const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

require('dotenv').config()
const { loadConfig } = require('../src/config/env')
const { createRequestRepository } = require('../src/requests/requestRepository')
const { createStaffPayoutRepository } = require('../src/payouts/staffPayoutRepository')
const { createTemporaryTables } = require('./helpers/postgresTestSchema')

const enabled = process.env.EW_RUN_POSTGRES_TESTS === '1'
const TABLES = Object.freeze([
  'expense_categories',
  'employee_manager_assignments',
  'staff_payout_destinations',
  'expense_requests',
  'request_decisions',
  'idempotency_records',
  'request_payout_attempts',
  'audit_events',
  'expense_request_attachments',
])

test('request approval and payout preparation commit staged decisions atomically in temporary PostgreSQL tables', { skip: !enabled }, async () => {
  const pool = new Pool({ ...loadConfig().database, max: 1, application_name: 'expense-warrior-approval-postgres-test' })
  try {
    const client = await pool.connect()
    try {
      const identity = await client.query(`
        SELECT current_database() AS database, current_user AS role, role.rolsuper AS superuser
          FROM pg_roles role
         WHERE role.rolname = current_user
      `)
      assert.equal(identity.rows[0]?.database, 'expense_warrior', 'test must use the dedicated local Expense Warrior database')
      assert.equal(identity.rows[0]?.role, 'expense_warrior_app', 'test must use the restricted runtime account')
      assert.equal(identity.rows[0]?.superuser, false, 'test refuses a superuser database identity')

      await createTemporaryTables(client, TABLES)
      const resolution = await client.query(`
        SELECT to_regclass('expense_requests')::text AS requests,
               to_regclass('request_payout_attempts')::text AS payouts,
               to_regclass('pg_temp.expense_requests')::text AS temporary_requests,
               to_regclass('pg_temp.request_payout_attempts')::text AS temporary_payouts
      `)
      assert.equal(resolution.rows[0].requests, resolution.rows[0].temporary_requests,
        'request workflow tables must resolve to session-local temporary tables')
      assert.equal(resolution.rows[0].payouts, resolution.rows[0].temporary_payouts,
        'payout workflow tables must resolve to session-local temporary tables')
    } finally {
      client.release()
    }

    const staffId = randomUUID()
    const managerId = randomUUID()
    const adminId = randomUUID()
    const categoryId = randomUUID()
    const assignmentId = randomUUID()
    const destinationId = randomUUID()
    const auditRequestId = randomUUID()
    const operationId = randomUUID()
    const holdId = randomUUID()
    const repository = createRequestRepository({ pool, idFactory: () => operationId })

    await pool.query(`
      INSERT INTO expense_categories
        (category_id, code, name, is_active, reason_required, attachment_required, itc_expense_category_code)
      VALUES ($1, 'PG_OFFICE_SUPPLIES', 'PostgreSQL approval test', true, false, false, 'office_supplies')
    `, [categoryId])
    await pool.query(`
      INSERT INTO employee_manager_assignments
        (assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id)
      VALUES ($1, $2, $3, $4)
    `, [assignmentId, staffId, managerId, adminId])
    await pool.query(`
      INSERT INTO staff_payout_destinations (
        destination_id, staff_customer_id, network_code, phone_ciphertext, encryption_key_id,
        phone_fingerprint, phone_last4, assigned_by_customer_id
      ) VALUES ($1, $2, 'MTN_MOMO_ZMB', repeat('x', 64), 'postgres-test-key', repeat('a', 64), '4567', $3)
    `, [destinationId, staffId, adminId])

    const submission = await repository.submit({
      actor: { customerId: staffId, role: 'staff' },
      request: { categoryId, subcategoryId: null, amount: '185.25', currency: 'ZMW', reason: 'Office paper and ink' },
      idempotencyKey: randomUUID(),
      requestId: auditRequestId,
    })
    const requestId = submission.request.request_id
    assert.equal(submission.request.status, 'PENDING_MANAGER')
    assert.equal(submission.request.reviewer_manager_customer_id, managerId)

    const manager = await repository.prepareManagerApproval({
      actor: { customerId: managerId, role: 'staff' }, requestId,
      idFactory: () => operationId,
    })
    assert.equal(manager.request.status, 'MANAGER_APPROVAL_PENDING_HOLD')
    assert.equal(manager.operation.expenseCategoryCode, 'office_supplies')

    const financeOperation = {
      operation_id: operationId,
      request_id: requestId,
      amount: '185.25',
      currency: 'ZMW',
      state: 'ACTIVE',
      hold_id: holdId,
      expense_category_code: 'office_supplies',
      expense_account_code: '6100',
    }
    const managerApproved = await repository.completeManagerApproval({
      actor: { customerId: managerId, role: 'staff' }, requestId, operationId,
      idempotencyKey: manager.operation.idempotencyKey,
      financeOperation,
    })
    assert.equal(managerApproved.request.status, 'MANAGER_APPROVED')
    assert.equal(managerApproved.request.finance_reservation_state, 'RESERVED')

    const payouts = createStaffPayoutRepository({ pool, idFactory: randomUUID })
    const adminApproved = await payouts.prepareFinalApproval({
      actor: { customerId: adminId, role: 'admin' }, requestId,
    })
    assert.equal(adminApproved.request.status, 'PAYOUT_PENDING')
    assert.equal(adminApproved.payout.state, 'SUBMITTING')
    assert.equal(adminApproved.payout.network_code, 'MTN_MOMO_ZMB')
    assert.equal(adminApproved.shouldInitiate, true)

    const replay = await payouts.prepareFinalApproval({
      actor: { customerId: adminId, role: 'admin' }, requestId,
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.shouldInitiate, false, 'replaying final approval must not start a second payout')
    assert.equal(replay.payout.payout_id, adminApproved.payout.payout_id)

    const decisions = await pool.query(`
      SELECT stage, action, actor_customer_id FROM request_decisions
       WHERE request_id = $1 ORDER BY stage
    `, [requestId])
    assert.deepEqual(decisions.rows.map(({ stage, action }) => [stage, action]), [
      ['admin', 'approve'], ['manager', 'approve'],
    ])
    const rows = await pool.query(`
      SELECT request.status, payout.state, payout.consume_state
        FROM expense_requests request
        JOIN request_payout_attempts payout USING (request_id)
       WHERE request.request_id = $1
    `, [requestId])
    assert.deepEqual(rows.rows[0], { status: 'PAYOUT_PENDING', state: 'SUBMITTING', consume_state: 'PENDING' })
    const auditCount = await pool.query(`SELECT count(*)::int AS count FROM audit_events WHERE target_id = $1`, [requestId])
    assert.equal(auditCount.rows[0].count, 4, 'submission, manager start/approval, and final approval are audited')

    const initialSnapshot = await pool.query(`
      SELECT reservation_operation_id, reservation_idempotency_key,
             reservation_hold_id, reservation_state
        FROM pg_temp.request_payout_attempts WHERE payout_id = $1
    `, [adminApproved.payout.payout_id])
    assert.deepEqual(initialSnapshot.rows[0], {
      reservation_operation_id: operationId, reservation_idempotency_key: manager.operation.idempotencyKey,
      reservation_hold_id: holdId, reservation_state: 'RESERVED',
    }, 'the first attempt snapshots its original hold')

    const admin = { customerId: adminId, role: 'admin' }
    await assert.rejects(payouts.preparePayoutRetry({ actor: admin, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    await payouts.recordInitiation({ actorId: adminId, requestId, payoutId: adminApproved.payout.payout_id,
      providerStatus: 'REJECTED', errorCode: 'PAWAPAY_INSUFFICIENT_BALANCE' })
    await assert.rejects(payouts.preparePayoutRetry({ actor: admin, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    const originalRelease = await payouts.prepareRelease({ actor: admin, requestId,
      payoutId: adminApproved.payout.payout_id, reasonCode: 'PAWAPAY_INSUFFICIENT_BALANCE' })
    assert.equal(originalRelease.operation.holdId, holdId)
    const releaseEvidence = { operation_id: originalRelease.operation.operationId, request_id: requestId,
      hold_id: holdId, state: 'RELEASED' }
    await payouts.completeRelease({ actor: admin, requestId, payoutId: adminApproved.payout.payout_id,
      operationId: originalRelease.operation.operationId, financeOperation: releaseEvidence })
    const eligible = await payouts.listRecovery({})
    assert.equal(eligible.items.length, 1)
    assert.equal(eligible.items[0].retry_allowed, true)

    const retry = await payouts.preparePayoutRetry({ actor: admin, requestId })
    assert.equal(retry.payout.state, 'RESERVING')
    assert.equal(retry.reservationActorCustomerId, adminId)
    assert.notEqual(retry.payout.payout_id, adminApproved.payout.payout_id)
    assert.notEqual(retry.payout.payout_attempt_id, adminApproved.payout.payout_attempt_id)
    assert.notEqual(retry.payout.client_reference_id, adminApproved.payout.client_reference_id)
    assert.notEqual(retry.reservation.operationId, operationId)
    assert.notEqual(retry.reservation.idempotencyKey, manager.operation.idempotencyKey)
    assert.equal(retry.shouldInitiate, false)
    const constraintClient = await pool.connect()
    try {
      for (const state of ['RESERVING', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE']) {
        await assert.rejects(constraintClient.query(`
          INSERT INTO pg_temp.request_payout_attempts (
            payout_id, payout_attempt_id, request_id, provider_code, network_code,
            amount, currency, client_reference_id, state, consume_operation_id,
            reservation_operation_id, reservation_idempotency_key, reservation_state
          ) SELECT $2, $3, request_id, provider_code, network_code, amount, currency, $4, $5, $6, $7, $8, $9
              FROM pg_temp.request_payout_attempts WHERE payout_id = $1
        `, [retry.payout.payout_id, randomUUID(), randomUUID(), randomUUID(), state, randomUUID(),
          state === 'RESERVING' ? randomUUID() : null, state === 'RESERVING' ? randomUUID() : null,
          state === 'RESERVING' ? 'PENDING' : null]), (error) =>
          error.code === '23505' && error.constraint === 'request_payout_attempts_one_active_test_idx')
      }
      for (const change of [
        "reservation_state = NULL", "reservation_operation_id = NULL",
        "reservation_idempotency_key = NULL", "reservation_idempotency_key = 'short'",
        "reservation_state = 'RESERVED'", `reservation_hold_id = '${randomUUID()}'`,
        "state = 'RESERVATION_FAILED'", "reservation_state = 'INVALID'",
      ]) {
        await assert.rejects(constraintClient.query(`
          UPDATE pg_temp.request_payout_attempts SET ${change} WHERE payout_id = $1
        `, [retry.payout.payout_id]), (error) => error.code === '23514')
      }
    } finally { constraintClient.release() }
    await payouts.markRetryReservationFailure({ actor: admin, requestId, payoutId: retry.payout.payout_id,
      operationId: retry.reservation.operationId, state: 'UNKNOWN', errorCode: 'ITC_UNAVAILABLE' })
    const resumed = await payouts.preparePayoutRetry({ actor: { ...admin, customerId: randomUUID() }, requestId: requestId.toUpperCase() })
    assert.equal(resumed.reservationActorCustomerId, adminId)
    assert.equal(resumed.request.request_id, requestId)
    assert.equal(resumed.payout.payout_id, retry.payout.payout_id)
    assert.deepEqual(resumed.reservation, retry.reservation)
    // Only a matching attempt/request/operation audit is a valid origin.
    await pool.query(`UPDATE pg_temp.audit_events SET action = 'test.origin.hidden'
      WHERE target_id = $1 AND action = 'payout.retry.reservation_started'`, [retry.payout.payout_id])
    await assert.rejects(payouts.preparePayoutRetry({ actor: admin, requestId }), { code: 'PAYOUT_RETRY_ORIGIN_UNAVAILABLE' })
    await pool.query(`UPDATE pg_temp.audit_events SET action = 'payout.retry.reservation_started'
      WHERE target_id = $1 AND action = 'test.origin.hidden'`, [retry.payout.payout_id])
    const savedMetadata = (await pool.query('SELECT metadata FROM pg_temp.audit_events WHERE target_id = $1 AND action = $2',
      [retry.payout.payout_id, 'payout.retry.reservation_started'])).rows[0].metadata
    for (const change of [{ request_id: randomUUID() }, { operation_id: randomUUID() }]) {
      await pool.query(`UPDATE pg_temp.audit_events SET metadata = $2::jsonb WHERE target_id = $1 AND action = 'payout.retry.reservation_started'`,
        [retry.payout.payout_id, JSON.stringify({ ...savedMetadata, ...change })])
      await assert.rejects(payouts.preparePayoutRetry({ actor: admin, requestId }), { code: 'PAYOUT_RETRY_ORIGIN_UNAVAILABLE' })
    }
    await pool.query(`UPDATE pg_temp.audit_events SET metadata = $2::jsonb WHERE target_id = $1 AND action = 'payout.retry.reservation_started'`,
      [retry.payout.payout_id, JSON.stringify(savedMetadata)])
    assert.equal((await payouts.preparePayoutRetry({ actor: admin, requestId })).reservationActorCustomerId, adminId)
    await payouts.markRetryReservationFailure({ actor: admin, requestId, payoutId: retry.payout.payout_id,
      operationId: retry.reservation.operationId, state: 'FAILED', errorCode: 'INSUFFICIENT_FUNDS' })
    const failedReservation = await payouts.listRecovery({})
    assert.equal(failedReservation.items.length, 1)
    assert.equal(failedReservation.items[0].payout_state, 'RESERVATION_FAILED')
    assert.equal(failedReservation.items[0].retry_allowed, true)

    const failureList = await repository.listForActor({ actor: admin,
      filters: { limit: 25, offset: 0, sort: 'created_at', direction: 'desc' } })
    assert.equal(failureList.items.length, 1)
    assert.equal(failureList.items[0].payout_state, 'RESERVATION_FAILED')
    assert.equal(failureList.items[0].payout_error_code, 'INSUFFICIENT_FUNDS')

    // A failed reservation must trace to the nearest prior provider failure,
    // rather than any historical failure that happened to have been released.
    await pool.query("UPDATE pg_temp.request_payout_attempts SET state = 'FAILED_PENDING_RELEASE', release_state = 'UNKNOWN' WHERE payout_id = $1", [adminApproved.payout.payout_id])
    await assert.rejects(payouts.preparePayoutRetry({ actor: admin, requestId }), { code: 'PAYOUT_RETRY_NOT_ALLOWED' })
    assert.equal((await payouts.listRecovery({})).items.length, 0)
    await pool.query("UPDATE pg_temp.request_payout_attempts SET state = 'FAILED', release_state = 'RELEASED' WHERE payout_id = $1", [adminApproved.payout.payout_id])
    const next = await payouts.preparePayoutRetry({ actor: admin, requestId })
    assert.notEqual(next.reservation.operationId, retry.reservation.operationId)
    const nextHoldId = randomUUID()
    const nextEvidence = { ...financeOperation, operation_id: next.reservation.operationId, hold_id: nextHoldId,
      provider_code: next.reservation.providerCode, provider_account_id: next.reservation.providerAccountId,
      provider_account_version: next.reservation.providerAccountVersion }
    await assert.rejects(payouts.completeRetryReservation({ actor: admin, requestId, payoutId: next.payout.payout_id,
      reservation: next.reservation, financeOperation: { ...nextEvidence, hold_id: holdId } }), { code: 'FINANCE_RESERVATION_MISMATCH' })
    const completions = await Promise.all([1, 2].map(() => payouts.completeRetryReservation({
      actor: admin, requestId, payoutId: next.payout.payout_id, reservation: next.reservation, financeOperation: nextEvidence,
    })))
    assert.equal(completions.filter((result) => result.shouldInitiate).length, 1,
      'only the transaction changing RESERVING to SUBMITTING may initiate')
    assert.equal(completions[0].payout.reservation_hold_id, nextHoldId)
    await assert.rejects(payouts.completeRelease({ actor: admin, requestId, payoutId: adminApproved.payout.payout_id,
      operationId: originalRelease.operation.operationId, financeOperation: releaseEvidence }), { code: 'PAYOUT_RELEASE_CONFLICT' })
    await payouts.markPending({ actorId: adminId, requestId, payoutId: next.payout.payout_id, providerStatus: 'ACCEPTED' })
    const consumedEvidence = { ...nextEvidence, operation_id: next.payout.consume_operation_id, state: 'CONSUMED',
      payout_attempt_id: next.payout.payout_attempt_id, provider_transaction_id: next.payout.payout_id }
    await assert.rejects(payouts.completePayout({ actor: admin, requestId, payoutId: next.payout.payout_id,
      providerTransactionId: next.payout.payout_id, providerStatus: 'COMPLETED', providerReference: next.payout.payout_id,
      financeOperation: { ...consumedEvidence, hold_id: holdId }, verifiedAt: new Date() }), { code: 'PAYOUT_COMPLETION_CONFLICT' })
    const listed = await repository.listForActor({ actor: admin,
      filters: { limit: 25, offset: 0, sort: 'created_at', direction: 'desc' } })
    assert.equal(listed.items.length, 1, 'history cannot duplicate a request list row')
    assert.equal(listed.items[0].payout_state, 'PENDING')
    assert.equal(listed.items[0].payout_error_code, null, 'an old failure cannot leak into the current attempt')
    const recovery = await payouts.listRecovery({})
    assert.equal(recovery.items.length, 1)
    assert.equal(recovery.items[0].payout_id, next.payout.payout_id)
    assert.equal(recovery.items[0].retry_allowed, false)
    await payouts.completePayout({ actor: admin, requestId, payoutId: next.payout.payout_id,
      providerTransactionId: next.payout.payout_id, providerStatus: 'COMPLETED', providerReference: next.payout.payout_id,
      financeOperation: consumedEvidence, verifiedAt: new Date() })
    const history = await pool.query(`SELECT payout_id, state, reservation_operation_id, reservation_hold_id, reservation_state
      FROM pg_temp.request_payout_attempts WHERE request_id = $1 ORDER BY created_at, payout_id`, [requestId])
    assert.equal(history.rows.length, 3)
    assert.deepEqual(history.rows.find((row) => row.payout_id === adminApproved.payout.payout_id), {
      payout_id: adminApproved.payout.payout_id, state: 'FAILED', reservation_operation_id: operationId,
      reservation_hold_id: holdId, reservation_state: 'RELEASED',
    })
    assert.equal(history.rows.find((row) => row.payout_id === next.payout.payout_id).reservation_state, 'CONSUMED')
    const finalDecisions = await pool.query('SELECT stage, action FROM request_decisions WHERE request_id = $1 ORDER BY stage', [requestId])
    assert.deepEqual(finalDecisions.rows, [{ stage: 'admin', action: 'approve' }, { stage: 'manager', action: 'approve' }])

  } finally {
    await pool.end()
  }
})
