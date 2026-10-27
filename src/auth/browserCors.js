const { isAllowedBrowserOrigin } = require('./cookieCsrfGuard')

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOWED_HEADERS = new Set([
  'accept', 'content-type', 'idempotency-key', 'x-request-id',
  'x-requested-with', 'x-session-audience', 'x-session-response',
])
const EXPOSED_HEADERS = 'Content-Disposition, X-Report-Row-Count, X-Request-Id'

function createBrowserCors({ allowedOrigins = [], nodeEnv = process.env.NODE_ENV || 'development' } = {}) {
  const trustedOrigins = new Set(allowedOrigins)

  return function browserCors(req, res, next) {
    const origin = req.headers?.origin
    if (!origin) return next()
    if (!isAllowedBrowserOrigin(origin, trustedOrigins, nodeEnv)) {
      return res.status(403).json({
        error: { code: 'BROWSER_ORIGIN_DENIED', message: 'Request origin validation failed' },
      })
    }

    res.vary('Origin')
    res.set('Access-Control-Allow-Origin', new URL(origin).origin)
    res.set('Access-Control-Allow-Credentials', 'true')
    res.set('Access-Control-Expose-Headers', EXPOSED_HEADERS)

    if (String(req.method || '').toUpperCase() !== 'OPTIONS') return next()

    const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase()
    const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
      .split(',').map((header) => header.trim().toLowerCase()).filter(Boolean)
    if (!ALLOWED_METHODS.split(', ').includes(requestedMethod) ||
        requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
      return res.status(403).end()
    }

    res.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
    res.set('Access-Control-Allow-Headers', [...ALLOWED_HEADERS].join(', '))
    res.set('Access-Control-Max-Age', '600')
    return res.status(204).end()
  }
}

module.exports = { createBrowserCors }
