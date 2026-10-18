const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { collectMigrations, assertMigrationAllowed, getMigrationDatabaseConfig, assertMigrationTargetIdentity, inspectMigrations, planMigrations } = require('../src/db/migrate')

const migrationTarget = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator' }

async function createMigrationFixture(files = { '0001_first.sql': 'SELECT 1;', '0002_second.sql': 'SELECT 2;' }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expense-migration-inspect-'))
  for (const [name, sql] of Object.entries(files)) await fs.writeFile(path.join(directory, name), sql)
  return directory
}

function createInspectPool({ ledgerExists = true, applicationTables = 1, rows = [] } = {}) {
  const statements = []
  const client = {
    connectionParameters: { host: migrationTarget.host, port: migrationTarget.port, database: migrationTarget.database, user: migrationTarget.user },
    async query(sql) {
      statements.push(sql.trim())
      if (/current_database\(\)/i.test(sql)) return { rows: [{ database: migrationTarget.database, current_role_name: migrationTarget.user, session_role_name: migrationTarget.user, is_in_recovery: false }] }
      if (/to_regclass/i.test(sql)) return { rows: [{ ledger_exists: ledgerExists, application_object_count: applicationTables }] }
      if (/SELECT migration_name, checksum/i.test(sql)) return { rows }
      return { rows: [] }
    },
    release() { statements.push('RELEASE') },
  }
  return { statements, pool: { async connect() { return client } } }
}

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

test('inspectMigrations is read-only, target-checked, and reports applied plus pending checksums', async () => {
  const directory = await createMigrationFixture()
  const fixture = createInspectPool({ rows: [{ migration_name: '0001_first.sql', checksum: require('node:crypto').createHash('sha256').update('SELECT 1;').digest('hex') }] })
  try {
    const result = await inspectMigrations({ pool: fixture.pool, target: migrationTarget, directory })
    assert.equal(result.state, 'READY')
    assert.deepEqual(result.applied.map(({ name }) => name), ['0001_first.sql'])
    assert.deepEqual(result.pending.map(({ name }) => name), ['0002_second.sql'])
    assert.ok(fixture.statements.includes('BEGIN READ ONLY'))
    assert.ok(fixture.statements.includes('ROLLBACK'))
    assert.ok(fixture.statements.some((sql) => /current_database\(\)/i.test(sql)))
    assert.ok(fixture.statements.every((sql) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT)\b/i.test(sql)))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('inspectMigrations distinguishes an empty database from an untracked application schema', async () => {
  const directory = await createMigrationFixture()
  try {
    const empty = createInspectPool({ ledgerExists: false, applicationTables: 0 })
    const emptyResult = await inspectMigrations({ pool: empty.pool, target: migrationTarget, directory })
    assert.equal(emptyResult.state, 'NEW_EMPTY_DATABASE')
    const existing = createInspectPool({ ledgerExists: false, applicationTables: 4 })
    const existingResult = await inspectMigrations({ pool: existing.pool, target: migrationTarget, directory })
    assert.equal(existingResult.state, 'MANUAL_REVIEW_REQUIRED')
    assert.ok(existingResult.blockers.includes('MIGRATION_LEDGER_MISSING_FOR_NON_EMPTY_SCHEMA'))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('inspectMigrations blocks unknown ledger rows and checksum drift', async () => {
  const directory = await createMigrationFixture({ '0001_first.sql': 'SELECT 1;' })
  try {
    const unknown = createInspectPool({ rows: [{ migration_name: '0009_unknown.sql', checksum: 'a'.repeat(64) }] })
    const unknownResult = await inspectMigrations({ pool: unknown.pool, target: migrationTarget, directory })
    assert.equal(unknownResult.state, 'BLOCKED')
    assert.ok(unknownResult.blockers.includes('UNKNOWN_LEDGER_MIGRATION'))
    const drift = createInspectPool({ rows: [{ migration_name: '0001_first.sql', checksum: 'b'.repeat(64) }] })
    const driftResult = await inspectMigrations({ pool: drift.pool, target: migrationTarget, directory })
    assert.equal(driftResult.state, 'BLOCKED')
    assert.ok(driftResult.blockers.includes('MIGRATION_CHECKSUM_MISMATCH'))
    const validChecksum = require('node:crypto').createHash('sha256').update('SELECT 1;').digest('hex')
    const duplicate = createInspectPool({ rows: [
      { migration_name: '0001_first.sql', checksum: validChecksum },
      { migration_name: '0001_first.sql', checksum: validChecksum },
    ] })
    const duplicateResult = await inspectMigrations({ pool: duplicate.pool, target: migrationTarget, directory })
    assert.equal(duplicateResult.state, 'BLOCKED')
    assert.ok(duplicateResult.blockers.includes('DUPLICATE_LEDGER_ROW'))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('planMigrations lists ordered checksums without writing', async () => {
  const directory = await createMigrationFixture()
  const fixture = createInspectPool({ ledgerExists: false, applicationTables: 0 })
  try {
    const result = await planMigrations({ pool: fixture.pool, target: migrationTarget, directory })
    assert.equal(result.state, 'NEW_EMPTY_DATABASE')
    assert.deepEqual(result.steps.map(({ name }) => name), ['0001_first.sql', '0002_second.sql'])
    assert.ok(result.steps.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)))
    assert.ok(fixture.statements.every((sql) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT)\b/i.test(sql)))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
