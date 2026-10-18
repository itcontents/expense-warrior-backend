const Joi = require('joi')
const { parseAllowedBrowserOrigins } = require('../auth/cookieCsrfGuard')

const configSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3100),
  DB_HOST: Joi.string().trim().min(1).required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
  DB_NAME: Joi.string().trim().min(1).required(),
  DB_USER: Joi.string().trim().min(1).required(),
  DB_PASSWORD: Joi.string().min(1).required(),
  DB_MIGRATION_USER: Joi.string().trim().allow('').default(''),
  DB_MIGRATION_PASSWORD: Joi.string().allow('').default(''),
  DB_SSL_MODE: Joi.string().valid('disable', 'require', 'verify-full').default('disable'),
  ITC_API_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
  ITC_IDENTITY_TIMEOUT_MS: Joi.number().integer().min(500).max(15000).default(5000),
  ITC_FINANCE_TIMEOUT_MS: Joi.number().integer().min(500).max(30000).default(10000),
  ITC_SERVICE_CLIENT_ID: Joi.string().trim().allow('').default(''),
  ITC_SERVICE_CLIENT_SECRET: Joi.string().allow('').default(''),
  CLOUDINARY_CLOUD_NAME: Joi.string().allow('').default(''),
  CLOUDINARY_API_KEY: Joi.string().allow('').default(''),
  CLOUDINARY_API_SECRET: Joi.string().allow('').default(''),
  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).allow('').default(''),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASS: Joi.string().allow('').default(''),
  EMAIL_FROM: Joi.string().allow('').default(''),
  PAWAPAY_API_TOKEN: Joi.string().allow('').default(''),
  ITC_PAWAPAY_PROVIDER_ACCOUNT_ID: Joi.string().guid({ version: ['uuidv4'] }).allow('').default(''),
  ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION: Joi.number().integer().min(1).allow('').default(''),
  PAWAPAY_BASE_URL: Joi.string().valid('https://api.sandbox.pawapay.io', 'https://api.pawapay.io').default('https://api.sandbox.pawapay.io'),
  PAWAPAY_DEPOSITS_CALLBACK_URL: Joi.string().uri({ scheme: ['https'] }).allow('').default(''),
  PAWAPAY_PAYOUTS_CALLBACK_URL: Joi.string().uri({ scheme: ['https'] }).allow('').default(''),
  PAWAPAY_SIGNATURE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED: Joi.boolean().truthy('true').falsy('false').default(false),
  PAWAPAY_COLLECTIONS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PAWAPAY_PAYOUTS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PAWAPAY_CALLBACK_INBOX_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PAWAPAY_SIGNATURE_KEY_ID: Joi.string().allow('').default(''),
  PAWAPAY_SIGNATURE_PRIVATE_KEY_PATH: Joi.string().allow('').default('./keys/pawapay-signing-private.pem'),
  PAWAPAY_SIGNATURE_PUBLIC_KEY_PATH: Joi.string().allow('').default('./keys/pawapay-signing-public.pem'),
  PAWAPAY_REQUEST_TIMEOUT_MS: Joi.number().integer().min(500).max(30000).default(15000),
  PAWAPAY_FINAL_STATUS_TIMEOUT_MS: Joi.number().integer().min(10000).max(180000).default(60000),
  PAWAPAY_FINAL_STATUS_POLL_INTERVAL_MS: Joi.number().integer().min(1000).max(15000).default(5000),
  EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON: Joi.string().allow('').default(''),
  EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID: Joi.string().allow('').default(''),
  EXPENSE_WARRIOR_BROWSER_ORIGINS: Joi.string().trim().allow('').default(''),
}).unknown(true)

function loadConfig(source = process.env, { includeMigrationCredentials = false } = {}) {
  const { value, error } = configSchema.validate(source, {
    abortEarly: false,
    convert: true,
    stripUnknown: true,
  })

  if (error) {
    const failure = new Error('Expense Warrior environment configuration is invalid')
    failure.code = 'CONFIG_INVALID'
    failure.details = error.details.map((detail) => detail.path.join('.'))
    throw failure
  }

  if (!includeMigrationCredentials && (value.DB_MIGRATION_USER || value.DB_MIGRATION_PASSWORD)) {
    const failure = new Error('Migration database credentials are not available to the runtime application')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['DB_MIGRATION_USER']
    throw failure
  }
  if (Boolean(value.DB_MIGRATION_USER) !== Boolean(value.DB_MIGRATION_PASSWORD)) {
    const failure = new Error('Migration database credentials must be configured as a separate user and password pair')
    failure.code = 'CONFIG_INVALID'
    failure.details = [value.DB_MIGRATION_USER ? 'DB_MIGRATION_PASSWORD' : 'DB_MIGRATION_USER']
    throw failure
  }
  if (value.DB_MIGRATION_USER && value.DB_MIGRATION_USER === value.DB_USER) {
    const failure = new Error('Migration database identity must differ from the runtime application identity')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['DB_MIGRATION_USER']
    throw failure
  }

  const cloudinaryValues = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET]
  if (cloudinaryValues.some(Boolean) && !cloudinaryValues.every(Boolean)) {
    const failure = new Error('Cloudinary attachment storage credentials must be configured together')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
    throw failure
  }

  if ((value.PAWAPAY_COLLECTIONS_ENABLED || value.PAWAPAY_PAYOUTS_ENABLED) &&
      value.PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED !== true) {
    const failure = new Error('PawaPay financial operations require confirmed signed-requests-only account configuration')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED']
    throw failure
  }

  if (value.PAWAPAY_COLLECTIONS_ENABLED &&
      (!value.ITC_PAWAPAY_PROVIDER_ACCOUNT_ID || !value.ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION)) {
    const failure = new Error('PawaPay collections require the matching ITC provider account identity')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['ITC_PAWAPAY_PROVIDER_ACCOUNT_ID', 'ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION']
    throw failure
  }

  const browserOrigins = parseAllowedBrowserOrigins(value.EXPENSE_WARRIOR_BROWSER_ORIGINS)
  if (value.NODE_ENV === 'production' && browserOrigins.length === 0) {
    const failure = new Error('Production browser mutations require an explicit trusted origin allowlist')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['EXPENSE_WARRIOR_BROWSER_ORIGINS']
    throw failure
  }
  if (value.NODE_ENV === 'production' && browserOrigins.some((origin) => new URL(origin).protocol !== 'https:')) {
    const failure = new Error('Production browser origins must use HTTPS')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['EXPENSE_WARRIOR_BROWSER_ORIGINS']
    throw failure
  }

  if (value.NODE_ENV === 'production') {
    const integrationUrl = new URL(value.ITC_API_BASE_URL)
    if (integrationUrl.protocol !== 'https:') {
      const failure = new Error('Production ITC integration must use HTTPS')
      failure.code = 'CONFIG_INVALID'
      failure.details = ['ITC_API_BASE_URL']
      throw failure
    }
    if (value.DB_SSL_MODE === 'disable') {
      const failure = new Error('Production database connections must use TLS')
      failure.code = 'CONFIG_INVALID'
      failure.details = ['DB_SSL_MODE']
      throw failure
    }
    if (value.PAWAPAY_BASE_URL !== 'https://api.pawapay.io') {
      const failure = new Error('Production PawaPay integration must use the production API URL')
      failure.code = 'CONFIG_INVALID'
      failure.details = ['PAWAPAY_BASE_URL']
      throw failure
    }
    if (!value.EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON || !value.EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID) {
      const failure = new Error('Production payout destination encryption must be configured')
      failure.code = 'CONFIG_INVALID'
      failure.details = ['EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON', 'EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID']
      throw failure
    }
    if (!value.CLOUDINARY_CLOUD_NAME || !value.CLOUDINARY_API_KEY || !value.CLOUDINARY_API_SECRET) {
      const failure = new Error('Production attachment storage must use Cloudinary credentials')
      failure.code = 'CONFIG_INVALID'
      failure.details = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
      throw failure
    }
  }

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    browserOrigins: Object.freeze(browserOrigins),
    database: Object.freeze({
      host: value.DB_HOST,
      port: value.DB_PORT,
      database: value.DB_NAME,
      user: value.DB_USER,
      password: value.DB_PASSWORD,
      ssl: value.DB_SSL_MODE === 'disable' ? false : { rejectUnauthorized: true },
    }),
    migrationDatabase: includeMigrationCredentials && value.DB_MIGRATION_USER ? Object.freeze({
      host: value.DB_HOST,
      port: value.DB_PORT,
      database: value.DB_NAME,
      user: value.DB_MIGRATION_USER,
      password: value.DB_MIGRATION_PASSWORD,
      ssl: value.DB_SSL_MODE === 'disable' ? false : { rejectUnauthorized: true },
    }) : null,
    itc: Object.freeze({
      baseUrl: value.ITC_API_BASE_URL.replace(/\/+$/, ''),
      identityTimeoutMs: value.ITC_IDENTITY_TIMEOUT_MS,
      financeTimeoutMs: value.ITC_FINANCE_TIMEOUT_MS,
      serviceClientId: value.ITC_SERVICE_CLIENT_ID,
      serviceClientSecret: value.ITC_SERVICE_CLIENT_SECRET,
    }),
    pawaPay: Object.freeze({
      baseUrl: value.PAWAPAY_BASE_URL,
      apiToken: value.PAWAPAY_API_TOKEN,
      providerAccountId: value.ITC_PAWAPAY_PROVIDER_ACCOUNT_ID || null,
      providerAccountVersion: value.ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION ? Number(value.ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION) : null,
      signatureEnabled: value.PAWAPAY_SIGNATURE_ENABLED,
      signedRequestsOnlyConfirmed: value.PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED,
      collectionsEnabled: value.PAWAPAY_COLLECTIONS_ENABLED,
      payoutsEnabled: value.PAWAPAY_PAYOUTS_ENABLED,
      callbackInboxEnabled: value.PAWAPAY_CALLBACK_INBOX_ENABLED,
      signatureKeyId: value.PAWAPAY_SIGNATURE_KEY_ID,
      signaturePrivateKeyPath: value.PAWAPAY_SIGNATURE_PRIVATE_KEY_PATH,
      signaturePublicKeyPath: value.PAWAPAY_SIGNATURE_PUBLIC_KEY_PATH,
      depositsCallbackUrl: value.PAWAPAY_DEPOSITS_CALLBACK_URL,
      payoutsCallbackUrl: value.PAWAPAY_PAYOUTS_CALLBACK_URL,
      requestTimeoutMs: value.PAWAPAY_REQUEST_TIMEOUT_MS,
      finalStatusTimeoutMs: value.PAWAPAY_FINAL_STATUS_TIMEOUT_MS,
      finalStatusPollIntervalMs: value.PAWAPAY_FINAL_STATUS_POLL_INTERVAL_MS,
    }),
    attachments: Object.freeze({
      cloudName: value.CLOUDINARY_CLOUD_NAME,
      apiKey: value.CLOUDINARY_API_KEY,
      apiSecret: value.CLOUDINARY_API_SECRET,
    }),
    payoutDestinations: Object.freeze({
      keysJson: value.EXPENSE_WARRIOR_PAYOUT_DESTINATION_KEYS_JSON,
      activeKeyId: value.EXPENSE_WARRIOR_PAYOUT_DESTINATION_ACTIVE_KEY_ID,
    }),
  })
}

function loadMigrationTargetConfig(source = process.env) {
  const schema = Joi.object({
    DB_MIGRATION_TARGET: Joi.string().trim().min(1).required(),
    DB_MIGRATION_ALLOWED_TARGETS: Joi.string().trim().min(1).required(),
    DB_MIGRATION_TARGETS_JSON: Joi.string().allow('').default(''),
    DB_MIGRATION_TARGET_HOST: Joi.string().trim().min(1).required(),
    DB_MIGRATION_TARGET_PORT: Joi.number().integer().min(1).max(65535).required(),
    DB_MIGRATION_TARGET_DATABASE: Joi.string().trim().min(1).required(),
    DB_MIGRATION_USER: Joi.string().trim().min(1).required(),
  }).unknown(true)
  const { value, error } = schema.validate(source, { abortEarly: false, convert: true })
  if (error) {
    const failure = new Error('Migration target configuration is incomplete or invalid')
    failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    failure.details = error.details.map((detail) => detail.path.join('.'))
    throw failure
  }

  const allowedTargets = value.DB_MIGRATION_ALLOWED_TARGETS.split(',').map((target) => target.trim()).filter(Boolean)
  if (new Set(allowedTargets).size !== allowedTargets.length) {
    const failure = new Error('Migration target allowlist contains duplicate names')
    failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    throw failure
  }
  if (!allowedTargets.includes(value.DB_MIGRATION_TARGET)) {
    const failure = new Error('Selected migration target is not allowlisted')
    failure.code = 'MIGRATION_TARGET_NOT_ALLOWLISTED'
    throw failure
  }
  let targets = null
  if (value.DB_MIGRATION_TARGETS_JSON) {
    try {
      targets = JSON.parse(value.DB_MIGRATION_TARGETS_JSON)
    } catch {
      const failure = new Error('Migration target map is invalid')
      failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
      throw failure
    }
    if (!targets || Array.isArray(targets) || typeof targets !== 'object') {
      const failure = new Error('Migration target map is invalid')
      failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
      throw failure
    }
  } else if (allowedTargets.length > 1) {
    const failure = new Error('A target identity map is required when multiple targets are allowlisted')
    failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    throw failure
  }
  if (targets) {
    for (const name of allowedTargets) {
      const configured = targets[name]
      if (!configured || typeof configured.host !== 'string' || !configured.host.trim() ||
          !Number.isInteger(Number(configured.port)) || Number(configured.port) < 1 || Number(configured.port) > 65535 ||
          typeof configured.database !== 'string' || !configured.database.trim() ||
          typeof configured.user !== 'string' || !configured.user.trim()) {
        const failure = new Error('Every allowlisted migration target needs a complete identity map')
        failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
        throw failure
      }
    }
    const mapped = targets[value.DB_MIGRATION_TARGET]
    if (mapped.host !== value.DB_MIGRATION_TARGET_HOST || Number(mapped.port) !== value.DB_MIGRATION_TARGET_PORT ||
        mapped.database !== value.DB_MIGRATION_TARGET_DATABASE || mapped.user !== value.DB_MIGRATION_USER) {
      const failure = new Error('Selected migration target tuple does not match its allowlisted identity')
      failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
      throw failure
    }
  }
  if (source.DB_USER && value.DB_MIGRATION_USER === source.DB_USER) {
    const failure = new Error('Migration database identity must differ from the runtime application identity')
    failure.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    failure.details = ['DB_MIGRATION_USER']
    throw failure
  }

  return Object.freeze({
    name: value.DB_MIGRATION_TARGET,
    host: value.DB_MIGRATION_TARGET_HOST,
    port: value.DB_MIGRATION_TARGET_PORT,
    database: value.DB_MIGRATION_TARGET_DATABASE,
    user: value.DB_MIGRATION_USER,
  })
}

module.exports = { loadConfig, loadMigrationTargetConfig }
