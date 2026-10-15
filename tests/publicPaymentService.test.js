const test = require('node:test')
const assert = require('node:assert/strict')
const { createPublicPaymentService } = require('../src/paymentLinks/publicPaymentService')

const token = 'T'.repeat(43)
const attemptId = '10000000-0000-4000-8000-000000000001'
const idempotencyKey = '20000000-0000-4000-8000-000000000001'
const mtnNetwork = { provider_code: 'pawapay', code: 'MTN_MOMO_ZMB', label: 'MTN MoMo' }
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

test('startAttempt persists a stable attempt, sends one signed-provider operation and masks the phone', async () => {
  const calls = []
  const repository = {
    createAttempt: async (input) => ({ link: { amount: '125.00', currency: 'ZMW' }, attempt: { ...baseAttempt, ...input }, replayed: false }),
    updateAttempt: async (_id, update) => ({ ...baseAttempt, ...update }),
  }
  const service = createPublicPaymentService({
    repository,
    idFactory: () => attemptId,
    providerRegistry: { getNetworks: () => [mtnNetwork], get: () => ({
      initiateDeposit: async (input) => { calls.push(input); return { depositId: attemptId, status: 'ACCEPTED' } },
      getDepositStatus: async () => null,
    }) },
  })
  const result = await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].amount, '125.00')
  assert.equal(calls[0].depositId, attemptId)
  assert.equal(calls[0].customerMessage, 'EW petty cash')
  assert.equal(result.attempt.status, 'PENDING')
  assert.equal(result.attempt.receipt_available, false)
  assert.equal(JSON.stringify(result).includes('260763456789'), false)
})

test('startAttempt replays the same idempotency key without a second provider call', async () => {
  let calls = 0
  const service = createPublicPaymentService({
    repository: { createAttempt: async () => ({ attempt: { ...baseAttempt, state: 'UNKNOWN' }, replayed: true }) },
    idFactory: () => attemptId,
    providerRegistry: { getNetworks: () => [mtnNetwork], get: () => ({ initiateDeposit: async () => { calls++; return {} }, getDepositStatus: async () => null }) },
  })
  const result = await service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey)
  assert.equal(result.replayed, true)
  assert.equal(result.attempt.status, 'UNKNOWN')
  assert.equal(calls, 0)
})

test('verified provider success remains pending ITC credit when the finance client is unavailable', async () => {
  const updates = []
  const service = createPublicPaymentService({
    repository: {
      getPublicAttempt: async () => ({ ...baseAttempt, state: 'PENDING' }),
      updateAttempt: async (_id, update) => { updates.push(update); return { ...baseAttempt, ...update, updated_at: '2026-10-15T12:01:00.000Z' } },
    },
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => [{
      depositId: attemptId, status: 'COMPLETED', requestedAmount: '125.00', depositedAmount: '125.00', currency: 'ZMW', country: 'ZMB',
      payer: { type: 'MSISDN', address: { value: '260763456789' } }, correspondent: 'MTN_MOMO_ZMB', providerTransactionId: 'provider-ref-1',
    }] }) },
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
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => [{
      depositId: attemptId, status: 'COMPLETED', requestedAmount: '125.00', depositedAmount: '125.00', currency: 'ZMW', country: 'ZMB',
      payer: { type: 'MSISDN', address: { value: '260763456789' } }, correspondent: 'MTN_MOMO_ZMB', providerTransactionId: 'provider-ref-1',
    }] }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.receipt_available, true)
  assert.equal(calls[0].payload.collection_attempt_id, attemptId)
  assert.equal(calls[0].payload.revenue_account_code, '4000')
  assert.match(calls[0].key, /^ew-collect-[a-f0-9]{64}$/)
  assert.deepEqual(calls[1], { id: attemptId, operationId: succeeded.ledger_operation_id })
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
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => [{
      depositId: attemptId, status: 'COMPLETED', requestedAmount: '125.00', depositedAmount: '125.00', currency: 'ZMW', country: 'ZMB',
      payer: { type: 'MSISDN', address: { value: '260953456700' } }, correspondent: 'MTN_MOMO_ZMB',
    }] }) },
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

test('getLink advertises only networks enabled by the provider registry', async () => {
  const service = createPublicPaymentService({
    repository: { getPublicLink: async () => ({ payment_link_id: 'link-1', description: 'Invoice', amount: '125.00', currency: 'ZMW' }) },
    providerRegistry: { getNetworks: () => [mtnNetwork] },
  })
  assert.deepEqual(await service.getLink(token), {
    payment_link_id: 'link-1', description: 'Invoice', amount: '125.00', currency: 'ZMW',
    available_networks: [{ code: 'MTN_MOMO_ZMB', label: 'MTN MoMo' }],
  })
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
      createAttempt: async (input) => ({ link, attempt: { ...baseAttempt, ...input, payment_link_id: link.payment_link_id }, replayed: false }),
      updateAttempt: async (_id, update) => ({ ...baseAttempt, ...update }),
    },
    itcFinanceClient: { reserveCustomerReceivablePayment: async (payload, key) => {
      calls.push({ type: 'reserve', payload, key })
      return { reservation: { reservation_id: payload.reservation_id, state: 'ACTIVE' } }
    } },
    idFactory: () => attemptId,
    providerRegistry: { getNetworks: () => [mtnNetwork], get: () => ({
      initiateDeposit: async (input) => { calls.push({ type: 'provider', input }); return { depositId: attemptId, status: 'ACCEPTED' } },
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

test('A/R collection posts through ITC with its reservation and closes the attempt only after application', async () => {
  const calls = []
  const attempt = {
    ...baseAttempt, state: 'PENDING', payment_link_id: '40000000-0000-4000-8000-000000000001',
    created_by_customer_id: '70000000-0000-4000-8000-000000000001',
    collection_target_type: 'AR_SETTLEMENT', customer_id: '50000000-0000-4000-8000-000000000001',
    receivable_id: '60000000-0000-4000-8000-000000000001',
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
    providerRegistry: { get: () => ({ initiateDeposit: async () => null, getDepositStatus: async () => [{
      depositId: attemptId, status: 'COMPLETED', requestedAmount: '125.00', depositedAmount: '125.00', currency: 'ZMW', country: 'ZMB',
      payer: { type: 'MSISDN', address: { value: '260763456789' } }, correspondent: 'MTN_MOMO_ZMB', providerTransactionId: 'provider-ref-1',
    }] }) },
  })
  const result = await service.refreshAttempt(token, attemptId)
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.receipt_available, true)
  assert.equal(calls[0].payload.reservation_id, attemptId)
  assert.equal(calls[0].payload.receivable_id, attempt.receivable_id)
  assert.equal(calls[0].payload.amount, '125.00')
  assert.equal(calls[1].type, 'complete')
})

test('startAttempt rejects a network absent from provider capabilities before persistence', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { createAttempt: async () => { persisted = true } },
    providerRegistry: { getNetworks: () => [mtnNetwork], get: () => assert.fail('must not create a provider client') },
  })
  await assert.rejects(service.startAttempt(token, { network_code: 'ZAMTEL_ZMB', phone_number: '260953456789' }, idempotencyKey), { code: 'INVALID_PAYMENT_ATTEMPT' })
  assert.equal(persisted, false)
})

test('startAttempt fails closed when multiple providers advertise the same network', async () => {
  let persisted = false
  const service = createPublicPaymentService({
    repository: { createAttempt: async () => { persisted = true } },
    providerRegistry: { getNetworks: () => [mtnNetwork, { ...mtnNetwork, provider_code: 'another_provider' }] },
  })
  await assert.rejects(
    service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, idempotencyKey),
    { code: 'PAYMENT_NETWORK_ROUTE_AMBIGUOUS', statusCode: 503 },
  )
  assert.equal(persisted, false)
})
