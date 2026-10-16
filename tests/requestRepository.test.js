const test = require('node:test')
const assert = require('node:assert/strict')

const { createRequestRepository, fingerprint } = require('../src/requests/requestRepository')

const actor = { customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'staff' }
const request = {
  categoryId: '45a79d36-1c70-4622-84d2-145a26f288d3',
  subcategoryId: null,
  amount: '25.00',
  currency: 'ZMW',
  reason: 'Buy office supplies',
}
const key = 'e1c5dc16-081f-4e89-98bd-a14a6f37fc2d'

function fakePool(handler) {
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      const result = await handler(sql, values, calls)
      if (sql.includes('FROM staff_payout_destinations') && !result?.noDestination && !result?.rows?.length) {
        return { rowCount: 1, rows: [{ destination_id: '89f85a3c-6bf8-4976-8cdc-2ec2ca88c929', provider_code: 'pawapay', network_code: 'AIRTEL_OAPI_ZMB', phone_ciphertext: 'cipher.envelope.value', encryption_key_id: 'k1', phone_last4: '9783' }] }
      }
      return result
    },
    release() { calls.push({ sql: 'RELEASE' }) },
  }
  return { calls, pool: { connect: async () => client, query: async (...args) => client.query(...args) } }
}

test('submitRequest_rejectsInactiveCategoryAndRollsBackIdempotencyClaim', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 1, rows: [{ idempotency_key: key }] }
    if (sql.includes('FROM expense_categories')) return { rowCount: 0, rows: [] }
    return { rowCount: 0, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  await assert.rejects(repository.submit({ actor, request, idempotencyKey: key }), (error) => error.code === 'CATEGORY_UNAVAILABLE')
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
  assert.ok(calls.some((call) => call.sql === 'RELEASE'))
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO expense_requests')), false)
})

test('submitRequest_replaysSameIdempotencyKeyWithoutCreatingAnotherRequest', async () => {
  const previousRequest = { request_id: '6a168a4e-65ca-4887-9a9c-6137a8002aba', status: 'PENDING_ADMIN', amount: '25.00', payout_network_code: 'AIRTEL_OAPI_ZMB', payout_phone_last4: '9783' }
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 0, rows: [] }
    if (sql.includes('SELECT request_hash, response_json')) {
      return { rowCount: 1, rows: [{ request_hash: fingerprint(request), response_json: previousRequest }] }
    }
    return { rowCount: 0, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  const result = await repository.submit({ actor, request, idempotencyKey: key })

  assert.deepEqual(result, { request: previousRequest, replayed: true })
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO expense_requests')), false)
  assert.equal(calls.some((call) => call.sql.includes('FROM staff_payout_destinations')), false)
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
})

test('submitRequest_rejectsIdempotencyKeyReusedWithDifferentPayload', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 0, rows: [] }
    if (sql.includes('SELECT request_hash, response_json')) return { rowCount: 1, rows: [{ request_hash: '0'.repeat(64), response_json: {} }] }
    return { rowCount: 0, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  await assert.rejects(repository.submit({ actor, request, idempotencyKey: key }), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED')
})

test('submitRequest_marksACreationCommitFailureAsAnUnknownOutcome', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 1, rows: [{ idempotency_key: key }] }
    if (sql.includes('FROM expense_categories')) return { rowCount: 1, rows: [{ category_id: request.categoryId, parent_category_id: null, reason_required: false, attachment_required: false }] }
    if (sql.includes('INSERT INTO expense_requests')) return { rowCount: 1, rows: [{
      request_id: '6a168a4e-65ca-4887-9a9c-6137a8002aba', requester_customer_id: actor.customerId,
      category_id: request.categoryId, subcategory_id: null, reviewer_manager_customer_id: null,
      amount: request.amount, currency: request.currency, reason: request.reason, status: 'PENDING_ADMIN',
    }] }
    if (sql === 'COMMIT') throw Object.assign(new Error('connection lost while committing'), { code: '08006' })
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  await assert.rejects(repository.submit({
    actor: { ...actor, role: 'admin' }, request, idempotencyKey: key,
    attachment: { storageKey: '123e4567-e89b-42d3-a456-426614174000.png', mediaType: 'image/png', size: 9, sha256: 'a'.repeat(64) },
  }), (error) => error.code === 'REQUEST_SUBMISSION_OUTCOME_UNKNOWN' && error.outcomeUnknown === true)

  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
  assert.ok(calls.some((call) => call.sql === 'RELEASE'))
})

test('submitRequest_snapshotsAssignedManagerAndRoutesToManagerFirst', async () => {
  const managerId = '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986'
  const assignmentId = '478d27bf-d574-488d-a347-7f5a87e3b11c'
  const saved = { request_id: '6a168a4e-65ca-4887-9a9c-6137a8002aba', status: 'PENDING_MANAGER', amount: '25.00', reviewer_manager_customer_id: managerId }
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 1, rows: [{ idempotency_key: key }] }
    if (sql.includes('FROM expense_categories')) return { rowCount: 1, rows: [{ category_id: request.categoryId, parent_category_id: null, reason_required: false, attachment_required: false }] }
    if (sql.includes('FROM employee_manager_assignments')) return { rowCount: 1, rows: [{ assignment_id: assignmentId, manager_customer_id: managerId }] }
    if (sql.includes('INSERT INTO expense_requests')) return { rowCount: 1, rows: [saved] }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  const result = await repository.submit({ actor, request, idempotencyKey: key })

  assert.equal(result.request.status, 'PENDING_MANAGER')
  assert.equal(result.request.reviewer_manager_customer_id, managerId)
  assert.equal(result.replayed, false)
  const insert = calls.find((call) => call.sql.includes('INSERT INTO expense_requests'))
  assert.equal(insert.values[5], '89f85a3c-6bf8-4976-8cdc-2ec2ca88c929')
  assert.equal(insert.values[6], 'pawapay')
  assert.equal(insert.values[7], 'AIRTEL_OAPI_ZMB')
  assert.equal(insert.values[8], 'cipher.envelope.value')
  assert.equal(insert.values[9], 'k1')
  assert.equal(insert.values[10], '9783')
})

test('submitRequest_rejectsWhenStaffHasNoCurrentPayoutDestination', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 1, rows: [{ idempotency_key: key }] }
    if (sql.includes('FROM expense_categories')) return { rowCount: 1, rows: [{ category_id: request.categoryId, parent_category_id: null, reason_required: false, attachment_required: false }] }
    if (sql.includes('FROM staff_payout_destinations')) return { rowCount: 0, rows: [], noDestination: true }
    return { rowCount: 0, rows: [] }
  })
  const repository = createRequestRepository({ pool })
  await assert.rejects(repository.submit({ actor, request, idempotencyKey: key }), { code: 'PAYOUT_DESTINATION_REQUIRED' })
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO expense_requests')), false)
})

test('revealPayoutDestination_decryptsOnlyEligibleRequestAndAuditsWithoutPhone', async () => {
  const phoneCiphertext = 'sealed-ciphertext'
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('FROM expense_requests') && sql.includes('payout_network_code')) {
      return { rowCount: 1, rows: [{
        requester_customer_id: '45a79d36-1c70-4622-84d2-145a26f288d3', status: 'PENDING_ADMIN',
        payout_provider_code: 'pawapay', payout_network_code: 'AIRTEL_OAPI_ZMB', payout_phone_ciphertext: phoneCiphertext,
        payout_encryption_key_id: 'k1', payout_phone_last4: '9783',
      }] }
    }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool })
  let decrypted
  const result = await repository.revealPayoutDestination({
    requestId: '6a168a4e-65ca-4887-9a9c-6137a8002aba',
    actorId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd',
    requestIdForAudit: 'req-123',
    decrypt: (input) => { decrypted = input; return '260957909783' },
  })

  assert.deepEqual(result, { provider_code: 'pawapay', network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783' })
  assert.equal(decrypted.ciphertext, phoneCiphertext)
  assert.ok(calls.some((call) => call.sql === 'BEGIN'))
  const audit = calls.find((call) => call.sql.includes('INSERT INTO audit_events'))
  assert.ok(audit)
  assert.match(audit.sql, /'request\.payout_destination\.revealed'/)
  assert.deepEqual(JSON.parse(audit.values[3]), { provider_code: 'pawapay', network_code: 'AIRTEL_OAPI_ZMB', phone_last4: '9783' })
  assert.equal(JSON.stringify(audit.values).includes('260957909783'), false)
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
})

test('revealPayoutDestination_refusesInactiveRequestBeforeDecryptOrAudit', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('FROM expense_requests') && sql.includes('payout_network_code')) {
      return { rowCount: 1, rows: [{
        requester_customer_id: '45a79d36-1c70-4622-84d2-145a26f288d3', status: 'REJECTED_ADMIN',
        payout_provider_code: 'pawapay', payout_network_code: 'AIRTEL_OAPI_ZMB', payout_phone_ciphertext: 'sealed', payout_encryption_key_id: 'k1', payout_phone_last4: '9783',
      }] }
    }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool })
  await assert.rejects(repository.revealPayoutDestination({ requestId: '6a168a4e-65ca-4887-9a9c-6137a8002aba', actorId: actor.customerId, decrypt: () => assert.fail('must not decrypt') }), (error) => error.code === 'PAYOUT_DESTINATION_NOT_AVAILABLE')
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO audit_events')), false)
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
})

test('submitRequest_requiresReasonWhenCategoryPolicyRequiresIt', async () => {
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO idempotency_records')) return { rowCount: 1, rows: [{ idempotency_key: key }] }
    if (sql.includes('FROM expense_categories')) return { rowCount: 1, rows: [{ category_id: request.categoryId, parent_category_id: null, reason_required: true, attachment_required: false }] }
    return { rowCount: 0, rows: [] }
  })
  const repository = createRequestRepository({ pool })

  await assert.rejects(repository.submit({ actor, request: { ...request, reason: null }, idempotencyKey: key }), (error) => error.code === 'REASON_REQUIRED')
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO expense_requests')), false)
})

test('listRequests_appliesActorScopePaginationAndAllowlistedSort', async () => {
  let call
  const pool = { connect: async () => assert.fail('list query should not open a transaction'), query: async (sql, values) => { call = { sql, values }; return { rows: [] } } }
  const repository = createRequestRepository({ pool })
  await repository.listForActor({
    actor,
    filters: { limit: 25, offset: 50, sort: 'created_at', direction: 'desc' },
  })

  assert.match(call.sql, /r\.requester_customer_id\s*=\s*\$2/)
  assert.match(call.sql, /r\.reviewer_manager_customer_id\s*=\s*\$2/)
  assert.match(call.sql, /LIMIT \$3 OFFSET \$4/)
  assert.deepEqual(call.values, ['staff', actor.customerId, 26, 50])
})

test('listRequests_exposesOnlyTerminalPayoutFailureCodesWithinTheActorScopedList', async () => {
  let call
  const failure = { request_id: '70000000-0000-4000-8000-000000000007', payout_error_code: 'PAWAPAY_INSUFFICIENT_BALANCE' }
  const pool = { connect: async () => assert.fail('list query should not open a transaction'), query: async (sql, values) => {
    call = { sql, values }
    return { rows: [failure] }
  } }
  const repository = createRequestRepository({ pool })

  const result = await repository.listForActor({
    actor,
    filters: { limit: 25, offset: 0, sort: 'created_at', direction: 'desc' },
  })

  assert.match(call.sql, /LEFT JOIN request_payout_attempts payout ON payout\.request_id = r\.request_id/)
  assert.match(call.sql, /CASE WHEN r\.status = 'PAYOUT_FAILED' AND payout\.state = 'FAILED' THEN payout\.error_code END AS payout_error_code/)
  assert.equal(result.items[0].payout_error_code, 'PAWAPAY_INSUFFICIENT_BALANCE')
  assert.deepEqual(call.values, ['staff', actor.customerId, 26, 0])
})

test('listApprovals_usesManagerScopeOrAdminQueueAndExcludesSelfApproval', async () => {
  let call
  const pool = { connect: async () => assert.fail('approval queue must be read-only'), query: async (sql, values) => { call = { sql, values }; return { rows: [] } } }
  const repository = createRequestRepository({ pool })
  await repository.listApprovals({ actor, filters: { limit: 50, offset: 0, sort: 'created_at', direction: 'desc' } })

  assert.match(call.sql, /r\.reviewer_manager_customer_id\s*=\s*\$2/)
  assert.match(call.sql, /r\.status IN \('PENDING_MANAGER', 'MANAGER_APPROVAL_PENDING_HOLD'\)/)
  assert.match(call.sql, /r\.status IN \('PENDING_ADMIN', 'MANAGER_APPROVED'\)/)
  assert.match(call.sql, /r\.requester_customer_id <> \$2/)
  assert.deepEqual(call.values, ['staff', actor.customerId, 51, 0])
})

test('reject_appendsDecisionUpdatesRequestAndAuditsWithinOneTransaction', async () => {
  const calls = []
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('SELECT request_id, requester_customer_id')) return { rowCount: 1, rows: [{ request_id: requestId, requester_customer_id: '16072218-9cf2-40bb-a759-ea49a00995a0', reviewer_manager_customer_id: actor.customerId, amount: '25.00', currency: 'ZMW', status: 'PENDING_MANAGER' }] }
      if (sql.includes('SELECT actor_customer_id, action, reason')) return { rowCount: 0, rows: [] }
      if (sql.includes('UPDATE expense_requests')) return { rowCount: 1, rows: [{ request_id: requestId, status: 'REJECTED_MANAGER' }] }
      return { rowCount: 1, rows: [] }
    },
    release() { calls.push({ sql: 'RELEASE' }) },
  }
  const pool = { connect: async () => client, query: async () => assert.fail('transaction client expected') }
  const repository = createRequestRepository({ pool })

  const result = await repository.reject({ actor, requestId, stage: 'manager', reason: 'Please attach a supplier quote' })

  assert.equal(result.status, 'REJECTED_MANAGER')
  assert.ok(calls.some((call) => call.sql === 'BEGIN'))
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO request_decisions") && call.values[1] === 'manager'))
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO audit_events") && call.values[1] === 'request.manager.rejected'))
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), false)
})

test('reject_replaysSameDecisionAndRejectsSelfReview', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  let selfReview = false
  const client = {
    async query(sql) {
      if (sql.includes('SELECT request_id, requester_customer_id')) return { rowCount: 1, rows: [{ request_id: requestId, requester_customer_id: selfReview ? actor.customerId : '16072218-9cf2-40bb-a759-ea49a00995a0', reviewer_manager_customer_id: actor.customerId, amount: '25.00', currency: 'ZMW', status: 'REJECTED_MANAGER' }] }
      if (sql.includes('SELECT actor_customer_id, action, reason')) return { rowCount: 1, rows: [{ actor_customer_id: actor.customerId, action: 'reject', reason: 'Not enough detail' }] }
      return { rowCount: 0, rows: [] }
    },
    release() {},
  }
  const repository = createRequestRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } })

  const replay = await repository.reject({ actor, requestId, stage: 'manager', reason: 'Not enough detail' })
  assert.equal(replay.replayed, true)

  selfReview = true
  await assert.rejects(repository.reject({ actor, requestId, stage: 'manager', reason: 'Not enough detail' }), (error) => error.code === 'SELF_REVIEW_PROHIBITED')
})

test('reject_adminCannotRejectAReservedRequestUntilTheITCHoldIsReleased', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql.includes('SELECT request_id, requester_customer_id')) return { rowCount: 1, rows: [{
        request_id: requestId, requester_customer_id: '16072218-9cf2-40bb-a759-ea49a00995a0',
        reviewer_manager_customer_id: '26072218-9cf2-40bb-a759-ea49a00995a0',
        amount: '125.00', currency: 'ZMW', status: 'MANAGER_APPROVED',
        finance_reservation_state: 'RESERVED', finance_hold_id: '8a168a4e-65ca-4887-9a9c-6137a8002aba',
      }] }
      return { rowCount: 0, rows: [] }
    },
    release() {},
  }
  const repository = createRequestRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } })

  await assert.rejects(repository.reject({
    actor: { customerId: '36072218-9cf2-40bb-a759-ea49a00995a0', role: 'admin' },
    requestId, stage: 'admin', reason: 'No longer required',
  }), { code: 'FINANCE_RELEASE_REQUIRED' })
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO request_decisions')), false)
})

test('prepareAdminRejection_persistsStableReleaseIdentityAndReasonBeforeRemoteCall', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  const operationId = '7a168a4e-65ca-4887-9a9c-6137a8002aba'
  const holdId = '8a168a4e-65ca-4887-9a9c-6137a8002aba'
  const admin = { customerId: '36072218-9cf2-40bb-a759-ea49a00995a0', role: 'admin' }
  const { calls, pool } = fakePool((sql) => {
    if (sql.includes('SELECT request_id, requester_customer_id')) return { rowCount: 1, rows: [{
      request_id: requestId, requester_customer_id: '16072218-9cf2-40bb-a759-ea49a00995a0',
      amount: '125.00', currency: 'ZMW', status: 'MANAGER_APPROVED',
      finance_reservation_state: 'RESERVED', finance_hold_id: holdId,
    }] }
    return { rowCount: 1, rows: [] }
  })
  const repository = createRequestRepository({ pool, idFactory: () => operationId })

  const prepared = await repository.prepareAdminRejection({ actor: admin, requestId, reason: 'No longer required' })

  assert.equal(prepared.requiresRelease, true)
  assert.deepEqual(prepared.operation, {
    requestId, holdId, operationId, idempotencyKey: `ewrr-${requestId}`,
    actorCustomerId: admin.customerId, reason: 'No longer required',
  })
  const save = calls.find((call) => call.sql.includes('UPDATE expense_requests'))
  assert.ok(save)
  assert.equal(save.values[1], operationId)
  assert.equal(save.values[2], `ewrr-${requestId}`)
  assert.equal(save.values[4], 'No longer required')
})
