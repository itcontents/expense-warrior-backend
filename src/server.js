require('dotenv').config()

const { loadConfig } = require('./config/env')
const { createPool } = require('./db/pool')
const { createApp } = require('./app')
const { ItcIdentityClient } = require('./integrations/itc/ItcIdentityClient')
const { ItcFinanceClient } = require('./integrations/itc/ItcFinanceClient')
const { createAttachmentStorage } = require('./attachments/attachmentStorage')
const cloudinarySdk = require('cloudinary').v2
const { createProviderRegistry } = require('./providers/providerRegistry')
const { loadProviderAddons } = require('./providers/providerAddons')
const { createPhoneVault } = require('./payoutDestinations/phoneVault')

function startServer() {
  const config = loadConfig()
  const pool = createPool(config.database)
  const identityClient = new ItcIdentityClient({
    baseUrl: config.itc.baseUrl,
    timeoutMs: config.itc.identityTimeoutMs,
  })
  const itcFinanceClient = new ItcFinanceClient({
    baseUrl: config.itc.baseUrl,
    keyId: config.itc.serviceClientId,
    secretBase64: config.itc.serviceClientSecret,
    timeoutMs: config.itc.financeTimeoutMs,
  })
  let attachmentStorage = null
  const { cloudName, apiKey, apiSecret } = config.attachments
  if (cloudName && apiKey && apiSecret) {
    cloudinarySdk.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true })
    attachmentStorage = createAttachmentStorage({ cloudinary: cloudinarySdk })
  }
  const paymentProviders = createProviderRegistry({
    pawaPayConfig: config.pawaPay,
    additionalProviders: loadProviderAddons(config),
  })
  const phoneVault = createPhoneVault(config.payoutDestinations)
  const app = createApp({ pool, identityClient, attachmentStorage, paymentProviders, itcFinanceClient, phoneVault,
    callbackInboxEnabled: config.pawaPay.callbackInboxEnabled,
    collectionPaymentsEnabled: config.pawaPay.collectionsEnabled,
    staffPayoutsEnabled: config.pawaPay.payoutsEnabled })
  const server = app.listen(config.port, '0.0.0.0')

  const shutdown = (signal) => {
    server.close(() => {
      pool.end().finally(() => process.exit(signal ? 0 : 1))
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.on('error', (error) => {
    console.error(JSON.stringify({ event: 'server_error', code: error.code || 'SERVER_ERROR' }))
    shutdown('server_error')
  })

  return { app, pool, server }
}

if (require.main === module) {
  try {
    startServer()
  } catch (error) {
    console.error(JSON.stringify({ event: 'startup_failed', code: error.code || 'STARTUP_FAILED' }))
    process.exitCode = 1
  }
}

module.exports = { startServer }
