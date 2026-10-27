const express = require('express')
const { randomUUID } = require('node:crypto')
const { createCookieCsrfGuard, parseAllowedBrowserOrigins } = require('./auth/cookieCsrfGuard')
const { createBrowserCors } = require('./auth/browserCors')

function validRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

function createApp({ pool, identityClient, attachmentStorage, paymentProviders, itcFinanceClient, phoneVault,
  callbackInboxEnabled = false, callbackInboxRepository = null, collectionPaymentsEnabled = false, staffPayoutsEnabled = false,
  browserOrigins = null, nodeEnv = process.env.NODE_ENV || 'development', logger = console }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required')
  }

  const app = express()
  if (paymentProviders) app.locals.paymentProviders = paymentProviders
  if (itcFinanceClient) app.locals.itcFinanceClient = itcFinanceClient
  app.disable('x-powered-by')
  const allowedBrowserOrigins = browserOrigins === null
    ? parseAllowedBrowserOrigins(process.env.EXPENSE_WARRIOR_BROWSER_ORIGINS || '')
    : browserOrigins
  app.use((req, res, next) => {
    const supplied = req.get('X-Request-Id')
    req.requestId = validRequestId(supplied) ? supplied : randomUUID()
    res.set('X-Request-Id', req.requestId)
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'no-referrer')
    next()
  })
  app.use(createBrowserCors({ allowedOrigins: allowedBrowserOrigins, nodeEnv }))
  app.use(createCookieCsrfGuard({ allowedOrigins: allowedBrowserOrigins, nodeEnv }))

  // Provider callbacks sign raw HTTP bodies. These bounded raw parsers must run
  // before express.json consumes or transforms those bodies.
  if (callbackInboxEnabled === true) {
    if (!paymentProviders || typeof paymentProviders.get !== 'function') {
      throw new TypeError('Provider callback inbox is enabled without a provider registry')
    }
    const { createCallbackInboxRepository } = require('./callbackInbox/callbackInboxRepository')
    const { createCallbackInboxService } = require('./callbackInbox/callbackInboxService')
    const { createCallbackInboxRouter } = require('./callbackInbox/callbackInboxRoutes')
    const repository = callbackInboxRepository || createCallbackInboxRepository({ pool })
    const providerCodes = typeof paymentProviders.list === 'function' ? paymentProviders.list() : ['pawapay']
    const supportedProviders = []
    for (const providerCode of providerCodes) {
      let provider
      try {
        provider = typeof paymentProviders.getForOperation === 'function'
          ? paymentProviders.getForOperation(providerCode, 'callback')
          : paymentProviders.get(providerCode)
      } catch (_error) {
        continue
      }
      if (!provider || typeof provider.verifyCallback !== 'function' || typeof provider.normalizeCallback !== 'function') continue
      supportedProviders.push({ providerCode, provider })
    }
    if (supportedProviders.length === 0) throw new TypeError('Provider callback inbox is enabled without a callback verifier')
    for (const { providerCode, provider } of supportedProviders) {
      let providerAccountIdentity = null
      try { providerAccountIdentity = paymentProviders.getAccountIdentity?.(providerCode) || null }
      catch (_error) { throw new TypeError('Provider callback inbox is enabled without account identity') }
      const callbackService = createCallbackInboxService({ provider, providerCode, providerAccountIdentity, repository })
      const callbackPath = paymentProviders.getCallbackPath?.(providerCode) ||
        `/api/v1/expense-warrior/providers/${providerCode}/callbacks`
      app.use(callbackPath, createCallbackInboxRouter({ callbackService }))
    }
  }

  app.use(express.json({ limit: '1mb', strict: true }))

  if (collectionPaymentsEnabled === true && (!paymentProviders || typeof pool.connect !== 'function')) {
    throw new TypeError('Payment-link collections require a database and signed provider registry')
  }

  if (collectionPaymentsEnabled !== true) {
    const disabledPublicPaymentRouter = express.Router()
    disabledPublicPaymentRouter.use((_req, res) => res.status(503).json({
      error: { code: 'COLLECTIONS_DISABLED', message: 'Payments are temporarily unavailable' },
    }))
    app.use('/api/v1/expense-warrior/public/payment-links', disabledPublicPaymentRouter)
  }

  let paymentLinkService = null
  if (typeof pool.connect === 'function') {
    const { createPaymentLinkRepository } = require('./paymentLinks/paymentLinkRepository')
    const { createPaymentLinkService } = require('./paymentLinks/paymentLinkService')
    const paymentLinkRepository = createPaymentLinkRepository({ pool })
    paymentLinkService = createPaymentLinkService({ repository: paymentLinkRepository })
    if (collectionPaymentsEnabled === true) {
      if (!paymentProviders) throw new TypeError('Payment-link collections require a signed provider registry')
      const { createPublicPaymentService } = require('./paymentLinks/publicPaymentService')
      const { createPublicPaymentRouter } = require('./paymentLinks/publicPaymentRoutes')
      const publicPaymentService = createPublicPaymentService({ repository: paymentLinkRepository, providerRegistry: paymentProviders, itcFinanceClient })
      app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({ paymentService: publicPaymentService }))
    }
  }

  app.get('/api/v1/health', (_req, res) => res.status(200).json({ status: 'ok' }))
  app.get('/api/v1/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1')
      return res.status(200).json({ status: 'ready' })
    } catch (_error) {
      return res.status(503).json({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' })
    }
  })

  if (identityClient) {
    const { createCategoryRouter } = require('./categories/categoryRoutes')
    const { createRequestRouter } = require('./requests/requestRoutes')
    const { createRequestRepository } = require('./requests/requestRepository')
    const { createRequestService } = require('./requests/requestService')
    const { createManagerAssignmentRouter } = require('./managerAssignments/managerAssignmentRoutes')
    const { createManagerAssignmentRepository } = require('./managerAssignments/managerAssignmentRepository')
    const { createManagerAssignmentService } = require('./managerAssignments/managerAssignmentService')
    const { createPaymentLinkRouter } = require('./paymentLinks/paymentLinkRoutes')
    const { createReportRouter } = require('./reports/reportRoutes')
    const { createReportService } = require('./reports/reportService')
    const { createPayoutDestinationRouter } = require('./payoutDestinations/payoutDestinationRoutes')
    const { createPayoutDestinationRepository } = require('./payoutDestinations/payoutDestinationRepository')
    const { createPayoutDestinationService } = require('./payoutDestinations/payoutDestinationService')
    const requestRepository = createRequestRepository({ pool })
    if (staffPayoutsEnabled === true) {
      if (!paymentProviders || typeof paymentProviders.getForOperation !== 'function' ||
          typeof paymentProviders.getNetworks !== 'function' || !itcFinanceClient || !phoneVault) {
        throw new TypeError('Payouts require the signed provider, ITC finance, and destination vault integrations')
      }
      const { createStaffPayoutRouter } = require('./payouts/staffPayoutRoutes')
      const { createStaffPayoutRepository } = require('./payouts/staffPayoutRepository')
      const { createStaffPayoutService } = require('./payouts/staffPayoutService')
      const payoutRepository = createStaffPayoutRepository({ pool })
      const payoutService = createStaffPayoutService({
        repository: Object.freeze({ ...payoutRepository, revealPayoutDestination: requestRepository.revealPayoutDestination }),
        providerRegistry: paymentProviders,
        financeClient: itcFinanceClient,
        phoneVault,
      })
      app.use('/api/v1/expense-warrior/admin', createStaffPayoutRouter({ identityClient, payoutService }))
    }
    if (paymentProviders) {
      const { createWalletBalanceRouter } = require('./wallet/walletBalanceRoutes')
      const { createWalletBalanceService } = require('./wallet/walletBalanceService')
      const { createProviderBalanceRepository } = require('./wallet/providerBalanceRepository')
      const snapshotRepository = typeof pool.connect === 'function' ? createProviderBalanceRepository({ pool }) : null
      const walletBalanceService = createWalletBalanceService({ providerRegistry: paymentProviders, snapshotRepository })
      app.use('/api/v1/expense-warrior', createWalletBalanceRouter({ identityClient, walletBalanceService, itcFinanceClient, snapshotRepository }))
    }
    const requestService = createRequestService({ repository: requestRepository, attachmentStorage, financeClient: itcFinanceClient, phoneVault })
    const managerAssignmentRepository = createManagerAssignmentRepository({ pool })
    const managerAssignmentService = createManagerAssignmentService({ repository: managerAssignmentRepository })
    const reportService = createReportService({ pool, itcFinanceClient })
    if (phoneVault) {
      const payoutDestinationRepository = createPayoutDestinationRepository({ pool })
      const payoutDestinationService = createPayoutDestinationService({ repository: payoutDestinationRepository, phoneVault, providerRegistry: paymentProviders })
      app.use('/api/v1/expense-warrior', createPayoutDestinationRouter({ identityClient, destinationService: payoutDestinationService }))
    }
    app.use('/api/v1/expense-warrior', createCategoryRouter({ pool, identityClient, itcFinanceClient, logger }))
    app.use('/api/v1/expense-warrior', createRequestRouter({ identityClient, requestService, pool, attachmentStorage, staffPayoutsEnabled }))
    app.use('/api/v1/expense-warrior', createManagerAssignmentRouter({ identityClient, assignmentService: managerAssignmentService }))
    app.use('/api/v1/expense-warrior', createReportRouter({ identityClient, reportService }))
    if (paymentLinkService) app.use('/api/v1/expense-warrior/admin', createPaymentLinkRouter({ identityClient, paymentLinkService, itcFinanceClient }))
  }

  app.use((_req, res) => res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }))

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large' } })
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } })
    }
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
  })

  return app
}

module.exports = { createApp }
