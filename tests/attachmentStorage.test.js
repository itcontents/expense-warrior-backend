const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { createAttachmentStorage, AttachmentStorageError } = require('../src/attachments/attachmentStorage')

function cloudinaryStub() {
  const calls = { uploads: [], destroys: [], urls: [] }
  return {
    calls,
    uploader: {
      upload_stream(options, callback) {
        calls.uploads.push(options)
        const chunks = []
        return new (require('node:stream').Writable)({
          write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done() },
          final(done) { callback(null, { public_id: options.public_id, buffer: Buffer.concat(chunks) }); done() },
        })
      },
      async destroy(publicId, options) { calls.destroys.push({ publicId, options }); return { result: 'ok' } },
    },
    url(publicId, options) { calls.urls.push({ publicId, options }); return 'https://res.cloudinary.com/test/image/authenticated/signed/private.png' },
  }
}

test('attachmentStorage_savesOnlyValidatedImagesAsAuthenticatedAssets', async () => {
  const cloudinary = cloudinaryStub()
  const storage = createAttachmentStorage({ cloudinary, fetchImpl: async () => new Response('unused') })
  const result = await storage.save({ mimetype: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })

  assert.match(result.storageKey, /^[0-9a-f-]{36}\.png$/)
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.size, 8)
  assert.equal(cloudinary.calls.uploads[0].type, 'authenticated')
  assert.equal(cloudinary.calls.uploads[0].overwrite, false)
  assert.match(cloudinary.calls.uploads[0].public_id, /^expense-warrior\/evidence\/[0-9a-f-]{36}$/)
})

test('attachmentStorage_rejectsMimetypeSpoofingAndOversizedImages', async () => {
  const storage = createAttachmentStorage({ cloudinary: cloudinaryStub() })
  await assert.rejects(storage.save({ mimetype: 'image/png', buffer: Buffer.from('not an image') }), (error) => error.code === 'UNSUPPORTED_IMAGE')
  await assert.rejects(storage.save({ mimetype: 'image/png', buffer: Buffer.alloc(9) }), (error) => error.code === 'UNSUPPORTED_IMAGE')
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
