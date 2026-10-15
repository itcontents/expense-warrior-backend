const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { Readable } = require('node:stream')

const { createApp } = require('../src/app')

async function withServer(app, run) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

function appFor(role = 'staff') {
  let databaseWrites = 0
  const pool = {
    async query() { return { rows: [] } },
    async connect() { databaseWrites += 1; throw new Error('unexpected database connection') },
  }
  const app = createApp({
    pool,
    identityClient: { getSession: async () => ({ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role, active: true }) },
  })
  return { app, getDatabaseWrites: () => databaseWrites }
}

test('requestRoutes_requiresIdentityBeforeRequestSubmission', async () => {
  const { app, getDatabaseWrites } = appFor()
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00' }),
    })
    assert.equal(response.status, 401)
    assert.equal(getDatabaseWrites(), 0)
  })
})

test('requestRoutes_servesAuthorizedEvidenceInlineAsTheValidatedImageType', async () => {
  const actorId = 'f437d2e8-b1dd-4e68-9e73-457889e17dbd'
  const requestId = 'a437d2e8-b1dd-4e68-9e73-457889e17dbd'
  const attachmentId = 'b437d2e8-b1dd-4e68-9e73-457889e17dbd'
  const storageKey = 'c437d2e8-b1dd-4e68-9e73-457889e17dbd.png'
  const app = createApp({
      pool: {
        async query(sql, params) {
          if (sql.includes('FROM expense_request_attachments')) {
            assert.deepEqual(params, [attachmentId, requestId, 'staff', actorId])
            return { rows: [{ storage_key: storageKey, media_type: 'image/png', file_size_bytes: 8 }] }
          }
          return { rows: [] }
        },
        async connect() { throw new Error('unexpected transaction') },
      },
      identityClient: { getSession: async () => ({ customerId: actorId, role: 'staff', active: true }) },
      attachmentStorage: {
        async open(key, mediaType) {
          assert.equal(key, storageKey)
          assert.equal(mediaType, 'image/png')
          return Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])])
        },
      },
    })

  await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests/${requestId}/attachments/${attachmentId}`, {
        headers: { Cookie: 'itc_backoffice_access=valid' },
      })

      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /^image\/png\b/)
      assert.match(response.headers.get('content-disposition'), /^inline\b/)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(Buffer.from(await response.arrayBuffer()).length, 8)
  })
})

test('requestRoutes_rejectsMalformedRequestBeforeDatabaseWrite', async () => {
  const { app, getDatabaseWrites } = appFor()
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests`, {
      method: 'POST',
      headers: { Cookie: 'itc_backoffice_access=valid', 'Content-Type': 'application/json', 'Idempotency-Key': 'e1c5dc16-081f-4e89-98bd-a14a6f37fc2d' },
      body: JSON.stringify({ category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: 1.009, status: 'PAID' }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST')
    assert.equal(getDatabaseWrites(), 0)
  })
})

test('requestRoutes_rejectsUnallowlistedSortBeforeDatabaseQuery', async () => {
  const { app } = appFor()
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests?sort=requester_customer_id%3Bdrop`, {
      headers: { Cookie: 'itc_backoffice_access=valid' },
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_FILTER')
  })
})

test('requestRoutes_requiresRejectionReasonBeforeDatabaseAccess', async () => {
  const { app, getDatabaseWrites } = appFor('admin')
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/requests/6a168a4e-65ca-4887-9a9c-6137a8002aba/admin/reject`, {
      method: 'POST',
      headers: { Cookie: 'itc_backoffice_access=valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '   ' }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_REJECTION')
    assert.equal(getDatabaseWrites(), 0)
  })
})
