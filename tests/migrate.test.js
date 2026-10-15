const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { collectMigrations, assertMigrationAllowed } = require('../src/db/migrate')

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
