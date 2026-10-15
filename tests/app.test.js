const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { createApp } = require('../src/app')

async function withServer(app, run) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('healthRoute_isIndependentOfDatabase', async () => {
  const pool = { query: async () => { throw new Error('database should not be queried') } }
  await withServer(createApp({ pool }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })
})

test('ready_returns503WhenDatabaseProbeFails', async () => {
  const pool = { query: async () => { throw new Error('database unavailable') } }
  await withServer(createApp({ pool }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ready`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { status: 'not_ready', code: 'DATABASE_UNAVAILABLE' })
  })
})

test('ready_returns200WhenDatabaseProbeSucceeds', async () => {
  const pool = { query: async () => ({ rows: [{ ok: 1 }] }) }
  await withServer(createApp({ pool }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ready`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ready' })
  })
})

test('appMountsTheAdminOnlyPawaPayWalletBalanceRouteWhenProviderRegistryIsConfigured', async () => {
  let requestedCountry
  const app = createApp({
    pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error('wallet reads do not need the Expense Warrior database') } },
    identityClient: { getSession: async () => ({ customerId: 'admin-id', role: 'admin', active: true }) },
    paymentProviders: { get: () => ({ getWalletBalances: async ({ country }) => {
      requestedCountry = country
      return { balances: [{ country, currency: 'ZMW', balance: '245.00', provider: 'MTN_MOMO_ZMB' }] }
    } }) },
    itcFinanceClient: { getBalance: async () => ({ currency: 'ZMW', posted_balance: '300.00', active_holds: '55.00', available_balance: '245.00', as_of: '2026-10-15T12:00:00.000Z' }) },
  })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/wallet/provider-balance`, { headers: { cookie: 'itc_backoffice_access=valid' } })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(requestedCountry, 'ZMB')
    assert.equal(payload.data.balances[0].balance, '245.00')
    assert.equal(payload.data.stale, false)

    const ledger = await fetch(`${baseUrl}/api/v1/expense-warrior/wallet/ledger-balance`, { headers: { cookie: 'itc_backoffice_access=valid' } })
    assert.equal(ledger.status, 200)
    const ledgerPayload = await ledger.json()
    assert.equal(ledgerPayload.data.source, 'itc_ledger')
    assert.equal(ledgerPayload.data.available_balance, '245.00')
  })
})
