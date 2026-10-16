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
    ADD CONSTRAINT payment_link_provider_account_pair_test_check CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    ),
    ADD CONSTRAINT payment_link_network_label_test_check
      CHECK (network_label IS NULL OR length(btrim(network_label)) BETWEEN 1 AND 80)
  `,
})

async function createTemporaryTables(client, tableNames) {
  for (const table of tableNames) {
    await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`)
  }

  // The local database intentionally does not have unapplied provider add-on
  // migrations. Mirror their additive columns on the session-local test tables.
  for (const table of tableNames) {
    const additions = SOURCE_ONLY_COLUMNS[table]
    if (additions) await client.query(`ALTER TABLE pg_temp.${table} ${additions}`)
  }
}

module.exports = { createTemporaryTables }
