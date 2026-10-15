const test = require('node:test')
const assert = require('node:assert/strict')
const { createReportService } = require('../src/reports/reportService')

const admin = { customerId: '26000000-0000-4000-8000-000000000001', role: 'admin' }
const query = { range: 'today', format: 'csv' }

test('request report export renders bounded data and records safe audit metadata', async () => {
  let audit
  const service = createReportService({
    pool: { query: async (...args) => { audit = args; return { rowCount: 1 } } },
    repository: { listRequestReport: async () => ({ items: [{ request_id: 'id' }], has_more: false }) },
    formatters: { csv: (rows) => Buffer.from(`rows:${rows.length}`), pdf: async () => Buffer.from('%PDF-') },
    clock: () => new Date('2026-10-15T12:00:00Z'),
  })
  const result = await service.exportRequests({ actor: admin, query, requestId: 'trace-1' })
  assert.equal(result.content.toString(), 'rows:1')
  assert.equal(result.contentType, 'text/csv; charset=utf-8')
  assert.equal(result.filename, 'expense-warrior-requests-2026-10-15-2026-10-15.csv')
  assert.match(audit[0], /INSERT INTO audit_events/)
  assert.equal(audit[1][0], admin.customerId)
  assert.match(audit[0], /report.requests.exported/)
  assert.deepEqual(JSON.parse(audit[1][2]), { format: 'csv', range: 'today', from: '2026-10-15', to: '2026-10-15', row_count: 1, status: null, category_id: null })
})

test('request report export denies non-admin before data or audit access', async () => {
  let calls = 0
  const service = createReportService({
    pool: { query: async () => { calls++ } },
    repository: { listRequestReport: async () => { calls++; return { items: [], has_more: false } } },
  })
  await assert.rejects(service.exportRequests({ actor: { customerId: 'staff', role: 'staff' }, query, requestId: 'trace' }), { code: 'FORBIDDEN' })
  assert.equal(calls, 0)
})

test('request report export rejects more than format cap before auditing', async () => {
  let auditCalls = 0
  const service = createReportService({
    pool: { query: async () => { auditCalls++ } },
    repository: { listRequestReport: async ({ limit }) => ({ items: Array(limit).fill({ request_id: 'x' }), has_more: true }) },
  })
  await assert.rejects(service.exportRequests({ actor: admin, query: { range: 'today', format: 'pdf' }, requestId: 'trace' }), { code: 'REPORT_TOO_LARGE' })
  assert.equal(auditCalls, 0)
})

test('wallet report fetches the ITC ledger with a stable cursor and audits the export', async () => {
  const pages = []
  let audit
  const first = { treasury_ledger_id: 'id1', entry_type: 'credit', direction: 'in', amount: '5.00', running_balance: '5.00', created_at: '2026-10-15T10:00:00.000Z' }
  const second = { ...first, treasury_ledger_id: 'id2', amount: '4.00', running_balance: '9.00', created_at: '2026-10-15T09:00:00.000Z' }
  const service = createReportService({
    pool: { query: async (...args) => { audit = args; return { rowCount: 1 } } },
    itcFinanceClient: { getLedgerHistory: async (filters, requestId) => {
      pages.push({ filters, requestId })
      return pages.length === 1 ? { items: [first], has_more: true, next_cursor: 'cursor-one' } : { items: [second], has_more: false, next_cursor: null }
    } },
    formatters: {
      csv: () => '', pdf: async () => Buffer.from('%PDF-'),
      walletCsv: (rows) => Buffer.from(rows.map((row) => row.amount).join(',')),
      walletPdf: async () => Buffer.from('%PDF-wallet'),
    },
    clock: () => new Date('2026-10-15T12:00:00Z'),
  })
  const result = await service.exportWalletHistory({ actor: admin, query, requestId: 'trace-1' })
  assert.equal(result.content.toString(), '5.00,4.00')
  assert.equal(result.filename, 'expense-warrior-wallet-history-2026-10-15-2026-10-15.csv')
  assert.equal(pages.length, 2)
  assert.equal(pages[0].filters.dateFrom, '2026-10-14T22:00:00.000Z')
  assert.equal(pages[1].filters.cursor, 'cursor-one')
  assert.equal(pages[1].requestId, 'trace-1')
  assert.match(audit[0], /report.wallet_history.exported/)
  assert.deepEqual(JSON.parse(audit[1][2]), { format: 'csv', range: 'today', from: '2026-10-15', to: '2026-10-15', row_count: 2 })
})

test('wallet report denies non-admin callers before ITC or audit access', async () => {
  let calls = 0
  const service = createReportService({ pool: { query: async () => { calls++ } }, itcFinanceClient: { getLedgerHistory: async () => { calls++ } } })
  await assert.rejects(service.exportWalletHistory({ actor: { customerId: 'staff', role: 'staff' }, query, requestId: 'trace' }), { code: 'FORBIDDEN' })
  assert.equal(calls, 0)
})
