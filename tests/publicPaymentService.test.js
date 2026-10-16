const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createPublicPaymentService } = require('../src/paymentLinks/publicPaymentService')

const token = 'T'.repeat(43)
const attemptId = '10000000-0000-4000-8000-000000000001'
const idempotencyKey = '20000000-0000-4000-8000-000000000001'
const mtnNetwork = { provider_code: 'pawapay', code: 'MTN_MOMO_ZMB', label: 'MTN MoMo' }
const mtnDepositOption = { ...mtnNetwork, min_amount: '1', max_amount: '5000', decimals_in_amount: 'TWO_PLACES', auth_type: 'PROVIDER_AUTH', pin_prompt: 'AUTOMATIC' }
const baseAttempt = {
  attempt_id: attemptId,
  provider_transaction_id: attemptId,
  provider_code: 'pawapay',
  network_code: 'MTN_MOMO_ZMB',
  payer_phone: '260763456789',
  amount: '125.00',
  currency: 'ZMW',
  state: 'SUBMITTING',
  created_at: '2026-10-15T12:00:00.000Z',
  updated_at: '2026-10-15T12:00:00.000Z',
}
const baseLink = { payment_link_id: '40000000-0000-4000-8000-000000000001', amount: '125.00', currency: 'ZMW', description: 'Test' }
const providerAccountIdentity = { provider_account_id: '80000000-0000-4000-8000-000000000001', provider_account_version: 2 }
const acceptedDeposit = (id = attemptId) => ({ transaction_id: id, outcome: 'ACCEPTED', provider_status: 'ACCEPTED' })
const completedDeposit = ({ id = attemptId, requestedAmount = '125.00', receivedAmount = '125.00', phone = '260763456789', network = 'MTN_MOMO_ZMB', providerReference = 'provider-ref-1' } = {}) => ({
  transaction_id: id, outcome: 'SUCCEEDED', provider_status: 'COMPLETED',
  evidence: { country: 'ZMB', amount: requestedAmount, requested_amount: requestedAmount,
    received_amount: receivedAmount, currency: 'ZMW', network_code: network,
    phone_number: phone, provider_transaction_id: providerReference },
})

test('startAttempt persists a stable attempt, sends one signed-provider operation and masks the phone', async () => {
  const calls = []
  const repository = {
    getPublicLink: async () => baseLink,
    createAttempt: async (input) => ({ link: { amount: '125.00', currency: 'ZMW' }, attempt: { ...baseAttempt, ...input }, replayed: false }),
    updateAttempt: async (_id, update) => ({ ...baseAttempt, ...update }),
  }
  const service = createPublicPaymentService({
    repository,
    idFactory: () => attemptId,
    providerRegistry: { getActiveNetworks: async () => [mtnDepositOption], getAccountIdentity: () => providerAccountIdentity, get: () => ({
      initiateDeposit: async (input) => { calls.push(input); return acceptedDeposit() },
      getDepositStatus: async () => null,
    }) },
  })
  const result = await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(calls.length, 1)
  assert.equal(result.attempt.provider_code, 'pawapay')
  assert.equal(calls[0].amount, '125.00')
  assert.equal(calls[0].transaction_id, attemptId)
  assert.equal(calls[0].customer_message, 'EW petty cash')
  assert.equal(result.attempt.status, 'PENDING')
  assert.equal(result.attempt.receipt_available, false)
  assert.equal(JSON.stringify(result).includes('260763456789'), false)
})

test('startAttempt preserves the selected add-on and account identity through attempt creation', async () => {
  const addonAccount = { provider_account_id: '71000000-0000-4000-8000-000000000001', provider_account_version: 3 }
  const addonNetwork = { ...mtnDepositOption, provider_code: 'airtel_direct', code: 'AIRTEL_OAPI_ZMB', provider_label: 'Airtel Direct' }
  const repositoryInputs = []
  const adapterSelections = []
  const initiated = []
  const adapter = {
    initiateDeposit: async (input) => {
      initiated.push(input)
      return acceptedDeposit()
    },
    getDepositStatus: async () => null,
  }
  const persistedAttempt = (input) => ({
    ...baseAttempt,
    ...input,
    provider_code: input.providerCode,
    provider_account_id: input.providerAccountId,
    provider_account_version: input.providerAccountVersion,
    network_code: input.networkCode,
    payer_phone: input.phoneNumber,
  })
  const service = createPublicPaymentService({
    repository: {
      getPublicLink: async () => baseLink,
      createAttempt: async (input) => {
        repositoryInputs.push(input)
        return { link: baseLink, attempt: persistedAttempt(input), replayed: false }
      },
      updateAttempt: async (_attemptId, changes) => ({ ...persistedAttempt(repositoryInputs[0]), ...changes }),
    },
    idFactory: () => attemptId,
    providerRegistry: {
      getActiveNetworks: async () => [addonNetwork],
      getAccountIdentity: (providerCode) => providerCode === 'airtel_direct' ? addonAccount : null,
      getForOperation: (...selection) => {
        adapterSelections.push(selection)
        return adapter
      },
    },
  })

  const result = await service.startAttempt(token, {
    provider_code: 'airtel_direct', network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783',
  }, idempotencyKey)

  assert.equal(result.attempt.provider_code, 'airtel_direct')
  assert.equal(repositoryInputs[0].providerCode, 'airtel_direct')
  assert.equal(repositoryInputs[0].providerAccountId, addonAccount.provider_account_id)
  assert.equal(repositoryInputs[0].providerAccountVersion, addonAccount.provider_account_version)
  assert.deepEqual(adapterSelections, [['airtel_direct', 'deposit', addonAccount]])
  assert.equal(initiated[0].network_code, 'AIRTEL_OAPI_ZMB')
  assert.equal(initiated[0].phone_number, '260957909783')
})

test('startAttempt sends whole-number amounts as integers for a NONE-decimal network', async () => {
  const calls = []
  const noDecimalOption = { ...mtnDepositOption, decimals_in_amount: 'NONE' }
  const service = createPublicPaymentService({
    repository: {
      getPublicLink: async () => baseLink,
      createAttempt: async (input) => ({ link: baseLink, attempt: { ...baseAttempt, ...input }, replayed: false }),
      updateAttempt: async (_id, changes) => ({ ...baseAttempt, ...changes }),
    },
    idFactory: () => attemptId,
    providerRegistry: {
      getActiveNetworks: async () => [noDecimalOption],
      getAccountIdentity: () => providerAccountIdentity,
      get: () => ({ initiateDeposit: async (input) => { calls.push(input); return acceptedDeposit() }, getDepositStatus: async () => null }),
    },
  })
  await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(calls[0].amount, '125')
})

test('startAttempt replays the same idempotency key without a second provider call', async () => {
  let calls = 0
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(['MTN_MOMO_ZMB', '260763456789'])).digest('hex')
  const service = createPublicPaymentService({
    repository: { getAttemptByIdempotency: async () => ({ ...baseAttempt, request_fingerprint: requestFingerprint, state: 'UNKNOWN' }) },
    idFactory: () => attemptId,
    providerRegistry: { getActiveNetworks: async () => { throw new Error('configuration temporarily unavailable') }, get: () => ({ initiateDeposit: async () => { calls++; return {} }, getDepositStatus: async () => null }) },
  })
  const result = await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(result.replayed, true)
  assert.equal(result.attempt.status, 'UNKNOWN')
  assert.equal(calls, 0)
})

test('startAttempt rejects changed payloads for a previously used idempotency key', async () => {
  let configLookups = 0
  const service = createPublicPaymentService({
    repository: { getAttemptByIdempotency: async () => ({ request_fingerprint: 'a'.repeat(64) }) },
    providerRegistry: { getActiveNetworks: async () => { configLookups++; return [] } },
  })
  await assert.rejects(service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 })
  assert.equal(configLookups, 0)
})

test('verified provider success remains pending ITC credit when the finance client is unavailable', async () => {
  const updates = []
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => ({ ...baseAttempt, state: 'PENDING' }),
      updateAttempt: async (_id, update) => { updates.push(update); return { ...baseAttempt, ...update, updated_at: '2026-10-15T12:01:00.000Z' } },
    },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => completedDeposit() }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'VERIFYING_LEDGER')
  assert.equal(result.receipt_available, false)
  assert.equal(updates[0].state, 'VERIFIED_PENDING_LEDGER')
  assert.equal(updates[0].verified, true)
})

test('confirmed PawaPay success posts the explicit link target and issues a receipt only after ITC applies it', async () => {
  const calls = []
  const succeeded = { ...baseAttempt, state: 'SUCCEEDED', ledger_operation_id: '30000000-0000-4000-8000-000000000001', updated_at: '2026-10-15T12:01:00.000Z' }
  const attempt = {
    ...baseAttempt,
    state: 'PENDING',
    payment_link_id: '40000000-0000-4000-8000-000000000001',
    created_by_customer_id: '50000000-0000-4000-8000-000000000001',
    collection_target_type: 'REVENUE',
    revenue_account_code: '4000',
  }
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => attempt,
      updateAttempt: async (_id, update) => ({ ...attempt, ...update, verified_at: '2026-10-15T12:01:00.000Z', provider_evidence_digest: update.evidenceDigest }),
      markAttemptSucceeded: async (id, operationId) => { calls.push({ id, operationId }); return succeeded },
    },
    itcFinanceClient: { postEarnedRevenueCollection: async (payload, key) => {
      calls.push({ payload, key })
      return { operation: { operation_id: succeeded.ledger_operation_id } }
    } },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => completedDeposit() }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.receipt_available, true)
  assert.equal(calls[0].payload.collection_attempt_id, attemptId)
  assert.equal(calls[0].payload.revenue_account_code, '4000')
  assert.match(calls[0].key, /^ew-collect-[a-f0-9]{64}$/)
  assert.deepEqual(calls[1], { id: attemptId, operationId: succeeded.ledger_operation_id })
})

test('integer PawaPay amount evidence matches the fixed two-decimal ledger amount exactly', async () => {
  const attempt = {
    ...baseAttempt, state: 'PENDING', payment_link_id: '40000000-0000-4000-8000-000000000001',
    created_by_customer_id: '50000000-0000-4000-8000-000000000001', collection_target_type: 'REVENUE', revenue_account_code: '4000',
  }
  let update
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => attempt,
      updateAttempt: async (_id, changes) => { update = changes; return { ...attempt, ...changes, verified_at: '2026-10-15T12:01:00.000Z', provider_evidence_digest: changes.evidenceDigest } },
      markAttemptSucceeded: async (_id, operationId) => ({ ...attempt, state: 'SUCCEEDED', ledger_operation_id: operationId }),
    },
    itcFinanceClient: { postEarnedRevenueCollection: async () => ({ operation: { operation_id: '30000000-0000-4000-8000-000000000001' } }) },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => completedDeposit({ requestedAmount: '125', receivedAmount: '125', providerReference: 'provider-ref-integer' }) }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(update.verified, true)
  assert.equal(result.status, 'SUCCEEDED')
})

test('verified pending collection retries the same ITC operation without another provider status call', async () => {
  const itcCalls = []
  let providerCalls = 0
  const attempt = {
    ...baseAttempt,
    state: 'VERIFIED_PENDING_LEDGER',
    payment_link_id: '40000000-0000-4000-8000-000000000001',
    created_by_customer_id: '50000000-0000-4000-8000-000000000001',
    collection_target_type: 'CUSTOMER_CREDIT',
    customer_id: '50000000-0000-4000-8000-000000000002',
    provider_evidence_digest: 'a'.repeat(64),
    verified_at: '2026-10-15T12:01:00.000Z',
  }
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => attempt,
      markAttemptSucceeded: async (_id, operationId) => ({ ...attempt, state: 'SUCCEEDED', ledger_operation_id: operationId }),
    },
    itcFinanceClient: { creditCustomerAccount: async (payload, key) => {
      itcCalls.push({ payload, key })
      return { operation: { operation_id: '30000000-0000-4000-8000-000000000001' } }
    } },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => { providerCalls++; return null } }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.receipt_available, true)
  assert.equal(providerCalls, 0)
  assert.equal(itcCalls.length, 1)
  assert.equal(itcCalls[0].payload.customer_id, attempt.customer_id)
})

test('provider success with mismatched destination remains unknown and uncredited', async () => {
  const updates = []
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => ({ ...baseAttempt, state: 'PENDING' }),
      updateAttempt: async (_id, update) => { updates.push(update); return { ...baseAttempt, ...update } },
    },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => completedDeposit({ phone: '260953456700', providerReference: null }) }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'UNKNOWN')
  assert.equal(result.receipt_available, false)
  assert.equal(updates[0].errorCode, 'PROVIDER_EVIDENCE_MISMATCH')
})

test('startAttempt rejects non-Zambian or malformed phone numbers before persistence', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { createAttempt: async () => { persisted = true } },
    providerRegistry: { get: () => ({ initiateDeposit: async () => assert.fail('must not call provider') }) },
  })
  await assert.rejects(service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '957909783' }, idempotencyKey), { code: 'INVALID_PAYMENT_ATTEMPT' })
  assert.equal(persisted, false)
})

test('getLink advertises active provider options, including amount and authorization requirements', async () => {
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => ({ payment_link_id: 'link-1', description: 'Invoice', amount: '125.00', currency: 'ZMW' }) },
    providerRegistry: { getActiveNetworks: async () => [mtnDepositOption] },
  })
  assert.deepEqual(await service.getLink(token), {
    payment_link_id: 'link-1', description: 'Invoice', amount: '125.00', currency: 'ZMW',
    available_networks: [{ provider_code: 'pawapay', code: 'MTN_MOMO_ZMB', label: 'MTN MoMo', min_amount: '1', max_amount: '5000', decimals_in_amount: 'TWO_PLACES', auth_type: 'PROVIDER_AUTH', pin_prompt: 'AUTOMATIC' }],
  })
})

test('getLink keeps same-network options from different provider add-ons distinct', async () => {
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => ({ ...baseLink, amount: '125.00' }) },
    providerRegistry: { getActiveNetworks: async () => [
      { ...mtnDepositOption, provider_label: 'PawaPay' },
      { ...mtnDepositOption, provider_code: 'another_provider', provider_label: 'Another Provider' },
    ] },
  })

  const link = await service.getLink(token)
  assert.deepEqual(link.available_networks.map(({ provider_code, provider_label, code }) => ({ provider_code, provider_label, code })), [
    { provider_code: 'pawapay', provider_label: 'PawaPay', code: 'MTN_MOMO_ZMB' },
    { provider_code: 'another_provider', provider_label: 'Another Provider', code: 'MTN_MOMO_ZMB' },
  ])
})

test('getLink hides configured networks whose amount rules cannot accept the fixed link amount', async () => {
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => ({ ...baseLink, amount: '125.50' }) },
    providerRegistry: { getActiveNetworks: async () => [{ ...mtnDepositOption, decimals_in_amount: 'NONE' }] },
  })
  assert.deepEqual((await service.getLink(token)).available_networks, [])
})

test('A/R attempts reserve the full delivered invoice before PawaPay and post with the reservation after verified success', async () => {
  const calls = []
  const link = {
    payment_link_id: '40000000-0000-4000-8000-000000000001', amount: '125.00', currency: 'ZMW',
    collection_target_type: 'AR_SETTLEMENT', customer_id: '50000000-0000-4000-8000-000000000001',
    receivable_id: '60000000-0000-4000-8000-000000000001', created_by_customer_id: '70000000-0000-4000-8000-000000000001',
  }
  const service = createPublicPaymentService({
    repository: {
      getPublicLink: async () => link,
      createAttempt: async (input) => ({ link, attempt: { ...baseAttempt, ...input, payment_link_id: link.payment_link_id }, replayed: false }),
      updateAttempt: async (_id, update) => ({ ...baseAttempt, ...update }),
    },
    itcFinanceClient: { reserveCustomerReceivablePayment: async (payload, key) => {
      calls.push({ type: 'reserve', payload, key })
      return { reservation: { reservation_id: payload.reservation_id, state: 'ACTIVE' } }
    } },
    idFactory: () => attemptId,
    providerRegistry: { getActiveNetworks: async () => [mtnDepositOption], getAccountIdentity: () => ({
      provider_account_id: '80000000-0000-4000-8000-000000000001', provider_account_version: 2,
    }), get: () => ({
      initiateDeposit: async (input) => { calls.push({ type: 'provider', input }); return acceptedDeposit() },
      getDepositStatus: async () => null,
    }) },
  })
  const result = await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(result.attempt.status, 'PENDING')
  assert.deepEqual(calls.map(({ type }) => type), ['reserve', 'provider'])
  assert.equal(calls[0].payload.receivable_id, link.receivable_id)
  assert.equal(calls[0].payload.amount, link.amount)
  assert.equal(calls[0].key, `ew-ar-reserve-${attemptId}`)
})

test('A/R payment attempt refuses to start if the ITC provider account identity is missing', async () => {
  let persisted = false
  const link = {
    ...baseLink, collection_target_type: 'AR_SETTLEMENT',
    customer_id: '50000000-0000-4000-8000-000000000001',
    receivable_id: '60000000-0000-4000-8000-000000000001',
  }
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => link, createAttempt: async () => { persisted = true } },
    providerRegistry: {
      getActiveNetworks: async () => [mtnDepositOption],
      get: () => ({
        initiateDeposit: async () => assert.fail('must not initiate a provider deposit'),
        getDepositStatus: async () => null,
      }),
    },
  })
  await assert.rejects(
    service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey),
    { code: 'PAYMENT_PROVIDER_CONFIGURATION_UNAVAILABLE', statusCode: 503 },
  )
  assert.equal(persisted, false)
})

test('A/R collection posts through ITC with its reservation and closes the attempt only after application', async () => {
  const calls = []
  const attempt = {
    ...baseAttempt, state: 'PENDING', payment_link_id: '40000000-0000-4000-8000-000000000001',
    created_by_customer_id: '70000000-0000-4000-8000-000000000001',
    collection_target_type: 'AR_SETTLEMENT', customer_id: '50000000-0000-4000-8000-000000000001',
    receivable_id: '60000000-0000-4000-8000-000000000001',
    provider_account_id: '80000000-0000-4000-8000-000000000001', provider_account_version: 2,
  }
  const success = { ...attempt, state: 'SUCCEEDED', ledger_operation_id: '30000000-0000-4000-8000-000000000001' }
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => attempt,
      updateAttempt: async (_id, update) => ({ ...attempt, ...update, verified_at: update.verified ? '2026-10-15T12:01:00.000Z' : attempt.verified_at, provider_evidence_digest: update.evidenceDigest }),
      markAttemptSucceeded: async (_id, operationId) => { calls.push({ type: 'complete', operationId }); return success },
    },
    itcFinanceClient: { applyCustomerReceivablePayment: async (payload, key) => {
      calls.push({ type: 'post', payload, key })
      return { operation: { operation_id: success.ledger_operation_id } }
    } },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => completedDeposit() }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.receipt_available, true)
  assert.equal(calls[0].payload.reservation_id, attemptId)
  assert.equal(calls[0].payload.receivable_id, attempt.receivable_id)
  assert.equal(calls[0].payload.amount, '125.00')
  assert.equal(calls[0].payload.provider_account_id, attempt.provider_account_id)
  assert.equal(calls[0].payload.provider_account_version, 2)
  assert.equal(calls[1].type, 'complete')
})

test('startAttempt rejects a network absent from provider capabilities before persistence', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => baseLink, createAttempt: async () => { persisted = true } },
    providerRegistry: { getActiveNetworks: async () => [], get: () => assert.fail('must not create a provider client') },
  })
  await assert.rejects(service.startAttempt(token, { network_code: 'ZAMTEL_ZMB', phone_number: '260953456789' }, idempotencyKey), { code: 'INVALID_PAYMENT_ATTEMPT' })
  assert.equal(persisted, false)
})

test('startAttempt hides and rejects network auth modes unsupported by the phone-prompt flow', async () => {
  let persisted = false
  const preAuthNetwork = { ...mtnDepositOption, auth_type: 'PREAUTH' }
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => baseLink, createAttempt: async () => { persisted = true } },
    providerRegistry: { getActiveNetworks: async () => [preAuthNetwork] },
  })

  const link = await service.getLink(token)
  assert.deepEqual(link.available_networks, [])
  await assert.rejects(
    service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey),
    { code: 'INVALID_PAYMENT_ATTEMPT' },
  )
  assert.equal(persisted, false)
})

test('startAttempt hides networks without an automatic provider auth prompt', async () => {
  const manualPromptNetwork = { ...mtnDepositOption, pin_prompt: 'MANUAL' }
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => baseLink },
    providerRegistry: { getActiveNetworks: async () => [manualPromptNetwork] },
  })
  const link = await service.getLink(token)
  assert.deepEqual(link.available_networks, [])
})

test('startAttempt fails closed when active configuration advertises the same network from multiple providers', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => baseLink, createAttempt: async () => { persisted = true } },
    providerRegistry: { getActiveNetworks: async () => [mtnDepositOption, { ...mtnDepositOption, provider_code: 'another_provider' }] },
  })
  await assert.rejects(
    service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey),
    { code: 'PAYMENT_NETWORK_ROUTE_AMBIGUOUS', statusCode: 503 },
  )
  assert.equal(persisted, false)
})

test('startAttempt fails closed when provider active configuration cannot be confirmed', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => baseLink, createAttempt: async () => { persisted = true } },
    providerRegistry: { getActiveNetworks: async () => { throw new Error('provider config unavailable') } },
  })
  await assert.rejects(service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey), { code: 'PAYMENT_PROVIDER_UNAVAILABLE', statusCode: 503 })
  assert.equal(persisted, false)
})
