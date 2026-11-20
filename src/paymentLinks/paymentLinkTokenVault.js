const crypto = require('node:crypto')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/
const TOKEN = /^[A-Za-z0-9_-]{40,128}$/

class PaymentLinkTokenVaultError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PaymentLinkTokenVaultError'
    this.code = code
  }
}

function decodeKey(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const key = Buffer.from(value, 'base64')
  return key.length === 32 && key.toString('base64') === value ? key : null
}

function createPaymentLinkTokenVault({ keysJson, activeKeyId } = {}) {
  let source
  try { source = JSON.parse(keysJson || '{}') } catch { throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_KEY_CONFIG_INVALID') }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_KEY_CONFIG_INVALID')
  const keys = new Map()
  for (const [keyId, encoded] of Object.entries(source)) {
    const key = decodeKey(encoded)
    if (!KEY_ID.test(keyId) || !key) throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_KEY_CONFIG_INVALID')
    keys.set(keyId, key)
  }
  if (keys.size && (!KEY_ID.test(String(activeKeyId || '')) || !keys.has(activeKeyId))) {
    throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_KEY_CONFIG_INVALID')
  }

  function keyFor(keyId, required = false) {
    const masterKey = keys.get(keyId)
    if (!masterKey) {
      if (required) throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_KEY_UNAVAILABLE')
      return null
    }
    return Buffer.from(crypto.hkdfSync(
      'sha256', masterKey, Buffer.from('expense-warrior-key-derivation-v1'),
      Buffer.from(`payment-link-token:${keyId}`), 32,
    ))
  }

  function aad(linkId) {
    if (!UUID.test(String(linkId || ''))) throw new PaymentLinkTokenVaultError('INVALID_PAYMENT_LINK')
    return Buffer.from(`expense-warrior:payment-link-token:${String(linkId).toLowerCase()}`)
  }

  return Object.freeze({
    encrypt({ linkId, token }) {
      if (!TOKEN.test(String(token || ''))) throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_INVALID')
      const key = keyFor(activeKeyId, true)
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad(linkId))
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
      return {
        keyId: activeKeyId,
        ciphertext: [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.'),
      }
    },
    decrypt({ linkId, keyId, ciphertext }) {
      const key = keyFor(keyId, true)
      try {
        const [ivEncoded, tagEncoded, dataEncoded, extra] = String(ciphertext || '').split('.')
        if (!ivEncoded || !tagEncoded || !dataEncoded || extra !== undefined) throw new Error('Invalid token envelope')
        const iv = Buffer.from(ivEncoded, 'base64url')
        const tag = Buffer.from(tagEncoded, 'base64url')
        const data = Buffer.from(dataEncoded, 'base64url')
        if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('Invalid token envelope')
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(aad(linkId))
        decipher.setAuthTag(tag)
        const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
        if (!TOKEN.test(token)) throw new Error('Invalid token')
        return token
      } catch {
        throw new PaymentLinkTokenVaultError('PAYMENT_LINK_TOKEN_CIPHERTEXT_INVALID')
      }
    },
  })
}

module.exports = { createPaymentLinkTokenVault, PaymentLinkTokenVaultError }
