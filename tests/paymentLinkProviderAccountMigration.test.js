const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { collectMigrations } = require('../src/db/migrate')

test('payment link attempts can retain the ITC provider account identity for A/R refunds', async () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../src/db/migrations/0013_payment_link_provider_account_snapshot.sql'), 'utf8')
  assert.match(migration, /ADD COLUMN provider_account_id uuid/)
  assert.match(migration, /ADD COLUMN provider_account_version integer/)
  assert.match(migration, /payment_link_attempts_provider_account_pair_check/)
  const migrations = await collectMigrations()
  assert.equal(migrations.at(-1).name, '0013_payment_link_provider_account_snapshot.sql')
})
