const test = require('node:test')
const assert = require('node:assert/strict')

const { loadConfig } = require('../src/config/env')

test('loadConfig rejects missing dedicated database credentials', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      PORT: '3100',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_NAME: '',
      DB_USER: '',
      DB_PASSWORD: '',
      ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
    }),
    (error) => error.code === 'CONFIG_INVALID'
  )
})

test('loadConfig rejects production HTTP ITC integration URLs', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_PORT: '5432',
      DB_NAME: 'expense_warrior',
      DB_USER: 'expense_warrior_api',
      DB_PASSWORD: 'configured-for-test',
      ITC_API_BASE_URL: 'http://itc.internal/api/v1',
    }),
    (error) => error.code === 'CONFIG_INVALID'
  )
})

test('loadConfig exposes PawaPay config and rejects the sandbox API in production', () => {
  const values = {
    NODE_ENV: 'production',
    DB_HOST: 'db.internal',
    DB_PORT: '5432',
    DB_NAME: 'expense_warrior',
    DB_USER: 'expense_warrior_api',
    DB_PASSWORD: 'configured-for-test',
    DB_SSL_MODE: 'require',
    ITC_API_BASE_URL: 'https://itc.internal/api/v1',
    PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: 'k1',
  }
  assert.throws(() => loadConfig(values), (error) => error.code === 'CONFIG_INVALID' && error.details.includes('PAWAPAY_BASE_URL'))

  const config = loadConfig({ ...values, PAWAPAY_BASE_URL: 'https://api.pawapay.io' })
  assert.equal(config.pawaPay.baseUrl, 'https://api.pawapay.io')
  assert.equal(config.pawaPay.signatureEnabled, true)
  assert.equal(config.pawaPay.signaturePrivateKeyPath, './keys/pawapay-signing-private.pem')
})

test('PawaPay callback inbox is disabled by default and can be explicitly enabled', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'api', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.equal(loadConfig(values).pawaPay.callbackInboxEnabled, false)
  assert.equal(loadConfig({ ...values, PAWAPAY_CALLBACK_INBOX_ENABLED: 'true' }).pawaPay.callbackInboxEnabled, true)
  assert.equal(loadConfig(values).pawaPay.collectionsEnabled, false)
  assert.equal(loadConfig(values).pawaPay.payoutsEnabled, false)
  assert.equal(loadConfig(values).pawaPay.signedRequestsOnlyConfirmed, false)
  const confirmedFinancialOperations = {
    ...values,
    PAWAPAY_COLLECTIONS_ENABLED: 'true',
    PAWAPAY_PAYOUTS_ENABLED: 'true',
    PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED: 'true',
  }
  assert.equal(loadConfig(confirmedFinancialOperations).pawaPay.collectionsEnabled, true)
  assert.equal(loadConfig(confirmedFinancialOperations).pawaPay.payoutsEnabled, true)
})

test('loadConfig requires Cloudinary credentials as a complete set', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'api', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.throws(() => loadConfig({ ...values, CLOUDINARY_CLOUD_NAME: 'cloud' }), (error) => error.code === 'CONFIG_INVALID')
  const config = loadConfig({ ...values, CLOUDINARY_CLOUD_NAME: 'cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret' })
  assert.deepEqual(config.attachments, { cloudName: 'cloud', apiKey: 'key', apiSecret: 'secret' })
  const production = { ...values, NODE_ENV: 'production', DB_SSL_MODE: 'require', ITC_API_BASE_URL: 'https://itc.internal/api/v1', PAWAPAY_BASE_URL: 'https://api.pawapay.io', EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: 'k1' }
  delete production.CLOUDINARY_CLOUD_NAME
  assert.throws(() => loadConfig(production), (error) => error.code === 'CONFIG_INVALID' && error.details.includes('CLOUDINARY_CLOUD_NAME'))
})

test('financial PawaPay operations require explicit account-level signed-only confirmation', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'api', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }

  assert.throws(
    () => loadConfig({ ...values, PAWAPAY_COLLECTIONS_ENABLED: 'true' }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED')
  )
  assert.throws(
    () => loadConfig({ ...values, PAWAPAY_PAYOUTS_ENABLED: 'true' }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED')
  )

  const config = loadConfig({
    ...values,
    PAWAPAY_COLLECTIONS_ENABLED: 'true',
    PAWAPAY_PAYOUTS_ENABLED: 'true',
    PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED: 'true',
  })
  assert.equal(config.pawaPay.signedRequestsOnlyConfirmed, true)
})
