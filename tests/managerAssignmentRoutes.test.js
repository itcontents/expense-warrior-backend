const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const { createApp } = require('../src/app')
const { createManagerAssignmentRouter } = require('../src/managerAssignments/managerAssignmentRoutes')

async function withServer(app, run) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

function buildApp(role = 'staff', identityOverrides = {}) {
  let transactions = 0
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => { transactions += 1; throw new Error('unexpected transaction') },
  }
  return {
    app: createApp({
      pool,
      identityClient: { getSession: async () => ({ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role, active: true }), ...identityOverrides },
    }),
    getTransactions: () => transactions,
  }
}

test('managerAssignments_requiresSession', async () => {
  const { app } = buildApp('admin')
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`)
    assert.equal(response.status, 401)
  })
})

test('managerCandidates_requiresAdminAndValidatesSearchBeforeCallingItc', async () => {
  let calls = 0
  const { app } = buildApp('staff', { listStaffDirectory: async () => { calls += 1; return [] } })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-candidates?search=x`, {
      headers: { Cookie: 'itc_expense_warrior_access=valid' },
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'FORBIDDEN')
    assert.equal(calls, 0)
  })
})

test('managerCandidates_adminCanSearchEligibleStaffThroughItc', async () => {
  let input
  const staff = [{ customer_id: '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986', email: 'sam@example.test', first_name: 'Sam', last_name: 'Staff' }]
  const { app } = buildApp('admin', { listStaffDirectory: async (_cookie, filters, requestId) => { input = { filters, requestId }; return staff } })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-candidates?search=sam&limit=10&offset=20`, {
      headers: { Cookie: 'itc_expense_warrior_access=valid', 'X-Request-Id': 'candidate-search-1' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: { items: staff } })
    assert.deepEqual({ ...input.filters }, { search: 'sam', limit: 10, offset: 20 })
    assert.equal(input.requestId, 'candidate-search-1')
  })
})

test('managerAssignments_rejectsNonAdminBeforeDatabaseTransaction', async () => {
  const { app, getTransactions } = buildApp('staff')
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`, {
      method: 'POST',
      headers: { Cookie: 'itc_expense_warrior_access=valid', Origin: 'http://localhost:5175', 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_customer_id: '45a79d36-1c70-4622-84d2-145a26f288d3', manager_customer_id: '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986' }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'FORBIDDEN')
    assert.equal(getTransactions(), 0)
  })
})

test('managerAssignments_refusesInactiveOrNonCompanyDirectoryIdsBeforeDatabaseWrite', async () => {
  let transactions = 0
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => { transactions += 1; throw new Error('assignment write should not start') },
  }
  const identityClient = {
    getSession: async () => ({ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }),
    listStaffDirectory: async () => [{ customer_id: '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986', email: 'staff@example.test', first_name: 'Sam', last_name: 'Staff' }],
  }
  const app = createApp({ pool, identityClient })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`, {
      method: 'POST',
      headers: { Cookie: 'itc_expense_warrior_access=valid', Origin: 'http://localhost:5175', 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_customer_id: '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986', manager_customer_id: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01' }),
    })
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error.code, 'ASSIGNMENT_CANDIDATE_UNAVAILABLE')
    assert.equal(transactions, 0)
  })
})

test('managerAssignments_validatesBothStaffIdsThroughItcBeforeCreatingAssignment', async () => {
  const staffId = '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986'
  const managerId = 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01'
  let directoryQuery
  let assignmentInput
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.requestId = req.get('X-Request-Id'); next() })
  app.use('/api/v1/expense-warrior', createManagerAssignmentRouter({
    identityClient: {
      getSession: async () => ({ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }),
      listStaffDirectory: async (_cookie, filters, requestId) => {
        directoryQuery = { filters, requestId }
        return [staffId, managerId].map((customer_id) => ({ customer_id, email: 'staff@example.test', first_name: 'Company', last_name: 'Staff' }))
      },
    },
    assignmentService: { assign: async (...input) => { assignmentInput = input; return { assignment_id: 'a8da2d30-9805-4f51-9f6c-5bca3ff77a01' } }, list: async () => ({ items: [] }), end: async () => null },
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`, {
      method: 'POST',
      headers: { Cookie: 'itc_expense_warrior_access=valid', 'Content-Type': 'application/json', 'X-Request-Id': 'assignment-validate-1' },
      body: JSON.stringify({ staff_customer_id: staffId, manager_customer_id: managerId }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(assignmentInput, [{ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }, staffId, managerId])
    assert.deepEqual({ ...directoryQuery.filters }, { ids: [staffId, managerId], limit: 50, offset: 0 })
    assert.equal(directoryQuery.requestId, 'assignment-validate-1')
  })
})

test('managerAssignments_enrichesAssignmentRowsWithMinimalDirectoryNames', async () => {
  const staffId = '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986'
  const managerId = 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01'
  const app = express()
  app.use('/api/v1/expense-warrior', createManagerAssignmentRouter({
    identityClient: {
      getSession: async () => ({ customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }),
      listStaffDirectory: async (_cookie, filters) => filters.ids.map((customer_id) => ({ customer_id, email: `${customer_id}@example.test`, first_name: 'Company', last_name: 'Staff' })),
    },
    assignmentService: {
      list: async () => ({ items: [{ assignment_id: 'a8da2d30-9805-4f51-9f6c-5bca3ff77a01', staff_customer_id: staffId, manager_customer_id: managerId }] }),
      assign: async () => null,
      end: async () => null,
    },
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`, { headers: { Cookie: 'itc_expense_warrior_access=valid' } })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.data.items[0].staff_member.customer_id, staffId)
    assert.equal(payload.data.items[0].manager.customer_id, managerId)
  })
})

test('managerAssignments_adminCanReadCurrentAndHistoricalAssignments', async () => {
  const { app } = buildApp('admin')
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/manager-assignments`, { headers: { Cookie: 'itc_expense_warrior_access=valid' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: { items: [] } })
  })
})
