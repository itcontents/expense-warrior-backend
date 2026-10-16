const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { createApp } = require('../src/app')

async function withServer(app, run) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('categories_requiresVerifiedItcSession', async () => {
  let queryCalled = false
  const app = createApp({
    pool: { query: async () => { queryCalled = true; return { rows: [] } }, connect: async () => assert.fail('request transaction should not start') },
    identityClient: { getSession: async () => { throw Object.assign(new Error('invalid'), { statusCode: 401 }) } },
  })

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/categories`, {
      headers: { Cookie: 'itc_backoffice_access=expired' },
    })
    assert.equal(response.status, 401)
    assert.equal(queryCalled, false)
  })
})

test('categories_returnsActiveHierarchyInStableOrder', async () => {
  let query
  const pool = {
    async connect() { assert.fail('request transaction should not start') },
    async query(sql, values) {
      query = { sql, values }
      return { rows: [
        { category_id: 'parent-1', parent_category_id: null, code: 'PHONE_INTERNET', name: 'Phone and Internet', reason_required: false, attachment_required: false },
        { category_id: 'child-1', parent_category_id: 'parent-1', code: 'MOBILE_DATA', name: 'Mobile data', reason_required: false, attachment_required: false },
      ] }
    },
  }
  const app = createApp({
    pool,
    identityClient: { getSession: async () => ({ customerId: 'staff-1', role: 'staff', active: true }) },
  })

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/categories`, {
      headers: { Cookie: 'itc_backoffice_access=valid' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: { items: [
      { category_id: 'parent-1', parent_category_id: null, code: 'PHONE_INTERNET', name: 'Phone and Internet', reason_required: false, attachment_required: false },
      { category_id: 'child-1', parent_category_id: 'parent-1', code: 'MOBILE_DATA', name: 'Mobile data', reason_required: false, attachment_required: false },
    ] } })
    assert.match(query.sql, /is_active\s*=\s*true/i)
    assert.match(query.sql, /ORDER BY/i)
    assert.equal(query.values, undefined)
  })
})

test('accounting category map administration is admin-only and validates against the signed ITC catalog', async () => {
  const calls = []
  const client = {
    async query(sql, values = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push({ sql: normalized, values })
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rowCount: 0, rows: [] }
      if (normalized.includes('FROM expense_categories category') && normalized.includes('LEFT JOIN expense_categories parent')) {
        return { rows: [{ category_id: '550e8400-e29b-41d4-a716-446655440000', code: 'OFFICE_SUPPLIES', parent_category_id: null, itc_expense_category_code: null, parent_code: null }] }
      }
      if (normalized.startsWith('UPDATE expense_categories')) return { rows: [{ category_id: values[0], code: 'OFFICE_SUPPLIES', parent_category_id: null, itc_expense_category_code: values[1], updated_at: '2026-10-15T12:00:00.000Z' }] }
      if (normalized.startsWith('INSERT INTO audit_events')) return { rowCount: 1, rows: [] }
      throw new Error(`Unexpected category map query: ${normalized}`)
    },
    release() {},
  }
  const pool = {
    async query(sql) {
      assert.match(sql, /itc_expense_category_code/)
      return { rows: [{ category_id: '550e8400-e29b-41d4-a716-446655440000', code: 'OFFICE_SUPPLIES', itc_expense_category_code: null }] }
    },
    connect: async () => client,
  }
  const identityClient = { getSession: async () => ({ customerId: 'admin-1', role: 'admin', active: true }) }
  const itcFinanceClient = { getExpenseCategories: async () => [{ category_code: 'consumables', category_name: 'Operating Consumables', account_code: '6280' }] }
  const app = createApp({ pool, identityClient, itcFinanceClient })

  await withServer(app, async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/v1/expense-warrior/admin/accounting-category-maps`, {
      headers: { Cookie: 'itc_backoffice_access=valid' },
    })
    assert.equal(listed.status, 200)
    assert.equal((await listed.json()).data.itc_categories[0].category_code, 'consumables')

    const saved = await fetch(`${baseUrl}/api/v1/expense-warrior/admin/categories/550e8400-e29b-41d4-a716-446655440000/accounting-map`, {
      method: 'PUT',
      headers: { Cookie: 'itc_backoffice_access=valid', Origin: 'http://localhost:5175', 'Content-Type': 'application/json' },
      body: JSON.stringify({ itc_expense_category_code: 'consumables' }),
    })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).data.mapping.itc_expense_category_code, 'consumables')

    const invalid = await fetch(`${baseUrl}/api/v1/expense-warrior/admin/categories/550e8400-e29b-41d4-a716-446655440000/accounting-map`, {
      method: 'PUT',
      headers: { Cookie: 'itc_backoffice_access=valid', Origin: 'http://localhost:5175', 'Content-Type': 'application/json' },
      body: JSON.stringify({ itc_expense_category_code: 'inventory' }),
    })
    assert.equal(invalid.status, 422)
  })
  assert.ok(calls.some(({ sql }) => sql.startsWith('INSERT INTO audit_events')))
})

test('accounting category map configuration refuses staff actors', async () => {
  const app = createApp({
    pool: { query: async () => assert.fail('admin map listing must be rejected before database access'), connect: async () => assert.fail('admin map update must be rejected before database access') },
    identityClient: { getSession: async () => ({ customerId: 'staff-1', role: 'staff', active: true }) },
    itcFinanceClient: { getExpenseCategories: async () => assert.fail('staff must not read the ITC accounting catalog') },
  })
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/expense-warrior/admin/accounting-category-maps`, {
      headers: { Cookie: 'itc_backoffice_access=valid' },
    })
    assert.equal(response.status, 403)
  })
})
