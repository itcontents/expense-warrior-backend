const { PaymentLinkError } = require('./paymentLinkService')

function createPaymentLinkRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required')
  return Object.freeze({
    async getPublicLink(tokenHash) {
      const result = await pool.query(`
        SELECT payment_link_id, amount::text, currency, description, status,
               collection_target_type, revenue_account_code, customer_id, receivable_id
          FROM payment_links
         WHERE public_token_hash = $1 AND status = 'ACTIVE' AND collection_target_type <> 'UNCONFIGURED'
           AND NOT (payment_links.collection_target_type = 'AR_SETTLEMENT' AND EXISTS (
             SELECT 1 FROM payment_link_receivable_closures c WHERE c.receivable_id = payment_links.receivable_id
           ))
         LIMIT 1
      `, [tokenHash])
      return result.rows[0] || null
    },
    async getAttemptByIdempotency(tokenHash, idempotencyKey) {
      const result = await pool.query(`
        SELECT a.attempt_id, a.payment_link_id, a.request_fingerprint, a.provider_code,
               a.provider_transaction_id, a.network_code, a.network_label, a.payer_phone, a.amount::text, a.currency,
               a.state, a.provider_status, a.provider_reference, a.created_at, a.updated_at,
               a.verified_at, a.ledger_operation_id, a.provider_evidence_digest,
               a.provider_account_id, a.provider_account_version,
               a.receivable_reservation_id, a.receivable_reservation_state,
               l.public_token_hash, l.description, l.collection_target_type, l.revenue_account_code,
               l.customer_id, l.receivable_id, l.created_by_customer_id
          FROM payment_link_attempts a
          JOIN payment_links l ON l.payment_link_id = a.payment_link_id
         WHERE l.public_token_hash = $1 AND a.idempotency_key = $2
         LIMIT 1
      `, [tokenHash, idempotencyKey])
      return result.rows[0] || null
    },
    async createAttempt(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const linkResult = await client.query(`
          SELECT payment_link_id, amount::text, currency, description,
                 collection_target_type, revenue_account_code, customer_id, receivable_id,
                 created_by_customer_id
            FROM payment_links
           WHERE public_token_hash = $1 AND status = 'ACTIVE' AND collection_target_type <> 'UNCONFIGURED'
             AND NOT (payment_links.collection_target_type = 'AR_SETTLEMENT' AND EXISTS (
               SELECT 1 FROM payment_link_receivable_closures c WHERE c.receivable_id = payment_links.receivable_id
             ))
           FOR SHARE
        `, [input.tokenHash])
        const link = linkResult.rows[0]
        if (!link) throw new PaymentLinkError('PAYMENT_LINK_NOT_AVAILABLE', 404)
        const priorResult = await client.query(`
          SELECT attempt_id, payment_link_id, request_fingerprint, provider_code, provider_transaction_id, network_code, network_label,
                 payer_phone, amount::text, currency, state, provider_status, created_at, updated_at,
                 provider_account_id, provider_account_version, receivable_reservation_id, receivable_reservation_state
            FROM payment_link_attempts
           WHERE payment_link_id = $1 AND idempotency_key = $2
           FOR UPDATE
        `, [link.payment_link_id, input.idempotencyKey])
        const prior = priorResult.rows[0]
        if (prior) {
          if (prior.request_fingerprint !== input.requestFingerprint) throw new PaymentLinkError('IDEMPOTENCY_CONFLICT', 409)
          await client.query('COMMIT')
          return { link, attempt: prior, replayed: true }
        }

        const inserted = await client.query(`
          INSERT INTO payment_link_attempts (
            attempt_id, payment_link_id, idempotency_key, request_fingerprint,
            provider_code, provider_transaction_id, network_code, network_label, payer_phone,
            amount, currency, state, provider_account_id, provider_account_version,
            receivable_reservation_id, receivable_reservation_state
          ) VALUES ($1::uuid,$2,$3,$4,$5,$1::uuid,$6,$7,$8,$9,$10,'SUBMITTING',$11,$12,
                    CASE WHEN $13::text = 'AR_SETTLEMENT' THEN $1::uuid ELSE NULL END,
                    CASE WHEN $13 = 'AR_SETTLEMENT' THEN 'PENDING' ELSE NULL END)
          RETURNING attempt_id, payment_link_id, provider_code, provider_transaction_id, network_code, network_label,
                    payer_phone, amount::text, currency, state, provider_status, created_at, updated_at,
                    provider_account_id, provider_account_version, receivable_reservation_id, receivable_reservation_state
        `, [input.attemptId, link.payment_link_id, input.idempotencyKey, input.requestFingerprint,
          input.providerCode, input.networkCode, input.networkLabel, input.phoneNumber, link.amount, link.currency,
          input.providerAccountId || null, input.providerAccountVersion || null, link.collection_target_type])
        await client.query('COMMIT')
        return { link, attempt: inserted.rows[0], replayed: false }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error instanceof PaymentLinkError) throw error
        if (error?.code === '23505') throw new PaymentLinkError('IDEMPOTENCY_CONFLICT', 409)
        throw new PaymentLinkError('PAYMENT_ATTEMPT_UNAVAILABLE')
      } finally { client.release() }
    },
    async getPublicAttempt(tokenHash, attemptId) {
      const result = await pool.query(`
        SELECT a.attempt_id, a.provider_code, a.provider_transaction_id, a.network_code, a.network_label, a.payer_phone,
               a.amount::text, a.currency, a.state, a.provider_status, a.provider_reference,
               a.created_at, a.updated_at, a.verified_at, a.ledger_operation_id,
               a.provider_evidence_digest,
               a.provider_account_id, a.provider_account_version,
               a.receivable_reservation_id, a.receivable_reservation_state,
               a.payment_link_id, l.public_token_hash, l.description,
               l.collection_target_type, l.revenue_account_code, l.customer_id, l.receivable_id,
               l.created_by_customer_id
          FROM payment_link_attempts a
          JOIN payment_links l ON l.payment_link_id = a.payment_link_id
         WHERE a.attempt_id = $1 AND l.public_token_hash = $2
         LIMIT 1
      `, [attemptId, tokenHash])
      return result.rows[0] || null
    },
    async updateAttempt(attemptId, { state, providerStatus, providerReference = null, errorCode = null, verified = false, evidenceDigest = null }) {
      const result = await pool.query(`
        UPDATE payment_link_attempts
           SET state = $2,
               provider_status = COALESCE($3, provider_status),
               provider_reference = COALESCE($4, provider_reference),
               last_error_code = $5,
               verified_at = CASE WHEN $6 THEN COALESCE(verified_at, transaction_timestamp()) ELSE verified_at END,
               provider_evidence_digest = COALESCE($7, provider_evidence_digest),
               updated_at = transaction_timestamp()
         WHERE attempt_id = $1 AND state IN ('SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFIED_PENDING_LEDGER')
        RETURNING attempt_id, provider_code, provider_transaction_id, network_code, payer_phone,
                  amount::text, currency, state, provider_status, provider_reference,
                  created_at, updated_at, verified_at, ledger_operation_id, provider_evidence_digest
                  , provider_account_id, provider_account_version, receivable_reservation_id, receivable_reservation_state
      `, [attemptId, state, providerStatus, providerReference, errorCode, verified, evidenceDigest])
      if (!result.rows[0]) {
        const current = await pool.query(`
          SELECT attempt_id, provider_code, provider_transaction_id, network_code, payer_phone,
                 amount::text, currency, state, provider_status, created_at, updated_at,
                 verified_at, ledger_operation_id, provider_evidence_digest
                 , provider_account_id, provider_account_version, receivable_reservation_id, receivable_reservation_state
            FROM payment_link_attempts WHERE attempt_id = $1 LIMIT 1
        `, [attemptId])
        if (!current.rows[0]) throw new PaymentLinkError('PAYMENT_ATTEMPT_UNAVAILABLE')
        return current.rows[0]
      }
      return result.rows[0]
    },
    async updateReceivableReservationState(attemptId, state) {
      if (!['PENDING', 'UNKNOWN', 'ACTIVE', 'RELEASED', 'APPLIED'].includes(state)) throw new PaymentLinkError('PAYMENT_COLLECTION_STATE_CONFLICT', 409)
      const result = await pool.query(`UPDATE payment_link_attempts
        SET receivable_reservation_state = $2, updated_at = transaction_timestamp()
        WHERE attempt_id = $1 AND receivable_reservation_id = $1 AND receivable_reservation_state <> 'APPLIED'
        RETURNING attempt_id, receivable_reservation_id, receivable_reservation_state`, [attemptId, state])
      if (!result.rows[0]) throw new PaymentLinkError('PAYMENT_COLLECTION_STATE_CONFLICT', 409)
      return result.rows[0]
    },
    async markAttemptSucceeded(attemptId, operationId) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          UPDATE payment_link_attempts
             SET state = 'SUCCEEDED', ledger_operation_id = $2, updated_at = transaction_timestamp()
           WHERE attempt_id = $1 AND state = 'VERIFIED_PENDING_LEDGER'
        `, [attemptId, operationId])
        const attempt = (await client.query(`
          SELECT a.attempt_id, a.payment_link_id, a.provider_code, a.provider_transaction_id,
                 a.network_code, a.payer_phone, a.amount::text, a.currency, a.state,
                 a.provider_status, a.provider_reference, a.created_at, a.updated_at,
                 a.verified_at, a.ledger_operation_id, a.provider_evidence_digest,
                 a.receivable_reservation_id, a.receivable_reservation_state,
                 l.collection_target_type, l.receivable_id, l.created_by_customer_id
            FROM payment_link_attempts a JOIN payment_links l ON l.payment_link_id = a.payment_link_id
           WHERE a.attempt_id = $1 FOR UPDATE OF a
        `, [attemptId])).rows[0]
        if (!attempt || attempt.state !== 'SUCCEEDED' || attempt.ledger_operation_id !== operationId) {
          throw new PaymentLinkError('PAYMENT_COLLECTION_STATE_CONFLICT', 409)
        }
        if (attempt.collection_target_type === 'AR_SETTLEMENT') {
          const closure = await client.query(`
            INSERT INTO payment_link_receivable_closures (payment_link_id, receivable_id, collection_operation_id)
            SELECT payment_link_id, receivable_id, $2 FROM payment_links
             WHERE collection_target_type = 'AR_SETTLEMENT' AND receivable_id = $1
            ON CONFLICT (payment_link_id) DO NOTHING
          `, [attempt.receivable_id, operationId])
          const conflictingClosure = await client.query(`
            SELECT 1 FROM payment_link_receivable_closures c
            JOIN payment_links l ON l.payment_link_id = c.payment_link_id
            WHERE l.receivable_id = $1 AND (c.receivable_id <> $1 OR c.collection_operation_id <> $2)
            LIMIT 1
          `, [attempt.receivable_id, operationId])
          if (conflictingClosure.rows.length) throw new PaymentLinkError('PAYMENT_COLLECTION_STATE_CONFLICT', 409)
          await client.query(`UPDATE payment_link_attempts SET receivable_reservation_state = 'APPLIED'
            WHERE receivable_reservation_id = $1`, [attempt.attempt_id])
          if (closure.rowCount > 0) {
            await client.query(`INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
              VALUES ($1, 'payment_link.receivable_settled', 'receivable', $2, $3::jsonb)`,
            [attempt.created_by_customer_id, attempt.receivable_id, JSON.stringify({ collection_operation_id: operationId, closed_link_count: closure.rowCount })])
          }
        }
        await client.query('COMMIT')
        return attempt
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error instanceof PaymentLinkError) throw error
        throw new PaymentLinkError('PAYMENT_COLLECTION_STATE_CONFLICT', 409)
      } finally { client.release() }
    },
    async create({ amount, description, target, tokenHash, idempotencyKey, requestFingerprint, actorCustomerId }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const priorResult = await client.query(`
          SELECT i.request_fingerprint, l.payment_link_id, l.amount::text, l.currency, l.description,
                 l.status, l.created_at, l.collection_target_type, l.revenue_account_code,
                 l.customer_id, l.receivable_id
            FROM payment_link_creation_requests i
            JOIN payment_links l ON l.payment_link_id = i.payment_link_id
           WHERE i.actor_customer_id = $1 AND i.idempotency_key = $2
           FOR UPDATE OF i
        `, [actorCustomerId, idempotencyKey])
        const prior = priorResult.rows[0]
        if (prior) {
          if (prior.request_fingerprint !== requestFingerprint) throw new PaymentLinkError('IDEMPOTENCY_CONFLICT', 409)
          await client.query('COMMIT')
          const { request_fingerprint: _fingerprint, ...link } = prior
          return { link, replayed: true }
        }
        const result = await client.query(`
          INSERT INTO payment_links (
            amount, currency, description, public_token_hash, status, created_by_customer_id,
            collection_target_type, revenue_account_code, customer_id, receivable_id
          ) VALUES ($1, 'ZMW', $2, $3, 'ACTIVE', $4, $5, $6, $7, $8)
          RETURNING payment_link_id, amount::text, currency, description, status, created_at,
                    collection_target_type, revenue_account_code, customer_id, receivable_id
        `, [amount, description, tokenHash, actorCustomerId, target.type,
          target.revenueAccountCode || null, target.customerId || null, target.receivableId || null])
        const link = result.rows[0]
        await client.query(`
          INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
          VALUES ($1, 'payment_link.created', 'payment_link', $2, $3::jsonb)
        `, [actorCustomerId, link.payment_link_id, JSON.stringify({
          amount: link.amount, currency: link.currency, collection_target_type: target.type,
          revenue_account_code: target.revenueAccountCode || null, customer_id: target.customerId || null,
          receivable_id: target.receivableId || null,
        })])
        await client.query(`
          INSERT INTO payment_link_creation_requests (actor_customer_id, idempotency_key, request_fingerprint, payment_link_id)
          VALUES ($1, $2, $3, $4)
        `, [actorCustomerId, idempotencyKey, requestFingerprint, link.payment_link_id])
        await client.query('COMMIT')
        return { link, replayed: false }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error instanceof PaymentLinkError) throw error
        if (error?.code === '23505') {
          const priorResult = await pool.query(`
            SELECT i.request_fingerprint, l.payment_link_id, l.amount::text, l.currency, l.description,
                   l.status, l.created_at, l.collection_target_type, l.revenue_account_code,
                   l.customer_id, l.receivable_id
              FROM payment_link_creation_requests i
              JOIN payment_links l ON l.payment_link_id = i.payment_link_id
             WHERE i.actor_customer_id = $1 AND i.idempotency_key = $2
             LIMIT 1
          `, [actorCustomerId, idempotencyKey]).catch(() => ({ rows: [] }))
          const prior = priorResult.rows[0]
          if (prior) {
            if (prior.request_fingerprint !== requestFingerprint) throw new PaymentLinkError('IDEMPOTENCY_CONFLICT', 409)
            const { request_fingerprint: _fingerprint, ...link } = prior
            return { link, replayed: true }
          }
        }
        throw new PaymentLinkError('PAYMENT_LINK_CREATE_UNAVAILABLE')
      } finally { client.release() }
    },
    async list({ limit = 50, offset = 0 } = {}) {
      const result = await pool.query(`
        SELECT l.payment_link_id, l.amount::text, l.currency, l.description, l.status, l.created_at, l.disabled_at,
               l.collection_target_type, l.revenue_account_code, l.customer_id, l.receivable_id,
               (SELECT min(c.settled_at) FROM payment_link_receivable_closures c
                 WHERE c.receivable_id = l.receivable_id) AS settled_at
          FROM payment_links l
         ORDER BY l.created_at DESC, l.payment_link_id DESC
         LIMIT $1 OFFSET $2
      `, [limit, offset])
      return { items: result.rows }
    },
    async disable(linkId, actorCustomerId) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const existing = await client.query(`
          SELECT payment_link_id, amount::text, currency, description, status, created_at, disabled_at,
                 collection_target_type, revenue_account_code, customer_id, receivable_id
            FROM payment_links WHERE payment_link_id = $1 FOR UPDATE
        `, [linkId])
        if (!existing.rows[0]) throw new PaymentLinkError('PAYMENT_LINK_NOT_FOUND', 404)
        let link = existing.rows[0]
        if (link.status === 'ACTIVE') {
          const result = await client.query(`
            UPDATE payment_links
               SET status = 'DISABLED', disabled_at = transaction_timestamp(), disabled_by_customer_id = $2
             WHERE payment_link_id = $1
            RETURNING payment_link_id, amount::text, currency, description, status, created_at, disabled_at,
                      collection_target_type, revenue_account_code, customer_id, receivable_id
          `, [linkId, actorCustomerId])
          link = result.rows[0]
          await client.query(`
            INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
            VALUES ($1, 'payment_link.disabled', 'payment_link', $2, '{}'::jsonb)
          `, [actorCustomerId, linkId])
        }
        await client.query('COMMIT')
        return { link }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error instanceof PaymentLinkError) throw error
        throw new PaymentLinkError('PAYMENT_LINK_DISABLE_UNAVAILABLE')
      } finally { client.release() }
    },
  })
}

module.exports = { createPaymentLinkRepository }
