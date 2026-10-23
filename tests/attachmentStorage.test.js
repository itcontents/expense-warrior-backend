const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const sharp = require('sharp')

const { createAttachmentStorage, AttachmentStorageError } = require('../src/attachments/attachmentStorage')

function cloudinaryStub() {
  const calls = { uploads: [], uploadedBuffers: [], destroys: [], urls: [] }
  return {
    calls,
    uploader: {
      upload_stream(options, callback) {
        calls.uploads.push(options)
        const chunks = []
        return new (require('node:stream').Writable)({
          write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done() },
          final(done) {
            const buffer = Buffer.concat(chunks)
            calls.uploadedBuffers.push(buffer)
            callback(null, { public_id: options.public_id, buffer })
            done()
          },
        })
      },
      async destroy(publicId, options) { calls.destroys.push({ publicId, options }); return { result: 'ok' } },
    },
    url(publicId, options) { calls.urls.push({ publicId, options }); return 'https://res.cloudinary.com/test/image/authenticated/signed/private.png' },
  }
}

async function createImage({ format = 'png', width = 16, height = 12, exif = false } = {}) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#abcdef' } })
  if (format === 'jpeg') {
    pipeline = pipeline.jpeg()
    if (exif) pipeline = pipeline.withExif({ IFD0: { Artist: 'private evidence metadata' } })
  } else if (format === 'webp') pipeline = pipeline.webp()
  else pipeline = pipeline.png()
  return pipeline.toBuffer()
}

test('attachmentStorage_reencodesValidatedImagesAndRemovesMetadataBeforePrivateUpload', async () => {
  const cloudinary = cloudinaryStub()
  const storage = createAttachmentStorage({ cloudinary, fetchImpl: async () => new Response('unused') })
  const original = await createImage({ format: 'jpeg', exif: true })
  const result = await storage.save({ mimetype: 'image/jpeg', buffer: original })

  assert.match(result.storageKey, /^[0-9a-f-]{36}\.jpg$/)
  assert.equal(result.mediaType, 'image/jpeg')
  assert.equal(result.size, cloudinary.calls.uploadedBuffers[0].length)
  assert.notDeepEqual(cloudinary.calls.uploadedBuffers[0], original)
  const uploadedMetadata = await sharp(cloudinary.calls.uploadedBuffers[0]).metadata()
  assert.equal(uploadedMetadata.format, 'jpeg')
  assert.equal(uploadedMetadata.exif, undefined)
  assert.equal(cloudinary.calls.uploads[0].type, 'authenticated')
  assert.equal(cloudinary.calls.uploads[0].overwrite, false)
  assert.match(cloudinary.calls.uploads[0].public_id, /^expense-warrior\/evidence\/[0-9a-f-]{36}$/)
})

test('attachmentStorage_acceptsReencodedPngAndWebpImagesAsAuthenticatedAssets', async () => {
  for (const [format, mimetype, extension] of [
    ['png', 'image/png', 'png'],
    ['webp', 'image/webp', 'webp'],
  ]) {
    const cloudinary = cloudinaryStub()
    const storage = createAttachmentStorage({ cloudinary })
    const result = await storage.save({ mimetype, buffer: await createImage({ format }) })

    assert.match(result.storageKey, new RegExp(`^[0-9a-f-]{36}\\.${extension}$`))
    assert.equal(result.mediaType, mimetype)
    assert.equal((await sharp(cloudinary.calls.uploadedBuffers[0]).metadata()).format, format)
    assert.equal(cloudinary.calls.uploads[0].type, 'authenticated')
  }
})

test('attachmentStorage_boundsCloudinaryUploadDuration', async () => {
  const cloudinary = cloudinaryStub()
  const storage = createAttachmentStorage({ cloudinary, timeoutMs: 1234 })
  await storage.save({ mimetype: 'image/png', buffer: await createImage() })

  assert.equal(cloudinary.calls.uploads[0].timeout, 1234)
})

test('attachmentStorage_rejectsMimetypeSpoofingAndOversizedImages', async () => {
  const storage = createAttachmentStorage({ cloudinary: cloudinaryStub() })
  await assert.rejects(storage.save({ mimetype: 'image/png', buffer: Buffer.from('not an image') }), (error) => error.code === 'UNSUPPORTED_IMAGE')
  await assert.rejects(storage.save({ mimetype: 'image/jpeg', buffer: await createImage() }), (error) => error.code === 'UNSUPPORTED_IMAGE')
})

test('attachmentStorage_rejectsImagesThatExceedTheDecodedPixelLimit', async () => {
  const storage = createAttachmentStorage({ cloudinary: cloudinaryStub(), maxPixels: 100 })
  await assert.rejects(storage.save({ mimetype: 'image/png', buffer: await createImage() }), (error) => {
    assert.ok(error instanceof AttachmentStorageError)
    assert.equal(error.code, 'IMAGE_TOO_LARGE')
    assert.equal(error.statusCode, 413)
    return true
  })
})

test('attachmentStorage_opensAuthenticatedCloudinaryImageWithoutExposingItsUrl', async () => {
  const cloudinary = cloudinaryStub()
  let requestedUrl
  const storage = createAttachmentStorage({
    cloudinary,
    fetchImpl: async (url, options) => {
      requestedUrl = url
      assert.equal(options.redirect, 'error')
      return new Response(Readable.toWeb(Readable.from([Buffer.from('image-bytes')])), {
        headers: { 'content-type': 'image/png', 'content-length': '11' },
      })
    },
  })
  const image = await storage.open('123e4567-e89b-42d3-a456-426614174000.png', 'image/png')
  const chunks = []
  for await (const chunk of image) chunks.push(chunk)

  assert.equal(Buffer.concat(chunks).toString(), 'image-bytes')
  assert.equal(requestedUrl, 'https://res.cloudinary.com/test/image/authenticated/signed/private.png')
  assert.equal(cloudinary.calls.urls[0].options.type, 'authenticated')
  assert.equal(cloudinary.calls.urls[0].options.sign_url, true)
})

test('attachmentStorage_removesOnlyOpaqueEvidenceKeysAsAuthenticatedAssets', async () => {
  const cloudinary = cloudinaryStub()
  const storage = createAttachmentStorage({ cloudinary })
  assert.equal(await storage.remove('123e4567-e89b-42d3-a456-426614174000.png'), true)
  assert.equal(await storage.remove('../other-file'), false)
  assert.equal(cloudinary.calls.destroys[0].options.type, 'authenticated')
})

test('attachmentStorage_rejectsMismatchedCloudinaryMediaType', async () => {
  const storage = createAttachmentStorage({
    cloudinary: cloudinaryStub(),
    fetchImpl: async () => new Response('not png', { headers: { 'content-type': 'text/html' } }),
  })
  await assert.rejects(storage.open('123e4567-e89b-42d3-a456-426614174000.png', 'image/png'), (error) => {
    assert.ok(error instanceof AttachmentStorageError)
    assert.equal(error.statusCode, 503)
    return true
  })
})
