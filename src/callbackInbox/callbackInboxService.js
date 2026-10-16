const crypto = require('node:crypto')

class CallbackInboxError extends Error {
  constructor(code, statusCode = 400) {
    super(code)
    this.name = 'CallbackInboxError'
    this.code = code
    this.statusCode = statusCode
  }
}

function createCallbackInboxService({ provider, providerCode = 'pawapay', providerAccountIdentity = null, repository } = {}) {
  if (!provider || typeof provider.verifyCallback !== 'function' || typeof provider.normalizeCallback !== 'function') {
    throw new TypeError('A callback provider with verification and normalization is required')
  }
  if (!repository || typeof repository.append !== 'function') throw new TypeError('A callback inbox repository is required')
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(String(providerCode))) throw new TypeError('A valid callback provider code is required')

  return Object.freeze({
    async receive({ transactionType, rawBody, headers, requestContext } = {}) {
      if (!['deposit', 'payout'].includes(transactionType)) throw new CallbackInboxError('CALLBACK_TYPE_INVALID', 404)
      if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > 65536) {
        throw new CallbackInboxError('CALLBACK_BODY_INVALID', 413)
      }

      // Signature verification intentionally precedes any interpretation of the body.
      try { await provider.verifyCallback({ requestContext: { ...requestContext, rawBody, headers } }) }
      catch { throw new CallbackInboxError('CALLBACK_SIGNATURE_INVALID', 401) }

      let record
      try { record = await provider.normalizeCallback({ transactionType, rawBody, headers }) } catch {
        throw new CallbackInboxError('CALLBACK_RECORD_INVALID', 400)
      }
      if (!record || typeof record !== 'object' ||
          typeof record.transaction_id !== 'string' || record.transaction_id.length > 36 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/.test(record.transaction_id)) {
        throw new CallbackInboxError('CALLBACK_TRANSACTION_ID_INVALID', 400)
      }
      if (typeof record.provider_status !== 'string' || record.provider_status.length > 40 || !/^[A-Z][A-Z0-9_]{0,39}$/.test(record.provider_status)) {
        throw new CallbackInboxError('CALLBACK_STATUS_INVALID', 400)
      }
      const signatureDate = record.signature_date
      const parsedSignatureDate = Date.parse(signatureDate)
      if (!Number.isFinite(parsedSignatureDate)) {
        throw new CallbackInboxError('CALLBACK_SIGNATURE_DATE_INVALID', 401)
      }
      const providerReference = record.provider_reference == null ? null : String(record.provider_reference)
      if (providerReference !== null && (providerReference.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(providerReference))) {
        throw new CallbackInboxError('CALLBACK_REFERENCE_INVALID', 400)
      }
      const signatureKeyId = record.signature_key_id == null ? null : String(record.signature_key_id)
      if (signatureKeyId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(signatureKeyId)) {
        throw new CallbackInboxError('CALLBACK_SIGNATURE_KEY_ID_INVALID', 400)
      }
      const payloadSha256 = crypto.createHash('sha256').update(rawBody).digest('hex')
      const event = Object.freeze({
        provider_code: providerCode,
        provider_account_id: providerAccountIdentity?.provider_account_id || null,
        provider_account_version: providerAccountIdentity?.provider_account_version || null,
        transaction_type: transactionType,
        transaction_id: record.transaction_id,
        provider_status: record.provider_status,
        provider_reference: providerReference,
        payload_sha256: payloadSha256,
        signature_key_id: signatureKeyId,
        signature_date: new Date(parsedSignatureDate).toISOString(),
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
