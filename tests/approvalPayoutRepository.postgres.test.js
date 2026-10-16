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
      reservation_operation_id: null, reservation_idempotency_key: null,
      reservation_hold_id: null, reservation_state: null,
    }, 'the original payout writer remains compatible until Task 2 populates snapshots')

    const constraintClient = await pool.connect()
    try {
      // All subsequent mutations target the temporary table explicitly. These
      // fixtures exercise retry constraints without making any financial API call.
      const appendAttempt = (state, reservationState = null) => constraintClient.query(`
        INSERT INTO pg_temp.request_payout_attempts (
          payout_id, payout_attempt_id, request_id, provider_code, network_code,
          amount, currency, client_reference_id, state, consume_operation_id,
          reservation_operation_id, reservation_idempotency_key, reservation_state
        ) SELECT $2, $3, request_id, provider_code, network_code,
                 amount, currency, $4, $5, $6, $7, $8, $9
            FROM pg_temp.request_payout_attempts WHERE payout_id = $1
        RETURNING *
      `, [adminApproved.payout.payout_id, randomUUID(), randomUUID(), randomUUID(), state,
        randomUUID(), reservationState ? randomUUID() : null,
        reservationState ? randomUUID() : null, reservationState])

      await assert.rejects(appendAttempt('SUBMITTING'), (error) =>
        error.code === '23505' && error.constraint === 'request_payout_attempts_one_active_test_idx')
      await constraintClient.query(`
        UPDATE pg_temp.request_payout_attempts
           SET state = 'FAILED', release_state = 'RELEASED',
               reservation_operation_id = $2, reservation_idempotency_key = $3,
               reservation_hold_id = $4, reservation_state = 'RELEASED'
         WHERE payout_id = $1
      `, [adminApproved.payout.payout_id, operationId, manager.operation.idempotencyKey, holdId])
      const retry = (await appendAttempt('RESERVING', 'PENDING')).rows[0]
      for (const state of ['RESERVING', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE']) {
        await assert.rejects(appendAttempt(state, state === 'RESERVING' ? 'UNKNOWN' : null), (error) =>
          error.code === '23505' && error.constraint === 'request_payout_attempts_one_active_test_idx',
        `an active retry must block another ${state} attempt`)
      }
      for (const change of [
        "reservation_state = NULL", "reservation_operation_id = NULL",
        "reservation_idempotency_key = NULL", "reservation_idempotency_key = 'short'",
        "reservation_state = 'RESERVED'", `reservation_hold_id = '${randomUUID()}'`,
        "state = 'RESERVATION_FAILED'", "reservation_state = 'INVALID'",
      ]) {
        await assert.rejects(constraintClient.query(`
          UPDATE pg_temp.request_payout_attempts SET ${change} WHERE payout_id = $1
        `, [retry.payout_id]), (error) => error.code === '23514',
        `incoherent reservation snapshot must fail: ${change}`)
      }
      await constraintClient.query(`
        UPDATE pg_temp.request_payout_attempts
           SET state = 'RESERVATION_FAILED', reservation_state = 'FAILED'
         WHERE payout_id = $1
      `, [retry.payout_id])
      const nextRetry = (await appendAttempt('RESERVING', 'UNKNOWN')).rows[0]
      assert.notEqual(nextRetry.reservation_operation_id, retry.reservation_operation_id)
      const history = await constraintClient.query(`
        SELECT payout_id, state, reservation_operation_id, reservation_hold_id, reservation_state
          FROM pg_temp.request_payout_attempts WHERE request_id = $1
      `, [requestId])
      assert.equal(history.rows.length, 3, 'terminal attempts remain in history')
      assert.deepEqual(history.rows.find((row) => row.payout_id === adminApproved.payout.payout_id), {
        payout_id: adminApproved.payout.payout_id, state: 'FAILED',
        reservation_operation_id: operationId, reservation_hold_id: holdId, reservation_state: 'RELEASED',
      }, 'later attempts retain the original reservation snapshot')
    } finally {
      constraintClient.release()
    }
  } finally {
    await pool.end()
  }
})
