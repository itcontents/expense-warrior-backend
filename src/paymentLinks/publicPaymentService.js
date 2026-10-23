const crypto = require('node:crypto')
const { PaymentLinkError } = require('./paymentLinkService')
const { createPaymentReceiptPdf } = require('./paymentReceiptPdf')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHONE_ZM = /^260\d{9}$/
const AMOUNT = /^(?:0|[1-9]\d{0,11})\.\d{2}$/
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const RECEIPT_NETWORKS = Object.freeze({
  AIRTEL_OAPI_ZMB: 'Airtel Money',
  MTN_MOMO_ZMB: 'MTN Mobile Money',
  ZAMTEL_ZMB: 'Zamtel Kwacha',
})
const isArLink = (link) => link?.collection_target_type === 'AR_SETTLEMENT'
const requiresCollectionPreflight = (link) =>
  link?.collection_target_type === 'REVENUE' || link?.collection_target_type === 'CUSTOMER_CREDIT'
const supportsPublicPhonePrompt = (network) =>
  network?.auth_type === 'PROVIDER_AUTH' && network?.pin_prompt === 'AUTOMATIC'

async function preflightCollectionAttempt(itcFinanceClient, link, attempt) {
  const target = link.collection_target_type === 'REVENUE'
    ? { type: 'REVENUE', revenue_account_code: link.revenue_account_code }
    : { type: 'CUSTOMER_CREDIT', customer_id: link.customer_id }
  const result = await itcFinanceClient.preflightCollectionTarget({
    payment_link_id: attempt.payment_link_id || link.payment_link_id,
    collection_attempt_id: attempt.attempt_id,
    actor_customer_id: link.created_by_customer_id,
    provider_code: attempt.provider_code,
    provider_account_id: attempt.provider_account_id,
    provider_account_version: attempt.provider_account_version,
    target,
  }, `ew-preflight-${attempt.attempt_id}`, attempt.attempt_id)
  if (result?.ready !== true) {
    throw new PaymentLinkError('ITC_COLLECTION_PREFLIGHT_NOT_READY', 502)
  }
}

function receivableReservationKey(attemptId) { return `ew-ar-reserve-${attemptId}` }
function receivableReleaseKey(attemptId) { return `ew-ar-release-${attemptId}` }

async function reserveReceivableAttempt(repository, itcFinanceClient, link, attempt) {
  if (!itcFinanceClient || typeof itcFinanceClient.reserveCustomerReceivablePayment !== 'function' ||
      !UUID.test(String(link.customer_id || '')) || !UUID.test(String(link.receivable_id || '')) ||
      !UUID.test(String(link.created_by_customer_id || '')) || !UUID.test(String(attempt.payment_link_id || link.payment_link_id || '')) ||
      !UUID.test(String(attempt.attempt_id || ''))) {
    await repository.updateAttempt(attempt.attempt_id, { state: 'FAILED', providerStatus: 'ITC_RESERVATION_REJECTED', errorCode: 'ITC_FINANCE_UNAVAILABLE' })
    await repository.updateReceivableReservationState(attempt.attempt_id, 'RELEASED')
    return { terminal: true }
  }
  const payload = {
    reservation_id: attempt.receivable_reservation_id || attempt.attempt_id,
    payment_link_id: attempt.payment_link_id || link.payment_link_id,
    collection_attempt_id: attempt.attempt_id,
    actor_customer_id: link.created_by_customer_id,
    customer_id: link.customer_id,
    receivable_id: link.receivable_id,
    amount: attempt.amount,
    currency: attempt.currency,
  }
  try {
    const result = await itcFinanceClient.reserveCustomerReceivablePayment(payload, receivableReservationKey(attempt.attempt_id), attempt.attempt_id)
    const reservation = result?.reservation
    if (!reservation || reservation.state !== 'ACTIVE' ||
        String(reservation.reservation_id).toLowerCase() !== payload.reservation_id.toLowerCase() ||
        String(reservation.receivable_id).toLowerCase() !== payload.receivable_id.toLowerCase() ||
        String(reservation.collection_attempt_id).toLowerCase() !== payload.collection_attempt_id.toLowerCase() ||
        reservation.amount !== payload.amount || reservation.currency_code !== 'ZMW') {
      await repository.updateReceivableReservationState(attempt.attempt_id, 'UNKNOWN')
      await repository.updateAttempt(attempt.attempt_id, { state: 'UNKNOWN', providerStatus: 'ITC_RESERVATION_UNKNOWN', errorCode: 'ITC_RESERVATION_RESPONSE_INVALID' })
      return { terminal: false }
    }
    await repository.updateReceivableReservationState(attempt.attempt_id, 'ACTIVE')
    return { terminal: false, active: true }
  } catch (error) {
    const knownFailure = ['RECEIVABLE_NOT_FULL_BALANCE_ELIGIBLE', 'RECEIVABLE_ALREADY_RESERVED',
      'COLLECTION_ATTEMPT_ALREADY_RESERVED', 'IDEMPOTENCY_CONFLICT', 'INVALID_RECEIVABLE_RESERVATION',
      'ADMIN_IDENTITY_UNAVAILABLE'].includes(error?.code)
    await repository.updateReceivableReservationState(attempt.attempt_id, knownFailure ? 'RELEASED' : 'UNKNOWN')
    if (knownFailure) {
      await repository.updateAttempt(attempt.attempt_id, { state: 'FAILED', providerStatus: 'ITC_RESERVATION_REJECTED', errorCode: error.code })
      return { terminal: true }
    }
    await repository.updateAttempt(attempt.attempt_id, { state: 'UNKNOWN', providerStatus: 'ITC_RESERVATION_UNKNOWN', errorCode: 'ITC_RESERVATION_UNAVAILABLE' })
    return { terminal: false }
  }
}

async function releaseReceivableAttempt(repository, itcFinanceClient, link, attempt, terminalEvidence) {
  if (!itcFinanceClient || typeof itcFinanceClient.releaseCustomerReceivablePayment !== 'function' ||
      !UUID.test(String(attempt.receivable_reservation_id || attempt.attempt_id)) ||
      !UUID.test(String(link.created_by_customer_id || ''))) {
    await repository.updateReceivableReservationState(attempt.attempt_id, 'UNKNOWN')
    return false
  }
  const outcome = String(terminalEvidence?.outcome || '')
  const reasonCode = outcome === 'REJECTED' ? 'PROVIDER_REJECTED' : 'PROVIDER_FAILED'
  const evidenceDigest = sha256(JSON.stringify([
    attempt.provider_code, attempt.provider_transaction_id, outcome,
    terminalEvidence?.provider_status || '', terminalEvidence?.rejection_code || '',
  ]))
  const payload = {
    operation_id: attempt.attempt_id,
    actor_customer_id: link.created_by_customer_id,
    reason_code: reasonCode,
    reason: `${attempt.provider_code} deposit reached terminal ${outcome.toLowerCase()} status`,
    evidence_digest: evidenceDigest,
  }
  try {
    const result = await itcFinanceClient.releaseCustomerReceivablePayment(
      attempt.receivable_reservation_id || attempt.attempt_id, payload,
      receivableReleaseKey(attempt.attempt_id), attempt.attempt_id,
    )
    if (result?.reservation?.state !== 'RELEASED') throw new Error('Reservation release was not confirmed')
    await repository.updateReceivableReservationState(attempt.attempt_id, 'RELEASED')
    await repository.updateAttempt(attempt.attempt_id, { state: 'FAILED', providerStatus: terminalEvidence.provider_status || outcome, errorCode: reasonCode })
    return true
  } catch (_error) {
    await repository.updateReceivableReservationState(attempt.attempt_id, 'UNKNOWN')
    await repository.updateAttempt(attempt.attempt_id, { state: 'UNKNOWN', providerStatus: terminalEvidence.provider_status || outcome, errorCode: 'ITC_RESERVATION_RELEASE_PENDING' })
    return false
  }
}

function toPublicAttempt(attempt) {
  const state = attempt.state === 'VERIFIED_PENDING_LEDGER' ? 'VERIFYING_LEDGER' : attempt.state
  return {
    attempt_id: attempt.attempt_id,
    status: state,
    amount: attempt.amount,
    currency: attempt.currency,
    provider_code: attempt.provider_code,
    network_code: attempt.network_code,
    payer_phone_masked: `••••${String(attempt.payer_phone || '').slice(-4)}`,
    created_at: new Date(attempt.created_at).toISOString(),
    updated_at: new Date(attempt.updated_at).toISOString(),
    receipt_available: attempt.state === 'SUCCEEDED' && Boolean(attempt.ledger_operation_id),
  }
}

function amountToMinor(value) {
  const match = String(value || '').match(/^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/)
  if (!match) return null
  return BigInt(match[1]) * 100n + BigInt(String(match[2] || '').padEnd(2, '0') || '0')
}

function providerAmount(amount, network) {
  const valueMinor = amountToMinor(amount)
  const minimum = amountToMinor(network.min_amount)
  const maximum = amountToMinor(network.max_amount)
  if (valueMinor === null || minimum === null || maximum === null || valueMinor < minimum || valueMinor > maximum) return null
  if (network.decimals_in_amount === 'NONE') {
    if (valueMinor % 100n !== 0n) return null
    return String(valueMinor / 100n)
  }
  if (network.decimals_in_amount === 'TWO_PLACES') return String(amount)
  return null
}

async function getDepositNetworks(providerRegistry) {
  if (typeof providerRegistry?.getActiveNetworks !== 'function') return []
  const networks = await providerRegistry.getActiveNetworks('deposit', { country: 'ZMB', currency: 'ZMW' })
  if (!Array.isArray(networks)) throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE', 503)
  return networks
}

async function getUniqueNetwork(providerRegistry, providerCode, networkCode, link) {
  if (link.currency !== 'ZMW') return null
  let availableNetworks
  try { availableNetworks = await getDepositNetworks(providerRegistry) }
  catch (_error) { throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE', 503) }
  const matching = availableNetworks
    .filter((network) => network.code === networkCode && (!providerCode || network.provider_code === providerCode) &&
      supportsPublicPhonePrompt(network) && providerAmount(link.amount, network) !== null)
  if (matching.length > 1) throw new PaymentLinkError('PAYMENT_NETWORK_ROUTE_AMBIGUOUS', 503)
  return matching[0] || null
}

function getProviderForOperation(providerRegistry, providerCode, operation, accountIdentity = null) {
  if (typeof providerRegistry?.getForOperation === 'function') return providerRegistry.getForOperation(providerCode, operation, accountIdentity)
  const provider = providerRegistry?.get?.(providerCode)
  const methods = { deposit: ['initiateDeposit', 'getDepositStatus'] }[operation] || []
  return provider && methods.every((method) => typeof provider[method] === 'function') ? provider : null
}

function createPublicPaymentService({ repository, providerRegistry, itcFinanceClient, idFactory = crypto.randomUUID } = {}) {
  if (!repository) throw new TypeError('Payment-link repository is required')
  return Object.freeze({
    async getLink(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new PaymentLinkError('PAYMENT_LINK_NOT_AVAILABLE', 404)
      const link = await repository.getPublicLink(sha256(token))
      if (!link) throw new PaymentLinkError('PAYMENT_LINK_NOT_AVAILABLE', 404)
      let availableNetworks
      try { availableNetworks = await getDepositNetworks(providerRegistry) }
      catch (_error) { throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE', 503) }
      return {
        payment_link_id: link.payment_link_id,
        description: link.description,
        amount: link.amount,
        currency: link.currency,
        available_networks: availableNetworks
          .filter((network) => link.currency === 'ZMW' && supportsPublicPhonePrompt(network) && providerAmount(link.amount, network) !== null)
          .map(({ provider_code, provider_label, code, label, min_amount, max_amount, decimals_in_amount, auth_type, pin_prompt }) => ({
            provider_code, code, label, min_amount, max_amount, decimals_in_amount, auth_type,
            ...(provider_label ? { provider_label } : {}),
            ...(pin_prompt ? { pin_prompt } : {}),
          })),
      }
    },

    async startAttempt(token, input, idempotencyKey) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(token) ||
          !input || typeof input !== 'object' || !PHONE_ZM.test(String(input.phone_number || '')) ||
          !UUID.test(String(idempotencyKey || '')) ||
          (input.provider_code !== undefined && !/^[a-z][a-z0-9_]{1,31}$/.test(String(input.provider_code)))) throw new PaymentLinkError('INVALID_PAYMENT_ATTEMPT', 400)
      const tokenHash = sha256(token)
      const requestFingerprint = sha256(JSON.stringify(input.provider_code
        ? [input.provider_code, input.network_code, input.phone_number]
        : [input.network_code, input.phone_number]))
      if (typeof repository.getAttemptByIdempotency === 'function') {
        const existing = await repository.getAttemptByIdempotency(tokenHash, idempotencyKey)
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) throw new PaymentLinkError('IDEMPOTENCY_CONFLICT', 409)
          return { attempt: toPublicAttempt(existing), replayed: true }
        }
      }
      const link = await repository.getPublicLink(tokenHash)
      if (!link) throw new PaymentLinkError('PAYMENT_LINK_NOT_AVAILABLE', 404)
      const selectedNetwork = await getUniqueNetwork(providerRegistry, input.provider_code || null, input.network_code, link)
      if (!selectedNetwork) throw new PaymentLinkError('INVALID_PAYMENT_ATTEMPT', 400)
      const attemptId = idFactory()
      if (!UUID.test(String(attemptId || ''))) throw new PaymentLinkError('PAYMENT_ATTEMPT_ID_INVALID')
      const providerCode = selectedNetwork.provider_code
      let providerAccountIdentity = null
      try { providerAccountIdentity = providerRegistry?.getAccountIdentity?.(providerCode) || null }
      catch (_error) { throw new PaymentLinkError('PAYMENT_PROVIDER_CONFIGURATION_UNAVAILABLE', 503) }
      if (!providerAccountIdentity) throw new PaymentLinkError('PAYMENT_PROVIDER_CONFIGURATION_UNAVAILABLE', 503)
      let provider
      try { provider = getProviderForOperation(providerRegistry, providerCode, 'deposit', providerAccountIdentity) }
      catch (_error) { throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE') }
      if (!provider) throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE')

      const prepared = await repository.createAttempt({
        tokenHash,
        idempotencyKey,
        requestFingerprint,
        attemptId,
        providerCode,
        networkCode: input.network_code,
        networkLabel: selectedNetwork.label,
        phoneNumber: input.phone_number,
        providerAccountId: providerAccountIdentity?.provider_account_id || null,
        providerAccountVersion: providerAccountIdentity?.provider_account_version || null,
      })
      if (prepared.replayed) return { attempt: toPublicAttempt(prepared.attempt), replayed: true }

      if (requiresCollectionPreflight(prepared.link)) {
        try {
          if (typeof itcFinanceClient?.preflightCollectionTarget !== 'function') {
            throw new PaymentLinkError('ITC_FINANCE_UNAVAILABLE', 503)
          }
          await preflightCollectionAttempt(itcFinanceClient, prepared.link, prepared.attempt)
        } catch (error) {
          const errorCode = /^[A-Z0-9_]{1,100}$/.test(String(error?.code || ''))
            ? error.code
            : 'ITC_COLLECTION_PREFLIGHT_FAILED'
          const attempt = await repository.updateAttempt(prepared.attempt.attempt_id, {
            state: 'FAILED',
            providerStatus: 'ITC_PREFLIGHT_REJECTED',
            errorCode,
          })
          return { attempt: toPublicAttempt(attempt), replayed: prepared.replayed }
        }
      }

      if (isArLink(prepared.link)) {
        const reservation = await reserveReceivableAttempt(repository, itcFinanceClient, prepared.link, prepared.attempt)
        if (!reservation.active) {
          const current = await repository.getPublicAttempt(tokenHash, prepared.attempt.attempt_id)
          return { attempt: toPublicAttempt(current || prepared.attempt), replayed: false }
        }
      }

      let updated
      try {
        const response = await provider.initiateDeposit({
          transaction_id: prepared.attempt.provider_transaction_id,
          country: 'ZMB',
          currency: prepared.attempt.currency,
          amount: providerAmount(prepared.attempt.amount, selectedNetwork),
          phone_number: prepared.attempt.payer_phone,
          network_code: prepared.attempt.network_code,
          client_reference: `EW-${prepared.attempt.attempt_id}`,
          customer_message: 'EW petty cash',
        })
        if (response?.transaction_id !== prepared.attempt.provider_transaction_id ||
            !['ACCEPTED', 'DUPLICATE', 'REJECTED'].includes(response?.outcome)) {
          updated = await repository.updateAttempt(prepared.attempt.attempt_id, {
            state: 'UNKNOWN', providerStatus: response?.provider_status || response?.outcome || 'INVALID_RESPONSE', errorCode: 'PROVIDER_RESPONSE_INVALID',
          })
        } else {
          updated = await repository.updateAttempt(prepared.attempt.attempt_id, {
            state: response.outcome === 'REJECTED' ? 'FAILED' : 'PENDING',
            providerStatus: response.provider_status || response.outcome,
            providerReference: response.rejection_code || null,
            errorCode: response.outcome === 'REJECTED' ? 'PROVIDER_REJECTED' : null,
          })
        }
      } catch (error) {
        updated = await repository.updateAttempt(prepared.attempt.attempt_id, {
          state: error?.outcomeUnknown ? 'UNKNOWN' : 'FAILED',
          providerStatus: error?.outcomeUnknown ? 'OUTCOME_UNKNOWN' : null,
          errorCode: /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : 'PROVIDER_UNAVAILABLE',
        })
      }
      if (isArLink(prepared.link) && updated.state === 'FAILED') {
        await releaseReceivableAttempt(repository, itcFinanceClient, prepared.link, {
          ...prepared.attempt, ...updated,
          receivable_reservation_id: prepared.attempt.receivable_reservation_id || prepared.attempt.attempt_id,
        }, { outcome: 'REJECTED', provider_status: updated.provider_status, rejection_code: updated.error_code })
        updated = await repository.getPublicAttempt(tokenHash, prepared.attempt.attempt_id) || updated
      }
      return { attempt: toPublicAttempt(updated), replayed: false }
    },

    async refreshAttempt(token, attemptId) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(token) || !UUID.test(String(attemptId || ''))) {
        throw new PaymentLinkError('PAYMENT_ATTEMPT_NOT_FOUND', 404)
      }
      const tokenHash = sha256(token)
      const attempt = await repository.getPublicAttempt(tokenHash, attemptId)
      if (!attempt) throw new PaymentLinkError('PAYMENT_ATTEMPT_NOT_FOUND', 404)
      if (['FAILED', 'SUCCEEDED'].includes(attempt.state)) return toPublicAttempt(attempt)
      if (isArLink(attempt) && attempt.receivable_reservation_state !== 'RELEASED' &&
          ['FAILED', 'CANCELLED', 'REJECTED'].includes(String(attempt.provider_status || '').toUpperCase())) {
        await releaseReceivableAttempt(repository, itcFinanceClient, { created_by_customer_id: attempt.created_by_customer_id }, attempt, {
          outcome: String(attempt.provider_status).toUpperCase(), provider_status: attempt.provider_status,
          rejection_code: attempt.provider_reference,
        })
        return toPublicAttempt(await repository.getPublicAttempt(tokenHash, attempt.attempt_id) || attempt)
      }
      if (isArLink(attempt) && attempt.receivable_reservation_state !== 'ACTIVE' && attempt.state !== 'VERIFIED_PENDING_LEDGER') {
        const link = {
          payment_link_id: attempt.payment_link_id,
          collection_target_type: attempt.collection_target_type,
          customer_id: attempt.customer_id,
          receivable_id: attempt.receivable_id,
          created_by_customer_id: attempt.created_by_customer_id,
        }
        const reservation = await reserveReceivableAttempt(repository, itcFinanceClient, link, attempt)
        if (reservation.terminal || !reservation.active) {
          return toPublicAttempt(await repository.getPublicAttempt(tokenHash, attempt.attempt_id) || attempt)
        }
        const existingStatus = String(attempt.provider_status || '').toUpperCase()
        if (['FAILED', 'CANCELLED', 'REJECTED'].includes(existingStatus)) {
          await releaseReceivableAttempt(repository, itcFinanceClient, link, attempt, { outcome: existingStatus, provider_status: existingStatus })
          return toPublicAttempt(await repository.getPublicAttempt(tokenHash, attempt.attempt_id) || attempt)
        }
        const selectedNetwork = await getUniqueNetwork(providerRegistry, attempt.provider_code, attempt.network_code, attempt)
        const provider = getProviderForOperation(providerRegistry, attempt.provider_code, 'deposit', {
          provider_account_id: attempt.provider_account_id, provider_account_version: attempt.provider_account_version,
        })
        if (!selectedNetwork || !provider) throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE', 503)
        try {
          const response = await provider.initiateDeposit({
            transaction_id: attempt.provider_transaction_id, country: 'ZMB', currency: attempt.currency,
            amount: providerAmount(attempt.amount, selectedNetwork), phone_number: attempt.payer_phone,
            network_code: attempt.network_code, client_reference: `EW-${attempt.attempt_id}`, customer_message: 'EW petty cash',
          })
          const submitted = await repository.updateAttempt(attempt.attempt_id, {
            state: response?.outcome === 'REJECTED' ? 'FAILED' : ['ACCEPTED', 'DUPLICATE'].includes(response?.outcome) ? 'PENDING' : 'UNKNOWN',
            providerStatus: response?.provider_status || response?.outcome || 'INVALID_RESPONSE',
            providerReference: response?.rejection_code || null,
            errorCode: response?.outcome === 'REJECTED' ? 'PROVIDER_REJECTED' : null,
          })
          if (submitted.state === 'FAILED') await releaseReceivableAttempt(repository, itcFinanceClient, link, attempt, { outcome: 'REJECTED', provider_status: submitted.provider_status, rejection_code: submitted.provider_reference })
          return toPublicAttempt(await repository.getPublicAttempt(tokenHash, attempt.attempt_id) || submitted)
        } catch (_error) {
          const unknown = await repository.updateAttempt(attempt.attempt_id, { state: 'UNKNOWN', providerStatus: 'OUTCOME_UNKNOWN', errorCode: 'PROVIDER_UNAVAILABLE' })
          return toPublicAttempt(unknown)
        }
      }
      if (attempt.state === 'VERIFIED_PENDING_LEDGER' && attempt.provider_evidence_digest) {
        return toPublicAttempt(await postConfirmedCollection(repository, itcFinanceClient, attempt))
      }

      let provider
      const accountIdentity = attempt.provider_account_id && attempt.provider_account_version
        ? { provider_account_id: attempt.provider_account_id, provider_account_version: attempt.provider_account_version }
        : null
      try { provider = getProviderForOperation(providerRegistry, attempt.provider_code || 'pawapay', 'deposit', accountIdentity) }
      catch (_error) { throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE') }
      if (!provider) throw new PaymentLinkError('PAYMENT_PROVIDER_UNAVAILABLE')
      let providerTransaction
      try { providerTransaction = await provider.getDepositStatus(attempt.provider_transaction_id) }
      catch (_error) { return toPublicAttempt(attempt) }
      if (!providerTransaction) return toPublicAttempt(attempt)

      const transactionId = providerTransaction.transaction_id
      const status = providerTransaction.provider_status || providerTransaction.outcome
      if (transactionId !== attempt.provider_transaction_id) {
        if (attempt.state === 'VERIFIED_PENDING_LEDGER') return toPublicAttempt(attempt)
        return toPublicAttempt(await repository.updateAttempt(attempt.attempt_id, { state: 'UNKNOWN', providerStatus: status || 'MISMATCH', errorCode: 'PROVIDER_EVIDENCE_MISMATCH' }))
      }
      if (['FAILED', 'CANCELLED'].includes(providerTransaction.outcome)) {
        if (attempt.state === 'VERIFIED_PENDING_LEDGER') return toPublicAttempt(attempt)
        if (isArLink(attempt)) {
          const link = { created_by_customer_id: attempt.created_by_customer_id }
          await releaseReceivableAttempt(repository, itcFinanceClient, link, attempt, { outcome: providerTransaction.outcome, provider_status: status })
          return toPublicAttempt(await repository.getPublicAttempt(tokenHash, attempt.attempt_id) || attempt)
        }
        return toPublicAttempt(await repository.updateAttempt(attempt.attempt_id, { state: 'FAILED', providerStatus: status, errorCode: status }))
      }
      if (providerTransaction.outcome !== 'SUCCEEDED') {
        if (attempt.state === 'VERIFIED_PENDING_LEDGER') return toPublicAttempt(attempt)
        return toPublicAttempt(await repository.updateAttempt(attempt.attempt_id, {
          state: providerTransaction.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING', providerStatus: status || 'UNKNOWN',
        }))
      }

      const evidence = providerTransaction.evidence
      const payerPhone = evidence?.phone_number
      const network = evidence?.network_code
      const requestedAmount = evidence?.requested_amount || evidence?.amount
      const receivedAmount = evidence?.received_amount || evidence?.amount
      const evidenceMatches = evidence && evidence.country === 'ZMB' &&
        transactionId === attempt.provider_transaction_id &&
        amountToMinor(requestedAmount) === amountToMinor(attempt.amount) &&
        amountToMinor(receivedAmount) === amountToMinor(attempt.amount) &&
        evidence.currency === attempt.currency && network === attempt.network_code && payerPhone === attempt.payer_phone
      if (!evidenceMatches) {
        if (attempt.state === 'VERIFIED_PENDING_LEDGER') return toPublicAttempt(attempt)
        return toPublicAttempt(await repository.updateAttempt(attempt.attempt_id, {
          state: 'UNKNOWN', providerStatus: 'COMPLETED', errorCode: 'PROVIDER_EVIDENCE_MISMATCH',
        }))
      }
      const evidenceDigest = sha256(JSON.stringify([
        providerTransaction.transaction_id,
        providerTransaction.provider_status || providerTransaction.outcome,
        evidence.country,
        requestedAmount,
        receivedAmount,
        evidence.currency,
        network,
        payerPhone,
        evidence.provider_transaction_id || null,
      ]))
      const verified = await repository.updateAttempt(attempt.attempt_id, {
        state: 'VERIFIED_PENDING_LEDGER', providerStatus: status,
        providerReference: String(evidence.provider_transaction_id || '').slice(0, 128) || null,
        verified: true, evidenceDigest,
      })
      if (verified.state !== 'VERIFIED_PENDING_LEDGER') return toPublicAttempt(verified)
      return toPublicAttempt(await postConfirmedCollection(repository, itcFinanceClient, {
        ...attempt,
        ...verified,
        provider_evidence_digest: verified.provider_evidence_digest || evidenceDigest,
      }))
    },

    async getReceipt(token, attemptId) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(token) || !UUID.test(String(attemptId || ''))) {
        throw new PaymentLinkError('PAYMENT_RECEIPT_NOT_AVAILABLE', 404)
      }
      const attempt = await repository.getPublicAttempt(sha256(token), attemptId)
      if (!attempt || attempt.public_token_hash !== sha256(token) ||
          String(attempt.attempt_id).toLowerCase() !== String(attemptId).toLowerCase() ||
          attempt.state !== 'SUCCEEDED' || !UUID.test(String(attempt.ledger_operation_id || '')) ||
          !UUID.test(String(attempt.attempt_id || '')) || !AMOUNT.test(String(attempt.amount || '')) ||
          attempt.currency !== 'ZMW' || !(attempt.network_label || RECEIPT_NETWORKS[attempt.network_code]) ||
          !/^\d{7,15}$/.test(String(attempt.payer_phone || '')) || !Number.isFinite(Date.parse(attempt.verified_at)) ||
          typeof attempt.description !== 'string' || attempt.description.length > 240) {
        throw new PaymentLinkError('PAYMENT_RECEIPT_NOT_AVAILABLE', 404)
      }
      const pdf = await createPaymentReceiptPdf({
        amount: attempt.amount,
        currency: attempt.currency,
        description: attempt.description,
        network: attempt.network_label || RECEIPT_NETWORKS[attempt.network_code],
        phoneLast4: attempt.payer_phone.slice(-4),
        paidAt: new Date(attempt.verified_at).toISOString(),
        reference: attempt.attempt_id,
      })
      return { pdf, filename: `expense-warrior-receipt-${attempt.attempt_id}.pdf` }
    },
  })
}

async function postConfirmedCollection(repository, itcFinanceClient, attempt) {
  if (!itcFinanceClient || !UUID.test(String(attempt.created_by_customer_id || '')) ||
      !UUID.test(String(attempt.payment_link_id || '')) || !UUID.test(String(attempt.attempt_id || '')) ||
      !UUID.test(String(attempt.provider_transaction_id || '')) || !/^[a-f0-9]{64}$/.test(String(attempt.provider_evidence_digest || '')) ||
      !Number.isFinite(Date.parse(attempt.verified_at))) return attempt

  const payload = {
    operation_id: attempt.attempt_id,
    payment_link_id: attempt.payment_link_id,
    collection_attempt_id: attempt.attempt_id,
    actor_customer_id: attempt.created_by_customer_id,
    provider_code: attempt.provider_code,
    provider_account_id: attempt.provider_account_id || null,
    provider_account_version: attempt.provider_account_version || null,
    provider_transaction_id: attempt.provider_transaction_id,
    provider_reference: attempt.provider_reference || attempt.provider_transaction_id,
    amount: attempt.amount,
    currency: attempt.currency,
    verified_at: new Date(attempt.verified_at).toISOString(),
    evidence_digest: attempt.provider_evidence_digest,
  }
  const idempotencyKey = `ew-collect-${sha256(`${String(attempt.provider_code).toLowerCase()}:${attempt.provider_transaction_id.toLowerCase()}`)}`
  let result
  try {
    if (attempt.collection_target_type === 'REVENUE' && /^\d{4}$/.test(String(attempt.revenue_account_code || ''))) {
      result = await itcFinanceClient.postEarnedRevenueCollection({
        ...payload, target: { type: 'REVENUE', revenue_account_code: attempt.revenue_account_code },
      }, idempotencyKey)
    } else if (attempt.collection_target_type === 'CUSTOMER_CREDIT' && UUID.test(String(attempt.customer_id || ''))) {
      result = await itcFinanceClient.creditCustomerAccount({
        ...payload, target: { type: 'CUSTOMER_CREDIT', customer_id: attempt.customer_id },
      }, idempotencyKey)
    } else if (attempt.collection_target_type === 'AR_SETTLEMENT' &&
        UUID.test(String(attempt.customer_id || '')) && UUID.test(String(attempt.receivable_id || '')) &&
        UUID.test(String(attempt.receivable_reservation_id || attempt.attempt_id)) && attempt.receivable_reservation_state === 'ACTIVE') {
      result = await itcFinanceClient.applyCustomerReceivablePayment({
        ...payload, target: {
          type: 'AR_SETTLEMENT', customer_id: attempt.customer_id,
          receivable_id: attempt.receivable_id, reservation_id: attempt.receivable_reservation_id || attempt.attempt_id,
        },
      }, idempotencyKey)
    } else {
      return attempt
    }
  } catch (_error) {
    return attempt
  }
  const operationId = result?.operation?.operation_id
  if (!UUID.test(String(operationId || ''))) return attempt
  return repository.markAttemptSucceeded(attempt.attempt_id, operationId)
}

module.exports = { createPublicPaymentService, toPublicAttempt, postConfirmedCollection }
