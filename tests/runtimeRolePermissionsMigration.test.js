const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { collectMigrations } = require('../src/db/migrate')
const { MIGRATION_POSTCONDITIONS } = require('../src/db/migrationPostconditions')

const migrationName = '0018_runtime_role_permissions.sql'
const appRole = 'expense_warrior_app'
const expected = {
  select: [
    'employee_manager_assignments', 'expense_categories', 'expense_request_attachments',
    'expense_requests', 'idempotency_records', 'payment_link_attempts', 'payment_link_creation_requests',
    'payment_link_receivable_closures', 'payment_links', 'provider_balance_snapshot_batches',
    'provider_balance_snapshot_items', 'request_decisions', 'request_payout_attempts', 'staff_payout_destinations',
  ],
  insert: [
    'audit_events', 'employee_manager_assignments', 'expense_request_attachments', 'expense_requests',
    'idempotency_records', 'payment_link_attempts', 'payment_link_creation_requests',
    'payment_link_receivable_closures', 'payment_links', 'provider_balance_snapshot_batches',
    'provider_balance_snapshot_items', 'provider_callback_inbox', 'request_decisions',
    'request_payout_attempts', 'staff_payout_destinations',
  ],
  update: [],
  columnUpdates: {
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
  },
}

function tableGrants(sql, privilege) {
  return [...sql.matchAll(new RegExp(`GRANT\\s+${privilege}\\s+ON\\s+TABLE\\s+([\\s\\S]+?)\\s+TO\\s+${appRole}\\s*;`, 'ig'))]
    .flatMap((match) => match[1].split(',').map((table) => table.trim()))
}

function columnGrants(sql, privilege) {
  return [...sql.matchAll(new RegExp(`GRANT\\s+${privilege}\\s*\\(\\s*([^)]*?)\\s*\\)\\s+ON\\s+TABLE\\s+([a-z_][a-z0-9_]*)\\s+TO\\s+${appRole}\\s*;`, 'ig'))]
    .map((match) => [match[2], match[1].split(',').map((column) => column.trim()).sort()])
}

test('runtime privilege migration is included after the existing migration chain', async () => {
  const migrations = await collectMigrations()
  assert.equal(migrations.at(-1)?.name, migrationName)
  assert.ok(MIGRATION_POSTCONDITIONS[migrationName])
})

test('runtime role receives only required API table actions', async () => {
  const sql = await fs.readFile(path.join(__dirname, '../src/db/migrations', migrationName), 'utf8')
  assert.deepEqual(tableGrants(sql, 'SELECT').sort(), expected.select.sort())
  assert.deepEqual(tableGrants(sql, 'INSERT').sort(), expected.insert.sort())
  assert.deepEqual(tableGrants(sql, 'UPDATE').sort(), expected.update.sort())
  assert.deepEqual(columnGrants(sql, 'UPDATE').sort(([a], [b]) => a.localeCompare(b)), Object.entries(expected.columnUpdates).map(([table, columns]) => [table, [...columns].sort()]).sort(([a], [b]) => a.localeCompare(b)))
  assert.match(sql, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+expense_warrior_app/i)
  assert.match(sql, /GRANT\s+CONNECT\s+ON\s+DATABASE/i)
  assert.doesNotMatch(sql, /GRANT\s+[^;]*(?:DELETE|TRUNCATE|CREATE|ALL\s+PRIVILEGES)[^;]*TO\s+expense_warrior_app/i)
})

test('runtime permission postconditions enforce denied destructive and schema-owner privileges', () => {
  const spec = MIGRATION_POSTCONDITIONS[migrationName]
  assert.equal(spec.roles?.length, 1)
  assert.equal(spec.databasePrivileges?.some((entry) => entry.role === appRole && entry.privilege === 'CONNECT' && entry.granted), true)
  assert.equal(spec.schemaPrivileges?.some((entry) => entry.role === appRole && entry.privilege === 'USAGE' && entry.granted), true)
  assert.equal(spec.schemaPrivileges?.some((entry) => entry.role === appRole && entry.privilege === 'CREATE' && !entry.granted), true)
  for (const table of [...new Set([...expected.select, ...expected.insert, ...expected.update, ...Object.keys(expected.columnUpdates)])]) {
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      assert.equal(spec.privileges?.some((entry) => entry.table === table && entry.role === appRole && entry.privilege === privilege && !entry.granted), true)
    }
  }
  assert.equal(spec.columnPrivileges?.some((entry) => entry.table === 'staff_payout_destinations' && entry.column === 'superseded_at' && entry.privilege === 'UPDATE' && entry.granted), true)
  assert.equal(spec.columnPrivileges?.some((entry) => entry.table === 'staff_payout_destinations' && entry.column === 'phone_ciphertext' && entry.privilege === 'UPDATE' && !entry.granted), true)
  assert.equal(spec.privileges?.some((entry) => entry.table === 'expense_requests' && entry.privilege === 'UPDATE' && !entry.granted), true)
  assert.equal(spec.columnPrivileges?.some((entry) => entry.table === 'expense_requests' && entry.column === 'amount' && entry.privilege === 'UPDATE' && !entry.granted), true)
  assert.equal(spec.columnPrivileges?.some((entry) => entry.table === 'request_payout_attempts' && entry.column === 'provider_account_id' && entry.privilege === 'UPDATE' && !entry.granted), true)
})
