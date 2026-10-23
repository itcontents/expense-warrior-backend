const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createPaymentLinkRouter } = require('../src/paymentLinks/paymentLinkRoutes')
const { createPublicPaymentService, postConfirmedCollection } = require('../src/paymentLinks/publicPaymentService')

const token = 'T'.repeat(43)
const customerId = '50000000-0000-4000-8000-000000000001'
const receivableId = '50000000-0000-4000-8000-000000000002'
const attemptId = '10000000-0000-4000-8000-000000000001'

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

test('payment-link management rejects A/R creation even when a caller supplies the old enable flag', async () => {
  let itcCalls = 0
  let createCalls = 0
  const app = express()
  app.use(express.json())
  app.use(createPaymentLinkRouter({
    identityClient: { getSession: async () => ({ customerId, role: 'admin', active: true }) },
    paymentLinkService: {
      createLink: async () => { createCalls++; return {} },
      listLinks: async () => ({ items: [] }),
      disableLink: async () => ({}),
    },
    itcFinanceClient: { getReceivable: async () => { itcCalls++; return {} }, getReceivables: async () => { itcCalls++; return {} } },
    receivablesEnabled: true,
  }))

  await withServer(app, async (baseUrl) => {
    const headers = { cookie: 'itc_expense_warrior_access=admin' }
    assert.equal((await fetch(`${baseUrl}/payment-links/capabilities`, { headers })).status, 404)
    assert.equal((await fetch(`${baseUrl}/payment-links/customers/${customerId}/receivables`, { headers })).status, 404)
    const created = await fetch(`${baseUrl}/payment-links`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'Idempotency-Key': attemptId },
      body: JSON.stringify({ amount: '250.00', description: 'Invoice', public_token: 'a'.repeat(64),
        target: { type: 'AR_SETTLEMENT', customer_id: customerId, receivable_id: receivableId } }),
    })
    assert.equal(created.status, 400)
  })

  assert.equal(itcCalls, 0)
  assert.equal(createCalls, 0)
})

test('public payer paths reject old A/R links before provider, attempt, status, or receipt side effects', async () => {
  const calls = []
  const link = { payment_link_id: receivableId, amount: '250.00', currency: 'ZMW', description: 'Invoice',
    collection_target_type: 'AR_SETTLEMENT', customer_id: customerId, receivable_id: attemptId }
  const attempt = { attempt_id: attemptId, public_token_hash: 'hash', collection_target_type: 'AR_SETTLEMENT',
    state: 'PENDING', amount: '250.00', currency: 'ZMW', created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z' }
  const service = createPublicPaymentService({
    repository: {
      getPublicLink: async () => { calls.push('link-read'); return link },
      getPublicAttempt: async () => { calls.push('attempt-read'); return attempt },
      getAttemptByIdempotency: async () => { calls.push('idempotency-read'); return null },
      createAttempt: async () => { calls.push('attempt-create'); throw new Error('must not create an A/R attempt') },
      getReceipt: async () => { calls.push('receipt-read'); return {} },
    },
    providerRegistry: { getActiveNetworks: async () => { calls.push('provider-network-read'); return [] } },
  })

  for (const operation of [
    () => service.getLink(token),
    () => service.startAttempt(token, { network_code: 'MTN_MOMO_ZMB', phone_number: '260763456789' }, attemptId),
    () => service.refreshAttempt(token, attemptId),
    () => service.getReceipt(token, attemptId),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'COMMERCE_RECEIVABLES_DEFERRED' && error.statusCode === 410)
  }

  assert.deepEqual(calls.filter((call) => ['attempt-create', 'provider-network-read', 'receipt-read'].includes(call)), [])
  assert.equal(calls.includes('idempotency-read'), false, 'an old A/R attempt cannot be accepted as an idempotent replay')
})


test('direct collection posting rejects an old A/R attempt before ITC or repository writes', async () => {
  let calls = 0
  const attempt = {
    attempt_id: attemptId, payment_link_id: receivableId,
    created_by_customer_id: customerId, provider_code: 'pawapay',
    provider_transaction_id: attemptId, collection_target_type: 'AR_SETTLEMENT',
    verified_at: '2026-10-23T00:00:00.000Z', provider_evidence_digest: 'a'.repeat(64),
  }
  await assert.rejects(postConfirmedCollection({ markAttemptSucceeded: async () => { calls++ } }, {
    postEarnedRevenueCollection: async () => { calls++ },
    creditCustomerAccount: async () => { calls++ },
    applyCustomerReceivablePayment: async () => { calls++ },
  }, attempt), (error) => error.code === 'COMMERCE_RECEIVABLES_DEFERRED' && error.statusCode === 410)
  assert.equal(calls, 0)
})
