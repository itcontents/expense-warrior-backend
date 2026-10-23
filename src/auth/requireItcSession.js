const { hasBackofficeAccessCookie } = require('./cookieCsrfGuard')

function createRequireItcSession(identityClient) {
  if (!identityClient || typeof identityClient.getSession !== 'function') {
    throw new TypeError('An ITC identity client is required')
  }

  return async function requireItcSession(req, res, next) {
    if (!hasBackofficeAccessCookie(req.headers?.cookie)) {
      return res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue' },
      })
    }

    try {
      req.actor = await identityClient.getSession(req.headers.cookie, req.requestId)
      return next()
    } catch (error) {
      if (error.statusCode === 401) {
        return res.status(401).json({
          error: { code: 'SESSION_INVALID', message: 'Your session has expired. Sign in again.' },
        })
      }
      if (error.statusCode === 503) {
        return res.status(503).json({
          error: { code: 'ITC_IDENTITY_UNAVAILABLE', message: 'Identity service is temporarily unavailable' },
        })
      }
      if (error.statusCode === 429) {
        const retryAfterSeconds = Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 3600
          ? error.retryAfterSeconds
          : null
        if (retryAfterSeconds !== null) res.set('Retry-After', String(retryAfterSeconds))
        return res.status(429).json({
          error: {
            code: 'ITC_IDENTITY_RATE_LIMITED',
            message: 'Too many requests right now. Wait a moment, then try again.',
            ...(retryAfterSeconds !== null ? { retry_after_seconds: retryAfterSeconds } : {}),
          },
        })
      }
      return res.status(502).json({
        error: { code: 'ITC_IDENTITY_RESPONSE_INVALID', message: 'Identity service returned an invalid response' },
      })
    }
  }
}

module.exports = { createRequireItcSession }
