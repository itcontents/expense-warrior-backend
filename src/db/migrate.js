const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { MIGRATION_POSTCONDITIONS, verifyMigrationPostconditions } = require('./migrationPostconditions')

const MIGRATION_CONFIRMATION = 'APPLY'
const ADVISORY_LOCK_ID = 455752
const RUNTIME_ROLE_PERMISSIONS_MIGRATION = '0018_runtime_role_permissions.sql'
const RUNTIME_ROLE_PERMISSIONS_CHECKSUM = 'e7bc9a7010d997d03e4542f883f65e8668838c23e041dd516f396ac36cc83fe0'
const REQUEST_DESTINATION_MIGRATION = '0019_request_specific_payout_destinations.sql'
const REQUEST_DESTINATION_CHECKSUM = 'd42ab92f5b2d07a7173125ecab938dcdb489f7d45292efb5a7d54cb3170ba13e'
const REQUEST_DESTINATION_LEGACY_CONSTRAINTS = Object.freeze({
  expense_requests_payout_snapshot_chk: "check (payout_destination_id is null and payout_network_code is null and payout_phone_ciphertext is null and payout_encryption_key_id is null and payout_phone_last4 is null or payout_destination_id is not null and payout_network_code ~ '^[a-z0-9_]{1,40}$' and payout_phone_ciphertext is not null and payout_encryption_key_id is not null and payout_phone_last4 ~ '^[0-9]{4}$')",
  expense_requests_payout_provider_snapshot_chk: "check (payout_destination_id is null and payout_provider_code is null or payout_destination_id is not null and payout_provider_code ~ '^[a-z][a-z0-9_]{1,31}$')",
  expense_requests_payout_provider_account_pair_check: 'check (payout_provider_account_id is null and payout_provider_account_version is null or payout_destination_id is not null and payout_provider_account_id is not null and payout_provider_account_version > 0)',
})
const REQUEST_DESTINATION_LEGACY_FAILURES = Object.freeze(Object.keys(REQUEST_DESTINATION_LEGACY_CONSTRAINTS)
  .map((name) => `constraint:${name}`).sort())
const MIGRATION_CONFIG_DETAIL_KEYS = new Set([
  'DB_MIGRATION_TARGET',
  'DB_MIGRATION_ALLOWED_TARGETS',
  'DB_MIGRATION_TARGETS_JSON',
  'DB_MIGRATION_TARGET_HOST',
  'DB_MIGRATION_TARGET_PORT',
  'DB_MIGRATION_TARGET_DATABASE',
  'DB_MIGRATION_USER',
  'DB_MIGRATION_PASSWORD',
])
const MIGRATION_IDENTITY_CHECK_KEYS = new Set([
  'connection_host',
  'connection_port',
  'connection_database',
  'connection_user',
  'target_schema',
  'target_search_path',
  'server_identity_unavailable',
  'database',
  'current_role',
  'session_role',
  'schema',
  'search_path',
  'primary_database',
  'role_superuser',
  'role_createdb',
  'role_createrole',
  'role_replication',
  'role_bypassrls',
])
const MIGRATION_STAGE_LABELS = new Set(['schema_inventory', 'migration_ledger_read', 'migration_postconditions'])

function serializeMigrationFailure(error) {
  const details = Array.isArray(error?.details)
    ? [...new Set(error.details.filter((detail) => MIGRATION_CONFIG_DETAIL_KEYS.has(detail)))]
    : []
  const identityChecks = Array.isArray(error?.identityChecks)
    ? [...new Set(error.identityChecks.filter((check) => MIGRATION_IDENTITY_CHECK_KEYS.has(check)))]
    : []
  const stage = MIGRATION_STAGE_LABELS.has(error?.migrationStage) ? error.migrationStage : null
  return {
    event: 'migration_failed',
    code: error?.code || 'MIGRATION_FAILED',
    ...(details.length ? { details } : {}),
    ...(identityChecks.length ? { identityChecks } : {}),
    ...(stage ? { stage } : {}),
  }
}

function assertMigrationAllowed(env = process.env) {
  if (env.CONFIRM_EXPENSE_WARRIOR_MIGRATIONS !== MIGRATION_CONFIRMATION) {
    const error = new Error('Set CONFIRM_EXPENSE_WARRIOR_MIGRATIONS=APPLY to apply Expense Warrior migrations')
    error.code = 'MIGRATION_CONFIRMATION_REQUIRED'
    throw error
  }
}

function getMigrationDatabaseConfig(config) {
  if (!config?.migrationDatabase) {
    const error = new Error('Separate DB_MIGRATION_USER and DB_MIGRATION_PASSWORD credentials are required')
    error.code = 'MIGRATION_DATABASE_CREDENTIALS_REQUIRED'
    throw error
  }
  return config.migrationDatabase
}

function normalizeSearchPath(searchPath) {
  return String(searchPath || '').split(',').map((schema) => schema.trim()).join(',')
}

async function assertMigrationTargetIdentity(client, target) {
  if (!client || !target) {
    const error = new Error('A connected client and named migration target are required')
    error.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    throw error
  }
  const parameters = client.connectionParameters || {}
  const connectionMatches = String(parameters.host || '') === target.host &&
    Number(parameters.port) === target.port &&
    String(parameters.database || '') === target.database &&
    String(parameters.user || '') === target.user
  const targetSchemaMatches = target.schema === 'public' && target.searchPath === 'public, pg_temp'
  const identityChecks = []
  if (String(parameters.host || '') !== target.host) identityChecks.push('connection_host')
  if (Number(parameters.port) !== target.port) identityChecks.push('connection_port')
  if (String(parameters.database || '') !== target.database) identityChecks.push('connection_database')
  if (String(parameters.user || '') !== target.user) identityChecks.push('connection_user')
  if (target.schema !== 'public') identityChecks.push('target_schema')
  if (target.searchPath !== 'public, pg_temp') identityChecks.push('target_search_path')
  let serverMatches = false
  let identity
  try {
    const result = await client.query(`
      SELECT current_database() AS database,
             current_user AS current_role_name,
             session_user AS session_role_name,
             current_schema() AS schema_name,
             current_setting('search_path') AS search_path,
             pg_is_in_recovery() AS is_in_recovery,
             target_role.rolsuper AS is_superuser,
             target_role.rolcreatedb AS can_create_database,
             target_role.rolcreaterole AS can_create_role,
             target_role.rolreplication AS can_replicate,
             target_role.rolbypassrls AS bypasses_row_security
      FROM pg_catalog.pg_roles target_role
      WHERE target_role.rolname = current_user
    `)
    identity = result.rows?.[0]
    if (!identity) identityChecks.push('server_identity_unavailable')
    else {
      if (identity.database !== target.database) identityChecks.push('database')
      if (identity.current_role_name !== target.user) identityChecks.push('current_role')
      if (identity.session_role_name !== target.user) identityChecks.push('session_role')
      if (identity.schema_name !== target.schema) identityChecks.push('schema')
      if (normalizeSearchPath(identity.search_path) !== normalizeSearchPath(target.searchPath)) identityChecks.push('search_path')
      if (identity.is_in_recovery !== false) identityChecks.push('primary_database')
      if (identity.is_superuser !== false) identityChecks.push('role_superuser')
      if (identity.can_create_database !== false) identityChecks.push('role_createdb')
      if (identity.can_create_role !== false) identityChecks.push('role_createrole')
      if (identity.can_replicate !== false) identityChecks.push('role_replication')
      if (identity.bypasses_row_security !== false) identityChecks.push('role_bypassrls')
    }
    serverMatches = Boolean(identity) &&
      identity.database === target.database &&
      identity.current_role_name === target.user &&
      identity.session_role_name === target.user &&
      identity.schema_name === target.schema &&
      normalizeSearchPath(identity.search_path) === normalizeSearchPath(target.searchPath) &&
      identity.is_in_recovery === false &&
      identity.is_superuser === false &&
      identity.can_create_database === false &&
      identity.can_create_role === false &&
      identity.can_replicate === false &&
      identity.bypasses_row_security === false
  } catch {
    serverMatches = false
    identityChecks.push('server_identity_unavailable')
  }
  if (!connectionMatches || !targetSchemaMatches || !serverMatches) {
    const error = new Error('Connected database identity does not match the selected migration target')
    error.code = 'MIGRATION_TARGET_IDENTITY_MISMATCH'
    error.identityChecks = [...new Set(identityChecks)]
    throw error
  }
}

async function collectMigrations(directory = path.join(__dirname, 'migrations')) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const migrations = []
  for (const name of names) {
    const sql = await fs.readFile(path.join(directory, name), 'utf8')
    if (!sql.trim()) {
      const error = new Error(`Migration ${name} is empty`)
      error.code = 'MIGRATION_EMPTY'
      throw error
    }
    migrations.push({
      name,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    })
  }
  return migrations
}

function migrationError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function inspectMigrations({ pool, target, directory } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required')
  if (!target) throw migrationError('MIGRATION_TARGET_CONFIG_INVALID', 'A named, allowlisted migration target is required')
  const migrations = await collectMigrations(directory)
  const client = await pool.connect()
  try {
    return await inspectMigrationClient(client, target, migrations)
  } finally {
    client.release()
  }
}

async function inspectMigrationClient(client, target, migrations) {
  let transactionStarted = false
  try {
    await client.query('BEGIN READ ONLY')
    transactionStarted = true
    await assertMigrationTargetIdentity(client, target)
    let schema
    try {
      schema = await client.query(`
      WITH user_namespaces AS (
        SELECT oid
        FROM pg_catalog.pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
          AND nspname NOT LIKE 'pg_toast%'
          AND nspname NOT LIKE 'pg_temp_%'
      ), user_objects AS (
        SELECT schema_row.oid
          FROM pg_catalog.pg_namespace schema_row
         WHERE schema_row.oid IN (SELECT oid FROM user_namespaces)
           AND schema_row.nspname <> 'public'
        UNION ALL
        SELECT relation.oid
          FROM pg_catalog.pg_class relation
         WHERE relation.relnamespace IN (SELECT oid FROM user_namespaces)
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'i', 'I', 'c')
           AND NOT (relation.relnamespace = 'public'::regnamespace AND relation.relname = 'expense_warrior_schema_migrations')
        UNION ALL
        SELECT proc.oid
          FROM pg_catalog.pg_proc proc
         WHERE proc.pronamespace IN (SELECT oid FROM user_namespaces)
        UNION ALL
        SELECT data_type.oid
          FROM pg_catalog.pg_type data_type
         WHERE data_type.typnamespace IN (SELECT oid FROM user_namespaces)
           AND data_type.typrelid = 0 AND data_type.typelem = 0
        UNION ALL
        SELECT object_row.oid
          FROM (
            SELECT coll.oid, coll.collnamespace AS namespace_oid FROM pg_catalog.pg_collation coll
            UNION ALL SELECT conv.oid, conv.connamespace FROM pg_catalog.pg_conversion conv
            UNION ALL SELECT op.oid, op.oprnamespace FROM pg_catalog.pg_operator op
            UNION ALL SELECT opc.oid, opc.opcnamespace FROM pg_catalog.pg_opclass opc
            UNION ALL SELECT opf.oid, opf.opfnamespace FROM pg_catalog.pg_opfamily opf
            UNION ALL SELECT stats.oid, stats.stxnamespace FROM pg_catalog.pg_statistic_ext stats
            UNION ALL SELECT config.oid, config.cfgnamespace FROM pg_catalog.pg_ts_config config
            UNION ALL SELECT dictionary.oid, dictionary.dictnamespace FROM pg_catalog.pg_ts_dict dictionary
            UNION ALL SELECT parser.oid, parser.prsnamespace FROM pg_catalog.pg_ts_parser parser
            UNION ALL SELECT template.oid, template.tmplnamespace FROM pg_catalog.pg_ts_template template
            UNION ALL SELECT extension.oid, extension.extnamespace FROM pg_catalog.pg_extension extension
          ) object_row
         WHERE object_row.namespace_oid IN (SELECT oid FROM user_namespaces)
      )
      SELECT to_regclass('public.expense_warrior_schema_migrations') IS NOT NULL AS ledger_exists,
             (SELECT count(*)::int FROM user_objects) AS application_object_count
      `)
    } catch (error) {
      error.migrationStage = 'schema_inventory'
      throw error
    }
    const schemaState = schema.rows?.[0] || { ledger_exists: false, application_object_count: 0 }
    const migrationByName = new Map(migrations.map((migration) => [migration.name, migration]))
    let ledgerRows = []
    if (schemaState.ledger_exists) {
      try {
        ledgerRows = (await client.query('SELECT migration_name, checksum FROM expense_warrior_schema_migrations ORDER BY migration_name')).rows || []
      } catch (error) {
        error.migrationStage = 'migration_ledger_read'
        throw error
      }
    }
    const blockers = []
    const rowsByName = new Map()
    for (const row of ledgerRows) {
      const name = String(row.migration_name || '')
      rowsByName.set(name, (rowsByName.get(name) || 0) + 1)
      if (!migrationByName.has(name)) blockers.push('UNKNOWN_LEDGER_MIGRATION')
    }
    if ([...rowsByName.values()].some((count) => count > 1)) blockers.push('DUPLICATE_LEDGER_ROW')

    const applied = []
    let postconditionResults = []
    for (const row of ledgerRows) {
      const source = migrationByName.get(String(row.migration_name || ''))
      if (!source) continue
      const checksum = String(row.checksum || '').trim()
      if (checksum !== source.checksum) blockers.push('MIGRATION_CHECKSUM_MISMATCH')
      applied.push({ name: source.name, checksum, matchesSource: checksum === source.checksum })
    }
    const appliedNames = new Set(applied.map(({ name }) => name))
    const pending = migrations
      .filter(({ name }) => !appliedNames.has(name))
      .map(({ name, checksum }) => ({ name, checksum }))

    if (schemaState.ledger_exists) {
      if (applied.length === 0) blockers.push('EMPTY_MIGRATION_LEDGER')
      if (migrations.every(({ name }) => MIGRATION_POSTCONDITIONS[name])) {
        let schemaChecks
        try {
          schemaChecks = await verifyMigrationPostconditions(client, migrations)
        } catch (error) {
          error.migrationStage = 'migration_postconditions'
          throw error
        }
        const checkByName = new Map(schemaChecks.verified.map((check) => [check.migration, check]))
        for (const migration of applied) {
          if (!checkByName.get(migration.name)?.passed) blockers.push('POSTCONDITION_FAILED')
        }
        const legacyCandidate = pending.length === 1 ? checkByName.get(pending[0].name) : null
        const legacyBlockers = [...blockers]
        if (legacyCandidate && !legacyCandidate.passed && legacyCandidate.presentCount > 0) legacyBlockers.push('PARTIAL_MIGRATION_SCHEMA')
        const recognizedLegacyRequestDestination = canApplyLegacyRequestDestinationMigration({
          state: legacyBlockers.length ? 'BLOCKED' : 'READY',
          blockers: legacyBlockers,
          applied,
          pending,
          postconditions: schemaChecks.verified,
        }, migrations)
        for (const migration of pending) {
          const check = checkByName.get(migration.name)
          if (!check || check.presentCount === 0) continue
          if (recognizedLegacyRequestDestination && migration.name === REQUEST_DESTINATION_MIGRATION) continue
          blockers.push(check.passed ? 'MIGRATION_SCHEMA_AHEAD_OF_LEDGER' : 'PARTIAL_MIGRATION_SCHEMA')
        }
        postconditionResults = schemaChecks.verified.map((check) => recognizedLegacyRequestDestination && check.migration === REQUEST_DESTINATION_MIGRATION
          ? { ...check, recognizedLegacyBaseSchema: true }
          : check)
      }
    }

    let state
    if (!schemaState.ledger_exists && Number(schemaState.application_object_count) > 0) {
      state = 'MANUAL_REVIEW_REQUIRED'
      blockers.push('MIGRATION_LEDGER_MISSING_FOR_NON_EMPTY_SCHEMA')
    } else if (blockers.length) {
      state = 'BLOCKED'
    } else if (!schemaState.ledger_exists) {
      state = 'NEW_EMPTY_DATABASE'
    } else {
      state = 'READY'
    }

    return {
      target: { name: target.name, host: target.host, port: target.port, database: target.database, user: target.user, schema: target.schema, searchPath: target.searchPath },
      state,
      applied,
      pending,
      blockers: [...new Set(blockers)],
      ...(postconditionResults.length ? { postconditions: postconditionResults } : {}),
    }
  } finally {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {})
  }
}

async function planMigrations(options = {}) {
  const status = await inspectMigrations(options)
  return {
    target: status.target,
    state: status.state,
    steps: status.pending.map(({ name, checksum }) => ({ name, checksum })),
    blockers: status.blockers,
  }
}

async function verifyMigrations({ pool, target, directory } = {}) {
  const migrations = await collectMigrations(directory)
  const status = await inspectMigrations({ pool, target, directory })
  const blockers = [...status.blockers]
  if (status.state === 'NEW_EMPTY_DATABASE' || status.pending.length > 0) blockers.push('MIGRATIONS_PENDING')
  if (status.state === 'MANUAL_REVIEW_REQUIRED' || status.state === 'BLOCKED' || blockers.length) {
    return { target: status.target, verified: false, blockers: [...new Set(blockers)] }
  }

  const client = await pool.connect()
  let transactionStarted = false
  try {
    await client.query('BEGIN READ ONLY')
    transactionStarted = true
    await assertMigrationTargetIdentity(client, target)
    const postconditions = await verifyMigrationPostconditions(client, migrations)
    blockers.push(...postconditions.blockers)
    return {
      target: status.target,
      verified: postconditions.blockers.length === 0 && postconditions.verified.length === migrations.length && postconditions.verified.every(({ passed }) => passed),
      blockers: [...new Set(blockers)],
    }
  } catch {
    return { target: status.target, verified: false, blockers: ['MIGRATION_VERIFY_FAILED'] }
  } finally {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

function canRecoverPartialRuntimePermissions(status, migrations) {
  if (status?.blockers?.length !== 1 || status.blockers[0] !== 'PARTIAL_MIGRATION_SCHEMA') return false
  if (status.pending?.length !== 1 || status.pending[0].name !== RUNTIME_ROLE_PERMISSIONS_MIGRATION) return false
  const migration = migrations.find(({ name }) => name === RUNTIME_ROLE_PERMISSIONS_MIGRATION)
  if (!migration || migration.checksum !== RUNTIME_ROLE_PERMISSIONS_CHECKSUM) return false
  const postcondition = status.postconditions?.find(({ migration: name }) => name === RUNTIME_ROLE_PERMISSIONS_MIGRATION)
  return Boolean(postcondition && !postcondition.passed && postcondition.failedChecks?.length > 0 &&
    postcondition.failedChecks.every((name) => /^(?:privilege|column-privilege|database-privilege|schema-privilege):/.test(name)))
}

function normalizeConstraintDefinition(definition) {
  return String(definition || '').toLowerCase().replace(/\s*::\s*text\b/g, '').replace(/\s+/g, ' ').trim()
}

function canApplyLegacyRequestDestinationMigration(status, migrations) {
  if (status?.blockers?.length !== 1 || status.blockers[0] !== 'PARTIAL_MIGRATION_SCHEMA') return false
  if (status.pending?.length !== 1 || status.pending[0].name !== REQUEST_DESTINATION_MIGRATION ||
      status.pending[0].checksum !== REQUEST_DESTINATION_CHECKSUM) return false
  if (migrations.at(-1)?.name !== REQUEST_DESTINATION_MIGRATION ||
      migrations.at(-1)?.checksum !== REQUEST_DESTINATION_CHECKSUM ||
      status.applied?.length !== migrations.length - 1) return false
  for (let index = 0; index < migrations.length - 1; index += 1) {
    const migration = migrations[index]
    const applied = status.applied[index]
    if (!applied || applied.name !== migration.name || applied.matchesSource !== true || applied.checksum !== migration.checksum) return false
  }
  const failed = status.postconditions?.find(({ migration }) => migration === REQUEST_DESTINATION_MIGRATION)
  if (!failed || failed.passed || JSON.stringify([...(failed.failedChecks || [])].sort()) !== JSON.stringify(REQUEST_DESTINATION_LEGACY_FAILURES)) return false
  const details = new Map((failed.constraintDetails || []).map((detail) => [detail.name, detail]))
  return Object.entries(REQUEST_DESTINATION_LEGACY_CONSTRAINTS).every(([name, expected]) => {
    const actual = details.get(name)
    return actual?.present === true && actual.validated === true &&
      normalizeConstraintDefinition(actual.definition) === normalizeConstraintDefinition(expected)
  }) && status.postconditions
    .filter(({ migration }) => migration !== REQUEST_DESTINATION_MIGRATION)
    .every(({ passed }) => passed === true)
}

async function runMigrations({ pool, target, env = process.env, directory, verifyPostconditions = verifyMigrationPostconditions } = {}) {
  assertMigrationAllowed(env)
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required')
  if (!target) {
    const error = new Error('A named, allowlisted migration target is required')
    error.code = 'MIGRATION_TARGET_CONFIG_INVALID'
    throw error
  }

  const migrations = await collectMigrations(directory)
  const client = await pool.connect()
  let locked = false
  try {
    await client.query('BEGIN READ ONLY')
    try {
      await assertMigrationTargetIdentity(client, target)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
    }
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_ID])
    if (lock.rows?.[0]?.acquired !== true) throw migrationError('MIGRATION_LOCK_UNAVAILABLE', 'Another migration process holds the migration lock')
    locked = true
    const status = await inspectMigrationClient(client, target, migrations)
    const recoverPartialRuntimePermissions = canRecoverPartialRuntimePermissions(status, migrations)
    if (status.state === 'MANUAL_REVIEW_REQUIRED' || (status.state === 'BLOCKED' && !recoverPartialRuntimePermissions)) {
      throw migrationError(status.blockers[0] || 'MIGRATION_PREFLIGHT_BLOCKED', 'Migration preflight is blocked; inspect status before applying')
    }
    let bootstrapLedger = status.state === 'NEW_EMPTY_DATABASE'
    const applied = []
    for (const pending of status.pending) {
      const migration = migrations.find(({ name }) => name === pending.name)
      if (!migration) throw migrationError('MIGRATION_SOURCE_MISMATCH', 'Migration source changed during preflight')
      await client.query('BEGIN')
      try {
        await client.query("SET LOCAL lock_timeout = '5s'")
        await client.query("SET LOCAL statement_timeout = '60s'")
        if (bootstrapLedger) {
          await client.query(`
            CREATE TABLE expense_warrior_schema_migrations (
              migration_name text PRIMARY KEY,
              checksum char(64) NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
          `)
        }
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO expense_warrior_schema_migrations (migration_name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum]
        )
        if ((recoverPartialRuntimePermissions && migration.name === RUNTIME_ROLE_PERMISSIONS_MIGRATION) ||
            migration.name === REQUEST_DESTINATION_MIGRATION) {
          const postconditions = await verifyPostconditions(client, [migration])
          const result = postconditions.verified?.find(({ migration: name }) => name === migration.name)
          if (postconditions.blockers?.length || !result?.passed) {
            throw migrationError('MIGRATION_POSTCONDITION_FAILED', 'Recovered runtime permissions did not satisfy migration postconditions')
          }
        }
        await client.query('COMMIT')
        applied.push(migration.name)
        if (bootstrapLedger) bootstrapLedger = false
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return { applied }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {})
    client.release()
  }
}

if (require.main === module) {
  const dotenv = require('dotenv')
  dotenv.config()
  const { loadConfig, loadMigrationTargetConfig } = require('../config/env')
  const { createPool } = require('./pool')

  let pool
  try {
    const command = process.argv[2] || 'apply'
    if (!['apply', 'status', 'plan', 'verify'].includes(command)) throw migrationError('MIGRATION_COMMAND_INVALID', 'Unknown migration command')
    if (command === 'apply') assertMigrationAllowed()
    const migrationEnvPath = path.resolve(process.cwd(), '.env.migrations')
    const migrationEnv = fsSync.existsSync(migrationEnvPath)
      ? dotenv.parse(fsSync.readFileSync(migrationEnvPath))
      : {}
    const migrationSource = { ...process.env, ...migrationEnv }
    const target = loadMigrationTargetConfig(migrationSource)
    pool = createPool(getMigrationDatabaseConfig(loadConfig(migrationSource, { includeMigrationCredentials: true })))
    const operation = command === 'status'
      ? inspectMigrations({ pool, target })
      : command === 'plan'
        ? planMigrations({ pool, target })
        : command === 'verify'
          ? verifyMigrations({ pool, target })
          : runMigrations({ pool, target })
    operation
      .then((result) => {
        if (command === 'apply') {
          console.log(JSON.stringify({ event: 'migrations_applied', count: result.applied.length }))
          return
        }
        console.log(JSON.stringify({ event: `migrations_${command}`, ...result }))
        if (result.state === 'BLOCKED' || result.state === 'MANUAL_REVIEW_REQUIRED' || result.verified === false) process.exitCode = 1
      })
      .catch((error) => {
        console.error(JSON.stringify(serializeMigrationFailure(error)))
        process.exitCode = 1
      })
      .finally(() => pool?.end())
  } catch (error) {
    console.error(JSON.stringify(serializeMigrationFailure(error)))
    process.exitCode = 1
  }
}

module.exports = { assertMigrationAllowed, assertMigrationTargetIdentity, canApplyLegacyRequestDestinationMigration, canRecoverPartialRuntimePermissions, collectMigrations, getMigrationDatabaseConfig, inspectMigrations, planMigrations, runMigrations, serializeMigrationFailure, verifyMigrations }
