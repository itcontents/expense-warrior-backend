const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveReportWindow, ReportFilterError } = require('../src/reports/reportFilters')

test('today uses Africa/Lusaka local midnight and a half-open UTC interval', () => {
  const result = resolveReportWindow({ preset: 'today', now: new Date('2026-10-15T00:30:00.000Z') })
  assert.equal(result.fromDate, '2026-10-15')
  assert.equal(result.toDate, '2026-10-15')
  assert.equal(result.start, '2026-10-14T22:00:00.000Z')
  assert.equal(result.end, '2026-10-15T22:00:00.000Z')
})

test('yesterday and calendar month presets use Lusaka calendar dates across UTC boundaries', () => {
  const yesterday = resolveReportWindow({ preset: 'yesterday', now: new Date('2026-03-01T00:30:00.000Z') })
  assert.equal(yesterday.fromDate, '2026-02-28')
  assert.equal(yesterday.toDate, '2026-02-28')
  const lastMonth = resolveReportWindow({ preset: 'last_month', now: new Date('2026-03-01T00:30:00.000Z') })
  assert.equal(lastMonth.fromDate, '2026-02-01')
  assert.equal(lastMonth.toDate, '2026-02-28')
  assert.equal(lastMonth.end, '2026-02-28T22:00:00.000Z')
})

test('custom ranges include both requested local dates and reject invalid or reversed dates', () => {
  const result = resolveReportWindow({ preset: 'custom', from: '2026-12-31', to: '2027-01-01' })
  assert.equal(result.start, '2026-12-30T22:00:00.000Z')
  assert.equal(result.end, '2027-01-01T22:00:00.000Z')
  assert.throws(() => resolveReportWindow({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }), ReportFilterError)
  assert.throws(() => resolveReportWindow({ preset: 'custom', from: '2026-03-02', to: '2026-03-01' }), ReportFilterError)
})

test('custom range supports multiple years and leaves resource bounds to the row cap', () => {
  const result = resolveReportWindow({ preset: 'custom', from: '2024-01-01', to: '2026-01-02' })
  assert.equal(result.fromDate, '2024-01-01')
  assert.equal(result.toDate, '2026-01-02')
})
