function createReportRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL-compatible pool is required')
  return Object.freeze({
    async listRequestReport({ window, filters = {}, limit }) {
      const result = await pool.query(`
        SELECT r.request_id,
               r.requester_customer_id,
               category.name AS category_name,
               subcategory.name AS subcategory_name,
               r.amount::text AS amount,
               r.currency,
               r.status,
               r.submitted_at,
               decision.stage AS latest_decision_stage,
               decision.action AS latest_decision_action,
               decision.actor_customer_id AS latest_decision_actor_id,
               decision.created_at AS latest_decision_at
          FROM expense_requests r
          JOIN expense_categories category ON category.category_id = r.category_id
          LEFT JOIN expense_categories subcategory ON subcategory.category_id = r.subcategory_id
          LEFT JOIN LATERAL (
            SELECT stage, action, actor_customer_id, created_at
              FROM request_decisions
             WHERE request_id = r.request_id
             ORDER BY created_at DESC, decision_id DESC
             LIMIT 1
          ) decision ON true
         WHERE r.submitted_at >= $1 AND r.submitted_at < $2
           AND ($3::text IS NULL OR r.status = $3)
           AND ($4::uuid IS NULL OR r.category_id = $4 OR r.subcategory_id = $4)
         ORDER BY r.submitted_at DESC, r.request_id DESC
         LIMIT $5
      `, [window.start, window.end, filters.status || null, filters.categoryId || null, limit + 1])
      const hasMore = result.rows.length > limit
      return { items: hasMore ? result.rows.slice(0, limit) : result.rows, has_more: hasMore }
    },
    async listPaymentLinkCollectionReport({ window, limit }) {
      const result = await pool.query(`
        SELECT a.created_at,
               l.description,
               l.collection_target_type,
               a.amount::text AS amount,
               a.currency,
               a.state,
               a.provider_code,
               a.network_label,
               RIGHT(a.payer_phone, 4) AS payer_last_four,
               a.provider_reference,
               a.provider_transaction_id
          FROM payment_link_attempts a
          JOIN payment_links l ON l.payment_link_id = a.payment_link_id
         WHERE a.created_at >= $1 AND a.created_at < $2
         ORDER BY a.created_at DESC, a.attempt_id DESC
         LIMIT $3
      `, [window.start, window.end, limit + 1])
      const hasMore = result.rows.length > limit
      return { items: hasMore ? result.rows.slice(0, limit) : result.rows, has_more: hasMore }
    },
  })
}

module.exports = { createReportRepository }
