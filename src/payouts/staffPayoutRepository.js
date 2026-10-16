const { randomUUID } = require('node:crypto')

class StaffPayoutRepositoryError extends Error {
  constructor(code, statusCode = 503) {
    super(code)
    this.name = 'StaffPayoutRepositoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function publicPayout(row) {
  if (!row) return null
  return {
    payout_id: row.payout_id,
    payout_attempt_id: row.payout_attempt_id,
    request_id: row.request_id,
    provider_code: row.provider_code,
    provider_account_id: row.provider_account_id || null,
    provider_account_version: row.provider_account_version || null,
    network_code: row.network_code,
    network_label: row.provider_network_label || null,
    amount: row.amount,
    currency: row.currency,
    client_reference_id: row.client_reference_id,
    state: row.state,
    provider_status: row.provider_status,
    provider_transaction_reference: row.provider_transaction_reference,
    error_code: row.error_code,
    consume_operation_id: row.consume_operation_id,
    consume_state: row.consume_state,
    release_state: row.release_state,
    reservation_operation_id: row.reservation_operation_id,
    reservation_idempotency_key: row.reservation_idempotency_key,
    reservation_hold_id: row.reservation_hold_id,
    reservation_state: row.reservation_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verified_at: row.verified_at,
  }
}

async function lockRequest(client, requestId) {
  const result = await client.query(`
    SELECT request.request_id, request.requester_customer_id, request.reviewer_manager_customer_id,
           request.amount::text AS amount, request.currency, request.status,
           request.finance_operation_id, request.finance_idempotency_key, request.finance_hold_id,
           request.finance_reservation_state, request.finance_error_code,
           request.finance_expense_category_code, request.finance_expense_account_code,
           request.payout_provider_code, request.payout_network_code, request.payout_phone_last4,
           request.payout_provider_account_id, request.payout_provider_account_version,
           COALESCE(subcategory.itc_expense_category_code, category.itc_expense_category_code) AS mapped_itc_expense_category_code
      FROM expense_requests request
      JOIN expense_categories category ON category.category_id = request.category_id
      LEFT JOIN expense_categories subcategory ON subcategory.category_id = request.subcategory_id
     WHERE request.request_id = $1
     FOR UPDATE OF request
  `, [requestId])
  return result.rows[0] || null
}

async function loadPayout(client, requestId, { lock = false } = {}) {
  const result = await client.query(`
    SELECT payout_id, payout_attempt_id, request_id, provider_code, provider_account_id, provider_account_version,
           network_code, provider_network_label,
           amount::text AS amount, currency, client_reference_id, state, provider_status,
           provider_transaction_reference, error_code, consume_operation_id, consume_state,
           release_operation_id, release_idempotency_key, release_state, release_error_code,
           reservation_operation_id, reservation_idempotency_key, reservation_hold_id, reservation_state,
           verified_at, created_at, updated_at
      FROM request_payout_attempts
     WHERE request_id = $1
     ORDER BY created_at DESC, payout_id DESC
     LIMIT 1
     ${lock ? 'FOR UPDATE' : ''}
  `, [requestId])
  return result.rows[0] || null
}

function assertAdminCanAct(request, actor) {
  if (String(actor?.role || '').toLowerCase() !== 'admin') throw new StaffPayoutRepositoryError('FORBIDDEN', 403)
  if (String(request.requester_customer_id).toLowerCase() === String(actor.customerId).toLowerCase()) {
    throw new StaffPayoutRepositoryError('SELF_REVIEW_PROHIBITED', 403)
  }
}

async function prepareFinalApproval({ pool, actor, requestId, requestIdForAudit = null, idFactory,
  providerCode = null, providerAccountId = null, providerAccountVersion = null, providerNetworkLabel = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    if (request.status === 'PAID') {
      const payout = await loadPayout(client, requestId)
      await client.query('COMMIT')
      return { request, payout: publicPayout(payout), replayed: true }
    }
    const existingPayout = await loadPayout(client, requestId, { lock: true })
    if (existingPayout) {
      if (existingPayout.state === 'FAILED') throw new StaffPayoutRepositoryError('PAYOUT_ALREADY_FAILED', 409)
      await client.query('COMMIT')
      return { request, payout: publicPayout(existingPayout), shouldInitiate: false, replayed: true }
    }
    if (!['PENDING_ADMIN', 'MANAGER_APPROVED', 'APPROVED_AWAITING_PAYOUT'].includes(request.status)) {
      throw new StaffPayoutRepositoryError('DECISION_NOT_ALLOWED', 409)
    }

    const priorAdminDecision = await client.query(`
      SELECT action, actor_customer_id
        FROM request_decisions
       WHERE request_id = $1 AND stage = 'admin'
       FOR UPDATE
    `, [requestId])
    if (priorAdminDecision.rows[0]?.action === 'reject') {
      throw new StaffPayoutRepositoryError('DECISION_NOT_ALLOWED', 409)
    }

    if (request.finance_reservation_state !== 'RESERVED' || !request.finance_hold_id) {
      if (request.status !== 'PENDING_ADMIN' || request.reviewer_manager_customer_id) {
        throw new StaffPayoutRepositoryError('FUNDS_RESERVATION_REQUIRED', 409)
      }
      const expenseCategoryCode = ['PENDING', 'UNKNOWN', 'FAILED'].includes(request.finance_reservation_state)
        ? request.finance_expense_category_code
        : request.mapped_itc_expense_category_code
      const expenseAccountCode = request.finance_expense_account_code || null
      if (!/^[a-z][a-z0-9_]{1,49}$/.test(String(expenseCategoryCode || '')) ||
          (expenseAccountCode !== null && !/^\d{4}$/.test(String(expenseAccountCode)))) {
        throw new StaffPayoutRepositoryError('EXPENSE_CATEGORY_ACCOUNTING_MAP_REQUIRED', 422)
      }
      const selectedProviderCode = providerCode || request.payout_provider_code || 'pawapay'
      if (request.payout_provider_code && selectedProviderCode !== request.payout_provider_code) {
        throw new StaffPayoutRepositoryError('PAYOUT_PROVIDER_SNAPSHOT_MISMATCH', 409)
      }
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(String(selectedProviderCode)) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(providerAccountId || '')) ||
          !Number.isSafeInteger(providerAccountVersion) || providerAccountVersion <= 0) {
        throw new StaffPayoutRepositoryError('PROVIDER_ACCOUNT_MAPPING_UNAVAILABLE', 503)
      }
      if (request.payout_provider_account_id &&
          (String(request.payout_provider_account_id).toLowerCase() !== String(providerAccountId).toLowerCase() ||
           Number(request.payout_provider_account_version) !== providerAccountVersion)) {
        throw new StaffPayoutRepositoryError('PAYOUT_PROVIDER_ACCOUNT_SNAPSHOT_MISMATCH', 409)
      }
      const operationId = request.finance_operation_id || idFactory()
      const idempotencyKey = request.finance_idempotency_key || `ewmr-${String(requestId).toLowerCase()}`
      await client.query(`
        UPDATE expense_requests
           SET finance_operation_id = $2, finance_idempotency_key = $3,
               finance_reservation_state = 'PENDING', finance_error_code = NULL,
               finance_expense_category_code = $4, finance_expense_account_code = $5,
               payout_provider_account_id = COALESCE(payout_provider_account_id, $6),
               payout_provider_account_version = COALESCE(payout_provider_account_version, $7),
               updated_at = transaction_timestamp()
         WHERE request_id = $1
      `, [requestId, operationId, idempotencyKey, expenseCategoryCode, expenseAccountCode,
        providerAccountId, providerAccountVersion])
      await client.query(`
        INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
        VALUES ($1, 'request.admin.reservation_started', 'expense_request', $2, $3, $4::jsonb)
      `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, expense_category_code: expenseCategoryCode })])
      await client.query('COMMIT')
      return {
        request: { ...request, finance_operation_id: operationId, finance_idempotency_key: idempotencyKey,
          finance_reservation_state: 'PENDING', finance_expense_category_code: expenseCategoryCode,
          finance_expense_account_code: expenseAccountCode },
        requiresReservation: true,
        reservation: {
          operationId, idempotencyKey, expenseCategoryCode, expenseAccountCode,
          amount: request.amount, currency: request.currency, requesterCustomerId: request.requester_customer_id,
          providerCode: selectedProviderCode, providerAccountId, providerAccountVersion,
        },
      }
    }

    if (!request.finance_operation_id || !request.finance_idempotency_key) {
      throw new StaffPayoutRepositoryError('FUNDS_RESERVATION_REQUIRED', 409)
    }
    if (!request.payout_network_code || !request.payout_phone_last4) throw new StaffPayoutRepositoryError('PAYOUT_DESTINATION_REQUIRED', 422)
    const payoutId = idFactory()
    const payoutAttemptId = idFactory()
    const consumeOperationId = idFactory()
    const clientReferenceId = `EW-REQ-${String(requestId).toLowerCase()}`
    const selectedProviderCode = providerCode || request.payout_provider_code || 'pawapay'
    if (request.payout_provider_code && selectedProviderCode !== request.payout_provider_code) {
      throw new StaffPayoutRepositoryError('PAYOUT_PROVIDER_SNAPSHOT_MISMATCH', 409)
    }
    const created = await client.query(`
      INSERT INTO request_payout_attempts (
        payout_id, payout_attempt_id, request_id, provider_code, provider_account_id, provider_account_version,
        network_code, provider_network_label, amount, currency, client_reference_id, state, consume_operation_id,
        reservation_operation_id, reservation_idempotency_key, reservation_hold_id, reservation_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'SUBMITTING', $12, $13, $14, $15, 'RESERVED')
      RETURNING payout_id, payout_attempt_id, request_id, provider_code, provider_account_id, provider_account_version,
                network_code, provider_network_label,
                amount::text AS amount, currency, client_reference_id, state, provider_status,
                provider_transaction_reference, error_code, consume_operation_id, consume_state,
                release_state, reservation_operation_id, reservation_idempotency_key, reservation_hold_id, reservation_state,
                created_at, updated_at, verified_at
    `, [payoutId, payoutAttemptId, requestId, selectedProviderCode, providerAccountId, providerAccountVersion,
      request.payout_network_code, providerNetworkLabel, request.amount, request.currency, clientReferenceId, consumeOperationId,
      request.finance_operation_id, request.finance_idempotency_key, request.finance_hold_id])
    await client.query(`
      INSERT INTO request_decisions (request_id, stage, action, actor_customer_id, reason)
      VALUES ($1, 'admin', 'approve', $2, NULL)
      ON CONFLICT (request_id, stage) DO NOTHING
    `, [requestId, actor.customerId])
    const updatedRequest = await client.query(`
      UPDATE expense_requests
         SET status = 'PAYOUT_PENDING', updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, reviewer_manager_customer_id,
                 amount::text AS amount, currency, status, finance_hold_id,
                 finance_reservation_state, finance_expense_category_code, finance_expense_account_code
    `, [requestId])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.payout_started', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ payout_id: payoutId, payout_attempt_id: payoutAttemptId, amount: request.amount, currency: request.currency })])
    await client.query('COMMIT')
    return { request: updatedRequest.rows[0], payout: publicPayout(created.rows[0]), shouldInitiate: true, replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function setAdminReservationAccountingSnapshot({ pool, actor, requestId, reservation, expenseAccountCode, requestIdForAudit = null }) {
  if (!/^\d{4}$/.test(String(expenseAccountCode || ''))) throw new StaffPayoutRepositoryError('INVALID_FINANCE_ACCOUNT_MAPPING', 400)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    if (request.status !== 'PENDING_ADMIN' || request.reviewer_manager_customer_id ||
        String(request.finance_operation_id).toLowerCase() !== String(reservation.operationId).toLowerCase() ||
        request.finance_idempotency_key !== reservation.idempotencyKey ||
        request.finance_expense_category_code !== reservation.expenseCategoryCode ||
        !['PENDING','UNKNOWN','FAILED'].includes(request.finance_reservation_state)) {
      throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    if (request.finance_expense_account_code && request.finance_expense_account_code !== expenseAccountCode) {
      throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    await client.query(`
      UPDATE expense_requests
         SET finance_expense_account_code = $2, updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, expenseAccountCode])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.account_mapping_snapshotted', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: reservation.operationId, expense_category_code: reservation.expenseCategoryCode, expense_account_code: expenseAccountCode })])
    await client.query('COMMIT')
    return { ...request, finance_expense_account_code: expenseAccountCode }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function completeAdminReservation({ pool, actor, requestId, reservation, financeOperation, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const valid = request.status === 'PENDING_ADMIN' && !request.reviewer_manager_customer_id &&
      String(request.finance_operation_id).toLowerCase() === String(reservation.operationId).toLowerCase() &&
      request.finance_idempotency_key === reservation.idempotencyKey &&
      String(financeOperation?.operation_id).toLowerCase() === String(reservation.operationId).toLowerCase() &&
      String(financeOperation?.request_id).toLowerCase() === String(requestId).toLowerCase() &&
      financeOperation?.amount === request.amount && financeOperation?.currency === request.currency &&
      financeOperation?.expense_category_code === reservation.expenseCategoryCode &&
      financeOperation?.expense_account_code === reservation.expenseAccountCode &&
      financeOperation?.state === 'ACTIVE' && /^[0-9a-f-]{36}$/i.test(String(financeOperation?.hold_id || ''))
    if (!valid) throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    const updated = await client.query(`
      UPDATE expense_requests
         SET finance_reservation_state = 'RESERVED', finance_hold_id = $2,
             finance_error_code = NULL, updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, reviewer_manager_customer_id,
                 amount::text AS amount, currency, status, finance_hold_id,
                 finance_reservation_state, finance_expense_category_code, finance_expense_account_code
    `, [requestId, financeOperation.hold_id])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.reservation_confirmed', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: reservation.operationId, hold_id: financeOperation.hold_id, amount: request.amount, currency: request.currency })])
    await client.query('COMMIT')
    return updated.rows[0]
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function markAdminReservationFailure({ pool, actor, requestId, operationId, state, errorCode, requestIdForAudit = null }) {
  if (!['FAILED', 'UNKNOWN'].includes(state) || !/^[A-Z0-9_]{1,100}$/.test(String(errorCode || ''))) {
    throw new StaffPayoutRepositoryError('INVALID_FINANCE_FAILURE', 400)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    if (request.status !== 'PENDING_ADMIN' || request.reviewer_manager_customer_id || request.finance_hold_id ||
        String(request.finance_operation_id).toLowerCase() !== String(operationId).toLowerCase()) {
      throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    const result = await client.query(`
      UPDATE expense_requests
         SET finance_reservation_state = $2, finance_error_code = $3, updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, status, finance_reservation_state, finance_error_code
    `, [requestId, state, errorCode])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.reservation_pending', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, state, error_code: errorCode })])
    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

function sameId(left, right) {
  return Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase()
}

function releasedProviderFailure(payout) {
  return payout?.state === 'FAILED' && payout.release_state === 'RELEASED' &&
    payout.reservation_state === 'RELEASED' && Boolean(payout.reservation_hold_id)
}

async function previousProviderAttempt(client, requestId) {
  const result = await client.query(`
    SELECT payout_id, state, release_state, reservation_state, reservation_hold_id
      FROM request_payout_attempts
     WHERE request_id = $1 AND state NOT IN ('RESERVING','RESERVATION_FAILED')
     ORDER BY created_at DESC, payout_id DESC
     LIMIT 1
  `, [requestId])
  return result.rows[0] || null
}

function retryReservation(request, payout) {
  return {
    operationId: payout.reservation_operation_id,
    idempotencyKey: payout.reservation_idempotency_key,
    expenseCategoryCode: request.finance_expense_category_code,
    expenseAccountCode: request.finance_expense_account_code,
    amount: payout.amount, currency: payout.currency,
    requesterCustomerId: request.requester_customer_id,
    providerCode: payout.provider_code,
    providerAccountId: payout.provider_account_id,
    providerAccountVersion: payout.provider_account_version,
  }
}

async function withLockedPayout({ pool, actor, requestId }, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const payout = await loadPayout(client, requestId, { lock: true })
    const result = await work(client, request, payout)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function auditRetry(client, actor, action, requestId, payoutId, requestIdForAudit, metadata) {
  await client.query(`
    INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
    VALUES ($1, $2, 'staff_payout', $3, $4, $5::jsonb)
  `, [actor.customerId, action, payoutId, requestIdForAudit, JSON.stringify({ request_id: requestId, ...metadata })])
}

async function retryReservationActor(client, request, payout) {
  const result = await client.query(`
    SELECT actor_customer_id
      FROM audit_events
     WHERE target_type = 'staff_payout' AND target_id = $1
       AND action = 'payout.retry.reservation_started'
       AND lower(metadata->>'request_id') = $2
       AND lower(metadata->>'operation_id') = $3
     LIMIT 2
  `, [payout.payout_id, String(request.request_id).toLowerCase(), String(payout.reservation_operation_id).toLowerCase()])
  const actorId = result.rows[0]?.actor_customer_id
  if (result.rows.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(actorId || ''))) {
    throw new StaffPayoutRepositoryError('PAYOUT_RETRY_ORIGIN_UNAVAILABLE', 409)
  }
  return String(actorId).toLowerCase()
}

async function preparePayoutRetry({ pool, actor, requestId, requestIdForAudit = null, idFactory }) {
  return withLockedPayout({ pool, actor, requestId }, async (client, request, payout) => {
    if (payout?.state === 'RESERVING') {
      const prior = await previousProviderAttempt(client, requestId)
      if (request.status !== 'PAYOUT_PENDING' || !releasedProviderFailure(prior) ||
          !['PENDING','UNKNOWN'].includes(payout.reservation_state) ||
          !sameId(request.finance_operation_id, payout.reservation_operation_id) ||
          request.finance_idempotency_key !== payout.reservation_idempotency_key || request.finance_hold_id ||
          !['PENDING','UNKNOWN'].includes(request.finance_reservation_state)) {
        throw new StaffPayoutRepositoryError('PAYOUT_RETRY_NOT_ALLOWED', 409)
      }
      return { request, payout: publicPayout(payout), requiresReservation: true,
        shouldInitiate: false, replayed: true, reservation: retryReservation(request, payout),
        reservationActorCustomerId: await retryReservationActor(client, request, payout) }
    }
    const prior = payout?.state === 'RESERVATION_FAILED' ? await previousProviderAttempt(client, requestId) : payout
    if (request.status !== 'PAYOUT_FAILED' || !payout ||
        !['FAILED','RESERVATION_FAILED'].includes(payout.state) || !releasedProviderFailure(prior) ||
        !sameId(request.finance_operation_id, payout.reservation_operation_id) ||
        request.finance_idempotency_key !== payout.reservation_idempotency_key ||
        (payout.state === 'FAILED' && (request.finance_reservation_state !== 'RELEASED' ||
          !sameId(request.finance_hold_id, payout.reservation_hold_id))) ||
        (payout.state === 'RESERVATION_FAILED' && (payout.reservation_state !== 'FAILED' || payout.reservation_hold_id ||
          request.finance_reservation_state !== 'FAILED' || request.finance_hold_id))) {
      throw new StaffPayoutRepositoryError('PAYOUT_RETRY_NOT_ALLOWED', 409)
    }
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(String(request.finance_expense_category_code || '')) ||
        !/^\d{4}$/.test(String(request.finance_expense_account_code || '')) ||
        request.amount !== payout.amount || request.currency !== payout.currency ||
        !request.payout_phone_last4 || request.payout_network_code !== payout.network_code ||
        request.payout_provider_code !== payout.provider_code) {
      throw new StaffPayoutRepositoryError('PAYOUT_RETRY_SNAPSHOT_MISMATCH', 409)
    }
    const payoutId = idFactory()
    const payoutAttemptId = idFactory()
    const consumeOperationId = idFactory()
    const operationId = idFactory()
    const idempotencyKey = `ewmr-${String(payoutId).toLowerCase()}`
    const clientReferenceId = `EW-PAY-${String(payoutId).toLowerCase()}`
    const created = await client.query(`
      INSERT INTO request_payout_attempts (
        payout_id, payout_attempt_id, request_id, provider_code, provider_account_id, provider_account_version,
        network_code, provider_network_label, amount, currency, client_reference_id, state, consume_operation_id,
        reservation_operation_id, reservation_idempotency_key, reservation_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'RESERVING', $12, $13, $14, 'PENDING')
      RETURNING *, amount::text AS amount
    `, [payoutId, payoutAttemptId, requestId, payout.provider_code, payout.provider_account_id, payout.provider_account_version,
      payout.network_code, payout.provider_network_label, payout.amount, payout.currency, clientReferenceId,
      consumeOperationId, operationId, idempotencyKey])
    await client.query(`
      UPDATE expense_requests
         SET status = 'PAYOUT_PENDING', finance_operation_id = $2, finance_idempotency_key = $3,
             finance_hold_id = NULL, finance_reservation_state = 'PENDING', finance_error_code = NULL,
             finance_release_operation_id = NULL, finance_release_idempotency_key = NULL,
             finance_release_state = NULL, finance_release_actor_customer_id = NULL,
             finance_release_reason = NULL, finance_release_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, operationId, idempotencyKey])
    const updatedRequest = { ...request, status: 'PAYOUT_PENDING', finance_operation_id: operationId,
      finance_idempotency_key: idempotencyKey, finance_hold_id: null, finance_reservation_state: 'PENDING', finance_error_code: null }
    await auditRetry(client, actor, 'payout.retry.reservation_started', request.request_id, payoutId, requestIdForAudit,
      { previous_payout_id: payout.payout_id, payout_attempt_id: payoutAttemptId, operation_id: operationId })
    return { request: updatedRequest, payout: publicPayout(created.rows[0]), requiresReservation: true,
      shouldInitiate: false, replayed: false,
      reservation: retryReservation(updatedRequest, created.rows[0]),
      reservationActorCustomerId: await retryReservationActor(client, updatedRequest, created.rows[0]) }
  })
}

async function completeRetryReservation({ pool, actor, requestId, payoutId, reservation, financeOperation, requestIdForAudit = null }) {
  return withLockedPayout({ pool, actor, requestId }, async (client, request, payout) => {
    if (!payout || !sameId(payout.payout_id, payoutId)) throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    const expected = retryReservation(request, payout)
    const valid = reservation && Object.keys(expected).every((key) => expected[key] === reservation[key]) &&
      sameId(request.finance_operation_id, expected.operationId) && request.finance_idempotency_key === expected.idempotencyKey &&
      sameId(financeOperation?.operation_id, expected.operationId) && sameId(financeOperation?.request_id, requestId) &&
      financeOperation?.amount === payout.amount && financeOperation?.currency === payout.currency &&
      financeOperation?.expense_category_code === expected.expenseCategoryCode &&
      financeOperation?.expense_account_code === expected.expenseAccountCode && financeOperation?.state === 'ACTIVE' &&
      financeOperation?.provider_code === payout.provider_code &&
      String(financeOperation?.provider_account_id).toLowerCase() === String(payout.provider_account_id).toLowerCase() &&
      Number(financeOperation?.provider_account_version) === Number(payout.provider_account_version) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(financeOperation?.hold_id || ''))
    if (!valid) throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    if (payout.state !== 'RESERVING') {
      if (!['SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE','FAILED','PAID'].includes(payout.state) ||
          !sameId(payout.reservation_hold_id, financeOperation.hold_id)) {
        throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
      }
      return { request, payout: publicPayout(payout), shouldInitiate: false, replayed: true }
    }
    if (request.status !== 'PAYOUT_PENDING' || !['PENDING','UNKNOWN'].includes(payout.reservation_state) ||
        !['PENDING','UNKNOWN'].includes(request.finance_reservation_state) ||
        request.finance_hold_id || !releasedProviderFailure(await previousProviderAttempt(client, requestId))) {
      throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    const usedHold = await client.query(`
      SELECT payout_id FROM request_payout_attempts
       WHERE reservation_hold_id = $1 AND payout_id <> $2 LIMIT 1
    `, [financeOperation.hold_id, payoutId])
    if (usedHold.rows.length) throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    const updated = await client.query(`
      UPDATE request_payout_attempts
         SET state = 'SUBMITTING', reservation_hold_id = $3, reservation_state = 'RESERVED',
             error_code = NULL, updated_at = transaction_timestamp()
       WHERE request_id = $1 AND payout_id = $2 AND state = 'RESERVING'
       RETURNING *, amount::text AS amount
    `, [requestId, payoutId, financeOperation.hold_id])
    if (updated.rowCount !== 1) throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    await client.query(`
      UPDATE expense_requests
         SET finance_hold_id = $2, finance_reservation_state = 'RESERVED', finance_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, financeOperation.hold_id])
    await auditRetry(client, actor, 'payout.retry.reservation_confirmed', requestId, payoutId, requestIdForAudit,
      { operation_id: expected.operationId, hold_id: financeOperation.hold_id })
    return { request: { ...request, finance_hold_id: financeOperation.hold_id, finance_reservation_state: 'RESERVED', finance_error_code: null },
      payout: publicPayout(updated.rows[0]), shouldInitiate: true, replayed: false }
  })
}

async function markRetryReservationFailure({ pool, actor, requestId, payoutId, operationId, state, errorCode, requestIdForAudit = null }) {
  if (!['FAILED','UNKNOWN'].includes(state) || !/^[A-Z0-9_]{1,100}$/.test(String(errorCode || ''))) {
    throw new StaffPayoutRepositoryError('INVALID_FINANCE_FAILURE', 400)
  }
  return withLockedPayout({ pool, actor, requestId }, async (client, request, payout) => {
    if (!payout || !sameId(payout.payout_id, payoutId) || !sameId(payout.reservation_operation_id, operationId) ||
        !sameId(request.finance_operation_id, operationId) || request.finance_hold_id || payout.reservation_hold_id ||
        !['RESERVING','RESERVATION_FAILED'].includes(payout.state)) {
      throw new StaffPayoutRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    if (payout.state === 'RESERVATION_FAILED') {
      return { request, payout: publicPayout(payout), shouldInitiate: false, replayed: true }
    }
    const payoutState = state === 'FAILED' ? 'RESERVATION_FAILED' : 'RESERVING'
    const requestState = state === 'FAILED' ? 'PAYOUT_FAILED' : 'PAYOUT_PENDING'
    await client.query(`
      UPDATE request_payout_attempts
         SET state = $3, reservation_state = $4, error_code = $5, updated_at = transaction_timestamp()
       WHERE request_id = $1 AND payout_id = $2 AND state = 'RESERVING'
    `, [requestId, payoutId, payoutState, state, errorCode])
    await client.query(`
      UPDATE expense_requests
         SET status = $2, finance_reservation_state = $3, finance_error_code = $4, updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, requestState, state, errorCode])
    await auditRetry(client, actor, 'payout.retry.reservation_pending', requestId, payoutId, requestIdForAudit,
      { operation_id: operationId, state, error_code: errorCode })
    return { request: { ...request, status: requestState, finance_reservation_state: state, finance_error_code: errorCode },
      payout: publicPayout({ ...payout, state: payoutState, reservation_state: state, error_code: errorCode }), shouldInitiate: false }
  })
}

async function preparePayoutReconciliation({ pool, actor, requestId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const payout = await loadPayout(client, requestId, { lock: true })
    if (!payout) throw new StaffPayoutRepositoryError('PAYOUT_NOT_FOUND', 404)
    await client.query('COMMIT')
    return { request, payout: publicPayout(payout) }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function updateAttempt({ pool, actorId, requestId, payoutId, state, providerStatus = null, providerReference = null, errorCode = null, requestIdForAudit = null, action }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(actorId || ''))) throw new StaffPayoutRepositoryError('AUTHENTICATION_REQUIRED', 401)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(`
      UPDATE request_payout_attempts
         SET state = $3, provider_status = COALESCE($4, provider_status),
             provider_transaction_reference = COALESCE($5, provider_transaction_reference),
             error_code = $6, updated_at = transaction_timestamp()
       WHERE request_id = $1 AND payout_id = $2 AND state IN ('SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE')
       RETURNING payout_id, payout_attempt_id, request_id, provider_code, provider_account_id, provider_account_version,
                 network_code, provider_network_label,
                 amount::text AS amount, currency, client_reference_id, state, provider_status,
                 provider_transaction_reference, error_code, consume_operation_id, consume_state,
                 release_state, reservation_operation_id, reservation_idempotency_key, reservation_hold_id, reservation_state,
                 created_at, updated_at, verified_at
    `, [requestId, payoutId, state, providerStatus, providerReference, errorCode])
    if (!result.rowCount) {
      const current = await loadPayout(client, requestId)
      if (sameId(current?.payout_id, payoutId) && ['PAID','FAILED'].includes(current?.state)) {
        await client.query('COMMIT')
        return publicPayout(current)
      }
      throw new StaffPayoutRepositoryError('PAYOUT_STATE_CONFLICT', 409)
    }
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, $2, 'staff_payout', $3, $4, $5::jsonb)
    `, [actorId, action, payoutId, requestIdForAudit, JSON.stringify({ request_id: requestId, provider_status: providerStatus, error_code: errorCode })])
    await client.query('COMMIT')
    return publicPayout(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function markPending(input) {
  return updateAttempt({ ...input, state: 'PENDING', errorCode: null, action: 'payout.provider_pending' })
}
async function markUnknown(input) {
  return updateAttempt({ ...input, state: 'UNKNOWN', action: 'payout.provider_unknown' })
}
async function markVerificationRequired(input) {
  return updateAttempt({ ...input, state: 'VERIFICATION_REQUIRED', action: 'payout.verification_required' })
}
async function recordInitiation(input) {
  const state = input.providerStatus === 'REJECTED' ? 'FAILED_PENDING_RELEASE' : 'PENDING'
  return updateAttempt({ ...input, state, action: 'payout.initiation_recorded' })
}

async function completePayout({ pool, actor, requestId, payoutId, providerTransactionId, providerStatus, providerReference, financeOperation, verifiedAt, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const payout = await loadPayout(client, requestId, { lock: true })
    if (!payout || String(payout.payout_id).toLowerCase() !== String(payoutId).toLowerCase() ||
        !['PENDING','UNKNOWN','VERIFICATION_REQUIRED'].includes(payout.state) ||
        payout.reservation_state !== 'RESERVED' || !payout.reservation_hold_id ||
        !sameId(payout.reservation_hold_id, financeOperation?.hold_id) ||
        String(financeOperation?.operation_id).toLowerCase() !== String(payout.consume_operation_id).toLowerCase() ||
        String(financeOperation?.request_id).toLowerCase() !== String(requestId).toLowerCase() ||
        String(financeOperation?.payout_attempt_id).toLowerCase() !== String(payout.payout_attempt_id).toLowerCase() ||
        String(financeOperation?.provider_transaction_id) !== String(providerTransactionId) ||
        financeOperation?.expense_category_code !== request.finance_expense_category_code ||
        financeOperation?.state !== 'CONSUMED' || financeOperation?.amount !== payout.amount ||
        financeOperation?.currency !== payout.currency || providerStatus !== 'COMPLETED' ||
        String(providerReference) !== String(providerTransactionId)) {
      if (request.status === 'PAID' && payout?.state === 'PAID' && sameId(payout.payout_id, payoutId)) {
        await client.query('COMMIT')
        return request
      }
      throw new StaffPayoutRepositoryError('PAYOUT_COMPLETION_CONFLICT', 409)
    }
    await client.query(`
      UPDATE request_payout_attempts
         SET state = 'PAID', provider_status = $3, provider_transaction_reference = $4,
             consume_state = 'CONSUMED', reservation_state = 'CONSUMED', error_code = NULL, verified_at = $5,
             updated_at = transaction_timestamp()
       WHERE payout_id = $1 AND request_id = $2
    `, [payoutId, requestId, providerStatus, providerReference, verifiedAt])
    await client.query(`
      UPDATE expense_requests
         SET status = 'PAID', finance_reservation_state = 'CONSUMED', finance_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.payout.paid', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ payout_id: payoutId, provider_transaction_id: providerReference, finance_operation_id: financeOperation.operation_id })])
    await client.query('COMMIT')
    return { ...request, status: 'PAID', finance_reservation_state: 'CONSUMED' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function prepareRelease({ pool, actor, requestId, payoutId, reasonCode, requestIdForAudit = null, idFactory }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const payout = await loadPayout(client, requestId, { lock: true })
    if (!payout || String(payout.payout_id).toLowerCase() !== String(payoutId).toLowerCase()) throw new StaffPayoutRepositoryError('PAYOUT_NOT_FOUND', 404)
    if (payout.state === 'FAILED' && payout.release_state === 'RELEASED') {
      await client.query('COMMIT')
      return { replayed: true, request: { ...request, status: 'PAYOUT_FAILED' } }
    }
    if (!['PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE'].includes(payout.state) ||
        payout.reservation_state !== 'RESERVED' || !payout.reservation_hold_id) {
      throw new StaffPayoutRepositoryError('PAYOUT_RELEASE_NOT_ALLOWED', 409)
    }
    const operationId = payout.release_operation_id || idFactory()
    const idempotencyKey = payout.release_idempotency_key || `ewpr-${String(payoutId).toLowerCase()}`
    await client.query(`
      UPDATE request_payout_attempts
         SET state = 'FAILED_PENDING_RELEASE', release_operation_id = $2,
             release_idempotency_key = $3, release_state = 'PENDING',
             release_error_code = NULL, updated_at = transaction_timestamp()
       WHERE payout_id = $1
    `, [payoutId, operationId, idempotencyKey])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'payout.hold_release_started', 'staff_payout', $2, $3, $4::jsonb)
    `, [actor.customerId, payoutId, requestIdForAudit, JSON.stringify({ request_id: requestId, reason_code: reasonCode, operation_id: operationId })])
    await client.query('COMMIT')
    return { operation: { requestId, holdId: payout.reservation_hold_id, operationId, idempotencyKey } }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function completeRelease({ pool, actor, requestId, payoutId, operationId, financeOperation, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const request = await lockRequest(client, requestId)
    if (!request) throw new StaffPayoutRepositoryError('REQUEST_NOT_FOUND', 404)
    assertAdminCanAct(request, actor)
    const payout = await loadPayout(client, requestId, { lock: true })
    if (!payout || !sameId(payout.payout_id, payoutId)) throw new StaffPayoutRepositoryError('PAYOUT_RELEASE_CONFLICT', 409)
    if (payout.release_state === 'RELEASED' && payout.state === 'FAILED') {
      await client.query('COMMIT')
      return { ...request, status: 'PAYOUT_FAILED' }
    }
    if (payout.release_state !== 'PENDING' && payout.release_state !== 'UNKNOWN' ||
        String(payout.release_operation_id).toLowerCase() !== String(operationId).toLowerCase() ||
        String(financeOperation?.operation_id).toLowerCase() !== String(operationId).toLowerCase() ||
        payout.reservation_state !== 'RESERVED' || !payout.reservation_hold_id ||
        !sameId(financeOperation?.hold_id, payout.reservation_hold_id) ||
        !sameId(financeOperation?.request_id, requestId) ||
        financeOperation?.state !== 'RELEASED') throw new StaffPayoutRepositoryError('PAYOUT_RELEASE_CONFLICT', 409)
    await client.query(`
      UPDATE request_payout_attempts
         SET state = 'FAILED', release_state = 'RELEASED', reservation_state = 'RELEASED', release_error_code = NULL,
             error_code = COALESCE(error_code, 'PROVIDER_PAYOUT_FAILED'), updated_at = transaction_timestamp()
       WHERE payout_id = $1
    `, [payoutId])
    await client.query(`
      UPDATE expense_requests
         SET status = 'PAYOUT_FAILED', finance_reservation_state = 'RELEASED',
             finance_release_state = 'RELEASED', finance_error_code = NULL,
             finance_release_operation_id = $2, finance_release_idempotency_key = $3,
             finance_release_actor_customer_id = $4, finance_release_reason = 'PawaPay payout failed',
             finance_release_error_code = NULL, updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, operationId, payout.release_idempotency_key, actor.customerId])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.payout.failed', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ payout_id: payoutId, operation_id: operationId })])
    await client.query('COMMIT')
    return { ...request, status: 'PAYOUT_FAILED', finance_reservation_state: 'RELEASED' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function markReleaseUnknown({ pool, actorId, requestId, payoutId, errorCode, requestIdForAudit = null }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(actorId || '')) || !/^[A-Z0-9_]{1,100}$/.test(String(errorCode || ''))) {
    throw new StaffPayoutRepositoryError('INVALID_FINANCE_FAILURE', 400)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(`
      UPDATE request_payout_attempts
         SET state = 'FAILED_PENDING_RELEASE', release_state = 'UNKNOWN',
             release_error_code = $3, updated_at = transaction_timestamp()
       WHERE request_id = $1 AND payout_id = $2 AND release_state IN ('PENDING','UNKNOWN')
       RETURNING payout_id
    `, [requestId, payoutId, errorCode])
    if (!result.rowCount) throw new StaffPayoutRepositoryError('PAYOUT_RELEASE_CONFLICT', 409)
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'payout.hold_release_unknown', 'staff_payout', $2, $3, $4::jsonb)
    `, [actorId, payoutId, requestIdForAudit, JSON.stringify({ request_id: requestId, error_code: errorCode })])
    await client.query('COMMIT')
    return { payout_id: payoutId, state: 'FAILED_PENDING_RELEASE', release_state: 'UNKNOWN', error_code: errorCode }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function listRecovery({ pool, limit = 50, offset = 0 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
    throw new StaffPayoutRepositoryError('INVALID_FILTER', 400)
  }
  const result = await pool.query(`
    SELECT request.request_id, request.requester_customer_id, request.amount::text AS amount,
           request.currency, request.status, request.reason, request.created_at AS submitted_at,
           category.name AS category_name, subcategory.name AS subcategory_name,
           payout.payout_id, payout.payout_attempt_id, payout.provider_code,
           payout.provider_account_id, payout.provider_account_version, payout.network_code, payout.provider_network_label,
           payout.state AS payout_state, payout.provider_status, payout.provider_transaction_reference,
           payout.error_code AS payout_error_code, payout.release_state,
           payout.release_error_code, payout.created_at AS payout_created_at,
           payout.updated_at AS payout_updated_at,
           (request.status = 'PAYOUT_FAILED' AND payout.state IN ('FAILED','RESERVATION_FAILED')
             AND COALESCE(eligibility.released, false)) AS retry_allowed
      FROM expense_requests request
      JOIN LATERAL (
        SELECT * FROM request_payout_attempts
         WHERE request_id = request.request_id
         ORDER BY created_at DESC, payout_id DESC
         LIMIT 1
      ) payout ON true
      LEFT JOIN LATERAL (
        SELECT state = 'FAILED' AND release_state = 'RELEASED'
               AND reservation_state = 'RELEASED' AND reservation_hold_id IS NOT NULL AS released
          FROM request_payout_attempts
         WHERE request_id = request.request_id AND state NOT IN ('RESERVING','RESERVATION_FAILED')
         ORDER BY created_at DESC, payout_id DESC
         LIMIT 1
      ) eligibility ON true
      JOIN expense_categories category ON category.category_id = request.category_id
      LEFT JOIN expense_categories subcategory ON subcategory.category_id = request.subcategory_id
     WHERE payout.state IN ('SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE')
        OR (COALESCE(eligibility.released, false) AND (
          (request.status = 'PAYOUT_PENDING' AND payout.state = 'RESERVING')
          OR (request.status = 'PAYOUT_FAILED' AND payout.state IN ('FAILED','RESERVATION_FAILED'))
        ))
     ORDER BY payout.updated_at ASC, payout.payout_id ASC
     LIMIT $1 OFFSET $2
  `, [limit + 1, offset])
  const hasMore = result.rows.length > limit
  return { items: hasMore ? result.rows.slice(0, limit) : result.rows, has_more: hasMore, limit, offset }
}

function createStaffPayoutRepository({ pool, idFactory = randomUUID } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required')
  return Object.freeze({
    async getPayoutProviderSelection(requestId) {
      const result = await pool.query(`
        SELECT payout_provider_code AS provider_code, payout_network_code AS network_code,
               payout_provider_account_id AS provider_account_id,
               payout_provider_account_version AS provider_account_version
          FROM expense_requests
         WHERE request_id = $1
         LIMIT 1
      `, [requestId])
      return result.rows[0] || null
    },
    prepareFinalApproval: (input) => prepareFinalApproval({ pool, idFactory, ...input }),
    completeAdminReservation: (input) => completeAdminReservation({ pool, ...input }),
    setAdminReservationAccountingSnapshot: (input) => setAdminReservationAccountingSnapshot({ pool, ...input }),
    markAdminReservationFailure: (input) => markAdminReservationFailure({ pool, ...input }),
    preparePayoutRetry: (input) => preparePayoutRetry({ pool, idFactory, ...input }),
    completeRetryReservation: (input) => completeRetryReservation({ pool, ...input }),
    markRetryReservationFailure: (input) => markRetryReservationFailure({ pool, ...input }),
    preparePayoutReconciliation: (input) => preparePayoutReconciliation({ pool, ...input }),
    listRecovery: (input) => listRecovery({ pool, ...input }),
    recordInitiation: (input) => recordInitiation({ pool, ...input }),
    markPending: (input) => markPending({ pool, ...input }),
    markUnknown: (input) => markUnknown({ pool, ...input }),
    markVerificationRequired: (input) => markVerificationRequired({ pool, ...input }),
    completePayout: (input) => completePayout({ pool, ...input }),
    prepareRelease: (input) => prepareRelease({ pool, idFactory, ...input }),
    completeRelease: (input) => completeRelease({ pool, ...input }),
    markReleaseUnknown: (input) => markReleaseUnknown({ pool, ...input }),
  })
}

module.exports = { createStaffPayoutRepository, StaffPayoutRepositoryError, publicPayout }
