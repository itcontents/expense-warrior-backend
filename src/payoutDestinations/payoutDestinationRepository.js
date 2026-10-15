class PayoutDestinationRepositoryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'PayoutDestinationRepositoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function publicFields(row) {
  if (!row) return null
  return {
    destination_id: row.destination_id,
    staff_customer_id: row.staff_customer_id,
    network_code: row.network_code,
    phone_last4: row.phone_last4,
    created_at: row.created_at,
    superseded_at: row.superseded_at || null,
  }
}

function createPayoutDestinationRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required')
  }
  return Object.freeze({
    async assign({ actorId, staffId, networkCode, encrypted, fingerprint, last4 }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ew-payout-destination:${staffId}`])
        const currentResult = await client.query(`
          SELECT destination_id, staff_customer_id, network_code, phone_ciphertext, encryption_key_id,
                 phone_fingerprint, phone_last4, assigned_by_customer_id, created_at, superseded_at
            FROM staff_payout_destinations
           WHERE staff_customer_id = $1 AND superseded_at IS NULL
           FOR UPDATE
        `, [staffId])
        const current = currentResult.rows[0] || null
        if (current && current.network_code === networkCode && current.phone_fingerprint === fingerprint) {
          await client.query('COMMIT')
          return { destination: publicFields(current), changed: false }
        }
        if (current) {
          await client.query(`UPDATE staff_payout_destinations SET superseded_at = transaction_timestamp() WHERE destination_id = $1`, [current.destination_id])
        }
        const createdResult = await client.query(`
          INSERT INTO staff_payout_destinations
            (staff_customer_id, network_code, phone_ciphertext, encryption_key_id, phone_fingerprint,
             phone_last4, assigned_by_customer_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING destination_id, staff_customer_id, network_code, phone_last4, created_at, superseded_at
        `, [staffId, networkCode, encrypted.ciphertext, encrypted.keyId, fingerprint, last4, actorId])
        const created = createdResult.rows[0]
        await client.query(`
          INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
          VALUES ($1, 'payout_destination.assigned', 'staff_payout_destination', $2, $3::jsonb)
        `, [actorId, created.destination_id, JSON.stringify({ staff_customer_id: staffId, network_code: networkCode, phone_last4: last4 })])
        await client.query('COMMIT')
        return { destination: publicFields(created), changed: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },
    async listCurrent() {
      const result = await pool.query(`
        SELECT destination_id, staff_customer_id, network_code, phone_last4, created_at, superseded_at
          FROM staff_payout_destinations
         WHERE superseded_at IS NULL
         ORDER BY created_at DESC, destination_id DESC
         LIMIT 5000
      `)
      return result.rows.map(publicFields)
    },
    async getCurrentForStaff(staffId) {
      const result = await pool.query(`
        SELECT destination_id, staff_customer_id, network_code, phone_last4, created_at, superseded_at
          FROM staff_payout_destinations
         WHERE staff_customer_id = $1 AND superseded_at IS NULL
         LIMIT 1
      `, [staffId])
      return publicFields(result.rows[0])
    },
  })
}

module.exports = { createPayoutDestinationRepository, PayoutDestinationRepositoryError }
