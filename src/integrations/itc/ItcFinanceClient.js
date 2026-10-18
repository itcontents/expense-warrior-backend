const crypto = require('node:crypto')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,11})\.\d{2}$/
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const amountCents = (value) => {
  const match = /^(0|[1-9]\d{0,11})\.(\d{2})$/.exec(String(value || ''))
  return match ? BigInt(match[1]) * 100n + BigInt(match[2]) : null
}
const consumeIdempotencyKey = (providerTransactionId) =>
  `ew-consume-${crypto.createHash('sha256').update(String(providerTransactionId || '').trim().toLowerCase()).digest('hex')}`

class ItcFinanceError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'ItcFinanceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function decodeSecret(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const secret = Buffer.from(value, 'base64')
  return secret.length >= 32 && secret.toString('base64') === value ? secret : null
}

function canonicalRequest({ keyId, timestamp, nonce, method, pathAndQuery, requestId, idempotencyKey = '', rawBody }) {
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex')
  return [keyId, timestamp, nonce, method, pathAndQuery, requestId, idempotencyKey, bodyHash].join('\n')
}

function createSignature(request, secret) {
  return crypto.createHmac('sha256', secret).update(canonicalRequest(request)).digest('base64url')
}

class ItcFinanceClient {
  constructor({
    baseUrl,
    keyId,
    secretBase64,
    timeoutMs = 10000,
    fetchImpl = fetch,
    nonceFactory = crypto.randomUUID,
    requestIdFactory = crypto.randomUUID,
    now = Date.now,
  } = {}) {
    if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
      throw new TypeError('A valid ITC API base URL is required')
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.keyId = keyId
    this.secret = decodeSecret(secretBase64)
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 30000 ? timeoutMs : 10000
    this.fetchImpl = fetchImpl
    this.nonceFactory = nonceFactory
    this.requestIdFactory = requestIdFactory
    this.now = now
  }

  async reserve(payload, idempotencyKey, requestId) {
    return this.#request('POST', '/internal/expense-warrior/holds', { payload, idempotencyKey, requestId })
  }

  async getOperation(operationId, requestId) {
    if (!UUID_PATTERN.test(String(operationId || ''))) throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    const data = await this.#request('GET', `/internal/expense-warrior/operations/${encodeURIComponent(operationId)}`, { requestId })
    if (!data.operation || typeof data.operation !== 'object' || Array.isArray(data.operation)) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return data.operation
  }

  async getBalance(requestId) {
    const data = await this.#request('GET', '/internal/expense-warrior/balance', { requestId })
    const posted = amountCents(data.balance?.posted_balance)
    const held = amountCents(data.balance?.active_holds)
    const available = amountCents(data.balance?.available_balance)
    if (!data.balance || typeof data.balance !== 'object' || Array.isArray(data.balance) ||
        data.balance.currency !== 'ZMW' ||
        posted === null || held === null || available === null || held > posted || posted - held !== available ||
        typeof data.balance.as_of !== 'string' || !Number.isFinite(Date.parse(data.balance.as_of))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return data.balance
  }

  async getExpenseCategories(requestId) {
    const data = await this.#request('GET', '/internal/expense-warrior/expense-categories', { requestId })
    if (!Array.isArray(data.categories) || data.categories.length > 500 ||
        data.categories.some((category) => !category || typeof category !== 'object' || Array.isArray(category) ||
          !/^[a-z][a-z0-9_]{1,49}$/.test(String(category.category_code || '')) ||
          category.category_code === 'inventory' ||
          typeof category.category_name !== 'string' || !category.category_name.trim() || category.category_name.length > 120 ||
          !/^\d{4}$/.test(String(category.account_code || '')))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return data.categories
  }

  async getRevenueAccounts(requestId = '') {
    const data = await this.#request('GET', '/internal/expense-warrior/revenue-accounts', { requestId })
    if (!Array.isArray(data.accounts) || data.accounts.length > 100 ||
        data.accounts.some((account) => !account || typeof account !== 'object' || Array.isArray(account) ||
          !/^\d{4}$/.test(String(account.account_code || '')) ||
          typeof account.account_name !== 'string' || !account.account_name.trim() || account.account_name.length > 160)) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return data.accounts
  }

  async listCustomers({ search, limit = 25, offset = 0 } = {}, requestId = '') {
    if (typeof search !== 'string' || search.trim().length < 2 || search.trim().length > 100 ||
        !Number.isInteger(limit) || limit < 1 || limit > 50 ||
        !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const query = new URLSearchParams({ search: search.trim(), limit: String(limit), offset: String(offset) })
    const data = await this.#request('GET', `/internal/expense-warrior/customers?${query}`, { requestId })
    const result = data.customers
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.items) ||
        result.items.length > limit || typeof result.has_more !== 'boolean' ||
        result.items.some((customer) => !customer || typeof customer !== 'object' || Array.isArray(customer) ||
          !UUID_PATTERN.test(String(customer.customer_id || '')) ||
          typeof customer.display_name !== 'string' || !customer.display_name.trim() || customer.display_name.length > 240 ||
          (customer.company_name !== null && (typeof customer.company_name !== 'string' || customer.company_name.length > 240)) ||
          (customer.phone_last4 !== null && !/^\d{4}$/.test(String(customer.phone_last4))))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return result
  }

  async getLedgerHistory({ dateFrom = null, dateTo = null, limit = 100, cursor = null } = {}, requestId = '') {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
        (dateFrom !== null && (typeof dateFrom !== 'string' || !Number.isFinite(Date.parse(dateFrom)))) ||
        (dateTo !== null && (typeof dateTo !== 'string' || !Number.isFinite(Date.parse(dateTo)))) ||
        (dateFrom && dateTo && Date.parse(dateFrom) >= Date.parse(dateTo)) ||
        (cursor !== null && (typeof cursor !== 'string' || cursor.length > 512))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const query = new URLSearchParams()
    if (dateFrom) query.set('date_from', dateFrom)
    if (dateTo) query.set('date_to', dateTo)
    query.set('limit', String(limit))
    if (cursor) query.set('cursor', cursor)
    const data = await this.#request('GET', `/internal/expense-warrior/ledger-history?${query.toString()}`, { requestId })
    const history = data.history
    if (!history || typeof history !== 'object' || Array.isArray(history) ||
        history.source !== 'itc_ledger' || history.currency !== 'ZMW' ||
        !Array.isArray(history.items) || history.items.length > limit ||
        typeof history.has_more !== 'boolean' ||
        (history.next_cursor !== null && typeof history.next_cursor !== 'string') ||
        (history.has_more && !history.next_cursor) || (!history.has_more && history.next_cursor !== null) ||
        !Number.isFinite(Date.parse(history.as_of)) ||
        history.items.some((row) => !row || typeof row !== 'object' || Array.isArray(row) ||
          !/^[0-9a-f-]{36}$/i.test(String(row.treasury_ledger_id || '')) ||
          typeof row.entry_type !== 'string' || row.entry_type.length > 80 ||
          !['in', 'out'].includes(row.direction) || !MONEY_PATTERN.test(String(row.amount || '')) ||
          !MONEY_PATTERN.test(String(row.running_balance || '')) ||
          (row.reference_type !== null && (typeof row.reference_type !== 'string' || row.reference_type.length > 100)) ||
          (row.reference_id !== null && !/^[0-9a-f-]{36}$/i.test(String(row.reference_id || ''))) ||
          (row.payment_method !== null && (typeof row.payment_method !== 'string' || row.payment_method.length > 80)) ||
          !Number.isFinite(Date.parse(row.created_at)))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return history
  }

  async release(holdId, payload, idempotencyKey, requestId) {
    if (!UUID_PATTERN.test(String(holdId || ''))) throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    return this.#request('POST', `/internal/expense-warrior/holds/${encodeURIComponent(holdId)}/release`, { payload, idempotencyKey, requestId })
  }

  async consume(holdId, payload, idempotencyKey, requestId) {
    if (!UUID_PATTERN.test(String(holdId || '')) ||
        idempotencyKey !== consumeIdempotencyKey(payload?.provider_transaction_id)) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    return this.#request('POST', `/internal/expense-warrior/holds/${encodeURIComponent(holdId)}/consume`, { payload, idempotencyKey, requestId })
  }

  async getReceivables(customerId, { limit = 50, cursor = null } = {}, requestId = '') {
    if (!UUID_PATTERN.test(String(customerId || '')) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== null && (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const query = new URLSearchParams({ limit: String(limit) })
    if (cursor) query.set('cursor', cursor)
    const data = await this.#request('GET', `/internal/expense-warrior/customers/${encodeURIComponent(customerId)}/receivables?${query}`, { requestId })
    const result = data.receivables
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.items) ||
        result.items.length > limit || typeof result.has_more !== 'boolean' ||
        (result.next_cursor !== null && typeof result.next_cursor !== 'string') ||
        (result.has_more && !result.next_cursor) || (!result.has_more && result.next_cursor !== null) ||
        !Number.isFinite(Date.parse(result.as_of)) || result.items.some((row) =>
          !row || typeof row !== 'object' || Array.isArray(row) ||
          !UUID_PATTERN.test(String(row.receivable_id || '')) || !UUID_PATTERN.test(String(row.order_id || '')) || !UUID_PATTERN.test(String(row.customer_id || '')) ||
          row.customer_id.toLowerCase() !== customerId.toLowerCase() ||
          typeof row.invoice_number !== 'string' || row.invoice_number.length < 1 || row.invoice_number.length > 120 ||
          !MONEY_PATTERN.test(String(row.original_amount || '')) || !MONEY_PATTERN.test(String(row.applied_amount || '')) ||
          !MONEY_PATTERN.test(String(row.outstanding_amount || '')) || row.currency !== 'ZMW' ||
          !['OPEN', 'PARTIALLY_PAID'].includes(row.status) || !Number.isFinite(Date.parse(row.issued_at)))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return result
  }

  async getReceivable(customerId, receivableId, requestId = '') {
    if (!UUID_PATTERN.test(String(customerId || '')) || !UUID_PATTERN.test(String(receivableId || ''))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const data = await this.#request('GET', `/internal/expense-warrior/customers/${encodeURIComponent(customerId)}/receivables/${encodeURIComponent(receivableId)}`, { requestId })
    const row = data.receivable
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.receivable_id?.toLowerCase() !== receivableId.toLowerCase() ||
        row.customer_id?.toLowerCase() !== customerId.toLowerCase() ||
        !UUID_PATTERN.test(String(row.order_id || '')) || typeof row.invoice_number !== 'string' ||
        !MONEY_PATTERN.test(String(row.outstanding_amount || '')) || row.currency !== 'ZMW' ||
        !['OPEN', 'PARTIALLY_PAID'].includes(row.status) || !Number.isFinite(Date.parse(row.issued_at))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return row
  }

  async getCustomerCreditBalance(customerId, requestId = '') {
    if (!UUID_PATTERN.test(String(customerId || ''))) throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    const data = await this.#request('GET', `/internal/expense-warrior/customers/${encodeURIComponent(customerId)}/customer-credit`, { requestId })
    const balance = data.balance
    if (!balance || typeof balance !== 'object' || Array.isArray(balance) ||
        balance.customer_id?.toLowerCase() !== customerId.toLowerCase() || balance.currency !== 'ZMW' ||
        !MONEY_PATTERN.test(String(balance.available_credit || '')) || !Number.isFinite(Date.parse(balance.as_of))) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return balance
  }

  async reserveCustomerReceivablePayment(payload, idempotencyKey, requestId) {
    if (!UUID_PATTERN.test(String(payload?.receivable_id || '')) ||
        !UUID_PATTERN.test(String(payload?.reservation_id || '')) ||
        !UUID_PATTERN.test(String(payload?.collection_attempt_id || '')) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(String(idempotencyKey || ''))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const data = await this.#request('POST', '/internal/expense-warrior/receivable-reservations', { payload, idempotencyKey, requestId })
    const reservation = data.reservation
    if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation) ||
        reservation.reservation_id?.toLowerCase() !== payload.reservation_id.toLowerCase() ||
        reservation.receivable_id?.toLowerCase() !== payload.receivable_id.toLowerCase() ||
        reservation.collection_attempt_id?.toLowerCase() !== payload.collection_attempt_id.toLowerCase() ||
        !MONEY_PATTERN.test(String(reservation.amount || '')) || reservation.amount !== payload.amount ||
        reservation.currency_code !== 'ZMW' || !['ACTIVE', 'RELEASED', 'APPLIED'].includes(reservation.state)) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return { reservation }
  }

  async releaseCustomerReceivablePayment(reservationId, payload, idempotencyKey, requestId) {
    if (!UUID_PATTERN.test(String(reservationId || '')) || !UUID_PATTERN.test(String(payload?.operation_id || '')) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(String(idempotencyKey || ''))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    const data = await this.#request('POST', `/internal/expense-warrior/receivable-reservations/${encodeURIComponent(reservationId)}/release`, { payload, idempotencyKey, requestId })
    const reservation = data.reservation
    if (!reservation || typeof reservation !== 'object' || reservation.state !== 'RELEASED' ||
        reservation.reservation_id?.toLowerCase() !== reservationId.toLowerCase()) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return { reservation }
  }

  async applyCustomerReceivablePayment(payload, idempotencyKey, requestId) {
    return this.#postCollection('/internal/expense-warrior/collections/ar-settlements', payload, idempotencyKey, requestId)
  }

  async creditCustomerAccount(payload, idempotencyKey, requestId) {
    return this.#postCollection('/internal/expense-warrior/collections/customer-credits', payload, idempotencyKey, requestId)
  }

  async postEarnedRevenueCollection(payload, idempotencyKey, requestId) {
    return this.#postCollection('/internal/expense-warrior/collections/revenue', payload, idempotencyKey, requestId)
  }

  async preflightCollectionTarget(payload, idempotencyKey, requestId) {
    const data = await this.#request('POST', '/internal/expense-warrior/collections/preflight', { payload, idempotencyKey, requestId })
    if (data.ready !== true) throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    return { ready: true }
  }

  async #postCollection(path, payload, idempotencyKey, requestId) {
    const data = await this.#request('POST', path, { payload, idempotencyKey, requestId })
    const operation = data.operation
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
        !UUID_PATTERN.test(String(operation.operation_id || '')) ||
        !['APPLIED', 'ALREADY_APPLIED'].includes(operation.state)) {
      throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
    }
    return { operation }
  }

  async #request(method, path, { payload, idempotencyKey = '', requestId = '' }) {
    if (!KEY_ID_PATTERN.test(String(this.keyId || '')) || !this.secret) {
      throw new ItcFinanceError('ITC_FINANCE_NOT_CONFIGURED', 503)
    }
    const normalizedRequestId = requestId || this.requestIdFactory()
    if (!UUID_PATTERN.test(String(normalizedRequestId || '')) ||
        (method === 'POST' && !IDEMPOTENCY_PATTERN.test(String(idempotencyKey || ''))) ||
        (method === 'GET' && idempotencyKey && !IDEMPOTENCY_PATTERN.test(String(idempotencyKey)))) {
      throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
    }
    let rawBody = Buffer.alloc(0)
    let serializedBody
    if (method === 'POST') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400)
      try { serializedBody = JSON.stringify(payload) } catch { throw new ItcFinanceError('ITC_FINANCE_REQUEST_INVALID', 400) }
      rawBody = Buffer.from(serializedBody, 'utf8')
      if (rawBody.length > MAX_BODY_BYTES) throw new ItcFinanceError('ITC_FINANCE_REQUEST_TOO_LARGE', 413)
    }

    const url = new URL(`${this.baseUrl}${path}`)
    const pathAndQuery = `${url.pathname}${url.search}`
    if (!pathAndQuery.startsWith('/api/v1/internal/expense-warrior/')) {
      throw new ItcFinanceError('ITC_FINANCE_BASE_URL_INVALID', 503)
    }
    const timestamp = String(Math.floor(this.now() / 1000))
    const nonce = this.nonceFactory()
    if (!UUID_PATTERN.test(String(nonce || ''))) throw new ItcFinanceError('ITC_FINANCE_NONCE_INVALID', 503)
    const signature = createSignature({
      keyId: this.keyId,
      timestamp,
      nonce,
      method,
      pathAndQuery,
      requestId: normalizedRequestId,
      idempotencyKey,
      rawBody,
    }, this.secret)
    const headers = {
      Accept: 'application/json',
      'X-ITC-Key-Id': this.keyId,
      'X-ITC-Timestamp': timestamp,
      'X-ITC-Nonce': nonce,
      'X-ITC-Signature': signature,
      'X-Request-Id': normalizedRequestId,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers,
        ...(method === 'POST' ? { body: serializedBody } : {}),
      })
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
      }
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
      let result
      try { result = JSON.parse(body) } catch { throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502) }
      if (!response.ok) {
        const code = /^[A-Z0-9_]{1,100}$/.test(String(result?.error?.code || ''))
          ? result.error.code
          : (response.status >= 500 ? 'ITC_FINANCE_UNAVAILABLE' : 'ITC_FINANCE_REJECTED')
        throw new ItcFinanceError(code, response.status)
      }
      if (result?.success !== true || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
        throw new ItcFinanceError('ITC_FINANCE_RESPONSE_INVALID', 502)
      }
      return result.data
    } catch (error) {
      if (error instanceof ItcFinanceError) throw error
      throw new ItcFinanceError('ITC_FINANCE_UNAVAILABLE', 503)
    } finally {
      clearTimeout(timeout)
    }
  }
}

module.exports = { ItcFinanceClient, ItcFinanceError, consumeIdempotencyKey }
