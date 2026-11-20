const crypto = require('node:crypto')

const AMOUNT = /^(?:0|[1-9]\d{0,11})\.\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPositiveAmount(amount) {
  if (!AMOUNT.test(amount || '')) return false
  const [whole, fraction] = amount.split('.')
  return BigInt(whole) * 100n + BigInt(fraction) > 0n
}

function normalizeCollectionTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new PaymentLinkError('PAYMENT_LINK_TARGET_INVALID', 400)
  const keys = Object.keys(target).sort().join(',')
  if (target.type === 'REVENUE' && keys === 'revenue_account_code,type' && /^\d{4}$/.test(String(target.revenue_account_code || ''))) {
    return { type: target.type, revenueAccountCode: target.revenue_account_code }
  }
  if (target.type === 'CUSTOMER_CREDIT' && keys === 'customer_id,type' && UUID.test(String(target.customer_id || ''))) {
    return { type: target.type, customerId: target.customer_id.toLowerCase() }
  }
  throw new PaymentLinkError('PAYMENT_LINK_TARGET_INVALID', 400)
}

class PaymentLinkError extends Error {
  constructor(code, statusCode = 503, options = {}) {
    super(code, options)
    this.code = code
    this.statusCode = statusCode
    this.operation = options.operation || null
  }
}

function createPaymentLinkService({ repository, tokenVault, hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex') } = {}) {
  if (!repository) throw new TypeError('A payment-link repository is required')
  return Object.freeze({
    async createLink(actor, input, idempotencyKey) {
      const target = normalizeCollectionTarget(input?.target)
      if (!isPositiveAmount(input?.amount) ||
          typeof input.description !== 'string' || input.description.trim().length < 1 || input.description.trim().length > 240 ||
          !UUID.test(String(actor?.customerId || '')) || !UUID.test(String(idempotencyKey || '')) ||
          typeof input.publicToken !== 'string' || input.publicToken.length < 40 || input.publicToken.length > 128 || !/^[A-Za-z0-9_-]+$/.test(input.publicToken)) throw new PaymentLinkError('PAYMENT_LINK_INPUT_INVALID', 400)
      const tokenHash = hashToken(input.publicToken)
      if (!tokenVault || typeof tokenVault.encrypt !== 'function') throw new PaymentLinkError('PAYMENT_LINK_TOKEN_VAULT_UNAVAILABLE')
      const paymentLinkId = crypto.randomUUID()
      const encryptedToken = tokenVault.encrypt({ linkId: paymentLinkId, token: input.publicToken })
      const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify([
        input.amount,
        input.description.trim(),
        target.type,
        target.revenueAccountCode || null,
        target.customerId || null,
        tokenHash,
      ])).digest('hex')
      const result = await repository.create({
        amount: input.amount,
        description: input.description.trim(),
        target,
        paymentLinkId,
        tokenHash,
        tokenCiphertext: encryptedToken.ciphertext,
        tokenEncryptionKeyId: encryptedToken.keyId,
        idempotencyKey,
        requestFingerprint,
        actorCustomerId: actor.customerId,
      })
      return { link: result.link || result, token: input.publicToken, replayed: Boolean(result.replayed) }
    },
    listLinks(options) { return repository.list(options) },
    async getLinkToken(linkId, actor) {
      if (!UUID.test(String(linkId || '')) || !UUID.test(String(actor?.customerId || ''))) throw new PaymentLinkError('PAYMENT_LINK_INPUT_INVALID', 400)
      if (!tokenVault || typeof tokenVault.decrypt !== 'function') throw new PaymentLinkError('PAYMENT_LINK_TOKEN_VAULT_UNAVAILABLE')
      const stored = await repository.getToken(linkId, actor.customerId)
      return { link: stored.link, token: tokenVault.decrypt({ linkId, keyId: stored.keyId, ciphertext: stored.ciphertext }) }
    },
    async replaceLinkToken(linkId, actor) {
      if (!UUID.test(String(linkId || '')) || !UUID.test(String(actor?.customerId || ''))) throw new PaymentLinkError('PAYMENT_LINK_INPUT_INVALID', 400)
      if (!tokenVault || typeof tokenVault.encrypt !== 'function') throw new PaymentLinkError('PAYMENT_LINK_TOKEN_VAULT_UNAVAILABLE')
      const token = crypto.randomBytes(32).toString('base64url')
      const encryptedToken = tokenVault.encrypt({ linkId, token })
      const link = await repository.replaceToken(linkId, hashToken(token), encryptedToken.ciphertext, encryptedToken.keyId, actor.customerId)
      return { link, token }
    },
    disableLink(linkId, actor) {
      if (!UUID.test(String(linkId || '')) || !UUID.test(String(actor?.customerId || ''))) throw new PaymentLinkError('PAYMENT_LINK_INPUT_INVALID', 400)
      return repository.disable(linkId, actor.customerId)
    },
  })
}

module.exports = { createPaymentLinkService, PaymentLinkError, normalizeCollectionTarget }
