const test = require('node:test')
const assert = require('node:assert/strict')

const { createRequestService, RequestServiceError } = require('../src/requests/requestService')

const actor = { customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'staff', active: true }
const idempotencyKey = 'e1c5dc16-081f-4e89-98bd-a14a6f37fc2d'
const repositoryWith = (methods = {}) => ({ submit: async () => null, listForActor: async () => [], listApprovals: async () => [], prepareManagerApproval: async () => null, completeManagerApproval: async () => null, markManagerApprovalFailure: async () => null, ...methods })

test('submitRequest_rejectsMalformedAmountBeforeDatabase', async () => {
  let called = false
  const service = createRequestService({ repository: repositoryWith({ submit: async () => { called = true } }) })

  await assert.rejects(
    service.submitRequest(actor, { category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '1.009' }, idempotencyKey),
    (error) => error instanceof RequestServiceError && error.code === 'INVALID_REQUEST',
  )
  assert.equal(called, false)
})

test('submitRequest_requiresIdempotencyKey', async () => {
  const service = createRequestService({ repository: repositoryWith({ submit: async () => assert.fail('repository should not be called') }) })

  await assert.rejects(
    service.submitRequest(actor, { category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00' }, ''),
    (error) => error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  )
})

test('submitRequest_removesRetryUploadWhenRepositoryReturnsPreviousIdempotentRequest', async () => {
  const removed = []
  let submitted
  const attachmentStorage = {
    save: async () => ({ storageKey: '123e4567-e89b-42d3-a456-426614174000.png', mediaType: 'image/png', size: 9, sha256: 'a'.repeat(64) }),
    remove: async (key) => { removed.push(key) },
  }
  const repository = repositoryWith({ submit: async (value) => { submitted = value; return { request: { request_id: '6a168a4e-65ca-4887-9a9c-6137a8002aba' }, replayed: true } } })
  const service = createRequestService({ repository, attachmentStorage })

  const result = await service.submitRequest(actor, {
    category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00',
  }, idempotencyKey, { file: { buffer: Buffer.from('image'), mimetype: 'image/png' } })

  assert.equal(result.replayed, true)
  assert.equal(submitted.attachment.sha256, 'a'.repeat(64))
  assert.deepEqual(removed, ['123e4567-e89b-42d3-a456-426614174000.png'])
})

test('submitRequest_preservesEvidenceWhenTheDatabaseCommitOutcomeIsUnknown', async () => {
  const removed = []
  const attachmentStorage = {
    save: async () => ({ storageKey: '123e4567-e89b-42d3-a456-426614174000.png', mediaType: 'image/png', size: 9, sha256: 'a'.repeat(64) }),
    remove: async (key) => { removed.push(key) },
  }
  const outcomeUnknown = Object.assign(new Error('REQUEST_SUBMISSION_OUTCOME_UNKNOWN'), {
    code: 'REQUEST_SUBMISSION_OUTCOME_UNKNOWN',
    outcomeUnknown: true,
  })
  const repository = repositoryWith({ submit: async () => { throw outcomeUnknown } })
  const service = createRequestService({ repository, attachmentStorage })

  await assert.rejects(service.submitRequest(actor, {
    category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00',
  }, idempotencyKey, { file: { buffer: Buffer.from('image'), mimetype: 'image/png' } }), (error) => error === outcomeUnknown)

  assert.deepEqual(removed, [])
})

test('listRequests_scopesStaffAndManagerThroughRepositoryActorContext', async () => {
  let input
  const service = createRequestService({ repository: repositoryWith({ listForActor: async (value) => { input = value; return [] } }) })
  await service.listRequests(actor, { limit: '25', offset: '50', sort: 'created_at', direction: 'asc' })

  assert.deepEqual(input, {
    actor: { customerId: actor.customerId, role: 'staff' },
    filters: { limit: 25, offset: 50, sort: 'created_at', direction: 'asc' },
  })
})

test('listRequests_rejectsUnsupportedSortKey', async () => {
  const service = createRequestService({ repository: repositoryWith({ listForActor: async () => assert.fail('repository should not be called') }) })

  await assert.rejects(service.listRequests(actor, { sort: 'requester_display_name; DROP TABLE expense_requests' }), (error) => error.code === 'INVALID_FILTER')
})

test('listApprovals_scopesQueueToVerifiedActor', async () => {
  let input
  const service = createRequestService({ repository: repositoryWith({ listApprovals: async (value) => { input = value; return { items: [] } } }) })
  await service.listApprovals(actor, { limit: 20 })

  assert.deepEqual(input, {
    actor: { customerId: actor.customerId, role: 'staff' },
    filters: { limit: 20, offset: 0, sort: 'created_at', direction: 'desc' },
  })
})

test('getPayoutDestination_isAdminOnlyAndPassesDecryptionThroughTheAuditedRepository', async () => {
  let received
  let decrypted
  const repository = repositoryWith({ revealPayoutDestination: async (input) => {
    received = input
    return { network_code: 'AIRTEL_OAPI_ZMB', phone_number: input.decrypt({ staffId: '45a79d36-1c70-4622-84d2-145a26f288d3', keyId: 'k1', ciphertext: 'sealed' }) }
  } })
  const phoneVault = { decrypt: (input) => { decrypted = input; return '260957909783' } }
  const service = createRequestService({ repository, phoneVault })
  const admin = { ...actor, role: 'admin' }
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'

  const result = await service.getPayoutDestination(admin, requestId, 'request-id-123')
  assert.deepEqual(result, { network_code: 'AIRTEL_OAPI_ZMB', phone_number: '260957909783' })
  assert.equal(received.actorId, admin.customerId)
  assert.equal(received.requestIdForAudit, 'request-id-123')
  assert.deepEqual(decrypted, { staffId: '45a79d36-1c70-4622-84d2-145a26f288d3', keyId: 'k1', ciphertext: 'sealed' })

  await assert.rejects(service.getPayoutDestination(actor, requestId), (error) => error.code === 'FORBIDDEN')
})

test('submitRequest_rejectsUntrustedRoles', async () => {
  const service = createRequestService({ repository: repositoryWith({ submit: async () => assert.fail('repository should not be called') }) })

  await assert.rejects(
    service.submitRequest({ ...actor, role: 'vendor' }, { category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00' }, idempotencyKey),
    (error) => error.code === 'FORBIDDEN',
  )
})

test('submitRequest_prohibitsAdminSelfFundedRequests', async () => {
  const service = createRequestService({ repository: repositoryWith({ submit: async () => assert.fail('repository should not be called') }) })
  await assert.rejects(
    service.submitRequest({ ...actor, role: 'admin' }, { category_id: '45a79d36-1c70-4622-84d2-145a26f288d3', amount: '25.00' }, idempotencyKey),
    (error) => error.code === 'FORBIDDEN',
  )
})

test('rejectRequest_requiresAReasonAndPassesVerifiedActorScope', async () => {
  let received
  const service = createRequestService({ repository: repositoryWith({ reject: async (input) => { received = input; return { request_id: input.requestId, status: 'REJECTED_MANAGER' } } }) })
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'

  await assert.rejects(service.rejectRequest(actor, requestId, 'manager', '   '), (error) => error.code === 'REJECTION_REASON_REQUIRED')
  const result = await service.rejectRequest(actor, requestId, 'manager', 'Not enough detail')

  assert.equal(result.status, 'REJECTED_MANAGER')
  assert.deepEqual(received, {
    actor: { customerId: actor.customerId, role: 'staff' },
    requestId,
    stage: 'manager',
    reason: 'Not enough detail',
  })
})

test('rejectRequest_rejectsInvalidStageAndRequestIdBeforeRepository', async () => {
  const service = createRequestService({ repository: repositoryWith({ reject: async () => assert.fail('repository should not be called') }) })

  await assert.rejects(service.rejectRequest(actor, 'bad-id', 'manager', 'Reason'), (error) => error.code === 'INVALID_REQUEST')
  await assert.rejects(service.rejectRequest(actor, '6a168a4e-65ca-4887-9a9c-6137a8002aba', 'owner', 'Reason'), (error) => error.code === 'INVALID_REQUEST')
})

test('rejectRequest_requiresTheRoleAuthorizedForTheReviewStage', async () => {
  const service = createRequestService({ repository: repositoryWith({ reject: async () => assert.fail('repository should not be called') }) })
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'

  await assert.rejects(service.rejectRequest(actor, requestId, 'admin', 'Reason'), (error) => error.code === 'FORBIDDEN')
  await assert.rejects(service.rejectRequest({ ...actor, role: 'admin' }, requestId, 'manager', 'Reason'), (error) => error.code === 'FORBIDDEN')
})

test('approveManager reserves through ITC before committing the manager decision', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  const operationId = '7a168a4e-65ca-4887-9a9c-6137a8002aba'
  const idempotencyKey = `ewmr-${requestId}`
  let financeCall
  let completed
  const repository = repositoryWith({
    prepareManagerApproval: async (input) => ({
      operation: {
        operationId, requestId, requesterCustomerId: '16072218-9cf2-40bb-a759-ea49a00995a0',
        actorCustomerId: actor.customerId, amount: '125.00', currency: 'ZMW',
        purpose: `Expense request ${requestId}`, idempotencyKey, expenseCategoryCode: 'consumables',
      },
      replayed: false,
    }),
    completeManagerApproval: async (input) => {
      completed = input
      return { request: { request_id: requestId, status: 'MANAGER_APPROVED' }, replayed: false }
    },
  })
  const financeClient = {
    reserve: async (...args) => {
      financeCall = args
      return { operation: {
        operation_id: operationId, request_id: requestId, hold_id: '8a168a4e-65ca-4887-9a9c-6137a8002aba',
        state: 'ACTIVE', amount: '125.00', currency: 'ZMW', expense_category_code: 'consumables', expense_account_code: '6280',
      } }
    },
  }
  const service = createRequestService({ repository, financeClient })

  const result = await service.approveManager(actor, requestId, '9a168a4e-65ca-4887-9a9c-6137a8002aba')

  assert.equal(result.request.status, 'MANAGER_APPROVED')
  assert.equal(result.pending, false)
  assert.deepEqual(financeCall[0], {
    operation_id: operationId,
    request_id: requestId,
    requester_customer_id: '16072218-9cf2-40bb-a759-ea49a00995a0',
    actor_customer_id: actor.customerId,
    amount: '125.00',
    currency: 'ZMW',
    expense_category_code: 'consumables',
    purpose: `Expense request ${requestId}`,
  })
  assert.equal(financeCall[1], idempotencyKey)
  assert.equal(completed.financeOperation.hold_id, '8a168a4e-65ca-4887-9a9c-6137a8002aba')
})

test('approveManager keeps ambiguous ITC outcomes pending and retries with the stored operation', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  let marked
  const repository = repositoryWith({
    prepareManagerApproval: async () => ({ operation: {
      operationId: '7a168a4e-65ca-4887-9a9c-6137a8002aba', requestId,
      requesterCustomerId: '16072218-9cf2-40bb-a759-ea49a00995a0', actorCustomerId: actor.customerId,
      amount: '125.00', currency: 'ZMW', purpose: `Expense request ${requestId}`, idempotencyKey: `ewmr-${requestId}`, expenseCategoryCode: 'consumables',
    }, replayed: false }),
    markManagerApprovalFailure: async (input) => { marked = input; return { request: { request_id: requestId, status: 'MANAGER_APPROVAL_PENDING_HOLD' } } },
  })
  const service = createRequestService({
    repository,
    financeClient: { reserve: async () => { const error = new Error('timeout'); error.code = 'ITC_FINANCE_UNAVAILABLE'; error.statusCode = 503; throw error } },
  })

  const result = await service.approveManager(actor, requestId, '9a168a4e-65ca-4887-9a9c-6137a8002aba')

  assert.equal(result.pending, true)
  assert.equal(result.request.status, 'MANAGER_APPROVAL_PENDING_HOLD')
  assert.equal(result.errorCode, 'ITC_FINANCE_UNAVAILABLE')
  assert.equal(marked.state, 'UNKNOWN')
})

test('approveManager rejects admins and non-managers before touching the repository', async () => {
  const service = createRequestService({
    repository: repositoryWith({ prepareManagerApproval: async () => assert.fail('repository must not run') }),
    financeClient: { reserve: async () => assert.fail('ITC must not be called') },
  })
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'

  await assert.rejects(service.approveManager({ ...actor, role: 'admin' }, requestId), { code: 'FORBIDDEN' })
  await assert.rejects(service.approveManager({ ...actor, role: 'vendor' }, requestId), { code: 'FORBIDDEN' })
  await assert.rejects(service.approveManager(actor, 'bad-id'), { code: 'INVALID_REQUEST' })
})

test('rejectRequest releases an ITC hold before finalizing admin rejection', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  let releaseCall
  let completed
  const repository = repositoryWith({
    prepareAdminRejection: async () => ({ requiresRelease: true, operation: {
      requestId, holdId: '8a168a4e-65ca-4887-9a9c-6137a8002aba',
      operationId: '7a168a4e-65ca-4887-9a9c-6137a8002aba', idempotencyKey: `ewrr-${requestId}`,
      actorCustomerId: '36072218-9cf2-40bb-a759-ea49a00995a0', reason: 'No longer required',
    } }),
    completeAdminRejection: async (input) => { completed = input; return { request: { request_id: requestId, status: 'REJECTED_ADMIN' } } },
  })
  const financeClient = { release: async (...args) => {
    releaseCall = args
    return { operation: { operation_id: '7a168a4e-65ca-4887-9a9c-6137a8002aba', request_id: requestId,
      hold_id: '8a168a4e-65ca-4887-9a9c-6137a8002aba', state: 'RELEASED' } }
  } }
  const service = createRequestService({ repository, financeClient })
  const admin = { ...actor, customerId: '36072218-9cf2-40bb-a759-ea49a00995a0', role: 'admin' }

  const result = await service.rejectRequest(admin, requestId, 'admin', 'No longer required')

  assert.equal(result.request.status, 'REJECTED_ADMIN')
  assert.equal(releaseCall[0], '8a168a4e-65ca-4887-9a9c-6137a8002aba')
  assert.equal(releaseCall[1].reason_code, 'ADMIN_REJECTED')
  assert.equal(releaseCall[2], `ewrr-${requestId}`)
  assert.equal(completed.financeOperation.state, 'RELEASED')
})

test('rejectRequest leaves admin rejection pending when ITC release outcome is unknown', async () => {
  const requestId = '6a168a4e-65ca-4887-9a9c-6137a8002aba'
  let failure
  const repository = repositoryWith({
    prepareAdminRejection: async () => ({ requiresRelease: true, operation: {
      requestId, holdId: '8a168a4e-65ca-4887-9a9c-6137a8002aba',
      operationId: '7a168a4e-65ca-4887-9a9c-6137a8002aba', idempotencyKey: `ewrr-${requestId}`,
      actorCustomerId: '36072218-9cf2-40bb-a759-ea49a00995a0', reason: 'No longer required',
    } }),
    markAdminRejectionPending: async (input) => { failure = input; return { request: { request_id: requestId, status: 'MANAGER_APPROVED' } } },
  })
  const service = createRequestService({ repository, financeClient: { release: async () => { throw Object.assign(new Error('timeout'), { code: 'ITC_FINANCE_UNAVAILABLE' }) } } })
  const admin = { ...actor, customerId: '36072218-9cf2-40bb-a759-ea49a00995a0', role: 'admin' }

  const result = await service.rejectRequest(admin, requestId, 'admin', 'No longer required')

  assert.equal(result.pending, true)
  assert.equal(result.errorCode, 'ITC_FINANCE_UNAVAILABLE')
  assert.equal(failure.errorCode, 'ITC_FINANCE_UNAVAILABLE')
})
