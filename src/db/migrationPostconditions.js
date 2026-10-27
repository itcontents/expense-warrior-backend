const runtimeTables = [
  'employee_manager_assignments', 'expense_categories', 'expense_request_attachments', 'expense_requests',
  'expense_warrior_schema_migrations', 'idempotency_records', 'audit_events', 'payment_link_attempts',
  'payment_link_creation_requests', 'payment_link_receivable_closures', 'payment_links',
  'provider_balance_snapshot_batches', 'provider_balance_snapshot_items', 'provider_callback_inbox',
  'request_decisions', 'request_payout_attempts', 'staff_payout_destinations',
]
const runtimeSelectTables = new Set([
  'employee_manager_assignments', 'expense_categories', 'expense_request_attachments', 'expense_requests',
  'idempotency_records', 'payment_link_attempts', 'payment_link_creation_requests',
  'payment_link_receivable_closures', 'payment_links', 'provider_balance_snapshot_batches',
  'provider_balance_snapshot_items', 'request_decisions', 'request_payout_attempts', 'staff_payout_destinations',
])
const runtimeInsertTables = new Set([
  'audit_events', 'employee_manager_assignments', 'expense_request_attachments', 'expense_requests',
  'idempotency_records', 'payment_link_attempts', 'payment_link_creation_requests',
  'payment_link_receivable_closures', 'payment_links', 'provider_balance_snapshot_batches',
  'provider_balance_snapshot_items', 'provider_callback_inbox', 'request_decisions',
  'request_payout_attempts', 'staff_payout_destinations',
])
const runtimeUpdateTables = new Set()
const runtimeColumnUpdates = Object.freeze({
  employee_manager_assignments: ['effective_to'],
  expense_categories: ['itc_expense_category_code', 'updated_at'],
  idempotency_records: ['resource_id', 'response_json', 'completed_at'],
  expense_requests: [
    'finance_operation_id', 'finance_idempotency_key', 'finance_reservation_state', 'finance_error_code',
    'finance_expense_category_code', 'finance_expense_account_code', 'payout_provider_account_id',
    'payout_provider_account_version', 'updated_at', 'status', 'finance_hold_id',
    'finance_release_operation_id', 'finance_release_idempotency_key', 'finance_release_state',
    'finance_release_actor_customer_id', 'finance_release_reason', 'finance_release_error_code',
    'manager_assignment_id', 'reviewer_manager_customer_id',
  ],
  payment_link_attempts: [
    'state', 'provider_status', 'provider_reference', 'last_error_code', 'verified_at',
    'provider_evidence_digest', 'updated_at', 'ledger_operation_id',
  ],
  payment_links: ['disabled_at', 'disabled_by_customer_id', 'status'],
  request_payout_attempts: [
    'state', 'reservation_hold_id', 'reservation_state', 'error_code', 'updated_at',
    'provider_status', 'provider_transaction_reference', 'verified_at', 'consume_state',
    'release_operation_id', 'release_idempotency_key', 'release_state', 'release_error_code',
  ],
  staff_payout_destinations: ['superseded_at'],
})
const runtimePrivileges = runtimeTables.flatMap((table) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((privilege) => ({
  table,
  role: 'expense_warrior_app',
  privilege,
  granted: privilege === 'SELECT' ? runtimeSelectTables.has(table)
    : privilege === 'INSERT' ? runtimeInsertTables.has(table)
      : privilege === 'UPDATE' ? runtimeUpdateTables.has(table)
        : false,
})))
const runtimeColumnPrivileges = runtimeTables.flatMap((table) => ['UPDATE'].flatMap((privilege) => {
  const grantedColumns = runtimeColumnUpdates[table] || []
  const knownColumns = table === 'employee_manager_assignments' ? ['effective_to', 'staff_customer_id']
    : table === 'expense_categories' ? ['itc_expense_category_code', 'updated_at', 'code']
      : table === 'idempotency_records' ? ['resource_id', 'response_json', 'completed_at', 'request_hash']
        : table === 'expense_requests' ? [...runtimeColumnUpdates.expense_requests, 'amount', 'requester_customer_id', 'payout_phone_ciphertext']
          : table === 'payment_link_attempts' ? [...runtimeColumnUpdates.payment_link_attempts, 'amount', 'provider_transaction_id', 'provider_account_id']
        : table === 'payment_links' ? ['disabled_at', 'disabled_by_customer_id', 'status', 'public_token_hash']
          : table === 'request_payout_attempts' ? [...runtimeColumnUpdates.request_payout_attempts, 'amount', 'payout_id', 'provider_account_id']
          : table === 'staff_payout_destinations' ? ['superseded_at', 'phone_ciphertext']
            : []
  return knownColumns.map((column) => ({ table, column, role: 'expense_warrior_app', privilege, granted: grantedColumns.includes(column) }))
}))

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
  '0015_staff_payout_retries.sql': {
    relations: ['request_payout_attempts_one_active_idx', 'request_payout_attempts_latest_idx'],
    columns: { request_payout_attempts: ['reservation_operation_id', 'reservation_idempotency_key', 'reservation_hold_id', 'reservation_state'] },
    indexes: [{
      name: 'request_payout_attempts_one_active_idx',
      table: 'request_payout_attempts',
      unique: true,
      keyDefinition: 'USING btree (request_id)',
      predicateValues: ['RESERVING', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE'],
    }],
    constraints: [
      { name: 'request_payout_attempts_reservation_state_check', literals: ['PENDING', 'RESERVED', 'CONSUMED', 'RELEASED', 'FAILED', 'UNKNOWN'], requiredTokens: ['reservation_state'] },
      { name: 'request_payout_attempts_reservation_key_check', requiredTokens: ['reservation_idempotency_key'], minimum: 8, maximum: 128 },
      { name: 'request_payout_attempts_reservation_identity_check', literals: ['PENDING', 'UNKNOWN', 'FAILED', 'RESERVED', 'CONSUMED', 'RELEASED'], requiredTokens: ['reservation_state', 'reservation_operation_id', 'reservation_idempotency_key', 'reservation_hold_id'] },
      { name: 'request_payout_attempts_state_check', literals: ['RESERVING', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE', 'FAILED', 'PAID', 'RESERVATION_FAILED'], requiredTokens: ['state'] },
      { name: 'request_payout_attempts_reserving_check', literals: ['RESERVING', 'PENDING', 'UNKNOWN'], requiredTokens: ['state', 'reservation_state'] },
      { name: 'request_payout_attempts_reservation_failed_check', literals: ['RESERVATION_FAILED', 'FAILED'], requiredTokens: ['state', 'reservation_state'] },
    ],
  },
  '0016_payment_link_attempts_report_created_idx.sql': { relations: ['payment_link_attempts_report_created_idx'] },
  '0017_payment_link_receivable_recovery.sql': {
    relations: ['payment_link_receivable_closures', 'payment_link_receivable_closures_receivable_idx'],
    triggers: [['payment_link_receivable_closures', 'payment_link_receivable_closures_append_only'], ['payment_link_receivable_closures', 'payment_link_receivable_closures_reject_truncate']],
    columns: { payment_link_attempts: ['receivable_reservation_id', 'receivable_reservation_state'], payment_link_receivable_closures: ['payment_link_id', 'receivable_id', 'collection_operation_id', 'settled_at'] },
    constraints: [
      { name: 'payment_link_attempts_receivable_reservation_state_check', literals: ['PENDING', 'UNKNOWN', 'ACTIVE', 'RELEASED', 'APPLIED'], requiredTokens: ['receivable_reservation_state'] },
      { name: 'payment_link_attempts_receivable_reservation_pair_check', requiredTokens: ['receivable_reservation_id', 'receivable_reservation_state'] },
    ],
    privileges: [
      { table: 'payment_link_receivable_closures', role: 'expense_warrior_app', privilege: 'SELECT', granted: true },
      { table: 'payment_link_receivable_closures', role: 'expense_warrior_app', privilege: 'INSERT', granted: true },
      { table: 'payment_link_receivable_closures', role: 'expense_warrior_app', privilege: 'UPDATE', granted: false },
      { table: 'payment_link_receivable_closures', role: 'expense_warrior_app', privilege: 'DELETE', granted: false },
      { table: 'payment_link_receivable_closures', role: 'expense_warrior_app', privilege: 'TRUNCATE', granted: false },
    ],
    indexes: [{ name: 'payment_link_receivable_closures_receivable_idx', table: 'payment_link_receivable_closures', unique: false, keyDefinition: 'USING btree (receivable_id, settled_at DESC, payment_link_id)', predicateValues: [] }],
  },
  '0018_runtime_role_permissions.sql': {
    relations: ['expense_warrior_schema_migrations'],
    roles: [{
      name: 'expense_warrior_app', canLogin: true, superuser: false, createDb: false, noMemberships: true,
      createRole: false, replication: false, bypassRls: false, inherit: false,
    }],
    databasePrivileges: [{ role: 'expense_warrior_app', privilege: 'CONNECT', granted: true }],
    schemaPrivileges: [
      { schema: 'public', role: 'expense_warrior_app', privilege: 'USAGE', granted: true },
      { schema: 'public', role: 'expense_warrior_app', privilege: 'CREATE', granted: false },
    ],
    privileges: runtimePrivileges,
    columnPrivileges: runtimeColumnPrivileges,
  },
})

async function verifyMigrationPostconditions(client, migrations) {
  const blockers = []
  const resultByName = new Map()
  const relationNames = new Set()
  const columnPairs = new Map()
  const triggerPairs = new Map()
  const indexNames = new Set()
  const criticalIndexes = new Map()
  const constraintSpecs = new Map()
  const privilegeChecks = new Map()
  const roleChecks = new Map()
  const databasePrivilegeChecks = new Map()
  const schemaPrivilegeChecks = new Map()
  const columnPrivilegeChecks = new Map()

  for (const migration of migrations) {
    const spec = MIGRATION_POSTCONDITIONS[migration.name]
    if (!spec) {
      blockers.push('MISSING_POSTCONDITION')
      resultByName.set(migration.name, { passed: false, presentCount: 0, totalCount: 0 })
      continue
    }
    for (const name of spec.relations || []) relationNames.add(name)
    for (const name of spec.relations || []) if (/(?:_idx|_index)$/.test(name)) indexNames.add(name)
    for (const index of spec.indexes || []) {
      indexNames.add(index.name)
      criticalIndexes.set(index.name, index)
    }
    for (const constraint of spec.constraints || []) constraintSpecs.set(constraint.name, constraint)
    for (const privilege of spec.privileges || []) {
      privilegeChecks.set(`${privilege.table}.${privilege.role}.${privilege.privilege}`, privilege)
    }
    for (const role of spec.roles || []) roleChecks.set(role.name, role)
    for (const privilege of spec.databasePrivileges || []) {
      databasePrivilegeChecks.set(`${privilege.role}.${privilege.privilege}`, privilege)
    }
    for (const privilege of spec.schemaPrivileges || []) {
      schemaPrivilegeChecks.set(`${privilege.schema}.${privilege.role}.${privilege.privilege}`, privilege)
    }
    for (const privilege of spec.columnPrivileges || []) {
      columnPrivilegeChecks.set(`${privilege.table}.${privilege.column}.${privilege.role}.${privilege.privilege}`, privilege)
    }
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
      SELECT relation.relname AS table_name, attribute.attname AS column_name
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (relation.relname, attribute.attname) IN (
          SELECT table_name, column_name FROM unnest($1::text[], $2::text[]) AS required(table_name, column_name)
        )
    `, [pairs.map(({ table }) => table), pairs.map(({ column }) => column)])
    for (const row of query.rows || []) foundColumns.add(`${row.table_name}.${row.column_name}`)
  }

  const foundTriggers = new Map()
  if (triggerPairs.size) {
    const pairs = [...triggerPairs.values()]
    const query = await client.query(`
      SELECT tbl.relname AS table_name, trg.tgname AS trigger_name, trg.tgenabled AS enabled_mode
      FROM pg_catalog.pg_trigger trg
      JOIN pg_catalog.pg_class tbl ON tbl.oid = trg.tgrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = current_schema()
        AND NOT trg.tgisinternal
        AND (tbl.relname, trg.tgname) IN (
          SELECT table_name, trigger_name FROM unnest($1::text[], $2::text[]) AS required(table_name, trigger_name)
        )
    `, [pairs.map(({ table }) => table), pairs.map(({ name }) => name)])
    for (const row of query.rows || []) foundTriggers.set(`${row.table_name}.${row.trigger_name}`, row.enabled_mode)
  }

  const foundIndexes = new Map()
  if (indexNames.size) {
    const query = await client.query(`
      SELECT idx.relname AS index_name,
             tbl.relname AS table_name,
             index_state.indisvalid AS index_valid,
             index_state.indisready AS index_ready,
             index_state.indisunique AS is_unique,
             pg_catalog.pg_get_indexdef(index_state.indexrelid) AS index_definition,
             pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate
      FROM pg_catalog.pg_index index_state
      JOIN pg_catalog.pg_class idx ON idx.oid = index_state.indexrelid
      JOIN pg_catalog.pg_class tbl ON tbl.oid = index_state.indrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = idx.relnamespace
      WHERE ns.nspname = current_schema()
        AND idx.relname = ANY($1::text[])
    `, [[...indexNames]])
    for (const row of query.rows || []) foundIndexes.set(row.index_name, row)
  }

  const foundConstraints = new Map()
  if (constraintSpecs.size) {
    const query = await client.query(`
      SELECT constraint_row.conname AS constraint_name,
             constraint_row.contype AS constraint_type,
             constraint_row.convalidated AS is_validated,
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class tbl ON tbl.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = current_schema()
        AND constraint_row.conname = ANY($1::text[])
    `, [[...constraintSpecs.keys()]])
    for (const row of query.rows || []) foundConstraints.set(row.constraint_name, row)
  }

  const foundPrivileges = new Map()
  if (privilegeChecks.size) {
    const privileges = [...privilegeChecks.values()]
    const query = await client.query(`
      SELECT required.table_name, required.role_name, required.privilege_type,
             CASE
               WHEN role.oid IS NULL OR to_regclass(format('%I.%I', current_schema(), required.table_name)) IS NULL THEN NULL
               ELSE has_table_privilege(role.oid,
                 format('%I.%I', current_schema(), required.table_name), required.privilege_type)
             END AS is_granted
      FROM unnest($1::text[], $2::text[], $3::text[]) AS required(table_name, role_name, privilege_type)
      LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.role_name
    `, [privileges.map(({ table }) => table), privileges.map(({ role }) => role), privileges.map(({ privilege }) => privilege)])
    for (const row of query.rows || []) {
      foundPrivileges.set(`${row.table_name}.${row.role_name}.${row.privilege_type}`, row.is_granted)
    }
  }

  const foundRoles = new Map()
  if (roleChecks.size) {
    const query = await client.query(`
      SELECT required.role_name,
             role.rolcanlogin AS can_login,
             role.rolsuper AS is_superuser,
             role.rolcreatedb AS can_create_database,
             role.rolcreaterole AS can_create_role,
             role.rolreplication AS can_replicate,
             role.rolbypassrls AS bypasses_row_security,
             role.rolinherit AS inherits_privileges,
             NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = role.oid
             ) AS has_no_memberships
      FROM unnest($1::text[]) AS required(role_name)
      LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.role_name
    `, [[...roleChecks.keys()]])
    for (const row of query.rows || []) foundRoles.set(row.role_name, row)
  }

  const foundDatabasePrivileges = new Map()
  if (databasePrivilegeChecks.size) {
    const privileges = [...databasePrivilegeChecks.values()]
    const query = await client.query(`
      SELECT required.role_name, required.privilege_type,
             CASE WHEN role.oid IS NULL THEN NULL
               ELSE has_database_privilege(role.oid, current_database(), required.privilege_type)
             END AS is_granted
      FROM unnest($1::text[], $2::text[]) AS required(role_name, privilege_type)
      LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.role_name
    `, [privileges.map(({ role }) => role), privileges.map(({ privilege }) => privilege)])
    for (const row of query.rows || []) foundDatabasePrivileges.set(`${row.role_name}.${row.privilege_type}`, row.is_granted)
  }

  const foundSchemaPrivileges = new Map()
  if (schemaPrivilegeChecks.size) {
    const privileges = [...schemaPrivilegeChecks.values()]
    const query = await client.query(`
      SELECT required.schema_name, required.role_name, required.privilege_type,
             CASE WHEN role.oid IS NULL THEN NULL
               ELSE has_schema_privilege(role.oid, required.schema_name, required.privilege_type)
             END AS is_granted
      FROM unnest($1::text[], $2::text[], $3::text[]) AS required(schema_name, role_name, privilege_type)
      LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.role_name
    `, [privileges.map(({ schema }) => schema), privileges.map(({ role }) => role), privileges.map(({ privilege }) => privilege)])
    for (const row of query.rows || []) foundSchemaPrivileges.set(`${row.schema_name}.${row.role_name}.${row.privilege_type}`, row.is_granted)
  }

  const foundColumnPrivileges = new Map()
  if (columnPrivilegeChecks.size) {
    const privileges = [...columnPrivilegeChecks.values()]
    const query = await client.query(`
      SELECT required.table_name, required.column_name, required.role_name, required.privilege_type,
             CASE
               WHEN role.oid IS NULL OR to_regclass(format('%I.%I', current_schema(), required.table_name)) IS NULL OR NOT EXISTS (
                 SELECT 1 FROM information_schema.columns column_row
                 WHERE column_row.table_schema = current_schema()
                   AND column_row.table_name = required.table_name
                   AND column_row.column_name = required.column_name
               ) THEN NULL
               ELSE has_column_privilege(role.oid,
                 format('%I.%I', current_schema(), required.table_name), required.column_name, required.privilege_type)
             END AS is_granted
      FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS required(table_name, column_name, role_name, privilege_type)
      LEFT JOIN pg_catalog.pg_roles role ON role.rolname = required.role_name
    `, [privileges.map(({ table }) => table), privileges.map(({ column }) => column), privileges.map(({ role }) => role), privileges.map(({ privilege }) => privilege)])
    for (const row of query.rows || []) {
      foundColumnPrivileges.set(`${row.table_name}.${row.column_name}.${row.role_name}.${row.privilege_type}`, row.is_granted)
    }
  }

  for (const migration of migrations) {
    const spec = MIGRATION_POSTCONDITIONS[migration.name]
    if (!spec) continue
    const checks = [
      ...(spec.relations || []).map((name) => ({ name: `relation:${name}`, passed: foundRelations.has(name) })),
      ...Object.entries(spec.columns || {}).flatMap(([table, columns]) => columns.map((column) => ({ name: `column:${table}.${column}`, passed: foundColumns.has(`${table}.${column}`) }))),
      ...(spec.triggers || []).map(([table, name]) => ({ name: `trigger:${table}.${name}`, passed: ['O', 'A'].includes(foundTriggers.get(`${table}.${name}`)) })),
      ...(spec.relations || []).filter((name) => indexNames.has(name)).map((name) => ({ name: `index:${name}`, passed: isHealthyIndex(foundIndexes.get(name), criticalIndexes.get(name)) })),
      ...(spec.indexes || []).filter((index) => !(spec.relations || []).includes(index.name)).map((index) => ({ name: `index:${index.name}`, passed: isHealthyIndex(foundIndexes.get(index.name), index) })),
      ...(spec.constraints || []).map((constraint) => ({ name: `constraint:${constraint.name}`, passed: isHealthyConstraint(foundConstraints.get(constraint.name), constraint) })),
      ...(spec.privileges || []).map((privilege) => ({ name: `privilege:${privilege.table}.${privilege.role}.${privilege.privilege}`, passed: foundPrivileges.get(`${privilege.table}.${privilege.role}.${privilege.privilege}`) === privilege.granted })),
      ...(spec.roles || []).flatMap((role) => {
        const actual = foundRoles.get(role.name)
        return [
          ['can_login', role.canLogin], ['is_superuser', role.superuser],
          ['can_create_database', role.createDb], ['can_create_role', role.createRole],
          ['can_replicate', role.replication], ['bypasses_row_security', role.bypassRls],
          ['inherits_privileges', role.inherit], ['has_no_memberships', role.noMemberships],
        ].map(([attribute, expected]) => ({
          name: `role:${role.name}:${attribute}`,
          passed: Boolean(actual) && actual[attribute] === expected,
        }))
      }),
      ...(spec.databasePrivileges || []).map((privilege) => ({ name: `database-privilege:${privilege.role}.${privilege.privilege}`, passed: foundDatabasePrivileges.get(`${privilege.role}.${privilege.privilege}`) === privilege.granted })),
      ...(spec.schemaPrivileges || []).map((privilege) => ({ name: `schema-privilege:${privilege.schema}.${privilege.role}.${privilege.privilege}`, passed: foundSchemaPrivileges.get(`${privilege.schema}.${privilege.role}.${privilege.privilege}`) === privilege.granted })),
      ...(spec.columnPrivileges || []).map((privilege) => ({ name: `column-privilege:${privilege.table}.${privilege.column}.${privilege.role}.${privilege.privilege}`, passed: foundColumnPrivileges.get(`${privilege.table}.${privilege.column}.${privilege.role}.${privilege.privilege}`) === privilege.granted })),
    ]
    const passed = checks.length > 0 && checks.every(({ passed: checkPassed }) => checkPassed)
    const presentCount = checks.filter(({ passed: checkPassed }) => checkPassed).length
    resultByName.set(migration.name, { passed, presentCount, totalCount: checks.length, failedChecks: checks.filter(({ passed: checkPassed }) => !checkPassed).map(({ name }) => name) })
    if (!passed) blockers.push('POSTCONDITION_FAILED')
  }

  return {
    verified: [...resultByName].map(([migration, result]) => ({ migration, ...result })),
    blockers: [...new Set(blockers)],
  }
}

function isHealthyIndex(row, spec) {
  if (!row || row.index_valid !== true || row.index_ready !== true) return false
  if (!spec) return true
  if (row.table_name !== spec.table || row.is_unique !== spec.unique) return false
  if (spec.keyDefinition && !String(row.index_definition || '').includes(spec.keyDefinition)) return false
  const actualPredicate = predicateValues(row.predicate)
  const expectedPredicate = [...(spec.predicateValues || [])].sort()
  return expectedPredicate.length === 0
    ? actualPredicate === null
    : actualPredicate?.join('\u0000') === expectedPredicate.join('\u0000')
}

function predicateValues(predicate) {
  if (typeof predicate !== 'string' || !predicate.trim()) return null
  let source = predicate.trim().toLowerCase()
  while (hasSingleOuterParentheses(source)) source = source.slice(1, -1).trim()
  const anyMatch = source.match(/^state\s*=\s*any\s*\(\s*array\s*\[(.*)\]\s*\)$/)
  const inMatch = source.match(/^state\s+in\s*\((.*)\)$/)
  const body = anyMatch?.[1] ?? inMatch?.[1]
  if (body === undefined) return null
  const values = [...body.matchAll(/'((?:[^']|'')*)'(?:\s*::\s*[a-z ]+)?/g)].map((match) => match[1].replaceAll("''", "'").toUpperCase())
  const residue = body.replace(/'((?:[^']|'')*)'(?:\s*::\s*[a-z ]+)?/g, '').replace(/[\s,]/g, '')
  if (residue || values.length === 0) return null
  return [...new Set(values)].sort()
}

function hasSingleOuterParentheses(value) {
  if (!value.startsWith('(') || !value.endsWith(')')) return false
  let depth = 0
  let inString = false
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "'") {
      if (inString && value[index + 1] === "'") { index += 1; continue }
      inString = !inString
    } else if (!inString && value[index] === '(') depth += 1
    else if (!inString && value[index] === ')') {
      depth -= 1
      if (depth === 0 && index !== value.length - 1) return false
    }
  }
  return depth === 0
}

function isHealthyConstraint(row, spec) {
  if (!row || row.constraint_type !== 'c' || row.is_validated !== true || typeof row.definition !== 'string') return false
  const definition = row.definition.toLowerCase()
  if (!(spec.requiredTokens || []).every((token) => definition.includes(token.toLowerCase()))) return false
  const normalizedDefinition = definition.replace(/[()]/g, ' ').replace(/\s+/g, ' ')
  if (spec.minimum !== undefined &&
      !new RegExp(`(?:>=\\s*${spec.minimum}(?:\\D|$)|between\\s+${spec.minimum}\\s+and\\s+${spec.maximum}(?:\\D|$))`).test(normalizedDefinition)) return false
  if (spec.maximum !== undefined &&
      !new RegExp(`(?:<=\\s*${spec.maximum}(?:\\D|$)|between\\s+${spec.minimum}\\s+and\\s+${spec.maximum}(?:\\D|$))`).test(normalizedDefinition)) return false
  if (spec.literals) {
    const literals = [...definition.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replaceAll("''", "'").toUpperCase())
    if ([...new Set(literals)].sort().join('\u0000') !== [...spec.literals].sort().join('\u0000')) return false
  }
  return true
}

module.exports = { MIGRATION_POSTCONDITIONS, verifyMigrationPostconditions }
