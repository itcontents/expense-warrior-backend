const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const { createStaffPayoutRouter } = require('../src/payouts/staffPayoutRoutes')
const { createApp } = require('../src/app')
const { StaffPayoutServiceError } = require('../src/payouts/staffPayoutService')
const requestId = '20000000-0000-4000-8000-000000000002'
const actor = { customerId: '10000000-0000-4000-8000-000000000001', role: 'admin', active: true }
async function withRouter(retry, run, session = actor) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.requestId = 'audit'; next() })
  const unused = async () => assert.fail('separate approval/reconcile/bulk/recovery action')
  app.use('/api/v1/expense-warrior/admin', createStaffPayoutRouter({
    identityClient: { getSession: async () => session },
    payoutService: { retry, finalApprove: unused, reconcile: unused, bulkFinalApprove: unused, listRecovery: unused },
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}/api/v1/expense-warrior/admin/requests`) }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}
const headers = { Cookie: 'itc_backoffice_access=valid', 'Content-Type': 'application/json' }
test('retry endpoint requires a session before service access', async () => {
  await withRouter(() => assert.fail('unauthenticated service call'), async (url) => {
    assert.equal((await fetch(`${url}/${requestId}/payout/retry`, { method: 'POST' })).status, 401)
  })
})
test('retry endpoint rejects malformed request IDs before service access', async () => {
  await withRouter(() => assert.fail('malformed service call'), async (url) => {
    assert.equal((await fetch(`${url}/not-a-uuid/payout/retry`, { method: 'POST', headers })).status, 400)
  })
})
for (const pending of [true, false]) {
  test(`retry endpoint forwards the admin and returns ${pending ? 202 : 200} for ${pending ? 'pending' : 'confirmed'} outcomes`, async () => {
    let args
    await withRouter(async (...input) => {
      args = input
      return { request: { request_id: requestId, status: pending ? 'PAYOUT_PENDING' : 'PAID' }, pending,
        ...(pending ? { errorCode: 'ITC_FINANCE_UNAVAILABLE' } : {}) }
    }, async (url) => {
      const response = await fetch(`${url}/${requestId}/payout/retry`, { method: 'POST', headers, body: '{}' })
      assert.equal(response.status, pending ? 202 : 200)
      assert.deepEqual(await response.json(), { data: { request: { request_id: requestId, status: pending ? 'PAYOUT_PENDING' : 'PAID' }, pending,
        ...(pending ? { error_code: 'ITC_FINANCE_UNAVAILABLE' } : {}) } })
    })
    assert.deepEqual(args, [actor, requestId, 'audit'])
  })
}
for (const body of [{ amount: '1.00' }, { provider_code: 'other' }, { hold_id: requestId }, { operation_id: requestId },
  { provider_account_id: requestId }, { provider_account_version: 3 }, { phone_number: '260950000000' }, { currency: 'USD' }, []]) {
  test(`retry rejects caller financial fields ${JSON.stringify(body)}`, async () => {
    await withRouter(() => assert.fail('caller-controlled field accepted'), async (url) => {
      assert.equal((await fetch(`${url}/${requestId}/payout/retry`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400)
    })
  })
}
test('retry endpoint returns only a safe error code for provider failures', async () => {
  await withRouter(async () => { throw Object.assign(new Error('private provider details'), { code: 'PAYOUT_RETRY_NOT_ALLOWED', statusCode: 409 }) }, async (url) => {
    const response = await fetch(`${url}/${requestId}/payout/retry`, { method: 'POST', headers })
    assert.equal(response.status, 409)
    assert.equal((await response.text()).includes('private'), false)
  })
})
test('retry service enforces admin authorization on an authenticated staff session', async () => {
  await withRouter(async (candidate) => {
    if (candidate.role !== 'admin') throw new StaffPayoutServiceError('FORBIDDEN', 403)
    assert.fail('staff authorized')
  }, async (url) => {
    assert.equal((await fetch(`${url}/${requestId}/payout/retry`, { method: 'POST', headers })).status, 403)
  }, { ...actor, role: 'staff' })
})
test('payout router rejects missing retry dependency at startup', () => {
  const method = () => {}
  assert.throws(() => createStaffPayoutRouter({ identityClient: { getSession: method }, payoutService: {
    finalApprove: method, reconcile: method, bulkFinalApprove: method, listRecovery: method,
  } }), TypeError)
})
test('payout startup fails closed without account-specific provider selection', () => {
  assert.throws(() => createApp({ pool: { query: async () => ({ rows: [] }), connect() {} },
    identityClient: { getSession() {} }, staffPayoutsEnabled: true,
    paymentProviders: { get() {} }, itcFinanceClient: {}, phoneVault: {} }), {
      name: 'TypeError', message: 'Payouts require the signed provider, ITC finance, and destination vault integrations',
    })
})
