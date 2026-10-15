const crypto = require('node:crypto')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

class PhoneVaultError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PhoneVaultError'
    this.code = code
  }
}

function decodeKey(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const key = Buffer.from(value, 'base64')
  return key.length === 32 && key.toString('base64') === value ? key : null
}

function normalizeZambiaPhone(value) {
  if (typeof value !== 'string') throw new PhoneVaultError('INVALID_PAYOUT_PHONE')
  let phone = value.trim().replace(/[\s()-]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (/^0[1-9]\d{8}$/.test(phone)) phone = `260${phone.slice(1)}`
  if (!/^260\d{9}$/.test(phone)) throw new PhoneVaultError('INVALID_PAYOUT_PHONE')
  return phone
}

function createPhoneVault({ keysJson, activeKeyId } = {}) {
  let source
  try { source = JSON.parse(keysJson || '{}') } catch { throw new PhoneVaultError('PAYOUT_ENCRYPTION_CONFIG_INVALID') }
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) {
    source = {}
  }
  const keys = new Map()
  for (const [keyId, encoded] of Object.entries(source)) {
    const key = decodeKey(encoded)
    if (!KEY_ID_PATTERN.test(keyId) || !key) throw new PhoneVaultError('PAYOUT_ENCRYPTION_CONFIG_INVALID')
    keys.set(keyId, key)
  }
  if (keys.size && (!KEY_ID_PATTERN.test(String(activeKeyId || '')) || !keys.has(activeKeyId))) {
    throw new PhoneVaultError('PAYOUT_ENCRYPTION_CONFIG_INVALID')
  }

  const requireActiveKey = () => {
    const key = keys.get(activeKeyId)
    if (!key) throw new PhoneVaultError('PAYOUT_ENCRYPTION_UNAVAILABLE')
    return key
  }
  const aadForStaff = (staffId) => {
    if (!UUID_PATTERN.test(String(staffId || ''))) throw new PhoneVaultError('INVALID_STAFF_ID')
    return Buffer.from(`expense-warrior:payout-destination:${String(staffId).toLowerCase()}`)
  }

  return Object.freeze({
    encrypt({ staffId, phone }) {
      const key = requireActiveKey()
      const normalized = normalizeZambiaPhone(phone)
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aadForStaff(staffId))
      const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
      return {
        keyId: activeKeyId,
        ciphertext: [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.'),
      }
    },
    decrypt({ staffId, keyId, ciphertext }) {
      const key = keys.get(keyId)
      if (!key || typeof ciphertext !== 'string') throw new PhoneVaultError('PAYOUT_ENCRYPTION_KEY_UNAVAILABLE')
      try {
        const [ivEncoded, tagEncoded, dataEncoded, extra] = ciphertext.split('.')
        if (!ivEncoded || !tagEncoded || !dataEncoded || extra !== undefined) throw new Error('bad envelope')
        const iv = Buffer.from(ivEncoded, 'base64url')
        const tag = Buffer.from(tagEncoded, 'base64url')
        const data = Buffer.from(dataEncoded, 'base64url')
        if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('bad envelope')
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(aadForStaff(staffId))
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
        return normalizeZambiaPhone(plaintext)
      } catch {
        throw new PhoneVaultError('PAYOUT_CIPHERTEXT_INVALID')
      }
    },
    fingerprint({ staffId, phone }) {
      const key = requireActiveKey()
      const normalized = normalizeZambiaPhone(phone)
      const normalizedStaffId = String(staffId || '').toLowerCase()
      if (!UUID_PATTERN.test(normalizedStaffId)) throw new PhoneVaultError('INVALID_STAFF_ID')
      const input = `expense-warrior:payout-destination:${normalizedStaffId}\n${normalized}`
      const fingerprintKey = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from('expense-warrior'), Buffer.from('payout-destination-fingerprint-v1'), 32))
      return crypto.createHmac('sha256', fingerprintKey).update(input).digest('hex')
    },
  })
}

module.exports = { createPhoneVault, normalizeZambiaPhone, PhoneVaultError }
