const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { collectMigrations, assertMigrationAllowed, getMigrationDatabaseConfig, assertMigrationTargetIdentity, inspectMigrations, planMigrations, runMigrations, verifyMigrations } = require('../src/db/migrate')

const migrationTarget = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator', schema: 'public', searchPath: 'public, pg_temp' }

test('migration status reports missing configuration names without connecting or exposing values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'expense-migration-config-'))
  try {
    await fs.writeFile(path.join(directory, '.env'), [
      'DB_HOST=127.0.0.1',
      'DB_NAME=expense_warrior',
      'DB_USER=expense_warrior_app',
      'DB_PASSWORD=unit-test-secret-placeholder',
      'ITC_API_BASE_URL=http://127.0.0.1:3000/api/v1',
    ].join('\n'))
    await fs.writeFile(path.join(directory, '.env.migrations'), '')
    const result = spawnSync(process.execPath, [path.join(__dirname, '../src/db/migrate.js'), 'status'], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '', NODE_ENV: 'test' },
    })

    assert.equal(result.status, 1)
    const failure = JSON.parse(result.stderr.trim())
    assert.equal(failure.event, 'migration_failed')
    assert.equal(failure.code, 'MIGRATION_TARGET_CONFIG_INVALID')
    assert.deepEqual(failure.details, [
      'DB_MIGRATION_TARGET',
      'DB_MIGRATION_ALLOWED_TARGETS',
      'DB_MIGRATION_TARGET_HOST',
      'DB_MIGRATION_TARGET_PORT',
      'DB_MIGRATION_TARGET_DATABASE',
      'DB_MIGRATION_USER',
    ])
    assert.doesNotMatch(result.stderr, /unit-test-secret-placeholder/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

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
      if (/current_database\(\)/i.test(sql)) return { rows: [{ database: migrationTarget.database, current_role_name: migrationTarget.user, session_role_name: migrationTarget.user, schema_name: 'public', search_path: 'public, pg_temp', is_in_recovery: false, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] }
      if (/to_regclass/i.test(sql)) return { rows: [{ ledger_exists: ledgerExists, application_object_count: applicationTables }] }
      if (/SELECT migration_name, checksum/i.test(sql)) return { rows }
      return { rows: [] }
    },
    release() { statements.push('RELEASE') },
  }
  return { statements, pool: { async connect() { return client } } }
}

function createApplyPool({ ledgerExists = false, applicationTables = 0, rows = [], lockAcquired = true, isInRecovery = false, failOnMigration = '' } = {}) {
  const statements = []
  const appliedRows = [...rows]
  const connectionParameters = { host: migrationTarget.host, port: migrationTarget.port, database: migrationTarget.database, user: migrationTarget.user }
  let transactionSnapshot = null
  const client = {
    connectionParameters,
    async query(sql, params = []) {
      const statement = sql.trim()
      statements.push(statement)
      if (statement === 'BEGIN' || statement === 'BEGIN READ ONLY') transactionSnapshot = { ledgerExists, rowsLength: appliedRows.length }
      if (statement === 'ROLLBACK' && transactionSnapshot) {
        ledgerExists = transactionSnapshot.ledgerExists
        appliedRows.length = transactionSnapshot.rowsLength
        transactionSnapshot = null
      }
      if (statement === 'COMMIT') transactionSnapshot = null
      if (/current_database\(\)/i.test(statement)) return { rows: [{ database: migrationTarget.database, current_role_name: migrationTarget.user, session_role_name: migrationTarget.user, schema_name: migrationTarget.schema, search_path: migrationTarget.searchPath, is_in_recovery: isInRecovery, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] }
      if (/pg_try_advisory_lock/i.test(statement)) return { rows: [{ acquired: lockAcquired }] }
      if (/to_regclass/i.test(statement)) return { rows: [{ ledger_exists: ledgerExists, application_object_count: applicationTables }] }
      if (/SELECT migration_name, checksum/i.test(statement)) return { rows: appliedRows }
      if (/CREATE TABLE(?: IF NOT EXISTS)? expense_warrior_schema_migrations/i.test(statement)) {
        ledgerExists = true
        return { rows: [] }
      }
      if (/INSERT INTO expense_warrior_schema_migrations/i.test(statement)) {
        appliedRows.push({ migration_name: params[0], checksum: params[1] })
        return { rows: [] }
      }
      if (statement === failOnMigration) throw new Error('simulated migration failure')
      return { rows: [] }
    },
    release() { statements.push('RELEASE') },
  }
  return { statements, get ledgerExists() { return ledgerExists }, pool: { async connect() { return client } } }
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
  const target = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator', schema: 'public', searchPath: 'public, pg_temp' }
  const client = {
    connectionParameters: { host: target.host, port: target.port, database: target.database, user: target.user },
    async query(sql) {
      assert.match(sql, /current_database\(\)/)
      assert.match(sql, /current_user/)
      assert.match(sql, /session_user/)
      assert.match(sql, /current_schema\(\)/)
      assert.match(sql, /rolbypassrls/)
      assert.match(sql, /current_setting\('search_path'/)
      assert.match(sql, /pg_is_in_recovery\(\)/)
      assert.match(sql, /rolsuper/)
      assert.match(sql, /rolcreatedb/)
      assert.match(sql, /rolcreaterole/)
      return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, schema_name: target.schema, search_path: target.searchPath, is_in_recovery: false, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] }
    },
  }
  await assert.doesNotReject(assertMigrationTargetIdentity(client, target))

  await assert.rejects(assertMigrationTargetIdentity({
    ...client, connectionParameters: { ...client.connectionParameters, database: 'itc' },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
  await assert.rejects(assertMigrationTargetIdentity({
    ...client, async query() { return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, schema_name: target.schema, search_path: target.searchPath, is_in_recovery: true, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] } },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
  await assert.rejects(assertMigrationTargetIdentity({
    ...client, async query() { return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, schema_name: 'attacker_schema', search_path: 'attacker_schema, public', is_in_recovery: false, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] } },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
  await assert.rejects(assertMigrationTargetIdentity({
    ...client, async query() { return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, schema_name: target.schema, search_path: target.searchPath, is_in_recovery: false, is_superuser: true, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] } },
  }, target), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
  await assert.rejects(assertMigrationTargetIdentity(client, { ...target, searchPath: 'public, attacker_schema' }),
    (error) => error.code === 'MIGRATION_TARGET_IDENTITY_MISMATCH')
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
    assert.ok(fixture.statements.every((sql) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT|WITH)\b/i.test(sql)))
    const objectInventory = fixture.statements.find((sql) => /application_object_count/.test(sql))
    assert.match(objectInventory, /pg_catalog\.pg_namespace/)
    assert.match(objectInventory, /pg_catalog\.pg_class/)
    assert.match(objectInventory, /pg_catalog\.pg_proc/)
    assert.match(objectInventory, /pg_catalog\.pg_type/)
    assert.match(objectInventory, /pg_catalog\.pg_collation/)
    assert.match(objectInventory, /pg_catalog\.pg_statistic_ext/)
    assert.match(objectInventory, /pg_catalog\.pg_ts_config/)
    assert.match(objectInventory, /pg_catalog\.pg_extension/)
    assert.match(objectInventory, /'S', 'i', 'I'/)
    assert.match(objectInventory, /pg_temp_%/)
    assert.match(objectInventory, /'public'::regnamespace/)
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
    assert.ok(fixture.statements.every((sql) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT|WITH)\b/i.test(sql)))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('runMigrations refuses an untracked schema, checksum drift, wrong target, and advisory-lock contention before SQL writes', async () => {
  const directory = await createMigrationFixture()
  try {
    const cases = [
      { pool: createApplyPool({ ledgerExists: false, applicationTables: 2 }), expected: 'MIGRATION_LEDGER_MISSING_FOR_NON_EMPTY_SCHEMA' },
      { pool: createApplyPool({ ledgerExists: true, rows: [{ migration_name: '0001_first.sql', checksum: 'f'.repeat(64) }] }), expected: 'MIGRATION_CHECKSUM_MISMATCH' },
      { pool: createApplyPool(), wrongTarget: { ...migrationTarget, database: 'itc' }, expected: 'MIGRATION_TARGET_IDENTITY_MISMATCH' },
      { pool: createApplyPool({ isInRecovery: true }), expected: 'MIGRATION_TARGET_IDENTITY_MISMATCH' },
      { pool: createApplyPool({ lockAcquired: false }), expected: 'MIGRATION_LOCK_UNAVAILABLE' },
    ]
    for (const item of cases) {
      await assert.rejects(runMigrations({ pool: item.pool.pool, target: item.wrongTarget || migrationTarget, directory, env: { CONFIRM_EXPENSE_WARRIOR_MIGRATIONS: 'APPLY' } }),
        (error) => error.code === item.expected)
      assert.equal(item.pool.statements.some((statement) => statement === 'SELECT 1;' || statement === 'SELECT 2;'), false)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('runMigrations bootstraps a new ledger and first migration in the same transaction', async () => {
  const directory = await createMigrationFixture({ '0001_first.sql': 'SELECT 1;' })
  const fixture = createApplyPool()
  try {
    const result = await runMigrations({ pool: fixture.pool, target: migrationTarget, directory, env: { CONFIRM_EXPENSE_WARRIOR_MIGRATIONS: 'APPLY' } })
    assert.deepEqual(result.applied, ['0001_first.sql'])
    const begin = fixture.statements.indexOf('BEGIN', fixture.statements.indexOf('ROLLBACK') + 1)
    const ledger = fixture.statements.findIndex((statement) => /CREATE TABLE(?: IF NOT EXISTS)? expense_warrior_schema_migrations/.test(statement))
    const migration = fixture.statements.indexOf('SELECT 1;')
    const insert = fixture.statements.findIndex((statement) => /INSERT INTO expense_warrior_schema_migrations/.test(statement))
    const commit = fixture.statements.indexOf('COMMIT')
    assert.ok(begin >= 0 && begin < ledger && ledger < migration && migration < insert && insert < commit)
    assert.ok(fixture.statements.includes("SET LOCAL lock_timeout = '5s'"))
    assert.ok(fixture.statements.includes("SET LOCAL statement_timeout = '60s'"))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('runMigrations rolls back bootstrap, migration SQL, and ledger row together on first failure', async () => {
  const directory = await createMigrationFixture({ '0001_first.sql': 'FAIL;' })
  const fixture = createApplyPool({ failOnMigration: 'FAIL;' })
  try {
    await assert.rejects(runMigrations({ pool: fixture.pool, target: migrationTarget, directory, env: { CONFIRM_EXPENSE_WARRIOR_MIGRATIONS: 'APPLY' } }))
    assert.ok(fixture.statements.includes('BEGIN'))
    assert.ok(fixture.statements.includes('ROLLBACK'))
    assert.equal(fixture.statements.some((statement) => /INSERT INTO expense_warrior_schema_migrations/.test(statement)), false)
    assert.equal(fixture.ledgerExists, false)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
