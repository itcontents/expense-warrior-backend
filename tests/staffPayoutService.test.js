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
const providerAccountId = '90000000-0000-4000-8000-000000000009'
const providerAccountVersion = 2
const providerTransactionId = 'provider-ref-123'
const destination = { provider_code: 'pawapay', network_code: 'ZAMTEL_ZMB', phone_number: '260953456700' }
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
    request_id: requestId,
    reservation_hold_id: holdId,
    reservation_state: 'RESERVED',
    provider_code: 'pawapay',
    provider_account_id: providerAccountId,
    provider_account_version: providerAccountVersion,
    amount: '25.00',
    currency: 'ZMW',
    network_code: 'ZAMTEL_ZMB',
    phone_number: destination.phone_number,
    client_reference_id: `EW-REQ-${requestId}`,
  },
}

function makeHarness({ prepared = {}, preparedSequence = [], initiation, status, consume, release, reserve,
  providerRegistry = null, payoutDestination = destination } = {}) {
  const calls = []
  const repository = {
    preparePayoutRetry: async () => assert.fail('unexpected retry'),
    completeRetryReservation: async () => assert.fail('unexpected retry completion'),
    markRetryReservationFailure: async () => assert.fail('unexpected retry failure'),
    prepareFinalApproval: async (input) => {
      calls.push(['prepareFinalApproval', input])
      return preparedSequence.length ? preparedSequence.shift() : { request, payout: request.payout, shouldInitiate: true, ...prepared }
    },
    completeAdminReservation: async (input) => { calls.push(['completeAdminReservation', input]); return request },
    setAdminReservationAccountingSnapshot: async (input) => { calls.push(['setAdminReservationAccountingSnapshot', input]); return request },
    markAdminReservationFailure: async (input) => { calls.push(['markAdminReservationFailure', input]); return request },
    preparePayoutReconciliation: async (input) => { calls.push(['preparePayoutReconciliation', input]); return { request, payout: request.payout } },
    revealPayoutDestination: async () => payoutDestination,
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
    initiatePayout: async (input) => { calls.push(['initiatePayout', input]); return initiation ?? { transaction_id: payoutId, outcome: 'ACCEPTED', provider_status: 'ACCEPTED' } },
    getPayoutStatus: async (id) => { calls.push(['getPayoutStatus', id]); return status ?? { transaction_id: payoutId, outcome: 'NOT_FOUND', provider_status: 'NOT_FOUND' } },
  }
  const financeClient = {
    getExpenseCategories: async (...args) => { calls.push(['getExpenseCategories', ...args]); return [{ category_code: 'office_supplies', account_code: '6280' }] },
    reserve: async (...args) => { calls.push(['reserve', ...args]); return reserve ?? { operation: {
      operation_id: '90000000-0000-4000-8000-000000000009', request_id: requestId,
      hold_id: holdId, state: 'ACTIVE', amount: '25.00', currency: 'ZMW',
      expense_category_code: 'office_supplies', expense_account_code: '6280',
      provider_code: 'pawapay', provider_account_id: providerAccountId,
      provider_account_version: providerAccountVersion,
    } } },
    consume: async (...args) => { calls.push(['consume', ...args]); return consume ?? { operation: {
      operation_id: consumeOperationId, request_id: requestId, hold_id: holdId,
      state: 'CONSUMED', amount: '25.00', currency: 'ZMW',
      expense_category_code: 'office_supplies', payout_attempt_id: attemptId,
      provider_transaction_id: providerTransactionId,
      provider_code: 'pawapay', provider_account_id: providerAccountId,
      provider_account_version: providerAccountVersion,
    } } },
    release: async (...args) => { calls.push(['release', ...args]); return release ?? { operation: {
      operation_id: '80000000-0000-4000-8000-000000000008', request_id: requestId,
      hold_id: holdId, provider_code: 'pawapay', provider_account_id: providerAccountId,
      provider_account_version: providerAccountVersion, state: 'RELEASED',
    } } },
  }
  const service = createStaffPayoutService({
    repository,
    providerRegistry: providerRegistry || {
      get: () => provider,
      getForOperation: () => provider,
      getNetworks: (providerCode) => [{ provider_code: providerCode, code: 'ZAMTEL_ZMB', label: 'Zamtel' }],
      getAccountIdentity: () => ({ provider_account_id: providerAccountId, provider_account_version: providerAccountVersion }),
    },
    financeClient,
    phoneVault: { decrypt: (value) => value },
    now: () => Date.parse('2026-10-15T10:00:00.000Z'),
  })
  return { service, calls, repository, provider, financeClient }
}

function completedStatus(overrides = {}) {
  const status = overrides.status || 'COMPLETED'
  const outcome = ({ COMPLETED: 'SUCCEEDED', FAILED: 'FAILED', CANCELED: 'CANCELLED', PROCESSING: 'PENDING' })[status] || 'UNKNOWN'
  return {
    transaction_id: payoutId, outcome, provider_status: status,
    evidence: {
      amount: overrides.amount || '25.00', currency: 'ZMW', country: 'ZMB',
      phone_number: overrides.phone || destination.phone_number,
      network_code: destination.network_code, client_reference: `EW-REQ-${requestId}`,
      provider_transaction_id: providerTransactionId,
    },
  }
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

test('final approval and reconciliation select the snapshotted add-on and account version', async () => {
  const addonAccountId = '91000000-0000-4000-8000-000000000010'
  const addonAccountVersion = 3
  const addonDestination = {
    provider_code: 'airtel_direct', network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783',
  }
  const addonPayout = {
    ...request.payout,
    provider_code: 'airtel_direct',
    provider_account_id: addonAccountId,
    provider_account_version: addonAccountVersion,
    network_code: addonDestination.network_code,
  }
  const addonRequest = { ...request, payout: addonPayout }
  const adapterSelections = []
  const initiationCalls = []
  const addonAdapter = {
    initiatePayout: async (input) => {
      initiationCalls.push(input)
      return { transaction_id: payoutId, outcome: 'ACCEPTED', provider_status: 'ACCEPTED' }
    },
    getPayoutStatus: async () => null,
  }
  const { service } = makeHarness({
    prepared: { request: addonRequest, payout: addonPayout, shouldInitiate: true },
    payoutDestination: addonDestination,
    providerRegistry: {
      get: () => addonAdapter,
      getNetworks: () => [{ code: addonDestination.network_code, label: 'Airtel Money' }],
      getAccountIdentity: () => ({ provider_account_id: addonAccountId, provider_account_version: addonAccountVersion }),
      getForOperation: (...selection) => {
        adapterSelections.push(selection)
        return addonAdapter
      },
    },
  })

  const result = await service.finalApprove(actor, requestId)

  assert.equal(result.pending, true)
  const expectedSelection = [
    'airtel_direct', 'payout',
    { provider_account_id: addonAccountId, provider_account_version: addonAccountVersion },
  ]
  assert.deepEqual(adapterSelections, [expectedSelection, expectedSelection])
  assert.equal(initiationCalls.length, 1)
  assert.equal(initiationCalls[0].network_code, 'AIRTEL_OAPI_ZMB')
  assert.equal(initiationCalls[0].phone_number, '260957909783')
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
  const { service, calls } = makeHarness({ status: completedStatus({ status: 'PROCESSING' }) })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.some(([name]) => name === 'markPending'), true)
  assert.equal(calls.some(([name]) => name === 'consume' || name === 'release'), false)
})

test('reconciling a known pending payout only checks status and never submits a replacement payout', async () => {
  const { service, calls } = makeHarness({ prepared: { shouldInitiate: false },
    status: completedStatus({ status: 'PROCESSING' }) })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 0)
  assert.equal(calls.filter(([name]) => name === 'getPayoutStatus').length, 1)
})

test('recovery after an unknown pre-acceptance result reuses the same PawaPay payout ID', async () => {
  const unknownPayout = { ...request.payout, state: 'UNKNOWN' }
  const { service, calls } = makeHarness({
    prepared: { payout: unknownPayout, shouldInitiate: false },
    status: { transaction_id: payoutId, outcome: 'NOT_FOUND', provider_status: 'NOT_FOUND' },
    initiation: { transaction_id: payoutId, outcome: 'DUPLICATE', provider_status: 'DUPLICATE_IGNORED' },
  })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.pending, true)
  const initiation = calls.find(([name]) => name === 'initiatePayout')
  assert.equal(initiation[1].transaction_id, payoutId)
  assert.equal(calls.filter(([name]) => name === 'initiatePayout').length, 1)
})

test('a rejected payout records a validated provider failure code in the hold release operation', async () => {
  const { service, calls } = makeHarness({ initiation: {
    transaction_id: payoutId, outcome: 'REJECTED', provider_status: 'REJECTED', rejection_code: 'INSUFFICIENT_BALANCE',
  } })

  const result = await service.finalApprove(actor, requestId)

  assert.equal(result.request.status, 'PAYOUT_FAILED')
  assert.equal(calls.find(([name]) => name === 'prepareRelease')[1].reasonCode, 'PAWAPAY_INSUFFICIENT_BALANCE')
  assert.equal(calls.find(([name]) => name === 'recordInitiation')[1].errorCode, 'PAWAPAY_INSUFFICIENT_BALANCE')
})

test('a malformed provider failure code falls back to a fixed safe rejection code', async () => {
  const { service, calls } = makeHarness({ initiation: {
    transaction_id: payoutId, outcome: 'REJECTED', provider_status: 'REJECTED', rejection_code: 'BAD CODE; SECRET',
  } })

  await service.finalApprove(actor, requestId)

  assert.equal(calls.find(([name]) => name === 'prepareRelease')[1].reasonCode, 'PROVIDER_REJECTED')
  assert.equal(calls.find(([name]) => name === 'recordInitiation')[1].errorCode, 'PROVIDER_REJECTED')
})

test('a definitive PawaPay failure releases the reserved ITC hold before marking the payout failed', async () => {
  const { service, calls } = makeHarness({ status: completedStatus({ status: 'FAILED' }) })
  const result = await service.finalApprove(actor, requestId)
  assert.equal(result.request.status, 'PAYOUT_FAILED')
  assert.equal(calls.some(([name]) => name === 'release'), true)
  assert.equal(calls.some(([name]) => name === 'completeRelease'), true)
  assert.equal(calls.some(([name]) => name === 'consume'), false)
})

test('a failed payout with mismatched destination is quarantined and does not release the hold', async () => {
  const { service, calls } = makeHarness({ status: completedStatus({ status: 'FAILED', phone: '260950000000' }) })
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
      providerCode: 'pawapay', providerAccountId, providerAccountVersion,
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


const retryPayoutId = '31000000-0000-4000-8000-000000000003'
const retryHoldId = '41000000-0000-4000-8000-000000000004'
const retryOperationId = '51000000-0000-4000-8000-000000000005'
function retryHarness({ reserveError, reservePatch = {}, completionWinner = true } = {}) {
  const h = makeHarness()
  const retryRequest = { ...request, status: 'PAYOUT_PENDING', finance_hold_id: null,
    finance_expense_account_code: '6280', finance_reservation_state: 'PENDING' }
  const payout = { ...request.payout, payout_id: retryPayoutId, state: 'RESERVING',
    reservation_operation_id: retryOperationId, reservation_idempotency_key: 'ewmr-persisted-retry',
    reservation_hold_id: null, reservation_state: 'PENDING', client_reference_id: 'EW-PAY-persisted-retry' }
  const reservation = { operationId: retryOperationId, idempotencyKey: 'ewmr-persisted-retry',
    expenseCategoryCode: 'office_supplies', expenseAccountCode: '6280', amount: '25.00', currency: 'ZMW',
    requesterCustomerId: request.requester_customer_id, providerCode: 'pawapay', providerAccountId, providerAccountVersion }
  h.repository.preparePayoutRetry = async (input) => {
    h.calls.push(['preparePayoutRetry', input])
    return { request: retryRequest, payout, reservation, reservationActorCustomerId: actor.customerId, requiresReservation: true, shouldInitiate: false }
  }
  let claimed = false
  h.repository.completeRetryReservation = async (input) => {
    h.calls.push(['completeRetryReservation', input])
    const shouldInitiate = !claimed && completionWinner
    claimed = true
    return { request: { ...retryRequest, finance_hold_id: retryHoldId, finance_reservation_state: 'RESERVED' },
      payout: { ...payout, state: 'SUBMITTING', reservation_hold_id: retryHoldId, reservation_state: 'RESERVED' }, shouldInitiate }
  }
  h.repository.markRetryReservationFailure = async (input) => {
    h.calls.push(['markRetryReservationFailure', input])
    return { request: { ...retryRequest, status: input.state === 'FAILED' ? 'PAYOUT_FAILED' : 'PAYOUT_PENDING' } }
  }
  h.financeClient.reserve = async (...args) => {
    h.calls.push(['reserve', ...args])
    if (reserveError) throw reserveError
    return { operation: { operation_id: retryOperationId, request_id: requestId, hold_id: retryHoldId,
      state: 'ACTIVE', amount: '25.00', currency: 'ZMW', expense_category_code: 'office_supplies',
      expense_account_code: '6280', provider_code: 'pawapay', provider_account_id: providerAccountId,
      provider_account_version: providerAccountVersion, ...reservePatch } }
  }
  h.provider.initiatePayout = async (input) => {
    h.calls.push(['initiatePayout', input])
    return { transaction_id: input.transaction_id, outcome: 'ACCEPTED' }
  }
  h.provider.getPayoutStatus = async (id) => {
    h.calls.push(['getPayoutStatus', id])
    return { transaction_id: id, outcome: 'PENDING' }
  }
  h.payout = payout
  h.reservation = reservation
  return h
}

test('retry requires an active admin and a valid request ID before repository access', async () => {
  const { service, calls } = retryHarness()
  for (const [candidate, id, code] of [
    [{ ...actor, role: 'staff' }, requestId, 'FORBIDDEN'],
    [{ ...actor, active: false }, requestId, 'AUTHENTICATION_REQUIRED'],
    [actor, 'bad', 'INVALID_REQUEST'],
  ]) await assert.rejects(service.retry(candidate, id), { code })
  assert.equal(calls.length, 0)
})

test('retry forwards admin identity and propagates locked eligibility and self-review rejections without financial calls', async () => {
  for (const code of ['SELF_REVIEW_PROHIBITED', 'PAYOUT_RETRY_NOT_ALLOWED']) {
    const h = retryHarness()
    h.repository.preparePayoutRetry = async (input) => {
      assert.deepEqual(input, { actor: { customerId: actor.customerId, role: 'admin' }, requestId, requestIdForAudit: 'audit' })
      throw Object.assign(new Error(code), { code, statusCode: 409 })
    }
    await assert.rejects(h.service.retry(actor, requestId, 'audit'), { code })
    assert.equal(h.calls.length, 0)
  }
})

test('retry reserves the persisted operation and saved account before submitting the new payout ID without another approval', async () => {
  const h = retryHarness()
  const result = await h.service.retry(actor, requestId, 'audit')
  assert.equal(result.pending, true)
  const reserve = h.calls.find(([name]) => name === 'reserve')
  assert.deepEqual(reserve.slice(1), [{ operation_id: retryOperationId, request_id: requestId,
    requester_customer_id: request.requester_customer_id, actor_customer_id: actor.customerId,
    amount: '25.00', currency: 'ZMW', expense_category_code: 'office_supplies', provider_code: 'pawapay',
    provider_account_id: providerAccountId, provider_account_version: 2, purpose: `Expense request ${requestId}` },
    'ewmr-persisted-retry', 'audit'])
  assert.equal(h.calls.find(([name]) => name === 'initiatePayout')[1].transaction_id, retryPayoutId)
  assert.ok(h.calls.findIndex(([name]) => name === 'completeRetryReservation') < h.calls.findIndex(([name]) => name === 'initiatePayout'))
  assert.equal(h.calls.some(([name]) => /FinalApproval|AdminReservation|getExpenseCategories/.test(name)), false)
})

for (const [field, value] of Object.entries({ operation_id: consumeOperationId, request_id: payoutId,
  hold_id: 'bad', state: 'RELEASED', amount: '24.00', currency: 'USD', expense_category_code: 'travel',
  expense_account_code: '9999', provider_code: 'other', provider_account_id: payoutId, provider_account_version: 3 })) {
  test(`retry quarantines a reservation with mismatched ${field} without contacting provider`, async () => {
    const h = retryHarness({ reservePatch: { [field]: value } })
    const result = await h.service.retry(actor, requestId)
    assert.equal(result.pending, true)
    assert.equal(result.errorCode, 'ITC_FINANCE_RESPONSE_INVALID')
    assert.equal(h.calls.find(([name]) => name === 'markRetryReservationFailure')[1].state, 'UNKNOWN')
    assert.equal(h.calls.some(([name]) => ['initiatePayout', 'getPayoutStatus', 'completeRetryReservation'].includes(name)), false)
  })
}

test('unknown reservation result replays exactly the persisted attempt, operation and key', async () => {
  const h = retryHarness({ reserveError: Object.assign(new Error('private text'), { code: 'ITC_FINANCE_UNAVAILABLE' }) })
  for (let i = 0; i < 2; i++) {
    const result = await h.service.retry(actor, requestId)
    assert.equal(result.pending, true)
    assert.equal(result.errorCode, 'ITC_FINANCE_UNAVAILABLE')
  }
  const reserves = h.calls.filter(([name]) => name === 'reserve')
  assert.deepEqual(reserves[0], reserves[1])
  const failures = h.calls.filter(([name]) => name === 'markRetryReservationFailure')
  assert.ok(failures.every(([, input]) => input.payoutId === retryPayoutId && input.operationId === retryOperationId && input.state === 'UNKNOWN'))
  assert.equal(h.calls.some(([name]) => /PayoutStatus|initiatePayout/.test(name)), false)
})

test('definitive reservation rejection records a terminal reservation failure with no provider operation', async () => {
  const h = retryHarness({ reserveError: Object.assign(new Error('private text'), { code: 'INSUFFICIENT_FUNDS' }) })
  const result = await h.service.retry(actor, requestId)
  assert.equal(result.pending, false)
  assert.equal(result.request.status, 'PAYOUT_FAILED')
  assert.equal(result.errorCode, 'INSUFFICIENT_FUNDS')
  assert.equal(h.calls.find(([name]) => name === 'markRetryReservationFailure')[1].state, 'FAILED')
  assert.equal(h.calls.some(([name]) => ['initiatePayout', 'getPayoutStatus', 'recordInitiation'].includes(name)), false)
})

test('concurrent reservation completions submit only the repository winner', async () => {
  const h = retryHarness()
  await Promise.all([h.service.retry(actor, requestId), h.service.retry(actor, requestId)])
  assert.equal(h.calls.filter(([name]) => name === 'initiatePayout').length, 1)
  assert.equal(h.calls.filter(([name]) => name === 'getPayoutStatus').length, 1)
})

test('a reservation completion loser returns pending without initiating or reconciling', async () => {
  const h = retryHarness({ completionWinner: false })
  assert.equal((await h.service.retry(actor, requestId)).pending, true)
  assert.equal(h.calls.some(([name]) => ['initiatePayout', 'getPayoutStatus'].includes(name)), false)
})

test('retry fails closed when the saved account version is unavailable', async () => {
  const h = retryHarness()
  // A current-account fallback must never run a retry with changed credentials.
  h.provider.initiatePayout = async () => assert.fail('provider must not be called')
  const strict = createStaffPayoutService({ repository: h.repository, financeClient: h.financeClient,
    phoneVault: { decrypt() {} }, providerRegistry: { get: () => h.provider, getForOperation: () => { throw Error('unavailable') } } })
  await assert.rejects(strict.retry(actor, requestId), { code: 'PROVIDER_ACCOUNT_MAPPING_UNAVAILABLE' })
  assert.equal(h.calls.some(([name]) => name === 'reserve'), false)
})

test('retry selects the persisted account version without consulting the current account', async () => {
  const h = retryHarness()
  const selected = []
  const strict = createStaffPayoutService({ repository: h.repository, financeClient: h.financeClient,
    phoneVault: { decrypt() {} }, providerRegistry: { get: () => h.provider,
      getNetworks: () => [{ code: 'ZAMTEL_ZMB' }], getAccountIdentity: () => assert.fail('current account lookup'),
      getForOperation: (...args) => { selected.push(args); return h.provider } } })
  await strict.retry(actor, requestId)
  assert.ok(selected.length > 0)
  assert.ok(selected.every((args) => args[0] === 'pawapay' && args[2].provider_account_id === providerAccountId && args[2].provider_account_version === 2))
})

for (const state of ['RESERVING', 'RESERVATION_FAILED']) {
  test(`reconcile never sends reservation-only ${state} attempts to the provider`, async () => {
    const h = makeHarness()
    h.repository.preparePayoutReconciliation = async () => ({ request, payout: { ...request.payout, state, reservation_hold_id: null } })
    const result = await h.service.reconcile(actor, requestId)
    assert.equal(result.pending, state === 'RESERVING')
    assert.equal(h.calls.length, 0)
  })
}

test('consumption uses and validates the selected attempt hold despite a different request hold', async () => {
  const h = makeHarness({ status: completedStatus() })
  h.repository.preparePayoutReconciliation = async () => ({ request: { ...request, finance_hold_id: retryHoldId }, payout: request.payout })
  assert.equal((await h.service.reconcile(actor, requestId)).request.status, 'PAID')
  assert.equal(h.calls.find(([name]) => name === 'consume')[1], holdId)
})

test('release fails closed if the repository release operation targets a different attempt hold', async () => {
  const h = makeHarness({ status: completedStatus({ status: 'FAILED' }) })
  h.repository.prepareRelease = async () => ({ operation: { holdId: retryHoldId, operationId: consumeOperationId, idempotencyKey: 'ew-release' } })
  const result = await h.service.reconcile(actor, requestId)
  assert.equal(result.pending, true)
  assert.equal(h.calls.some(([name]) => name === 'release'), false)
})

test('retry requires an explicit boolean submission claim', async () => {
  const h = retryHarness()
  h.repository.completeRetryReservation = async () => ({ request, payout: request.payout, shouldInitiate: 'true' })
  await h.service.retry(actor, requestId)
  assert.equal(h.calls.some(([name]) => name === 'initiatePayout'), false)
})

test('retry treats rejected reused-hold completion as unresolved without a provider operation', async () => {
  const h = retryHarness()
  h.repository.completeRetryReservation = async () => { throw Object.assign(Error('old hold already used'), { code: 'FINANCE_RESERVATION_MISMATCH' }) }
  assert.equal((await h.service.retry(actor, requestId)).pending, true)
  assert.equal(h.calls.some(([name]) => ['initiatePayout', 'getPayoutStatus'].includes(name)), false)
})

test('retry returns a fixed recovery error when recording an unknown reservation fails', async () => {
  const h = retryHarness({ reserveError: Error('secret provider text') })
  h.repository.markRetryReservationFailure = async () => { throw Error('private database details') }
  await assert.rejects(h.service.retry(actor, requestId), { code: 'PAYOUT_RECONCILIATION_REQUIRED' })
  assert.equal(h.calls.some(([name]) => name === 'initiatePayout'), false)
})

test('retry completes payment against its own new hold and persists the new payout identity', async () => {
  const h = retryHarness()
  h.provider.getPayoutStatus = async (id) => ({ ...completedStatus(), transaction_id: id,
    evidence: { ...completedStatus().evidence, client_reference: 'EW-PAY-persisted-retry' } })
  h.financeClient.consume = async (...args) => {
    h.calls.push(['consume', ...args])
    return { operation: { operation_id: consumeOperationId, request_id: requestId, hold_id: retryHoldId,
      state: 'CONSUMED', amount: '25.00', currency: 'ZMW', expense_category_code: 'office_supplies',
      payout_attempt_id: attemptId, provider_transaction_id: providerTransactionId, provider_code: 'pawapay',
      provider_account_id: providerAccountId, provider_account_version: 2 } }
  }
  assert.equal((await h.service.retry(actor, requestId)).request.status, 'PAID')
  assert.equal(h.calls.find(([name]) => name === 'consume')[1], retryHoldId)
  assert.equal(h.calls.find(([name]) => name === 'completePayout')[1].payoutId, retryPayoutId)
})

test('retry provider rejection releases only its own new hold and records a safe provider code', async () => {
  const h = retryHarness()
  h.provider.initiatePayout = async (input) => ({ transaction_id: input.transaction_id, outcome: 'REJECTED',
    rejection_code: 'BAD CODE private details', message: 'provider confidential text' })
  h.repository.prepareRelease = async (input) => {
    h.calls.push(['prepareRelease', input])
    return { operation: { holdId: retryHoldId, operationId: consumeOperationId, idempotencyKey: 'retry-release-key' } }
  }
  h.financeClient.release = async (...args) => {
    h.calls.push(['release', ...args])
    return { operation: { operation_id: consumeOperationId, request_id: requestId, hold_id: retryHoldId,
      provider_code: 'pawapay', provider_account_id: providerAccountId, provider_account_version: 2, state: 'RELEASED' } }
  }
  const result = await h.service.retry(actor, requestId)
  assert.equal(result.request.status, 'PAYOUT_FAILED')
  assert.equal(h.calls.find(([name]) => name === 'release')[1], retryHoldId)
  assert.equal(h.calls.find(([name]) => name === 'prepareRelease')[1].payoutId, retryPayoutId)
  assert.equal(h.calls.find(([name]) => name === 'recordInitiation')[1].errorCode, 'PROVIDER_REJECTED')
  assert.equal(JSON.stringify(result).includes('private'), false)
})

for (const [state, releaseState, requestState] of [
  ['SUBMITTING', null, 'PAYOUT_PENDING'], ['PENDING', null, 'PAYOUT_PENDING'], ['UNKNOWN', null, 'PAYOUT_PENDING'],
  ['VERIFICATION_REQUIRED', null, 'PAYOUT_PENDING'], ['FAILED_PENDING_RELEASE', 'UNKNOWN', 'PAYOUT_PENDING'],
  ['PAID', null, 'PAID'], ['FAILED', 'UNKNOWN', 'PAYOUT_FAILED'], ['FAILED', 'PENDING', 'PAYOUT_FAILED'],
]) {
  test(`retry service cannot reserve or submit when locked latest state is ${state}/${releaseState}`, async () => {
    const h = makeHarness()
    const client = { release() {}, async query(sql) {
      if (sql.includes('SELECT request.request_id')) return { rows: [{ ...request, status: requestState }] }
      if (sql.includes('FROM request_payout_attempts')) return { rows: [{ ...request.payout, state, release_state: releaseState }] }
      if (/INSERT|UPDATE/.test(sql)) assert.fail('ineligible retry mutated persistence')
      return { rows: [] }
    } }
    const real = createStaffPayoutRepository({ pool: { query: client.query, connect: async () => client } })
    h.repository.preparePayoutRetry = real.preparePayoutRetry
    await assert.rejects(h.service.retry(actor, requestId), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    assert.equal(h.calls.length, 0)
  })
}

test('retry service cannot self-review through the locked repository authorization', async () => {
  const h = makeHarness()
  const client = { release() {}, async query(sql) {
    if (sql.includes('SELECT request.request_id')) return { rows: [{ ...request, requester_customer_id: actor.customerId }] }
    if (/INSERT|UPDATE/.test(sql)) assert.fail('self-review mutated persistence')
    return { rows: [] }
  } }
  h.repository.preparePayoutRetry = createStaffPayoutRepository({ pool: { query: client.query, connect: async () => client } }).preparePayoutRetry
  await assert.rejects(h.service.retry(actor, requestId), { code: 'SELF_REVIEW_PROHIBITED' })
  assert.equal(h.calls.length, 0)
})


for (const [name, changeActor, changeCase] of [['different admin', true, false], ['different UUID casing', false, true], ['different admin and UUID casing', true, true]]) {
  test(`unknown retry reservation resolves its exact ITC fingerprint with ${name}`, async () => {
    const canonicalId = 'abcdef01-0000-4000-8000-000000000002'
    const h = retryHarness({ reservePatch: { request_id: canonicalId } })
    const basePrepare = h.repository.preparePayoutRetry
    h.repository.preparePayoutRetry = async (input) => {
      const prepared = await basePrepare(input)
      return { ...prepared, request: { ...prepared.request, request_id: canonicalId },
        payout: { ...prepared.payout, request_id: canonicalId } }
    }
    const baseComplete = h.repository.completeRetryReservation
    h.repository.completeRetryReservation = async (input) => {
      const completed = await baseComplete(input)
      return { ...completed, request: { ...completed.request, request_id: canonicalId } }
    }
    let committedPayload
    const baseReserve = h.financeClient.reserve
    h.financeClient.reserve = async (...args) => {
      const result = await baseReserve(...args)
      if (!committedPayload) {
        committedPayload = structuredClone(args[0])
        throw Object.assign(Error('response lost after ITC committed'), { code: 'ITC_FINANCE_UNAVAILABLE' })
      }
      // Model ITC fingerprint enforcement, including actor and purpose.
      if (JSON.stringify(args[0]) !== JSON.stringify(committedPayload)) {
        throw Object.assign(Error('fingerprint differs'), { code: 'IDEMPOTENCY_CONFLICT' })
      }
      return result
    }
    const first = await h.service.retry(actor, canonicalId)
    assert.equal(first.errorCode, 'ITC_FINANCE_UNAVAILABLE')
    const resumingAdmin = changeActor ? { ...actor, customerId: '11000000-0000-4000-8000-000000000001' } : actor
    const resumed = await h.service.retry(resumingAdmin, changeCase ? canonicalId.toUpperCase() : canonicalId)
    assert.equal(resumed.errorCode, undefined)
    assert.equal(h.calls.filter(([name]) => name === 'initiatePayout').length, 1)
    const reserves = h.calls.filter(([name]) => name === 'reserve')
    assert.deepEqual(reserves[1].slice(1), reserves[0].slice(1))
    assert.equal(reserves[1][1].actor_customer_id, actor.customerId)
    assert.equal(reserves[1][1].request_id, canonicalId)
    assert.equal(reserves[1][1].purpose, `Expense request ${canonicalId}`)
    assert.equal(h.calls.find(([name]) => name === 'completeRetryReservation')[1].actor.customerId, resumingAdmin.customerId)
  })
}

test('retry fails closed without a valid persisted reservation actor', async () => {
  for (const origin of [undefined, null, 'bad']) {
    const h = retryHarness()
    const base = h.repository.preparePayoutRetry
    h.repository.preparePayoutRetry = async (input) => ({ ...await base(input), reservationActorCustomerId: origin })
    await assert.rejects(h.service.retry(actor, requestId), { code: 'PAYOUT_RETRY_PREPARATION_INVALID' })
    assert.equal(h.calls.some(([name]) => name === 'reserve'), false)
  }
})
