const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const { createPayoutDestinationRepository } = require('../src/payoutDestinations/payoutDestinationRepository')
const { createPayoutDestinationService } = require('../src/payoutDestinations/payoutDestinationService')
const { createPayoutDestinationRouter } = require('../src/payoutDestinations/payoutDestinationRoutes')
const { createPhoneVault } = require('../src/payoutDestinations/phoneVault')

const admin = { customerId: 'a437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }
const staffId = 'b437d2e8-b1dd-4e68-9e73-457889e17dbd'
const key = Buffer.alloc(32, 7).toString('base64')

function fakePool(handler) {
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      return handler(sql, values)
    },
    release() {},
  }
  return { calls, pool: { connect: async () => client, query: async (sql, values) => client.query(sql, values) } }
}

test('assignPayoutDestination serializes replacement, audits only masked fields, and commits atomically', async () => {
  let current = null
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('FROM staff_payout_destinations')) return { rows: current ? [current] : [] }
    if (sql.includes('INSERT INTO staff_payout_destinations')) return { rows: [{
      destination_id: 'c437d2e8-b1dd-4e68-9e73-457889e17dbd', staff_customer_id: staffId,
      network_code: 'AIRTEL_OAPI_ZMB', phone_last4: '9783', created_at: new Date().toISOString(),
    }] }
    return { rows: [] }
  })
  const repository = createPayoutDestinationRepository({ pool })
  const vault = createPhoneVault({ keysJson: JSON.stringify({ k1: key }), activeKeyId: 'k1' })
  const phone = '260957909783'
  const encrypted = vault.encrypt({ staffId, phone })
  const result = await repository.assign({
    actorId: admin.customerId, staffId, networkCode: 'AIRTEL_OAPI_ZMB', encrypted,
    fingerprint: vault.fingerprint({ staffId, phone }), last4: '9783',
  })
  assert.equal(result.changed, true)
  const save = calls.find((call) => call.sql.includes('INSERT INTO audit_events'))
  assert.ok(save)
  assert.equal(save.values[2].includes(phone), false)
  assert.ok(calls.some((call) => call.sql.includes('pg_advisory_xact_lock')))
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
})

test('payout destination service rejects non-admins and normalizes numbers before encryption', async () => {
  let received
  const repository = {
    assign: async (input) => { received = input; return { destination: { phone_last4: input.last4 }, changed: true } },
    listCurrent: async () => [],
    getCurrentForStaff: async () => null,
  }
  const vault = createPhoneVault({ keysJson: JSON.stringify({ k1: key }), activeKeyId: 'k1' })
  const service = createPayoutDestinationService({ repository, phoneVault: vault })
  await assert.rejects(service.assign({ ...admin, role: 'staff' }, staffId, 'AIRTEL_OAPI_ZMB', '260957909783'), { code: 'FORBIDDEN' })
  const assigned = await service.assign(admin, staffId, 'AIRTEL_OAPI_ZMB', '+260 957 909 783')
  assert.equal(assigned.destination.phone_last4, '9783')
  assert.equal(received.encrypted.ciphertext.includes('260957909783'), false)
  assert.equal(received.staffId, staffId)
  await assert.rejects(service.assign(admin, staffId, 'AIRTEL', '260957909783'), { code: 'INVALID_PAYOUT_DESTINATION' })
})

test('destination route rejects non-admin assignment before identity directory lookup', async () => {
  let directoryCalls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior', createPayoutDestinationRouter({
    identityClient: {
      getSession: async () => ({ ...admin, role: 'staff' }),
      listStaffDirectory: async () => { directoryCalls += 1; return [{ customer_id: staffId }] },
    },
    destinationService: { assign: async () => assert.fail('must reject before service') },
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/expense-warrior/admin/payout-destinations/${staffId}`, {
      method: 'PUT', headers: { Cookie: 'itc_backoffice_access=valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783' }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'FORBIDDEN')
    assert.equal(directoryCalls, 0)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('destination route verifies eligible identity before returning only masked destination metadata', async () => {
  let assigned
  let directoryQuery
  const app = express()
  app.use(express.json())
  app.use('/api/v1/expense-warrior', createPayoutDestinationRouter({
    identityClient: {
      getSession: async () => admin,
      listStaffDirectory: async (_cookie, filters) => {
        directoryQuery = filters
        return [{ customer_id: staffId }]
      },
    },
    destinationService: {
      assign: async (...args) => { assigned = args; return { destination: { destination_id: 'c437d2e8-b1dd-4e68-9e73-457889e17dbd', staff_customer_id: staffId, network_code: 'AIRTEL_OAPI_ZMB', phone_last4: '9783' }, changed: true } },
    },
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/expense-warrior/admin/payout-destinations/${staffId}`, {
      method: 'PUT', headers: { Cookie: 'itc_backoffice_access=valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(directoryQuery.ids, [staffId])
    assert.deepEqual(assigned, [admin, staffId, 'AIRTEL_OAPI_ZMB', '260957909783', 'pawapay'])
    assert.equal(payload.data.destination.phone_last4, '9783')
    assert.equal(JSON.stringify(payload).includes('260957909783'), false)
    assert.equal(JSON.stringify(payload).includes('ciphertext'), false)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
