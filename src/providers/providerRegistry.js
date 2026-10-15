const { PawaPayClient } = require('./pawapay/PawaPayClient')

class ProviderRegistryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'ProviderRegistryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function createProviderRegistry({ pawaPayConfig, dependencies = {}, additionalProviders = {} } = {}) {
  let pawapayClient = null
  const definitions = new Map([['pawapay', {
    create: () => {
      if (!pawapayClient) pawapayClient = new PawaPayClient(pawaPayConfig, dependencies.pawapay)
      return pawapayClient
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
        !definition || typeof definition.create !== 'function' || typeof definition.getNetworks !== 'function') {
      throw new TypeError('Additional providers require a unique code, factory, and capability function')
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
    getForOperation(providerCode, operation) {
      const code = String(providerCode || '').trim().toLowerCase()
      const definition = definitions.get(code)
      if (!definition) throw new ProviderRegistryError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      const requiredMethods = {
        deposit: ['initiateDeposit', 'getDepositStatus'],
        payout: ['initiatePayout', 'getPayoutStatus'],
        refund: ['initiateRefund', 'getRefundStatus'],
        balance: ['getWalletBalances'],
        callback: ['verifyCallback'],
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
      const provider = definition.create()
      if (!provider || requiredMethods.some((method) => typeof provider[method] !== 'function')) {
        throw new ProviderRegistryError('PAYMENT_PROVIDER_CAPABILITY_UNAVAILABLE', 503)
      }
      return provider
    },
    list() {
      return [...definitions.keys()]
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

module.exports = { createProviderRegistry, ProviderRegistryError }
