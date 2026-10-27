const test = require('node:test')
const assert = require('node:assert/strict')
const { createBrowserCors } = require('../src/auth/browserCors')

function runCors(cors, { method = 'GET', origin, headers = {} } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    vary(value) { this.headers.vary = value },
    set(name, value) { this.headers[name.toLowerCase()] = value },
    status(code) { this.statusCode = code; return this },
    end() { return this },
    json(value) { this.body = value; return this },
  }
  let continued = false
  cors({ method, headers: { ...headers, ...(origin ? { origin } : {}) } }, response, () => { continued = true })
  return { response, continued }
}

test('browser CORS allows only exact trusted origins with credentialed cookie access', () => {
  const cors = createBrowserCors({ allowedOrigins: ['https://expense.itcontents.com'], nodeEnv: 'production' })
  const { response, continued } = runCors(cors, { origin: 'https://expense.itcontents.com' })
  assert.equal(continued, true)
  assert.equal(response.headers['access-control-allow-origin'], 'https://expense.itcontents.com')
  assert.equal(response.headers['access-control-allow-credentials'], 'true')
  assert.match(response.headers['access-control-expose-headers'], /Content-Disposition/)
  assert.equal(response.headers.vary, 'Origin')
})

test('browser CORS rejects untrusted and wildcard origins', () => {
  const cors = createBrowserCors({ allowedOrigins: ['https://expense.itcontents.com'], nodeEnv: 'production' })
  for (const origin of ['https://evil.example', '*']) {
    const { response, continued } = runCors(cors, { origin })
    assert.equal(continued, false)
    assert.equal(response.statusCode, 403)
    assert.equal(response.headers['access-control-allow-origin'], undefined)
  }
})

test('browser CORS handles the cookie and upload preflight headers', () => {
  const cors = createBrowserCors({ allowedOrigins: ['https://expense.itcontents.com'], nodeEnv: 'production' })
  const { response, continued } = runCors(cors, {
    method: 'OPTIONS',
    origin: 'https://expense.itcontents.com',
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-requested-with, x-request-id, idempotency-key',
    },
  })
  assert.equal(continued, false)
  assert.equal(response.statusCode, 204)
  assert.match(response.headers['access-control-allow-headers'], /x-requested-with/i)
})

test('browser CORS rejects unsupported preflight methods and headers', () => {
  const cors = createBrowserCors({ allowedOrigins: ['https://expense.itcontents.com'], nodeEnv: 'production' })
  for (const headers of [
    { 'access-control-request-method': 'TRACE' },
    { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
  ]) {
    const { response, continued } = runCors(cors, { method: 'OPTIONS', origin: 'https://expense.itcontents.com', headers })
    assert.equal(continued, false)
    assert.equal(response.statusCode, 403)
  }
})
