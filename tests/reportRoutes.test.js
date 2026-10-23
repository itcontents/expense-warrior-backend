const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createReportRouter } = require('../src/reports/reportRoutes')

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('request report route requires admin and returns private downloadable file', async (t) => {
  let exports = 0
  const app = express()
  app.use(createReportRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff' }) },
    reportService: { exportRequests: async () => { exports++; return { content: Buffer.from('csv'), contentType: 'text/csv; charset=utf-8', filename: 'expense-warrior-requests-a-b.csv' } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const forbidden = await fetch(`${url}/admin/reports/requests?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=staff' } })
  assert.equal(forbidden.status, 403)
  assert.equal(exports, 0)
  const response = await fetch(`${url}/admin/reports/requests?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.match(response.headers.get('content-disposition'), /attachment; filename="expense-warrior-requests-a-b\.csv"/)
  assert.equal(await response.text(), 'csv')
  assert.equal(exports, 1)
})

test('request report route rejects invalid filters before export service', async (t) => {
  let exports = 0
  const app = express()
  app.use(createReportRouter({
    identityClient: { getSession: async () => ({ customerId: 'admin', role: 'admin' }) },
    reportService: { exportRequests: async () => { exports++; return {} } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const response = await fetch(`${url}/admin/reports/requests?range=custom&format=csv&from=2026-02-30&to=2026-03-01`, { headers: { cookie: 'itc_expense_warrior_access=admin' } })
  assert.equal(response.status, 400)
  assert.equal(exports, 0)
})

test('wallet history report is admin-only and returns a private downloadable export', async (t) => {
  let input
  const app = express()
  app.use(createReportRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff' }) },
    reportService: { exportRequests: async () => assert.fail('request report should not run'), exportWalletHistory: async (value) => {
      input = value
      return { content: Buffer.from('wallet csv'), contentType: 'text/csv; charset=utf-8', filename: 'expense-warrior-wallet-history-2026-10-15-2026-10-15.csv', rowCount: 1 }
    } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const forbidden = await fetch(`${url}/admin/reports/wallet-history?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=staff' } })
  assert.equal(forbidden.status, 403)
  const response = await fetch(`${url}/admin/reports/wallet-history?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-report-row-count'), '1')
  assert.equal(await response.text(), 'wallet csv')
  assert.equal(input.query.range, 'today')
  assert.equal(input.query.format, 'csv')
})

test('payment-link collection report is admin-only and validates date filters before export', async (t) => {
  let input
  let exports = 0
  const app = express()
  app.use(createReportRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff' }) },
    reportService: { exportRequests: async () => assert.fail('request report should not run'), exportPaymentLinkCollections: async (value) => {
      input = value
      exports++
      return { content: Buffer.from('collections csv'), contentType: 'text/csv; charset=utf-8', filename: 'expense-warrior-payment-link-collections-2026-10-15-2026-10-15.csv', rowCount: 2 }
    } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const forbidden = await fetch(`${url}/admin/reports/payment-link-collections?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=staff' } })
  assert.equal(forbidden.status, 403)
  const invalid = await fetch(`${url}/admin/reports/payment-link-collections?range=custom&from=2026-02-30&to=2026-03-01&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=admin' } })
  assert.equal(invalid.status, 400)
  assert.equal(exports, 0)
  const response = await fetch(`${url}/admin/reports/payment-link-collections?range=today&format=csv`, { headers: { cookie: 'itc_expense_warrior_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-report-row-count'), '2')
  assert.equal(await response.text(), 'collections csv')
  assert.equal(input.query.range, 'today')
  assert.equal(input.query.format, 'csv')
  assert.equal(exports, 1)
})
