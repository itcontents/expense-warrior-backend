const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { collectMigrations } = require('../src/db/migrate')

const migrationPath = path.resolve(__dirname, '../src/db/migrations/0017_payment_link_receivable_recovery.sql')
const readMigration = () => fs.readFileSync(migrationPath, 'utf8')

test('A/R recovery migration follows existing payment-link migrations', async () => {
  const names = (await collectMigrations()).map(({ name }) => name)
  assert.equal(names.at(-1), '0017_payment_link_receivable_recovery.sql')
})

test('A/R recovery migration stores durable reservation state and idempotent settled-link closure', () => {
  const migration = readMigration()
  assert.match(migration, /ADD COLUMN receivable_reservation_id uuid/)
  assert.match(migration, /ADD COLUMN receivable_reservation_state text/)
  assert.match(migration, /'PENDING', 'UNKNOWN', 'ACTIVE', 'RELEASED', 'APPLIED'/)
  assert.match(migration, /CREATE TABLE payment_link_receivable_closures/)
  assert.match(migration, /payment_link_id uuid PRIMARY KEY REFERENCES payment_links/)
  assert.match(migration, /collection_operation_id uuid NOT NULL/)
  assert.match(migration, /GRANT SELECT, INSERT ON payment_link_receivable_closures TO expense_warrior_app/i)
  assert.doesNotMatch(migration, /GRANT\s+[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*ON payment_link_receivable_closures/i)
  assert.match(migration, /payment_link_receivable_closures_append_only/)
  assert.match(migration, /payment_link_receivable_closures_reject_truncate/)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE\s+TABLE|DELETE\s+FROM/i)
})
