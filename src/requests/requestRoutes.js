const express = require('express')
const Joi = require('joi')
const multer = require('multer')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { RequestRepositoryError } = require('./requestRepository')
const { RequestServiceError } = require('./requestService')
const { AttachmentStorageError } = require('../attachments/attachmentStorage')

const amountPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/
const requestSchema = Joi.object({
  category_id: Joi.string().guid().required(),
  subcategory_id: Joi.string().guid().allow(null),
  amount: Joi.string().pattern(amountPattern).required(),
  reason: Joi.string().max(2000).allow('', null),
})
const filterSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100),
  offset: Joi.number().integer().min(0).max(1000000),
  sort: Joi.string().valid('created_at', 'amount', 'status', 'category_name'),
  direction: Joi.string().lowercase().valid('asc', 'desc'),
}).unknown(false)
const rejectionSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(2000).required(),
}).unknown(false)

function respondWithError(res, error) {
  if (error instanceof RequestServiceError || error instanceof RequestRepositoryError || error instanceof AttachmentStorageError) {
    return res.status(error.statusCode).json({ error: { code: error.code, message: error.code.replaceAll('_', ' ').toLowerCase() } })
  }
  return res.status(503).json({ error: { code: 'REQUEST_SERVICE_UNAVAILABLE', message: 'Requests are temporarily unavailable' } })
}

function createRequestRouter({ identityClient, requestService, pool, attachmentStorage, staffPayoutsEnabled = false }) {
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  const evidenceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 2000 },
  }).single('evidence')
  const parseEvidence = (req, res, next) => evidenceUpload(req, res, (error) => {
    if (!error) return next()
    const tooLarge = error.code === 'LIMIT_FILE_SIZE'
    return res.status(tooLarge ? 413 : 400).json({ error: {
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'INVALID_MULTIPART_REQUEST',
      message: tooLarge ? 'Image must be 5 MB or smaller' : 'The request form or image is invalid',
    } })
  })

  router.get('/me', requireSession, async (req, res) => {
    const role = String(req.actor.role || '').toLowerCase()
    const canRequest = role === 'staff'
    let canViewApprovals = role === 'admin'
    if (role === 'staff') {
      try {
        const result = await pool.query(`
          SELECT EXISTS (
            SELECT 1
              FROM employee_manager_assignments
             WHERE manager_customer_id = $1
               AND effective_from <= transaction_timestamp()
               AND (effective_to IS NULL OR effective_to > transaction_timestamp())
          ) AS is_manager
        `, [req.actor.customerId])
        canViewApprovals = result.rows[0]?.is_manager === true
      } catch (_error) {
        return res.status(503).json({ error: { code: 'CAPABILITIES_UNAVAILABLE', message: 'Your workspace permissions are temporarily unavailable' } })
      }
    }
    return res.status(200).json({ data: {
      role,
      can_request: canRequest,
      can_view_approvals: canViewApprovals,
      can_final_approve: role === 'admin' && staffPayoutsEnabled === true,
      can_bulk_approve: role === 'admin' && staffPayoutsEnabled === true,
    } })
  })

  router.post('/requests', requireSession, parseEvidence, async (req, res) => {
    const { value, error } = requestSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Check the request fields and try again' } })

    try {
      const result = await requestService.submitRequest(req.actor, value, req.get('Idempotency-Key'), {
        file: req.file,
        requestId: req.requestId,
      })
      return res.status(result.replayed ? 200 : 201).json({ data: { request: result.request } })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.get('/admin/requests/:request_id/payout-destination', requireSession, async (req, res) => {
    try {
      const destination = await requestService.getPayoutDestination(req.actor, req.params.request_id, req.requestId)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { destination } })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.get('/requests/:request_id/attachments/:attachment_id', requireSession, async (req, res) => {
    try {
      const attachment = await requestService.getAttachment(req.actor, req.params.request_id, req.params.attachment_id)
      if (!attachmentStorage || typeof attachmentStorage.open !== 'function') {
        return res.status(503).json({ error: { code: 'ATTACHMENT_STORAGE_UNAVAILABLE', message: 'Attachments are temporarily unavailable' } })
      }
      const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
      if (!imageTypes.has(attachment.media_type)) {
        return res.status(404).json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } })
      }
      const image = await attachmentStorage.open(attachment.storage_key, attachment.media_type)
      res.set('Cache-Control', 'private, no-store')
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Type', attachment.media_type)
      res.set('Content-Disposition', 'inline')
      if (Number.isSafeInteger(attachment.file_size_bytes)) res.set('Content-Length', String(attachment.file_size_bytes))
      image.on('error', () => {
        if (res.headersSent) res.destroy()
        else res.status(503).end()
      })
      image.pipe(res)
      return undefined
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.get('/requests', requireSession, async (req, res) => {
    const { value, error } = filterSchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The request filters are invalid' } })

    try {
      const result = await requestService.listRequests(req.actor, value)
      return res.status(200).json({ data: result })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.get('/approvals', requireSession, async (req, res) => {
    const { value, error } = filterSchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The request filters are invalid' } })

    try {
      const result = await requestService.listApprovals(req.actor, value)
      return res.status(200).json({ data: result })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.post('/requests/:request_id/manager/approve', requireSession, async (req, res) => {
    try {
      const result = await requestService.approveManager(req.actor, req.params.request_id, req.requestId)
      return res.status(result.pending ? 202 : 200).json({ data: {
        request: result.request,
        pending: result.pending,
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
      } })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.post('/requests/:request_id/:stage/reject', requireSession, async (req, res) => {
    const { value, error } = rejectionSchema.validate(req.body, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_REJECTION', message: 'Add a rejection reason up to 2,000 characters' } })
    try {
      const result = await requestService.rejectRequest(req.actor, req.params.request_id, req.params.stage, value.reason, req.requestId)
      if (result?.pending) return res.status(202).json({ data: { request: result.request, pending: true, error_code: result.errorCode } })
      return res.status(200).json({ data: { request: result?.request || result, pending: false } })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  return router
}

module.exports = { createRequestRouter }
