const test = require('node:test')
const assert = require('node:assert/strict')
const { createManagerAssignmentRepository } = require('../src/managerAssignments/managerAssignmentRepository')

const input = {
  actorId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd',
  staffId: '45a79d36-1c70-4622-84d2-145a26f288d3',
  managerId: '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986',
}

function fakePool(handler) {
  const calls = []
  const client = {
    async query(sql, values) { calls.push({ sql, values }); return handler(sql, values, calls) },
    release() { calls.push({ sql: 'RELEASE' }) },
  }
  return { calls, pool: { connect: async () => client, query: async (...args) => client.query(...args) } }
}

test('assignManager_serializesByStaffAndAuditsAChangedAssignmentInOneTransaction', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('FROM employee_manager_assignments') && sql.includes('FOR UPDATE')) return { rows: [{ assignment_id: '00000000-0000-4000-8000-000000000001', manager_customer_id: '00000000-0000-4000-8000-000000000002' }] }
    if (sql.includes('INSERT INTO employee_manager_assignments')) return { rows: [{ assignment_id: '00000000-0000-4000-8000-000000000003', staff_customer_id: input.staffId, manager_customer_id: input.managerId }] }
    return { rows: [], rowCount: 1 }
  })
  const repository = createManagerAssignmentRepository({ pool })
  const result = await repository.assign(input)

  assert.equal(result.manager_customer_id, input.managerId)
  assert.ok(calls.findIndex((call) => call.sql === 'BEGIN') < calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock')))
  assert.ok(calls.some((call) => call.sql.includes('UPDATE employee_manager_assignments') && call.sql.includes('effective_to')))
  assert.ok(calls.some((call) => call.sql.includes("'manager_assignment.changed'")))
  assert.equal(calls.at(-1).sql, 'RELEASE')
})

test('assignManager_sameCurrentManagerIsIdempotentAndDoesNotAddAuditEvent', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('FROM employee_manager_assignments') && sql.includes('FOR UPDATE')) return { rows: [{ assignment_id: '00000000-0000-4000-8000-000000000003', manager_customer_id: input.managerId }] }
    return { rows: [], rowCount: 1 }
  })
  const repository = createManagerAssignmentRepository({ pool })
  const result = await repository.assign(input)

  assert.equal(result.assignment_id, '00000000-0000-4000-8000-000000000003')
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO audit_events')), false)
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO employee_manager_assignments')), false)
})

test('assignManager transfers unreviewed requests to the new manager with an audit event', async () => {
  const previousAssignmentId = '00000000-0000-4000-8000-000000000001'
  const newAssignmentId = '00000000-0000-4000-8000-000000000003'
  const requestId = '00000000-0000-4000-8000-000000000004'
  let routedUpdate
  let audit
  const { calls, pool } = fakePool((sql, values) => {
    if (sql.includes('FROM employee_manager_assignments') && sql.includes('FOR UPDATE')) return { rows: [{ assignment_id: previousAssignmentId, manager_customer_id: '00000000-0000-4000-8000-000000000002' }] }
    if (sql.includes('INSERT INTO employee_manager_assignments')) return { rows: [{ assignment_id: newAssignmentId, staff_customer_id: input.staffId, manager_customer_id: input.managerId }] }
    if (sql.includes('FROM expense_requests') && sql.includes('PENDING_MANAGER') && sql.includes('FOR UPDATE')) {
      return { rows: [{ request_id: requestId, manager_assignment_id: previousAssignmentId, reviewer_manager_customer_id: '00000000-0000-4000-8000-000000000002', status: 'PENDING_MANAGER' }] }
    }
    if (sql.includes('UPDATE expense_requests') && sql.includes('reviewer_manager_customer_id')) {
      routedUpdate = { sql, values }
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes("'request.manager_reassigned'")) audit = { sql, values }
    return { rows: [], rowCount: 1 }
  })
  const repository = createManagerAssignmentRepository({ pool })

  await repository.assign(input)

  assert.ok(calls.some((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('expense_requests')))
  const requestLock = calls.find((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('expense_requests'))
  assert.ok(requestLock.sql.includes("status = 'PENDING_MANAGER'"))
  assert.deepEqual(requestLock.values, [input.staffId, previousAssignmentId, '00000000-0000-4000-8000-000000000002'])
  assert.ok(routedUpdate.sql.includes("status = 'PENDING_MANAGER'"))
  assert.deepEqual(routedUpdate.values.slice(0, 4), [requestId, newAssignmentId, input.managerId, 'PENDING_MANAGER'])
  assert.ok(audit.sql.includes('INSERT INTO audit_events'))
  assert.deepEqual(audit.values.slice(0, 2), [input.actorId, requestId])
  assert.match(audit.values[2], /previous_manager_customer_id/)
  assert.equal(calls.at(-2).sql, 'COMMIT')
})

test('endManagerAssignment routes only unreviewed requests to admin and audits them', async () => {
  const assignmentId = '00000000-0000-4000-8000-000000000003'
  const requestId = '00000000-0000-4000-8000-000000000004'
  let routedUpdate
  let audit
  const { calls, pool } = fakePool((sql, values) => {
    if (sql.includes('SELECT staff_customer_id') && sql.includes('FROM employee_manager_assignments')) return { rows: [{ staff_customer_id: input.staffId }] }
    if (sql.includes('UPDATE employee_manager_assignments') && sql.includes('RETURNING')) return { rows: [{ assignment_id: assignmentId, staff_customer_id: input.staffId, manager_customer_id: input.managerId }] }
    if (sql.includes('FROM expense_requests') && sql.includes('PENDING_MANAGER') && sql.includes('FOR UPDATE')) {
      return { rows: [{ request_id: requestId, manager_assignment_id: assignmentId, reviewer_manager_customer_id: input.managerId, status: 'PENDING_MANAGER' }] }
    }
    if (sql.includes('UPDATE expense_requests') && values?.[3] === 'PENDING_ADMIN') {
      routedUpdate = { sql, values }
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes("'request.manager_reassigned'")) audit = { sql, values }
    return { rows: [], rowCount: 1 }
  })
  const repository = createManagerAssignmentRepository({ pool })

  await repository.end({ actorId: input.actorId, assignmentId })

  assert.ok(calls.some((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('expense_requests')))
  const requestLock = calls.find((call) => call.sql.includes('FOR UPDATE') && call.sql.includes('expense_requests'))
  assert.ok(requestLock.sql.includes("status = 'PENDING_MANAGER'"))
  assert.deepEqual(requestLock.values, [input.staffId, assignmentId, input.managerId])
  assert.ok(routedUpdate.sql.includes('reviewer_manager_customer_id = $3'))
  assert.deepEqual(routedUpdate.values.slice(0, 4), [requestId, null, null, 'PENDING_ADMIN'])
  assert.ok(audit.sql.includes('INSERT INTO audit_events'))
  assert.deepEqual(audit.values.slice(0, 2), [input.actorId, requestId])
  assert.match(audit.values[2], /status/)
  assert.equal(calls.at(-2).sql, 'COMMIT')
})

test('endManagerAssignment_onlyEndsCurrentAssignmentsAndAuditsTheChange', async () => {
  const assignmentId = '00000000-0000-4000-8000-000000000003'
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('SELECT staff_customer_id') && sql.includes('FROM employee_manager_assignments')) return { rows: [{ staff_customer_id: input.staffId }] }
    if (sql.includes('UPDATE employee_manager_assignments') && sql.includes('RETURNING')) return { rows: [{ assignment_id: assignmentId, staff_customer_id: input.staffId, manager_customer_id: input.managerId }] }
    return { rows: [], rowCount: 1 }
  })
  const repository = createManagerAssignmentRepository({ pool })
  const result = await repository.end({ actorId: input.actorId, assignmentId })

  assert.equal(result.assignment_id, assignmentId)
  assert.ok(calls.some((call) => call.sql.includes('pg_advisory_xact_lock')))
  assert.ok(calls.some((call) => call.sql.includes("'manager_assignment.ended'")))
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
})
