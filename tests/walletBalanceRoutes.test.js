const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createWalletBalanceRouter } = require('../src/wallet/walletBalanceRoutes')

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('wallet balance route is admin-only and returns freshness metadata without caching in browsers', async (t) => {
  let calls = 0
  const app = express()
  app.use(createWalletBalanceRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin-session') ? 'admin' : 'staff', active: true }) },
    walletBalanceService: { getBalance: async (options) => { calls++; return { provider: 'pawapay', country: 'ZMB', balances: [], fetched_at: '2026-10-15T12:00:00.000Z', stale: false, cached: false, force: options.forceRefresh } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const forbidden = await fetch(`${url}/wallet/provider-balance`, { headers: { cookie: 'itc_expense_warrior_access=staff-session' } })
  assert.equal(forbidden.status, 403)
  const response = await fetch(`${url}/wallet/provider-balance?refresh=true`, { headers: { cookie: 'itc_expense_warrior_access=admin-session' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const payload = await response.json()
  assert.equal(payload.data.force, true)
  assert.equal(calls, 1)
})

test('wallet balance route rejects an unsupported refresh query before provider access', async (t) => {
  let calls = 0
  const app = express()
  app.use(createWalletBalanceRouter({
    identityClient: { getSession: async () => ({ customerId: 'admin-id', role: 'admin', active: true }) },
    walletBalanceService: { getBalance: async () => { calls++; return {} } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const response = await fetch(`${url}/wallet/provider-balance?refresh=yes`, { headers: { cookie: 'itc_expense_warrior_access=valid' } })
  assert.equal(response.status, 400)
  assert.equal(calls, 0)
})

test('provider balance snapshot history is bounded and admin-only', async (t) => {
  let received
  const app = express()
  app.use(createWalletBalanceRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    walletBalanceService: { getBalance: async () => ({ balances: [] }) },
    snapshotRepository: { listRecent: async (options) => { received = options; return [{ snapshot_batch_id: 'batch-1' }] } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const forbidden = await fetch(`${url}/wallet/provider-balance/history`, { headers: { cookie: 'itc_expense_warrior_access=staff-session' } })
  assert.equal(forbidden.status, 403)
  const invalid = await fetch(`${url}/wallet/provider-balance/history?limit=101`, { headers: { cookie: 'itc_expense_warrior_access=admin-session' } })
  assert.equal(invalid.status, 400)
  const response = await fetch(`${url}/wallet/provider-balance/history?limit=25`, { headers: { cookie: 'itc_expense_warrior_access=admin-session' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(received, { limit: 25, providerCode: 'pawapay' })
  assert.deepEqual((await response.json()).data.snapshots, [{ snapshot_batch_id: 'batch-1' }])
})

test('ITC ledger balance route requires admin and returns the authoritative ledger fields without caching', async (t) => {
  let calls = 0
  const app = express()
  app.use(createWalletBalanceRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    walletBalanceService: { getBalance: async () => ({ balances: [] }) },
    itcFinanceClient: { getBalance: async () => { calls++; return { currency: 'ZMW', posted_balance: '1000.25', active_holds: '125.75', available_balance: '874.50', as_of: '2026-10-15T12:00:00.000Z' } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const forbidden = await fetch(`${url}/wallet/ledger-balance`, { headers: { cookie: 'itc_expense_warrior_access=staff-session' } })
  assert.equal(forbidden.status, 403)
  assert.equal(calls, 0)

  const response = await fetch(`${url}/wallet/ledger-balance`, { headers: { cookie: 'itc_expense_warrior_access=admin-session' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual((await response.json()).data, { source: 'itc_ledger', currency: 'ZMW', posted_balance: '1000.25', active_holds: '125.75', available_balance: '874.50', as_of: '2026-10-15T12:00:00.000Z' })
  assert.equal(calls, 1)
})

test('ITC ledger history is admin-only, bounded, filtered, and never browser cached', async (t) => {
  let received
  const app = express()
  app.use(createWalletBalanceRouter({
    identityClient: { getSession: async (cookie) => ({ customerId: cookie, role: cookie.includes('admin') ? 'admin' : 'staff', active: true }) },
    walletBalanceService: { getBalance: async () => ({ balances: [] }) },
    itcFinanceClient: { getLedgerHistory: async (...args) => { received = args; return { source: 'itc_ledger', items: [], has_more: false, next_cursor: null, as_of: '2026-10-15T12:00:00.000Z' } } },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const forbidden = await fetch(`${url}/wallet/ledger-history`, { headers: { cookie: 'itc_expense_warrior_access=staff-session' } })
  assert.equal(forbidden.status, 403)
  const response = await fetch(`${url}/wallet/ledger-history?date_from=2026-10-15T00%3A00%3A00.000Z&limit=25`, { headers: { cookie: 'itc_expense_warrior_access=admin-session' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(received[0], { dateFrom: '2026-10-15T00:00:00.000Z', dateTo: null, limit: 25, cursor: null })
  assert.equal(received[1], undefined)
})
