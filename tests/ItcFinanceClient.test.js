const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { ItcFinanceClient, consumeIdempotencyKey } = require('../src/integrations/itc/ItcFinanceClient')

const keyId = 'expense-warrior-dev'
const secret = Buffer.alloc(32, 23)
const secretBase64 = secret.toString('base64')
const requestId = '10000000-0000-4000-8000-000000000001'
const nonce = '20000000-0000-4000-8000-000000000001'
const operationId = '30000000-0000-4000-8000-000000000001'

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('reserve signs the exact path, JSON bytes, idempotency key, and request identity', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'http://itc.test/api/v1/', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(200, { success: true, data: { operation: { operation_id: operationId, state: 'ACTIVE' } } })
    },
    nonceFactory: () => nonce,
    requestIdFactory: () => requestId,
    now: () => 1792080000000,
  })
  const payload = {
    operation_id: operationId,
    request_id: '40000000-0000-4000-8000-000000000001',
    requester_customer_id: '50000000-0000-4000-8000-000000000001',
    actor_customer_id: '60000000-0000-4000-8000-000000000001',
    amount: '125.00',
    currency: 'ZMW',
    purpose: 'Transport',
  }
  const result = await client.reserve(payload, 'reserve-key-0001', requestId)

  assert.deepEqual(result, { operation: { operation_id: operationId, state: 'ACTIVE' } })
  assert.equal(call.url, 'http://itc.test/api/v1/internal/expense-warrior/holds')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.redirect, 'manual')
  assert.equal(call.options.body, JSON.stringify(payload))
  const timestamp = String(Math.floor(1792080000000 / 1000))
  const canonical = [
    keyId,
    timestamp,
    nonce,
    'POST',
    '/api/v1/internal/expense-warrior/holds',
    requestId,
    'reserve-key-0001',
    crypto.createHash('sha256').update(call.options.body).digest('hex'),
  ].join('\n')
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('base64url')
  assert.equal(call.options.headers['X-ITC-Signature'], expected)
  assert.equal(call.options.headers['X-Request-Id'], requestId)
})

test('preflightCollectionTarget signs the exact request and accepts only an affirmative readiness result', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1/', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(200, { success: true, data: { ready: true } })
    },
    nonceFactory: () => nonce,
    requestIdFactory: () => requestId,
    now: () => 1792080000000,
  })
  const payload = {
    payment_link_id: '70000000-0000-4000-8000-000000000002',
    collection_attempt_id: '70000000-0000-4000-8000-000000000003',
    actor_customer_id: '60000000-0000-4000-8000-000000000001',
    provider_code: 'pawapay',
    provider_account_id: '80000000-0000-4000-8000-000000000001',
    provider_account_version: 1,
    target: { type: 'REVENUE', revenue_account_code: '4000' },
  }
  const idempotencyKey = 'collection-preflight-0001'

  assert.deepEqual(await client.preflightCollectionTarget(payload, idempotencyKey, requestId), { ready: true })
  assert.equal(call.url, 'https://itc.test/api/v1/internal/expense-warrior/collections/preflight')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.body, JSON.stringify(payload))
  assert.equal(call.options.headers['Idempotency-Key'], idempotencyKey)
  assert.equal(call.options.headers['X-Request-Id'], requestId)
  const timestamp = String(Math.floor(1792080000000 / 1000))
  const canonical = [
    keyId,
    timestamp,
    nonce,
    'POST',
    '/api/v1/internal/expense-warrior/collections/preflight',
    requestId,
    idempotencyKey,
    crypto.createHash('sha256').update(call.options.body).digest('hex'),
  ].join('\n')
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('base64url')
  assert.equal(call.options.headers['X-ITC-Signature'], expected)

  const extendedResponse = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { ready: true, evaluated_at: '2026-10-18T12:00:00.000Z' } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  assert.deepEqual(await extendedResponse.preflightCollectionTarget(payload, idempotencyKey, requestId), { ready: true })
})

test('preflightCollectionTarget rejects missing, malformed, or negative readiness responses consistently', async () => {
  for (const data of [undefined, {}, { ready: false }, { ready: 'true' }, []]) {
    const client = new ItcFinanceClient({
      baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
      fetchImpl: async () => response(200, { success: true, data }),
      nonceFactory: () => nonce, now: () => 1792080000000,
    })
    await assert.rejects(client.preflightCollectionTarget({ target_type: 'REVENUE' }, 'collection-preflight-0001', requestId), {
      name: 'ItcFinanceError', code: 'ITC_FINANCE_RESPONSE_INVALID', statusCode: 502,
    })
  }
})

test('preflightCollectionTarget preserves stable ITC error envelope codes', async () => {
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(409, { success: false, error: { code: 'COLLECTION_TARGET_NOT_READY' } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  await assert.rejects(client.preflightCollectionTarget({ target_type: 'REVENUE' }, 'collection-preflight-0001', requestId), {
    name: 'ItcFinanceError', code: 'COLLECTION_TARGET_NOT_READY', statusCode: 409,
  })
})

test('release uses the hold-specific signed route and preserves ITC business errors', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(409, { success: false, error: { code: 'HOLD_ALREADY_CONSUMED', message: 'Cannot release a consumed hold' } })
    },
    nonceFactory: () => nonce,
    now: () => 1792080000000,
  })

  await assert.rejects(
    client.release('70000000-0000-4000-8000-000000000001', { operation_id: operationId, reason: 'Rejected' }, 'release-key-0001'),
    { code: 'HOLD_ALREADY_CONSUMED', statusCode: 409 },
  )
  assert.equal(call.url, 'https://itc.test/api/v1/internal/expense-warrior/holds/70000000-0000-4000-8000-000000000001/release')
  assert.equal(call.options.headers['Idempotency-Key'], 'release-key-0001')
})

test('consume binds its idempotency key to the verified PawaPay transaction identity', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(201, { success: true, data: { operation: { operation_id: operationId, state: 'CONSUMED' } } })
    },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  const payload = { operation_id: operationId, provider_transaction_id: 'provider-tx-001' }
  const key = consumeIdempotencyKey(payload.provider_transaction_id)
  assert.deepEqual(await client.consume('70000000-0000-4000-8000-000000000001', payload, key, requestId), {
    operation: { operation_id: operationId, state: 'CONSUMED' },
  })
  assert.equal(call.url, 'https://itc.test/api/v1/internal/expense-warrior/holds/70000000-0000-4000-8000-000000000001/consume')
  assert.equal(call.options.headers['Idempotency-Key'], key)
  await assert.rejects(client.consume('70000000-0000-4000-8000-000000000001', payload, 'consume-key-0001', requestId), {
    code: 'ITC_FINANCE_REQUEST_INVALID', statusCode: 400,
  })
})

test('the client fails closed when credentials or the signed response contract is invalid', async () => {
  const unavailable = new ItcFinanceClient({ baseUrl: 'http://itc.test/api/v1' })
  await assert.rejects(unavailable.reserve({ operation_id: operationId }, 'reserve-key-0001'), { code: 'ITC_FINANCE_NOT_CONFIGURED' })

  const invalidResponse = new ItcFinanceClient({
    baseUrl: 'http://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: {} }),
    nonceFactory: () => nonce,
    now: () => 1792080000000,
  })
  await assert.rejects(invalidResponse.getOperation(operationId), { code: 'ITC_FINANCE_RESPONSE_INVALID' })
})

test('getBalance signs the private balance read and rejects malformed finance responses', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(200, { success: true, data: { balance: { treasury_account_id: operationId, currency: 'ZMW', posted_balance: '1000.25', active_holds: '125.75', available_balance: '874.50', as_of: '2026-10-15T12:00:00.000Z' } } })
    },
    nonceFactory: () => nonce,
    requestIdFactory: () => requestId,
    now: () => 1792080000000,
  })
  assert.deepEqual(await client.getBalance(requestId), { treasury_account_id: operationId, currency: 'ZMW', posted_balance: '1000.25', active_holds: '125.75', available_balance: '874.50', as_of: '2026-10-15T12:00:00.000Z' })
  assert.equal(call.url, 'https://itc.test/api/v1/internal/expense-warrior/balance')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.body, undefined)

  const invalid = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { balance: [] } }),
    nonceFactory: () => nonce,
    now: () => 1792080000000,
  })
  await assert.rejects(invalid.getBalance(), { code: 'ITC_FINANCE_RESPONSE_INVALID' })
})

test('getExpenseCategories reads only the signed ITC postable category catalog and validates its shape', async () => {
  let call
  const categories = [{ category_code: 'consumables', category_name: 'Operating Consumables', account_code: '6280' }]
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => { call = { url: String(url), options }; return response(200, { success: true, data: { categories } }) },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  assert.deepEqual(await client.getExpenseCategories(requestId), categories)
  assert.equal(call.url, 'https://itc.test/api/v1/internal/expense-warrior/expense-categories')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.headers['X-Request-Id'], requestId)

  const invalid = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { categories: [{ category_code: 'inventory', category_name: 'Inventory', account_code: '1300' }] } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  await assert.rejects(invalid.getExpenseCategories(), { code: 'ITC_FINANCE_RESPONSE_INVALID', statusCode: 502 })
})

test('listCustomers signs a bounded private directory search and validates redacted fields', async () => {
  let call
  const customer = { customer_id: '50000000-0000-4000-8000-000000000001', display_name: 'Chanda Banda', company_name: 'Banda Ltd', phone_last4: '1234' }
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(200, { success: true, data: { customers: { items: [customer], has_more: false } } })
    },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  assert.deepEqual(await client.listCustomers({ search: 'Chanda', limit: 10, offset: 20 }, requestId), { items: [customer], has_more: false })
  const url = new URL(call.url)
  assert.equal(url.pathname, '/api/v1/internal/expense-warrior/customers')
  assert.equal(url.searchParams.get('search'), 'Chanda')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(url.searchParams.get('offset'), '20')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.body, undefined)
  assert.equal(call.options.headers['X-Request-Id'], requestId)
  await assert.rejects(client.listCustomers({ search: 'x' }), { code: 'ITC_FINANCE_REQUEST_INVALID', statusCode: 400 })

  const invalid = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { customers: { items: [{ ...customer, phone_last4: '26095551234' }], has_more: false } } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  await assert.rejects(invalid.listCustomers({ search: 'Chanda' }), { code: 'ITC_FINANCE_RESPONSE_INVALID', statusCode: 502 })
})

test('getLedgerHistory signs bounded date filters and validates its keyset response', async () => {
  let call
  const history = {
    source: 'itc_ledger', treasury_account_id: operationId, currency: 'ZMW',
    items: [{
      treasury_ledger_id: '70000000-0000-4000-8000-000000000001', entry_type: 'collection_credit',
      direction: 'in', amount: '25.00', running_balance: '125.00',
      reference_type: 'expense_warrior_collection', reference_id: operationId,
      payment_method: 'mobile_money', created_at: '2026-10-15T12:00:00.000Z',
    }], has_more: false, next_cursor: null, as_of: '2026-10-15T12:01:00.000Z',
  }
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => { call = { url: String(url), options }; return response(200, { success: true, data: { history } }) },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  const result = await client.getLedgerHistory({ dateFrom: '2026-10-15T00:00:00.000Z', dateTo: '2026-10-16T00:00:00.000Z', limit: 20 }, requestId)
  assert.deepEqual(result, history)
  const url = new URL(call.url)
  assert.equal(url.pathname, '/api/v1/internal/expense-warrior/ledger-history')
  assert.equal(url.searchParams.get('date_from'), '2026-10-15T00:00:00.000Z')
  assert.equal(url.searchParams.get('limit'), '20')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.body, undefined)
  await assert.rejects(client.getLedgerHistory({ limit: 501 }), { code: 'ITC_FINANCE_REQUEST_INVALID' })
})

test('customer collection methods use signed ITC routes and validate authoritative responses', async () => {
  const calls = []
  const receivable = {
    receivable_id: operationId, customer_id: '50000000-0000-4000-8000-000000000001',
    invoice_number: 'Q-2026-001', order_id: '70000000-0000-4000-8000-000000000001', original_amount: '75.00', applied_amount: '0.00',
    outstanding_amount: '75.00', currency: 'ZMW', status: 'OPEN',
    issued_at: '2026-10-15T12:00:00.000Z',
  }
  const operation = { operation_id: operationId, state: 'APPLIED' }
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      const path = new URL(String(url)).pathname
      if (path.endsWith('/customers/50000000-0000-4000-8000-000000000001/receivables')) {
        return response(200, { success: true, data: { receivables: { items: [receivable], has_more: false, next_cursor: null, as_of: '2026-10-15T12:00:00.000Z' } } })
      }
      if (path.endsWith(`/customers/${receivable.customer_id}/receivables/${receivable.receivable_id}`)) {
        return response(200, { success: true, data: { receivable } })
      }
      if (path.endsWith('/receivable-reservations')) {
        const body = JSON.parse(options.body)
        return response(201, { success: true, data: { reservation: { reservation_id: body.reservation_id,
          receivable_id: body.receivable_id, collection_attempt_id: body.collection_attempt_id, amount: body.amount,
          currency_code: 'ZMW', state: 'ACTIVE' } } })
      }
      if (path.endsWith('/customer-credit')) return response(200, { success: true, data: { balance: { customer_id: receivable.customer_id, currency: 'ZMW', available_credit: '25.00', as_of: '2026-10-15T12:00:00.000Z' } } })
      return response(201, { success: true, data: { operation } })
    },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  assert.deepEqual(await client.getReceivables(receivable.customer_id, { limit: 10 }, requestId), {
    items: [receivable], has_more: false, next_cursor: null, as_of: '2026-10-15T12:00:00.000Z',
  })
  assert.equal((await client.getReceivable(receivable.customer_id, receivable.receivable_id, requestId)).outstanding_amount, '75.00')
  const reservation = { reservation_id: '80000000-0000-4000-8000-000000000001', payment_link_id: '70000000-0000-4000-8000-000000000002',
    collection_attempt_id: '70000000-0000-4000-8000-000000000003', actor_customer_id: '60000000-0000-4000-8000-000000000001',
    customer_id: receivable.customer_id, receivable_id: receivable.receivable_id, amount: '75.00', currency: 'ZMW' }
  assert.equal((await client.reserveCustomerReceivablePayment(reservation, 'ew-ar-reserve-key', requestId)).reservation.state, 'ACTIVE')
  const collection = { operation_id: operationId, actor_customer_id: '60000000-0000-4000-8000-000000000001',
    customer_id: receivable.customer_id, amount: '25.00', currency: 'ZMW',
    provider_code: 'pawapay', provider_transaction_id: 'provider-tx-001',
    provider_reference: 'provider-ref-001', collection_attempt_id: '70000000-0000-4000-8000-000000000001',
    verified_at: '2026-10-15T12:00:00.000Z', evidence_digest: 'a'.repeat(64) }
  assert.deepEqual(await client.applyCustomerReceivablePayment({ ...collection, allocations: [{ order_id: receivable.order_id, amount: '25.00' }] }, 'ar-key-0001', requestId), { operation })
  assert.deepEqual(await client.creditCustomerAccount(collection, 'credit-key-0001', requestId), { operation })
  assert.deepEqual(await client.postEarnedRevenueCollection({ ...collection, revenue_account_code: '4000' }, 'revenue-key-0001', requestId), { operation })
  assert.equal((await client.getCustomerCreditBalance(receivable.customer_id, requestId)).available_credit, '25.00')
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    `/api/v1/internal/expense-warrior/customers/${receivable.customer_id}/receivables`,
    `/api/v1/internal/expense-warrior/customers/${receivable.customer_id}/receivables/${receivable.receivable_id}`,
    '/api/v1/internal/expense-warrior/receivable-reservations',
    '/api/v1/internal/expense-warrior/collections/ar-settlements',
    '/api/v1/internal/expense-warrior/collections/customer-credits',
    '/api/v1/internal/expense-warrior/collections/revenue',
    `/api/v1/internal/expense-warrior/customers/${receivable.customer_id}/customer-credit`,
  ])
  assert.equal(calls[3].options.headers['Idempotency-Key'], 'ar-key-0001')
  assert.equal(calls[6].options.method, 'GET')
})

test('revenue account catalog uses the signed route and rejects malformed account data', async () => {
  let call
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options }
      return response(200, { success: true, data: { accounts: [
        { account_code: '4000', account_name: 'Product Sales – Standard Rated' },
      ] } })
    },
    nonceFactory: () => nonce, requestIdFactory: () => requestId, now: () => 1792080000000,
  })
  assert.deepEqual(await client.getRevenueAccounts(requestId), [
    { account_code: '4000', account_name: 'Product Sales – Standard Rated' },
  ])
  assert.equal(new URL(call.url).pathname, '/api/v1/internal/expense-warrior/revenue-accounts')
  assert.equal(call.options.method, 'GET')
  assert.match(call.options.headers['X-ITC-Signature'], /^[A-Za-z0-9_-]+$/)
  const invalid = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { accounts: [{ account_code: 'bad', account_name: 'Revenue' }] } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  await assert.rejects(invalid.getRevenueAccounts(requestId), { code: 'ITC_FINANCE_RESPONSE_INVALID', statusCode: 502 })
})

test('customer collection client rejects invalid identity, pagination, and malformed response shapes', async () => {
  const client = new ItcFinanceClient({
    baseUrl: 'https://itc.test/api/v1', keyId, secretBase64,
    fetchImpl: async () => response(200, { success: true, data: { receivables: [{}], has_more: true, next_cursor: null } }),
    nonceFactory: () => nonce, now: () => 1792080000000,
  })
  await assert.rejects(client.getReceivables('not-a-uuid'), { code: 'ITC_FINANCE_REQUEST_INVALID', statusCode: 400 })
  await assert.rejects(client.getReceivables(operationId, { limit: 501 }), { code: 'ITC_FINANCE_REQUEST_INVALID', statusCode: 400 })
  await assert.rejects(client.getReceivables(operationId), { code: 'ITC_FINANCE_RESPONSE_INVALID', statusCode: 502 })
})
