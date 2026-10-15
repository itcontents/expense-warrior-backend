const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NETWORKS = new Set(['AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB'])

class PayoutDestinationError extends Error {
  constructor(code, statusCode) {
    super(code)
    this.name = 'PayoutDestinationError'
    this.code = code
    this.statusCode = statusCode
  }
}

function assertActor(actor, admin = false) {
  if (!actor?.active || !UUID_PATTERN.test(String(actor.customerId || ''))) throw new PayoutDestinationError('AUTHENTICATION_REQUIRED', 401)
  if (admin && String(actor.role || '').toLowerCase() !== 'admin') throw new PayoutDestinationError('FORBIDDEN', 403)
}

function createPayoutDestinationService({ repository, phoneVault } = {}) {
  if (!repository || !phoneVault || typeof repository.assign !== 'function') throw new TypeError('Payout destination dependencies are required')
  return Object.freeze({
    async assign(actor, staffId, networkCode, phone) {
      assertActor(actor, true)
      const normalizedStaffId = String(staffId || '').toLowerCase()
      if (!UUID_PATTERN.test(normalizedStaffId) || !NETWORKS.has(networkCode)) throw new PayoutDestinationError('INVALID_PAYOUT_DESTINATION', 400)
      let normalizedPhone
      try { normalizedPhone = require('./phoneVault').normalizeZambiaPhone(phone) } catch { throw new PayoutDestinationError('INVALID_PAYOUT_PHONE', 422) }
      const encrypted = phoneVault.encrypt({ staffId: normalizedStaffId, phone: normalizedPhone })
      const fingerprint = phoneVault.fingerprint({ staffId: normalizedStaffId, phone: normalizedPhone })
      return repository.assign({
        actorId: actor.customerId,
        staffId: normalizedStaffId,
        networkCode,
        encrypted,
        fingerprint,
        last4: normalizedPhone.slice(-4),
      })
    },
    async list(actor) {
      assertActor(actor, true)
      return repository.listCurrent()
    },
    async getMine(actor) {
      assertActor(actor)
      if (!['staff', 'admin'].includes(String(actor.role || '').toLowerCase())) throw new PayoutDestinationError('FORBIDDEN', 403)
      return repository.getCurrentForStaff(String(actor.customerId).toLowerCase())
    },
  })
}

module.exports = { createPayoutDestinationService, PayoutDestinationError }
