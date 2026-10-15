const { createHash, randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { Transform } = require('node:stream')

const IMAGE_SIGNATURES = Object.freeze({
  'image/jpeg': { extension: 'jpg', matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: 'png', matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { extension: 'webp', matches: (buffer) => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
})

const STORAGE_PREFIX = 'expense-warrior/evidence/'

class AttachmentStorageError extends Error {
  constructor(code, statusCode = 400) {
    super(code)
    this.name = 'AttachmentStorageError'
    this.code = code
    this.statusCode = statusCode
  }
}

function createAttachmentStorage({ cloudinary, fetchImpl = fetch, maxBytes = 5 * 1024 * 1024, timeoutMs = 10000 } = {}) {
  if (!cloudinary?.uploader?.upload_stream || !cloudinary?.uploader?.destroy || typeof cloudinary?.url !== 'function') {
    throw new TypeError('A configured Cloudinary client is required')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('A positive attachment size limit is required')

  async function save(file) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) throw new AttachmentStorageError('INVALID_IMAGE')
    if (file.buffer.length > maxBytes) throw new AttachmentStorageError('IMAGE_TOO_LARGE', 413)
    const signature = IMAGE_SIGNATURES[file.mimetype]
    if (!signature || !signature.matches(file.buffer)) throw new AttachmentStorageError('UNSUPPORTED_IMAGE')

    const storageKey = `${randomUUID()}.${signature.extension}`
    const publicId = `${STORAGE_PREFIX}${storageKey.slice(0, 36)}`
    try {
      await new Promise((resolve, reject) => {
        const upload = cloudinary.uploader.upload_stream({
          public_id: publicId,
          resource_type: 'image',
          type: 'authenticated',
          overwrite: false,
          unique_filename: false,
          use_filename: false,
          format: signature.extension,
        }, (error, result) => error ? reject(error) : resolve(result))
        Readable.from([file.buffer]).pipe(upload)
      })
    } catch {
      throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    }

    return Object.freeze({
      storageKey,
      mediaType: file.mimetype,
      size: file.buffer.length,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
    })
  }

  async function remove(storageKey) {
    if (typeof storageKey !== 'string' || !/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(storageKey)) return false
    try {
      const result = await cloudinary.uploader.destroy(`${STORAGE_PREFIX}${storageKey.slice(0, 36)}`, {
        resource_type: 'image',
        type: 'authenticated',
        invalidate: true,
      })
      return result?.result === 'ok'
    } catch {
      throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    }
  }

  async function open(storageKey, mediaType) {
    if (typeof storageKey !== 'string' || !/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(storageKey)) {
      throw new AttachmentStorageError('ATTACHMENT_NOT_FOUND', 404)
    }
    const signature = IMAGE_SIGNATURES[mediaType]
    if (!signature || !storageKey.endsWith(`.${signature.extension}`)) throw new AttachmentStorageError('ATTACHMENT_NOT_FOUND', 404)
    const url = cloudinary.url(`${STORAGE_PREFIX}${storageKey.slice(0, 36)}`, {
      resource_type: 'image',
      type: 'authenticated',
      sign_url: true,
      secure: true,
      format: signature.extension,
    })

    let response
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    }
    if (response.status === 404) throw new AttachmentStorageError('ATTACHMENT_NOT_FOUND', 404)
    if (!response.ok || !response.body) throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== mediaType) throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    let receivedBytes = 0
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length
        callback(receivedBytes > maxBytes ? new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503) : null, chunk)
      },
    })
    return Readable.fromWeb(response.body).pipe(limit)
  }

  return Object.freeze({ save, remove, open })
}

module.exports = { createAttachmentStorage, AttachmentStorageError }
