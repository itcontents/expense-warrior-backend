const BALANCE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/
const PROVIDER_CODE = /^[A-Z0-9_]{1,40}$/
const PROVIDER_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  const cachedByProvider = new Map()
  const refreshesByProvider = new Map()

  return Object.freeze({
    async getBalance({ providerCode = 'pawapay', forceRefresh = false } = {}) {
      const selectedProviderCode = String(providerCode || '').trim().toLowerCase()
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(selectedProviderCode)) {
        throw new WalletBalanceServiceError('PAYMENT_PROVIDER_UNSUPPORTED', 422)
      }
      const cached = cachedByProvider.get(selectedProviderCode) || null
      const currentTime = now()
      if (cached && !forceRefresh && currentTime - cached.fetchedAtMs < ttlMs) {
        return { provider: selectedProviderCode, provider_account_id: cached.providerAccountId, provider_account_version: cached.providerAccountVersion,
          country: 'ZMB', balances: structuredClone(cached.balances), fetched_at: cached.fetchedAt, stale: false, cached: true,
          ...(cached.snapshotErrorCode ? { snapshot_persisted: false, snapshot_error_code: cached.snapshotErrorCode } : {}) }
      }
      if (!refreshesByProvider.has(selectedProviderCode)) {
        const refreshPromise = (async () => {
          try {
            const provider = typeof providerRegistry.getForOperation === 'function'
              ? providerRegistry.getForOperation(selectedProviderCode, 'balance')
              : providerRegistry.get(selectedProviderCode)
            if (!provider || typeof provider.getWalletBalances !== 'function') throw new WalletBalanceServiceError('PROVIDER_BALANCE_CAPABILITY_UNAVAILABLE')
            const response = await provider.getWalletBalances({ country: 'ZMB' })
            const balances = normalizeBalances(response)
            let accountIdentity = null
            try { accountIdentity = providerRegistry.getAccountIdentity?.(selectedProviderCode) || null } catch (_error) {}
            const providerAccountId = PROVIDER_ACCOUNT_ID.test(String(accountIdentity?.provider_account_id || ''))
              ? String(accountIdentity.provider_account_id).toLowerCase()
              : null
            const providerAccountVersion = Number.isSafeInteger(Number(accountIdentity?.provider_account_version)) &&
              Number(accountIdentity?.provider_account_version) > 0
              ? Number(accountIdentity.provider_account_version)
              : null
            const hasAccountIdentity = Boolean(providerAccountId && providerAccountVersion)
            const fetchedAtMs = now()
            const entry = {
              balances, fetchedAtMs, fetchedAt: new Date(fetchedAtMs).toISOString(),
              providerAccountId: hasAccountIdentity ? providerAccountId : null,
              providerAccountVersion: hasAccountIdentity ? providerAccountVersion : null,
              snapshotErrorCode: snapshotRepository && !hasAccountIdentity
                ? 'PAYMENT_PROVIDER_ACCOUNT_IDENTITY_UNAVAILABLE'
                : null,
            }
            cachedByProvider.set(selectedProviderCode, entry)
            const result = { provider: selectedProviderCode, provider_account_id: entry.providerAccountId,
              provider_account_version: entry.providerAccountVersion, country: 'ZMB', balances, fetched_at: entry.fetchedAt, stale: false, cached: false }
            if (snapshotRepository) {
              if (!hasAccountIdentity) {
                result.snapshot_persisted = false
                result.snapshot_error_code = entry.snapshotErrorCode
              } else {
                try {
                  const snapshot = await snapshotRepository.recordBatch({
                    provider: selectedProviderCode, providerAccountId: entry.providerAccountId,
                    providerAccountVersion: entry.providerAccountVersion,
                    country: 'ZMB', balances, retrievedAt: entry.fetchedAt,
                  })
                  result.snapshot_persisted = true
                  result.snapshot_batch_id = snapshot?.snapshotBatchId || null
                } catch (error) {
                  result.snapshot_persisted = false
                  result.snapshot_error_code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || ''))
                    ? error.code
                    : 'PROVIDER_BALANCE_SNAPSHOT_FAILED'
                  entry.snapshotErrorCode = result.snapshot_error_code
                }
              }
            }
            return result
          } catch (error) {
            const lastKnown = cachedByProvider.get(selectedProviderCode) || null
            if (lastKnown) {
              const errorCode = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE'
              return { provider: selectedProviderCode, provider_account_id: lastKnown.providerAccountId,
                provider_account_version: lastKnown.providerAccountVersion, country: 'ZMB', balances: lastKnown.balances,
                fetched_at: lastKnown.fetchedAt, stale: true, cached: true, error_code: errorCode }
            }
            if (error instanceof WalletBalanceServiceError) throw error
            const failure = new WalletBalanceServiceError(/^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE')
            throw failure
          }
        })()
        refreshesByProvider.set(selectedProviderCode, refreshPromise)
      }
      try {
        return structuredClone(await refreshesByProvider.get(selectedProviderCode))
      } finally {
        refreshesByProvider.delete(selectedProviderCode)
      }
    },
  })
}

module.exports = { createWalletBalanceService, WalletBalanceServiceError, normalizeBalances }
