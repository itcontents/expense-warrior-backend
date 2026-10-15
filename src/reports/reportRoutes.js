const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { ReportServiceError } = require('./reportService')
const { resolveReportWindow, ReportFilterError } = require('./reportFilters')

const STATUSES = [
  'PENDING_MANAGER', 'MANAGER_APPROVAL_PENDING_HOLD', 'MANAGER_APPROVED', 'PENDING_ADMIN',
  'APPROVED_AWAITING_PAYOUT', 'PAYOUT_PENDING', 'PAID', 'REJECTED_MANAGER', 'REJECTED_ADMIN',
]
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const filtersSchema = Joi.object({
  range: Joi.string().valid('today', 'yesterday', 'this_month', 'last_month', 'custom').required(),
  format: Joi.string().valid('csv', 'pdf', 'xlsx').required(),
  from: Joi.string().pattern(datePattern).when('range', { is: 'custom', then: Joi.required(), otherwise: Joi.forbidden() }),
  to: Joi.string().pattern(datePattern).when('range', { is: 'custom', then: Joi.required(), otherwise: Joi.forbidden() }),
  status: Joi.string().valid(...STATUSES),
  category_id: Joi.string().guid({ version: ['uuidv4', 'uuidv5'] }),
}).unknown(false)
const walletFiltersSchema = Joi.object({
  range: Joi.string().valid('today', 'yesterday', 'this_month', 'last_month', 'custom').required(),
  format: Joi.string().valid('csv', 'pdf', 'xlsx').required(),
  from: Joi.string().pattern(datePattern).when('range', { is: 'custom', then: Joi.required(), otherwise: Joi.forbidden() }),
  to: Joi.string().pattern(datePattern).when('range', { is: 'custom', then: Joi.required(), otherwise: Joi.forbidden() }),
}).unknown(false)

function createReportRouter({ identityClient, reportService }) {
  if (!reportService || typeof reportService.exportRequests !== 'function') throw new TypeError('A request report service is required')
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  router.get('/admin/reports/requests', requireSession, async (req, res) => {
    const role = String(req.actor.role || '').toLowerCase()
    if (role !== 'admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin permission is required' } })
    const { value, error } = filtersSchema.validate(req.query, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_REPORT_FILTER', message: 'Check the report date, status, category, and format' } })
    try {
      resolveReportWindow({ preset: value.range, from: value.from, to: value.to })
    } catch (cause) {
      if (cause instanceof ReportFilterError) return res.status(400).json({ error: { code: cause.code, message: cause.code.replaceAll('_', ' ').toLowerCase() } })
      return res.status(400).json({ error: { code: 'INVALID_REPORT_FILTER', message: 'Check the report date and range' } })
    }
    try {
      const result = await reportService.exportRequests({
        actor: req.actor,
        query: { range: value.range, from: value.from, to: value.to, format: value.format, status: value.status, categoryId: value.category_id },
        requestId: req.requestId,
      })
      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Row-Count': String(result.rowCount),
      })
      return res.status(200).send(result.content)
    } catch (cause) {
      if (cause instanceof ReportServiceError) return res.status(cause.statusCode).json({ error: { code: cause.code, message: cause.code.replaceAll('_', ' ').toLowerCase() } })
      return res.status(503).json({ error: { code: 'REPORT_UNAVAILABLE', message: 'The request report is temporarily unavailable' } })
    }
  })
  router.get('/admin/reports/wallet-history', requireSession, async (req, res) => {
    if (String(req.actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin permission is required' } })
    }
    const { value, error } = walletFiltersSchema.validate(req.query, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_REPORT_FILTER', message: 'Check the report date range and format' } })
    try {
      resolveReportWindow({ preset: value.range, from: value.from, to: value.to })
    } catch (cause) {
      if (cause instanceof ReportFilterError) return res.status(400).json({ error: { code: cause.code, message: cause.code.replaceAll('_', ' ').toLowerCase() } })
      return res.status(400).json({ error: { code: 'INVALID_REPORT_FILTER', message: 'Check the report date and range' } })
    }
    try {
      const result = await reportService.exportWalletHistory({
        actor: req.actor,
        query: { range: value.range, from: value.from, to: value.to, format: value.format },
        requestId: req.requestId,
      })
      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Row-Count': String(result.rowCount),
      })
      return res.status(200).send(result.content)
    } catch (cause) {
      if (cause instanceof ReportServiceError) return res.status(cause.statusCode).json({ error: { code: cause.code, message: cause.code.replaceAll('_', ' ').toLowerCase() } })
      return res.status(503).json({ error: { code: 'REPORT_UNAVAILABLE', message: 'The wallet history report is temporarily unavailable' } })
    }
  })
  return router
}

module.exports = { createReportRouter, filtersSchema, walletFiltersSchema }
