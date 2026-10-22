const TABLE_NAME = /^[a-z][a-z0-9_]*$/
const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`

async function useRetryAttemptIndexes(client) {
  const result = await client.query(`
    SELECT index_class.relname AS index_name,
           constraint_row.conname AS constraint_name
      FROM pg_index index_row
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_attribute request_id
        ON request_id.attrelid = index_row.indrelid
       AND request_id.attname = 'request_id'
       AND request_id.attnum = index_row.indkey[0]
      LEFT JOIN pg_constraint constraint_row
        ON constraint_row.conindid = index_row.indexrelid
     WHERE index_row.indrelid = 'pg_temp.request_payout_attempts'::regclass
       AND index_row.indisunique
       AND index_row.indnkeyatts = 1
  `)

  for (const row of result.rows) {
    if (row.constraint_name) {
      await client.query(`ALTER TABLE pg_temp.request_payout_attempts DROP CONSTRAINT ${quoteIdentifier(row.constraint_name)}`)
    } else {
      await client.query(`DROP INDEX pg_temp.${quoteIdentifier(row.index_name)}`)
    }
  }

  await client.query(`
    CREATE UNIQUE INDEX request_payout_attempts_one_active_test_idx
      ON pg_temp.request_payout_attempts (request_id)
      WHERE state IN ('RESERVING','SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE')
  `)
  await client.query(`
    CREATE INDEX request_payout_attempts_latest_test_idx
      ON pg_temp.request_payout_attempts (request_id, created_at DESC, payout_id DESC)
  `)
}

async function createTemporaryTables(client, tableNames) {
  for (const table of tableNames) {
    if (!TABLE_NAME.test(table)) throw new Error(`Invalid temporary test table name: ${table}`)

    if (table === 'payment_link_receivable_closures') {
      await client.query(`CREATE TEMP TABLE pg_temp.${table} (
        payment_link_id uuid PRIMARY KEY, receivable_id uuid NOT NULL,
        collection_operation_id uuid NOT NULL,
        settled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        UNIQUE (payment_link_id, receivable_id, collection_operation_id)
      ) ON COMMIT PRESERVE ROWS`)
      continue
    }

    // Clone the current migrated schema. Applying migration fragments here made
    // the fixture diverge from the database and duplicated columns after apply.
    // Temporary tables remain connection-local; the persistent schema is read only.
    await client.query(`CREATE TEMP TABLE pg_temp.${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`)
    if (table === 'request_payout_attempts') await useRetryAttemptIndexes(client)
  }
}

module.exports = { createTemporaryTables }
