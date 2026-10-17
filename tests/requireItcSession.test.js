const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequireItcSession } = require('../src/auth/requireItcSession')

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('requireItcSession_rejectsMissingBackofficeCookie', async () => {
  let called = false
  const middleware = createRequireItcSession({ getSession: async () => { called = true } })
  const req = { headers: {}, requestId: 'req-1' }
  const res = fakeResponse()
  let nextCalled = false

  await middleware(req, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 401)
  assert.equal(called, false)
  assert.equal(nextCalled, false)
})

test('requireItcSession_rejectsLookalikeCookieNames', async () => {
  let called = false
  const middleware = createRequireItcSession({ getSession: async () => { called = true } })
  const req = { headers: { cookie: 'not_itc_backoffice_access=invalid; itc_backoffice_access_backup=invalid' }, requestId: 'req-lookalike' }
  const res = fakeResponse()
  let nextCalled = false

  await middleware(req, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 401)
  assert.equal(called, false)
  assert.equal(nextCalled, false)
})

test('requireItcSession_setsOnlyVerifiedItcActor', async () => {
  const middleware = createRequireItcSession({
    getSession: async () => ({ customerId: 'staff-1', role: 'staff', active: true }),
  })
  const req = { headers: { cookie: 'itc_backoffice_access=valid' }, requestId: 'req-2' }
  const res = fakeResponse()
  let nextCalled = false

  await middleware(req, res, () => { nextCalled = true })

  assert.equal(nextCalled, true)
  assert.deepEqual(req.actor, { customerId: 'staff-1', role: 'staff', active: true })
})

test('requireItcSession_failsClosedWhenItcIsUnavailable', async () => {
  const middleware = createRequireItcSession({
    getSession: async () => { const error = new Error('offline'); error.statusCode = 503; throw error },
  })
  const req = { headers: { cookie: 'itc_backoffice_access=valid' }, requestId: 'req-3' }
  const res = fakeResponse()
  let nextCalled = false

  await middleware(req, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body.error, { code: 'ITC_IDENTITY_UNAVAILABLE', message: 'Identity service is temporarily unavailable' })
  assert.equal(nextCalled, false)
})
