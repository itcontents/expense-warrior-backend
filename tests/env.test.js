const test = require('node:test')
const assert = require('node:assert/strict')

const { loadConfig, loadMigrationTargetConfig } = require('../src/config/env')

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

test('ITC commerce receivables cannot be enabled by an environment variable', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.equal('commerceReceivablesEnabled' in loadConfig(values).itc, false)
  assert.equal('commerceReceivablesEnabled' in loadConfig({ ...values, ITC_COMMERCE_RECEIVABLES_ENABLED: 'true' }).itc, false)
})

test('loadConfig keeps migration credentials out of the runtime and rejects partial or shared identities', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'expense_warrior',
    DB_USER: 'expense_warrior_app', DB_PASSWORD: 'runtime-password',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.equal(loadConfig(values).migrationDatabase, null)

  const migrationValues = {
    ...values, DB_MIGRATION_USER: 'expense_warrior_migrator', DB_MIGRATION_PASSWORD: 'migration-password',
  }
  assert.throws(() => loadConfig(migrationValues),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('DB_MIGRATION_USER'))
  const config = loadConfig(migrationValues, { includeMigrationCredentials: true })
  assert.deepEqual(config.migrationDatabase, {
    host: '127.0.0.1', port: 5432, database: 'expense_warrior',
    user: 'expense_warrior_migrator', password: 'migration-password', ssl: false, options: '-c search_path=public,pg_temp',
  })

  assert.throws(() => loadConfig({ ...values, DB_MIGRATION_USER: 'expense_warrior_migrator' }, { includeMigrationCredentials: true }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('DB_MIGRATION_PASSWORD'))
  assert.throws(() => loadConfig({ ...values, DB_MIGRATION_USER: values.DB_USER, DB_MIGRATION_PASSWORD: 'migration-password' }, { includeMigrationCredentials: true }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('DB_MIGRATION_USER'))
})

test('loadConfig requires the dedicated runtime role named by the permission migrations', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'expense_warrior',
    DB_USER: 'expense_warrior_api', DB_PASSWORD: 'runtime-password',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.throws(() => loadConfig(values),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('DB_USER'))
  assert.doesNotThrow(() => loadConfig({ ...values, DB_USER: 'expense_warrior_app' }))
})

test('loadConfig rejects production HTTP ITC integration URLs', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_PORT: '5432',
      DB_NAME: 'expense_warrior',
      DB_USER: 'expense_warrior_app',
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
    DB_USER: 'expense_warrior_app',
    DB_PASSWORD: 'configured-for-test',
    DB_SSL_MODE: 'require',
    ITC_API_BASE_URL: 'https://itc.internal/api/v1',
    PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: 'k1',
    EXPENSE_WARRIOR_BROWSER_ORIGINS: 'https://expense.itcontents.com',
  }
  assert.throws(() => loadConfig(values), (error) => error.code === 'CONFIG_INVALID' && error.details.includes('PAWAPAY_BASE_URL'))

  const config = loadConfig({ ...values, PAWAPAY_BASE_URL: 'https://api.pawapay.io' })
  assert.equal(config.pawaPay.baseUrl, 'https://api.pawapay.io')
  assert.equal(config.pawaPay.signatureEnabled, true)
  assert.equal(config.pawaPay.signaturePrivateKeyPath, './keys/pawapay-signing-private.pem')
})

test('loadConfig requires explicit HTTPS browser origins in production and rejects non-origin URLs', () => {
  const values = {
    NODE_ENV: 'production', DB_HOST: 'db.internal', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
    DB_SSL_MODE: 'require', ITC_API_BASE_URL: 'https://itc.internal/api/v1', PAWAPAY_BASE_URL: 'https://api.pawapay.io',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: 'k1',
    CLOUDINARY_CLOUD_NAME: 'test-cloud', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret',
  }
  assert.throws(() => loadConfig(values), (error) => error.code === 'CONFIG_INVALID' && error.details.includes('EXPENSE_WARRIOR_BROWSER_ORIGINS'))
  assert.throws(() => loadConfig({ ...values, EXPENSE_WARRIOR_BROWSER_ORIGINS: 'http://expense.itcontents.com' }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('EXPENSE_WARRIOR_BROWSER_ORIGINS'))
  assert.throws(() => loadConfig({ ...values, EXPENSE_WARRIOR_BROWSER_ORIGINS: 'https://expense.itcontents.com/admin' }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.includes('EXPENSE_WARRIOR_BROWSER_ORIGINS'))
  const config = loadConfig({ ...values, EXPENSE_WARRIOR_BROWSER_ORIGINS: 'https://expense.itcontents.com,https://admin.itcontents.com' })
  assert.deepEqual(config.browserOrigins, ['https://expense.itcontents.com', 'https://admin.itcontents.com'])
})

test('PawaPay callback inbox is disabled by default and can be explicitly enabled', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
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
    ITC_PAWAPAY_PROVIDER_ACCOUNT_ID: '70000000-0000-4000-8000-000000000001',
    ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION: '2',
  }
  assert.equal(loadConfig(confirmedFinancialOperations).pawaPay.collectionsEnabled, true)
  assert.equal(loadConfig(confirmedFinancialOperations).pawaPay.payoutsEnabled, true)
  assert.equal(loadConfig(confirmedFinancialOperations).pawaPay.providerAccountVersion, 2)
})

test('PawaPay collections require an explicit matching ITC provider account identity', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1', PAWAPAY_COLLECTIONS_ENABLED: 'true',
    PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED: 'true',
  }
  assert.throws(() => loadConfig(values), (error) => error.code === 'CONFIG_INVALID' &&
    error.details.includes('ITC_PAWAPAY_PROVIDER_ACCOUNT_ID'))
})

test('loadConfig requires Cloudinary credentials as a complete set', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
    ITC_API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  }
  assert.throws(() => loadConfig({ ...values, CLOUDINARY_CLOUD_NAME: 'cloud' }), (error) => error.code === 'CONFIG_INVALID')
  const config = loadConfig({ ...values, CLOUDINARY_CLOUD_NAME: 'cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret' })
  assert.deepEqual(config.attachments, { cloudName: 'cloud', apiKey: 'key', apiSecret: 'secret' })
  const production = { ...values, NODE_ENV: 'production', DB_SSL_MODE: 'require', ITC_API_BASE_URL: 'https://itc.internal/api/v1', PAWAPAY_BASE_URL: 'https://api.pawapay.io', EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: '{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: 'k1', EXPENSE_WARRIOR_BROWSER_ORIGINS: 'https://expense.itcontents.com' }
  delete production.CLOUDINARY_CLOUD_NAME
  assert.throws(() => loadConfig(production), (error) => error.code === 'CONFIG_INVALID' && error.details.includes('CLOUDINARY_CLOUD_NAME'))
})

test('financial PawaPay operations require explicit account-level signed-only confirmation', () => {
  const values = {
    NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_NAME: 'expense_warrior', DB_USER: 'expense_warrior_app', DB_PASSWORD: 'configured-for-test',
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
    ITC_PAWAPAY_PROVIDER_ACCOUNT_ID: '70000000-0000-4000-8000-000000000001',
    ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION: '2',
  })
  assert.equal(config.pawaPay.signedRequestsOnlyConfirmed, true)
})

test('migration target config requires a named allowlisted target and complete exact identity', () => {
  const values = {
    DB_MIGRATION_TARGET: 'local',
    DB_MIGRATION_ALLOWED_TARGETS: 'local, staging',
    DB_MIGRATION_TARGETS_JSON: JSON.stringify({
      local: { host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator' },
      staging: { host: 'staging-db.example.test', port: 5432, database: 'expense_warrior_staging', user: 'expense_warrior_migrator' },
    }),
    DB_MIGRATION_TARGET_HOST: '127.0.0.1',
    DB_MIGRATION_TARGET_PORT: '5432',
    DB_MIGRATION_TARGET_DATABASE: 'expense_warrior',
    DB_USER: 'expense_warrior_app',
    DB_MIGRATION_USER: 'expense_warrior_migrator',
    DB_MIGRATION_PASSWORD: 'migration-test-password',
  }
  assert.deepEqual(loadMigrationTargetConfig(values), {
    name: 'local', host: '127.0.0.1', port: 5432,
    database: 'expense_warrior', user: 'expense_warrior_migrator', schema: 'public', searchPath: 'public, pg_temp',
  })

  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET: '' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_PASSWORD: '' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID' && error.details.includes('DB_MIGRATION_PASSWORD'))
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET: 'production' }),
    (error) => error.code === 'MIGRATION_TARGET_NOT_ALLOWLISTED')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET_HOST: '' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_USER: 'expense_warrior_app' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGETS_JSON: '' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET_HOST: 'staging-db.example.test' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET_DATABASE: 'itc' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET_DATABASE: 'local_staging' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_TARGET_DATABASE: 'staging' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_USER: 'shopit_dba' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({ ...values, DB_MIGRATION_USER: 'EXPENSE_WARRIOR_MIGRATOR' }),
    (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
  assert.throws(() => loadMigrationTargetConfig({
    ...values,
    DB_MIGRATION_TARGETS_JSON: JSON.stringify({
      local: { host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator' },
      staging: { host: 'staging-db.example.test', port: 5432, database: 'itc', user: 'expense_warrior_migrator' },
    }),
  }), (error) => error.code === 'MIGRATION_TARGET_CONFIG_INVALID')
})
