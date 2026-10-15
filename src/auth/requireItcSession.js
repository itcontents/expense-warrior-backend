function createRequireItcSession(identityClient) {
  if (!identityClient || typeof identityClient.getSession !== 'function') {
    throw new TypeError('An ITC identity client is required')
  }

  return async function requireItcSession(req, res, next) {
    if (!req.headers?.cookie || !req.headers.cookie.includes('itc_backoffice_access=')) {
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
      return res.status(502).json({
        error: { code: 'ITC_IDENTITY_RESPONSE_INVALID', message: 'Identity service returned an invalid response' },
      })
    }
  }
}

module.exports = { createRequireItcSession }
