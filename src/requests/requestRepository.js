const { createHash, randomUUID } = require('node:crypto')

const OPERATION_SUBMIT = 'request.submit.v1'
const SORT_COLUMNS = Object.freeze({
  created_at: 'r.created_at',
  amount: 'r.amount',
  status: 'r.status',
  category_name: 'category.name',
})

class RequestRepositoryError extends Error {
  constructor(code, statusCode, message = code) {
    super(message)
    this.name = 'RequestRepositoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fingerprint(request, attachment = null) {
  return createHash('sha256').update(JSON.stringify([
    request.categoryId,
    request.subcategoryId,
    request.amount,
    request.currency,
    request.reason,
    attachment?.sha256 || null,
  ])).digest('hex')
}

async function submit({ pool, actor, request, attachment = null, idempotencyKey, requestId = null }) {
  const client = await pool.connect()
  const requestHash = fingerprint(request, attachment)
  try {
    await client.query('BEGIN')

    const claimed = await client.query(`
      INSERT INTO idempotency_records
        (actor_customer_id, operation, idempotency_key, request_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (actor_customer_id, operation, idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `, [actor.customerId, OPERATION_SUBMIT, idempotencyKey, requestHash])

    if (claimed.rowCount === 0) {
      const previous = await client.query(`
        SELECT request_hash, response_json
          FROM idempotency_records
         WHERE actor_customer_id = $1 AND operation = $2 AND idempotency_key = $3
         FOR UPDATE
      `, [actor.customerId, OPERATION_SUBMIT, idempotencyKey])
      const row = previous.rows[0]
      if (!row) throw new RequestRepositoryError('IDEMPOTENCY_RETRY_REQUIRED', 409)
      if (row.request_hash !== requestHash) {
        throw new RequestRepositoryError('IDEMPOTENCY_KEY_REUSED', 409)
      }
      if (!row.response_json) throw new RequestRepositoryError('IDEMPOTENCY_IN_PROGRESS', 409)
      await client.query('COMMIT')
      return { request: row.response_json, replayed: true }
    }

    const categoryResult = await client.query(`
      SELECT category_id, parent_category_id, reason_required, attachment_required
        FROM expense_categories
       WHERE category_id = $1 AND is_active = true
       FOR SHARE
    `, [request.categoryId])
    const category = categoryResult.rows[0]
    if (!category || category.parent_category_id) {
      throw new RequestRepositoryError('CATEGORY_UNAVAILABLE', 422)
    }

    let subcategory = null
    if (request.subcategoryId) {
      const subcategoryResult = await client.query(`
        SELECT category_id, parent_category_id, reason_required, attachment_required
          FROM expense_categories
         WHERE category_id = $1 AND parent_category_id = $2 AND is_active = true
         FOR SHARE
      `, [request.subcategoryId, request.categoryId])
      subcategory = subcategoryResult.rows[0]
      if (!subcategory) throw new RequestRepositoryError('CATEGORY_UNAVAILABLE', 422)
    }
    if ((category.reason_required || subcategory?.reason_required) && !request.reason) {
      throw new RequestRepositoryError('REASON_REQUIRED', 422)
    }
    if (category.attachment_required || subcategory?.attachment_required) {
      throw new RequestRepositoryError('ATTACHMENT_REQUIRED', 422)
    }

    let assignment = null
    if (actor.role === 'staff') {
      const assignmentResult = await client.query(`
        SELECT assignment_id, manager_customer_id
          FROM employee_manager_assignments
         WHERE staff_customer_id = $1
           AND effective_from <= transaction_timestamp()
           AND (effective_to IS NULL OR effective_to > transaction_timestamp())
         ORDER BY effective_from DESC, assignment_id DESC
         LIMIT 1
         FOR SHARE
      `, [actor.customerId])
      assignment = assignmentResult.rows[0] || null
    }

    let payoutDestination = null
    if (actor.role === 'staff') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ew-payout-destination:${actor.customerId.toLowerCase()}`])
      const destinationResult = await client.query(`
        SELECT destination_id, network_code, phone_ciphertext, encryption_key_id, phone_last4
          FROM staff_payout_destinations
         WHERE staff_customer_id = $1 AND superseded_at IS NULL
         FOR SHARE
      `, [actor.customerId])
      payoutDestination = destinationResult.rows[0] || null
      if (!payoutDestination) throw new RequestRepositoryError('PAYOUT_DESTINATION_REQUIRED', 422)
    }

    const requestResult = await client.query(`
      INSERT INTO expense_requests (
        requester_customer_id,
        category_id,
        subcategory_id,
        manager_assignment_id,
        reviewer_manager_customer_id,
        payout_destination_id,
        payout_network_code,
        payout_phone_ciphertext,
        payout_encryption_key_id,
        payout_phone_last4,
        amount,
        currency,
        reason,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING request_id, requester_customer_id, category_id, subcategory_id,
                reviewer_manager_customer_id, amount::text, currency, reason, status,
                payout_network_code, payout_phone_last4, created_at, submitted_at
    `, [
      actor.customerId,
      request.categoryId,
      request.subcategoryId,
      assignment?.assignment_id || null,
      assignment?.manager_customer_id || null,
      payoutDestination?.destination_id || null,
      payoutDestination?.network_code || null,
      payoutDestination?.phone_ciphertext || null,
      payoutDestination?.encryption_key_id || null,
      payoutDestination?.phone_last4 || null,
      request.amount,
      request.currency,
      request.reason,
      assignment ? 'PENDING_MANAGER' : 'PENDING_ADMIN',
    ])
    const created = requestResult.rows[0]
    let attachmentMetadata = null
    if (attachment) {
      const attachmentResult = await client.query(`
        INSERT INTO expense_request_attachments
          (request_id, storage_key, media_type, file_size_bytes, sha256, uploader_customer_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING attachment_id, media_type, file_size_bytes AS size_bytes, uploaded_at
      `, [created.request_id, attachment.storageKey, attachment.mediaType, attachment.size, attachment.sha256, actor.customerId])
      attachmentMetadata = attachmentResult.rows[0]
    }
    const response = { ...created, amount: created.amount, attachment: attachmentMetadata }

    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.submitted', 'expense_request', $2, $3, $4::jsonb)
    `, [
      actor.customerId,
      created.request_id,
      requestId,
      JSON.stringify({ status: created.status, amount: created.amount, currency: created.currency, category_id: created.category_id }),
    ])

    await client.query(`
      UPDATE idempotency_records
         SET resource_id = $4,
             response_json = $5::jsonb,
             completed_at = transaction_timestamp()
       WHERE actor_customer_id = $1 AND operation = $2 AND idempotency_key = $3
    `, [actor.customerId, OPERATION_SUBMIT, idempotencyKey, created.request_id, JSON.stringify(response)])

    await client.query('COMMIT')
    return { request: response, replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function listForActor({ pool, actor, filters }) {
  const column = SORT_COLUMNS[filters.sort]
  if (!column || !['asc', 'desc'].includes(filters.direction)) {
    throw new RequestRepositoryError('INVALID_FILTER', 400)
  }
  const result = await pool.query(`
    SELECT r.request_id,
           r.requester_customer_id,
           r.category_id,
           r.subcategory_id,
           category.name AS category_name,
           subcategory.name AS subcategory_name,
           r.reviewer_manager_customer_id,
           r.amount::text AS amount,
           r.currency,
           r.reason,
           r.status,
           r.finance_reservation_state,
           r.finance_error_code,
           r.created_at AS submitted_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'attachment_id', a.attachment_id,
             'media_type', a.media_type,
             'size_bytes', a.file_size_bytes,
             'uploaded_at', a.uploaded_at
           ) ORDER BY a.uploaded_at, a.attachment_id)
             FROM expense_request_attachments a WHERE a.request_id = r.request_id), '[]'::jsonb) AS attachments
      FROM expense_requests r
      JOIN expense_categories category ON category.category_id = r.category_id
      LEFT JOIN expense_categories subcategory ON subcategory.category_id = r.subcategory_id
     WHERE $1::text = 'admin'
        OR r.requester_customer_id = $2
        OR ($1::text = 'staff' AND r.reviewer_manager_customer_id = $2)
     ORDER BY ${column} ${filters.direction.toUpperCase()}, r.request_id DESC
     LIMIT $3 OFFSET $4
  `, [actor.role, actor.customerId, filters.limit + 1, filters.offset])

  const hasMore = result.rows.length > filters.limit
  const rows = hasMore ? result.rows.slice(0, filters.limit) : result.rows

  return {
    items: rows,
    has_more: hasMore,
    limit: filters.limit,
    offset: filters.offset,
  }
}

async function listApprovals({ pool, actor, filters }) {
  const column = SORT_COLUMNS[filters.sort]
  if (!column || !['asc', 'desc'].includes(filters.direction)) {
    throw new RequestRepositoryError('INVALID_FILTER', 400)
  }
  const result = await pool.query(`
    SELECT r.request_id,
           r.requester_customer_id,
           r.category_id,
           r.subcategory_id,
           category.name AS category_name,
           subcategory.name AS subcategory_name,
           r.reviewer_manager_customer_id,
           r.amount::text AS amount,
           r.currency,
           r.reason,
           r.status,
           r.finance_reservation_state,
           r.finance_error_code,
           r.created_at AS submitted_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'attachment_id', a.attachment_id,
             'media_type', a.media_type,
             'size_bytes', a.file_size_bytes,
             'uploaded_at', a.uploaded_at
           ) ORDER BY a.uploaded_at, a.attachment_id)
             FROM expense_request_attachments a WHERE a.request_id = r.request_id), '[]'::jsonb) AS attachments
      FROM expense_requests r
      JOIN expense_categories category ON category.category_id = r.category_id
      LEFT JOIN expense_categories subcategory ON subcategory.category_id = r.subcategory_id
     WHERE r.requester_customer_id <> $2
       AND (
         ($1::text = 'admin' AND r.status IN ('PENDING_ADMIN', 'MANAGER_APPROVED'))
         OR ($1::text = 'staff' AND r.reviewer_manager_customer_id = $2 AND r.status IN ('PENDING_MANAGER', 'MANAGER_APPROVAL_PENDING_HOLD'))
       )
     ORDER BY ${column} ${filters.direction.toUpperCase()}, r.request_id DESC
     LIMIT $3 OFFSET $4
  `, [actor.role, actor.customerId, filters.limit + 1, filters.offset])
  const hasMore = result.rows.length > filters.limit
  return {
    items: hasMore ? result.rows.slice(0, filters.limit) : result.rows,
    has_more: hasMore,
    limit: filters.limit,
    offset: filters.offset,
  }
}

async function findAttachment({ pool, actor, requestId, attachmentId }) {
  const result = await pool.query(`
    SELECT a.storage_key, a.media_type, a.file_size_bytes
      FROM expense_request_attachments a
      JOIN expense_requests r ON r.request_id = a.request_id
     WHERE a.attachment_id = $1
       AND r.request_id = $2
       AND (
         $3::text = 'admin'
         OR r.requester_customer_id = $4
         OR ($3::text = 'staff' AND r.reviewer_manager_customer_id = $4)
       )
     LIMIT 1
  `, [attachmentId, requestId, actor.role, actor.customerId])
  return result.rows[0] || null
}

async function revealPayoutDestination({ pool, requestId, actorId, decrypt, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(`
      SELECT requester_customer_id, status, payout_network_code, payout_phone_ciphertext,
             payout_encryption_key_id, payout_phone_last4
        FROM expense_requests
       WHERE request_id = $1
       FOR SHARE
    `, [requestId])
    const request = result.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    if (!['PENDING_ADMIN', 'MANAGER_APPROVED', 'APPROVED_AWAITING_PAYOUT', 'PAYOUT_PENDING'].includes(request.status)) {
      throw new RequestRepositoryError('PAYOUT_DESTINATION_NOT_AVAILABLE', 409)
    }
    if (!request.payout_network_code || !request.payout_phone_ciphertext || !request.payout_encryption_key_id) {
      throw new RequestRepositoryError('PAYOUT_DESTINATION_NOT_AVAILABLE', 409)
    }
    const phoneNumber = decrypt({
      staffId: request.requester_customer_id,
      keyId: request.payout_encryption_key_id,
      ciphertext: request.payout_phone_ciphertext,
    })
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.payout_destination.revealed', 'expense_request', $2, $3, $4::jsonb)
    `, [actorId, requestId, requestIdForAudit, JSON.stringify({ network_code: request.payout_network_code, phone_last4: request.payout_phone_last4 })])
    await client.query('COMMIT')
    return { network_code: request.payout_network_code, phone_number: phoneNumber }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function reject({ pool, actor, requestId, stage, reason }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request_id, requester_customer_id, reviewer_manager_customer_id,
             amount::text AS amount, currency, status,
             finance_reservation_state, finance_hold_id
        FROM expense_requests
       WHERE request_id = $1
       FOR UPDATE
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    if (String(request.requester_customer_id).toLowerCase() === String(actor.customerId).toLowerCase()) {
      throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    }

    const normalizedRole = String(actor.role || '').toLowerCase()
    const stageRoleAllowed = (stage === 'manager' && normalizedRole === 'staff') ||
      (stage === 'admin' && normalizedRole === 'admin')
    if (!stageRoleAllowed) {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    if (stage === 'admin' && request.finance_reservation_state === 'RESERVED' && request.finance_hold_id) {
      throw new RequestRepositoryError('FINANCE_RELEASE_REQUIRED', 409)
    }

    const existing = await client.query(`
      SELECT actor_customer_id, action, reason
        FROM request_decisions
       WHERE request_id = $1 AND stage = $2
       FOR UPDATE
    `, [requestId, stage])
    if (existing.rowCount) {
      const previous = existing.rows[0]
      if (String(previous.actor_customer_id).toLowerCase() === String(actor.customerId).toLowerCase() &&
          previous.action === 'reject' && previous.reason === reason) {
        await client.query('COMMIT')
        return { ...request, status: stage === 'manager' ? 'REJECTED_MANAGER' : 'REJECTED_ADMIN', replayed: true }
      }
      throw new RequestRepositoryError('DECISION_ALREADY_RECORDED', 409)
    }

    const managerAllowed = stage === 'manager' &&
      String(request.reviewer_manager_customer_id).toLowerCase() === String(actor.customerId).toLowerCase() && request.status === 'PENDING_MANAGER'
    const adminAllowed = stage === 'admin' && ['PENDING_ADMIN', 'MANAGER_APPROVED'].includes(request.status)
    if (!managerAllowed && !adminAllowed) {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }

    await client.query(`
      INSERT INTO request_decisions (request_id, stage, action, actor_customer_id, reason)
      VALUES ($1, $2, 'reject', $3, $4)
    `, [requestId, stage, actor.customerId, reason])
    const status = stage === 'manager' ? 'REJECTED_MANAGER' : 'REJECTED_ADMIN'
    const updated = await client.query(`
      UPDATE expense_requests
         SET status = $2, updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, reviewer_manager_customer_id,
                 amount::text AS amount, currency, status, created_at AS submitted_at
    `, [requestId, status])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
      VALUES ($1, $2, 'expense_request', $3, $4::jsonb)
    `, [actor.customerId, `request.${stage}.rejected`, requestId, JSON.stringify({ reason, previous_status: request.status, status })])
    await client.query('COMMIT')
    return { ...updated.rows[0], replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function prepareAdminRejection({ pool, actor, requestId, reason, requestIdForAudit = null, idFactory }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request_id, requester_customer_id, amount::text AS amount, currency, status,
             finance_reservation_state, finance_hold_id, finance_release_operation_id,
             finance_release_idempotency_key, finance_release_state, finance_release_actor_customer_id,
             finance_release_reason, finance_release_error_code
        FROM expense_requests WHERE request_id = $1 FOR UPDATE
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    if (String(actor.role).toLowerCase() !== 'admin') throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    if (String(request.requester_customer_id).toLowerCase() === String(actor.customerId).toLowerCase()) {
      throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    }
    if (request.status === 'REJECTED_ADMIN') {
      await client.query('COMMIT')
      return { requiresRelease: false, request }
    }
    if (!['PENDING_ADMIN', 'MANAGER_APPROVED'].includes(request.status)) throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    if (request.status !== 'MANAGER_APPROVED' || request.finance_reservation_state !== 'RESERVED' || !request.finance_hold_id) {
      await client.query('COMMIT')
      return { requiresRelease: false, request }
    }
    const releaseActor = String(request.finance_release_actor_customer_id || '').toLowerCase()
    if (request.finance_release_operation_id) {
      if (releaseActor !== String(actor.customerId).toLowerCase() || request.finance_release_reason !== reason) {
        throw new RequestRepositoryError('ADMIN_REJECTION_ALREADY_PENDING', 409)
      }
      const operation = {
        requestId, holdId: request.finance_hold_id,
        operationId: request.finance_release_operation_id,
        idempotencyKey: request.finance_release_idempotency_key,
        actorCustomerId: actor.customerId, reason: request.finance_release_reason,
      }
      await client.query('COMMIT')
      return { requiresRelease: true, operation, replayed: true }
    }
    const operationId = idFactory()
    const idempotencyKey = `ewrr-${requestId}`
    await client.query(`
      UPDATE expense_requests
         SET finance_release_operation_id = $2, finance_release_idempotency_key = $3,
             finance_release_state = 'PENDING', finance_release_actor_customer_id = $4,
             finance_release_reason = $5, finance_release_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
    `, [requestId, operationId, idempotencyKey, actor.customerId, reason])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.rejection_release_started', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, hold_id: request.finance_hold_id })])
    await client.query('COMMIT')
    return { requiresRelease: true, operation: {
      requestId, holdId: request.finance_hold_id, operationId, idempotencyKey,
      actorCustomerId: actor.customerId, reason,
    }, replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function completeAdminRejection({ pool, actor, requestId, operationId, financeOperation, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request_id, requester_customer_id, status, finance_hold_id,
             finance_release_operation_id, finance_release_state,
             finance_release_actor_customer_id, finance_release_reason
        FROM expense_requests WHERE request_id = $1 FOR UPDATE
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    if (String(request.requester_customer_id).toLowerCase() === String(actor.customerId).toLowerCase()) throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    if (String(actor.role).toLowerCase() !== 'admin' || String(request.finance_release_actor_customer_id).toLowerCase() !== String(actor.customerId).toLowerCase()) {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    if (request.status === 'REJECTED_ADMIN' && request.finance_release_state === 'RELEASED') {
      await client.query('COMMIT')
      return { request, replayed: true }
    }
    if (request.status !== 'MANAGER_APPROVED' || request.finance_release_state !== 'PENDING' && request.finance_release_state !== 'UNKNOWN' ||
        String(request.finance_release_operation_id).toLowerCase() !== String(operationId).toLowerCase() ||
        String(request.finance_hold_id).toLowerCase() !== String(financeOperation.hold_id).toLowerCase() || financeOperation.state !== 'RELEASED') {
      throw new RequestRepositoryError('FINANCE_RELEASE_IDENTITY_CONFLICT', 409)
    }
    await client.query(`
      INSERT INTO request_decisions (request_id, stage, action, actor_customer_id, reason)
      VALUES ($1, 'admin', 'reject', $2, $3)
      ON CONFLICT (request_id, stage) DO NOTHING
    `, [requestId, actor.customerId, request.finance_release_reason])
    const updated = await client.query(`
      UPDATE expense_requests
         SET status = 'REJECTED_ADMIN', finance_reservation_state = 'RELEASED',
             finance_release_state = 'RELEASED', finance_release_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, status, finance_reservation_state, finance_release_state
    `, [requestId])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.rejected', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ reason: request.finance_release_reason, hold_id: request.finance_hold_id, operation_id: operationId })])
    await client.query('COMMIT')
    return { request: updated.rows[0], replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function markAdminRejectionPending({ pool, actor, requestId, operationId, errorCode, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(`
      UPDATE expense_requests
         SET finance_release_state = 'UNKNOWN', finance_release_error_code = $4,
             updated_at = transaction_timestamp()
       WHERE request_id = $1 AND finance_release_operation_id = $2
         AND finance_release_actor_customer_id = $3
         AND finance_release_state IN ('PENDING','UNKNOWN')
       RETURNING request_id, status, finance_release_state, finance_release_error_code
    `, [requestId, operationId, actor.customerId, errorCode])
    if (!updated.rowCount) throw new RequestRepositoryError('FINANCE_RELEASE_IDENTITY_CONFLICT', 409)
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.admin.rejection_release_pending', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, error_code: errorCode })])
    await client.query('COMMIT')
    return { request: updated.rows[0] }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function prepareManagerApproval({ pool, actor, requestId, requestIdForAudit = null, idFactory }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request.request_id, request.requester_customer_id, request.reviewer_manager_customer_id,
             request.amount::text AS amount, request.currency, request.reason, request.status,
             finance_operation_id, finance_idempotency_key, finance_hold_id,
             finance_reservation_state, finance_error_code,
             request.finance_expense_category_code, request.finance_expense_account_code,
             COALESCE(subcategory.itc_expense_category_code, category.itc_expense_category_code) AS mapped_itc_expense_category_code
        FROM expense_requests request
        JOIN expense_categories category ON category.category_id = request.category_id
        LEFT JOIN expense_categories subcategory ON subcategory.category_id = request.subcategory_id
       WHERE request.request_id = $1
       FOR UPDATE OF request
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    const requesterId = String(request.requester_customer_id).toLowerCase()
    const actorId = String(actor.customerId).toLowerCase()
    if (requesterId === actorId) throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    if (String(actor.role).toLowerCase() !== 'staff' ||
        String(request.reviewer_manager_customer_id || '').toLowerCase() !== actorId) {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    if (request.status === 'MANAGER_APPROVED' && request.finance_reservation_state === 'RESERVED' && request.finance_hold_id) {
      await client.query('COMMIT')
      return { request, replayed: true }
    }
    if (!['PENDING_MANAGER', 'MANAGER_APPROVAL_PENDING_HOLD'].includes(request.status)) {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }

    const useStoredAccountingMap = ['PENDING', 'UNKNOWN'].includes(request.finance_reservation_state)
    const expenseCategoryCode = (useStoredAccountingMap && request.finance_expense_category_code) || request.mapped_itc_expense_category_code
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(String(expenseCategoryCode || ''))) {
      throw new RequestRepositoryError('EXPENSE_CATEGORY_ACCOUNTING_MAP_REQUIRED', 422)
    }

    const operationId = request.finance_operation_id || idFactory()
    const idempotencyKey = request.finance_idempotency_key || `ewmr-${String(request.request_id).toLowerCase()}`
    const updatedResult = await client.query(`
      UPDATE expense_requests
         SET status = 'MANAGER_APPROVAL_PENDING_HOLD',
             finance_operation_id = $2,
             finance_idempotency_key = $3,
             finance_expense_category_code = $4,
             finance_reservation_state = 'PENDING',
             finance_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, reviewer_manager_customer_id,
                 amount::text AS amount, currency, reason, status,
                 finance_operation_id, finance_idempotency_key,
                 finance_reservation_state, finance_error_code
    `, [requestId, operationId, idempotencyKey, expenseCategoryCode])
    const pendingRequest = updatedResult.rows[0]
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.manager.approval_attempted', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, state: 'PENDING', expense_category_code: expenseCategoryCode })])
    await client.query('COMMIT')
    return {
      request: pendingRequest,
      operation: {
        operationId,
        requestId: request.request_id,
        requesterCustomerId: request.requester_customer_id,
        actorCustomerId: actor.customerId,
        amount: request.amount,
        currency: request.currency,
        expenseCategoryCode,
        purpose: `Expense request ${request.request_id}`,
        idempotencyKey,
      },
      replayed: false,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function completeManagerApproval({ pool, actor, requestId, operationId, idempotencyKey, financeOperation, requestIdForAudit = null }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request_id, requester_customer_id, reviewer_manager_customer_id,
             amount::text AS amount, currency, status,
             finance_operation_id, finance_idempotency_key, finance_hold_id,
             finance_reservation_state, finance_expense_category_code, finance_expense_account_code
        FROM expense_requests
       WHERE request_id = $1
       FOR UPDATE
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    const actorId = String(actor.customerId).toLowerCase()
    if (String(request.requester_customer_id).toLowerCase() === actorId) {
      throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    }
    if (String(request.reviewer_manager_customer_id || '').toLowerCase() !== actorId || String(actor.role).toLowerCase() !== 'staff') {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    if (String(request.finance_operation_id).toLowerCase() !== String(operationId).toLowerCase() ||
        request.finance_idempotency_key !== idempotencyKey ||
        String(financeOperation?.operation_id || '').toLowerCase() !== String(operationId).toLowerCase() ||
        String(financeOperation?.request_id || '').toLowerCase() !== String(requestId).toLowerCase() ||
        String(financeOperation?.amount) !== request.amount || financeOperation?.currency !== request.currency ||
        financeOperation?.state !== 'ACTIVE' || !financeOperation?.hold_id ||
        financeOperation?.expense_category_code !== request.finance_expense_category_code ||
        !/^\d{4}$/.test(String(financeOperation?.expense_account_code || '')) ||
        (request.finance_expense_account_code && financeOperation.expense_account_code !== request.finance_expense_account_code)) {
      throw new RequestRepositoryError('FINANCE_RESERVATION_MISMATCH', 409)
    }
    if (request.status === 'MANAGER_APPROVED' && request.finance_reservation_state === 'RESERVED' &&
        String(request.finance_hold_id).toLowerCase() === String(financeOperation.hold_id).toLowerCase()) {
      await client.query('COMMIT')
      return { request, replayed: true }
    }
    if (request.status !== 'MANAGER_APPROVAL_PENDING_HOLD') {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }

    const priorDecision = await client.query(`
      SELECT actor_customer_id, action
        FROM request_decisions
       WHERE request_id = $1 AND stage = 'manager'
       FOR UPDATE
    `, [requestId])
    if (priorDecision.rowCount) throw new RequestRepositoryError('DECISION_ALREADY_RECORDED', 409)

    await client.query(`
      INSERT INTO request_decisions (request_id, stage, action, actor_customer_id, reason)
      VALUES ($1, 'manager', 'approve', $2, NULL)
    `, [requestId, actor.customerId])
    const updatedResult = await client.query(`
      UPDATE expense_requests
         SET status = 'MANAGER_APPROVED',
             finance_reservation_state = 'RESERVED',
             finance_hold_id = $2,
             finance_expense_account_code = $3,
             finance_error_code = NULL,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, requester_customer_id, reviewer_manager_customer_id,
                 amount::text AS amount, currency, status, created_at AS submitted_at,
                 finance_reservation_state, finance_error_code
    `, [requestId, financeOperation.hold_id, financeOperation.expense_account_code])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.manager.approved', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, hold_id: financeOperation.hold_id, amount: request.amount, currency: request.currency, expense_category_code: request.finance_expense_category_code, expense_account_code: financeOperation.expense_account_code })])
    await client.query('COMMIT')
    return { request: updatedResult.rows[0], replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function markManagerApprovalFailure({ pool, actor, requestId, operationId, state, errorCode, requestIdForAudit = null }) {
  if (!['FAILED', 'UNKNOWN'].includes(state) || !/^[A-Z0-9_]{1,100}$/.test(String(errorCode || ''))) {
    throw new RequestRepositoryError('INVALID_FINANCE_FAILURE', 400)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(`
      SELECT request_id, requester_customer_id, reviewer_manager_customer_id, status,
             finance_operation_id, finance_reservation_state, finance_hold_id
        FROM expense_requests
       WHERE request_id = $1
       FOR UPDATE
    `, [requestId])
    const request = selected.rows[0]
    if (!request) throw new RequestRepositoryError('REQUEST_NOT_FOUND', 404)
    if (String(request.requester_customer_id).toLowerCase() === String(actor.customerId).toLowerCase()) {
      throw new RequestRepositoryError('SELF_REVIEW_PROHIBITED', 403)
    }
    if (String(request.reviewer_manager_customer_id || '').toLowerCase() !== String(actor.customerId).toLowerCase() || String(actor.role).toLowerCase() !== 'staff') {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    if (String(request.finance_operation_id).toLowerCase() !== String(operationId).toLowerCase()) {
      throw new RequestRepositoryError('FINANCE_OPERATION_MISMATCH', 409)
    }
    if (request.status === 'MANAGER_APPROVED' && request.finance_reservation_state === 'RESERVED' && request.finance_hold_id) {
      await client.query('COMMIT')
      return { request, completed: true }
    }
    if (request.status !== 'MANAGER_APPROVAL_PENDING_HOLD') {
      throw new RequestRepositoryError('DECISION_NOT_ALLOWED', 403)
    }
    const updatedResult = await client.query(`
      UPDATE expense_requests
         SET finance_reservation_state = $2,
             finance_error_code = $3,
             updated_at = transaction_timestamp()
       WHERE request_id = $1
       RETURNING request_id, status, finance_reservation_state, finance_error_code
    `, [requestId, state, errorCode])
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, request_id, metadata)
      VALUES ($1, 'request.manager.approval_pending', 'expense_request', $2, $3, $4::jsonb)
    `, [actor.customerId, requestId, requestIdForAudit, JSON.stringify({ operation_id: operationId, state, error_code: errorCode })])
    await client.query('COMMIT')
    return { request: updatedResult.rows[0], completed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function createRequestRepository({ pool, idFactory = randomUUID }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required')
  }
  return Object.freeze({
    submit: (input) => submit({ pool, ...input }),
    listForActor: (input) => listForActor({ pool, ...input }),
    listApprovals: (input) => listApprovals({ pool, ...input }),
    findAttachment: (input) => findAttachment({ pool, ...input }),
    revealPayoutDestination: (input) => revealPayoutDestination({ pool, ...input }),
    reject: (input) => reject({ pool, ...input }),
    prepareAdminRejection: (input) => prepareAdminRejection({ pool, idFactory, ...input }),
    completeAdminRejection: (input) => completeAdminRejection({ pool, ...input }),
    markAdminRejectionPending: (input) => markAdminRejectionPending({ pool, ...input }),
    prepareManagerApproval: (input) => prepareManagerApproval({ pool, idFactory, ...input }),
    completeManagerApproval: (input) => completeManagerApproval({ pool, ...input }),
    markManagerApprovalFailure: (input) => markManagerApprovalFailure({ pool, ...input }),
  })
}

module.exports = { createRequestRepository, RequestRepositoryError, fingerprint }
