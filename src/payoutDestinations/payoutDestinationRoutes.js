const express = require('express')
const Joi = require('joi')
const { createRequireItcSession } = require('../auth/requireItcSession')
const { ItcIdentityError } = require('../integrations/itc/ItcIdentityClient')
const { PayoutDestinationError } = require('./payoutDestinationService')
const { PayoutDestinationRepositoryError } = require('./payoutDestinationRepository')

const assignmentSchema = Joi.object({
  network_code: Joi.string().valid('AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB').required(),
  phone_number: Joi.string().trim().min(9).max(20).required(),
}).unknown(false)

function createPayoutDestinationRouter({ identityClient, destinationService }) {
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)
  const respondError = (res, error) => {
    if (error instanceof PayoutDestinationError || error instanceof PayoutDestinationRepositoryError || error instanceof ItcIdentityError) {
      return res.status(error.statusCode || 503).json({ error: { code: error.code, message: 'Payout destination request could not be completed' } })
    }
    return res.status(503).json({ error: { code: 'PAYOUT_DESTINATIONS_UNAVAILABLE', message: 'Payout destinations are temporarily unavailable' } })
  }
  const requireAdmin = (req, res, next) => String(req.actor?.role || '').toLowerCase() === 'admin'
    ? next()
    : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })

  router.get('/admin/payout-destinations', requireSession, requireAdmin, async (_req, res) => {
    try { return res.status(200).json({ data: { items: await destinationService.list(_req.actor) } }) } catch (error) { return respondError(res, error) }
  })
  router.put('/admin/payout-destinations/:staff_customer_id', requireSession, requireAdmin, async (req, res) => {
    const { value, error } = assignmentSchema.validate(req.body, { abortEarly: false, convert: true })
    const staffIdValidation = Joi.string().guid().validate(req.params.staff_customer_id)
    if (error || staffIdValidation.error) {
      return res.status(400).json({ error: { code: 'INVALID_PAYOUT_DESTINATION', message: 'Provide a valid staff member, network and Zambia phone number' } })
    }
    try {
      const eligible = await identityClient.listStaffDirectory(req.headers.cookie, { ids: [req.params.staff_customer_id], limit: 1, offset: 0 }, req.requestId)
      if (!eligible.some((person) => person.customer_id.toLowerCase() === req.params.staff_customer_id.toLowerCase())) {
        return res.status(422).json({ error: { code: 'STAFF_NOT_ELIGIBLE', message: 'Choose an active company staff account' } })
      }
      const result = await destinationService.assign(req.actor, req.params.staff_customer_id, value.network_code, value.phone_number)
      return res.status(200).json({ data: result })
    } catch (cause) { return respondError(res, cause) }
  })
  router.get('/payout-destination/me', requireSession, async (req, res) => {
    try { return res.status(200).json({ data: { destination: await destinationService.getMine(req.actor) } }) } catch (error) { return respondError(res, error) }
  })
  return router
}

module.exports = { createPayoutDestinationRouter }
