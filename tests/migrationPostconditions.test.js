const test = require('node:test')
const assert = require('node:assert/strict')
const { collectMigrations, verifyMigrations } = require('../src/db/migrate')
const { MIGRATION_POSTCONDITIONS, verifyMigrationPostconditions } = require('../src/db/migrationPostconditions')

const target = { name: 'local', host: '127.0.0.1', port: 5432, database: 'expense_warrior', user: 'expense_warrior_migrator', schema: 'public', searchPath: 'public, pg_temp' }

function constraintDefinition(name) {
  const spec = Object.values(MIGRATION_POSTCONDITIONS).flatMap((migration) => migration.constraints || []).find((constraint) => constraint.name === name)
  return [...(spec.requiredTokens || []), ...(spec.literals || []).map((literal) => `'${literal}'`),
    ...(spec.minimum === undefined ? [] : [`>= ${spec.minimum}`, `<= ${spec.maximum}`])].join(' ')
}

function indexSpecification(name) {
  return Object.values(MIGRATION_POSTCONDITIONS).flatMap((migration) => migration.indexes || []).find((index) => index.name === name)
}

function createPostconditionClient(fault = {}) {
  return {
    async query(sql, params = []) {
      if (/to_regclass/i.test(sql)) return { rows: params[0].map((relation_name) => ({ relation_name })) }
      if (/information_schema\.columns/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, column_name: params[1][index] })) }
      if (/pg_catalog\.pg_trigger/i.test(sql)) return { rows: params[0].map((table_name, index) => ({
        table_name, trigger_name: params[1][index],
        enabled_mode: table_name === fault.disabledTrigger?.[0] && params[1][index] === fault.disabledTrigger?.[1] ? 'D' : 'O',
      })) }
      if (/pg_catalog\.pg_index/i.test(sql)) return { rows: params[0].map((index_name) => ({
        index_name,
        index_valid: index_name !== fault.invalidIndex,
        index_ready: true,
        is_unique: Boolean(indexSpecification(index_name)?.unique),
        table_name: indexSpecification(index_name)?.table || 'request_payout_attempts',
        index_definition: fault.wrongIndexKey && index_name === 'request_payout_attempts_one_active_idx'
          ? 'CREATE UNIQUE INDEX request_payout_attempts_one_active_idx ON public.request_payout_attempts USING btree (payout_id)'
          : indexSpecification(index_name)
            ? `CREATE ${indexSpecification(index_name).unique ? 'UNIQUE ' : ''}INDEX ${index_name} ON public.${indexSpecification(index_name).table} ${indexSpecification(index_name).keyDefinition}`
            : 'CREATE UNIQUE INDEX request_payout_attempts_one_active_idx ON public.request_payout_attempts USING btree (request_id)',
        predicate: !indexSpecification(index_name)?.predicateValues?.length ? null : fault.wrongPredicate && index_name === 'request_payout_attempts_one_active_idx'
          ? "state = 'PENDING'::text"
          : "state = ANY (ARRAY['RESERVING'::text, 'SUBMITTING'::text, 'PENDING'::text, 'UNKNOWN'::text, 'VERIFICATION_REQUIRED'::text, 'FAILED_PENDING_RELEASE'::text])",
      })) }
      if (/pg_catalog\.pg_constraint/i.test(sql)) return { rows: params[0].map((constraint_name) => ({
        constraint_name, constraint_type: 'c',
        is_validated: constraint_name !== fault.unvalidatedConstraint,
        definition: constraintDefinition(constraint_name),
      })) }
      if (/has_table_privilege/i.test(sql)) return { rows: params[0].map((table_name, index) => ({
        table_name, role_name: params[1][index], privilege_type: params[2][index],
        is_granted: `${table_name}.${params[1][index]}.${params[2][index]}` === fault.wrongPrivilege
          ? !['SELECT', 'INSERT'].includes(params[2][index])
          : ['SELECT', 'INSERT'].includes(params[2][index]),
      })) }
      return { rows: [] }
    },
  }
}

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
      if (/pg_catalog\.pg_trigger/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, trigger_name: params[1][index], enabled_mode: 'O' })) }
      if (/pg_catalog\.pg_index/i.test(sql)) return { rows: params[0].map((index_name) => ({
        index_name, index_valid: true, index_ready: true,
        is_unique: Boolean(indexSpecification(index_name)?.unique),
        table_name: indexSpecification(index_name)?.table || 'request_payout_attempts',
        index_definition: indexSpecification(index_name)
          ? `CREATE ${indexSpecification(index_name).unique ? 'UNIQUE ' : ''}INDEX ${index_name} ON public.${indexSpecification(index_name).table} ${indexSpecification(index_name).keyDefinition}`
          : 'CREATE UNIQUE INDEX request_payout_attempts_one_active_idx ON public.request_payout_attempts USING btree (request_id)',
        predicate: indexSpecification(index_name)?.predicateValues?.length
          ? "state = ANY (ARRAY['RESERVING'::text, 'SUBMITTING'::text, 'PENDING'::text, 'UNKNOWN'::text, 'VERIFICATION_REQUIRED'::text, 'FAILED_PENDING_RELEASE'::text])"
          : null,
      })) }
      if (/pg_catalog\.pg_constraint/i.test(sql)) return { rows: params[0].map((constraint_name) => ({
        constraint_name, constraint_type: 'c', is_validated: true, definition: constraintDefinition(constraint_name),
      })) }
      if (/has_table_privilege/i.test(sql)) return { rows: params[0].map((table_name, index) => ({
        table_name, role_name: params[1][index], privilege_type: params[2][index],
        is_granted: ['SELECT', 'INSERT'].includes(params[2][index]),
      })) }
      return { rows: [] }
    },
  }
  const result = await verifyMigrationPostconditions(client, migrations)
  assert.equal(result.verified.length, migrations.length)
  assert.ok(result.verified.every(({ passed }) => passed))
  assert.deepEqual(result.blockers, [])
  assert.ok(statements.every((statement) => /^SELECT\b/i.test(statement)))
  assert.ok(statements.some((statement) => /pg_catalog\.pg_index/.test(statement)))
  assert.ok(statements.some((statement) => /pg_catalog\.pg_constraint/.test(statement)))
  assert.ok(statements.some((statement) => /has_table_privilege/.test(statement)))
})

test('postcondition verification rejects invalid indexes and an incorrect active-attempt predicate', async () => {
  const migrations = await collectMigrations()
  const client = {
    async query(sql, params = []) {
      if (/to_regclass/i.test(sql)) return { rows: params[0].map((relation_name) => ({ relation_name })) }
      if (/information_schema\.columns/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, column_name: params[1][index] })) }
      if (/pg_catalog\.pg_trigger/i.test(sql)) return { rows: params[0].map((table_name, index) => ({ table_name, trigger_name: params[1][index], enabled_mode: 'O' })) }
      if (/pg_catalog\.pg_index/i.test(sql)) return { rows: params[0].map((index_name) => ({
        index_name, index_valid: index_name !== 'request_payout_attempts_latest_idx', index_ready: true,
        is_unique: index_name === 'request_payout_attempts_one_active_idx', table_name: 'request_payout_attempts',
        index_definition: 'CREATE UNIQUE INDEX request_payout_attempts_one_active_idx ON public.request_payout_attempts USING btree (request_id)',
        predicate: "state = 'PENDING'::text",
      })) }
      if (/pg_catalog\.pg_constraint/i.test(sql)) return { rows: params[0].map((constraint_name) => ({
        constraint_name, constraint_type: 'c', is_validated: true, definition: constraintDefinition(constraint_name),
      })) }
      return { rows: [] }
    },
  }
  const result = await verifyMigrationPostconditions(client, migrations)
  const retryMigration = result.verified.find(({ migration }) => migration === '0015_staff_payout_retries.sql')
  assert.equal(retryMigration.passed, false)
  assert.ok(result.blockers.includes('POSTCONDITION_FAILED'))
})

test('postcondition verification rejects disabled triggers and unvalidated retry constraints', async () => {
  const migrations = await collectMigrations()
  for (const fault of [
    { disabledTrigger: ['staff_payout_destinations', 'staff_payout_destinations_append_only'] },
    { unvalidatedConstraint: 'request_payout_attempts_state_check' },
  ]) {
    const result = await verifyMigrationPostconditions(createPostconditionClient(fault), migrations)
    assert.ok(result.blockers.includes('POSTCONDITION_FAILED'))
  }
})

test('postcondition verification rejects missing runtime grants or excessive closure-table privileges', async () => {
  const migrations = await collectMigrations()
  for (const wrongPrivilege of [
    'payment_link_receivable_closures.expense_warrior_app.SELECT',
    'payment_link_receivable_closures.expense_warrior_app.INSERT',
    'payment_link_receivable_closures.expense_warrior_app.UPDATE',
    'payment_link_receivable_closures.expense_warrior_app.DELETE',
    'payment_link_receivable_closures.expense_warrior_app.TRUNCATE',
  ]) {
    const result = await verifyMigrationPostconditions(createPostconditionClient({ wrongPrivilege }), migrations)
    const paymentLinkMigration = result.verified.find(({ migration }) => migration === '0017_payment_link_receivable_recovery.sql')
    assert.equal(paymentLinkMigration.passed, false, wrongPrivilege)
  }
})

test('postcondition verification checks the active-attempt unique key, not only its partial predicate', async () => {
  const migrations = await collectMigrations()
  const result = await verifyMigrationPostconditions(createPostconditionClient({ wrongIndexKey: true }), migrations)
  const retryMigration = result.verified.find(({ migration }) => migration === '0015_staff_payout_retries.sql')
  assert.equal(retryMigration.passed, false)
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
      if (/current_database\(\)/i.test(statement)) return { rows: [{ database: target.database, current_role_name: target.user, session_role_name: target.user, schema_name: target.schema, search_path: target.searchPath, is_in_recovery: false, is_superuser: false, can_create_database: false, can_create_role: false, can_replicate: false, bypasses_row_security: false }] }
      if (/AS ledger_exists/i.test(statement)) return { rows: [{ ledger_exists: true, application_object_count: 25 }] }
      if (/SELECT migration_name, checksum/i.test(statement)) return { rows: ledgerRows || migrations.map(({ name, checksum }) => ({ migration_name: name, checksum })) }
      if (/to_regclass/i.test(statement)) return { rows: params[0].filter((name) => name !== missingRelation).map((relation_name) => ({ relation_name })) }
      if (/information_schema\.columns/i.test(statement)) return { rows: params[0].map((table_name, index) => ({ table_name, column_name: params[1][index] })) }
      if (/pg_catalog\.pg_trigger/i.test(statement)) return { rows: params[0].map((table_name, index) => ({ table_name, trigger_name: params[1][index], enabled_mode: 'O' })) }
      if (/pg_catalog\.pg_index/i.test(statement)) return { rows: params[0].map((index_name) => ({
        index_name, index_valid: true, index_ready: true,
        is_unique: Boolean(indexSpecification(index_name)?.unique),
        table_name: indexSpecification(index_name)?.table || 'request_payout_attempts',
        index_definition: indexSpecification(index_name)
          ? `CREATE ${indexSpecification(index_name).unique ? 'UNIQUE ' : ''}INDEX ${index_name} ON public.${indexSpecification(index_name).table} ${indexSpecification(index_name).keyDefinition}`
          : 'CREATE UNIQUE INDEX request_payout_attempts_one_active_idx ON public.request_payout_attempts USING btree (request_id)',
        predicate: indexSpecification(index_name)?.predicateValues?.length
          ? "state = ANY (ARRAY['RESERVING'::text, 'SUBMITTING'::text, 'PENDING'::text, 'UNKNOWN'::text, 'VERIFICATION_REQUIRED'::text, 'FAILED_PENDING_RELEASE'::text])"
          : null,
      })) }
      if (/pg_catalog\.pg_constraint/i.test(statement)) return { rows: params[0].map((constraint_name) => ({
        constraint_name, constraint_type: 'c', is_validated: true, definition: constraintDefinition(constraint_name),
      })) }
      if (/has_table_privilege/i.test(statement)) return { rows: params[0].map((table_name, index) => ({
        table_name, role_name: params[1][index], privilege_type: params[2][index],
        is_granted: ['SELECT', 'INSERT'].includes(params[2][index]),
      })) }
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
  assert.ok(fixture.statements.every((statement) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT|WITH)\b/i.test(statement)))
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
  assert.ok(partial.statements.every((statement) => /^(BEGIN READ ONLY|ROLLBACK|RELEASE|SELECT|WITH)\b/i.test(statement)))
})
