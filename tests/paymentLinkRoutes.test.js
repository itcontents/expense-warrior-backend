const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createPaymentLinkRouter } = require('../src/paymentLinks/paymentLinkRoutes')

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('payment-link management is admin-only and creates a fixed amount reusable link', async (t) => {
  const calls = []
  const app = express()
  app.use(express.json())
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie.includes('admin') ? 'admin-id' : 'staff-id', role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    paymentLinkService: {
      createLink: async (actor, input, idempotencyKey) => { calls.push({ actor, input, idempotencyKey }); return { link: { description: input.description, amount: input.amount }, token: input.publicToken, replayed: false } },
      listLinks: async () => ({ items: [] }),
      disableLink: async () => ({ link: { status: 'DISABLED' } }),
    },
    itcFinanceClient: { getRevenueAccounts: async () => [{ account_code: '4000', account_name: 'Product Sales' }] },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const forbidden = await fetch(`${url}/payment-links`, { headers: { cookie: 'itc_backoffice_access=staff' } })
  assert.equal(forbidden.status, 403)

  const response = await fetch(`${url}/payment-links`, {
    method: 'POST', headers: { cookie: 'itc_backoffice_access=admin', 'content-type': 'application/json', 'Idempotency-Key': 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66' },
    body: JSON.stringify({ amount: '250.00', description: 'Office petty cash top-up', public_token: 'a'.repeat(64), target: { type: 'REVENUE', revenue_account_code: '4000' } }),
  })
  assert.equal(response.status, 201)
  const payload = await response.json()
  assert.equal(payload.data.link.amount, '250.00')
  assert.equal(payload.data.token, 'a'.repeat(64))
  assert.equal(calls[0].actor.customerId, 'admin-id')
  assert.equal(calls[0].idempotencyKey, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66')
  assert.deepEqual(calls[0].input.target, { type: 'REVENUE', revenue_account_code: '4000' })
})

test('A/R link creation verifies customer and full outstanding balance before persistence', async (t) => {
  const creates = []
  const lookups = []
  const app = express()
  app.use(express.json())
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async () => ({ customerId: 'admin-id', role: 'admin', active: true }) },
    paymentLinkService: { createLink: async (...args) => { creates.push(args); return { link: {}, token: 't'.repeat(43) } }, listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
    itcFinanceClient: { getReceivable: async (...args) => { lookups.push(args); return { customer_id: args[0], receivable_id: args[1], outstanding_amount: '250.00', currency: 'ZMW', status: 'OPEN' } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const response = await fetch(`${url}/payment-links`, {
    method: 'POST', headers: { cookie: 'itc_backoffice_access=admin', 'content-type': 'application/json', 'Idempotency-Key': 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66' },
    body: JSON.stringify({ amount: '250.00', description: 'Invoice', public_token: 'a'.repeat(64), target: { type: 'AR_SETTLEMENT', customer_id: '50000000-0000-4000-8000-000000000001', receivable_id: '50000000-0000-4000-8000-000000000002' } }),
  })
  assert.equal(response.status, 201)
  assert.deepEqual(lookups, [['50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', undefined]])
  assert.equal(creates.length, 1)
  const staleAmount = await fetch(`${url}/payment-links`, {
    method: 'POST', headers: { cookie: 'itc_backoffice_access=admin', 'content-type': 'application/json', 'Idempotency-Key': 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f67' },
    body: JSON.stringify({ amount: '251.00', description: 'Invoice', public_token: 'b'.repeat(64), target: { type: 'AR_SETTLEMENT', customer_id: '50000000-0000-4000-8000-000000000001', receivable_id: '50000000-0000-4000-8000-000000000002' } }),
  })
  assert.equal(staleAmount.status, 422)
  assert.equal(creates.length, 1)
})

test('payment-link management rejects invalid amount and unknown fields', async (t) => {
  let calls = 0
  const app = express()
  app.use(express.json())
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async () => ({ customerId: 'admin-id', role: 'admin', active: true }) },
    paymentLinkService: { createLink: async () => { calls++; return {} }, listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const invalid = await fetch(`${url}/payment-links`, { method: 'POST', headers: { cookie: 'itc_backoffice_access=ok', 'content-type': 'application/json' }, body: JSON.stringify({ amount: '0', description: 'Test' }) })
  assert.equal(invalid.status, 400)
  const extra = await fetch(`${url}/payment-links`, { method: 'POST', headers: { cookie: 'itc_backoffice_access=ok', 'content-type': 'application/json', 'Idempotency-Key': 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66' }, body: JSON.stringify({ amount: '1.00', description: 'Test', public_token: 'a'.repeat(64), expires_at: 'tomorrow' }) })
  assert.equal(extra.status, 400)
  const missingKey = await fetch(`${url}/payment-links`, { method: 'POST', headers: { cookie: 'itc_backoffice_access=ok', 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1.00', description: 'Test', public_token: 'a'.repeat(64) }) })
  assert.equal(missingKey.status, 400)
  assert.equal(calls, 0)
})

test('customer directory search is admin-only, bounded, and exposes only the signed ITC response', async (t) => {
  const calls = []
  const app = express()
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie.includes('admin') ? 'admin-id' : 'staff-id', role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    paymentLinkService: { createLink: async () => ({}), listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
    itcFinanceClient: { listCustomers: async (...args) => { calls.push(args); return { items: [{ customer_id: '50000000-0000-4000-8000-000000000001', display_name: 'Chanda Banda', company_name: null, phone_last4: '1234' }], has_more: false } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const denied = await fetch(`${url}/payment-links/customers?search=Chanda`, { headers: { cookie: 'itc_backoffice_access=staff' } })
  assert.equal(denied.status, 403)
  const invalid = await fetch(`${url}/payment-links/customers?search=x`, { headers: { cookie: 'itc_backoffice_access=admin' } })
  assert.equal(invalid.status, 400)
  const response = await fetch(`${url}/payment-links/customers?search=Chanda&limit=10&offset=5`, { headers: { cookie: 'itc_backoffice_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { data: { customers: { items: [{ customer_id: '50000000-0000-4000-8000-000000000001', display_name: 'Chanda Banda', company_name: null, phone_last4: '1234' }], has_more: false } } })
  assert.equal(calls.length, 1)
  assert.deepEqual({ ...calls[0][0] }, { search: 'Chanda', limit: 10, offset: 5 })
})

test('postable revenue account catalog is proxied to admins only', async (t) => {
  let called = 0
  const app = express()
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie.includes('admin') ? 'admin-id' : 'staff-id', role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    paymentLinkService: { createLink: async () => ({}), listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
    itcFinanceClient: { getRevenueAccounts: async () => { called++; return [{ account_code: '4000', account_name: 'Product Sales – Standard Rated' }] } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const denied = await fetch(`${url}/payment-links/revenue-accounts`, { headers: { cookie: 'itc_backoffice_access=staff' } })
  assert.equal(denied.status, 403)
  const response = await fetch(`${url}/payment-links/revenue-accounts`, { headers: { cookie: 'itc_backoffice_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { data: { accounts: [{ account_code: '4000', account_name: 'Product Sales – Standard Rated' }] } })
  assert.equal(called, 1)
})

test('delivered receivable catalog is admin-only, bounded, and not cached', async (t) => {
  const calls = []
  const app = express()
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: '50000000-0000-4000-8000-000000000001', role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    paymentLinkService: { createLink: async () => ({}), listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
    itcFinanceClient: { getReceivables: async (...args) => { calls.push(args); return { items: [{ receivable_id: '60000000-0000-4000-8000-000000000001', invoice_number: 'INV-1', outstanding_amount: '250.00' }], has_more: false, next_cursor: null, as_of: '2026-10-20T00:00:00.000Z' } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())
  const path = '/payment-links/customers/50000000-0000-4000-8000-000000000001/receivables?limit=10'
  const denied = await fetch(`${url}${path}`, { headers: { cookie: 'itc_backoffice_access=staff' } })
  assert.equal(denied.status, 403)
  const response = await fetch(`${url}${path}`, { headers: { cookie: 'itc_backoffice_access=admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['50000000-0000-4000-8000-000000000001', { limit: 10, cursor: null }, undefined])
})

test('delivered receivable catalog rejects an invalid customer id before ITC lookup', async (t) => {
  let called = false
  const app = express()
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async () => ({ customerId: 'admin-id', role: 'admin', active: true }) },
    paymentLinkService: { createLink: async () => ({}), listLinks: async () => ({ items: [] }), disableLink: async () => ({}) },
    itcFinanceClient: { getReceivables: async () => { called = true; return { items: [] } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const response = await fetch(`${url}/payment-links/customers/not-a-uuid/receivables`, {
    headers: { cookie: 'itc_backoffice_access=admin' },
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_CUSTOMER_ID', message: 'Customer identifier is invalid' } })
  assert.equal(called, false)
})
