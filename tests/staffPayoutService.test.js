const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createStaffPayoutService } = require('../src/payouts/staffPayoutService')
const { createStaffPayoutRepository } = require('../src/payouts/staffPayoutRepository')

const actor = { customerId: '10000000-0000-4000-8000-000000000001', role: 'admin', active: true }
const requestId = '20000000-0000-4000-8000-000000000002'
const payoutId = '30000000-0000-4000-8000-000000000003'
const holdId = '40000000-0000-4000-8000-000000000004'
const consumeOperationId = '50000000-0000-4000-8000-000000000005'
const attemptId = '60000000-0000-4000-8000-000000000006'
const providerTransactionId = 'provider-ref-123'
const destination = { network_code: 'ZAMTEL_ZMB', phone_number: '260953456700' }
const request = {
  request_id: requestId,
  requester_customer_id: '70000000-0000-4000-8000-000000000007',
  amount: '25.00',
  currency: 'ZMW',
  finance_hold_id: holdId,
  finance_reservation_state: 'RESERVED',
  finance_expense_category_code: 'office_supplies',
  payout: {
    payout_id: payoutId,
    payout_attempt_id: attemptId,
    consume_operation_id: consumeOperationId,
    state: 'SUBMITTING',
    amount: '25.00',
    currency: 'ZMW',
    network_code: 'ZAMTEL_ZMB',
    phone_number: destination.phone_number,
    client_reference_id: `EW-REQ-${requestId}`,
  },
}

function makeHarness({ prepared = {}, preparedSequence = [], initiation, status, consume, release, reserve } = {}) {
  const calls = []
  const repository = {
    prepareFinalApproval: async (input) => {
      calls.push(['prepareFinalApproval', input])
      return preparedSequence.length ? preparedSequence.shift() : { request, payout: request.payout, shouldInitiate: true, ...prepared }
    },
    completeAdminReservation: async (input) => { calls.push(['completeAdminReservation', input]); return request },
    setAdminReservationAccountingSnapshot: async (input) => { calls.push(['setAdminReservationAccountingSnapshot', input]); return request },
    markAdminReservationFailure: async (input) => { calls.push(['markAdminReservationFailure', input]); return request },
    preparePayoutReconciliation: async (input) => { calls.push(['preparePayoutReconciliation', input]); return { request, payout: request.payout } },
    revealPayoutDestination: async () => destination,
    recordInitiation: async (input) => { calls.push(['recordInitiation', input]); return request.payout },
    markPending: async (input) => { calls.push(['markPending', input]); return request.payout },
    markUnknown: async (input) => { calls.push(['markUnknown', input]); return request.payout },
    markVerificationRequired: async (input) => { calls.push(['markVerificationRequired', input]); return request.payout },
    completePayout: async (input) => { calls.push(['completePayout', input]); return { ...request, status: 'PAID' } },
    prepareRelease: async (input) => {
      calls.push(['prepareRelease', input])
      return { operation: { holdId, operationId: '80000000-0000-4000-8000-000000000008', idempotencyKey: `ewpr-${requestId}` } }
    },
    completeRelease: async (input) => { calls.push(['completeRelease', input]); return { ...request, status: 'PAYOUT_FAILED' } },
    markReleaseUnknown: async (input) => { calls.push(['markReleaseUnknown', input]); return request.payout },
  }
  const provider = {
    initiatePayout: async (input) => { calls.push(['initiatePayout', input]); return initiation ?? { payoutId, status: 'ACCEPTED' } },
    getPayoutStatus: async (id) => { calls.push(['getPayoutStatus', id]); return status ?? { status: 'NOT_FOUND' } },
  }
  const financeClient = {
    getExpenseCategories: async (...args) => { calls.push(['getExpenseCategories', ...args]); return [{ category_code: 'office_supplies', account_code: '6280' }] },
    reserve: async (...args) => { calls.push(['reserve', ...args]); return reserve ?? { operation: {
      operation_id: '90000000-0000-4000-8000-000000000009', request_id: requestId,
      hold_id: holdId, state: 'ACTIVE', amount: '25.00', currency: 'ZMW',
      expense_category_code: 'office_supplies', expense_account_code: '6280',
    } } },
    consume: async (...args) => { calls.push(['consume', ...args]); return consume ?? { operation: {
      operation_id: consumeOperationId, request_id: requestId, hold_id: holdId,
      state: 'CONSUMED', amount: '25.00', currency: 'ZMW',
      expense_category_code: 'office_supplies', payout_attempt_id: attemptId,
      provider_transaction_id: providerTransactionId,
    } } },
    release: async (...args) => { calls.push(['release', ...args]); return release ?? { operation: {
      operation_id: '80000000-0000-4000-8000-000000000008', request_id: requestId,
      hold_id: holdId, state: 'RELEASED',
    } } },
  }
  const service = createStaffPayoutService({
    repository,
    providerRegistry: { get: () => provider },
    financeClient,
    phoneVault: { decrypt: (value) => value },
    now: () => Date.parse('2026-10-15T10:00:00.000Z'),
  })
  return { service, calls }
}

function completedStatus(overrides = {}) {
  return { status: 'FOUND', data: {
    payoutId,
    status: 'COMPLETED',
    amount: '25.00',
    currency: 'ZMW',
    country: 'ZMB',
    recipient: { type: 'MMO', accountDetails: { phoneNumber: destination.phone_number, provider: destination.network_code } },
    clientReferenceId: `EW-REQ-${requestId}`,
    providerTransactionId,
    ...overrides,
  } }
}

test('final approval is admin-only and does not prepare a payout for staff', async () => {
  const { service, calls } = makeHarness()
  await assert.rejects(service.finalApprove({ ...actor, role: 'staff' }, requestId), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 0)
})

test('a prior admin rejection blocks final approval even if request status is stale', async () => {
  const statements = []
  const dbRequest = {
    request_id: requestId, requester_customer_id: request.requester_customer_id,
    reviewer_manager_customer_id: null, amount: '25.00', currency: 'ZMW', status: 'PENDING_ADMIN',
    finance_operation_id: null, finance_idempotency_key: null, finance_hold_id: holdId,
    finance_reservation_state: 'RESERVED', finance_error_code: null,
    finance_expense_category_code: 'office_supplies', finance_expense_account_code: '6280',
    payout_network_code: 'ZAMTEL_ZMB', payout_phone_last4: '6700', mapped_itc_expense_category_code: 'office_supplies',
  }
  const client = { query: async (sql) => {
    statements.push(sql)
    if (/SELECT request\.request_id/.test(sql)) return { rows: [dbRequest] }
    if (/SELECT payout_id, payout_attempt_id/.test(sql)) return { rows: [] }
    if (/FROM request_decisions/.test(sql)) return { rows: [{ action: 'reject' }] }
    return { rows: [], rowCount: 0 }
  }, release() {} }
  const repository = createStaffPayoutRepository({ pool: { query: client.query, connect: async () => client } })
  await assert.rejects(repository.prepareFinalApproval({ actor, requestId }), { code: 'DECISION_NOT_ALLOWED' })
  assert.equal(statements.some((sql) => /INSERT INTO request_payout_attempts/.test(sql)), false)
})

test('a confirmed matching PawaPay payout consumes its exact ITC hold before reporting paid', async () => {
  const { service, calls } = makeHarness({ status: completedStatus() })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.request.status, 'PAID')
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 1)
  assert.equal(calls.filter(([name]) => name === 'consume').length, 1)
  const consumeCall = calls.find(([name]) => name === 'consume')
  assert.equal(consumeCall[1], holdId)
  assert.equal(consumeCall[2].provider_transaction_id, providerTransactionId)
  assert.equal(consumeCall[2].expense_category_code, 'office_supplies')
  assert.equal(consumeCall[3], `ew-consume-${crypto.createHash('sha256').update(providerTransactionId).digest('hex')}`)
})

test('a payout with mismatched destination or amount is held for reconciliation and never consumed', async () => {
  const { service, calls } = makeHarness({ status: completedStatus({ amount: '24.00' }) })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.some(([name]) => name === 'markVerificationRequired'), true)
  assert.equal(calls.some(([name]) => name === 'consume'), false)
  assert.equal(calls.some(([name]) => name === 'release'), false)
})

test('an accepted but non-terminal payout remains pending and does not consume or release the hold', async () => {
  const { service, calls } = makeHarness({ status: { status: 'FOUND', data: { ...completedStatus().data, status: 'PROCESSING' } } })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.some(([name]) => name === 'markPending'), true)
  assert.equal(calls.some(([name]) => name === 'consume' || name === 'release'), false)
})

test('reconciling a known pending payout only checks status and never submits a replacement payout', async () => {
  const { service, calls } = makeHarness({ prepared: { shouldInitiate: false },
    status: { status: 'FOUND', data: { ...completedStatus().data, status: 'PROCESSING' } } })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 0)
  assert.equal(calls.filter(([name]) => name === 'getPayoutStatus').length, 1)
})

test('recovery after an unknown pre-acceptance result reuses the same PawaPay payout ID', async () => {
  const unknownPayout = { ...request.payout, state: 'UNKNOWN' }
  const { service, calls } = makeHarness({
    prepared: { payout: unknownPayout, shouldInitiate: false },
    status: { status: 'NOT_FOUND' },
    initiation: { payoutId, status: 'DUPLICATE_IGNORED' },
  })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  const initiation = calls.find(([name]) => name === 'initiatePayout')
  assert.equal(initiation[1].payoutId, payoutId)
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 1)
})

test('a definitive PawaPay failure releases the reserved ITC hold before marking the payout failed', async () => {
  const { service, calls } = makeHarness({ status: { status: 'FOUND', data: { ...completedStatus().data, status: 'FAILED' } } })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.request.status, 'PAYOUT_FAILED')
  assert.equal(calls.some(([name]) => name === 'release'), true)
  assert.equal(calls.some(([name]) => name === 'completeRelease'), true)
  assert.equal(calls.some(([name]) => name === 'consume'), false)
})

test('a failed payout with mismatched destination is quarantined and does not release the hold', async () => {
  const { service, calls } = makeHarness({ status: completedStatus({ status: 'FAILED', recipient: { type: 'MMO', accountDetails: { phoneNumber: '260950000000', provider: destination.network_code } } }) })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.some(([name]) => name === 'markVerificationRequired'), true)
  assert.equal(calls.some(([name]) => name === 'release'), false)
})

test('bulk approval is admin-only and processes each request independently', async () => {
  const { service, calls } = makeHarness()
  await assert.rejects(service.bulkFinalApprove({ ...actor, role: 'staff' }, [requestId]), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 0)
})

test('admin final approval reserves funds itself for a staff request without a manager before paying', async () => {
  const unreserved = { ...request, status: 'PENDING_ADMIN', reviewer_manager_customer_id: null, finance_hold_id: null,
    finance_reservation_state: null, finance_expense_category_code: 'office_supplies', finance_expense_account_code: null }
  const { service, calls } = makeHarness({ preparedSequence: [
    { request: unreserved, requiresReservation: true, reservation: {
      operationId: '90000000-0000-4000-8000-000000000009', idempotencyKey: `ewmr-${requestId}`,
      expenseCategoryCode: 'office_supplies', expenseAccountCode: null, amount: '25.00', currency: 'ZMW',
      requesterCustomerId: request.requester_customer_id,
    } },
    { request, payout: request.payout, shouldInitiate: true },
  ], status: completedStatus() })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.request.status, 'PAID')
  assert.equal(calls.filter(([name]) => name === 'reserve').length, 1)
  assert.equal(calls.filter(([name]) => name === 'getExpenseCategories').length, 1)
  assert.equal(calls.filter(([name]) => name === 'setAdminReservationAccountingSnapshot').length, 1)
  assert.equal(calls.filter(([name]) => name === 'completeAdminReservation').length, 1)
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 1)
})
