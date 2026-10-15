const test = require('node:test')
const assert = require('node:assert/strict')
const { ItcIdentityClient } = require('../src/integrations/itc/ItcIdentityClient')

function sessionResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('identityClient_forwardsOnlyBackofficeCookieAndDoesNotReturnToken', async () => {
  let captured
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1/',
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return sessionResponse(200, {
        success: true,
        data: {
          token: 'must-not-be-retained',
          customer: { customer_id: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01', role: 'staff', is_active: true },
        },
      })
    },
  })

  const actor = await client.getSession('itc_backoffice_access=opaque-cookie; unrelated=ignored', 'request-123')

  assert.equal(captured.url, 'https://itc.example/api/v1/auth/session')
  assert.equal(captured.options.headers.Cookie, 'itc_backoffice_access=opaque-cookie')
  assert.equal(captured.options.headers['X-Session-Audience'], 'backoffice')
  assert.equal(captured.options.headers['X-Request-Id'], 'request-123')
  assert.deepEqual(actor, { customerId: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01', role: 'staff', active: true })
  assert.equal(Object.hasOwn(actor, 'token'), false)
})

test('identityClient_mapsExpiredSessionToUnauthorized', async () => {
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async () => sessionResponse(401, { error: 'Access token required' }),
  })

  await assert.rejects(client.getSession('itc_backoffice_access=value'), (error) => error.statusCode === 401)
})

test('identityClient_mapsTimeoutToUnavailable', async () => {
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    timeoutMs: 500,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })

  await assert.rejects(client.getSession('itc_backoffice_access=value'), (error) => error.statusCode === 503)
})

test('identityClient_rejectsMalformedIdentityResponse', async () => {
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async () => sessionResponse(200, { success: true, data: { customer: { role: 'staff' } } }),
  })

  await assert.rejects(client.getSession('itc_backoffice_access=value'), (error) => error.code === 'ITC_IDENTITY_RESPONSE_INVALID')
})

test('identityClient_readsOnlyBoundedActiveStaffDirectoryThroughBackofficeSession', async () => {
  let captured
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return sessionResponse(200, {
        success: true,
        data: { staff: [{ customer_id: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01', email: 's@example.test', first_name: 'Sam', last_name: 'Staff' }] },
      })
    },
  })

  const staff = await client.listStaffDirectory('itc_backoffice_access=opaque; other=ignored', { search: 'sam & team', limit: 20, offset: 40 }, 'request-456')

  assert.match(String(captured.url), /^https:\/\/itc\.example\/api\/v1\/admin\/expense-warrior\/staff-directory\?/)
  assert.equal(new URL(captured.url).searchParams.get('search'), 'sam & team')
  assert.equal(new URL(captured.url).searchParams.get('limit'), '20')
  assert.equal(new URL(captured.url).searchParams.get('offset'), '40')
  assert.equal(captured.options.headers.Cookie, 'itc_backoffice_access=opaque')
  assert.equal(captured.options.headers['X-Request-Id'], 'request-456')
  assert.equal(staff[0].customer_id, 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01')
})

test('identityClient_rejectsUnexpectedStaffDirectoryIdentity', async () => {
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async () => sessionResponse(200, { success: true, data: { staff: [{ email: 'not-an-id@example.test' }] } }),
  })

  await assert.rejects(client.listStaffDirectory('itc_backoffice_access=value'), (error) => error.code === 'ITC_IDENTITY_RESPONSE_INVALID')
})

test('identityClient_normalizesMissingDirectoryNamesWithoutExposingOtherFields', async () => {
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async () => sessionResponse(200, {
      success: true,
      data: { staff: [{ customer_id: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01', email: 's@example.test', first_name: null, last_name: null, phone: '260970000000' }] },
    }),
  })

  assert.deepEqual(await client.listStaffDirectory('itc_backoffice_access=value'), [
    { customer_id: 'c8da2d30-9805-4f51-9f6c-5bca3ff77a01', email: 's@example.test', first_name: '', last_name: '' },
  ])
})

test('identityClient_supportsNarrowStaffIdValidationAndRejectsMalformedIds', async () => {
  let capturedUrl
  const client = new ItcIdentityClient({
    baseUrl: 'https://itc.example/api/v1',
    fetchImpl: async (url) => {
      capturedUrl = String(url)
      return sessionResponse(200, { success: true, data: { staff: [] } })
    },
  })
  const ids = ['c8da2d30-9805-4f51-9f6c-5bca3ff77a01', 'f437d2e8-b1dd-4e68-9e73-457889e17dbd']
  await client.listStaffDirectory('itc_backoffice_access=value', { ids })
  assert.equal(new URL(capturedUrl).searchParams.get('ids'), ids.join(','))
  await assert.rejects(client.listStaffDirectory('itc_backoffice_access=value', { ids: ['bad-id'] }), (error) => error.code === 'ITC_STAFF_DIRECTORY_FILTER_INVALID')
})
