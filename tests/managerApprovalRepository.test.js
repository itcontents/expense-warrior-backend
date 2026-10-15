const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequestRepository } = require('../src/requests/requestRepository')

const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
const operationId = '7a168a4e-65ca-4887-9a9c-6137a8002aba'
const requesterId = '16072218-9cf2-40bb-a759-ea49a00995a0'
const managerId = 'f437d2e8-b1dd-4e68-9e73-457889e17dbd'
const holdId = '8a168a4e-65ca-4887-9a9c-6137a8002aba'
const actor = { customerId: managerId, role: 'staff' }

function fakePool(handler) {
  const calls = []
  const client = {
    async query(sql, values) { calls.push({ sql, values }); return handler(sql, values, calls) },
    release() { calls.push({ sql: 'RELEASE' }) },
  }
  return { calls, pool: { connect: async () => client, query: (...args) => client.query(...args) } }
}

test('prepareManagerApproval persists one stable reservation identity before the ITC call', async () => {
  const request = {
    request_id: requestId, requester_customer_id: requesterId, reviewer_manager_customer_id: managerId,
    amount: '125.00', currency: 'ZMW', reason: 'Transport', status: 'PENDING_MANAGER',
    finance_operation_id: null, finance_idempotency_key: null, finance_hold_id: null,
    finance_reservation_state: null,
    finance_expense_category_code: null, mapped_itc_expense_category_code: 'consumables', finance_expense_account_code: null,
  }
  const { calls, pool } = fakePool((sql, values) => {
    if (sql.includes('FROM expense_requests request') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [request] }
    if (sql.includes('UPDATE expense_requests') && sql.includes('finance_operation_id')) return { rowCount: 1, rows: [{ ...request, status: 'MANAGER_APPROVAL_PENDING_HOLD', finance_operation_id: values[1], finance_idempotency_key: values[2], finance_expense_category_code: values[3], finance_reservation_state: 'PENDING' }] }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool, idFactory: () => operationId })

  const result = await repository.prepareManagerApproval({ actor, requestId })

  assert.equal(result.replayed, false)
  assert.deepEqual(result.operation, {
    operationId,
    requestId,
    requesterCustomerId: requesterId,
    actorCustomerId: managerId,
    amount: '125.00',
    currency: 'ZMW',
    expenseCategoryCode: 'consumables',
    purpose: `Expense request ${requestId}`,
    idempotencyKey: `ewmr-${requestId}`,
  })
  assert.ok(calls.some(({ sql }) => sql.includes("SET status = 'MANAGER_APPROVAL_PENDING_HOLD'")))
  assert.ok(calls.some(({ sql }) => sql.includes("'request.manager.approval_attempted'")))
  assert.equal(calls.at(-2).sql, 'COMMIT')
})

test('completeManagerApproval records the hold and manager decision atomically', async () => {
  const request = {
    request_id: requestId, requester_customer_id: requesterId, reviewer_manager_customer_id: managerId,
    amount: '125.00', currency: 'ZMW', status: 'MANAGER_APPROVAL_PENDING_HOLD',
    finance_operation_id: operationId, finance_idempotency_key: `ewmr-${requestId}`,
    finance_reservation_state: 'PENDING', finance_hold_id: null,
    finance_expense_category_code: 'consumables', finance_expense_account_code: null,
  }
  const { calls, pool } = fakePool((sql, values) => {
    if (sql.includes('SELECT request_id, requester_customer_id') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [request] }
    if (sql.includes('SELECT actor_customer_id, action') && sql.includes('request_decisions')) return { rowCount: 0, rows: [] }
    if (sql.includes('UPDATE expense_requests') && sql.includes("finance_reservation_state = 'RESERVED'")) return { rowCount: 1, rows: [{ request_id: requestId, status: 'MANAGER_APPROVED', finance_reservation_state: 'RESERVED', finance_hold_id: holdId, finance_expense_category_code: 'consumables', finance_expense_account_code: '6280' }] }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  const result = await repository.completeManagerApproval({
    actor, requestId, operationId, idempotencyKey: `ewmr-${requestId}`,
    financeOperation: { operation_id: operationId, request_id: requestId, hold_id: holdId, amount: '125.00', currency: 'ZMW', state: 'ACTIVE', expense_category_code: 'consumables', expense_account_code: '6280' },
  })

  assert.equal(result.request.status, 'MANAGER_APPROVED')
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO request_decisions") && sql.includes("'approve'")))
  assert.ok(calls.some(({ sql }) => sql.includes("'request.manager.approved'")))
  assert.equal(calls.at(-2).sql, 'COMMIT')
})

test('prepareManagerApproval rejects self-review and another manager before writing finance identity', async () => {
  const selfReview = { request_id: requestId, requester_customer_id: managerId, reviewer_manager_customer_id: managerId, amount: '125.00', currency: 'ZMW', status: 'PENDING_MANAGER' }
  const { calls, pool } = fakePool((sql) => sql.includes('FROM expense_requests request') ? { rowCount: 1, rows: [selfReview] } : { rowCount: 0, rows: [] })
  const repository = createRequestRepository({ pool })

  await assert.rejects(repository.prepareManagerApproval({ actor, requestId }), { code: 'SELF_REVIEW_PROHIBITED' })
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE expense_requests')), false)
})

test('prepareManagerApproval blocks fund reservation until a request category has an explicit ITC account map', async () => {
  const unmapped = {
    request_id: requestId, requester_customer_id: requesterId, reviewer_manager_customer_id: managerId,
    amount: '125.00', currency: 'ZMW', status: 'PENDING_MANAGER',
    finance_reservation_state: null, finance_expense_category_code: null,
    mapped_itc_expense_category_code: null,
  }
  const { calls, pool } = fakePool((sql) => sql.includes('FROM expense_requests request') ? { rowCount: 1, rows: [unmapped] } : { rowCount: 1, rows: [] })
  const repository = createRequestRepository({ pool })
  await assert.rejects(repository.prepareManagerApproval({ actor, requestId }), { code: 'EXPENSE_CATEGORY_ACCOUNTING_MAP_REQUIRED', statusCode: 422 })
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE expense_requests')), false)
  assert.equal(calls.at(-2).sql, 'ROLLBACK')
})
