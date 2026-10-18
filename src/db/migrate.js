const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MIGRATION_CONFIRMATION = 'APPLY'
const ADVISORY_LOCK_ID = 455752

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
  let serverMatches = false
  try {
    const result = await client.query(`
      SELECT current_database() AS database,
             current_user AS current_role_name,
             session_user AS session_role_name,
             pg_is_in_recovery() AS is_in_recovery
    `)
    const identity = result.rows?.[0]
    serverMatches = Boolean(identity) &&
      identity.database === target.database &&
      identity.current_role_name === target.user &&
      identity.session_role_name === target.user &&
      identity.is_in_recovery === false
  } catch {
    serverMatches = false
  }
  if (!connectionMatches || !serverMatches) {
    const error = new Error('Connected database identity does not match the selected migration target')
    error.code = 'MIGRATION_TARGET_IDENTITY_MISMATCH'
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

async function runMigrations({ pool, target, env = process.env, directory } = {}) {
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
    await assertMigrationTargetIdentity(client, target)
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID])
    locked = true
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_warrior_schema_migrations (
        migration_name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const applied = []
    for (const migration of migrations) {
      const existing = await client.query(
        'SELECT checksum FROM expense_warrior_schema_migrations WHERE migration_name = $1',
        [migration.name]
      )
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum) {
          const error = new Error(`Applied migration checksum changed: ${migration.name}`)
          error.code = 'MIGRATION_CHECKSUM_MISMATCH'
          throw error
        }
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO expense_warrior_schema_migrations (migration_name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum]
        )
        await client.query('COMMIT')
        applied.push(migration.name)
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
    assertMigrationAllowed()
    const migrationEnvPath = path.resolve(process.cwd(), '.env.migrations')
    const migrationEnv = fsSync.existsSync(migrationEnvPath)
      ? dotenv.parse(fsSync.readFileSync(migrationEnvPath))
      : {}
    const migrationSource = { ...process.env, ...migrationEnv }
    const target = loadMigrationTargetConfig(migrationSource)
    pool = createPool(getMigrationDatabaseConfig(loadConfig(migrationSource, { includeMigrationCredentials: true })))
    runMigrations({ pool, target })
      .then(({ applied }) => console.log(JSON.stringify({ event: 'migrations_applied', count: applied.length })))
      .catch((error) => {
        console.error(JSON.stringify({ event: 'migration_failed', code: error.code || 'MIGRATION_FAILED' }))
        process.exitCode = 1
      })
      .finally(() => pool?.end())
  } catch (error) {
    console.error(JSON.stringify({ event: 'migration_failed', code: error.code || 'MIGRATION_FAILED' }))
    process.exitCode = 1
  }
}

module.exports = { assertMigrationAllowed, assertMigrationTargetIdentity, collectMigrations, getMigrationDatabaseConfig, runMigrations }
