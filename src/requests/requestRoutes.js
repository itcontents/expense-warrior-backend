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
  payout_provider_code: Joi.string().pattern(/^[a-z][a-z0-9_]{1,31}$/),
  payout_network_code: Joi.string().pattern(/^[A-Z][A-Z0-9_]{1,39}$/),
  payout_phone_number: Joi.string().trim().min(9).max(20),
}).and('payout_provider_code', 'payout_network_code', 'payout_phone_number').unknown(false)
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

async function addRequesterNames(result, identityClient, req) {
  const items = result?.items || []
  const ids = [...new Set(items.map((item) => item.requester_customer_id).filter(Boolean))]
  if (!ids.length || typeof identityClient.listStaffDirectory !== 'function') return result

  try {
    const people = await identityClient.listStaffDirectory(req.headers.cookie, {
      ids,
      limit: ids.length,
      offset: 0,
    }, req.requestId)
    const names = new Map(people.map((person) => {
      const name = [person.first_name, person.last_name].filter(Boolean).join(' ').trim()
      return [String(person.customer_id).toLowerCase(), name]
    }))
    return {
      ...result,
      items: items.map((item) => ({
        ...item,
        requester_display_name: names.get(String(item.requester_customer_id).toLowerCase()) || null,
      })),
    }
  } catch (_directoryError) {
    // Keep review queues available if the separate staff directory service is unavailable.
    return {
      ...result,
      items: items.map((item) => ({ ...item, requester_display_name: null })),
    }
  }
}

function createRequestRouter({ identityClient, requestService, pool, attachmentStorage, staffPayoutsEnabled = false }) {
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  const evidenceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 7, fieldSize: 2000 },
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
    const isMasterAdmin = req.actor.isMasterAdmin === true
    const canFinalApprove = role === 'admin' && staffPayoutsEnabled === true &&
      (isMasterAdmin || req.actor.canFinalApprove === true)
    return res.status(200).json({ data: {
      role,
      can_request: isMasterAdmin || req.actor.canRequest === true,
      can_view_approvals: isMasterAdmin || req.actor.canViewApprovals === true,
      can_final_approve: canFinalApprove,
      can_bulk_approve: canFinalApprove && (isMasterAdmin || req.actor.canBulkApprove === true),
      is_master_admin: isMasterAdmin,
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

  router.post('/requests/:request_id/cancel', requireSession, async (req, res) => {
    if (Object.keys(req.body || {}).length) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The request is invalid' } })
    try {
      const result = await requestService.cancelOwnRequest(req.actor, req.params.request_id, req.requestId)
      return res.status(200).json({ data: { request: result.request, replayed: result.replayed } })
    } catch (cause) {
      return respondWithError(res, cause)
    }
  })

  router.get('/approvals', requireSession, async (req, res) => {
    if (req.actor.isMasterAdmin !== true && req.actor.canViewApprovals !== true) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Approval queue access is not enabled for this account' } })
    }
    const { value, error } = filterSchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The request filters are invalid' } })

    try {
      const result = await requestService.listApprovals(req.actor, value)
      const namedResult = await addRequesterNames(result, identityClient, req)
      return res.status(200).json({ data: namedResult })
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
