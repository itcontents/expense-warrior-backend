const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const BASE_URLS = new Set([
  'https://api.sandbox.pawapay.io',
  'https://api.pawapay.io',
])
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CALLBACK_COMPONENTS = Object.freeze(['@method', '@authority', '@path', 'signature-date', 'content-digest', 'content-type'])
const NETWORKS = Object.freeze([
  Object.freeze({ code: 'AIRTEL_OAPI_ZMB', label: 'Airtel Money' }),
  Object.freeze({ code: 'MTN_MOMO_ZMB', label: 'MTN MoMo' }),
  Object.freeze({ code: 'ZAMTEL_ZMB', label: 'Zamtel Kwacha' }),
])
const PROVIDERS = new Set(NETWORKS.map(({ code }) => code))
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{2})?$/

class PawaPayError extends Error {
  constructor(code, { statusCode = 502, outcomeUnknown = false, providerStatus = null } = {}) {
    super(code)
    this.name = 'PawaPayError'
    this.code = code
    this.statusCode = statusCode
    this.outcomeUnknown = outcomeUnknown
    this.providerStatus = providerStatus
  }
}

function normalizeConfig(config = {}) {
  const baseUrl = String(config.baseUrl || 'https://api.sandbox.pawapay.io').replace(/\/+$/, '')
  if (!BASE_URLS.has(baseUrl)) throw new PawaPayError('PAWAPAY_BASE_URL_INVALID', { statusCode: 500 })
  if (!String(config.apiToken || '').trim()) throw new PawaPayError('PAWAPAY_API_TOKEN_MISSING', { statusCode: 500 })
  if (config.signatureEnabled !== true) throw new PawaPayError('PAWAPAY_SIGNATURE_REQUIRED', { statusCode: 500 })
  if (!String(config.signatureKeyId || '').trim() || String(config.signatureKeyId).length > 128) {
    throw new PawaPayError('PAWAPAY_SIGNATURE_KEY_ID_INVALID', { statusCode: 500 })
  }
  const requestTimeoutMs = Number(config.requestTimeoutMs || 15000)
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs > 30000) {
    throw new PawaPayError('PAWAPAY_TIMEOUT_INVALID', { statusCode: 500 })
  }
  const callbackPublicKeyTtlMs = Number(config.callbackPublicKeyTtlMs || 3600000)
  const callbackSignatureToleranceMs = Number(config.callbackSignatureToleranceMs ?? 300000)
  if (!Number.isInteger(callbackPublicKeyTtlMs) || callbackPublicKeyTtlMs < 60000 || callbackPublicKeyTtlMs > 86400000) {
    throw new PawaPayError('PAWAPAY_CALLBACK_KEY_TTL_INVALID', { statusCode: 500 })
  }
  if (!Number.isInteger(callbackSignatureToleranceMs) || callbackSignatureToleranceMs < 0 || callbackSignatureToleranceMs > 900000) {
    throw new PawaPayError('PAWAPAY_CALLBACK_TOLERANCE_INVALID', { statusCode: 500 })
  }
  return Object.freeze({
    baseUrl,
    apiToken: String(config.apiToken).trim(),
    signatureEnabled: true,
    signatureKeyId: String(config.signatureKeyId).trim(),
    signaturePrivateKey: config.signaturePrivateKey || null,
    signaturePrivateKeyPath: config.signaturePrivateKeyPath || null,
    requestTimeoutMs,
    callbackPublicKeyTtlMs,
    callbackSignatureToleranceMs,
  })
}

function parseCallbackSignatureInput(value) {
  const match = String(value || '').trim().match(/^([A-Za-z][A-Za-z0-9_-]{0,31})=\(([^)]*)\)(.*)$/)
  if (!match) throw new PawaPayError('PAWAPAY_CALLBACK_SIGNATURE_INPUT_INVALID', { statusCode: 401 })
  const components = match[2].trim().split(/\s+/)
    .map((component) => component.replace(/^"|"$/g, '')).filter(Boolean)
  if (components.length !== CALLBACK_COMPONENTS.length ||
      CALLBACK_COMPONENTS.some((component) => !components.includes(component)) ||
      new Set(components).size !== components.length) {
    throw new PawaPayError('PAWAPAY_CALLBACK_SIGNATURE_COMPONENTS_INVALID', { statusCode: 401 })
  }
  const params = {}
  for (const raw of match[3].split(';').filter(Boolean)) {
    const index = raw.indexOf('=')
    if (index < 1) throw new PawaPayError('PAWAPAY_CALLBACK_SIGNATURE_INPUT_INVALID', { statusCode: 401 })
    const key = raw.slice(0, index).trim()
    if (Object.hasOwn(params, key)) throw new PawaPayError('PAWAPAY_CALLBACK_SIGNATURE_INPUT_INVALID', { statusCode: 401 })
    params[key] = raw.slice(index + 1).trim().replace(/^"|"$/g, '')
  }
  return { label: match[1], components, params, signatureParams: `(${match[2]})${match[3]}` }
}

function callbackVerifyAlgorithm(value) {
  const algorithm = String(value || '').toLowerCase()
  if (['ecdsa-p256-sha256', 'rsa-v1_5-sha256'].includes(algorithm)) return { digest: 'sha256' }
  if (algorithm === 'ecdsa-p384-sha384') return { digest: 'sha384' }
  if (algorithm === 'rsa-pss-sha512') return {
    digest: 'sha512',
    options: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
  }
  throw new PawaPayError('PAWAPAY_CALLBACK_ALGORITHM_UNSUPPORTED', { statusCode: 401 })
}

function assertTransactionId(value) {
  if (!TRANSACTION_ID.test(String(value || ''))) {
    throw new PawaPayError('PAWAPAY_TRANSACTION_ID_INVALID', { statusCode: 400 })
  }
}

function assertAmount(value) {
  const amount = String(value || '')
  if (!AMOUNT.test(amount) || Number(amount) <= 0) {
    throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
  }
  return amount
}

function depositOptionsFromConfiguration(configuration, { country = 'ZMB', currency = 'ZMW' } = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
      !Array.isArray(configuration.countries)) {
    throw new PawaPayError('PAWAPAY_RESPONSE_INVALID', { statusCode: 502 })
  }
  const countryConfig = configuration.countries.find((item) => item?.country === country)
  if (!countryConfig) return []
  if (!Array.isArray(countryConfig.providers)) throw new PawaPayError('PAWAPAY_RESPONSE_INVALID', { statusCode: 502 })
  const result = []
  for (const providerConfig of countryConfig.providers) {
    const network = NETWORKS.find(({ code }) => code === providerConfig?.provider)
    if (!network) continue
    if (!Array.isArray(providerConfig.currencies)) throw new PawaPayError('PAWAPAY_RESPONSE_INVALID', { statusCode: 502 })
    const currencyConfig = providerConfig.currencies.find((item) => item?.currency === currency)
    if (!currencyConfig) continue
    const operationTypes = currencyConfig.operationTypes
    let operation
    if (Array.isArray(operationTypes)) {
      operation = operationTypes
        .map((item) => item?.DEPOSIT || (item?.operationType === 'DEPOSIT' ? item : null))
        .find(Boolean)
    } else if (operationTypes && typeof operationTypes === 'object') {
      operation = operationTypes.DEPOSIT || null
    } else {
      throw new PawaPayError('PAWAPAY_RESPONSE_INVALID', { statusCode: 502 })
    }
    if (!operation || operation.status !== 'OPERATIONAL') continue
    const minAmount = operation.minTransactionLimit ?? operation.minAmount
    const maxAmount = operation.maxTransactionLimit ?? operation.maxAmount
    const validAmount = (value) => typeof value === 'string' && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value)
    if (!validAmount(minAmount) || !validAmount(maxAmount) ||
        !['NONE', 'TWO_PLACES'].includes(operation.decimalsInAmount) ||
        typeof operation.authType !== 'string' || !operation.authType.trim()) {
      throw new PawaPayError('PAWAPAY_RESPONSE_INVALID', { statusCode: 502 })
    }
    // V1 relies on the provider sending an authorization prompt. PREAUTH needs
    // an additional code in the deposit request that this payer flow never collects.
    if (operation.authType !== 'PROVIDER_AUTH' || operation.pinPrompt !== 'AUTOMATIC') continue
    result.push({
      ...network,
      min_amount: minAmount,
      max_amount: maxAmount,
      decimals_in_amount: operation.decimalsInAmount,
      auth_type: operation.authType,
      ...(typeof operation.pinPrompt === 'string' ? { pin_prompt: operation.pinPrompt } : {}),
    })
  }
  return result
}

function assertPhoneAndProvider(phoneNumber, provider) {
  if (!/^\d{7,15}$/.test(String(phoneNumber || '')) || !PROVIDERS.has(String(provider || ''))) {
    throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
  }
}

function assertOnlyKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
  }
}

class PawaPayClient {
  static getNetworks(operation = 'deposit') {
    if (!['deposit', 'payout'].includes(operation)) return []
    return NETWORKS.map((network) => ({ ...network }))
  }

  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now, readFile = fs.readFileSync, stat = fs.statSync } = {}) {
    Object.defineProperty(this, 'config', { value: normalizeConfig(config), enumerable: false })
    if (typeof fetchImpl !== 'function') throw new PawaPayError('PAWAPAY_FETCH_REQUIRED', { statusCode: 500 })
    this.fetchImpl = fetchImpl
    this.now = now
    this.readFile = readFile
    this.stat = stat
    Object.defineProperty(this, 'privateKey', { value: null, writable: true, enumerable: false })
    this.callbackPublicKeys = null
    this.callbackPublicKeysFetchedAt = 0
  }

  loadPrivateKey() {
    if (this.privateKey) return this.privateKey
    if (this.config.signaturePrivateKey) this.privateKey = String(this.config.signaturePrivateKey)
    else if (this.config.signaturePrivateKeyPath) {
      const filePath = path.isAbsolute(this.config.signaturePrivateKeyPath)
        ? this.config.signaturePrivateKeyPath
        : path.resolve(process.cwd(), this.config.signaturePrivateKeyPath)
      try {
        const keyStat = this.stat(filePath)
        if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
          throw new Error('Signing key file permissions are too broad')
        }
        this.privateKey = this.readFile(filePath, 'utf8')
      } catch (_error) {
        throw new PawaPayError('PAWAPAY_SIGNATURE_PRIVATE_KEY_UNAVAILABLE', { statusCode: 500 })
      }
    }
    if (!this.privateKey) throw new PawaPayError('PAWAPAY_SIGNATURE_PRIVATE_KEY_MISSING', { statusCode: 500 })
    try {
      const key = crypto.createPrivateKey(this.privateKey)
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('Unsupported key type')
      }
    } catch (_error) {
      this.privateKey = null
      throw new PawaPayError('PAWAPAY_SIGNATURE_PRIVATE_KEY_INVALID', { statusCode: 500 })
    }
    return this.privateKey
  }

  buildHeaders({ method, url, body = '' }) {
    const contentType = 'application/json; charset=UTF-8'
    const timestamp = this.now()
    const signatureDate = new Date(timestamp).toISOString()
    const created = Math.floor(timestamp / 1000)
    const expires = created + 60
    const contentDigest = `sha-512=:${crypto.createHash('sha512').update(String(body), 'utf8').digest('base64')}:`
    const parsed = new URL(url)
    const signatureParams = `("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="${this.config.signatureKeyId}";created=${created};expires=${expires}`
    const signatureBase = [
      `"@method": ${String(method).toUpperCase()}`,
      `"@authority": ${parsed.host}`,
      `"@path": ${parsed.pathname}${parsed.search}`,
      `"signature-date": ${signatureDate}`,
      `"content-digest": ${contentDigest}`,
      `"content-type": ${contentType}`,
      `"@signature-params": ${signatureParams}`,
    ].join('\n')
    const signer = crypto.createSign('SHA256')
    signer.update(signatureBase)
    signer.end()
    const signature = signer.sign(this.loadPrivateKey()).toString('base64')
    return {
      Authorization: `Bearer ${this.config.apiToken}`,
      'Content-Type': contentType,
      'Content-Digest': contentDigest,
      'Signature-Date': signatureDate,
      Signature: `sig-pp=:${signature}:`,
      'Signature-Input': `sig-pp=${signatureParams}`,
      'Accept-Signature': 'rsa-pss-sha512,ecdsa-p256-sha256,rsa-v1_5-sha256,ecdsa-p384-sha384',
      'Accept-Digest': 'sha-256,sha-512',
    }
  }

  async request(endpoint, { method = 'GET', body, signed = true } = {}) {
    method = String(method || '').toUpperCase()
    if (!['GET', 'POST'].includes(method)) throw new PawaPayError('PAWAPAY_METHOD_INVALID', { statusCode: 400 })
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/v2/') || endpoint.startsWith('//') || /[\r\n\\]/.test(endpoint) || endpoint.includes('..')) {
      throw new PawaPayError('PAWAPAY_PATH_INVALID', { statusCode: 400 })
    }
    const url = `${this.config.baseUrl}${endpoint}`
    const bodyText = body === undefined ? '' : JSON.stringify(body)
    const headers = signed
      ? this.buildHeaders({ method, url, body: bodyText })
      : { Authorization: `Bearer ${this.config.apiToken}` }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs)
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: bodyText }),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      const uncertain = method !== 'GET'
      throw new PawaPayError(uncertain ? 'PAWAPAY_OUTCOME_UNKNOWN' : (error.name === 'AbortError' ? 'PAWAPAY_TIMEOUT' : 'PAWAPAY_NETWORK_ERROR'), {
        statusCode: uncertain ? 504 : (error.name === 'AbortError' ? 504 : 502),
        outcomeUnknown: uncertain,
      })
    } finally {
      clearTimeout(timer)
    }

    let text
    try {
      text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > 262144) throw new Error('Response too large')
    } catch (_error) {
      throw new PawaPayError(method === 'GET' ? 'PAWAPAY_RESPONSE_INVALID' : 'PAWAPAY_OUTCOME_UNKNOWN', {
        statusCode: method === 'GET' ? 502 : 504,
        outcomeUnknown: method !== 'GET',
        providerStatus: response.status,
      })
    }

    let payload = {}
    if (text) {
      try { payload = JSON.parse(text) } catch (_error) {
        throw new PawaPayError(method === 'GET' ? 'PAWAPAY_RESPONSE_INVALID' : 'PAWAPAY_OUTCOME_UNKNOWN', {
          statusCode: method === 'GET' ? 502 : 504,
          outcomeUnknown: method !== 'GET',
          providerStatus: response.status,
        })
      }
    }
    if (!response.ok) {
      const uncertain = method !== 'GET' && response.status >= 500
      throw new PawaPayError(uncertain ? 'PAWAPAY_OUTCOME_UNKNOWN' : 'PAWAPAY_REQUEST_FAILED', {
        statusCode: uncertain ? 504 : (response.status >= 500 ? 502 : response.status),
        outcomeUnknown: uncertain,
        providerStatus: response.status,
      })
    }
    return payload
  }

  getWalletBalances({ country } = {}) {
    const query = country ? `?country=${encodeURIComponent(country)}` : ''
    if (country && !/^[A-Z]{3}$/.test(country)) throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
    return this.request(`/v2/wallet-balances${query}`)
  }

  getActiveConfiguration({ country = 'ZMB', operationType = 'DEPOSIT' } = {}) {
    if (!/^[A-Z]{3}$/.test(country) || !['DEPOSIT', 'PAYOUT'].includes(operationType)) {
      throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
    }
    const query = new URLSearchParams({ country, operationType })
    return this.request(`/v2/active-conf?${query}`)
  }

  async getDepositNetworkOptions({ country = 'ZMB', currency = 'ZMW' } = {}) {
    if (!/^[A-Z]{3}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
      throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
    }
    const configuration = await this.getActiveConfiguration({ country, operationType: 'DEPOSIT' })
    return depositOptionsFromConfiguration(configuration, { country, currency })
  }

  predictProvider(phoneNumber) {
    if (!/^\d{7,15}$/.test(String(phoneNumber || ''))) throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
    return this.request('/v2/predict-provider', { method: 'POST', body: { phoneNumber } })
  }

  initiateDeposit(input = {}) {
    assertOnlyKeys(input, ['depositId', 'amount', 'phoneNumber', 'provider', 'clientReferenceId', 'customerMessage'])
    assertTransactionId(input.depositId)
    assertPhoneAndProvider(input.phoneNumber, input.provider)
    const payload = {
      depositId: input.depositId,
      payer: { type: 'MMO', accountDetails: { phoneNumber: input.phoneNumber, provider: input.provider } },
      amount: assertAmount(input.amount),
      currency: 'ZMW',
    }
    if (input.clientReferenceId !== undefined) payload.clientReferenceId = validateReference(input.clientReferenceId)
    if (input.customerMessage !== undefined) payload.customerMessage = validateMessage(input.customerMessage)
    return this.request('/v2/deposits', { method: 'POST', body: payload })
  }

  getDepositStatus(depositId) {
    assertTransactionId(depositId)
    return this.request(`/v2/deposits/${encodeURIComponent(depositId)}`)
  }

  initiatePayout(input = {}) {
    assertOnlyKeys(input, ['payoutId', 'amount', 'phoneNumber', 'provider', 'clientReferenceId', 'customerMessage'])
    assertTransactionId(input.payoutId)
    assertPhoneAndProvider(input.phoneNumber, input.provider)
    const payload = {
      payoutId: input.payoutId,
      recipient: { type: 'MMO', accountDetails: { phoneNumber: input.phoneNumber, provider: input.provider } },
      amount: assertAmount(input.amount),
      currency: 'ZMW',
      clientReferenceId: validateReference(input.clientReferenceId),
      customerMessage: validateMessage(input.customerMessage),
    }
    return this.request('/v2/payouts', { method: 'POST', body: payload })
  }

  getPayoutStatus(payoutId) {
    assertTransactionId(payoutId)
    return this.request(`/v2/payouts/${encodeURIComponent(payoutId)}`)
  }

  initiateRefund(input = {}) {
    assertOnlyKeys(input, ['refundId', 'depositId', 'amount', 'clientReferenceId'])
    assertTransactionId(input.refundId)
    assertTransactionId(input.depositId)
    return this.request('/v2/refunds', { method: 'POST', body: {
      refundId: input.refundId,
      depositId: input.depositId,
      amount: assertAmount(input.amount),
      currency: 'ZMW',
      clientReferenceId: validateReference(input.clientReferenceId),
    } })
  }

  getRefundStatus(refundId) {
    assertTransactionId(refundId)
    return this.request(`/v2/refunds/${encodeURIComponent(refundId)}`)
  }

  async getCallbackPublicKeys() {
    if (this.callbackPublicKeys && this.now() - this.callbackPublicKeysFetchedAt < this.config.callbackPublicKeyTtlMs) {
      return this.callbackPublicKeys
    }
    const payload = await this.request('/v2/public-key/http', { signed: false })
    if (!Array.isArray(payload)) throw new PawaPayError('PAWAPAY_CALLBACK_KEYS_INVALID')
    const keys = new Map()
    for (const item of payload) {
      const id = String(item?.id || '')
      const key = String(item?.key || '')
      if (!id || !key) continue
      try { crypto.createPublicKey(key) } catch { continue }
      keys.set(id, key)
    }
    if (!keys.size) throw new PawaPayError('PAWAPAY_CALLBACK_KEYS_EMPTY')
    this.callbackPublicKeys = keys
    this.callbackPublicKeysFetchedAt = this.now()
    return keys
  }

  async verifyCallback({ requestContext } = {}) {
    const context = requestContext || {}
    const rawBody = context.rawBody
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 65536) {
      throw new PawaPayError('PAWAPAY_CALLBACK_RAW_BODY_INVALID', { statusCode: 401 })
    }
    const headers = Object.fromEntries(Object.entries(context.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    for (const name of ['signature', 'signature-input', 'signature-date', 'content-digest', 'content-type']) {
      if (typeof headers[name] !== 'string' || !headers[name]) {
        throw new PawaPayError('PAWAPAY_CALLBACK_HEADERS_MISSING', { statusCode: 401 })
      }
    }
    const expectedDigest = crypto.createHash('sha512').update(rawBody).digest('base64')
    const receivedDigest = headers['content-digest'].match(/^sha-512=:(.+):$/)?.[1] || ''
    const expectedDigestBytes = Buffer.from(expectedDigest)
    const receivedDigestBytes = Buffer.from(receivedDigest)
    if (expectedDigestBytes.length !== receivedDigestBytes.length ||
        !crypto.timingSafeEqual(expectedDigestBytes, receivedDigestBytes)) {
      throw new PawaPayError('PAWAPAY_CALLBACK_DIGEST_INVALID', { statusCode: 401 })
    }
    const parsed = parseCallbackSignatureInput(headers['signature-input'])
    const created = Number(parsed.params.created) * 1000
    const expires = Number(parsed.params.expires) * 1000
    const signatureDate = Date.parse(headers['signature-date'])
    const tolerance = this.config.callbackSignatureToleranceMs
    if (!Number.isFinite(created) || !Number.isFinite(expires) || !Number.isFinite(signatureDate) ||
        expires < created || this.now() < created - tolerance || this.now() > expires + tolerance ||
        Math.abs(this.now() - signatureDate) > tolerance || !parsed.params.keyid || !parsed.params.alg) {
      throw new PawaPayError('PAWAPAY_CALLBACK_WINDOW_INVALID', { statusCode: 401 })
    }
    const values = {
      '@method': String(context.method || 'POST').toUpperCase(),
      '@authority': String(context.authority || headers.host || ''),
      '@path': String(context.originalUrl || context.url || '/'),
      'signature-date': headers['signature-date'],
      'content-digest': headers['content-digest'],
      'content-type': headers['content-type'],
    }
    if (Object.values(values).some((value) => !value)) {
      throw new PawaPayError('PAWAPAY_CALLBACK_COMPONENT_MISSING', { statusCode: 401 })
    }
    const signatureBase = parsed.components.map((name) => `"${name}": ${values[name]}`)
      .concat(`"@signature-params": ${parsed.signatureParams}`).join('\n')
    const signatureLabel = parsed.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const signature = headers.signature.match(new RegExp(`(?:^|,)\\s*${signatureLabel}=:(.+?):`))?.[1]
    const key = (await this.getCallbackPublicKeys()).get(parsed.params.keyid)
    if (!signature || !key) throw new PawaPayError('PAWAPAY_CALLBACK_KEY_OR_SIGNATURE_UNKNOWN', { statusCode: 401 })
    const algorithm = callbackVerifyAlgorithm(parsed.params.alg)
    const verifier = crypto.createVerify(algorithm.digest)
    verifier.update(signatureBase)
    verifier.end()
    const valid = algorithm.options
      ? verifier.verify({ key, ...algorithm.options }, signature, 'base64')
      : verifier.verify(key, signature, 'base64')
    if (!valid) throw new PawaPayError('PAWAPAY_CALLBACK_SIGNATURE_INVALID', { statusCode: 401 })
    return true
  }
}

function validateReference(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 128) {
    throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
  }
  return value.trim()
}

function validateMessage(value) {
  if (typeof value !== 'string' || value.trim().length < 4 || value.length > 22) {
    throw new PawaPayError('PAWAPAY_INPUT_INVALID', { statusCode: 400 })
  }
  return value.trim()
}

module.exports = { PawaPayClient, PawaPayError }
