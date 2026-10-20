const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

require('dotenv').config()
const { loadConfig } = require('../src/config/env')
const { createPaymentLinkRepository } = require('../src/paymentLinks/paymentLinkRepository')
const { createTemporaryTables } = require('./helpers/postgresTestSchema')

const enabled = process.env.EW_RUN_POSTGRES_TESTS === '1'
const TABLES = Object.freeze([
  'payment_links',
  'payment_link_creation_requests',
  'payment_link_attempts',
  'audit_events',
])

test('payment-link repository persists idempotent links and verified collections in temporary PostgreSQL tables', { skip: !enabled }, async () => {
  const pool = new Pool({ ...loadConfig().database, max: 1, application_name: 'expense-warrior-payment-link-postgres-test' })
  try {
    const client = await pool.connect()
    try {
      const identity = await client.query(`
        SELECT current_database() AS database, current_user AS role, role.rolsuper AS superuser
          FROM pg_roles role
         WHERE role.rolname = current_user
      `)
      assert.equal(identity.rows[0]?.database, 'expense_warrior', 'test must use the dedicated local Expense Warrior database')
      assert.equal(identity.rows[0]?.role, 'expense_warrior_app', 'test must use the restricted runtime account')
      assert.equal(identity.rows[0]?.superuser, false, 'test refuses a superuser database identity')

      await createTemporaryTables(client, TABLES)
      const resolution = await client.query(`
        SELECT to_regclass('payment_links')::text AS links,
               to_regclass('payment_link_attempts')::text AS attempts,
               to_regclass('pg_temp.payment_links')::text AS temporary_links,
               to_regclass('pg_temp.payment_link_attempts')::text AS temporary_attempts
      `)
      assert.equal(resolution.rows[0].links, resolution.rows[0].temporary_links,
        'repository link table names must resolve to session-local temporary tables')
      assert.equal(resolution.rows[0].attempts, resolution.rows[0].temporary_attempts,
        'repository attempt table names must resolve to session-local temporary tables')
    } finally {
      client.release()
    }

    const repository = createPaymentLinkRepository({ pool })
    const actorCustomerId = randomUUID()
    const linkInput = {
      amount: '75.50',
      description: 'PostgreSQL collection test',
      target: { type: 'REVENUE', revenueAccountCode: '4100' },
      tokenHash: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      idempotencyKey: randomUUID(),
      actorCustomerId,
    }
    const created = await repository.create(linkInput)
    assert.equal(created.replayed, false)
    assert.equal(created.link.amount, '75.50')
    assert.equal(created.link.collection_target_type, 'REVENUE')

    const replay = await repository.create(linkInput)
    assert.equal(replay.replayed, true)
    assert.equal(replay.link.payment_link_id, created.link.payment_link_id)
    await assert.rejects(
      repository.create({ ...linkInput, requestFingerprint: 'c'.repeat(64) }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    )

    const attemptInput = {
      attemptId: randomUUID(),
      tokenHash: linkInput.tokenHash,
      idempotencyKey: randomUUID(),
      requestFingerprint: 'd'.repeat(64),
      providerCode: 'pawapay',
      networkCode: 'AIRTEL_OAPI_ZMB',
      phoneNumber: '260977123456',
      providerAccountId: randomUUID(),
      providerAccountVersion: 4,
    }
    const firstAttempt = await repository.createAttempt(attemptInput)
    assert.equal(firstAttempt.replayed, false)
    assert.equal(firstAttempt.attempt.state, 'SUBMITTING')
    assert.equal(firstAttempt.attempt.provider_code, attemptInput.providerCode)
    assert.equal(firstAttempt.attempt.provider_account_version, 4)

    const replayedAttempt = await repository.createAttempt({ ...attemptInput, attemptId: randomUUID() })
    assert.equal(replayedAttempt.replayed, true)
    assert.equal(replayedAttempt.attempt.attempt_id, attemptInput.attemptId)
    assert.equal(replayedAttempt.attempt.provider_code, attemptInput.providerCode)
    await assert.rejects(
      repository.createAttempt({ ...attemptInput, requestFingerprint: 'e'.repeat(64) }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    )

    const verified = await repository.updateAttempt(attemptInput.attemptId, {
      state: 'VERIFIED_PENDING_LEDGER',
      providerStatus: 'COMPLETED',
      providerReference: 'provider-ref-test',
      verified: true,
      evidenceDigest: 'f'.repeat(64),
    })
    assert.equal(verified.state, 'VERIFIED_PENDING_LEDGER')
    assert.equal(verified.provider_code, attemptInput.providerCode)
    const succeeded = await repository.markAttemptSucceeded(attemptInput.attemptId, randomUUID())
    assert.equal(succeeded.state, 'SUCCEEDED')
    assert.equal(succeeded.provider_code, attemptInput.providerCode)

    const addonAccountId = randomUUID()
    const distinctPayment = await repository.createAttempt({
      ...attemptInput,
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: '1'.repeat(64),
      phoneNumber: '260977654321',
      providerCode: 'airtel_direct',
      providerAccountId: addonAccountId,
      providerAccountVersion: 5,
    })
    assert.equal(distinctPayment.replayed, false, 'a reusable revenue link accepts a new independent payment attempt')
    assert.equal(distinctPayment.attempt.provider_code, 'airtel_direct')
    assert.equal(distinctPayment.attempt.network_code, attemptInput.networkCode,
      'different providers may safely use the same network code')

    const audit = await pool.query(`SELECT count(*)::int AS count FROM audit_events`)
    assert.equal(audit.rows[0].count, 1, 'creation replay must not duplicate the audit record')
    const attempts = await pool.query(`SELECT count(*)::int AS count FROM payment_link_attempts`)
    assert.equal(attempts.rows[0].count, 2, 'attempt replay must not insert another provider attempt')

    const persisted = await pool.query(`
      SELECT state, provider_code, network_code, provider_account_id, provider_account_version, ledger_operation_id
        FROM payment_link_attempts WHERE attempt_id = ANY($1::uuid[])
    `, [[attemptInput.attemptId, distinctPayment.attempt.attempt_id]])
    const persistedByProvider = new Map(persisted.rows.map((row) => [row.provider_code, row]))
    assert.equal(persistedByProvider.get('pawapay').state, 'SUCCEEDED')
    assert.equal(persistedByProvider.get('pawapay').provider_account_id, attemptInput.providerAccountId)
    assert.equal(persistedByProvider.get('pawapay').provider_account_version, 4)
    assert.ok(persistedByProvider.get('pawapay').ledger_operation_id)
    assert.equal(persistedByProvider.get('airtel_direct').network_code, attemptInput.networkCode)
    assert.equal(persistedByProvider.get('airtel_direct').provider_account_id, addonAccountId)
    assert.equal(persistedByProvider.get('airtel_direct').provider_account_version, 5)
    const activeRevenueLink = await repository.getPublicLink(linkInput.tokenHash)
    assert.equal(activeRevenueLink.status, 'ACTIVE', 'revenue payment links remain reusable after a successful collection')
  } finally {
    await pool.end()
  }
})
