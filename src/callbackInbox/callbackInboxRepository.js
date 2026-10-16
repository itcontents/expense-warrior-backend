function createCallbackInboxRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL-compatible pool is required')
  return Object.freeze({
    async append(event) {
      const result = await pool.query(`
        INSERT INTO provider_callback_inbox (
          provider_code, provider_account_id, provider_account_version,
          transaction_type, transaction_id, provider_status, provider_reference,
          payload_sha256, signature_key_id, signature_date
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (provider_code, payload_sha256) DO NOTHING
        RETURNING callback_event_id
      `, [event.provider_code, event.provider_account_id, event.provider_account_version,
        event.transaction_type, event.transaction_id, event.provider_status,
        event.provider_reference, event.payload_sha256, event.signature_key_id, event.signature_date])
      return result.rows[0]
        ? { inserted: true, eventId: result.rows[0].callback_event_id }
        : { inserted: false, eventId: null }
    },
  })
}

module.exports = { createCallbackInboxRepository }
