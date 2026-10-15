const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const crypto = require('node:crypto')
const { createPublicPaymentRouter } = require('../src/paymentLinks/publicPaymentRoutes')
const { createPublicPaymentService } = require('../src/paymentLinks/publicPaymentService')

const token = 'B'.repeat(43)
const attemptId = '10000000-0000-4000-8000-000000000001'
const paidAttempt = {
  attempt_id: attemptId,
  payment_link_id: '20000000-0000-4000-8000-000000000001',
  public_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
  description: 'Office supplies',
  provider_code: 'pawapay',
  provider_transaction_id: attemptId,
  provider_reference: 'provider-reference-123',
  network_code: 'MTN_MOMO_ZMB',
  payer_phone: '260763456789',
  amount: '125.00',
  currency: 'ZMW',
  state: 'SUCCEEDED',
  verified_at: '2026-10-15T12:00:00.000Z',
  ledger_operation_id: '30000000-0000-4000-8000-000000000001',
  created_at: '2026-10-15T11:58:00.000Z',
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('receipt endpoint serves a PDF only after the ledger records a verified payment', async (t) => {
  let currentAttempt = { ...paidAttempt }
  let requestedTokenHash
  const paymentService = createPublicPaymentService({
    repository: {
      getPublicAttempt: async (tokenHash, requestedAttemptId) => {
        requestedTokenHash = tokenHash
        return requestedAttemptId === attemptId && currentAttempt.public_token_hash === tokenHash ? currentAttempt : null
      },
      getPublicLink: async () => null,
    },
    providerRegistry: null,
  })
  const app = express()
  app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({ paymentService }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  let response = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts/${attemptId}/receipt`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.match(response.headers.get('content-disposition'), new RegExp(`expense-warrior-receipt-${attemptId}\\.pdf`))
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const pdf = Buffer.from(await response.arrayBuffer())
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length < 32768)
  assert.ok(requestedTokenHash)
  assert.equal(pdf.toString('latin1').includes('260763456789'), false)

  currentAttempt = { ...paidAttempt, state: 'VERIFIED_PENDING_LEDGER', ledger_operation_id: null }
  response = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts/${attemptId}/receipt`)
  assert.equal(response.status, 404)
})

test('receipt endpoint does not disclose another link attempt or accept malformed identifiers', async (t) => {
  let reads = 0
  const paymentService = createPublicPaymentService({
    repository: { getPublicAttempt: async () => { reads += 1; return null }, getPublicLink: async () => null },
    providerRegistry: null,
  })
  const app = express()
  app.use('/api/v1/expense-warrior/public/payment-links', createPublicPaymentRouter({ paymentService }))
  const { server, url } = await listen(app)
  t.after(() => server.close())

  const missing = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts/${attemptId}/receipt`)
  assert.equal(missing.status, 404)
  const malformed = await fetch(`${url}/api/v1/expense-warrior/public/payment-links/${token}/attempts/not-a-uuid/receipt`)
  assert.equal(malformed.status, 404)
  assert.equal(reads, 1)
})
