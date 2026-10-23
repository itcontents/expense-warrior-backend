const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequireItcSession } = require('../src/auth/requireItcSession')

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this },
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
  const req = { headers: { cookie: 'not_itc_expense_warrior_access=invalid; itc_expense_warrior_access_backup=invalid' }, requestId: 'req-lookalike' }
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
  const req = { headers: { cookie: 'itc_expense_warrior_access=valid' }, requestId: 'req-2' }
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
  const req = { headers: { cookie: 'itc_expense_warrior_access=valid' }, requestId: 'req-3' }
  const res = fakeResponse()
  let nextCalled = false

  await middleware(req, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body.error, { code: 'ITC_IDENTITY_UNAVAILABLE', message: 'Identity service is temporarily unavailable' })
  assert.equal(nextCalled, false)
})

test('requireItcSession_preservesRateLimitAsRetryableWithoutExposingUpstreamBody', async () => {
  const middleware = createRequireItcSession({
    getSession: async () => {
      const error = new Error('upstream response body must not be exposed')
      error.statusCode = 429
      error.retryAfterSeconds = 37
      throw error
    },
  })
  const req = { headers: { cookie: 'itc_expense_warrior_access=valid' }, requestId: 'req-limited' }
  const res = fakeResponse()

  await middleware(req, res, () => assert.fail('rate-limited request must not continue'))

  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['retry-after'], '37')
  assert.deepEqual(res.body, { error: {
    code: 'ITC_IDENTITY_RATE_LIMITED',
    message: 'Too many requests right now. Wait a moment, then try again.',
    retry_after_seconds: 37,
  } })
})
