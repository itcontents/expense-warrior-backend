const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/
const SORT_KEYS = new Set(['created_at', 'amount', 'status', 'category_name'])

class RequestServiceError extends Error {
  constructor(code, statusCode, message = code) {
    super(message)
    this.name = 'RequestServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function assertStaffActor(actor) {
  if (!actor?.active || !UUID_PATTERN.test(String(actor.customerId || ''))) {
    throw new RequestServiceError('AUTHENTICATION_REQUIRED', 401)
  }
  if (!['staff', 'admin'].includes(String(actor.role || '').toLowerCase())) {
    throw new RequestServiceError('FORBIDDEN', 403)
  }
}

function parseInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestServiceError('INVALID_FILTER', 400)
  }
  return parsed
}

function validateSubmission(input, idempotencyKey) {
  if (!UUID_PATTERN.test(String(idempotencyKey || ''))) {
    throw new RequestServiceError('IDEMPOTENCY_KEY_REQUIRED', 400)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  if (Object.keys(input).some((key) => !['category_id', 'subcategory_id', 'amount', 'reason'].includes(key))) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  if (!UUID_PATTERN.test(String(input.category_id || ''))) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  if (input.subcategory_id && !UUID_PATTERN.test(String(input.subcategory_id))) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  const amount = String(input.amount ?? '')
  if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  const [whole, fraction = ''] = amount.split('.')
  const reason = input.reason === undefined || input.reason === null ? '' : input.reason
  if (typeof reason !== 'string' || reason.length > 2000) {
    throw new RequestServiceError('INVALID_REQUEST', 400)
  }
  return {
    categoryId: input.category_id,
    subcategoryId: input.subcategory_id || null,
    amount: `${whole}.${fraction.padEnd(2, '0')}`,
    currency: 'ZMW',
    reason: reason.trim() || null,
  }
}

function createRequestService({ repository, attachmentStorage, financeClient, phoneVault } = {}) {
  if (!repository || typeof repository.submit !== 'function' || typeof repository.listForActor !== 'function' || typeof repository.listApprovals !== 'function') {
    throw new TypeError('A request repository is required')
  }

  return Object.freeze({
    async submitRequest(actor, input, idempotencyKey, { file, requestId } = {}) {
      assertStaffActor(actor)
      if (String(actor.role || '').toLowerCase() !== 'staff') throw new RequestServiceError('FORBIDDEN', 403)
      const request = validateSubmission(input, idempotencyKey)
      let attachment = null
      if (file) {
        if (!attachmentStorage || typeof attachmentStorage.save !== 'function' || typeof attachmentStorage.remove !== 'function') {
          throw new RequestServiceError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
        }
        try {
          attachment = await attachmentStorage.save(file)
        } catch (error) {
          throw new RequestServiceError(error.code || 'ATTACHMENT_STORAGE_UNAVAILABLE', error.statusCode || 503)
        }
      }
      try {
        const result = await repository.submit({
          actor: { customerId: actor.customerId, role: String(actor.role).toLowerCase() },
          request,
          attachment,
          idempotencyKey,
          requestId,
        })
        if (result.replayed && attachment) await attachmentStorage.remove(attachment.storageKey)
        return result
      } catch (error) {
        if (attachment) await attachmentStorage.remove(attachment.storageKey).catch(() => {})
        throw error
      }
    },

    async listRequests(actor, filters = {}) {
      assertStaffActor(actor)
      const normalizedFilters = normalizeFilters(filters)
      return repository.listForActor({
        actor: { customerId: actor.customerId, role: String(actor.role).toLowerCase() },
        filters: normalizedFilters,
      })
    },

    async listApprovals(actor, filters = {}) {
      assertStaffActor(actor)
      const normalizedFilters = normalizeFilters(filters)
      return repository.listApprovals({
        actor: { customerId: actor.customerId, role: String(actor.role).toLowerCase() },
        filters: normalizedFilters,
      })
    },

    async approveManager(actor, requestId, requestIdForAudit = null) {
      assertStaffActor(actor)
      if (!UUID_PATTERN.test(String(requestId || ''))) throw new RequestServiceError('INVALID_REQUEST', 400)
      if (String(actor.role).toLowerCase() !== 'staff') throw new RequestServiceError('FORBIDDEN', 403)
      if (typeof repository.prepareManagerApproval !== 'function' ||
          typeof repository.completeManagerApproval !== 'function' ||
          typeof repository.markManagerApprovalFailure !== 'function') {
        throw new RequestServiceError('APPROVAL_SERVICE_UNAVAILABLE', 503)
      }

      const actorContext = { customerId: actor.customerId, role: 'staff' }
      const prepared = await repository.prepareManagerApproval({ actor: actorContext, requestId, requestIdForAudit })
      if (prepared.replayed) return { request: prepared.request, pending: false, replayed: true }

      const operation = prepared.operation
      const payload = {
        operation_id: operation.operationId,
        request_id: operation.requestId,
        requester_customer_id: operation.requesterCustomerId,
        actor_customer_id: operation.actorCustomerId,
        amount: operation.amount,
        currency: operation.currency,
        expense_category_code: operation.expenseCategoryCode,
        purpose: operation.purpose,
      }

      try {
        if (!financeClient || typeof financeClient.reserve !== 'function') {
          const unavailable = new RequestServiceError('ITC_FINANCE_NOT_CONFIGURED', 503)
          throw unavailable
        }
        const result = await financeClient.reserve(payload, operation.idempotencyKey)
        const financeOperation = result?.operation
        if (!financeOperation || typeof financeOperation !== 'object' || Array.isArray(financeOperation) ||
            String(financeOperation.operation_id).toLowerCase() !== String(operation.operationId).toLowerCase() ||
            String(financeOperation.request_id).toLowerCase() !== String(operation.requestId).toLowerCase() ||
            String(financeOperation.amount) !== operation.amount || financeOperation.currency !== operation.currency ||
            financeOperation.state !== 'ACTIVE' || !UUID_PATTERN.test(String(financeOperation.hold_id || '')) ||
            financeOperation.expense_category_code !== operation.expenseCategoryCode ||
            !/^\d{4}$/.test(String(financeOperation.expense_account_code || ''))) {
          throw new RequestServiceError('ITC_FINANCE_RESPONSE_INVALID', 502)
        }
        const completed = await repository.completeManagerApproval({
          actor: actorContext,
          requestId,
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          financeOperation,
          requestIdForAudit,
        })
        return { ...completed, pending: false }
      } catch (error) {
        const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || ''))
          ? error.code
          : 'ITC_FINANCE_UNAVAILABLE'
        const definitiveFailure = new Set([
          'INSUFFICIENT_FUNDS',
          'TREASURY_MAPPING_UNAVAILABLE',
          'TREASURY_ACCOUNT_UNAVAILABLE',
          'EXPENSE_CATEGORY_NOT_POSTABLE',
          'IDENTITY_UNAVAILABLE',
          'INVALID_RESERVATION',
        ]).has(code)
        let marked
        try {
          marked = await repository.markManagerApprovalFailure({
            actor: actorContext,
            requestId,
            operationId: operation.operationId,
            state: definitiveFailure ? 'FAILED' : 'UNKNOWN',
            errorCode: code,
            requestIdForAudit,
          })
        } catch (_persistenceError) {
          throw new RequestServiceError('APPROVAL_RECONCILIATION_REQUIRED', 503)
        }
        if (marked.completed) return { request: marked.request, pending: false, replayed: true }
        return { request: marked.request, pending: true, replayed: false, errorCode: code }
      }
    },

    async getAttachment(actor, requestId, attachmentId) {
      assertStaffActor(actor)
      if (!UUID_PATTERN.test(String(requestId || '')) || !UUID_PATTERN.test(String(attachmentId || ''))) {
        throw new RequestServiceError('ATTACHMENT_NOT_FOUND', 404)
      }
      const attachment = await repository.findAttachment({
        actor: { customerId: actor.customerId, role: String(actor.role).toLowerCase() },
        requestId,
        attachmentId,
      })
      if (!attachment) throw new RequestServiceError('ATTACHMENT_NOT_FOUND', 404)
      return attachment
    },

    async getPayoutDestination(actor, requestId, requestIdForAudit = null) {
      assertStaffActor(actor)
      if (String(actor.role || '').toLowerCase() !== 'admin') throw new RequestServiceError('FORBIDDEN', 403)
      if (!UUID_PATTERN.test(String(requestId || ''))) throw new RequestServiceError('INVALID_REQUEST', 400)
      if (!phoneVault || typeof phoneVault.decrypt !== 'function' || typeof repository.revealPayoutDestination !== 'function') {
        throw new RequestServiceError('PAYOUT_DESTINATION_UNAVAILABLE', 503)
      }
      try {
        return await repository.revealPayoutDestination({
          requestId,
          actorId: actor.customerId,
          requestIdForAudit,
          decrypt: (encrypted) => phoneVault.decrypt(encrypted),
        })
      } catch (error) {
        if (error instanceof RequestRepositoryError) throw error
        throw new RequestServiceError('PAYOUT_DESTINATION_UNAVAILABLE', 503)
      }
    },

    async rejectRequest(actor, requestId, stage, reason, requestIdForAudit = null) {
      assertStaffActor(actor)
      if (!UUID_PATTERN.test(String(requestId || '')) || !['manager', 'admin'].includes(stage)) {
        throw new RequestServiceError('INVALID_REQUEST', 400)
      }
      const normalizedReason = typeof reason === 'string' ? reason.trim() : ''
      if (!normalizedReason) throw new RequestServiceError('REJECTION_REASON_REQUIRED', 422)
      if (normalizedReason.length > 2000) throw new RequestServiceError('INVALID_REQUEST', 400)
      if ((stage === 'admin' && String(actor.role).toLowerCase() !== 'admin') ||
          (stage === 'manager' && String(actor.role).toLowerCase() !== 'staff')) {
        throw new RequestServiceError('FORBIDDEN', 403)
      }
      const actorContext = { customerId: actor.customerId, role: String(actor.role).toLowerCase() }
      if (stage === 'admin' && typeof repository.prepareAdminRejection === 'function') {
        const prepared = await repository.prepareAdminRejection({ actor: actorContext, requestId, reason: normalizedReason, requestIdForAudit })
        if (prepared.requiresRelease) {
          const operation = prepared.operation
          try {
            if (!financeClient || typeof financeClient.release !== 'function') {
              throw new RequestServiceError('ITC_FINANCE_NOT_CONFIGURED', 503)
            }
            const result = await financeClient.release(operation.holdId, {
              operation_id: operation.operationId,
              actor_customer_id: operation.actorCustomerId,
              reason_code: 'ADMIN_REJECTED',
              reason: operation.reason,
            }, operation.idempotencyKey, requestIdForAudit)
            const financeOperation = result?.operation
            if (!financeOperation || String(financeOperation.operation_id).toLowerCase() !== String(operation.operationId).toLowerCase() ||
                String(financeOperation.request_id).toLowerCase() !== String(requestId).toLowerCase() ||
                String(financeOperation.hold_id).toLowerCase() !== String(operation.holdId).toLowerCase() ||
                financeOperation.state !== 'RELEASED') {
              throw new RequestServiceError('ITC_FINANCE_RESPONSE_INVALID', 502)
            }
            const completed = await repository.completeAdminRejection({ actor: actorContext, requestId, operationId: operation.operationId, financeOperation, requestIdForAudit })
            return { request: completed.request, pending: false }
          } catch (error) {
            const code = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'ITC_FINANCE_UNAVAILABLE'
            let marked
            try {
              marked = await repository.markAdminRejectionPending({ actor: actorContext, requestId, operationId: operation.operationId, errorCode: code, requestIdForAudit })
            } catch (_persistenceError) {
              throw new RequestServiceError('APPROVAL_RECONCILIATION_REQUIRED', 503)
            }
            return { request: marked.request, pending: true, errorCode: code }
          }
        }
      }
      return repository.reject({
        actor: actorContext,
        requestId,
        stage,
        reason: normalizedReason,
      })
    },
  })
}

function normalizeFilters(filters) {
  const sort = filters.sort || 'created_at'
  const direction = String(filters.direction || 'desc').toLowerCase()
  if (!SORT_KEYS.has(sort) || !['asc', 'desc'].includes(direction)) {
    throw new RequestServiceError('INVALID_FILTER', 400)
  }
  return {
    limit: parseInteger(filters.limit, 50, 1, 100),
    offset: parseInteger(filters.offset, 0, 0, 1000000),
    sort,
    direction,
  }
}

module.exports = { createRequestService, RequestServiceError, validateSubmission }
