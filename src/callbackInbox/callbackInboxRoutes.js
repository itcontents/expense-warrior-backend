const express = require('express')
const { CallbackInboxError } = require('./callbackInboxService')

const CALLBACK_PATH = '/api/v1/expense-warrior/providers/pawapay/callbacks'
const MAX_CALLBACK_BYTES = 65536

function createCallbackInboxRouter({ callbackService } = {}) {
  if (!callbackService || typeof callbackService.receive !== 'function') throw new TypeError('A callback inbox service is required')
  const router = express.Router()
  const rawJson = express.raw({ type: 'application/json', limit: MAX_CALLBACK_BYTES, inflate: false })

  for (const transactionType of ['deposit', 'payout']) {
    router.post(`/${transactionType}`, rawJson, async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: { code: 'CALLBACK_CONTENT_TYPE_INVALID', message: 'Callback must use application/json' } })
      }
      try {
        const result = await callbackService.receive({
          transactionType,
          rawBody: req.body,
          headers: req.headers,
          requestContext: {
            method: req.method,
            authority: req.get('host'),
            originalUrl: req.originalUrl,
            url: req.url,
          },
        })
        return res.status(200).json({ accepted: true, duplicate: result.duplicate })
      } catch (error) {
        if (error instanceof CallbackInboxError) {
          return res.status(error.statusCode).json({ error: { code: error.code, message: 'Callback could not be accepted' } })
        }
        return res.status(503).json({ error: { code: 'CALLBACK_INBOX_UNAVAILABLE', message: 'Callback could not be accepted' } })
      }
    })
  }
  return router
}

module.exports = { createCallbackInboxRouter, CALLBACK_PATH, MAX_CALLBACK_BYTES }
