const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

require('dotenv').config()
const { loadConfig } = require('../src/config/env')
const { createRequestRepository } = require('../src/requests/requestRepository')

const enabled = process.env.EW_RUN_POSTGRES_TESTS === '1'
const TABLES = Object.freeze([
  'idempotency_records',
  'expense_categories',
  'employee_manager_assignments',
  'staff_payout_destinations',
  'expense_requests',
  'expense_request_attachments',
  'audit_events',
])

test('request repository uses real PostgreSQL transactions, constraints and replay behavior', { skip: !enabled }, async () => {
  const pool = new Pool({ ...loadConfig().database, max: 1, application_name: 'expense-warrior-postgres-test' })
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

      for (const table of TABLES) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`)
      }
      const resolution = await client.query(`
        SELECT to_regclass('expense_requests')::text AS resolved_table,
               to_regclass('pg_temp.expense_requests')::text AS temporary_table
      `)
      assert.equal(resolution.rows[0].resolved_table, resolution.rows[0].temporary_table,
        'repository table names must resolve to session-local temporary tables')
    } finally {
      client.release()
    }

    const staffId = randomUUID()
    const managerId = randomUUID()
    const adminId = randomUUID()
    const categoryId = randomUUID()
    const inactiveCategoryId = randomUUID()
    const destinationId = randomUUID()
    const idempotencyKey = randomUUID()
    const requestId = randomUUID()
    const attachmentId = randomUUID()

    await pool.query(`
      INSERT INTO expense_categories
        (category_id, code, name, is_active, reason_required, attachment_required)
      VALUES
        ($1, 'PG_TEST_CATEGORY', 'PostgreSQL request test', true, false, false),
        ($2, 'PG_TEST_INACTIVE', 'Inactive PostgreSQL test category', false, false, false)
    `, [categoryId, inactiveCategoryId])
    await pool.query(`
      INSERT INTO employee_manager_assignments (staff_customer_id, manager_customer_id, assigned_by_customer_id)
      VALUES ($1, $2, $3)
    `, [staffId, managerId, adminId])
    await pool.query(`
      INSERT INTO staff_payout_destinations (
        destination_id, staff_customer_id, network_code, phone_ciphertext, encryption_key_id,
        phone_fingerprint, phone_last4, assigned_by_customer_id
      ) VALUES ($1, $2, 'AIRTEL_OAPI_ZMB', repeat('x', 64), 'postgres-test-key', repeat('a', 64), '0783', $3)
    `, [destinationId, staffId, adminId])

    const request = { categoryId, subcategoryId: null, amount: '20.50', currency: 'ZMW', reason: null }
    const repository = createRequestRepository({ pool })
    const attachment = {
      storageKey: `${attachmentId}.jpg`,
      mediaType: 'image/jpeg',
      size: 128,
      sha256: 'b'.repeat(64),
    }
    const actor = { customerId: staffId, role: 'staff' }
    const first = await repository.submit({ actor, request, attachment, idempotencyKey, requestId })
    assert.equal(first.replayed, false)
    assert.equal(first.request.status, 'PENDING_MANAGER')
    assert.equal(first.request.reviewer_manager_customer_id, managerId)
    assert.equal(first.request.payout_phone_last4, '0783')
    assert.equal(first.request.attachment.media_type, 'image/jpeg')

    const replay = await repository.submit({ actor, request, attachment, idempotencyKey, requestId })
    assert.equal(replay.replayed, true)
    assert.equal(replay.request.request_id, first.request.request_id)

    await assert.rejects(
      repository.submit({ actor, request: { ...request, amount: '21.00' }, attachment, idempotencyKey, requestId }),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
    )

    const visible = await repository.listForActor({
      actor, filters: { sort: 'created_at', direction: 'desc', limit: 10, offset: 0 },
    })
    assert.deepEqual(visible.items.map((item) => item.request_id), [first.request.request_id])

    const managerQueue = await repository.listApprovals({
      actor: { customerId: managerId, role: 'staff' },
      filters: { sort: 'created_at', direction: 'desc', limit: 10, offset: 0 },
    })
    assert.deepEqual(managerQueue.items.map((item) => item.request_id), [first.request.request_id])
    const unrelatedQueue = await repository.listApprovals({
      actor: { customerId: randomUUID(), role: 'staff' },
      filters: { sort: 'created_at', direction: 'desc', limit: 10, offset: 0 },
    })
    assert.deepEqual(unrelatedQueue.items, [], 'unassigned staff must not see another employee queue')

    const rejectedActorId = randomUUID()
    const rejectedKey = randomUUID()
    await assert.rejects(
      repository.submit({
        actor: { customerId: rejectedActorId, role: 'staff' },
        request: { ...request, categoryId: inactiveCategoryId },
        idempotencyKey: rejectedKey,
        requestId: randomUUID(),
      }),
      (error) => error.code === 'CATEGORY_UNAVAILABLE'
    )
    const rollback = await pool.query(`
      SELECT count(*)::int AS rows
        FROM idempotency_records
       WHERE actor_customer_id = $1 AND idempotency_key = $2
    `, [rejectedActorId, rejectedKey])
    assert.equal(rollback.rows[0].rows, 0, 'failed submission must roll back its idempotency claim')
  } finally {
    await pool.end()
  }
})
