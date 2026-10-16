const crypto = require('node:crypto')

function createProviderBalanceRepository({ pool, idFactory = crypto.randomUUID } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required')
  }

  return Object.freeze({
    async recordBatch({ provider = 'pawapay', providerAccountId = null, providerAccountVersion = null, country = 'ZMB', balances, retrievedAt } = {}) {
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(String(provider || '')) || country !== 'ZMB' ||
          ((providerAccountId === null) !== (providerAccountVersion === null)) ||
          (providerAccountId !== null && (!/^[0-9a-f-]{36}$/i.test(String(providerAccountId)) || !Number.isSafeInteger(providerAccountVersion) || providerAccountVersion < 1)) ||
          !Array.isArray(balances) || balances.length > 100 || balances.some((row) =>
            !row || typeof row !== 'object' || row.currency !== 'ZMW' ||
            typeof row.balance !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(row.balance) ||
            (row.provider !== '' && !/^[A-Z0-9_]{1,40}$/.test(String(row.provider || '')))) ||
          !Number.isFinite(Date.parse(retrievedAt))) throw new TypeError('A validated provider balance snapshot is required')
      const snapshotBatchId = idFactory()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          INSERT INTO provider_balance_snapshot_batches (
            snapshot_batch_id, provider_code, provider_account_id, provider_account_version,
            country, retrieved_at, balance_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [snapshotBatchId, provider, providerAccountId, providerAccountVersion, country, retrievedAt, balances.length])
        for (const row of balances) {
          await client.query(`
            INSERT INTO provider_balance_snapshot_items (
              snapshot_batch_id, provider_code, network_code, currency, balance
            ) VALUES ($1,$2,$3,$4,$5)
          `, [snapshotBatchId, provider, row.provider || null, row.currency, row.balance])
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

    async listRecent({ limit = 50, providerCode = null } = {}) {
      if (providerCode !== null && !/^[a-z][a-z0-9_]{1,31}$/.test(String(providerCode))) {
        throw new TypeError('A valid provider code is required')
      }
      const result = await pool.query(`
        SELECT batch.snapshot_batch_id, batch.provider_code, batch.country,
               batch.provider_account_id, batch.provider_account_version,
               batch.retrieved_at, batch.balance_count,
               COALESCE(jsonb_agg(jsonb_build_object(
                 'network_code', item.network_code,
                 'currency', item.currency,
                 'balance', item.balance::text
               ) ORDER BY item.network_code) FILTER (WHERE item.snapshot_item_id IS NOT NULL), '[]'::jsonb) AS balances
          FROM provider_balance_snapshot_batches batch
          LEFT JOIN provider_balance_snapshot_items item USING (snapshot_batch_id)
         WHERE ($2::varchar IS NULL OR batch.provider_code = $2)
         GROUP BY batch.snapshot_batch_id
         ORDER BY batch.retrieved_at DESC, batch.snapshot_batch_id DESC
         LIMIT $1
      `, [limit, providerCode])
      return result.rows
    },
  })
}

module.exports = { createProviderBalanceRepository }
