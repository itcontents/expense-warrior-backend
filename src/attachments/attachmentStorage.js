const { createHash, randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { Transform } = require('node:stream')
const sharp = require('sharp')

const IMAGE_SIGNATURES = Object.freeze({
  'image/jpeg': { extension: 'jpg', format: 'jpeg', matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: 'png', format: 'png', matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { extension: 'webp', format: 'webp', matches: (buffer) => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
})

const STORAGE_PREFIX = 'expense-warrior/evidence/'
const DEFAULT_MAX_PIXELS = 20_000_000

class AttachmentStorageError extends Error {
  constructor(code, statusCode = 400) {
    super(code)
    this.name = 'AttachmentStorageError'
    this.code = code
    this.statusCode = statusCode
  }
}

function createAttachmentStorage({ cloudinary, fetchImpl = fetch, maxBytes = 5 * 1024 * 1024, maxPixels = DEFAULT_MAX_PIXELS, timeoutMs = 10000 } = {}) {
  if (!cloudinary?.uploader?.upload_stream || !cloudinary?.uploader?.destroy || typeof cloudinary?.url !== 'function') {
    throw new TypeError('A configured Cloudinary client is required')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('A positive attachment size limit is required')
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new TypeError('A positive attachment pixel limit is required')

  async function normalizeImage(buffer, signature) {
    let metadata
    try {
      metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: maxPixels }).metadata()
    } catch (error) {
      if (error?.message === 'Input image exceeds pixel limit') {
        throw new AttachmentStorageError('IMAGE_TOO_LARGE', 413)
      }
      throw new AttachmentStorageError('UNSUPPORTED_IMAGE')
    }
    if (metadata.format !== signature.format || !metadata.width || !metadata.height || metadata.channels > 4) {
      throw new AttachmentStorageError('UNSUPPORTED_IMAGE')
    }
    if (metadata.width * metadata.height > maxPixels) {
      throw new AttachmentStorageError('IMAGE_TOO_LARGE', 413)
    }
    if (Number(metadata.pages || 1) > 1) throw new AttachmentStorageError('UNSUPPORTED_IMAGE')

    try {
      let pipeline = sharp(buffer, { failOn: 'warning', limitInputPixels: maxPixels }).rotate()
      if (signature.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 85 })
      else if (signature.format === 'png') pipeline = pipeline.png({ compressionLevel: 8 })
      else pipeline = pipeline.webp({ quality: 85 })
      const normalized = await pipeline.toBuffer()
      if (normalized.length > maxBytes) throw new AttachmentStorageError('IMAGE_TOO_LARGE', 413)
      return normalized
    } catch (error) {
      if (error instanceof AttachmentStorageError) throw error
      throw new AttachmentStorageError('UNSUPPORTED_IMAGE')
    }
  }

  async function save(file) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) throw new AttachmentStorageError('INVALID_IMAGE')
    if (file.buffer.length > maxBytes) throw new AttachmentStorageError('IMAGE_TOO_LARGE', 413)
    const signature = IMAGE_SIGNATURES[file.mimetype]
    if (!signature || !signature.matches(file.buffer)) throw new AttachmentStorageError('UNSUPPORTED_IMAGE')
    const normalizedBuffer = await normalizeImage(file.buffer, signature)

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
        Readable.from([normalizedBuffer]).pipe(upload)
      })
    } catch {
      throw new AttachmentStorageError('ATTACHMENT_STORAGE_UNAVAILABLE', 503)
    }

    return Object.freeze({
      storageKey,
      mediaType: file.mimetype,
      size: normalizedBuffer.length,
      sha256: createHash('sha256').update(normalizedBuffer).digest('hex'),
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
