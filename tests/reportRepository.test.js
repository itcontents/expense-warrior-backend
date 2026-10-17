const test = require('node:test')
const assert = require('node:assert/strict')
const { createReportRepository } = require('../src/reports/reportRepository')

test('request report query is bounded, filtered by submitted window, and stably newest first', async () => {
  let call
  const repository = createReportRepository({ pool: { query: async (...args) => { call = args; return { rows: [] } } } })
  const window = { start: '2026-10-14T22:00:00.000Z', end: '2026-10-15T22:00:00.000Z' }
  await repository.listRequestReport({ window, filters: { status: 'PAID', categoryId: null }, limit: 501 })
  assert.match(call[0], /r\.submitted_at >= \$1 AND r\.submitted_at < \$2/)
  assert.match(call[0], /ORDER BY r\.submitted_at DESC, r\.request_id DESC/)
  assert.match(call[0], /LIMIT \$5/)
  assert.deepEqual(call[1], [window.start, window.end, 'PAID', null, 502])
})

test('request report returns at most the requested limit and flags overflow', async () => {
  const repository = createReportRepository({ pool: { query: async () => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }) } })
  const result = await repository.listRequestReport({ window: { start: 'a', end: 'b' }, filters: {}, limit: 2 })
  assert.deepEqual(result.items, [{ id: 1 }, { id: 2 }])
  assert.equal(result.has_more, true)
})

test('payment-link collection report is bounded, newest first, and returns only masked payer digits', async () => {
  let call
  const repository = createReportRepository({ pool: { query: async (...args) => {
    call = args
    return { rows: [{ payer_last_four: '9783' }, { payer_last_four: null }] }
  } } })
  const window = { start: '2026-10-14T22:00:00.000Z', end: '2026-10-15T22:00:00.000Z' }
  const result = await repository.listPaymentLinkCollectionReport({ window, limit: 1 })
  assert.match(call[0], /a\.created_at >= \$1 AND a\.created_at < \$2/)
  assert.match(call[0], /ORDER BY a\.created_at DESC, a\.attempt_id DESC/)
  assert.match(call[0], /LIMIT \$3/)
  assert.match(call[0], /RIGHT\(a\.payer_phone, 4\) AS payer_last_four/)
  assert.doesNotMatch(call[0], /SELECT\s+a\.payer_phone\s*,/i)
  assert.deepEqual(call[1], [window.start, window.end, 2])
  assert.deepEqual(result, { items: [{ payer_last_four: '9783' }], has_more: true })
})
