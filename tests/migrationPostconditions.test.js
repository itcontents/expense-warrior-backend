const test = require('node:test')
const assert = require('node:assert/strict')
const { collectMigrations, verifyMigrations } = require('../src/db/migrate')
const { MIGRATION_POSTCONDITIONS, verifyMigrationPostconditions } = require('../src/db/migrationPostconditions')

const target = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator' }

test('every source migration has a read-only postcondition definition', async () => {
  const migrations = await collectMigrations()
  assert.deepEqual(Object.keys(MIGRATION_POSTCONDITIONS).sort(), migrations.map(({ name }) => name).sort())
})

test('postcondition verification uses catalog SELECTs and returns one result per migration', async () => {
  const migrations = await collectMigrations()
  const statements = []
  const client = {
    async query(sql, params = []) {
      statements.push(sql.trim())
      if (/to_regclass/i.test(sql)) return { rows: params[0].map((relation_name) => ({ relation_name })) }
      if (/information_schema\.columns/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, column_name: params[1][index] })) }
      if (/pg_catalog\.pg_trigger/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, trigger_name: params[1][index] })) }
      return { rows: [] }
    },
  }
  const result = await verifyMigrationPostconditions(client, migrations)
  assert.equal(result.verified.length, migrations.length)
  assert.ok(result.verified.every(({ passed }) => passed))
  assert.deepEqual(result.blockers, [])
  assert.ok(statements.every((statement) => /^SELECT\b/i.test(statement)))
})

test('missing schema postconditions fail closed', async () => {
  const migrations = await collectMigrations()
  const statements = []
  const client = { async query(sql) { statements.push(sql.trim()); return { rows: [] } } }
  const result = await verifyMigrationPostconditions(client, migrations)
  assert.equal(result.verified.length, migrations.length)
  assert.ok(result.verified.some(({ passed }) => !passed))
  assert.ok(result.blockers.includes('POSTCONDITION_FAILED'))
  assert.ok(statements.every((statement) => /^SELECT\b/i.test(statement)))
})

function createVerificationPool(migrations, { missingRelation = null, ledgerRows = null } = {}) {
  const statements = []
  let connections = 0
  const client = {
    connectionParameters: { host: target.host, port: target.port, database: target.database, user: target.user },
    async query(sql, params = []) {
      const statement = sql.trim()
      statements.push(statement)
      if (/current_database\(\)/i.test(statement)) return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, is_in_recovery: false }] }
      if (/to_regclass\('expense_warrior_schema_migrations'\)/i.test(statement)) return { rows: [{ ledger_exists: true, application_object_count: 25 }] }
      if (/SELECT migration_name, checksum/i.test(statement)) return { rows: ledgerRows || migrations.map(({ name, checksum }) => ({ migration_name: name, checksum })) }
      if (/to_regclass/i.test(statement)) return { rows: params[0].filter((name) => name !== missingRelation).map((relation_name) => ({ relation_name })) }
      if (/information_schema\.columns/i.test(statement)) return { rows: params[0].map((table_name, index) => ({ table_name, column_name: params[1][index] })) }
      if (/pg_catalog\.pg_trigger/i.test(statement)) return { rows: params[0].map((table_name, index) => ({ table_name, trigger_name: params[1][index] })) }
      return { rows: [] }
    },
    release() { statements.push('RELEASE') },
  }
  return { statements, get connections() { return connections }, pool: { async connect() { connections += 1; return client } } }
}

test('verifyMigrations checks all applied checksums and postconditions without writes', async () => {
  const migrations = await collectMigrations()
  const fixture = createVerificationPool(migrations)
  const result = await verifyMigrations({ pool: fixture.pool, target })
  assert.equal(result.verified, true)
  assert.deepEqual(result.blockers, [])
  assert.equal(fixture.connections, 2)
  assert.ok(fixture.statements.every((statement) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT)\b/i.test(statement)))
})

test('verifyMigrations blocks failed postconditions and does not verify pending migrations', async () => {
  const migrations = await collectMigrations()
  const partialSchema = createVerificationPool(migrations, { missingRelation: 'payment_links' })
  const failed = await verifyMigrations({ pool: partialSchema.pool, target })
  assert.equal(failed.verified, false)
  assert.ok(failed.blockers.includes('POSTCONDITION_FAILED'))

  const pendingSchema = createVerificationPool(migrations, { ledgerRows: [] })
  const pending = await verifyMigrations({ pool: pendingSchema.pool, target })
  assert.equal(pending.verified, false)
  assert.ok(pending.blockers.includes('MIGRATIONS_PENDING'))
  assert.equal(pendingSchema.connections, 1)
})

test('status blocks applied ledger rows with a missing schema postcondition', async () => {
  const migrations = await collectMigrations()
  const partial = createVerificationPool(migrations, {
    ledgerRows: [{ migration_name: migrations[0].name, checksum: migrations[0].checksum }],
    missingRelation: 'expense_categories_active_parent_idx',
  })
  const result = await require('../src/db/migrate').inspectMigrations({ pool: partial.pool, target })
  assert.equal(result.state, 'BLOCKED')
  assert.ok(result.blockers.includes('POSTCONDITION_FAILED'))
  assert.ok(partial.statements.every((statement) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT)\b/i.test(statement)))
})
