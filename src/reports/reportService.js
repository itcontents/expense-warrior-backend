const defaultRepositoryFactory = require('./reportRepository').createReportRepository
const { resolveReportWindow, ReportFilterError } = require('./reportFilters')
const { createCsvReport, createPdfReport, createWalletCsvReport, createWalletPdfReport, createXlsxReport, createWalletXlsxReport } = require('./reportFormats')

const CSV_MAX_ROWS = 10000
const PDF_MAX_ROWS = 500
const WALLET_CSV_MAX_ROWS = 10000
const WALLET_PDF_MAX_ROWS = 500
const XLSX_MAX_ROWS = 10000
const WALLET_XLSX_MAX_ROWS = 10000

class ReportServiceError extends Error {
  constructor(code, statusCode) {
    super(code)
    this.name = 'ReportServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function createReportService({ pool, repository, formatters, itcFinanceClient, clock = () => new Date() }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL-compatible pool is required')
  const reports = repository || defaultRepositoryFactory({ pool })
  const renderers = formatters || { csv: createCsvReport, pdf: createPdfReport, xlsx: createXlsxReport, walletCsv: createWalletCsvReport, walletPdf: createWalletPdfReport, walletXlsx: createWalletXlsxReport }
  return Object.freeze({
    async exportRequests({ actor, query, requestId }) {
      if (String(actor?.role || '').toLowerCase() !== 'admin') throw new ReportServiceError('FORBIDDEN', 403)
      if (!['csv', 'pdf', 'xlsx'].includes(query?.format)) throw new ReportServiceError('INVALID_REPORT_FORMAT', 400)
      let window
      try {
        window = resolveReportWindow({ preset: query.range, from: query.from, to: query.to, now: clock() })
      } catch (error) {
        if (error instanceof ReportFilterError) throw new ReportServiceError(error.code, error.statusCode)
        throw error
      }
      const limit = query.format === 'pdf' ? PDF_MAX_ROWS : query.format === 'xlsx' ? XLSX_MAX_ROWS : CSV_MAX_ROWS
      const filters = { status: query.status || null, categoryId: query.categoryId || null }
      const result = await reports.listRequestReport({ window, filters, limit })
      if (result.has_more) throw new ReportServiceError('REPORT_TOO_LARGE', 413)
      const content = await renderers[query.format](result.items, window)
      const metadata = {
        format: query.format,
        range: query.range,
        from: window.fromDate,
        to: window.toDate,
        row_count: result.items.length,
        status: filters.status,
        category_id: filters.categoryId,
      }
      await pool.query(`
        INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
        VALUES ($1, 'report.requests.exported', 'request_report', NULL, $2, $3::jsonb)
      `, [actor.customerId, requestId || null, JSON.stringify(metadata)])
      return {
        content,
        contentType: reportContentType(query.format),
        filename: `expense-warrior-requests-${window.fromDate}-${window.toDate}.${query.format}`,
        rowCount: result.items.length,
        window,
      }
    },
    async exportWalletHistory({ actor, query, requestId }) {
      if (String(actor?.role || '').toLowerCase() !== 'admin') throw new ReportServiceError('FORBIDDEN', 403)
      if (!['csv', 'pdf', 'xlsx'].includes(query?.format)) throw new ReportServiceError('INVALID_REPORT_FORMAT', 400)
      if (!itcFinanceClient || typeof itcFinanceClient.getLedgerHistory !== 'function') {
        throw new ReportServiceError('WALLET_HISTORY_UNAVAILABLE', 503)
      }
      let window
      try {
        window = resolveReportWindow({ preset: query.range, from: query.from, to: query.to, now: clock() })
      } catch (error) {
        if (error instanceof ReportFilterError) throw new ReportServiceError(error.code, error.statusCode)
        throw error
      }
      const limit = query.format === 'pdf' ? WALLET_PDF_MAX_ROWS : query.format === 'xlsx' ? WALLET_XLSX_MAX_ROWS : WALLET_CSV_MAX_ROWS
      const items = []
      let cursor = null
      const seenCursors = new Set()
      while (items.length <= limit) {
        const page = await itcFinanceClient.getLedgerHistory({
          dateFrom: window.start,
          dateTo: window.end,
          limit: Math.min(500, limit + 1 - items.length),
          cursor,
        }, requestId)
        if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' ||
            (page.has_more && (typeof page.next_cursor !== 'string' || seenCursors.has(page.next_cursor))) ||
            (!page.has_more && page.next_cursor !== null)) {
          throw new ReportServiceError('WALLET_HISTORY_RESPONSE_INVALID', 502)
        }
        items.push(...page.items.map((entry) => ({ ...entry, currency: 'ZMW' })))
        if (items.length > limit) throw new ReportServiceError('REPORT_TOO_LARGE', 413)
        if (!page.has_more) break
        seenCursors.add(page.next_cursor)
        cursor = page.next_cursor
      }
      const content = query.format === 'csv' ? await renderers.walletCsv(items, window)
        : query.format === 'xlsx' ? await renderers.walletXlsx(items, window)
          : await renderers.walletPdf(items, window)
      await pool.query(`
        INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
        VALUES ($1, 'report.wallet_history.exported', 'wallet_history_report', NULL, $2, $3::jsonb)
      `, [actor.customerId, requestId || null, JSON.stringify({
        format: query.format, range: query.range, from: window.fromDate, to: window.toDate, row_count: items.length,
      })])
      return {
        content,
        contentType: reportContentType(query.format),
        filename: `expense-warrior-wallet-history-${window.fromDate}-${window.toDate}.${query.format}`,
        rowCount: items.length,
        window,
      }
    },
  })
}

function reportContentType(format) {
  if (format === 'csv') return 'text/csv; charset=utf-8'
  if (format === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return 'application/pdf'
}

module.exports = { createReportService, ReportServiceError, CSV_MAX_ROWS, PDF_MAX_ROWS, WALLET_CSV_MAX_ROWS, WALLET_PDF_MAX_ROWS, XLSX_MAX_ROWS, WALLET_XLSX_MAX_ROWS }
