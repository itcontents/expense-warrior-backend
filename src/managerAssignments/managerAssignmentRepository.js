class ManagerAssignmentRepositoryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'ManagerAssignmentRepositoryError'
    this.code = code
    this.statusCode = statusCode
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
