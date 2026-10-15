const test = require('node:test')
const assert = require('node:assert/strict')
const { createPhoneVault, normalizeZambiaPhone, PhoneVaultError } = require('../src/payoutDestinations/phoneVault')

const key1 = Buffer.alloc(32, 1).toString('base64')
const key2 = Buffer.alloc(32, 2).toString('base64')
const staffId = '26000000-0000-4000-8000-000000000001'

test('normalizes accepted Zambia international and local number forms', () => {
  assert.equal(normalizeZambiaPhone('+260 957 909 783'), '260957909783')
  assert.equal(normalizeZambiaPhone('0977-909-783'), '260977909783')
  assert.throws(() => normalizeZambiaPhone('26095790'), PhoneVaultError)
  assert.throws(() => normalizeZambiaPhone('0977909783 ext 12'), PhoneVaultError)
})

test('encrypts a phone with the active key and binds ciphertext to its staff identity', () => {
  const vault = createPhoneVault({ keysJson: JSON.stringify({ k1: key1 }), activeKeyId: 'k1' })
  const encrypted = vault.encrypt({ staffId, phone: '260957909783' })
  assert.equal(encrypted.keyId, 'k1')
  assert.equal(encrypted.ciphertext.includes('260957909783'), false)
  assert.equal(vault.decrypt({ staffId, keyId: encrypted.keyId, ciphertext: encrypted.ciphertext }), '260957909783')
  assert.throws(() => vault.decrypt({ staffId: '26000000-0000-4000-8000-000000000002', keyId: encrypted.keyId, ciphertext: encrypted.ciphertext }), { code: 'PAYOUT_CIPHERTEXT_INVALID' })
})

test('old destinations remain decryptable after adding a rotated active key', () => {
  const oldVault = createPhoneVault({ keysJson: JSON.stringify({ k1: key1 }), activeKeyId: 'k1' })
  const encrypted = oldVault.encrypt({ staffId, phone: '260957909783' })
  const rotated = createPhoneVault({ keysJson: JSON.stringify({ k1: key1, k2: key2 }), activeKeyId: 'k2' })
  assert.equal(rotated.decrypt({ staffId, keyId: encrypted.keyId, ciphertext: encrypted.ciphertext }), '260957909783')
  assert.notEqual(rotated.fingerprint({ staffId, phone: '260957909783' }), oldVault.fingerprint({ staffId, phone: '260957909783' }))
})

test('missing or malformed key configuration fails closed', () => {
  assert.throws(() => createPhoneVault({ keysJson: '', activeKeyId: '' }).encrypt({ staffId, phone: '260957909783' }), { code: 'PAYOUT_ENCRYPTION_UNAVAILABLE' })
  assert.throws(() => createPhoneVault({ keysJson: JSON.stringify({ k1: 'bad' }), activeKeyId: 'k1' }), PhoneVaultError)
  assert.throws(() => createPhoneVault({ keysJson: JSON.stringify({ k1: key1 }), activeKeyId: 'missing' }), PhoneVaultError)
})

test('fingerprints reject malformed staff identity values', () => {
  const vault = createPhoneVault({ keysJson: JSON.stringify({ k1: key1 }), activeKeyId: 'k1' })
  assert.throws(() => vault.fingerprint({ staffId: 'not-a-uuid', phone: '260957909783' }), { code: 'INVALID_STAFF_ID' })
})
