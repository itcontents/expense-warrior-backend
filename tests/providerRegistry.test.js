const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createProviderRegistry, ProviderRegistryError } = require('../src/providers/providerRegistry')

const airtelNetwork = { code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money' }

test('provider registry exposes deposit capabilities across lazy registered adapters', () => {
  let created = 0
  const registry = createProviderRegistry({
    additionalProviders: {
      airtel_direct: {
        contractVersion: 1,
        create: () => { created += 1; return { contractVersion: 1, initiateDeposit() {} } },
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

test('provider registry exposes a validated configured account identity for internal collection posting', () => {
  const registry = createProviderRegistry({ pawaPayConfig: {
    providerAccountId: '70000000-0000-4000-8000-000000000001', providerAccountVersion: 4,
  } })
  assert.deepEqual(registry.getAccountIdentity('pawapay'), {
    provider_account_id: '70000000-0000-4000-8000-000000000001', provider_account_version: 4,
  })
  assert.throws(() => createProviderRegistry({ pawaPayConfig: {} }).getAccountIdentity('pawapay'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE')
  assert.throws(() => registry.getForOperation('pawapay', 'deposit', {
    provider_account_id: '70000000-0000-4000-8000-000000000001', provider_account_version: 3,
  }), (error) => error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE')
})

test('active payment options are resolved through the provider adapter', async () => {
  let requestedUrl
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const signaturePrivateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const registry = createProviderRegistry({
    pawaPayConfig: { apiToken: 'sandbox-test-token', baseUrl: 'https://api.sandbox.pawapay.io', signatureEnabled: true, signatureKeyId: 'test', signaturePrivateKey },
    dependencies: { pawapay: { fetchImpl: async (url) => {
      requestedUrl = String(url)
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({
        countries: [{ country: 'ZMB', providers: [{ provider: 'AIRTEL_OAPI_ZMB', currencies: [{ currency: 'ZMW', operationTypes: [{ DEPOSIT: {
          status: 'OPERATIONAL', minTransactionLimit: '1', maxTransactionLimit: '1000', decimalsInAmount: 'TWO_PLACES', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC',
        } }] }] }] }],
      }) }
    } } },
  })

  const networks = await registry.getActiveNetworks('deposit', { country: 'ZMB', currency: 'ZMW' })

  assert.equal(requestedUrl, 'https://api.sandbox.pawapay.io/v2/active-conf?country=ZMB&operationType=DEPOSIT')
  assert.deepEqual(networks, [{
    provider_code: 'pawapay', code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money', min_amount: '1', max_amount: '1000',
    decimals_in_amount: 'TWO_PLACES', auth_type: 'PROVIDER_AUTH', pin_prompt: 'AUTOMATIC',
  }])
})

test('provider registry rejects malformed operation capability metadata', () => {
  const registry = createProviderRegistry({
    additionalProviders: {
      broken_adapter: {
        contractVersion: 1,
        create: () => ({ contractVersion: 1, initiateDeposit() {}, getDepositStatus() {} }),
        getNetworks: () => ({ code: 'AIRTEL_OAPI_ZMB' }),
      },
    },
  })
  assert.throws(() => registry.getForOperation('broken_adapter', 'deposit'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE')
})

test('provider registry rejects unsafe, duplicate, and incomplete add-on definitions', () => {
  const validDefinition = { contractVersion: 1, create: () => ({}), getNetworks: () => [] }
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
      contractVersion: 1,
      create: () => ({ contractVersion: 1, initiateRefund() {}, getRefundStatus() {} }),
      getNetworks: () => [],
    },
  } })
  assert.equal(typeof complete.getForOperation('refund_addon', 'refund').initiateRefund, 'function')
  assert.equal(typeof complete.getForOperation('refund_addon', 'refund').getRefundStatus, 'function')
  const incomplete = createProviderRegistry({ additionalProviders: {
    refund_addon: {
      contractVersion: 1,
      create: () => ({ contractVersion: 1, initiateRefund() {} }),
      getNetworks: () => [],
    },
  } })
  assert.throws(() => incomplete.getForOperation('refund_addon', 'refund'), (error) =>
    error instanceof ProviderRegistryError && error.code === 'PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE')
})
