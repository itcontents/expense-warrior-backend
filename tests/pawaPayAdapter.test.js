const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { PawaPayClient, PawaPayError } = require('../src/providers/pawapay/PawaPayClient')
const { createProviderRegistry } = require('../src/providers/providerRegistry')

const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = pair.publicKey
const now = Date.parse('2026-10-15T12:00:00.000Z')
const config = {
  apiToken: 'sandbox-test-token',
  baseUrl: 'https://api.sandbox.pawapay.io',
  signatureEnabled: true,
  signatureKeyId: 'expense-warrior-test',
  signaturePrivateKey: privateKey,
  requestTimeoutMs: 500,
}

function verifyRequestSignature({ url, method, body = '', headers }) {
  const parsed = new URL(url)
  const signatureInput = headers['Signature-Input']
  const inputMatch = signatureInput.match(/^sig-pp=(\(.+\))((?:;.+)+)$/)
  assert.ok(inputMatch, 'Signature-Input must contain the signed components and parameters')
  const params = `${inputMatch[1]}${inputMatch[2]}`
  const digest = `sha-512=:${crypto.createHash('sha512').update(body).digest('base64')}:`
  assert.equal(headers['Content-Digest'], digest)
  const signatureBase = [
    `"@method": ${method}`,
    `"@authority": ${parsed.host}`,
    `"@path": ${parsed.pathname}${parsed.search}`,
    `"signature-date": ${headers['Signature-Date']}`,
    `"content-digest": ${digest}`,
    '"content-type": application/json; charset=UTF-8',
    `"@signature-params": ${params}`,
  ].join('\n')
  const signature = headers.Signature.match(/^sig-pp=:(.+):$/)?.[1]
  assert.ok(signature)
  assert.equal(crypto.verify('sha256', Buffer.from(signatureBase), publicKey, Buffer.from(signature, 'base64')), true)
}

function signedCallback(rawBody, { keyId = 'callback-01', timestamp = now } = {}) {
  const body = Buffer.from(rawBody)
  const signatureDate = new Date(timestamp).toISOString()
  const created = Math.floor(timestamp / 1000)
  const contentDigest = `sha-512=:${crypto.createHash('sha512').update(body).digest('base64')}:`
  const contentType = 'application/json'
  const signatureParams = `("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="${keyId}";created=${created};expires=${created + 60}`
  const signatureInput = `sig-pp=${signatureParams}`
  const base = [
    '"@method": POST', '"@authority": expense.example.test', '"@path": /api/v1/expense-warrior/providers/pawapay/callbacks/deposit',
    `"signature-date": ${signatureDate}`, `"content-digest": ${contentDigest}`, `"content-type": ${contentType}`,
    `"@signature-params": ${signatureParams}`,
  ].join('\n')
  const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64')
  return {
    rawBody: body,
    requestContext: {
      method: 'POST', authority: 'expense.example.test', originalUrl: '/api/v1/expense-warrior/providers/pawapay/callbacks/deposit',
      rawBody: body,
      headers: {
        host: 'expense.example.test', 'signature-date': signatureDate, 'content-digest': contentDigest,
        'content-type': contentType, 'signature-input': signatureInput, signature: `sig-pp=:${signature}:`,
      },
    },
  }
}

test('financial calls include valid PawaPay HTTP message signatures over exact request body', async () => {
  let call
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      call = { url: String(url), ...options }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ depositId: '11111111-1111-4111-8111-111111111111', status: 'ACCEPTED' }) }
    },
  })

  await client.initiateDeposit({ depositId: '11111111-1111-4111-8111-111111111111', amount: '10.00', phoneNumber: '260763456789', provider: 'MTN_MOMO_ZMB' })

  assert.equal(call.method, 'POST')
  assert.equal(call.url, 'https://api.sandbox.pawapay.io/v2/deposits')
  assert.equal(call.headers.Authorization, 'Bearer sandbox-test-token')
  assert.deepEqual(JSON.parse(call.body), {
    depositId: '11111111-1111-4111-8111-111111111111',
    payer: { type: 'MMO', accountDetails: { phoneNumber: '260763456789', provider: 'MTN_MOMO_ZMB' } },
    amount: '10.00', currency: 'ZMW',
  })
  verifyRequestSignature(call)
})

test('payout calls are signed and use the recipient payload contract', async () => {
  let call
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      call = { url: String(url), ...options }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"status":"ACCEPTED"}' }
    },
  })

  await client.initiatePayout({ payoutId: '22222222-2222-4222-8222-222222222222', amount: '25.50', phoneNumber: '260953456700', provider: 'ZAMTEL_ZMB', clientReferenceId: 'EW-REQ-1', customerMessage: 'Expense request' })

  assert.equal(call.url, 'https://api.sandbox.pawapay.io/v2/payouts')
  assert.deepEqual(JSON.parse(call.body), {
    payoutId: '22222222-2222-4222-8222-222222222222',
    recipient: { type: 'MMO', accountDetails: { phoneNumber: '260953456700', provider: 'ZAMTEL_ZMB' } },
    amount: '25.50', currency: 'ZMW', clientReferenceId: 'EW-REQ-1', customerMessage: 'Expense request',
  })
  verifyRequestSignature(call)
})

test('refund initiation is signed, tied to the original deposit, and safely queryable', async () => {
  const calls = []
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options })
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () =>
        calls.length === 1
          ? '{"refundId":"33333333-3333-4333-8333-333333333333","status":"ACCEPTED"}'
          : '{"status":"FOUND","data":{"refundId":"33333333-3333-4333-8333-333333333333","status":"COMPLETED"}}' }
    },
  })

  const submitted = await client.initiateRefund({
    refundId: '33333333-3333-4333-8333-333333333333',
    depositId: '11111111-1111-4111-8111-111111111111',
    amount: '12.00',
    clientReferenceId: 'EW-RETURN-1',
  })
  const status = await client.getRefundStatus('33333333-3333-4333-8333-333333333333')

  assert.equal(submitted.status, 'ACCEPTED')
  assert.equal(calls[0].url, 'https://api.sandbox.pawapay.io/v2/refunds')
  assert.deepEqual(JSON.parse(calls[0].body), {
    refundId: '33333333-3333-4333-8333-333333333333',
    depositId: '11111111-1111-4111-8111-111111111111',
    amount: '12.00', currency: 'ZMW', clientReferenceId: 'EW-RETURN-1',
  })
  verifyRequestSignature(calls[0])
  assert.equal(calls[1].url, 'https://api.sandbox.pawapay.io/v2/refunds/33333333-3333-4333-8333-333333333333')
  verifyRequestSignature(calls[1])
  assert.equal(status.data.status, 'COMPLETED')
})

test('refund initiation validates both identities and amount before provider access', () => {
  let calls = 0
  const client = new PawaPayClient(config, { fetchImpl: async () => { calls += 1 } })
  assert.throws(() => client.initiateRefund({ refundId: 'bad', depositId: '11111111-1111-4111-8111-111111111111', amount: '12.00', clientReferenceId: 'EW-RETURN-1' }), { code: 'PAWAPAY_TRANSACTION_ID_INVALID' })
  assert.throws(() => client.initiateRefund({ refundId: '33333333-3333-4333-8333-333333333333', depositId: 'bad', amount: '12.00', clientReferenceId: 'EW-RETURN-1' }), { code: 'PAWAPAY_TRANSACTION_ID_INVALID' })
  assert.throws(() => client.initiateRefund({ refundId: '33333333-3333-4333-8333-333333333333', depositId: '11111111-1111-4111-8111-111111111111', amount: '0', clientReferenceId: 'EW-RETURN-1' }), { code: 'PAWAPAY_INPUT_INVALID' })
  assert.equal(calls, 0)
})

test('wallet balance lookup uses the documented country filter and returns provider payload', async () => {
  let call
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      call = { url: String(url), ...options }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"balances":[{"country":"ZMB","currency":"ZMW","balance":"120.00","provider":""}]}' }
    },
  })

  const result = await client.getWalletBalances({ country: 'ZMB' })

  assert.equal(call.url, 'https://api.sandbox.pawapay.io/v2/wallet-balances?country=ZMB')
  assert.deepEqual(result.balances, [{ country: 'ZMB', currency: 'ZMW', balance: '120.00', provider: '' }])
})

test('deposit options come only from operational Zambia ZMW entries in active configuration', async () => {
  let call
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      call = { url: String(url), ...options }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({
        companyName: 'Merchant',
        countries: [{ country: 'ZMB', providers: [
          { provider: 'MTN_MOMO_ZMB', currencies: [{ currency: 'ZMW', operationTypes: [{ DEPOSIT: { status: 'OPERATIONAL', minTransactionLimit: '5', maxTransactionLimit: '2500', decimalsInAmount: 'TWO_PLACES', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC' } }] }] },
          { provider: 'AIRTEL_OAPI_ZMB', currencies: [{ currency: 'ZMW', operationTypes: [{ operationType: 'DEPOSIT', status: 'OPERATIONAL', minTransactionLimit: '1', maxTransactionLimit: '1000', decimalsInAmount: 'TWO_PLACES', authType: 'PREAUTH' }] }] },
          { provider: 'ZAMTEL_ZMB', currencies: [{ currency: 'ZMW', operationTypes: [{ operationType: 'DEPOSIT', status: 'DELAYED', minTransactionLimit: '1', maxTransactionLimit: '1000', decimalsInAmount: 'NONE', authType: 'PROVIDER_AUTH' }] }] },
          { provider: 'UNSUPPORTED_ZMB', currencies: [{ currency: 'ZMW', operationTypes: [{ operationType: 'DEPOSIT', status: 'OPERATIONAL' }] }] },
        ] }, { country: 'MWI', providers: [] }],
      }) }
    },
  })

  const options = await client.getDepositNetworkOptions()

  assert.equal(call.url, 'https://api.sandbox.pawapay.io/v2/active-conf?country=ZMB&operationType=DEPOSIT')
  assert.deepEqual(options, [{
    code: 'MTN_MOMO_ZMB', label: 'MTN MoMo', min_amount: '5', max_amount: '2500',
    decimals_in_amount: 'TWO_PLACES', auth_type: 'PROVIDER_AUTH', pin_prompt: 'AUTOMATIC',
  }])
})

test('deposit options accept the operationTypes object and amount fields returned by PawaPay', async () => {
  const configuration = {
    countries: [{ country: 'ZMB', providers: [
      { provider: 'AIRTEL_OAPI_ZMB', currencies: [{ currency: 'ZMW', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '1', maxAmount: '20000', decimalsInAmount: 'TWO_PLACES', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC' } } }] },
      { provider: 'MTN_MOMO_ZMB', currencies: [{ currency: 'ZMW', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '1', maxAmount: '20000', decimalsInAmount: 'TWO_PLACES', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC' } } }] },
      { provider: 'ZAMTEL_ZMB', currencies: [{ currency: 'ZMW', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '1', maxAmount: '20000', decimalsInAmount: 'TWO_PLACES', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC' } } }] },
    ] }],
  }
  const client = new PawaPayClient(config, {
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(configuration) }),
  })

  const options = await client.getDepositNetworkOptions()

  assert.deepEqual(options.map(({ code, min_amount, max_amount, pin_prompt }) => ({ code, min_amount, max_amount, pin_prompt })), [
    { code: 'AIRTEL_OAPI_ZMB', min_amount: '1', max_amount: '20000', pin_prompt: 'AUTOMATIC' },
    { code: 'MTN_MOMO_ZMB', min_amount: '1', max_amount: '20000', pin_prompt: 'AUTOMATIC' },
    { code: 'ZAMTEL_ZMB', min_amount: '1', max_amount: '20000', pin_prompt: 'AUTOMATIC' },
  ])
})

test('active configuration must be structurally valid before exposing deposit options', async () => {
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"countries":{}}' }),
  })
  await assert.rejects(client.getDepositNetworkOptions(), { code: 'PAWAPAY_RESPONSE_INVALID' })
})

test('invalid transaction identifiers and amounts are rejected before network access', async () => {
  let calls = 0
  const client = new PawaPayClient({ ...config, signaturePrivateKey: privateKey }, { fetchImpl: async () => { calls += 1 } })
  assert.throws(() => client.getDepositStatus('not-a-uuid'), { code: 'PAWAPAY_TRANSACTION_ID_INVALID' })
  assert.throws(() => client.initiateDeposit({ depositId: '11111111-1111-4111-8111-111111111111', amount: '0', phoneNumber: '260763456789', provider: 'MTN_MOMO_ZMB' }), { code: 'PAWAPAY_INPUT_INVALID' })
  assert.equal(calls, 0)
})

test('an ambiguous payout timeout is marked unknown and is never retried by the client', async () => {
  let calls = 0
  const client = new PawaPayClient({ ...config, requestTimeoutMs: 500 }, {
    now: () => now,
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
  })

  await assert.rejects(
    () => client.initiatePayout({ payoutId: '22222222-2222-4222-8222-222222222222', amount: '25.50', phoneNumber: '260953456700', provider: 'ZAMTEL_ZMB', clientReferenceId: 'EW-REQ-1', customerMessage: 'Expense request' }),
    (error) => error instanceof PawaPayError && error.code === 'PAWAPAY_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
  )
  assert.equal(calls, 1)
})

test('financial calls fail closed when request signing is disabled or the key is missing', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1 }
  assert.throws(() => new PawaPayClient({ ...config, signatureEnabled: false }, { fetchImpl }), { code: 'PAWAPAY_SIGNATURE_REQUIRED' })
  const client = new PawaPayClient({ ...config, signaturePrivateKey: '' }, { fetchImpl })
  await assert.rejects(() => client.initiateDeposit({ depositId: '11111111-1111-4111-8111-111111111111', amount: '10.00', phoneNumber: '260763456789', provider: 'MTN_MOMO_ZMB' }), { code: 'PAWAPAY_SIGNATURE_PRIVATE_KEY_MISSING' })
  assert.equal(calls, 0)
})

test('callback verification checks the exact signed request and caches provider public keys', async () => {
  let keyRequests = 0
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      keyRequests += 1
      assert.equal(url, 'https://api.sandbox.pawapay.io/v2/public-key/http')
      assert.equal(options.headers.Authorization, 'Bearer sandbox-test-token')
      assert.equal(options.headers.Signature, undefined)
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'callback-01', key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]) }
    },
  })
  const callback = signedCallback('{"depositId":"11111111-1111-4111-8111-111111111111","status":"COMPLETED"}')
  assert.equal(await client.verifyCallback(callback), true)
  assert.equal(await client.verifyCallback(callback), true)
  assert.equal(keyRequests, 1)
})

test('callback verification rejects a changed body and expired signature before trusting it', async () => {
  let keyRequests = 0
  const client = new PawaPayClient(config, {
    now: () => now,
    fetchImpl: async () => { keyRequests += 1; throw new Error('must not fetch keys') },
  })
  const changed = signedCallback('{"status":"COMPLETED"}')
  changed.requestContext.rawBody = Buffer.from('{"status":"FAILED"}')
  await assert.rejects(() => client.verifyCallback(changed), { code: 'PAWAPAY_CALLBACK_DIGEST_INVALID' })

  const expired = signedCallback('{"status":"COMPLETED"}', { timestamp: now - 600000 })
  await assert.rejects(() => client.verifyCallback(expired), { code: 'PAWAPAY_CALLBACK_WINDOW_INVALID' })
  assert.equal(keyRequests, 0)
})

test('provider registry selects PawaPay by normalized code and rejects unknown providers', () => {
  const registry = createProviderRegistry({
    pawaPayConfig: config,
    dependencies: { pawapay: { fetchImpl: async () => {} } },
  })
  assert.ok(registry.get(' PawaPay ') instanceof PawaPayClient)
  assert.deepEqual(registry.list(), ['pawapay'])
  assert.throws(() => registry.get('unconfigured-provider'), { code: 'PAYMENT_PROVIDER_UNSUPPORTED' })
})
