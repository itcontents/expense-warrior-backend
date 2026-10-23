const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const EXPENSE_WARRIOR_ACCESS_COOKIE = 'itc_expense_warrior_access'

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim() === 'null') return ''
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

function parseAllowedBrowserOrigins(value = '') {
  const origins = []
  for (const entry of String(value).split(',').map((item) => item.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(entry)
    if (!origin) {
      const error = new Error('Expense Warrior browser origins must be valid HTTP origins')
      error.code = 'CONFIG_INVALID'
      error.details = ['EXPENSE_WARRIOR_BROWSER_ORIGINS']
      throw error
    }
    const url = new URL(entry)
    if (url.pathname !== '/' || url.search || url.hash) {
      const error = new Error('Expense Warrior browser origins must not include a path, query, or fragment')
      error.code = 'CONFIG_INVALID'
      error.details = ['EXPENSE_WARRIOR_BROWSER_ORIGINS']
      throw error
    }
    origins.push(origin)
  }
  return [...new Set(origins)]
}

function hasExpenseWarriorAccessCookie(header = '') {
  return String(header).split(';').some((part) => part.trim().split('=', 1)[0] === EXPENSE_WARRIOR_ACCESS_COOKIE)
}

function isAllowedBrowserOrigin(origin, allowedOrigins, nodeEnv) {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  if (allowedOrigins.has(normalized)) return true
  if (nodeEnv === 'production') return false
  return /^http:\/\/(?:localhost|127\.0\.0\.1):5175$/i.test(normalized) ||
    /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:5175$/i.test(normalized)
}

function createCookieCsrfGuard({ allowedOrigins = [], nodeEnv = process.env.NODE_ENV || 'development' } = {}) {
  const trustedOrigins = new Set(allowedOrigins)
  return function cookieCsrfGuard(req, res, next) {
    if (!STATE_CHANGING_METHODS.has(String(req.method || '').toUpperCase()) ||
        !hasExpenseWarriorAccessCookie(req.headers?.cookie)) {
      return next()
    }
    if (isAllowedBrowserOrigin(req.headers?.origin, trustedOrigins, nodeEnv)) return next()
    return res.status(403).json({
      error: { code: 'CSRF_ORIGIN_DENIED', message: 'Request origin validation failed' },
    })
  }
}

module.exports = { createCookieCsrfGuard, hasExpenseWarriorAccessCookie, parseAllowedBrowserOrigins }
