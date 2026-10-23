const CUSTOMER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class ItcIdentityError extends Error {
  constructor(code, statusCode) {
    super(code)
    this.name = 'ItcIdentityError'
    this.code = code
    this.statusCode = statusCode
  }
}

function getBackofficeAccessCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192 || /[\r\n]/.test(cookieHeader)) return ''
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0 || pair.slice(0, separator).trim() !== 'itc_backoffice_access') continue
    const value = pair.slice(separator + 1).trim()
    return value && !/[;\r\n]/.test(value) ? value : ''
  }
  return ''
}

class ItcIdentityClient {
  constructor({ baseUrl, timeoutMs = 5000, fetchImpl = fetch } = {}) {
    if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
      throw new TypeError('A valid ITC API base URL is required')
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  async getSession(cookieHeader, requestId = '') {
    const accessToken = getBackofficeAccessCookie(cookieHeader)
    if (!accessToken) throw new ItcIdentityError('ITC_SESSION_INVALID', 401)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/auth/session`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Cookie: `itc_backoffice_access=${accessToken}`,
          'X-Session-Audience': 'backoffice',
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
      })

      if (response.status === 401 || response.status === 403) {
        throw new ItcIdentityError('ITC_SESSION_INVALID', 401)
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || ''
        const retryAfterSeconds = /^\d{1,4}$/.test(retryAfter) ? Number(retryAfter) : null
        const error = new ItcIdentityError('ITC_IDENTITY_RATE_LIMITED', 429)
        if (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= 3600) {
          error.retryAfterSeconds = retryAfterSeconds
        }
        throw error
      }
      if (response.status !== 200) throw new ItcIdentityError('ITC_IDENTITY_UNAVAILABLE', 503)

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > 32768) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }

      let payload
      try {
        payload = JSON.parse(body)
      } catch (_error) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }

      const customer = payload?.data?.customer
      if (payload?.success !== true ||
          !CUSTOMER_ID_PATTERN.test(String(customer?.customer_id || '')) ||
          !['admin', 'staff', 'vendor', 'customer'].includes(String(customer?.role || '').toLowerCase())) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }

      return {
        customerId: customer.customer_id,
        role: String(customer.role).toLowerCase(),
        active: true,
      }
    } catch (error) {
      if (error instanceof ItcIdentityError) throw error
      throw new ItcIdentityError('ITC_IDENTITY_UNAVAILABLE', 503)
    } finally {
      clearTimeout(timeout)
    }
  }

  async listStaffDirectory(cookieHeader, filters = {}, requestId = '') {
    const accessToken = getBackofficeAccessCookie(cookieHeader)
    if (!accessToken) throw new ItcIdentityError('ITC_SESSION_INVALID', 401)
    const search = typeof filters.search === 'string' ? filters.search : ''
    const ids = filters.ids === undefined ? null : filters.ids
    const limit = Number.isSafeInteger(filters.limit) ? filters.limit : 50
    const offset = Number.isSafeInteger(filters.offset) ? filters.offset : 0
    if (search.length > 100 || (ids !== null && (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some((id) => !CUSTOMER_ID_PATTERN.test(String(id))))) ||
        limit < 1 || limit > (ids ? 500 : 50) || offset < 0 || offset > 1000000) {
      throw new ItcIdentityError('ITC_STAFF_DIRECTORY_FILTER_INVALID', 400)
    }

    const url = new URL(`${this.baseUrl}/admin/expense-warrior/staff-directory`)
    if (search) url.searchParams.set('search', search)
    if (ids) url.searchParams.set('ids', ids.join(','))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Cookie: `itc_backoffice_access=${accessToken}`,
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
      })
      if (response.status === 401 || response.status === 403) {
        throw new ItcIdentityError(response.status === 401 ? 'ITC_SESSION_INVALID' : 'ITC_STAFF_DIRECTORY_FORBIDDEN', response.status)
      }
      if (response.status !== 200) throw new ItcIdentityError('ITC_STAFF_DIRECTORY_UNAVAILABLE', 503)
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > 262144) throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      let payload
      try { payload = JSON.parse(body) } catch { throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502) }
      const staff = payload?.data?.staff
      if (payload?.success !== true || !Array.isArray(staff) || staff.length > limit || staff.some((person) =>
        !CUSTOMER_ID_PATTERN.test(String(person?.customer_id || '')) ||
        (person?.first_name !== null && person?.first_name !== undefined && (typeof person.first_name !== 'string' || person.first_name.length > 120)) ||
        (person?.last_name !== null && person?.last_name !== undefined && (typeof person.last_name !== 'string' || person.last_name.length > 120)) ||
        typeof person?.email !== 'string' || person.email.length > 254
      )) {
        throw new ItcIdentityError('ITC_IDENTITY_RESPONSE_INVALID', 502)
      }
      return staff.map(({ customer_id, email, first_name, last_name }) => ({
        customer_id, email, first_name: first_name || '', last_name: last_name || '',
      }))
    } catch (error) {
      if (error instanceof ItcIdentityError) throw error
      throw new ItcIdentityError('ITC_STAFF_DIRECTORY_UNAVAILABLE', 503)
    } finally {
      clearTimeout(timeout)
    }
  }
}

module.exports = { ItcIdentityClient, ItcIdentityError }
