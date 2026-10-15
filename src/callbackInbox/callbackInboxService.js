const crypto = require('node:crypto')

class CallbackInboxError extends Error {
  constructor(code, statusCode = 400) {
    super(code)
    this.name = 'CallbackInboxError'
    this.code = code
    this.statusCode = statusCode
  }
}

function callbackSignatureKeyId(value) {
  const match = String(value || '').match(/(?:^|;)\s*keyid="([A-Za-z0-9._:-]{1,128})"(?:;|$)/)
  return match?.[1] || null
}

function safeHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : null
}

function parseCallback(transactionType, rawBody, headers) {
  let body
  try { body = JSON.parse(rawBody.toString('utf8')) } catch {
    throw new CallbackInboxError('CALLBACK_JSON_INVALID', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CallbackInboxError('CALLBACK_RECORD_INVALID', 400)
  }
  const idField = transactionType === 'deposit' ? 'depositId' : 'payoutId'
  const transactionId = body[idField]
  if (typeof transactionId !== 'string' || transactionId.length > 36 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/.test(transactionId)) {
    throw new CallbackInboxError('CALLBACK_TRANSACTION_ID_INVALID', 400)
  }
  const providerStatus = body.status
  if (typeof providerStatus !== 'string' || providerStatus.length > 40 || !/^[A-Z][A-Z0-9_]{0,39}$/.test(providerStatus)) {
    throw new CallbackInboxError('CALLBACK_STATUS_INVALID', 400)
  }
  return { transaction_id: transactionId, provider_status: providerStatus }
}

function createCallbackInboxService({ verifier, repository } = {}) {
  if (!verifier || typeof verifier.verifyCallback !== 'function') throw new TypeError('A PawaPay callback verifier is required')
  if (!repository || typeof repository.append !== 'function') throw new TypeError('A callback inbox repository is required')

  return Object.freeze({
    async receive({ transactionType, rawBody, headers, requestContext } = {}) {
      if (!['deposit', 'payout'].includes(transactionType)) throw new CallbackInboxError('CALLBACK_TYPE_INVALID', 404)
      if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > 65536) {
        throw new CallbackInboxError('CALLBACK_BODY_INVALID', 413)
      }

      // Signature verification intentionally precedes any interpretation of the body.
      try { await verifier.verifyCallback({ requestContext: { ...requestContext, rawBody, headers } }) }
      catch { throw new CallbackInboxError('CALLBACK_SIGNATURE_INVALID', 401) }

      const record = parseCallback(transactionType, rawBody, headers)
      const signatureDate = safeHeader(headers, 'signature-date')
      if (!signatureDate || !Number.isFinite(Date.parse(signatureDate))) {
        throw new CallbackInboxError('CALLBACK_SIGNATURE_DATE_INVALID', 401)
      }
      const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex')
      const event = Object.freeze({
        provider_code: 'pawapay',
        transaction_type: transactionType,
        transaction_id: record.transaction_id,
        provider_status: record.provider_status,
        provider_reference: null,
        payload_sha256: payloadSha256,
        signature_key_id: callbackSignatureKeyId(safeHeader(headers, 'signature-input')),
        signature_date: new Date(signatureDate).toISOString(),
      })
      try {
        const result = await repository.append(event)
        return { duplicate: !result.inserted, event_id: result.eventId || null }
      } catch {
        throw new CallbackInboxError('CALLBACK_INBOX_UNAVAILABLE', 503)
      }
    },
  })
}

module.exports = { createCallbackInboxService, CallbackInboxError }
