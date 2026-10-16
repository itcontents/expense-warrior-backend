const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')

const ledgerHistorySchema = Joi.object({
  date_from: Joi.string().isoDate(),
  date_to: Joi.string().isoDate(),
  limit: Joi.number().integer().min(1).max(500).default(100),
  cursor: Joi.string().max(512),
}).unknown(false)

function createWalletBalanceRouter({ identityClient, walletBalanceService, itcFinanceClient, snapshotRepository = null } = {}) {
  if (!identityClient || !walletBalanceService || typeof walletBalanceService.getBalance !== 'function') {
    throw new TypeError('ITC identity and wallet balance services are required')
  }
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)

  router.get('/wallet/provider-balance', requireSession, async (req, res) => {
    const actor = req.actor
    if (!actor?.active) return res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue' } })
    if (String(actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    if (req.query.refresh !== undefined && req.query.refresh !== 'true' && req.query.refresh !== 'false') {
      return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The refresh option must be true or false' } })
    }
    const providerCode = req.query.provider_code === undefined ? 'pawapay' : String(req.query.provider_code).trim().toLowerCase()
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(providerCode)) {
      return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'The provider filter is invalid' } })
    }
    try {
      const result = await walletBalanceService.getBalance({ providerCode, forceRefresh: req.query.refresh === 'true' })
      res.set('Cache-Control', 'private, no-store')
      res.set('Vary', 'Cookie')
      return res.status(200).json({ data: result })
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 503
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PROVIDER_BALANCE_UNAVAILABLE'
      return res.status(statusCode).json({ error: { code, message: 'Provider balance is temporarily unavailable' } })
    }
  })

  router.get('/wallet/provider-balance/history', requireSession, async (req, res) => {
    const actor = req.actor
    if (!actor?.active) return res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue' } })
    if (String(actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      provider_code: Joi.string().pattern(/^[a-z][a-z0-9_]{1,31}$/).default('pawapay'),
    }).unknown(false)
    const { value, error } = schema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_FILTER', message: 'Snapshot history filters are invalid' } })
    if (!snapshotRepository || typeof snapshotRepository.listRecent !== 'function') {
      return res.status(503).json({ error: { code: 'PROVIDER_BALANCE_HISTORY_UNAVAILABLE', message: 'Provider balance history is temporarily unavailable' } })
    }
    try {
      const snapshots = await snapshotRepository.listRecent({ limit: value.limit, providerCode: value.provider_code })
      res.set('Cache-Control', 'private, no-store')
      res.set('Vary', 'Cookie')
      return res.status(200).json({ data: { snapshots } })
    } catch (error) {
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PROVIDER_BALANCE_HISTORY_UNAVAILABLE'
      return res.status(503).json({ error: { code, message: 'Provider balance history is temporarily unavailable' } })
    }
  })

  router.get('/wallet/ledger-balance', requireSession, async (req, res) => {
    const actor = req.actor
    if (!actor?.active) return res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue' } })
    if (String(actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    if (!itcFinanceClient || typeof itcFinanceClient.getBalance !== 'function') {
      return res.status(503).json({ error: { code: 'LEDGER_BALANCE_UNAVAILABLE', message: 'The ITC ledger balance is temporarily unavailable' } })
    }
    try {
      const balance = await itcFinanceClient.getBalance()
      res.set('Cache-Control', 'private, no-store')
      res.set('Vary', 'Cookie')
      return res.status(200).json({ data: { source: 'itc_ledger', ...balance } })
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 503
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'LEDGER_BALANCE_UNAVAILABLE'
      return res.status(statusCode).json({ error: { code, message: 'The ITC ledger balance is temporarily unavailable' } })
    }
  })

  router.get('/wallet/ledger-history', requireSession, async (req, res) => {
    const actor = req.actor
    if (!actor?.active) return res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue' } })
    if (String(actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    if (!itcFinanceClient || typeof itcFinanceClient.getLedgerHistory !== 'function') {
      return res.status(503).json({ error: { code: 'LEDGER_HISTORY_UNAVAILABLE', message: 'The ITC ledger history is temporarily unavailable' } })
    }
    const { value, error } = ledgerHistorySchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_LEDGER_HISTORY_FILTER', message: 'Ledger history filters are invalid' } })
    try {
      const history = await itcFinanceClient.getLedgerHistory({
        dateFrom: value.date_from ? new Date(value.date_from).toISOString() : null,
        dateTo: value.date_to ? new Date(value.date_to).toISOString() : null,
        limit: value.limit,
        cursor: value.cursor || null,
      }, req.requestId)
      res.set('Cache-Control', 'private, no-store')
      res.set('Vary', 'Cookie')
      return res.status(200).json({ data: { history } })
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 503
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'LEDGER_HISTORY_UNAVAILABLE'
      return res.status(statusCode).json({ error: { code, message: 'The ITC ledger history is temporarily unavailable' } })
    }
  })

  return router
}

module.exports = { createWalletBalanceRouter }
