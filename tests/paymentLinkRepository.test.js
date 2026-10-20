const test = require('node:test')
const assert = require('node:assert/strict')
const { createPaymentLinkRepository } = require('../src/paymentLinks/paymentLinkRepository')
const { PaymentLinkError } = require('../src/paymentLinks/paymentLinkService')

function createMemoryPool() {
  const state = { links: new Map(), requests: new Map(), auditEvents: 0, nextId: 1 }
  const requestKey = (actorId, key) => `${actorId}:${key}`
  const joinedRequest = (actorId, key) => {
    const request = state.requests.get(requestKey(actorId, key))
    const link = request && state.links.get(request.payment_link_id)
    return request && link ? [{ ...request, ...link }] : []
  }

  return {
    state,
    async connect() {
      let snapshot
      return {
        async query(sql, params = []) {
          if (sql.includes('BEGIN')) {
            snapshot = structuredClone(state)
            return { rows: [] }
          }
          if (sql.includes('SELECT i.request_fingerprint')) return { rows: joinedRequest(params[0], params[1]) }
          if (sql.includes('INSERT INTO payment_links')) {
            const id = `11111111-1111-4111-8111-${String(state.nextId++).padStart(12, '0')}`
            const link = {
              payment_link_id: id,
              amount: params[0],
              currency: 'ZMW',
              description: params[1],
              status: 'ACTIVE',
              created_at: new Date().toISOString(),
              collection_target_type: params[4],
              revenue_account_code: params[5],
              customer_id: params[6],
              receivable_id: params[7],
            }
            state.links.set(id, link)
            return { rows: [link] }
          }
          if (sql.includes('INSERT INTO audit_events')) {
            state.auditEvents += 1
            return { rows: [] }
          }
          if (sql.includes('INSERT INTO payment_link_creation_requests')) {
            const key = requestKey(params[0], params[1])
            if (state.requests.has(key)) {
              const error = new Error('unique violation')
              error.code = '23505'
              throw error
            }
            state.requests.set(key, { request_fingerprint: params[2], payment_link_id: params[3] })
            return { rows: [] }
          }
          if (sql.includes('COMMIT')) return { rows: [] }
          if (sql.includes('ROLLBACK')) {
            state.links = snapshot.links
            state.requests = snapshot.requests
            state.auditEvents = snapshot.auditEvents
            state.nextId = snapshot.nextId
            return { rows: [] }
          }
          throw new Error(`Unexpected SQL in test pool: ${sql}`)
        },
        release() {},
      }
    },
    async query(sql, params = []) {
      if (sql.includes('SELECT i.request_fingerprint')) return { rows: joinedRequest(params[0], params[1]) }
      throw new Error(`Unexpected pool SQL in test: ${sql}`)
    },
  }
}

const input = {
  amount: '75.50',
  description: 'Workshop supplies',
  target: { type: 'REVENUE', revenueAccountCode: '4100' },
  tokenHash: 'a'.repeat(64),
  requestFingerprint: 'b'.repeat(64),
  idempotencyKey: 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66',
  actorCustomerId: 'd9cc33b3-b9ae-4dd9-9d27-2214c671b7c2',
}

test('payment-link repository replays the existing link without another audit event', async () => {
  const pool = createMemoryPool()
  const repository = createPaymentLinkRepository({ pool })
  const first = await repository.create(input)
  const replay = await repository.create(input)

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.link.payment_link_id, first.link.payment_link_id)
  assert.equal(pool.state.links.size, 1)
  assert.equal(pool.state.auditEvents, 1)
})

test('payment-link repository rejects changed content for a reused key without creating another link', async () => {
  const pool = createMemoryPool()
  const repository = createPaymentLinkRepository({ pool })
  await repository.create(input)

  await assert.rejects(
    repository.create({ ...input, requestFingerprint: 'f'.repeat(64) }),
    (error) => error instanceof PaymentLinkError && error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409,
  )
  assert.equal(pool.state.links.size, 1)
  assert.equal(pool.state.auditEvents, 1)
})

test('payment-link repository finds an existing attempt by opaque link hash and idempotency key', async () => {
  const expected = {
    attempt_id: '11111111-1111-4111-8111-111111111111',
    request_fingerprint: 'b'.repeat(64), state: 'PENDING', amount: '75.50', currency: 'ZMW',
  }
  let query
  const repository = createPaymentLinkRepository({ pool: {
    connect: async () => { throw new Error('unused') },
    query: async (sql, params) => { query = { sql, params }; return { rows: [expected] } },
  } })
  const result = await repository.getAttemptByIdempotency('a'.repeat(64), input.idempotencyKey)
  assert.deepEqual(result, expected)
  assert.deepEqual(query.params, ['a'.repeat(64), input.idempotencyKey])
  assert.match(query.sql, /l\.public_token_hash = \$1 AND a\.idempotency_key = \$2/)
})
