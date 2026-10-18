const MIGRATION_POSTCONDITIONS = Object.freeze({
  '0001_expense_categories.sql': { relations: ['expense_categories', 'expense_categories_active_parent_idx'], columns: { expense_categories: ['category_id', 'parent_category_id', 'code', 'reason_required'] } },
  '0002_expense_requests.sql': { relations: ['employee_manager_assignments', 'expense_requests', 'expense_request_attachments', 'request_decisions', 'idempotency_records', 'audit_events', 'expense_requests_manager_queue_idx'], columns: { expense_requests: ['requester_customer_id', 'category_id', 'status', 'submitted_at'], expense_request_attachments: ['storage_key', 'sha256', 'uploader_customer_id'], request_decisions: ['stage', 'action', 'actor_customer_id'], idempotency_records: ['request_hash', 'response_json'], audit_events: ['metadata', 'created_at'] } },
  '0003_manager_finance_reservations.sql': { relations: ['expense_requests_finance_pending_idx'], columns: { expense_requests: ['finance_operation_id', 'finance_idempotency_key', 'finance_hold_id', 'finance_reservation_state'] } },
  '0004_admin_rejection_releases.sql': { relations: ['expense_requests_finance_release_pending_idx'], columns: { expense_requests: ['finance_release_operation_id', 'finance_release_idempotency_key', 'finance_release_state', 'finance_release_reason'] } },
  '0005_payment_links.sql': { relations: ['payment_links', 'payment_link_creation_requests', 'payment_link_attempts', 'payment_link_attempts_recovery_idx'], columns: { payment_links: ['public_token_hash', 'status', 'amount'], payment_link_creation_requests: ['request_fingerprint', 'payment_link_id'], payment_link_attempts: ['provider_transaction_id', 'network_code', 'state', 'ledger_operation_id'] } },
  '0006_request_report_indexes.sql': { relations: ['expense_requests_submitted_report_idx'] },
  '0007_staff_payout_destinations.sql': { relations: ['staff_payout_destinations', 'staff_payout_destinations_one_current_idx'], columns: { staff_payout_destinations: ['phone_ciphertext', 'phone_fingerprint', 'phone_last4'], expense_requests: ['payout_destination_id', 'payout_phone_ciphertext', 'payout_phone_last4'] }, triggers: [['staff_payout_destinations', 'staff_payout_destinations_append_only'], ['expense_requests', 'expense_request_payout_snapshot_immutable']] },
  '0008_provider_callback_inbox.sql': { relations: ['provider_callback_inbox', 'provider_callback_inbox_transaction_idx'], columns: { provider_callback_inbox: ['payload_sha256', 'signature_date', 'received_at'] }, triggers: [['provider_callback_inbox', 'provider_callback_inbox_append_only'], ['provider_callback_inbox', 'provider_callback_inbox_reject_truncate']] },
  '0009_expense_category_itc_mapping.sql': { columns: { expense_categories: ['itc_expense_category_code'], expense_requests: ['finance_expense_category_code', 'finance_expense_account_code'] } },
  '0010_staff_payout_execution.sql': { relations: ['request_payout_attempts', 'request_payout_attempts_recovery_idx'], columns: { request_payout_attempts: ['payout_id', 'request_id', 'consume_operation_id', 'consume_state', 'provider_transaction_reference'] } },
  '0011_provider_balance_snapshots.sql': { relations: ['provider_balance_snapshot_batches', 'provider_balance_snapshot_items', 'provider_balance_snapshot_items_network_unique_idx'], columns: { provider_balance_snapshot_batches: ['retrieved_at', 'balance_count'], provider_balance_snapshot_items: ['snapshot_batch_id', 'network_code', 'balance'] }, triggers: [['provider_balance_snapshot_batches', 'provider_balance_snapshot_batches_append_only'], ['provider_balance_snapshot_items', 'provider_balance_snapshot_items_append_only'], ['provider_balance_snapshot_batches', 'provider_balance_snapshot_batches_reject_truncate'], ['provider_balance_snapshot_items', 'provider_balance_snapshot_items_reject_truncate']] },
  '0012_payment_link_collection_targets.sql': { relations: ['payment_links_customer_target_idx', 'payment_links_receivable_target_idx'], columns: { payment_links: ['collection_target_type', 'revenue_account_code', 'customer_id', 'receivable_id'], payment_link_attempts: ['provider_evidence_digest'] } },
  '0013_payment_link_provider_account_snapshot.sql': { columns: { payment_link_attempts: ['provider_account_id', 'provider_account_version'] } },
  '0014_provider_addon_lifecycle.sql': { relations: ['provider_balance_snapshot_batches_account_recent_idx'], columns: { payment_link_attempts: ['network_label', 'provider_account_id', 'provider_account_version'], staff_payout_destinations: ['provider_code'], expense_requests: ['payout_provider_code', 'payout_provider_account_id'], request_payout_attempts: ['provider_account_id', 'provider_account_version', 'provider_network_label'], provider_callback_inbox: ['provider_account_id', 'provider_account_version'], provider_balance_snapshot_batches: ['provider_account_id', 'provider_account_version'] } },
  '0015_staff_payout_retries.sql': { relations: ['request_payout_attempts_one_active_idx', 'request_payout_attempts_latest_idx'], columns: { request_payout_attempts: ['reservation_operation_id', 'reservation_idempotency_key', 'reservation_hold_id', 'reservation_state'] } },
  '0016_payment_link_attempts_report_created_idx.sql': { relations: ['payment_link_attempts_report_created_idx'] },
})

async function verifyMigrationPostconditions(client, migrations) {
  const blockers = []
  const resultByName = new Map()
  const relationNames = new Set()
  const columnPairs = new Map()
  const triggerPairs = new Map()

  for (const migration of migrations) {
    const spec = MIGRATION_POSTCONDITIONS[migration.name]
    if (!spec) {
      blockers.push('MISSING_POSTCONDITION')
      resultByName.set(migration.name, { passed: false, presentCount: 0, totalCount: 0 })
      continue
    }
    for (const name of spec.relations || []) relationNames.add(name)
    for (const [table, columns] of Object.entries(spec.columns || {})) {
      for (const column of columns) columnPairs.set(`${table}.${column}`, { table, column })
    }
    for (const [table, name] of spec.triggers || []) triggerPairs.set(`${table}.${name}`, { table, name })
  }

  const foundRelations = new Set()
  if (relationNames.size) {
    const query = await client.query(`
      SELECT relation_name
      FROM unnest($1::text[]) AS required(relation_name)
      WHERE to_regclass(format('%I.%I', current_schema(), relation_name)) IS NOT NULL
    `, [[...relationNames]])
    for (const row of query.rows || []) foundRelations.add(row.relation_name)
  }

  const foundColumns = new Set()
  if (columnPairs.size) {
    const pairs = [...columnPairs.values()]
    const query = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          SELECT table_name, column_name FROM unnest($1::text[], $2::text[]) AS required(table_name, column_name)
        )
    `, [pairs.map(({ table }) => table), pairs.map(({ column }) => column)])
    for (const row of query.rows || []) foundColumns.add(`${row.table_name}.${row.column_name}`)
  }

  const foundTriggers = new Set()
  if (triggerPairs.size) {
    const pairs = [...triggerPairs.values()]
    const query = await client.query(`
      SELECT tbl.relname AS table_name, trg.tgname AS trigger_name
      FROM pg_catalog.pg_trigger trg
      JOIN pg_catalog.pg_class tbl ON tbl.oid = trg.tgrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = current_schema()
        AND NOT trg.tgisinternal
        AND (tbl.relname, trg.tgname) IN (
          SELECT table_name, trigger_name FROM unnest($1::text[], $2::text[]) AS required(table_name, trigger_name)
        )
    `, [pairs.map(({ table }) => table), pairs.map(({ name }) => name)])
    for (const row of query.rows || []) foundTriggers.add(`${row.table_name}.${row.trigger_name}`)
  }

  for (const migration of migrations) {
    const spec = MIGRATION_POSTCONDITIONS[migration.name]
    if (!spec) continue
    const checks = [
      ...(spec.relations || []).map((name) => foundRelations.has(name)),
      ...Object.entries(spec.columns || {}).flatMap(([table, columns]) => columns.map((column) => foundColumns.has(`${table}.${column}`))),
      ...(spec.triggers || []).map(([table, name]) => foundTriggers.has(`${table}.${name}`)),
    ]
    const passed = checks.length > 0 && checks.every(Boolean)
    const presentCount = checks.filter(Boolean).length
    resultByName.set(migration.name, { passed, presentCount, totalCount: checks.length })
    if (!passed) blockers.push('POSTCONDITION_FAILED')
  }

  return {
    verified: [...resultByName].map(([migration, result]) => ({ migration, ...result })),
    blockers: [...new Set(blockers)],
  }
}

module.exports = { MIGRATION_POSTCONDITIONS, verifyMigrationPostconditions }
