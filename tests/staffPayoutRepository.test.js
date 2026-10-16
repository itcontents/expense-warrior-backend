const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createStaffPayoutRepository } = require('../src/payouts/staffPayoutRepository')

const actor = { role: 'admin', customerId: randomUUID() }
const requestId = randomUUID()
const request = {
  request_id: requestId, requester_customer_id: randomUUID(), status: 'PAYOUT_FAILED',
  amount: '185.25', currency: 'ZMW', finance_reservation_state: 'RELEASED',
  finance_operation_id: randomUUID(), finance_idempotency_key: 'original-reservation', finance_hold_id: randomUUID(),
  finance_expense_category_code: 'office_supplies', finance_expense_account_code: '6100',
  payout_provider_code: 'pawapay', payout_network_code: 'MTN_MOMO_ZMB', payout_phone_last4: '4567',
}
const failed = {
  payout_id: randomUUID(), payout_attempt_id: randomUUID(), request_id: requestId,
  provider_code: 'pawapay', provider_account_id: randomUUID(), provider_account_version: 2,
  network_code: 'MTN_MOMO_ZMB', provider_network_label: 'MTN', amount: '185.25', currency: 'ZMW',
  client_reference_id: 'original-reference', consume_operation_id: randomUUID(), state: 'FAILED', release_state: 'RELEASED',
  reservation_operation_id: request.finance_operation_id, reservation_idempotency_key: request.finance_idempotency_key,
  reservation_hold_id: request.finance_hold_id, reservation_state: 'RELEASED',
}
function fixture({ currentRequest = request, payout = failed, prior = failed, inserted = {}, auditRows = [{ actor_customer_id: actor.customerId }] } = {}) {
  const calls = []
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('FROM audit_events')) return { rows: auditRows, rowCount: auditRows.length }
    if (sql.includes('SELECT request.request_id')) return { rows: [currentRequest], rowCount: 1 }
    if (sql.includes('SELECT payout_id FROM request_payout_attempts')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM request_payout_attempts') && sql.includes('SELECT')) {
      const selected = sql.includes("state NOT IN ('RESERVING','RESERVATION_FAILED')") ? prior : payout
      return { rows: selected ? [selected] : [], rowCount: selected ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO request_payout_attempts')) return { rows: [{ ...failed, ...inserted, payout_id: values[0], payout_attempt_id: values[1],
      consume_operation_id: values[11], reservation_operation_id: values[12], reservation_idempotency_key: values[13],
      reservation_hold_id: null, reservation_state: 'PENDING', state: 'RESERVING' }], rowCount: 1 }
    if (sql.includes('UPDATE request_payout_attempts') && sql.includes('RETURNING')) return { rows: [{ ...payout, state: 'SUBMITTING', reservation_state: 'RESERVED' }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  } }
  return { calls, repository: createStaffPayoutRepository({ pool: { connect: async () => client, query: client.query }, idFactory: randomUUID }) }
}

test('retry appends fresh identities using the approved routing and preserves the old hold', async () => {
  const { repository, calls } = fixture()
  const result = await repository.preparePayoutRetry({ actor, requestId })
  assert.equal(result.requiresReservation, true)
  assert.equal(result.shouldInitiate, false)
  assert.notEqual(result.reservation.operationId, failed.reservation_operation_id)
  assert.notEqual(result.reservation.idempotencyKey, failed.reservation_idempotency_key)
  assert.equal(result.reservation.providerAccountId, failed.provider_account_id)
  assert.equal(result.reservation.providerAccountVersion, 2)
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO request_payout_attempts'))
  assert.ok(insert.values.includes(result.reservation.operationId))
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE request_payout_attempts')), false)
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO request_decisions')), false)
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO audit_events')))
  assert.ok(calls.some(({ sql }) => sql === 'COMMIT'))
})

for (const state of ['SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE', 'PAID']) {
  test(`retry cannot replace ${state}`, async () => {
    const { repository, calls } = fixture({ payout: { ...failed, state } })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO request_payout_attempts')), false)
  })
}
for (const change of [{ release_state: 'UNKNOWN' }, { release_state: 'PENDING' }, { reservation_state: 'RESERVED' }, { reservation_hold_id: null }]) {
  test(`retry requires confirmed release ${JSON.stringify(change)}`, async () => {
    const { repository } = fixture({ payout: { ...failed, ...change } })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
  })
}

test('retry rejects non-admin and self review before inserting an attempt', async () => {
  for (const user of [{ ...actor, role: 'staff' }, { ...actor, customerId: request.requester_customer_id }]) {
    const { repository, calls } = fixture()
    await assert.rejects(repository.preparePayoutRetry({ actor: user, requestId }), { statusCode: 403 })
    assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO request_payout_attempts')), false)
  }
})

const reserving = { ...failed, payout_id: randomUUID(), payout_attempt_id: randomUUID(), state: 'RESERVING',
  reservation_operation_id: randomUUID(), reservation_idempotency_key: 'retry-operation-key', reservation_hold_id: null,
  reservation_state: 'UNKNOWN', release_state: null }
const pendingRequest = { ...request, status: 'PAYOUT_PENDING', finance_operation_id: reserving.reservation_operation_id,
  finance_idempotency_key: reserving.reservation_idempotency_key, finance_hold_id: null, finance_reservation_state: 'UNKNOWN' }

test('unknown reservation resumes the exact attempt and stable operation without another insert', async () => {
  const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving })
  const result = await repository.preparePayoutRetry({ actor, requestId })
  assert.equal(result.payout.payout_id, reserving.payout_id)
  assert.equal(result.reservation.operationId, reserving.reservation_operation_id)
  assert.equal(result.reservation.idempotencyKey, reserving.reservation_idempotency_key)
  assert.equal(result.replayed, true)
  assert.equal(result.shouldInitiate, false)
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO')), false)
  assert.match(calls.find(({ sql }) => sql.includes('FROM request_payout_attempts')).sql, /ORDER BY created_at DESC, payout_id DESC\s+LIMIT 1\s+FOR UPDATE/)
})

test('a failed reservation needs the nearest preceding provider attempt to be failed and released', async () => {
  const payout = { ...reserving, state: 'RESERVATION_FAILED', reservation_state: 'FAILED' }
  const failedRequest = { ...pendingRequest, status: 'PAYOUT_FAILED', finance_reservation_state: 'FAILED' }
  const allowed = fixture({ payout, currentRequest: failedRequest })
  assert.equal((await allowed.repository.preparePayoutRetry({ actor, requestId })).requiresReservation, true)
  for (const prior of [null, { ...failed, release_state: 'UNKNOWN' }, { ...failed, state: 'PAID' }]) {
    const { repository } = fixture({ payout, prior, currentRequest: failedRequest })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
  }
})

test('reservation failure records only matching latest attempt and keeps unknown reservations resumable', async () => {
  for (const state of ['FAILED', 'UNKNOWN']) {
    const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving })
    await repository.markRetryReservationFailure({ actor, requestId, payoutId: reserving.payout_id,
      operationId: reserving.reservation_operation_id, state, errorCode: 'ITC_UNAVAILABLE' })
    const update = calls.find(({ sql }) => sql.includes('UPDATE request_payout_attempts'))
    assert.ok(update.values.includes(state === 'FAILED' ? 'RESERVATION_FAILED' : 'RESERVING'))
    assert.ok(update.values.includes(reserving.payout_id))
    assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO audit_events')))
  }
})

const newHoldId = randomUUID()
const reservation = { operationId: reserving.reservation_operation_id, idempotencyKey: reserving.reservation_idempotency_key,
  expenseCategoryCode: 'office_supplies', expenseAccountCode: '6100', amount: '185.25', currency: 'ZMW',
  providerCode: 'pawapay', providerAccountId: failed.provider_account_id, providerAccountVersion: 2,
  requesterCustomerId: request.requester_customer_id }
const financeOperation = { operation_id: reservation.operationId, request_id: requestId, hold_id: newHoldId,
  amount: '185.25', currency: 'ZMW', state: 'ACTIVE', expense_category_code: 'office_supplies', expense_account_code: '6100',
  provider_code: 'pawapay', provider_account_id: failed.provider_account_id, provider_account_version: 2 }

test('verified reservation advances the selected attempt to submitting in the locked transaction', async () => {
  const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving })
  const result = await repository.completeRetryReservation({ actor, requestId, payoutId: reserving.payout_id, reservation, financeOperation })
  assert.equal(result.shouldInitiate, true)
  const update = calls.find(({ sql }) => sql.includes('UPDATE request_payout_attempts'))
  assert.match(update.sql, /state = 'RESERVING'/)
  assert.ok(update.values.includes(newHoldId))
  assert.ok(calls.some(({ sql }) => sql.includes('UPDATE expense_requests')))
})
for (const change of [{ hold_id: null }, { amount: '1.00' }, { currency: 'USD' }, { provider_account_version: 3 },
  { provider_code: 'other' }, { operation_id: randomUUID() }, { request_id: randomUUID() }, { state: 'RELEASED' },
  { expense_category_code: 'other' }, { expense_account_code: '6200' }]) {
  test(`reservation completion rejects mismatched finance evidence ${JSON.stringify(change)}`, async () => {
    const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving })
    await assert.rejects(repository.completeRetryReservation({ actor, requestId, payoutId: reserving.payout_id,
      reservation, financeOperation: { ...financeOperation, ...change } }), { code: 'FINANCE_RESERVATION_MISMATCH' })
    assert.equal(calls.some(({ sql }) => sql.includes('UPDATE request_payout_attempts')), false)
  })
}

test('recovery selects one latest attempt and exposes an eligibility boolean with released provider ancestry', async () => {
  const { repository, calls } = fixture()
  await repository.listRecovery({ limit: 25 })
  const query = calls[0]
  assert.match(query.sql, /JOIN LATERAL/)
  assert.match(query.sql, /ORDER BY created_at DESC, payout_id DESC\s+LIMIT 1/)
  assert.match(query.sql, /retry_allowed/)
  assert.match(query.sql, /RESERVATION_FAILED/)
  assert.match(query.sql, /release_state = 'RELEASED'/)
  assert.deepEqual(query.values, [26, 0])
})

test('release uses the selected attempt hold and a distinct per-attempt release key', async () => {
  const payout = { ...failed, state: 'PENDING', reservation_state: 'RESERVED', release_state: null }
  const { repository } = fixture({ payout, currentRequest: { ...request, finance_hold_id: randomUUID() } })
  const result = await repository.prepareRelease({ actor, requestId, payoutId: payout.payout_id, reasonCode: 'PROVIDER_FAILED' })
  assert.equal(result.operation.holdId, payout.reservation_hold_id)
  assert.ok(result.operation.idempotencyKey.includes(payout.payout_id))
})

test('stale release completion cannot mark a newer attempt or request failed', async () => {
  const { repository, calls } = fixture({ payout: reserving, currentRequest: pendingRequest })
  await assert.rejects(repository.completeRelease({ actor, requestId, payoutId: failed.payout_id,
    operationId: randomUUID(), financeOperation: { state: 'RELEASED' } }), { code: 'PAYOUT_RELEASE_CONFLICT' })
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE expense_requests')), false)
})

test('consume validates the selected attempt hold even when the request hold differs', async () => {
  const payout = { ...failed, state: 'PENDING', reservation_state: 'RESERVED', release_state: null }
  const { repository, calls } = fixture({ payout, currentRequest: { ...request, status: 'PAYOUT_PENDING', finance_hold_id: randomUUID() } })
  const result = await repository.completePayout({ actor, requestId, payoutId: payout.payout_id,
    providerTransactionId: payout.payout_id, providerStatus: 'COMPLETED', providerReference: payout.payout_id,
    financeOperation: { operation_id: payout.consume_operation_id, hold_id: payout.reservation_hold_id,
      request_id: requestId, payout_attempt_id: payout.payout_attempt_id, provider_transaction_id: payout.payout_id,
      expense_category_code: 'office_supplies', amount: '185.25', currency: 'ZMW', state: 'CONSUMED' }, verifiedAt: new Date() })
  assert.equal(result.status, 'PAID')
  assert.ok(calls.some(({ sql }) => sql.includes("reservation_state = 'CONSUMED'")))
})

test('release completion validates the selected attempt hold and preserves its snapshot', async () => {
  const operationId = randomUUID()
  const payout = { ...failed, state: 'FAILED_PENDING_RELEASE', reservation_state: 'RESERVED', release_state: 'UNKNOWN',
    release_operation_id: operationId, release_idempotency_key: 'stable-release-key' }
  const { repository, calls } = fixture({ payout, currentRequest: { ...request, status: 'PAYOUT_PENDING', finance_hold_id: randomUUID() } })
  const result = await repository.completeRelease({ actor, requestId, payoutId: payout.payout_id, operationId,
    financeOperation: { operation_id: operationId, request_id: requestId, hold_id: payout.reservation_hold_id, state: 'RELEASED' } })
  assert.equal(result.status, 'PAYOUT_FAILED')
  const update = calls.find(({ sql }) => sql.includes('UPDATE request_payout_attempts'))
  assert.match(update.sql, /reservation_state = 'RELEASED'/)
  assert.equal(update.sql.includes('reservation_hold_id ='), false)
})

test('retry requires the failed request state even when the attempt is released', async () => {
  for (const status of ['PENDING_ADMIN', 'PAYOUT_PENDING', 'PAID']) {
    const { repository } = fixture({ currentRequest: { ...request, status } })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
  }
})

test('provider outcome updates cannot mutate an attempt still reserving', async () => {
  const calls = []
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values })
    if (sql.includes('UPDATE request_payout_attempts')) {
      assert.match(sql, /state IN \('SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE'\)/)
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM request_payout_attempts')) return { rows: [reserving], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  } }
  const repository = createStaffPayoutRepository({ pool: { connect: async () => client, query: client.query } })
  await assert.rejects(repository.markUnknown({ actorId: actor.customerId, requestId, payoutId: reserving.payout_id,
    errorCode: 'PROVIDER_UNAVAILABLE' }), { code: 'PAYOUT_STATE_CONFLICT' })
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO audit_events')), false)
})


test('retry cannot discard a mismatched or still reserved current request hold', async () => {
  for (const change of [
    { finance_reservation_state: 'RESERVED' }, { finance_hold_id: randomUUID() },
    { finance_operation_id: randomUUID() }, { finance_idempotency_key: 'another-operation' },
  ]) {
    const { repository, calls } = fixture({ currentRequest: { ...request, ...change } })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO request_payout_attempts')), false)
  }
})


test('retry preparation returns the canonical actor from its persisted origin audit', async () => {
  const { repository } = fixture()
  const created = await repository.preparePayoutRetry({ actor: { ...actor, customerId: actor.customerId.toUpperCase() }, requestId })
  assert.equal(created.reservationActorCustomerId, actor.customerId)
})

test('reserving replay recovers the original actor across admin and request UUID casing changes', async () => {
  const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving })
  const replay = await repository.preparePayoutRetry({ actor: { ...actor, customerId: randomUUID() }, requestId: requestId.toUpperCase() })
  assert.equal(replay.reservationActorCustomerId, actor.customerId)
  assert.equal(replay.request.request_id, requestId)
  const lookup = calls.find(({ sql }) => sql.includes('FROM audit_events'))
  assert.ok(lookup.values.includes(reserving.payout_id))
  assert.ok(lookup.values.includes(requestId))
  assert.ok(lookup.values.includes(reserving.reservation_operation_id))
  assert.equal(calls.some(({ sql }) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false)
})

for (const auditRows of [[], [{ actor_customer_id: null }], [{ actor_customer_id: 'bad' }],
  [{ actor_customer_id: actor.customerId }, { actor_customer_id: randomUUID() }]]) {
  test(`retry cannot resume without one valid immutable origin audit actor ${JSON.stringify(auditRows)}`, async () => {
    const { repository, calls } = fixture({ currentRequest: pendingRequest, payout: reserving, auditRows })
    await assert.rejects(repository.preparePayoutRetry({ actor, requestId }), { code: 'PAYOUT_RETRY_ORIGIN_UNAVAILABLE' })
    assert.ok(calls.some(({ sql }) => sql === 'ROLLBACK'))
    assert.equal(calls.some(({ sql }) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false)
  })
}
