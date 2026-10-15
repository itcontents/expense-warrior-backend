const test = require('node:test')
const assert = require('node:assert/strict')
const { createProviderRegistry, ProviderRegistryError } = require('../src/providers/providerRegistry')

const airtelNetwork = { code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money' }

test('provider registry exposes deposit capabilities across lazy registered adapters', () => {
  let created = 0
  const registry = createProviderRegistry({
    additionalProviders: {
      airtel_direct: {
        create: () => { created += 1; return { initiateDeposit() {} } },
        getNetworks: (operation) => operation === 'deposit' ? [airtelNetwork] : [],
      },
    },
  })

  assert.deepEqual(registry.list(), ['pawapay', 'airtel_direct'])
  assert.deepEqual(registry.getNetworks(undefined, 'deposit'), [
    { provider_code: 'pawapay', code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money' },
    { provider_code: 'pawapay', code: 'MTN_MOMO_ZMB', label: 'MTN MoMo' },
    { provider_code: 'pawapay', code: 'ZAMTEL_ZMB', label: 'Zamtel Kwacha' },
    { provider_code: 'airtel_direct', code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money' },
  ])
  assert.deepEqual(registry.getNetworks('airtel_direct', 'payout'), [])
  assert.equal(created, 0)
  assert.equal(typeof registry.get('airtel_direct').initiateDeposit, 'function')
  assert.equal(created, 1)
  assert.throws(() => registry.getForOperation('airtel_direct', 'payout'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE')
})

test('PawaPay exposes its configured Zambian deposit and payout networks separately from other operations', () => {
  const registry = createProviderRegistry({ pawaPayConfig: {} })
  assert.deepEqual(registry.getNetworks('pawapay', 'payout').map(({ code }) => code), [
    'AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB',
  ])
  assert.deepEqual(registry.getNetworks('pawapay', 'balance'), [])
})

test('provider registry rejects malformed operation capability metadata', () => {
  const registry = createProviderRegistry({
    additionalProviders: {
      broken_adapter: {
        create: () => ({ initiateDeposit() {}, getDepositStatus() {} }),
        getNetworks: () => ({ code: 'AIRTEL_OAPI_ZMB' }),
      },
    },
  })
  assert.throws(() => registry.getForOperation('broken_adapter', 'deposit'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE')
})

test('provider registry rejects unsafe, duplicate, and incomplete add-on definitions', () => {
  const validDefinition = { create: () => ({}), getNetworks: () => [] }
  for (const [providerCode, definition] of [
    ['PawaPay', validDefinition],
    ['pawapay', validDefinition],
    ['airtel', { create: () => ({}) }],
  ]) {
    assert.throws(() => createProviderRegistry({ additionalProviders: { [providerCode]: definition } }), TypeError)
  }
})

test('provider registry rejects lookups for an unregistered provider', () => {
  const registry = createProviderRegistry()
  assert.throws(() => registry.getNetworks('unknown_provider'), ProviderRegistryError)
  assert.throws(() => registry.get('unknown_provider'), ProviderRegistryError)
})

test('provider registry requires both refund initiation and refund status methods', () => {
  const complete = createProviderRegistry({ additionalProviders: {
    refund_addon: {
      create: () => ({ initiateRefund() {}, getRefundStatus() {} }),
      getNetworks: () => [],
    },
  } })
  assert.equal(typeof complete.getForOperation('refund_addon', 'refund').initiateRefund, 'function')
  assert.equal(typeof complete.getForOperation('refund_addon', 'refund').getRefundStatus, 'function')
  const incomplete = createProviderRegistry({ additionalProviders: {
    refund_addon: {
      create: () => ({ initiateRefund() {} }),
      getNetworks: () => [],
    },
  } })
  assert.throws(() => incomplete.getForOperation('refund_addon', 'refund'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE')
})
