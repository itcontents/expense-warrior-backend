const { PawaPayClient } = require('./pawapay/PawaPayClient')

class ProviderRegistryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'ProviderRegistryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function resultRecord(payload) {
  if (Array.isArray(payload)) return payload[0] || null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.status === 'FOUND') return payload.data && typeof payload.data === 'object' ? payload.data : null
  return payload
}

function normalizeOutcome(status, kind = 'status') {
  if (status === 'NOT_FOUND') return 'NOT_FOUND'
  if (kind === 'initiation') {
    return ({ ACCEPTED: 'ACCEPTED', DUPLICATE_IGNORED: 'DUPLICATE', REJECTED: 'REJECTED' })[status] || 'UNKNOWN'
  }
  return ({ COMPLETED: 'SUCCEEDED', FAILED: 'FAILED', CANCELED: 'CANCELLED', CANCELLED: 'CANCELLED' })[status] ||
    (['ACCEPTED', 'SUBMITTED', 'INITIATED', 'PROCESSING', 'PENDING'].includes(status) ? 'PENDING' : 'UNKNOWN')
}

function providerFailureCode(record) {
  const code = record?.failureReason?.failureCode || record?.rejectionReason?.rejectionCode
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null
}

function normalizePawaPayResult(operation, payload, kind = 'status') {
  const record = resultRecord(payload)
  if (!record) return null
  const transactionId = operation === 'deposit' ? record.depositId : record.payoutId
  const evidence = operation === 'deposit'
    ? {
        country: record.country,
        amount: record.amount,
        currency: record.currency,
        requested_amount: record.requestedAmount ?? record.amount,
        received_amount: record.depositedAmount ?? record.amount,
        network_code: record.correspondent ?? record.payer?.accountDetails?.provider,
        phone_number: record.payer?.accountDetails?.phoneNumber ?? record.payer?.address?.value,
        client_reference: record.clientReferenceId,
        provider_transaction_id: record.providerTransactionId,
      }
    : {
        country: record.country,
        amount: record.amount,
        currency: record.currency,
        network_code: record.recipient?.accountDetails?.provider,
        phone_number: record.recipient?.accountDetails?.phoneNumber,
        client_reference: record.clientReferenceId,
        provider_transaction_id: record.providerTransactionId,
      }
  return {
    transaction_id: transactionId,
    outcome: normalizeOutcome(record.status, kind),
    provider_status: record.status || null,
    rejection_code: providerFailureCode(record),
    evidence,
  }
}

function pawaPayRequest(operation, input) {
  if (!input || input.country !== 'ZMB' || input.currency !== 'ZMW') {
    throw new ProviderRegistryError('PAYMENT_PROVIDER_CONFIGURATION_INVALID', 422)
  }
  return {
    [operation === 'deposit' ? 'depositId' : 'payoutId']: input.transaction_id,
    amount: input.amount,
    phoneNumber: input.phone_number,
    provider: input.network_code,
    clientReferenceId: input.client_reference,
    customerMessage: input.customer_message,
  }
}

function normalizePawaPayCallback({ transactionType, rawBody, headers } = {}) {
  let record
  try { record = JSON.parse(rawBody.toString('utf8')) } catch { return null }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const transactionId = transactionType === 'deposit' ? record.depositId : record.payoutId
  if (typeof transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/.test(transactionId) ||
      typeof record.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(record.status)) return null
  const signatureInput = typeof headers?.['signature-input'] === 'string' ? headers['signature-input'] : ''
  const keyId = signatureInput.match(/(?:^|;)\s*keyid="([A-Za-z0-9._:-]{1,128})"(?:;|$)/)?.[1] || null
  const signatureDate = typeof headers?.['signature-date'] === 'string' ? headers['signature-date'] : null
  return { transaction_id: transactionId, provider_status: record.status,
    provider_reference: record.providerTransactionId || null, signature_key_id: keyId, signature_date: signatureDate }
}

function createPawaPayNormalizedAdapter(client) {
  return Object.freeze({
    contractVersion: 1,
    initiateDeposit: async (input) => normalizePawaPayResult('deposit', await client.initiateDeposit(pawaPayRequest('deposit', input)), 'initiation'),
    getDepositStatus: async (id) => normalizePawaPayResult('deposit', await client.getDepositStatus(id)),
    initiatePayout: async (input) => normalizePawaPayResult('payout', await client.initiatePayout(pawaPayRequest('payout', input)), 'initiation'),
    getPayoutStatus: async (id) => normalizePawaPayResult('payout', await client.getPayoutStatus(id)),
    initiateRefund: (...args) => client.initiateRefund(...args),
    getRefundStatus: (...args) => client.getRefundStatus(...args),
    getWalletBalances: (...args) => client.getWalletBalances(...args),
    verifyCallback: (...args) => client.verifyCallback(...args),
    normalizeCallback: normalizePawaPayCallback,
    predictProvider: (...args) => client.predictProvider(...args),
    getDepositNetworkOptions: (...args) => client.getDepositNetworkOptions(...args),
  })
}

function createProviderRegistry({ pawaPayConfig, dependencies = {}, additionalProviders = {} } = {}) {
  let pawapayClient = null
  const definitions = new Map([['pawapay', {
    create: () => {
      if (!pawapayClient) pawapayClient = new PawaPayClient(pawaPayConfig, dependencies.pawapay)
      return createPawaPayNormalizedAdapter(pawapayClient)
    },
    getAccountIdentity: () => ({
      provider_account_id: pawaPayConfig?.providerAccountId,
      provider_account_version: pawaPayConfig?.providerAccountVersion,
    }),
    getNetworks: (operation) => PawaPayClient.getNetworks(operation),
    getActiveNetworks: (operation, options) => operation === 'deposit'
      ? definitions.get('pawapay').create().getDepositNetworkOptions(options)
      : Promise.resolve([]),
  }]])

  if (!additionalProviders || typeof additionalProviders !== 'object' || Array.isArray(additionalProviders)) {
    throw new TypeError('Additional providers must be a provider definition map')
  }
  for (const [providerCode, definition] of Object.entries(additionalProviders)) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(providerCode) || definitions.has(providerCode) ||
        !definition || typeof definition.create !== 'function' || typeof definition.getNetworks !== 'function' || definition.contractVersion !== 1) {
      throw new TypeError('Additional providers require a unique code, normalized contract version, factory, and capability function')
    }
    definitions.set(providerCode, definition)
  }

  return Object.freeze({
    get(providerCode) {
      const code = String(providerCode || '').trim().toLowerCase()
      const definition = definitions.get(code)
      if (!definition) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      return definition.create()
    },
    getAccountIdentity(providerCode) {
      const code = String(providerCode || '').trim().toLowerCase()
      const definition = definitions.get(code)
      if (!definition) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      const identity = typeof definition.getAccountIdentity === 'function'
        ? definition.getAccountIdentity()
        : definition.accountIdentity
      if (!identity || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(identity.provider_account_id || '')) ||
          !Number.isSafeInteger(Number(identity.provider_account_version)) || Number(identity.provider_account_version) <= 0) {
        throw new ProviderRegistryError('PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE', 503)
      }
      return {
        provider_account_id: String(identity.provider_account_id).toLowerCase(),
        provider_account_version: Number(identity.provider_account_version),
      }
    },
    getForOperation(providerCode, operation, accountIdentity = null) {
      const code = String(providerCode || '').trim().toLowerCase()
      const definition = definitions.get(code)
      if (!definition) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      const requiredMethods = {
        deposit: ['initiateDeposit', 'getDepositStatus'],
        payout: ['initiatePayout', 'getPayoutStatus'],
        refund: ['initiateRefund', 'getRefundStatus'],
        balance: ['getWalletBalances'],
        callback: ['verifyCallback', 'normalizeCallback'],
      }[operation]
      if (!requiredMethods) throw new ProviderRegistryError('PAYMENT_OPERATION_UNSUPPORTED', 422)
      if (['deposit', 'payout'].includes(operation)) {
        let networks
        try { networks = definition.getNetworks(operation) } catch (_error) { networks = null }
        if (!Array.isArray(networks) || networks.length === 0 || networks.some((network) =>
          !network || typeof network !== 'object' || typeof network.code !== 'string' || !network.code.trim())) {
          throw new ProviderRegistryError('PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE', 503)
        }
      }
      let provider
      if (accountIdentity) {
        const suppliedId = String(accountIdentity.provider_account_id || '').toLowerCase()
        const suppliedVersion = Number(accountIdentity.provider_account_version)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suppliedId) ||
            !Number.isSafeInteger(suppliedVersion) || suppliedVersion < 1) {
          throw new ProviderRegistryError('PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE', 503)
        }
        if (typeof definition.createForAccount === 'function') {
          provider = definition.createForAccount({ provider_account_id: suppliedId, provider_account_version: suppliedVersion })
        } else {
          const current = typeof definition.getAccountIdentity === 'function' ? definition.getAccountIdentity() : definition.accountIdentity
          if (!current || String(current.provider_account_id || '').toLowerCase() !== suppliedId ||
              Number(current.provider_account_version) !== suppliedVersion) {
            throw new ProviderRegistryError('PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE', 503)
          }
          provider = definition.create()
        }
      } else {
        provider = definition.create()
      }
      if (!provider || provider.contractVersion !== 1 || requiredMethods.some((method) => typeof provider[method] !== 'function')) {
        throw new ProviderRegistryError('PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE', 503)
      }
      return provider
    },
    list() {
      return [...definitions.keys()]
    },
    getCallbackPath(providerCode) {
      const code = String(providerCode || '').trim().toLowerCase()
      const definition = definitions.get(code)
      if (!definition) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      if (typeof definition.callbackPath === 'string') return definition.callbackPath
      if (code === 'pawapay') return '/api/v1/expense-warrior/providers/pawapay/callbacks'
      return `/api/v1/expense-warrior/providers/${code}/callbacks`
    },
    getNetworks(providerCode, operation = 'deposit') {
      const code = String(providerCode || '').trim().toLowerCase()
      const selected = code ? [[code, definitions.get(code)]] : [...definitions.entries()]
      if (selected.some(([, definition]) => !definition)) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      return selected.flatMap(([registeredCode, definition]) => {
        let networks
        try { networks = definition.getNetworks(operation) } catch (_error) { networks = null }
        if (!Array.isArray(networks)) throw new ProviderRegistryError('PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE', 503)
        return networks.map((network) => {
          if (!network || typeof network !== 'object' || typeof network.code !== 'string' || !network.code.trim()) {
            throw new ProviderRegistryError('PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE', 503)
          }
          return { provider_code: registeredCode, ...network }
        })
      })
    },
    async getActiveNetworks(operation = 'deposit', options = {}) {
      const providers = [...definitions.entries()]
      const networkLists = await Promise.all(providers.map(async ([registeredCode, definition]) => {
        if (typeof definition.getActiveNetworks !== 'function') return []
        let networks
        try { networks = await definition.getActiveNetworks(operation, options) }
        catch (_error) { throw new ProviderRegistryError('PAYMENT_PROVIDER_CONFIGURATION_UNAVAILABLE', 503) }
        if (!Array.isArray(networks) || networks.some((network) =>
          !network || typeof network !== 'object' || typeof network.code !== 'string' || !network.code.trim() ||
          typeof network.label !== 'string' || !network.label.trim())) {
          throw new ProviderRegistryError('PAYMENT_PROVIDER_CONFIGURATION_INVALID', 503)
        }
        return networks.map((network) => ({ provider_code: registeredCode, ...network }))
      }))
      return networkLists.flat()
    },
  })
}

module.exports = { createProviderRegistry, ProviderRegistryError, normalizePawaPayResult, normalizePawaPayCallback }
