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
