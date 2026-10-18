const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { collectMigrations, assertMigrationAllowed, getMigrationDatabaseConfig, assertMigrationTargetIdentity } = require('../src/db/migrate')

test('collectMigrations_listsSqlFilesInStableOrderWithChecksums', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expense-migrations-'))
  try {
    await fs.writeFile(path.join(directory, '0002_second.sql'), 'SELECT 2;')
    await fs.writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;')
    await fs.writeFile(path.join(directory, 'notes.txt'), 'ignored')
    const migrations = await collectMigrations(directory)
    assert.deepEqual(migrations.map(({ name }) => name), ['0001_first.sql', '0002_second.sql'])
    assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('assertMigrationAllowed_requiresExplicitConfirmation', () => {
  assert.throws(
    () => assertMigrationAllowed({}),
    (error) => error.code === 'MIGRATION_CONFIRMATION_REQUIRED'
  )
  assert.doesNotThrow(() => assertMigrationAllowed({ CONFIRM_EXPENSE_WARRIOR_MIGRATIONS: 'APPLY' }))
})

test('getMigrationDatabaseConfig fails closed without a separate migration identity', () => {
  assert.throws(
    () => getMigrationDatabaseConfig({ migrationDatabase: null }),
    (error) => error.code === 'MIGRATION_DATABASE_CREDENTIALS_REQUIRED'
  )
  const config = { migrationDatabase: { user: 'expense_warrior_migrator', database: 'expense_warrior' } }
  assert.equal(getMigrationDatabaseConfig(config), config.migrationDatabase)
})

test('assertMigrationTargetIdentity verifies connection and server identity and rejects replicas', async () => {
  const target = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator' }
  const client = {
    connectionParameters: { host: target.host, port: target.port, database: target.database, user: target.user },
    async query(sql) {
      assert.match(sql, /current_database\(\)/)
      assert.match(sql, /current_user/)
      assert.match(sql, /session_user/)
      assert.match(sql, /pg_is_in_recovery\(\)/)
      return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, is_in_recovery: false }] }
    },
  }
  await assert.doesNotReject(assertMigrationTargetIdentity(client, target))

  await assert.rejects(assertMigrationTargetIdentity({
    ...client, connectionParameters: { ...client.connectionParameters, database: 'itc' },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
  await assert.rejects(assertMigrationTargetIdentity({
    ...client, async query() { return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, is_in_recovery: true }] } },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
})
