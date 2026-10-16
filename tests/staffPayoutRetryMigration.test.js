const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { collectMigrations } = require('../src/db/migrate')

const migrationPath = path.resolve(__dirname, '../src/db/migrations/0015_staff_payout_retries.sql')
const readMigration = () => fs.readFileSync(migrationPath, 'utf8')

test('staff payout retry migration follows the provider lifecycle migration', async () => {
  const names = (await collectMigrations()).map(({ name }) => name)
  assert.equal(names.at(-1), '0015_staff_payout_retries.sql')
  assert.equal(names.at(-2), '0014_provider_addon_lifecycle.sql')
})

test('retry migration removes only the request uniqueness and retains payout identities', () => {
  const migration = readMigration()
  assert.match(migration, /DROP CONSTRAINT request_payout_attempts_request_id_key/)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)/i)
  const dropped = [...migration.matchAll(/DROP CONSTRAINT (\w+)/g)].map((match) => match[1])
  assert.deepEqual(dropped.sort(), ['request_payout_attempts_request_id_key', 'request_payout_attempts_state_check'])
})

test('retry migration backfills reservation snapshots without rewriting provider identity', () => {
  const migration = readMigration()
  for (const [column, type] of [
    ['reservation_operation_id', 'uuid'], ['reservation_idempotency_key', 'varchar\\(128\\)'],
    ['reservation_hold_id', 'uuid'], ['reservation_state', 'text'],
  ]) assert.match(migration, new RegExp(`ADD COLUMN ${column} ${type}`))
  assert.match(migration, /request_payout_attempts_reservation_identity_check/)
  assert.match(migration, /UPDATE request_payout_attempts[\s\S]+FROM expense_requests[\s\S]+request_id = request\.request_id/)
  for (const [target, source] of [
    ['operation_id', 'operation_id'], ['idempotency_key', 'idempotency_key'],
    ['hold_id', 'hold_id'], ['state', 'reservation_state'],
  ]) assert.match(migration, new RegExp(`reservation_${target} = request\\.finance_${source}`))
  assert.doesNotMatch(migration, /(?:SET|,)\s*(?:provider_code|provider_account_id|provider_account_version|amount|currency|network_code|client_reference_id)\s*=/i)
})

test('retry migration enforces one active attempt and indexes latest attempt lookup', () => {
  const migration = readMigration()
  assert.match(migration, /CREATE UNIQUE INDEX request_payout_attempts_one_active_idx[\s\S]+ON request_payout_attempts \(request_id\)\s+WHERE state IN/)
  const active = migration.match(/WHERE state IN \(([^)]+)\)/)[1]
  assert.deepEqual([...active.matchAll(/'([^']+)'/g)].map((match) => match[1]), [
    'RESERVING', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'VERIFICATION_REQUIRED', 'FAILED_PENDING_RELEASE',
  ])
  assert.match(migration, /ON request_payout_attempts \(request_id, created_at DESC, payout_id DESC\)/)
})

test('retry migration extends payout states and validates reservation lifecycle snapshots', () => {
  const migration = readMigration()
  assert.match(migration, /ADD CONSTRAINT request_payout_attempts_state_check CHECK \(state IN \([\s\S]+'RESERVING'[\s\S]+'RESERVATION_FAILED'/)
  assert.match(migration, /reservation_state IN \('PENDING','RESERVED','CONSUMED','RELEASED','FAILED','UNKNOWN'\)/)
  assert.match(migration, /state <> 'RESERVING' OR \(reservation_state IS NOT NULL AND reservation_state IN \('PENDING','UNKNOWN'\)\)/)
  assert.match(migration, /state <> 'RESERVATION_FAILED' OR \(reservation_state IS NOT NULL AND reservation_state = 'FAILED'\)/)
})
