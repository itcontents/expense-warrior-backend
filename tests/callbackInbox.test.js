const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { createCallbackInboxService, CallbackInboxError } = require('../src/callbackInbox/callbackInboxService')
const { createCallbackInboxRepository } = require('../src/callbackInbox/callbackInboxRepository')
const { createApp } = require('../src/app')

const transactionId = '11111111-1111-4111-8111-111111111111'
const payload = { depositId: transactionId, status: 'COMPLETED', correspondentIds: { MTN_FINAL: 'network-ref' }, payer: { address: { value: '260971234567' } } }
const digest = 'a'.repeat(64)

function createService({ inserted = true } = {}) {
  let stored
  const service = createCallbackInboxService({
    providerCode: 'pawapay',
    provider: {
      verifyCallback: async ({ requestContext }) => {
        assert.ok(Buffer.isBuffer(requestContext.rawBody))
        return true
      },
      normalizeCallback: ({ transactionType, rawBody, headers }) => {
        const body = JSON.parse(rawBody.toString('utf8'))
        return {
          transaction_id: body[transactionType === 'deposit' ? 'depositId' : 'payoutId'],
          provider_status: body.status,
          provider_reference: null,
          signature_key_id: 'merchant-key',
          signature_date: headers['signature-date'],
        }
      },
    },
    repository: { append: async (event) => { stored = event; return { inserted, eventId: inserted ? 'event-1' : null } } },
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  })
  return { service, get stored() { return stored } }
}

async function withServer(app, run) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('callback intake verifies raw body before parsing and persists only sanitized immutable hints', async () => {
  const harness = createService()
  const rawBody = Buffer.from(JSON.stringify(payload))
  const result = await harness.service.receive({ transactionType: 'deposit', rawBody, headers: {
    'signature-input': 'sig-pp=("@method");keyid="merchant-key"', 'signature-date': '2026-10-15T12:00:00.000Z',
  }, requestContext: { rawBody } })
  assert.equal(result.duplicate, false)
  assert.deepEqual(harness.stored, {
    provider_code: 'pawapay', provider_account_id: null, provider_account_version: null,
    transaction_type: 'deposit', transaction_id: transactionId,
    provider_status: 'COMPLETED', provider_reference: null,
    payload_sha256: require('node:crypto').createHash('sha256').update(rawBody).digest('hex'),
    signature_key_id: 'merchant-key', signature_date: '2026-10-15T12:00:00.000Z',
  })
  assert.equal(JSON.stringify(harness.stored).includes('260971234567'), false)
  assert.equal(JSON.stringify(harness.stored).includes('network-ref'), false)
})

test('callback intake rejects invalid signature before JSON parsing and storage', async () => {
  let writes = 0
  const service = createCallbackInboxService({
    provider: { verifyCallback: async () => { throw new Error('signature rejected') }, normalizeCallback: () => assert.fail('untrusted body must not be parsed') },
    repository: { append: async () => { writes += 1 } },
  })
  await assert.rejects(service.receive({ transactionType: 'deposit', rawBody: Buffer.from('{not json'), headers: {}, requestContext: {} }), CallbackInboxError)
  assert.equal(writes, 0)
})

test('callback intake rejects arrays, multiple records, invalid IDs, and invalid status', async () => {
  const harness = createService()
  const cases = [
    ['deposit', [payload]],
    ['deposit', { ...payload, depositId: 'bad-id' }],
    ['deposit', { ...payload, status: 'COMPLETED\nsecret' }],
    ['payout', payload],
  ]
  for (const [transactionType, body] of cases) {
    await assert.rejects(harness.service.receive({ transactionType, rawBody: Buffer.from(JSON.stringify(body)), headers: {}, requestContext: {} }), CallbackInboxError)
  }
  assert.equal(harness.stored, undefined)
})

test('callback intake returns duplicate result when exact payload hash already exists', async () => {
  const harness = createService({ inserted: false })
  const rawBody = Buffer.from(JSON.stringify(payload))
  const result = await harness.service.receive({ transactionType: 'deposit', rawBody,
    headers: { 'signature-date': '2026-10-15T12:00:00.000Z' }, requestContext: {} })
  assert.equal(result.duplicate, true)
  assert.equal(harness.stored.payload_sha256, require('node:crypto').createHash('sha256').update(rawBody).digest('hex'))
})

test('callback repository appends with exact-payload deduplication and never updates records', async () => {
  let statement
  let params
  const repository = createCallbackInboxRepository({ pool: { query: async (sql, values) => {
    statement = sql
    params = values
    return { rows: [] }
  } } })
  const result = await repository.append({ provider_code: 'pawapay', provider_account_id: null, provider_account_version: null,
    transaction_type: 'deposit', transaction_id: transactionId,
    provider_status: 'COMPLETED', provider_reference: null, payload_sha256: digest, signature_key_id: null,
    signature_date: '2026-10-15T12:00:00.000Z' })
  assert.deepEqual(result, { inserted: false, eventId: null })
  assert.match(statement, /ON CONFLICT \(provider_code, payload_sha256\) DO NOTHING/)
  assert.doesNotMatch(statement, /UPDATE\s+provider_callback_inbox/i)
  assert.ok(!params.includes(JSON.stringify(payload)))
  assert.equal(params.length, 10)
})

test('callback endpoint is disabled by default and when enabled it is mounted before JSON parser', async () => {
  let verificationCount = 0
  let stored
  const paymentProviders = { get: () => ({ verifyCallback: async ({ requestContext }) => {
    verificationCount += 1
    assert.ok(Buffer.isBuffer(requestContext.rawBody))
    return true
  }, normalizeCallback: ({ transactionType, rawBody, headers }) => {
    const parsed = JSON.parse(rawBody.toString('utf8'))
    return { transaction_id: parsed[transactionType === 'deposit' ? 'depositId' : 'payoutId'], provider_status: parsed.status,
      signature_key_id: 'merchant-key', signature_date: headers['signature-date'] }
  } }) }
  const app = createApp({ pool: { query: async () => ({ rows: [] }) }, paymentProviders,
    callbackInboxRepository: { append: async (event) => { stored = event; return { inserted: true, eventId: 'event-1' } } } })
  const body = JSON.stringify(payload)
  await withServer(app, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/api/v1/expense-warrior/providers/pawapay/callbacks/deposit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    assert.equal(response.status, 404)
    assert.equal(verificationCount, 0)
  })

  const enabledApp = createApp({ pool: { query: async () => ({ rows: [] }) }, paymentProviders, callbackInboxEnabled: true,
    callbackInboxRepository: { append: async (event) => { stored = event; return { inserted: true, eventId: 'event-1' } } } })
  await withServer(enabledApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/providers/pawapay/callbacks/deposit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'signature-input': 'sig-pp=("@method");keyid="merchant-key"',
        'signature-date': '2026-10-15T12:00:00.000Z' }, body,
    })
    assert.equal(response.status, 200)
    assert.equal(verificationCount, 1)
    assert.equal(stored.transaction_id, transactionId)
    assert.equal(stored.signature_key_id, 'merchant-key')
  })
})

test('enabling callback intake fails startup without a usable verifier', () => {
  const pool = { query: async () => ({ rows: [] }) }
  assert.throws(() => createApp({ pool, callbackInboxEnabled: true }), /provider registry/)
  assert.throws(() => createApp({ pool, callbackInboxEnabled: true, paymentProviders: { get: () => ({}) } }), /callback verifier/)
})

test('callback endpoint rejects requests over 64 KiB before verification', async () => {
  let verificationCount = 0
  const app = createApp({ pool: { query: async () => ({ rows: [] }) }, callbackInboxEnabled: true,
    paymentProviders: { get: () => ({ verifyCallback: async () => { verificationCount += 1 }, normalizeCallback: () => ({}) }) },
    callbackInboxRepository: { append: async () => ({ inserted: true }) } })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/providers/pawapay/callbacks/deposit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"padding":"${'x'.repeat(65536)}"}`,
    })
    assert.equal(response.status, 413)
    assert.equal(verificationCount, 0)
  })
})
