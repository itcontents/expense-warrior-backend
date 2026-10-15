const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class ManagerAssignmentError extends Error {
  constructor(code, statusCode) {
    super(code)
    this.name = 'ManagerAssignmentError'
    this.code = code
    this.statusCode = statusCode
  }
}

function assertAdmin(actor) {
  if (!actor?.active || !UUID_PATTERN.test(String(actor.customerId || ''))) {
    throw new ManagerAssignmentError('AUTHENTICATION_REQUIRED', 401)
  }
  if (String(actor.role || '').toLowerCase() !== 'admin') {
    throw new ManagerAssignmentError('FORBIDDEN', 403)
  }
}

function createManagerAssignmentService({ repository } = {}) {
  if (!repository || typeof repository.list !== 'function' || typeof repository.assign !== 'function' || typeof repository.end !== 'function') {
    throw new TypeError('A manager assignment repository is required')
  }
  return Object.freeze({
    async list(actor) {
      assertAdmin(actor)
      return repository.list()
    },
    async assign(actor, staffId, managerId) {
      assertAdmin(actor)
      const normalizedStaffId = String(staffId || '').toLowerCase()
      const normalizedManagerId = String(managerId || '').toLowerCase()
      if (!UUID_PATTERN.test(normalizedStaffId) || !UUID_PATTERN.test(normalizedManagerId) || normalizedStaffId === normalizedManagerId) {
        throw new ManagerAssignmentError('INVALID_ASSIGNMENT', 400)
      }
      return repository.assign({ actorId: actor.customerId, staffId: normalizedStaffId, managerId: normalizedManagerId })
    },
    async end(actor, assignmentId) {
      assertAdmin(actor)
      if (!UUID_PATTERN.test(String(assignmentId || ''))) throw new ManagerAssignmentError('INVALID_ASSIGNMENT', 400)
      const assignment = await repository.end({ actorId: actor.customerId, assignmentId })
      if (!assignment) throw new ManagerAssignmentError('ASSIGNMENT_NOT_FOUND', 404)
      return assignment
    },
  })
}

module.exports = { createManagerAssignmentService, ManagerAssignmentError }
