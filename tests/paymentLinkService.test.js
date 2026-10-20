const test = require('node:test')
const assert = require('node:assert/strict')
const { createPaymentLinkService, PaymentLinkError } = require('../src/paymentLinks/paymentLinkService')

const actor = { customerId: 'a8d2c6f1-7439-4d30-9f48-2e3b6f4a1c90' }
const revenueTarget = { type: 'REVENUE', revenue_account_code: '4000' }

test('createLink returns the opaque token once and stores only its SHA-256 hash', async () => {
  const saved = []
  const token = 'A'.repeat(64)
  const service = createPaymentLinkService({
    repository: { create: async (record) => { saved.push(record); return { link: { payment_link_id: 'link-id', amount: record.amount, status: 'ACTIVE' }, replayed: false } } },
  })
  const result = await service.createLink(actor, { amount: '250.00', description: '  Petty cash top-up  ', target: revenueTarget, publicToken: token }, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66')
  assert.equal(result.token, token)
  assert.equal(result.link.status, 'ACTIVE')
  assert.equal(saved[0].description, 'Petty cash top-up')
  assert.deepEqual(saved[0].target, { type: 'REVENUE', revenueAccountCode: '4000' })
  assert.match(saved[0].tokenHash, /^[a-f0-9]{64}$/)
  assert.equal(saved[0].tokenHash.includes(result.token), false)
  assert.match(saved[0].requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(saved[0].idempotencyKey, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66')
})

test('createLink rejects malformed amounts before persistence', async () => {
  let calls = 0
  const service = createPaymentLinkService({ repository: { create: async () => { calls++ } } })
  await assert.rejects(service.createLink(actor, { amount: '1.239', description: 'x', target: revenueTarget, publicToken: 'A'.repeat(64) }, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66'), (error) => error instanceof PaymentLinkError && error.statusCode === 400)
  assert.equal(calls, 0)
})

test('createLink returns the same one-time token when the repository identifies an exact idempotent replay', async () => {
  const token = 'b'.repeat(64)
  const service = createPaymentLinkService({
    repository: { create: async () => ({ link: { payment_link_id: 'same-link', status: 'ACTIVE' }, replayed: true }) },
  })
  const result = await service.createLink(actor, { amount: '2.50', description: 'Top up', target: revenueTarget, publicToken: token }, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66')
  assert.equal(result.link.payment_link_id, 'same-link')
  assert.equal(result.token, token)
  assert.equal(result.replayed, true)
})

test('createLink requires an exact recognized target object', async () => {
  let calls = 0
  const service = createPaymentLinkService({ repository: { create: async () => { calls++ } } })
  await assert.rejects(service.createLink(actor, {
    amount: '2.50', description: 'Top up', target: { type: 'CUSTOMER_CREDIT', customer_id: 'a8d2c6f1-7439-4d30-9f48-2e3b6f4a1c90', revenue_account_code: '4000' },
    publicToken: 'c'.repeat(64),
  }, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66'), (error) => error instanceof PaymentLinkError && error.code === 'PAYMENT_LINK_TARGET_INVALID')
  assert.equal(calls, 0)
})

test('createLink rejects deferred A/R settlement targets before persistence', async () => {
  let calls = 0
  const service = createPaymentLinkService({ repository: { create: async () => { calls++ } } })
  await assert.rejects(service.createLink(actor, {
    amount: '125.00', description: 'Invoice',
    target: { type: 'AR_SETTLEMENT', customer_id: actor.customerId, receivable_id: '60000000-0000-4000-8000-000000000001' },
    publicToken: 'A'.repeat(64),
  }, 'c3d5fcb6-9424-41b8-9f8b-5f14bb8e3f66'), (error) => error instanceof PaymentLinkError && error.code === 'PAYMENT_LINK_TARGET_DEFERRED')
  assert.equal(calls, 0)
})
