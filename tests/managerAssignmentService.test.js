const test = require('node:test')
const assert = require('node:assert/strict')
const { createManagerAssignmentService } = require('../src/managerAssignments/managerAssignmentService')

const admin = { customerId: 'f437d2e8-b1dd-4e68-9e73-457889e17dbd', role: 'admin', active: true }
const staffId = '45a79d36-1c70-4622-84d2-145a26f288d3'
const managerId = '8c1e1275-0a6d-4e0e-9176-3f6d46ab9986'
const assignmentId = '478d27bf-d574-488d-a347-7f5a87e3b11c'

function repo(methods = {}) {
  return {
    list: async () => [],
    assign: async () => ({ assignment_id: assignmentId }),
    end: async () => null,
    ...methods,
  }
}

test('assignManager_rejectsNonAdminBeforeRepositoryCall', async () => {
  let called = false
  const service = createManagerAssignmentService({ repository: repo({ assign: async () => { called = true } }) })
  await assert.rejects(service.assign({ ...admin, role: 'staff' }, staffId, managerId), (error) => error.code === 'FORBIDDEN')
  assert.equal(called, false)
})

test('assignManager_rejectsSelfAssignmentBeforeRepositoryCall', async () => {
  let called = false
  const service = createManagerAssignmentService({ repository: repo({ assign: async () => { called = true } }) })
  await assert.rejects(service.assign(admin, staffId, staffId), (error) => error.code === 'INVALID_ASSIGNMENT')
  assert.equal(called, false)
})

test('assignManager_sendsAdminActorAndValidatedIdsToRepository', async () => {
  let input
  const service = createManagerAssignmentService({ repository: repo({ assign: async (value) => { input = value; return { assignment_id: assignmentId } } }) })
  const result = await service.assign(admin, staffId, managerId)
  assert.deepEqual(input, { actorId: admin.customerId, staffId, managerId })
  assert.equal(result.assignment_id, assignmentId)
})

test('assignManager_rejectsSelfAssignmentRegardlessOfUuidLetterCase', async () => {
  const upperCaseStaffId = staffId.toUpperCase()
  const service = createManagerAssignmentService({ repository: repo({ assign: async () => assert.fail('repository should not be called') }) })
  await assert.rejects(service.assign(admin, staffId, upperCaseStaffId), (error) => error.code === 'INVALID_ASSIGNMENT')
})
