const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { ManagerAssignmentError } = require('./managerAssignmentService')
const { ManagerAssignmentRepositoryError } = require('./managerAssignmentRepository')
const { ItcIdentityError } = require('../integrations/itc/ItcIdentityClient')

const assignmentSchema = Joi.object({
  staff_customer_id: Joi.string().guid().required(),
  manager_customer_id: Joi.string().guid().required(),
}).unknown(false)
const candidatesSchema = Joi.object({
  search: Joi.string().max(100).allow('').default(''),
  limit: Joi.number().integer().min(1).max(50).default(50),
  offset: Joi.number().integer().min(0).max(1000000).default(0),
}).unknown(false)

function createManagerAssignmentRouter({ identityClient, assignmentService }) {
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  const respondError = (res, error) => {
    if (error instanceof ManagerAssignmentError || error instanceof ManagerAssignmentRepositoryError) {
      return res.status(error.statusCode).json({ error: { code: error.code, message: error.code.replaceAll('_', ' ').toLowerCase() } })
    }
    if (error instanceof ItcIdentityError) {
      return res.status(error.statusCode).json({ error: { code: error.code, message: 'Staff directory is temporarily unavailable' } })
    }
    return res.status(503).json({ error: { code: 'MANAGER_ASSIGNMENTS_UNAVAILABLE', message: 'Manager assignments are temporarily unavailable' } })
  }

  router.get('/manager-assignments', requireSession, async (req, res) => {
    try {
      const data = await assignmentService.list(req.actor)
      const ids = [...new Set((data.items || []).flatMap((item) => [item.staff_customer_id, item.manager_customer_id]))]
      if (ids.length && typeof identityClient.listStaffDirectory === 'function') {
        try {
          const batches = await Promise.all(Array.from({ length: Math.ceil(ids.length / 500) }, (_, index) => {
            const batch = ids.slice(index * 500, (index + 1) * 500)
            return identityClient.listStaffDirectory(req.headers.cookie, { ids: batch, limit: batch.length, offset: 0 }, req.requestId)
          }))
          const people = new Map(batches.flat().map((person) => [String(person.customer_id).toLowerCase(), person]))
          data.items = data.items.map((item) => ({
            ...item,
            staff_member: people.get(String(item.staff_customer_id).toLowerCase()) || null,
            manager: people.get(String(item.manager_customer_id).toLowerCase()) || null,
          }))
        } catch (_directoryError) {
          // Assignment history remains available by ID while ITC directory names are unavailable.
        }
      }
      return res.status(200).json({ data })
    } catch (error) {
      return respondError(res, error)
    }
  })

  router.get('/manager-candidates', requireSession, async (req, res) => {
    if (String(req.actor.role).toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    const { value, error } = candidatesSchema.validate(req.query, { abortEarly: false, convert: true })
    if (error) return res.status(400).json({ error: { code: 'INVALID_STAFF_DIRECTORY_FILTER', message: 'The staff search filters are invalid' } })
    try {
      if (typeof identityClient.listStaffDirectory !== 'function') throw new Error('ITC staff directory is unavailable')
      const items = await identityClient.listStaffDirectory(req.headers.cookie, value, req.requestId)
      return res.status(200).json({ data: { items } })
    } catch (cause) {
      return respondError(res, cause)
    }
  })

  router.post('/manager-assignments', requireSession, async (req, res) => {
    if (String(req.actor.role).toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    const { value, error } = assignmentSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_ASSIGNMENT', message: 'Provide valid staff and manager accounts' } })
    if (value.staff_customer_id.toLowerCase() === value.manager_customer_id.toLowerCase()) {
      return res.status(422).json({ error: { code: 'SELF_ASSIGNMENT_PROHIBITED', message: 'A staff member cannot be their own manager' } })
    }
    try {
      const eligible = await identityClient.listStaffDirectory(req.headers.cookie, {
        ids: [value.staff_customer_id, value.manager_customer_id], limit: 50, offset: 0,
      }, req.requestId)
      const eligibleIds = new Set(eligible.map((person) => String(person.customer_id).toLowerCase()))
      if (!eligibleIds.has(value.staff_customer_id.toLowerCase()) || !eligibleIds.has(value.manager_customer_id.toLowerCase())) {
        return res.status(422).json({ error: { code: 'ASSIGNMENT_CANDIDATE_UNAVAILABLE', message: 'Choose two active company staff accounts' } })
      }
      const assignment = await assignmentService.assign(req.actor, value.staff_customer_id, value.manager_customer_id)
      return res.status(200).json({ data: { assignment } })
    } catch (cause) {
      return respondError(res, cause)
    }
  })

  router.post('/manager-assignments/:assignment_id/end', requireSession, async (req, res) => {
    try {
      const assignment = await assignmentService.end(req.actor, req.params.assignment_id)
      return res.status(200).json({ data: { assignment } })
    } catch (cause) {
      return respondError(res, cause)
    }
  })

  return router
}

module.exports = { createManagerAssignmentRouter }
