const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { StaffPayoutServiceError } = require('./staffPayoutService')

const bulkSchema = Joi.object({
  request_ids: Joi.array().items(Joi.string().guid({ version: ['uuidv4'] }).required()).min(1).max(50).unique().required(),
}).unknown(false)
const recoveryQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).max(1000000).default(0),
}).unknown(false)

function respondWithError(res, error) {
  if (error instanceof StaffPayoutServiceError ||
      (Number.isInteger(error?.statusCode) && /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')))) {
    return res.status(error.statusCode).json({ error: { code: error.code, message: error.code.replaceAll('_', ' ').toLowerCase() } })
  }
  return res.status(503).json({ error: { code: 'PAYOUT_SERVICE_UNAVAILABLE', message: 'Payouts are temporarily unavailable' } })
}

function createStaffPayoutRouter({ identityClient, payoutService } = {}) {
  if (!identityClient || !payoutService || typeof payoutService.finalApprove !== 'function' ||
      typeof payoutService.retry !== 'function' || typeof payoutService.reconcile !== 'function' || typeof payoutService.bulkFinalApprove !== 'function' ||
      typeof payoutService.listRecovery !== 'function') {
    throw new TypeError('ITC identity and staff payout services are required')
  }
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)

  router.get('/payouts/recovery', requireSession, async (req, res) => {
    const { value, error } = recoveryQuerySchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The payout recovery filters are invalid' } })
    try {
      const result = await payoutService.listRecovery(req.actor, value)
      return res.status(200).json({ data: result })
    } catch (cause) { return respondWithError(res, cause) }
  })

  router.post('/requests/:request_id/final-approve', requireSession, async (req, res) => {
    try {
      const result = await payoutService.finalApprove(req.actor, req.params.request_id, req.requestId)
      return res.status(result.pending ? 202 : 200).json({ data: {
        request: result.request,
        pending: result.pending,
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
      } })
    } catch (error) { return respondWithError(res, error) }
  })

  router.post('/requests/:request_id/payout/retry', requireSession, async (req, res) => {
    const validId = Joi.string().guid({ version: ['uuidv4'] }).required().validate(req.params.request_id)
    const validBody = Joi.object({}).unknown(false).validate(req.body === undefined ? {} : req.body, { convert: false })
    if (validId.error || validBody.error || Object.keys(req.query).length) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The payout retry request is invalid' } })
    }
    try {
      const result = await payoutService.retry(req.actor, req.params.request_id, req.requestId)
      return res.status(result.pending ? 202 : 200).json({ data: {
        request: result.request, pending: result.pending,
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
      } })
    } catch (error) { return respondWithError(res, error) }
  })

  router.post('/requests/:request_id/payout/reconcile', requireSession, async (req, res) => {
    try {
      const result = await payoutService.reconcile(req.actor, req.params.request_id, req.requestId)
      return res.status(result.pending ? 202 : 200).json({ data: {
        request: result.request,
        pending: result.pending,
        ...(result.errorCode ? { error_code: result.errorCode } : {}),
      } })
    } catch (error) { return respondWithError(res, error) }
  })

  router.post('/requests/bulk-final-approve', requireSession, async (req, res) => {
    const { value, error } = bulkSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_BULK_REQUEST', message: 'Select between 1 and 50 unique requests' } })
    try {
      const result = await payoutService.bulkFinalApprove(req.actor, value.request_ids, req.requestId)
      return res.status(200).json({ data: result })
    } catch (cause) { return respondWithError(res, cause) }
  })

  return router
}

module.exports = { createStaffPayoutRouter, bulkSchema, recoveryQuerySchema }
