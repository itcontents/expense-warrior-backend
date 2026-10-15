const express = require('express')
const Joi = require('joi')
const { PaymentLinkError } = require('./paymentLinkService')

const attemptSchema = Joi.object({
  network_code: Joi.string().pattern(/^[A-Z][A-Z0-9_]{1,31}$/).required(),
  phone_number: Joi.string().pattern(/^260\d{9}$/).required(),
}).unknown(false)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createRateLimiter({ max, windowMs, now = Date.now } = {}) {
  const buckets = new Map()
  return (req, res, next) => {
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown')
    const timestamp = now()
    let bucket = buckets.get(key)
    if (!bucket || bucket.expiresAt <= timestamp) bucket = { count: 0, expiresAt: timestamp + windowMs }
    bucket.count += 1
    buckets.delete(key)
    buckets.set(key, bucket)
    if (buckets.size > 10000) {
      for (const [oldKey, oldBucket] of buckets) {
        if (oldBucket.expiresAt <= timestamp || buckets.size > 9000) buckets.delete(oldKey)
        else break
      }
    }
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - timestamp) / 1000))))
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many payment attempts. Please wait and try again.' } })
    }
    return next()
  }
}

function createPublicPaymentRouter({ paymentService, now } = {}) {
  if (!paymentService || typeof paymentService.getLink !== 'function' || typeof paymentService.startAttempt !== 'function' ||
      typeof paymentService.refreshAttempt !== 'function' || typeof paymentService.getReceipt !== 'function') {
    throw new TypeError('Public payment-link service is required')
  }
  const router = express.Router()
  const limitStart = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000, now })
  const limitStatus = createRateLimiter({ max: 60, windowMs: 60 * 1000, now })
  const fail = (res, error) => {
    if (error instanceof PaymentLinkError) return res.status(error.statusCode).json({ error: { code: error.code, message: error.code.replaceAll('_', ' ').toLowerCase() } })
    return res.status(503).json({ error: { code: 'PAYMENT_SERVICE_UNAVAILABLE', message: 'Payments are temporarily unavailable' } })
  }

  router.get('/:token', limitStatus, async (req, res) => {
    try {
      const link = await paymentService.getLink(req.params.token)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { link } })
    } catch (cause) { return fail(res, cause) }
  })
  router.post('/:token/attempts', limitStart, async (req, res) => {
    const { value, error } = attemptSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error || !UUID.test(String(req.get('Idempotency-Key') || ''))) {
      return res.status(400).json({ error: { code: 'INVALID_PAYMENT_ATTEMPT', message: 'Choose a network and enter a valid Zambia mobile number' } })
    }
    try {
      const result = await paymentService.startAttempt(req.params.token, value, req.get('Idempotency-Key'))
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.replayed ? 200 : 202).json({ data: result, meta: { replayed: result.replayed } })
    } catch (cause) { return fail(res, cause) }
  })
  router.get('/:token/attempts/:attempt_id', limitStatus, async (req, res) => {
    if (!UUID.test(req.params.attempt_id)) return res.status(404).json({ error: { code: 'PAYMENT_ATTEMPT_NOT_FOUND', message: 'Payment attempt was not found' } })
    try {
      const attempt = await paymentService.refreshAttempt(req.params.token, req.params.attempt_id)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { attempt } })
    } catch (cause) { return fail(res, cause) }
  })
  router.get('/:token/attempts/:attempt_id/receipt', limitStatus, async (req, res) => {
    if (!UUID.test(req.params.attempt_id)) return res.status(404).json({ error: { code: 'PAYMENT_RECEIPT_NOT_AVAILABLE', message: 'Payment receipt is not available' } })
    try {
      const receipt = await paymentService.getReceipt(req.params.token, req.params.attempt_id)
      res.set('Cache-Control', 'private, no-store')
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Disposition', `attachment; filename="${receipt.filename}"`)
      return res.type('application/pdf').status(200).send(receipt.pdf)
    } catch (cause) { return fail(res, cause) }
  })
  return router
}

module.exports = { createPublicPaymentRouter, createRateLimiter }
