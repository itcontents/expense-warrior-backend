const SOURCE_ONLY_COLUMNS = Object.freeze({
  staff_payout_destinations: `
    ADD COLUMN provider_code varchar(32) NOT NULL DEFAULT 'pawapay',
    ADD CONSTRAINT staff_payout_destinations_provider_code_test_check
      CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$')
  `,
  expense_requests: `
    ADD COLUMN payout_provider_code varchar(32),
    ADD COLUMN payout_provider_account_id uuid,
    ADD COLUMN payout_provider_account_version integer,
    ADD CONSTRAINT expense_requests_payout_provider_account_pair_test_check CHECK (
      (payout_provider_account_id IS NULL AND payout_provider_account_version IS NULL)
      OR (payout_destination_id IS NOT NULL AND payout_provider_account_id IS NOT NULL
        AND payout_provider_account_version > 0)
    ),
    ADD CONSTRAINT expense_requests_payout_provider_snapshot_test_check CHECK (
      (payout_destination_id IS NULL AND payout_provider_code IS NULL)
      OR (payout_destination_id IS NOT NULL AND payout_provider_code ~ '^[a-z][a-z0-9_]{1,31}$')
    )
  `,
  request_payout_attempts: `
    ADD COLUMN provider_account_id uuid,
    ADD COLUMN provider_account_version integer,
    ADD COLUMN provider_network_label varchar(80),
    ADD CONSTRAINT request_payout_provider_account_pair_test_check CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    ),
    ADD CONSTRAINT request_payout_network_label_test_check
      CHECK (provider_network_label IS NULL OR length(btrim(provider_network_label)) BETWEEN 1 AND 80)
  `,
  payment_link_attempts: `
    ADD COLUMN provider_account_id uuid,
    ADD COLUMN provider_account_version integer,
    ADD COLUMN network_label varchar(80),
    ADD COLUMN receivable_reservation_id uuid,
    ADD COLUMN receivable_reservation_state text,
    ADD CONSTRAINT payment_link_receivable_reservation_state_test_check CHECK (
      receivable_reservation_state IS NULL OR receivable_reservation_state IN ('PENDING','UNKNOWN','ACTIVE','RELEASED','APPLIED')
    ),
    ADD CONSTRAINT payment_link_receivable_reservation_pair_test_check CHECK (
      (receivable_reservation_id IS NULL AND receivable_reservation_state IS NULL)
      OR (receivable_reservation_id IS NOT NULL AND receivable_reservation_state IS NOT NULL)
    ),
    ADD CONSTRAINT payment_link_provider_account_pair_test_check CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    ),
    ADD CONSTRAINT payment_link_network_label_test_check
      CHECK (network_label IS NULL OR length(btrim(network_label)) BETWEEN 1 AND 80)
  `,
})

// Mirror 0015 only on empty session-local tables; never execute the migration or
// its backfill against the persistent application schema.
const PAYOUT_RETRY_COLUMNS = `
  ADD COLUMN reservation_operation_id uuid UNIQUE,
  ADD COLUMN reservation_idempotency_key varchar(128) UNIQUE,
  ADD COLUMN reservation_hold_id uuid UNIQUE,
  ADD COLUMN reservation_state text
`
const PAYOUT_RETRY_CONSTRAINTS = `
  ADD CONSTRAINT request_payout_attempts_reservation_state_check CHECK (
    reservation_state IS NULL OR reservation_state IN ('PENDING','RESERVED','CONSUMED','RELEASED','FAILED','UNKNOWN')
  ),
  ADD CONSTRAINT request_payout_attempts_reservation_key_check CHECK (
    reservation_idempotency_key IS NULL OR length(btrim(reservation_idempotency_key)) BETWEEN 8 AND 128
  ),
  -- Permit an entirely absent snapshot for compatibility with the original writer.
  -- A populated snapshot must include the operation/key and the appropriate hold.
  ADD CONSTRAINT request_payout_attempts_reservation_identity_check CHECK (
    (reservation_state IS NULL AND reservation_operation_id IS NULL
      AND reservation_idempotency_key IS NULL AND reservation_hold_id IS NULL)
    OR (reservation_state IS NOT NULL AND reservation_operation_id IS NOT NULL
      AND reservation_idempotency_key IS NOT NULL AND (
        (reservation_state IN ('PENDING','UNKNOWN','FAILED') AND reservation_hold_id IS NULL)
        OR (reservation_state IN ('RESERVED','CONSUMED','RELEASED') AND reservation_hold_id IS NOT NULL)
      ))
  ),
  DROP CONSTRAINT request_payout_attempts_state_check,
  ADD CONSTRAINT request_payout_attempts_state_check CHECK (state IN (
    'RESERVING','SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED',
    'FAILED_PENDING_RELEASE','FAILED','PAID','RESERVATION_FAILED'
  )),
  ADD CONSTRAINT request_payout_attempts_reserving_check CHECK (
    state <> 'RESERVING' OR (reservation_state IS NOT NULL AND reservation_state IN ('PENDING','UNKNOWN'))
  ),
  ADD CONSTRAINT request_payout_attempts_reservation_failed_check CHECK (
    state <> 'RESERVATION_FAILED' OR (reservation_state IS NOT NULL AND reservation_state = 'FAILED')
  )
`

async function createTemporaryTables(client, tableNames) {
  for (const table of tableNames) {
    if (table === 'payment_link_receivable_closures') {
      await client.query(`CREATE TEMP TABLE payment_link_receivable_closures (
        payment_link_id uuid PRIMARY KEY, receivable_id uuid NOT NULL,
        collection_operation_id uuid NOT NULL,
        settled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        UNIQUE (payment_link_id, receivable_id, collection_operation_id)
      ) ON COMMIT PRESERVE ROWS`)
    } else {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`)
    }
  }

  // The local database intentionally does not have unapplied provider add-on
  // migrations. Mirror their additive columns on the session-local test tables.
  for (const table of tableNames) {
    const additions = SOURCE_ONLY_COLUMNS[table]
    if (additions) await client.query(`ALTER TABLE pg_temp.${table} ${additions}`)
    if (table === 'request_payout_attempts') {
      // LIKE INCLUDING ALL gives copied unique constraints generated names.
      // Resolve exactly the copied single-column request uniqueness constraint.
      const constraints = await client.query(`
        SELECT constraint_row.conname
          FROM pg_constraint constraint_row
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attname = 'request_id'
         WHERE constraint_row.conrelid = 'pg_temp.request_payout_attempts'::regclass
           AND constraint_row.contype = 'u'
           AND constraint_row.conkey = ARRAY[attribute.attnum]::smallint[]
      `)
      if (constraints.rows.length !== 1) throw new Error('Expected one copied payout request unique constraint')
      const constraintName = constraints.rows[0].conname.replace(/"/g, '""')
      await client.query(`ALTER TABLE pg_temp.request_payout_attempts DROP CONSTRAINT "${constraintName}"`)
      await client.query(`ALTER TABLE pg_temp.request_payout_attempts ${PAYOUT_RETRY_COLUMNS}`)
      await client.query(`ALTER TABLE pg_temp.request_payout_attempts ${PAYOUT_RETRY_CONSTRAINTS}`)
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
  }
}

module.exports = { createTemporaryTables }
