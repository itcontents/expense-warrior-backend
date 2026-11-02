const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const { createRequestRouter } = require('../src/requests/requestRoutes')

const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
const managerId = 'f437d2e8-b1dd-4e68-9e73-457889e17dbd'

async function withRouter(role, requestService, run) {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior', createRequestRouter({
    identityClient: { getSession: async () => ({ customerId: managerId, role, active: true }) },
    requestService,
    pool: { query: async () => ({ rows: [] }) },
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('manager approval endpoint returns accepted while the ITC reservation is unresolved', async () => {
  let received
  await withRouter('staff', {
    approveManager: async (...args) => {
      received = args
      return { request: { request_id: requestId, status: 'MANAGER_APPROVAL_PENDING_HOLD' }, pending: true, errorCode: 'ITC_FINANCE_UNAVAILABLE' }
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests/${requestId}/manager/approve`, {
      method: 'POST', headers: { Cookie: 'itc_expense_warrior_access=valid' },
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { data: {
      request: { request_id: requestId, status: 'MANAGER_APPROVAL_PENDING_HOLD' },
      pending: true,
      error_code: 'ITC_FINANCE_UNAVAILABLE',
    } })
  })
  assert.equal(received[0].customerId, managerId)
  assert.equal(received[1], requestId)
})

test('manager approval endpoint returns success only after reservation and local decision commit', async () => {
  await withRouter('staff', {
    approveManager: async () => ({ request: { request_id: requestId, status: 'MANAGER_APPROVED' }, pending: false, replayed: false }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests/${requestId}/manager/approve`, {
      method: 'POST', headers: { Cookie: 'itc_expense_warrior_access=valid' },
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data.request.status, 'MANAGER_APPROVED')
  })
})
