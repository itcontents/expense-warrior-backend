const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createPublicPaymentRouter } = require('../src/paymentLinks/publicPaymentRoutes')

const token = 'A'.repeat(43)
const attemptId = '10000000-0000-4000-8000-000000000001'

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('public checkout returns safe fixed link details, accepts a phone and network, and refreshes status', async (t) => {
  const calls = []
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({
    paymentService: {
      getLink: async (providedToken) => { calls.push(['getLink', providedToken]); return { description: 'Office supplies', amount: '125.00', currency: 'ZMW' } },
      startAttempt: async (...args) => { calls.push(['start', ...args]); return { attempt: { attempt_id: attemptId, status: 'PENDING', amount: '125.00', currency: 'ZMW', receipt_available: false }, replayed: false } },
      refreshAttempt: async (...args) => { calls.push(['refresh', ...args]); return { attempt_id: attemptId, status: 'VERIFYING_LEDGER', receipt_available: false } },
      getReceipt: async () => ({ pdf: Buffer.from('%PDF-'), filename: 'receipt.pdf' }),
    },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const linkResponse = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}`)
  assert.equal(linkResponse.status, 200)
  assert.equal(linkResponse.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual((await linkResponse.json()).data.link, { description: 'Office supplies', amount: '125.00', currency: 'ZMW' })

  const started = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': attemptId },
    body: JSON.stringify({ network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }),
  })
  assert.equal(started.status, 202)
  assert.equal((await started.json()).data.attempt.status, 'PENDING')
  assert.equal(calls.at(-1)[3], attemptId)

  const refreshed = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts/${attemptId}`)
  assert.equal(refreshed.status, 200)
  assert.equal((await refreshed.json()).data.attempt.status, 'VERIFYING_LEDGER')
})

test('public checkout rejects amount overrides, invalid phone, and missing idempotency before service calls', async (t) => {
  let calls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({
    paymentService: { getLink: async () => ({}), startAttempt: async () => { calls++; return {} }, refreshAttempt: async () => ({}), getReceipt: async () => ({ pdf: Buffer.from('%PDF-'), filename: 'receipt.pdf' }) },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const response = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': attemptId },
    body: JSON.stringify({ network_code: 'MTN_MOMO_ZMB', phone_number: '260123', amount: '1.00' }),
  })
  assert.equal(response.status, 400)
  const noKey = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }),
  })
  assert.equal(noKey.status, 400)
  assert.equal(calls, 0)
})

test('public payment attempt creation is rate limited per source address', async (t) => {
  let calls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({
    paymentService: {
      getLink: async () => ({}),
      startAttempt: async () => { calls++; return { attempt: { attempt_id: attemptId }, replayed: false } },
      refreshAttempt: async () => ({}),
      getReceipt: async () => ({ pdf: Buffer.from('%PDF-'), filename: 'receipt.pdf' }),
    },
  }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  let last
  for (let index = 0; index < 6; index++) {
    last = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` },
      body: JSON.stringify({ network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }),
    })
  }
  assert.equal(last.status, 429)
  assert.ok(last.headers.get('retry-after'))
  assert.equal(calls, 5)
})
