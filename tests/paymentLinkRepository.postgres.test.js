const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')

require('dotenv').config()
const { loadConfig } = require('../src/config/env')
const { createPaymentLinkRepository } = require('../src/paymentLinks/paymentLinkRepository')

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

      for (const table of TABLES) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`)
      }
      // Migration 0013 is deliberately unapplied. Add its exact shape only to this
      // session's temporary table so the source-only repository contract is testable.
      await client.query(`
        ALTER TABLE pg_temp.payment_link_attempts
          ADD COLUMN provider_account_id uuid,
          ADD COLUMN provider_account_version integer,
          ADD CONSTRAINT payment_link_attempts_provider_account_pair_check
            CHECK (
              (provider_account_id IS NULL AND provider_account_version IS NULL)
              OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
            )
      `)
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
    assert.equal(firstAttempt.attempt.provider_account_version, 4)

    const replayedAttempt = await repository.createAttempt({ ...attemptInput, attemptId: randomUUID() })
    assert.equal(replayedAttempt.replayed, true)
    assert.equal(replayedAttempt.attempt.attempt_id, attemptInput.attemptId)
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
    const succeeded = await repository.markAttemptSucceeded(attemptInput.attemptId, randomUUID())
    assert.equal(succeeded.state, 'SUCCEEDED')

    const distinctPayment = await repository.createAttempt({
      ...attemptInput,
      attemptId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: '1'.repeat(64),
      phoneNumber: '260977654321',
    })
    assert.equal(distinctPayment.replayed, false, 'a reusable revenue link accepts a new independent payment attempt')

    const customerId = randomUUID()
    const receivableId = randomUUID()
    const arLinkInputs = [0, 1].map((index) => ({
      ...linkInput,
      amount: '120.00',
      description: `A/R PostgreSQL collection test ${index}`,
      target: { type: 'AR_SETTLEMENT', customerId, receivableId },
      tokenHash: String(index + 2).repeat(64),
      requestFingerprint: String(index + 2).repeat(64),
      idempotencyKey: randomUUID(),
    }))
    const arLinks = await Promise.all(arLinkInputs.map((entry) => repository.create(entry)))
    const arAttempt = await repository.createAttempt({
      ...attemptInput,
      attemptId: randomUUID(),
      tokenHash: arLinkInputs[0].tokenHash,
      idempotencyKey: randomUUID(),
      requestFingerprint: '2'.repeat(64),
    })
    await repository.updateAttempt(arAttempt.attempt.attempt_id, {
      state: 'VERIFIED_PENDING_LEDGER', providerStatus: 'COMPLETED', verified: true,
    })
    await repository.markAttemptSucceeded(arAttempt.attempt.attempt_id, randomUUID())
    const arStates = await pool.query(`
      SELECT status FROM payment_links WHERE payment_link_id = ANY($1::uuid[])
    `, [arLinks.map(({ link }) => link.payment_link_id)])
    assert.deepEqual(arStates.rows.map(({ status }) => status), ['DISABLED', 'DISABLED'],
      'verified A/R collection must close every active link for the settled receivable')

    const audit = await pool.query(`SELECT count(*)::int AS count FROM audit_events`)
    assert.equal(audit.rows[0].count, 5, 'creation replay must not duplicate the audit record; A/R closures are audited')
    const attempts = await pool.query(`SELECT count(*)::int AS count FROM payment_link_attempts`)
    assert.equal(attempts.rows[0].count, 3, 'attempt replay must not insert another provider attempt')

    const persisted = await pool.query(`
      SELECT state, provider_account_id, provider_account_version, ledger_operation_id
        FROM payment_link_attempts WHERE attempt_id = $1
    `, [attemptInput.attemptId])
    assert.equal(persisted.rows[0].state, 'SUCCEEDED')
    assert.equal(persisted.rows[0].provider_account_id, attemptInput.providerAccountId)
    assert.equal(persisted.rows[0].provider_account_version, 4)
    assert.ok(persisted.rows[0].ledger_operation_id)
    const activeRevenueLink = await repository.getPublicLink(linkInput.tokenHash)
    assert.equal(activeRevenueLink.status, 'ACTIVE', 'revenue payment links remain reusable after a successful collection')
  } finally {
    await pool.end()
  }
})
