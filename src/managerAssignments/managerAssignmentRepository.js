class ManagerAssignmentRepositoryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'ManagerAssignmentRepositoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

async function routePendingManagerRequests(client, {
  actorId,
  staffId,
  previousAssignment,
  nextAssignment = null,
}) {
  if (!previousAssignment?.assignment_id) return

  const pendingResult = await client.query(`
    SELECT request_id, status
      FROM expense_requests
     WHERE requester_customer_id = $1
       AND manager_assignment_id = $2
       AND reviewer_manager_customer_id = $3
       AND status = 'PENDING_MANAGER'
     ORDER BY request_id
     FOR UPDATE
  `, [staffId, previousAssignment.assignment_id, previousAssignment.manager_customer_id])

  for (const request of pendingResult.rows) {
    const status = nextAssignment ? 'PENDING_MANAGER' : 'PENDING_ADMIN'
    const updatedResult = await client.query(`
      UPDATE expense_requests
         SET manager_assignment_id = $2,
             reviewer_manager_customer_id = $3,
             status = $4,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
         AND manager_assignment_id = $5
         AND reviewer_manager_customer_id = $6
         AND status = 'PENDING_MANAGER'
       RETURNING request_id
    `, [
      request.request_id,
      nextAssignment?.assignment_id || null,
      nextAssignment?.manager_customer_id || null,
      status,
      previousAssignment.assignment_id,
      previousAssignment.manager_customer_id,
    ])
    if (!updatedResult.rowCount) continue

    const metadata = {
      staff_customer_id: staffId,
      previous_manager_customer_id: previousAssignment.manager_customer_id,
      manager_customer_id: nextAssignment?.manager_customer_id || null,
      previous_manager_assignment_id: previousAssignment.assignment_id,
      manager_assignment_id: nextAssignment?.assignment_id || null,
      previous_status: 'PENDING_MANAGER',
      status,
      routing_reason: nextAssignment ? 'manager_reassigned' : 'manager_assignment_ended',
    }
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
      VALUES ($1, 'request.manager_reassigned', 'expense_request', $2, $3::jsonb)
    `, [actorId, request.request_id, JSON.stringify(metadata)])
  }
}

async function assign({ pool, actorId, staffId, managerId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [staffId])
    const currentResult = await client.query(`
      SELECT assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id,
             effective_from, effective_to, created_at
        FROM employee_manager_assignments
       WHERE staff_customer_id = $1 AND effective_to IS NULL
       FOR UPDATE
    `, [staffId])
    const current = currentResult.rows[0] || null
    if (current?.manager_customer_id === managerId) {
      await client.query('COMMIT')
      return current
    }

    if (current) {
      await client.query(`
        UPDATE employee_manager_assignments
           SET effective_to = transaction_timestamp()
         WHERE assignment_id = $1 AND effective_to IS NULL
      `, [current.assignment_id])
    }

    const createdResult = await client.query(`
      INSERT INTO employee_manager_assignments
        (staff_customer_id, manager_customer_id, assigned_by_customer_id)
      VALUES ($1, $2, $3)
      RETURNING assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id,
                effective_from, effective_to, created_at
    `, [staffId, managerId, actorId])
    const created = createdResult.rows[0]
    await routePendingManagerRequests(client, {
      actorId,
      staffId,
      previousAssignment: current,
      nextAssignment: created,
    })
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
      VALUES ($1, 'manager_assignment.changed', 'manager_assignment', $2, $3::jsonb)
    `, [actorId, created.assignment_id, JSON.stringify({
      staff_customer_id: staffId,
      previous_manager_customer_id: current?.manager_customer_id || null,
      manager_customer_id: managerId,
    })])
    await client.query('COMMIT')
    return created
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function end({ pool, actorId, assignmentId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const subjectResult = await client.query(`
      SELECT staff_customer_id
        FROM employee_manager_assignments
       WHERE assignment_id = $1
    `, [assignmentId])
    const staffId = subjectResult.rows[0]?.staff_customer_id
    if (!staffId) {
      await client.query('COMMIT')
      return null
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [staffId])
    const endedResult = await client.query(`
      UPDATE employee_manager_assignments
         SET effective_to = transaction_timestamp()
       WHERE assignment_id = $1 AND effective_to IS NULL
       RETURNING assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id,
                 effective_from, effective_to, created_at
    `, [assignmentId])
    const ended = endedResult.rows[0]
    if (!ended) {
      await client.query('COMMIT')
      return null
    }
    await routePendingManagerRequests(client, {
      actorId,
      staffId: ended.staff_customer_id,
      previousAssignment: ended,
    })
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
      VALUES ($1, 'manager_assignment.ended', 'manager_assignment', $2, $3::jsonb)
    `, [actorId, assignmentId, JSON.stringify({ staff_customer_id: ended.staff_customer_id, manager_customer_id: ended.manager_customer_id })])
    await client.query('COMMIT')
    return ended
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function list(pool) {
  const result = await pool.query(`
    SELECT assignment_id, staff_customer_id, manager_customer_id, assigned_by_customer_id,
           effective_from, effective_to, created_at
      FROM employee_manager_assignments
     ORDER BY (effective_to IS NULL) DESC, effective_from DESC, assignment_id DESC
     LIMIT 500
  `)
  return { items: result.rows }
}

function createManagerAssignmentRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required')
  }
  return Object.freeze({
    list: () => list(pool),
    assign: (input) => assign({ pool, ...input }),
    end: (input) => end({ pool, ...input }),
  })
}

module.exports = { createManagerAssignmentRepository, ManagerAssignmentRepositoryError }
