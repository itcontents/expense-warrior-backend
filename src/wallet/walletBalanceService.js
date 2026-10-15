const BALANCE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/
const PROVIDER_CODE = /^[A-Z0-9_]{1,40}$/

class WalletBalanceServiceError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'WalletBalanceServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function normalizeBalances(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      !Array.isArray(response.balances) || response.balances.length > 100) {
    throw new WalletBalanceServiceError('PROVIDER_BALANCE_RESPONSE_INVALID', 502)
  }
  return response.balances.map((row) => {
    if (!row || typeof row !== 'object' || row.country !== 'ZMB' || row.currency !== 'ZMW' ||
        typeof row.balance !== 'string' || !BALANCE.test(row.balance) ||
        (row.provider !== '' && !PROVIDER_CODE.test(String(row.provider || '')))) {
      throw new WalletBalanceServiceError('PROVIDER_BALANCE_RESPONSE_INVALID', 502)
    }
    return { country: row.country, currency: row.currency, balance: row.balance, provider: row.provider }
  })
}

function createWalletBalanceService({ providerRegistry, snapshotRepository = null, now = Date.now, ttlMs = 30000 } = {}) {
  if (!providerRegistry || typeof providerRegistry.get !== 'function') throw new TypeError('A payment provider registry is required')
  if (snapshotRepository && typeof snapshotRepository.recordBatch !== 'function') throw new TypeError('A provider balance snapshot repository is invalid')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw new TypeError('Balance cache TTL must be between 1 and 300 seconds')
  let cached = null
  let refreshPromise = null

  return Object.freeze({
    async getBalance({ forceRefresh = false } = {}) {
      const currentTime = now()
      if (cached && !forceRefresh && currentTime - cached.fetchedAtMs < ttlMs) {
        return { provider: 'pawapay', country: 'ZMB', balances: structuredClone(cached.balances), fetched_at: cached.fetchedAt, stale: false, cached: true }
      }
      if (!refreshPromise) {
        refreshPromise = (async () => {
          try {
            const provider = typeof providerRegistry.getForOperation === 'function'
              ? providerRegistry.getForOperation('pawapay', 'balance')
              : providerRegistry.get('pawapay')
            if (!provider || typeof provider.getWalletBalances !== 'function') throw new WalletBalanceServiceError('PROVIDER_BALANCE_CAPABILITY_UNAVAILABLE')
            const response = await provider.getWalletBalances({ country: 'ZMB' })
            const balances = normalizeBalances(response)
            const fetchedAtMs = now()
            cached = { balances, fetchedAtMs, fetchedAt: new Date(fetchedAtMs).toISOString() }
            const result = { provider: 'pawapay', country: 'ZMB', balances, fetched_at: cached.fetchedAt, stale: false, cached: false }
            if (snapshotRepository) {
              try {
                const snapshot = await snapshotRepository.recordBatch({
                  provider: 'pawapay', country: 'ZMB', balances, retrievedAt: cached.fetchedAt,
                })
                result.snapshot_persisted = true
                result.snapshot_batch_id = snapshot?.snapshotBatchId || null
              } catch (error) {
                result.snapshot_persisted = false
                result.snapshot_error_code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || ''))
                  ? error.code
                  : 'PROVIDER_BALANCE_SNAPSHOT_FAILED'
              }
            }
            return result
          } catch (error) {
            if (cached) {
              const errorCode = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PAWAPAY_UNAVAILABLE'
              return { provider: 'pawapay', country: 'ZMB', balances: cached.balances, fetched_at: cached.fetchedAt, stale: true, cached: true, error_code: errorCode }
            }
            if (error instanceof WalletBalanceServiceError) throw error
            const failure = new WalletBalanceServiceError(/^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PAWAPAY_UNAVAILABLE')
            throw failure
          }
        })()
      }
      try {
        return structuredClone(await refreshPromise)
      } finally {
        refreshPromise = null
      }
    },
  })
}

module.exports = { createWalletBalanceService, WalletBalanceServiceError, normalizeBalances }
