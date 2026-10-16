const crypto = require('node:crypto')
const { consumeIdempotencyKey } = require('../integrations/itc/ItcFinanceClient')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
class StaffPayoutServiceError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'StaffPayoutServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function assertAdmin(actor) {
  if (!actor?.active || !UUID.test(String(actor.customerId || ''))) throw new StaffPayoutServiceError('AUTHENTICATION_REQUIRED', 401)
  if (String(actor.role || '').toLowerCase() !== 'admin') throw new StaffPayoutServiceError('FORBIDDEN', 403)
}

function matchesPayout(result, payout, destination, expectedOutcome = 'SUCCEEDED') {
  const evidence = result?.evidence
  return result && result.transaction_id === payout.payout_id && result.outcome === expectedOutcome && evidence &&
    evidence.country === 'ZMB' && evidence.amount === payout.amount && evidence.currency === payout.currency &&
    evidence.network_code === payout.network_code && evidence.phone_number === destination.phone_number &&
    evidence.client_reference === payout.client_reference_id &&
    (expectedOutcome !== 'SUCCEEDED' || (typeof evidence.provider_transaction_id === 'string' && evidence.provider_transaction_id.length > 0 && evidence.provider_transaction_id.length <= 128))
}

function evidenceDigest(result) {
  const evidence = result.evidence
  const canonical = [
    result.transaction_id, evidence.provider_transaction_id, result.provider_status || result.outcome,
    result.outcome, evidence.country, evidence.amount, evidence.currency,
    evidence.phone_number, evidence.network_code, evidence.client_reference,
  ].join('\n')
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function providerRejectionCode(payout, response) {
  const providerCode = String(payout?.provider_code || 'pawapay')
  const failureCode = String(response?.rejection_code || '')
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(providerCode) || !/^[A-Z0-9_]{1,64}$/.test(failureCode)) {
    return 'PROVIDER_REJECTED'
  }
  return `${providerCode.toUpperCase()}_${failureCode}`
}

function getProviderForOperation(providerRegistry, providerCode, operation, accountIdentity = null) {
  if (typeof providerRegistry?.getForOperation === 'function') return providerRegistry.getForOperation(providerCode, operation, accountIdentity)
  const provider = providerRegistry?.get?.(providerCode)
  const methods = { payout: ['initiatePayout', 'getPayoutStatus'] }[operation] || []
  return provider && methods.every((method) => typeof provider[method] === 'function') ? provider : null
}

function createStaffPayoutService({ repository, providerRegistry, financeClient, phoneVault, now = Date.now } = {}) {
  if (!repository || typeof repository.prepareFinalApproval !== 'function' ||
      typeof repository.preparePayoutReconciliation !== 'function' ||
      typeof repository.setAdminReservationAccountingSnapshot !== 'function' ||
      !providerRegistry || typeof providerRegistry.get !== 'function' ||
      !financeClient || typeof financeClient.reserve !== 'function' || typeof financeClient.consume !== 'function' || typeof financeClient.release !== 'function' ||
      typeof financeClient.getExpenseCategories !== 'function' ||
      !phoneVault || typeof phoneVault.decrypt !== 'function') {
    throw new TypeError('Staff payout dependencies are required')
  }

  async function revealDestination(actor, requestId, requestIdForAudit, expectedNetworkCode = null, expectedProviderCode = null) {
    if (typeof repository.revealPayoutDestination !== 'function') throw new StaffPayoutServiceError('PAYOUT_DESTINATION_UNAVAILABLE')
    try {
      const destination = await repository.revealPayoutDestination({
        requestId,
        actorId: actor.customerId,
        requestIdForAudit,
        decrypt: ({ staffId, keyId, ciphertext }) => phoneVault.decrypt({ staffId, keyId, ciphertext }),
      })
      const providerCode = destination?.provider_code || expectedProviderCode || 'pawapay'
      let networks = []
      try { networks = providerRegistry.getNetworks(providerCode, 'payout') } catch (_error) {}
      if (!destination || !Array.isArray(networks) || !networks.some(({ code }) => code === destination.network_code) ||
          (expectedProviderCode && providerCode !== expectedProviderCode) || !/^260\d{9}$/.test(String(destination.phone_number || '')) ||
          (expectedNetworkCode && destination.network_code !== expectedNetworkCode)) {
        throw new StaffPayoutServiceError('PAYOUT_DESTINATION_INVALID', 422)
      }
      return destination
    } catch (error) {
      if (error instanceof StaffPayoutServiceError) throw error
      throw new StaffPayoutServiceError('PAYOUT_DESTINATION_UNAVAILABLE')
    }
  }

  async function markUnknown(actor, payout, code, requestIdForAudit) {
    await repository.markUnknown({ actorId: actor.customerId, requestId: payout.request_id, payoutId: payout.payout_id, errorCode: code, requestIdForAudit })
    return { request: { request_id: payout.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: code }
  }

  async function payoutRouteSnapshot(requestId) {
    const selection = typeof repository.getPayoutProviderSelection === 'function'
      ? await repository.getPayoutProviderSelection(requestId)
      : null
    const providerCode = selection?.provider_code || 'pawapay'
    const networkCode = selection?.network_code || null
    let network = null
    if (networkCode && typeof providerRegistry.getNetworks === 'function') {
      let networks
      try { networks = providerRegistry.getNetworks(providerCode, 'payout') }
      catch (_error) { throw new StaffPayoutServiceError('PROVIDER_CAPABILITY_UNAVAILABLE', 503) }
      network = networks.find((item) => item.code === networkCode) || null
      if (!network) throw new StaffPayoutServiceError('PAYOUT_DESTINATION_INVALID', 422)
    }
    let accountIdentity = selection?.provider_account_id && selection?.provider_account_version
      ? { provider_account_id: selection.provider_account_id, provider_account_version: Number(selection.provider_account_version) }
      : null
    if (!accountIdentity && typeof providerRegistry.getAccountIdentity === 'function') {
      try { accountIdentity = providerRegistry.getAccountIdentity(providerCode) }
      catch (_error) { throw new StaffPayoutServiceError('PROVIDER_ACCOUNT_MAPPING_UNAVAILABLE', 503) }
      if (!accountIdentity?.provider_account_id || !Number.isSafeInteger(accountIdentity.provider_account_version)) {
        throw new StaffPayoutServiceError('PROVIDER_ACCOUNT_MAPPING_UNAVAILABLE', 503)
      }
    }
    return {
      providerCode,
      providerAccountId: accountIdentity?.provider_account_id || null,
      providerAccountVersion: accountIdentity?.provider_account_version || null,
      providerNetworkLabel: network?.label || null,
    }
  }

  async function retrySameProviderPayoutId(actor, request, payout, destination, requestIdForAudit) {
    let provider
    const accountIdentity = payout.provider_account_id && payout.provider_account_version
      ? { provider_account_id: payout.provider_account_id, provider_account_version: payout.provider_account_version }
      : null
    try { provider = getProviderForOperation(providerRegistry, payout.provider_code || 'pawapay', 'payout', accountIdentity) }
    catch (_error) { return markUnknown(actor, payout, 'PROVIDER_CAPABILITY_UNAVAILABLE', requestIdForAudit) }
    if (!provider) return markUnknown(actor, payout, 'PROVIDER_CAPABILITY_UNAVAILABLE', requestIdForAudit)
    try {
      const response = await provider.initiatePayout({
        transaction_id: payout.payout_id,
        country: 'ZMB',
        currency: payout.currency,
        amount: payout.amount,
        phone_number: destination.phone_number,
        network_code: destination.network_code,
        client_reference: payout.client_reference_id,
        customer_message: 'Expense request payout',
      })
      if (response?.transaction_id !== payout.payout_id || !['ACCEPTED', 'DUPLICATE', 'REJECTED'].includes(response?.outcome)) {
        return markUnknown(actor, payout, 'PROVIDER_RESPONSE_INVALID', requestIdForAudit)
      }
      if (response.outcome === 'REJECTED') {
        const reasonCode = providerRejectionCode(payout, response)
        await repository.recordInitiation({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, providerStatus: response.provider_status || 'REJECTED', errorCode: reasonCode, requestIdForAudit })
        return releaseFailedPayout(actor, request, payout, reasonCode, requestIdForAudit)
      }
      await repository.markPending({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, providerStatus: response.provider_status || response.outcome, requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true }
    } catch (_error) {
      return markUnknown(actor, payout, 'PROVIDER_OUTCOME_UNKNOWN', requestIdForAudit)
    }
  }

  async function releaseFailedPayout(actor, request, payout, reasonCode, requestIdForAudit) {
    const prepared = await repository.prepareRelease({
      actor: { customerId: actor.customerId, role: 'admin' },
      requestId: request.request_id,
      payoutId: payout.payout_id,
      reasonCode,
      requestIdForAudit,
    })
    if (prepared.replayed) return { request: prepared.request, pending: false, replayed: true }
    const operation = prepared.operation
    try {
      const result = await financeClient.release(operation.holdId, {
        operation_id: operation.operationId,
        actor_customer_id: actor.customerId,
        reason_code: reasonCode,
        reason: `${payout.provider_code || 'pawapay'} payout ${payout.payout_id} failed: ${reasonCode}`,
      }, operation.idempotencyKey, requestIdForAudit)
      const financeOperation = result?.operation
      if (!financeOperation || String(financeOperation.operation_id).toLowerCase() !== String(operation.operationId).toLowerCase() ||
          String(financeOperation.request_id).toLowerCase() !== String(request.request_id).toLowerCase() ||
          String(financeOperation.hold_id).toLowerCase() !== String(operation.holdId).toLowerCase() ||
          financeOperation.provider_code !== (payout.provider_code || 'pawapay') ||
          String(financeOperation.provider_account_id).toLowerCase() !== String(payout.provider_account_id).toLowerCase() ||
          Number(financeOperation.provider_account_version) !== Number(payout.provider_account_version) ||
          financeOperation.state !== 'RELEASED') {
        throw new StaffPayoutServiceError('ITC_FINANCE_RESPONSE_INVALID', 502)
      }
      const completed = await repository.completeRelease({
        actor: { customerId: actor.customerId, role: 'admin' }, requestId: request.request_id,
        payoutId: payout.payout_id, operationId: operation.operationId, financeOperation,
        requestIdForAudit,
      })
      return { request: completed, pending: false }
    } catch (error) {
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'ITC_FINANCE_UNAVAILABLE'
      await repository.markReleaseUnknown({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, errorCode: code, requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: code }
    }
  }

  async function reconcilePrepared(actor, request, payout, requestIdForAudit) {
    let provider
    const accountIdentity = payout.provider_account_id && payout.provider_account_version
      ? { provider_account_id: payout.provider_account_id, provider_account_version: payout.provider_account_version }
      : null
    try { provider = getProviderForOperation(providerRegistry, payout.provider_code || 'pawapay', 'payout', accountIdentity) }
    catch (_error) { return markUnknown(actor, payout, 'PROVIDER_STATUS_CAPABILITY_UNAVAILABLE', requestIdForAudit) }
    if (!provider) return markUnknown(actor, payout, 'PROVIDER_STATUS_CAPABILITY_UNAVAILABLE', requestIdForAudit)
    let response
    try {
      response = await provider.getPayoutStatus(payout.payout_id)
    } catch (_error) {
      return markUnknown(actor, payout, 'PROVIDER_STATUS_UNAVAILABLE', requestIdForAudit)
    }
    if (response?.outcome === 'NOT_FOUND') {
      if (['SUBMITTING', 'UNKNOWN'].includes(payout.state)) {
        const destination = await revealDestination(actor, request.request_id, requestIdForAudit, payout.network_code, payout.provider_code)
        return retrySameProviderPayoutId(actor, request, payout, destination, requestIdForAudit)
      }
      return markUnknown(actor, payout, 'PROVIDER_STATUS_NOT_FOUND', requestIdForAudit)
    }
    if (!response || response.transaction_id !== payout.payout_id ||
        !['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(response.outcome)) {
      return markUnknown(actor, payout, 'PROVIDER_EVIDENCE_MISMATCH', requestIdForAudit)
    }
    const providerStatus = response.provider_status || response.outcome
    if (response.outcome === 'FAILED' || response.outcome === 'CANCELLED') {
      const destination = await revealDestination(actor, request.request_id, requestIdForAudit, payout.network_code, payout.provider_code)
      if (!matchesPayout(response, payout, destination, response.outcome)) {
        await repository.markVerificationRequired({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, errorCode: 'PROVIDER_EVIDENCE_MISMATCH', requestIdForAudit })
        return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: 'PROVIDER_EVIDENCE_MISMATCH' }
      }
      const reasonCode = response.outcome === 'CANCELLED' ? 'PROVIDER_PAYOUT_CANCELLED' : 'PROVIDER_PAYOUT_FAILED'
      return releaseFailedPayout(actor, request, payout, reasonCode, requestIdForAudit)
    }
    if (response.outcome === 'PENDING') {
      await repository.markPending({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, providerStatus, requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true }
    }
    if (response.outcome === 'UNKNOWN') return markUnknown(actor, payout, 'PROVIDER_STATUS_UNKNOWN', requestIdForAudit)

    const destination = await revealDestination(actor, request.request_id, requestIdForAudit, payout.network_code, payout.provider_code)
    if (!matchesPayout(response, payout, destination)) {
      await repository.markVerificationRequired({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, errorCode: 'PROVIDER_EVIDENCE_MISMATCH', requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: 'PROVIDER_EVIDENCE_MISMATCH' }
    }

    const verifiedAt = new Date(now()).toISOString()
    const consumePayload = {
      operation_id: payout.consume_operation_id,
      request_id: request.request_id,
      requester_customer_id: request.requester_customer_id,
      actor_customer_id: actor.customerId,
      expense_category_code: request.finance_expense_category_code,
      payout_attempt_id: payout.payout_attempt_id,
      provider_transaction_id: response.evidence.provider_transaction_id,
      provider_reference: payout.client_reference_id,
      provider_code: payout.provider_code || 'pawapay',
      provider_account_id: payout.provider_account_id,
      provider_account_version: payout.provider_account_version,
      amount: payout.amount,
      currency: payout.currency,
      verified_at: verifiedAt,
      evidence_digest: evidenceDigest(response),
    }
    let result
    try {
      result = await financeClient.consume(request.finance_hold_id, consumePayload,
        consumeIdempotencyKey(response.evidence.provider_transaction_id), requestIdForAudit)
    } catch (error) {
      const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'ITC_FINANCE_UNAVAILABLE'
      await repository.markVerificationRequired({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, errorCode: code, requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: code }
    }
    const financeOperation = result?.operation
    if (!financeOperation || String(financeOperation.operation_id).toLowerCase() !== String(payout.consume_operation_id).toLowerCase() ||
        String(financeOperation.request_id).toLowerCase() !== String(request.request_id).toLowerCase() ||
        String(financeOperation.hold_id).toLowerCase() !== String(request.finance_hold_id).toLowerCase() ||
        financeOperation.provider_code !== (payout.provider_code || 'pawapay') ||
        String(financeOperation.provider_account_id).toLowerCase() !== String(payout.provider_account_id).toLowerCase() ||
        Number(financeOperation.provider_account_version) !== Number(payout.provider_account_version) ||
        String(financeOperation.payout_attempt_id).toLowerCase() !== String(payout.payout_attempt_id).toLowerCase() ||
        String(financeOperation.provider_transaction_id) !== String(response.evidence.provider_transaction_id) ||
        financeOperation.state !== 'CONSUMED' || financeOperation.amount !== payout.amount ||
        financeOperation.currency !== payout.currency || financeOperation.expense_category_code !== request.finance_expense_category_code) {
      await repository.markVerificationRequired({ actorId: actor.customerId, requestId: request.request_id, payoutId: payout.payout_id, errorCode: 'ITC_FINANCE_RESPONSE_INVALID', requestIdForAudit })
      return { request: { request_id: request.request_id, status: 'PAYOUT_PENDING' }, pending: true, errorCode: 'ITC_FINANCE_RESPONSE_INVALID' }
    }
    const completed = await repository.completePayout({
      actor: { customerId: actor.customerId, role: 'admin' }, requestId: request.request_id,
      payoutId: payout.payout_id, providerTransactionId: response.evidence.provider_transaction_id,
      providerStatus, providerReference: response.evidence.provider_transaction_id,
      financeOperation, verifiedAt, requestIdForAudit,
    })
    return { request: completed, pending: false, replayed: Boolean(result.replayed) }
  }

  async function finalApprove(actor, requestId, requestIdForAudit = null) {
    assertAdmin(actor)
    if (!UUID.test(String(requestId || ''))) throw new StaffPayoutServiceError('INVALID_REQUEST', 400)
    const routeSnapshot = await payoutRouteSnapshot(requestId)
    const prepare = () => repository.prepareFinalApproval({
      actor: { customerId: actor.customerId, role: 'admin' }, requestId, requestIdForAudit, ...routeSnapshot,
    })
    let prepared = await prepare()
    if (prepared.replayed && prepared.request?.status === 'PAID') return { request: prepared.request, pending: false, replayed: true }
    if (prepared.requiresReservation) {
      let reservation = prepared.reservation
      if (!reservation || !UUID.test(String(reservation.operationId || '')) ||
          reservation.requesterCustomerId !== prepared.request?.requester_customer_id ||
          !/^[a-z][a-z0-9_]{1,49}$/.test(String(reservation.expenseCategoryCode || '')) ||
          (reservation.expenseAccountCode !== null && reservation.expenseAccountCode !== undefined && !/^\d{4}$/.test(String(reservation.expenseAccountCode))) ||
          !/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(String(reservation.amount || '')) || reservation.currency !== 'ZMW') {
        throw new StaffPayoutServiceError('ADMIN_RESERVATION_PREPARATION_INVALID')
      }
      try {
        if (!reservation.expenseAccountCode) {
          const categories = await financeClient.getExpenseCategories(requestIdForAudit)
          const mapping = Array.isArray(categories)
            ? categories.find((category) => category.category_code === reservation.expenseCategoryCode)
            : null
          if (!mapping || !/^\d{4}$/.test(String(mapping.account_code || ''))) {
            throw new StaffPayoutServiceError('EXPENSE_CATEGORY_NOT_POSTABLE', 422)
          }
          reservation = { ...reservation, expenseAccountCode: mapping.account_code }
          await repository.setAdminReservationAccountingSnapshot({
            actor: { customerId: actor.customerId, role: 'admin' }, requestId, reservation,
            expenseAccountCode: mapping.account_code, requestIdForAudit,
          })
        }
        const result = await financeClient.reserve({
          operation_id: reservation.operationId,
          request_id: requestId,
          requester_customer_id: reservation.requesterCustomerId,
          actor_customer_id: actor.customerId,
          amount: reservation.amount,
          currency: reservation.currency,
          expense_category_code: reservation.expenseCategoryCode,
          provider_code: routeSnapshot.providerCode,
          provider_account_id: routeSnapshot.providerAccountId,
          provider_account_version: routeSnapshot.providerAccountVersion,
          purpose: `Expense request ${requestId}`,
        }, reservation.idempotencyKey, requestIdForAudit)
        const financeOperation = result?.operation
        if (!financeOperation || String(financeOperation.operation_id).toLowerCase() !== reservation.operationId.toLowerCase() ||
            String(financeOperation.request_id).toLowerCase() !== requestId.toLowerCase() ||
            String(financeOperation.amount) !== reservation.amount || financeOperation.currency !== reservation.currency ||
            financeOperation.state !== 'ACTIVE' || !UUID.test(String(financeOperation.hold_id || '')) ||
            financeOperation.expense_category_code !== reservation.expenseCategoryCode ||
        financeOperation.expense_account_code !== reservation.expenseAccountCode ||
            financeOperation.provider_code !== reservation.providerCode ||
            String(financeOperation.provider_account_id).toLowerCase() !== String(reservation.providerAccountId).toLowerCase() ||
            Number(financeOperation.provider_account_version) !== reservation.providerAccountVersion) {
          throw new StaffPayoutServiceError('ITC_FINANCE_RESPONSE_INVALID', 502)
        }
        await repository.completeAdminReservation({
          actor: { customerId: actor.customerId, role: 'admin' }, requestId,
          reservation, financeOperation, requestIdForAudit,
        })
        prepared = await prepare()
      } catch (error) {
        const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'ITC_FINANCE_UNAVAILABLE'
        const definitiveFailure = new Set([
          'INSUFFICIENT_FUNDS', 'TREASURY_MAPPING_UNAVAILABLE', 'TREASURY_ACCOUNT_UNAVAILABLE',
          'PROVIDER_ACCOUNT_MAPPING_UNAVAILABLE', 'EXPENSE_CATEGORY_NOT_POSTABLE',
          'IDENTITY_UNAVAILABLE', 'INVALID_RESERVATION',
        ]).has(code)
        try {
          await repository.markAdminReservationFailure({
            actor: { customerId: actor.customerId, role: 'admin' }, requestId,
            operationId: reservation.operationId, state: definitiveFailure ? 'FAILED' : 'UNKNOWN',
            errorCode: code, requestIdForAudit,
          })
        } catch {
          throw new StaffPayoutServiceError('APPROVAL_RECONCILIATION_REQUIRED', 503)
        }
        if (definitiveFailure) throw new StaffPayoutServiceError(code, 422)
        return { request: { request_id: requestId, status: 'PENDING_ADMIN' }, pending: true, errorCode: code }
      }
    }
    const request = prepared.request
    const payout = prepared.payout
    if (!request || !payout) throw new StaffPayoutServiceError('PAYOUT_PREPARATION_INVALID', 503)
    if (prepared.shouldInitiate) {
      const destination = await revealDestination(actor, requestId, requestIdForAudit, payout.network_code, payout.provider_code)
      let provider
      const accountIdentity = payout.provider_account_id && payout.provider_account_version
        ? { provider_account_id: payout.provider_account_id, provider_account_version: payout.provider_account_version }
        : null
      try { provider = getProviderForOperation(providerRegistry, payout.provider_code || 'pawapay', 'payout', accountIdentity) }
      catch (_error) {
        return releaseFailedPayout(actor, request, payout, 'PROVIDER_CAPABILITY_UNAVAILABLE', requestIdForAudit)
      }
      if (!provider) return releaseFailedPayout(actor, request, payout, 'PROVIDER_CAPABILITY_UNAVAILABLE', requestIdForAudit)
      try {
        const response = await provider.initiatePayout({
          transaction_id: payout.payout_id,
          country: 'ZMB',
          currency: payout.currency,
          amount: payout.amount,
          phone_number: destination.phone_number,
          network_code: destination.network_code,
          client_reference: payout.client_reference_id,
          customer_message: 'Expense request payout',
        })
        if (response?.transaction_id !== payout.payout_id || !['ACCEPTED', 'DUPLICATE', 'REJECTED'].includes(response?.outcome)) {
          await repository.markUnknown({ actorId: actor.customerId, requestId, payoutId: payout.payout_id, errorCode: 'PROVIDER_RESPONSE_INVALID', requestIdForAudit })
          return { request: { request_id: requestId, status: 'PAYOUT_PENDING' }, pending: true, errorCode: 'PROVIDER_RESPONSE_INVALID' }
        }
        if (response.outcome === 'REJECTED') {
          const reasonCode = providerRejectionCode(payout, response)
          await repository.recordInitiation({ actorId: actor.customerId, requestId, payoutId: payout.payout_id, providerStatus: response.provider_status || 'REJECTED', errorCode: reasonCode, requestIdForAudit })
          return releaseFailedPayout(actor, request, payout, reasonCode, requestIdForAudit)
        }
        await repository.recordInitiation({ actorId: actor.customerId, requestId, payoutId: payout.payout_id, providerStatus: response.provider_status || response.outcome, requestIdForAudit })
      } catch (_error) {
        await repository.markUnknown({ actorId: actor.customerId, requestId, payoutId: payout.payout_id, errorCode: 'PROVIDER_OUTCOME_UNKNOWN', requestIdForAudit })
        return { request: { request_id: requestId, status: 'PAYOUT_PENDING' }, pending: true, errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }
      }
    }
    return reconcilePrepared(actor, request, payout, requestIdForAudit)
  }

  async function reconcile(actor, requestId, requestIdForAudit = null) {
    assertAdmin(actor)
    if (!UUID.test(String(requestId || ''))) throw new StaffPayoutServiceError('INVALID_REQUEST', 400)
    const prepared = await repository.preparePayoutReconciliation({ actor: { customerId: actor.customerId, role: 'admin' }, requestId, requestIdForAudit })
    if (prepared.request?.status === 'PAID') return { request: prepared.request, pending: false, replayed: true }
    if (!prepared.request || !prepared.payout) throw new StaffPayoutServiceError('PAYOUT_NOT_FOUND', 404)
    return reconcilePrepared(actor, prepared.request, prepared.payout, requestIdForAudit)
  }

  async function bulkFinalApprove(actor, requestIds, requestIdForAudit = null) {
    assertAdmin(actor)
    if (!Array.isArray(requestIds) || requestIds.length < 1 || requestIds.length > 50 ||
        requestIds.some((id) => !UUID.test(String(id || ''))) || new Set(requestIds.map((id) => String(id).toLowerCase())).size !== requestIds.length) {
      throw new StaffPayoutServiceError('INVALID_BULK_REQUEST', 400)
    }
    const results = []
    for (const requestId of requestIds) {
      try {
        const result = await finalApprove(actor, requestId, requestIdForAudit)
        results.push({ request_id: requestId, status: result.request?.status || 'PAYOUT_PENDING', pending: result.pending })
      } catch (error) {
        results.push({ request_id: requestId, error_code: /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PAYOUT_UNAVAILABLE' })
      }
    }
    return { items: results, succeeded: results.filter((item) => item.status === 'PAID').length,
      pending: results.filter((item) => item.pending).length,
      failed: results.filter((item) => item.error_code || item.status === 'PAYOUT_FAILED').length }
  }

  async function listRecovery(actor, { limit = 50, offset = 0 } = {}) {
    assertAdmin(actor)
    const parsedLimit = Number(limit)
    const parsedOffset = Number(offset)
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100 ||
        !Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 1000000) {
      throw new StaffPayoutServiceError('INVALID_FILTER', 400)
    }
    if (typeof repository.listRecovery !== 'function') throw new StaffPayoutServiceError('PAYOUT_RECOVERY_UNAVAILABLE')
    return repository.listRecovery({ limit: parsedLimit, offset: parsedOffset })
  }

  return Object.freeze({ finalApprove, reconcile, bulkFinalApprove, listRecovery })
}

module.exports = { createStaffPayoutService, StaffPayoutServiceError, matchesPayout, evidenceDigest }
