const crypto = require('node:crypto')

function createProviderBalanceRepository({ pool, idFactory = crypto.randomUUID } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required')
  }

  return Object.freeze({
    async recordBatch({ provider = 'pawapay', country = 'ZMB', balances, retrievedAt } = {}) {
      if (provider !== 'pawapay' || country !== 'ZMB' || !Array.isArray(balances) || balances.length > 100 ||
          !Number.isFinite(Date.parse(retrievedAt))) throw new TypeError('A validated provider balance snapshot is required')
      const snapshotBatchId = idFactory()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          INSERT INTO provider_balance_snapshot_batches (
            snapshot_batch_id, provider_code, country, retrieved_at, balance_count
          ) VALUES ($1,'pawapay','ZMB',$2,$3)
        `, [snapshotBatchId, retrievedAt, balances.length])
        for (const row of balances) {
          await client.query(`
            INSERT INTO provider_balance_snapshot_items (
              snapshot_batch_id, provider_code, network_code, currency, balance
            ) VALUES ($1,'pawapay',$2,'ZMW',$3)
          `, [snapshotBatchId, row.provider || null, row.balance])
        }
        await client.query('COMMIT')
        return { snapshotBatchId }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    async listRecent({ limit = 50 } = {}) {
      const result = await pool.query(`
        SELECT batch.snapshot_batch_id, batch.provider_code, batch.country,
               batch.retrieved_at, batch.balance_count,
               COALESCE(jsonb_agg(jsonb_build_object(
                 'network_code', item.network_code,
                 'currency', item.currency,
                 'balance', item.balance::text
               ) ORDER BY item.network_code) FILTER (WHERE item.snapshot_item_id IS NOT NULL), '[]'::jsonb) AS balances
          FROM provider_balance_snapshot_batches batch
          LEFT JOIN provider_balance_snapshot_items item USING (snapshot_batch_id)
         GROUP BY batch.snapshot_batch_id
         ORDER BY batch.retrieved_at DESC, batch.snapshot_batch_id DESC
         LIMIT $1
      `, [limit])
      return result.rows
    },
  })
}

module.exports = { createProviderBalanceRepository }
