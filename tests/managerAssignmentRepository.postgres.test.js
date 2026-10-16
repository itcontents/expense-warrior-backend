const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

require('dotenv').config()
const { loadConfig } = require('../src/config/env')
const { createManagerAssignmentRepository } = require('../src/managerAssignments/managerAssignmentRepository')
const { createTemporaryTables } = require('./helpers/postgresTestSchema')

const enabled = process.env.EW_RUN_POSTGRES_TESTS === '1'
const TABLES = Object.freeze([
  'expense_categories',
  'employee_manager_assignments',
  'expense_requests',
  'audit_events',
])

test('manager reassignment and ending route only untouched requests in real PostgreSQL transactions', { skip: !enabled }, async () => {
  const pool = new Pool({ ...loadConfig().database, max: 1, application_name: 'expense-warrior-manager-assignment-postgres-test' })
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
      for (const table of TABLES) {
        const resolution = await client.query(`
          SELECT to_regclass($1)::text AS resolved, to_regclass($2)::text AS temporary
        `, [table, `pg_temp.${table}`])
        assert.equal(resolution.rows[0].resolved, resolution.rows[0].temporary,
          `${table} must resolve to a session-local temporary table`)
      }
    } finally {
      client.release()
    }

    const staffId = randomUUID()
    const oldManagerId = randomUUID()
    const newManagerId = randomUUID()
    const adminId = randomUUID()
    const categoryId = randomUUID()
    const previousAssignmentId = randomUUID()
    const pendingRequestId = randomUUID()
    const holdRequestId = randomUUID()
    const holdOperationId = randomUUID()
    const repository = createManagerAssignmentRepository({ pool })

    await pool.query(`
      INSERT INTO expense_categories
        (category_id, code, name, is_active, reason_required, attachment_required)
      VALUES ($1, 'PG_MANAGER_ROUTE', 'Manager routing PostgreSQL test', true, false, false)
    `, [categoryId])
    await pool.query(`
      INSERT INTO employee_manager_assignments
        (assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id)
      VALUES ($1, $2, $3, $4)
    `, [previousAssignmentId, staffId, oldManagerId, adminId])
    await pool.query(`
      INSERT INTO expense_requests
        (request_id, requester_customer_id, category_id, manager_assignment_id,
         reviewer_manager_customer_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, '20.00', 'PENDING_MANAGER')
    `, [pendingRequestId, staffId, categoryId, previousAssignmentId, oldManagerId])
    await pool.query(`
      INSERT INTO expense_requests
        (request_id, requester_customer_id, category_id, manager_assignment_id,
         reviewer_manager_customer_id, amount, status, finance_operation_id,
         finance_idempotency_key, finance_reservation_state)
      VALUES ($1, $2, $3, $4, $5, '30.00', 'MANAGER_APPROVAL_PENDING_HOLD', $6, $7, 'PENDING')
    `, [holdRequestId, staffId, categoryId, previousAssignmentId, oldManagerId, holdOperationId, `ewmr-${holdOperationId}`])

    const assigned = await repository.assign({ actorId: adminId, staffId, managerId: newManagerId })
    let requests = await pool.query(`
      SELECT request_id, status, manager_assignment_id, reviewer_manager_customer_id
        FROM expense_requests ORDER BY request_id
    `)
    const pendingAfterReassignment = requests.rows.find((row) => row.request_id === pendingRequestId)
    const holdAfterReassignment = requests.rows.find((row) => row.request_id === holdRequestId)
    assert.deepEqual(pendingAfterReassignment, {
      request_id: pendingRequestId,
      status: 'PENDING_MANAGER',
      manager_assignment_id: assigned.assignment_id,
      reviewer_manager_customer_id: newManagerId,
    })
    assert.deepEqual(holdAfterReassignment, {
      request_id: holdRequestId,
      status: 'MANAGER_APPROVAL_PENDING_HOLD',
      manager_assignment_id: previousAssignmentId,
      reviewer_manager_customer_id: oldManagerId,
    })

    await repository.end({ actorId: adminId, assignmentId: assigned.assignment_id })
    requests = await pool.query(`
      SELECT request_id, status, manager_assignment_id, reviewer_manager_customer_id
        FROM expense_requests ORDER BY request_id
    `)
    const pendingAfterEnd = requests.rows.find((row) => row.request_id === pendingRequestId)
    const holdAfterEnd = requests.rows.find((row) => row.request_id === holdRequestId)
    assert.deepEqual(pendingAfterEnd, {
      request_id: pendingRequestId,
      status: 'PENDING_ADMIN',
      manager_assignment_id: null,
      reviewer_manager_customer_id: null,
    })
    assert.deepEqual(holdAfterEnd, {
      request_id: holdRequestId,
      status: 'MANAGER_APPROVAL_PENDING_HOLD',
      manager_assignment_id: previousAssignmentId,
      reviewer_manager_customer_id: oldManagerId,
    })

    const audit = await pool.query(`
      SELECT action, target_id, metadata
        FROM audit_events
       WHERE action = 'request.manager_reassigned'
       ORDER BY created_at, audit_event_id
    `)
    assert.equal(audit.rowCount, 2)
    assert.deepEqual(audit.rows.map((row) => row.target_id), [pendingRequestId, pendingRequestId])
    assert.deepEqual(audit.rows.map((row) => row.metadata.status), ['PENDING_MANAGER', 'PENDING_ADMIN'])
  } finally {
    await pool.end()
  }
})
