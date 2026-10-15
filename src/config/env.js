const Joi = require('joi')

const configSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3100),
  DB_HOST: Joi.string().trim().min(1).required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
  DB_NAME: Joi.string().trim().min(1).required(),
  DB_USER: Joi.string().trim().min(1).required(),
  DB_PASSWORD: Joi.string().min(1).required(),
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
  PAWAPAY_BASE_URL: Joi.string().valid('https://api.sandbox.pawapay.io', 'https://api.pawapay.io').default('https://api.sandbox.pawapay.io'),
  PAWAPAY_DEPOSITS_CALLBACK_URL: Joi.string().uri({ scheme: ['https'] }).allow('').default(''),
  PAWAPAY_PAYOUTS_CALLBACK_URL: Joi.string().uri({ scheme: ['https'] }).allow('').default(''),
  PAWAPAY_SIGNATURE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
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
}).unknown(true)

function loadConfig(source = process.env) {
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

  const cloudinaryValues = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET]
  if (cloudinaryValues.some(Boolean) && !cloudinaryValues.every(Boolean)) {
    const failure = new Error('Cloudinary attachment storage credentials must be configured together')
    failure.code = 'CONFIG_INVALID'
    failure.details = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
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
    database: Object.freeze({
      host: value.DB_HOST,
      port: value.DB_PORT,
      database: value.DB_NAME,
      user: value.DB_USER,
      password: value.DB_PASSWORD,
      ssl: value.DB_SSL_MODE === 'disable' ? false : { rejectUnauthorized: true },
    }),
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
      signatureEnabled: value.PAWAPAY_SIGNATURE_ENABLED,
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

module.exports = { loadConfig }
