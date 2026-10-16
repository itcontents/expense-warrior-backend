const test = require('node:test')
const assert = require('node:assert/strict')
const { createWalletBalanceService } = require('../src/wallet/walletBalanceService')

test('getBalance caches provider wallet balances for a bounded interval and supports forced refresh', async () => {
  let now = 1000
  let calls = 0
  const snapshots = []
  const service = createWalletBalanceService({
    providerRegistry: { get: () => ({ getWalletBalances: async () => ({ balances: [{ country: 'ZMB', currency: 'ZMW', balance: `${++calls}20.00`, provider: '' }] }) }) },
    snapshotRepository: { recordBatch: async (input) => { snapshots.push(input); return { snapshotBatchId: `batch-${snapshots.length}` } } },
    now: () => now,
    ttlMs: 30000,
  })

  const first = await service.getBalance()
  now += 10000
  const cached = await service.getBalance()
  const refreshed = await service.getBalance({ forceRefresh: true })

  assert.equal(first.balances[0].balance, '120.00')
  assert.equal(cached.cached, true)
  assert.equal(calls, 2)
  assert.equal(refreshed.balances[0].balance, '220.00')
  assert.equal(refreshed.cached, false)
  assert.equal(snapshots.length, 2)
  assert.equal(first.snapshot_persisted, true)
  assert.equal(cached.snapshot_persisted, undefined)
  assert.equal(refreshed.snapshot_persisted, true)
  assert.equal(refreshed.snapshot_batch_id, 'batch-2')
})

test('a snapshot persistence error does not replace a fresh verified provider balance with stale or fabricated data', async () => {
  const service = createWalletBalanceService({
    providerRegistry: { get: () => ({ getWalletBalances: async () => ({ balances: [{ country: 'ZMB', currency: 'ZMW', balance: '120.00', provider: 'MTN_MOMO_ZMB' }] }) }) },
    snapshotRepository: { recordBatch: async () => { throw Object.assign(new Error('db unavailable'), { code: 'DATABASE_UNAVAILABLE' }) } },
  })
  const result = await service.getBalance({ forceRefresh: true })
  assert.equal(result.balances[0].balance, '120.00')
  assert.equal(result.stale, false)
  assert.equal(result.snapshot_persisted, false)
  assert.equal(result.snapshot_error_code, 'DATABASE_UNAVAILABLE')
})

test('getBalance serves a clearly stale last known response when provider is unavailable', async () => {
  let now = 1000
  let failing = false
  const service = createWalletBalanceService({
    providerRegistry: { get: () => ({ getWalletBalances: async () => {
      if (failing) throw Object.assign(new Error('secret-safe'), { code: 'PAWAPAY_TIMEOUT' })
      return { balances: [{ country: 'ZMB', currency: 'ZMW', balance: '120.00', provider: '' }] }
    } }) },
    now: () => now,
    ttlMs: 30000,
  })

  const first = await service.getBalance()
  now += 31000
  failing = true
  const stale = await service.getBalance()

  assert.equal(first.stale, false)
  assert.equal(stale.stale, true)
  assert.equal(stale.error_code, 'PAWAPAY_TIMEOUT')
  assert.equal(stale.balances[0].balance, '120.00')
})

test('getBalance rejects malformed provider balance payloads instead of presenting made up data', async () => {
  const service = createWalletBalanceService({ providerRegistry: { get: () => ({ getWalletBalances: async () => ({ balances: [{ country: 'ZMB', currency: 'ZMW', balance: 'oops', provider: '' }] }) }) } })
  await assert.rejects(service.getBalance(), { code: 'PROVIDER_BALANCE_RESPONSE_INVALID' })
})

test('getBalance coalesces concurrent cache misses into one provider read', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = createWalletBalanceService({ providerRegistry: { get: () => ({ getWalletBalances: async () => {
    calls++
    await gate
    return { balances: [{ country: 'ZMB', currency: 'ZMW', balance: '120.00', provider: '' }] }
  } }) } })

  const pending = [service.getBalance(), service.getBalance(), service.getBalance()]
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const results = await Promise.all(pending)

  assert.equal(calls, 1)
  assert.equal(results.length, 3)
  assert.ok(results.every((result) => result.balances[0].balance === '120.00'))
})

test('balance cache and append-only snapshots are scoped to provider account identity', async () => {
  const snapshots = []
  const providers = {
    get: () => assert.fail('operation lookup should be used'),
    getForOperation: (code, operation) => {
      assert.equal(operation, 'balance')
      return { getWalletBalances: async () => ({ balances: [{ country: 'ZMB', currency: 'ZMW', balance: code === 'pawapay' ? '10.00' : '20.00', provider: '' }] }) }
    },
    getAccountIdentity: (code) => ({ provider_account_id: code === 'pawapay' ? 'a66ab1fc-89e0-4ff8-92b4-d41380bded9a' : 'b66ab1fc-89e0-4ff8-92b4-d41380bded9a', provider_account_version: 1 }),
  }
  const service = createWalletBalanceService({ providerRegistry: providers, snapshotRepository: { recordBatch: async (input) => {
    snapshots.push(input)
    return { snapshotBatchId: `${snapshots.length}` }
  } } })

  const primary = await service.getBalance()
  const addon = await service.getBalance({ providerCode: 'another_provider' })
  const cachedPrimary = await service.getBalance()

  assert.equal(primary.provider, 'pawapay')
  assert.equal(primary.provider_account_version, 1)
  assert.equal(addon.provider, 'another_provider')
  assert.equal(addon.balances[0].balance, '20.00')
  assert.equal(cachedPrimary.cached, true)
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map(({ provider, providerAccountVersion }) => [provider, providerAccountVersion]), [['pawapay', 1], ['another_provider', 1]])
})
