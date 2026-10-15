const test = require('node:test')
const assert = require('node:assert/strict')
const { createProviderBalanceRepository } = require('../src/wallet/providerBalanceRepository')

test('recordBatch writes a complete provider snapshot atomically', async () => {
  const calls = []
  const client = {
    query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] } },
    release: () => calls.push({ sql: 'RELEASE' }),
  }
  const repository = createProviderBalanceRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) }, idFactory: () => 'batch-id' })
  const result = await repository.recordBatch({
    provider: 'pawapay', country: 'ZMB', retrievedAt: '2026-10-15T12:00:00.000Z',
    balances: [{ provider: '', balance: '123.45' }, { provider: 'MTN_MOMO_ZMB', balance: '20.00' }],
  })
  assert.equal(result.snapshotBatchId, 'batch-id')
  assert.deepEqual(calls.map((call) => call.sql.trim().split(/\s+/)[0]), ['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'COMMIT', 'RELEASE'])
  assert.deepEqual(calls[2].values, ['batch-id', null, '123.45'])
  assert.deepEqual(calls[3].values, ['batch-id', 'MTN_MOMO_ZMB', '20.00'])
})

test('recordBatch rolls back and releases the connection when a snapshot row fails', async () => {
  const calls = []
  let insertCount = 0
  const client = {
    query: async (sql) => {
      calls.push(sql.trim().split(/\s+/)[0])
      if (sql.includes('INSERT INTO provider_balance_snapshot_items') && ++insertCount === 2) throw Object.assign(new Error('db failure'), { code: 'DB_CONSTRAINT' })
      return { rows: [] }
    },
    release: () => calls.push('RELEASE'),
  }
  const repository = createProviderBalanceRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } })
  await assert.rejects(repository.recordBatch({
    retrievedAt: '2026-10-15T12:00:00.000Z', balances: [{ provider: '', balance: '1.00' }, { provider: 'MTN_MOMO_ZMB', balance: '2.00' }],
  }), { code: 'DB_CONSTRAINT' })
  assert.ok(calls.includes('ROLLBACK'))
  assert.equal(calls.at(-1), 'RELEASE')
  assert.equal(calls.includes('COMMIT'), false)
})

test('listRecent uses a bounded parameterized limit', async () => {
  let captured
  const repository = createProviderBalanceRepository({
    pool: { connect: async () => assert.fail('history is read-only'), query: async (sql, values) => { captured = { sql, values }; return { rows: [{ snapshot_batch_id: 'id' }] } } },
  })
  const rows = await repository.listRecent({ limit: 25 })
  assert.equal(rows[0].snapshot_batch_id, 'id')
  assert.deepEqual(captured.values, [25])
  assert.match(captured.sql, /ORDER BY batch\.retrieved_at DESC/)
})
