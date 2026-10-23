const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { PaymentLinkError } = require('./paymentLinkService')
const { ItcFinanceError } = require('../integrations/itc/ItcFinanceClient')

const createSchema = Joi.object({
  amount: Joi.string().pattern(/^(?:0|[1-9]\d{0,11})\.\d{2}$/).required(),
  description: Joi.string().trim().min(1).max(240).required(),
  public_token: Joi.string().pattern(/^[A-Za-z0-9_-]{40,128}$/).required(),
  target: Joi.alternatives().try(
    Joi.object({ type: Joi.string().valid('REVENUE').required(), revenue_account_code: Joi.string().pattern(/^\d{4}$/).required() }).unknown(false),
    Joi.object({ type: Joi.string().valid('CUSTOMER_CREDIT').required(), customer_id: Joi.string().pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).required() }).unknown(false),
    Joi.object({ type: Joi.string().valid('AR_SETTLEMENT').required(), customer_id: Joi.string().pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).required(), receivable_id: Joi.string().pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).required() }).unknown(false),
  ).required(),
}).unknown(false)
const listSchema = Joi.object({ limit: Joi.number().integer().min(1).max(100), offset: Joi.number().integer().min(0).max(1000000) }).unknown(false)
const customerSearchSchema = Joi.object({
  search: Joi.string().trim().min(2).max(100).required(),
  limit: Joi.number().integer().min(1).max(50).default(25),
  offset: Joi.number().integer().min(0).max(1000000).default(0),
}).unknown(false)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createPaymentLinkRouter({ identityClient, paymentLinkService, itcFinanceClient, receivablesEnabled = false } = {}) {
  if (!paymentLinkService || typeof paymentLinkService.createLink !== 'function' || typeof paymentLinkService.listLinks !== 'function' || typeof paymentLinkService.disableLink !== 'function') throw new TypeError('Payment-link service is required')
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  const adminOnly = (req, res, next) => String(req.actor?.role || '').toLowerCase() === 'admin'
    ? next()
    : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
  const fail = (res, error) => {
    if (error instanceof PaymentLinkError) return res.status(error.statusCode).json({ error: { code: error.code, message: error.code.replaceAll('_', ' ').toLowerCase() } })
    return res.status(503).json({ error: { code: 'PAYMENT_LINKS_UNAVAILABLE', message: 'Payment links are temporarily unavailable' } })
  }

  router.get('/payment-links/capabilities', requireSession, adminOnly, (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ data: { receivables_enabled: receivablesEnabled === true } })
  })

  router.get('/payment-links', requireSession, adminOnly, async (req, res) => {
    const { value, error } = listSchema.validate(req.query, { convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The payment-link filters are invalid' } })
    try { return res.json({ data: await paymentLinkService.listLinks(value) }) } catch (cause) { return fail(res, cause) }
  })
  router.get('/payment-links/customers', requireSession, adminOnly, async (req, res) => {
    const { value, error } = customerSearchSchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_CUSTOMER_SEARCH', message: 'Customer search filters are invalid' } })
    if (!itcFinanceClient || typeof itcFinanceClient.listCustomers !== 'function') {
      return res.status(503).json({ error: { code: 'CUSTOMER_DIRECTORY_UNAVAILABLE', message: 'Customer search is temporarily unavailable' } })
    }
    try {
      const customers = await itcFinanceClient.listCustomers(value, req.requestId)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { customers } })
    } catch (errorCause) {
      const status = errorCause instanceof ItcFinanceError ? errorCause.statusCode : 503
      const code = errorCause instanceof ItcFinanceError ? errorCause.code : 'CUSTOMER_DIRECTORY_UNAVAILABLE'
      return res.status(status).json({ error: { code, message: 'Customer search is temporarily unavailable' } })
    }
  })
  router.get('/payment-links/customers/:customer_id/receivables', requireSession, adminOnly, async (req, res) => {
    if (!UUID.test(req.params.customer_id)) return res.status(400).json({ error: { code: 'INVALID_CUSTOMER_ID', message: 'Customer identifier is invalid' } })
    if (receivablesEnabled !== true) return res.status(410).json({ error: { code: 'COMMERCE_RECEIVABLES_DEFERRED', message: 'Invoice collections are not available yet' } })
    if (!itcFinanceClient || typeof itcFinanceClient.getReceivables !== 'function') {
      return res.status(503).json({ error: { code: 'RECEIVABLES_UNAVAILABLE', message: 'Delivered invoices are temporarily unavailable' } })
    }
    const { value, error } = Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      cursor: Joi.string().max(512),
    }).unknown(false).validate(req.query, { convert: true, abortEarly: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_RECEIVABLE_FILTER', message: 'Invoice filters are invalid' } })
    try {
      const receivables = await itcFinanceClient.getReceivables(req.params.customer_id, { limit: value.limit, cursor: value.cursor || null }, req.requestId)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { receivables } })
    } catch (errorCause) {
      const status = errorCause instanceof ItcFinanceError ? errorCause.statusCode : 503
      const code = errorCause instanceof ItcFinanceError ? errorCause.code : 'RECEIVABLES_UNAVAILABLE'
      return res.status(status).json({ error: { code, message: 'Delivered invoices are temporarily unavailable' } })
    }
  })
  router.get('/payment-links/revenue-accounts', requireSession, adminOnly, async (req, res) => {
    if (!itcFinanceClient || typeof itcFinanceClient.getRevenueAccounts !== 'function') {
      return res.status(503).json({ error: { code: 'REVENUE_ACCOUNTS_UNAVAILABLE', message: 'Revenue accounts are temporarily unavailable' } })
    }
    try {
      const accounts = await itcFinanceClient.getRevenueAccounts(req.requestId)
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json({ data: { accounts } })
    } catch (errorCause) {
      const status = errorCause instanceof ItcFinanceError ? errorCause.statusCode : 503
      const code = errorCause instanceof ItcFinanceError ? errorCause.code : 'REVENUE_ACCOUNTS_UNAVAILABLE'
      return res.status(status).json({ error: { code, message: 'Revenue accounts are temporarily unavailable' } })
    }
  })
  router.post('/payment-links', requireSession, adminOnly, async (req, res) => {
    const { value, error } = createSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_PAYMENT_LINK', message: 'Add a description and a fixed ZMW amount with two decimal places' } })
    const idempotencyKey = req.get('Idempotency-Key')
    if (!UUID.test(String(idempotencyKey || ''))) return res.status(400).json({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'A valid Idempotency-Key is required' } })
    if (value.target.type === 'AR_SETTLEMENT' && receivablesEnabled !== true) {
      return res.status(410).json({ error: { code: 'COMMERCE_RECEIVABLES_DEFERRED', message: 'Invoice collections are not available yet' } })
    }
    if (!itcFinanceClient) return res.status(503).json({ error: { code: 'COLLECTION_TARGET_UNAVAILABLE', message: 'Collection targets are temporarily unavailable' } })
    try {
      if (value.target.type === 'REVENUE') {
        const accounts = await itcFinanceClient.getRevenueAccounts(req.requestId)
        if (!accounts.some((account) => account.account_code === value.target.revenue_account_code)) {
          return res.status(422).json({ error: { code: 'REVENUE_ACCOUNT_UNAVAILABLE', message: 'Choose an active postable ITC revenue account' } })
        }
      } else if (value.target.type === 'CUSTOMER_CREDIT') {
        const balance = await itcFinanceClient.getCustomerCreditBalance(value.target.customer_id, req.requestId)
        if (balance.customer_id.toLowerCase() !== value.target.customer_id.toLowerCase()) {
          return res.status(422).json({ error: { code: 'CUSTOMER_UNAVAILABLE', message: 'Choose an active ITC customer account' } })
        }
      } else if (value.target.type === 'AR_SETTLEMENT') {
        const receivable = await itcFinanceClient.getReceivable(value.target.customer_id, value.target.receivable_id, req.requestId)
        if (receivable.customer_id.toLowerCase() !== value.target.customer_id.toLowerCase() ||
            receivable.receivable_id.toLowerCase() !== value.target.receivable_id.toLowerCase() ||
            receivable.currency !== 'ZMW' || !['OPEN', 'PARTIALLY_PAID', 'PARTIALLY_CREDITED'].includes(receivable.status) ||
            receivable.outstanding_amount !== value.amount) {
          return res.status(422).json({ error: { code: 'RECEIVABLE_UNAVAILABLE', message: 'Choose a delivered invoice with the exact outstanding ZMW balance' } })
        }
      }
      const result = await paymentLinkService.createLink(req.actor, { ...value, publicToken: value.public_token }, idempotencyKey)
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.replayed ? 200 : 201).json({ data: { link: result.link, token: result.token } })
    } catch (cause) { return fail(res, cause) }
  })
  router.post('/payment-links/:link_id/disable', requireSession, adminOnly, async (req, res) => {
    if (!UUID.test(req.params.link_id)) return res.status(400).json({ error: { code: 'INVALID_PAYMENT_LINK', message: 'The payment link is invalid' } })
    try { return res.json({ data: await paymentLinkService.disableLink(req.params.link_id, req.actor) }) } catch (cause) { return fail(res, cause) }
  })
  return router
}

module.exports = { createPaymentLinkRouter }
