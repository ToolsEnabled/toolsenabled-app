import test from 'node:test'
import assert from 'node:assert/strict'

import { crescentSpec } from '../../src/crescent-field.js'

const MODULE = new URL('../../src/crescent-render.js', import.meta.url)
let loadId = 0
const originalGlobals = {
  document: globalThis.document,
  Worker: globalThis.Worker,
  devicePixelRatio: globalThis.devicePixelRatio,
  createObjectURL: globalThis.URL.createObjectURL,
  revokeObjectURL: globalThis.URL.revokeObjectURL,
}

function installBrowser({ worker = 'unavailable', blobs = true } = {}) {
  const canvases = []
  const created = []
  const revoked = []

  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas', 'the renderer only asks the document for canvases')
      const canvas = {
        width: 0,
        height: 0,
        image: null,
        getContext(kind) {
          assert.equal(kind, '2d', 'alpha masks are rendered through a 2D canvas')
          return {
            createImageData(width, height) {
              canvas.image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
              return canvas.image
            },
            putImageData(image, x, y) {
              assert.equal(image, canvas.image)
              assert.deepEqual([x, y], [0, 0])
            },
          }
        },
        toBlob(callback, type) {
          assert.equal(type, 'image/png', 'mask canvases are encoded in a browser-supported lossless format')
          callback((typeof blobs === 'function' ? blobs() : blobs) ? { canvas } : null)
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }

  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:mask-${created.length + 1}`
    created.push({ blob, url })
    return url
  }
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url)

  globalThis.Worker = worker === 'reject'
    ? class {
        postMessage(message) {
          queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: false, error: 'worker could not rasterise' } }))
        }
        terminate() {}
      }
    : class { constructor() { throw new Error('workers unavailable') } }

  return { canvases, created, revoked }
}

async function loadRenderer(options) {
  const browser = installBrowser(options)
  const renderer = await import(`${MODULE.href}?crescent-render-test=${++loadId}`)
  return { ...browser, renderer }
}

test.afterEach(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (name === 'createObjectURL' || name === 'revokeObjectURL') continue
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
  globalThis.URL.createObjectURL = originalGlobals.createObjectURL
  globalThis.URL.revokeObjectURL = originalGlobals.revokeObjectURL
})

test('a real hero size becomes three usable alpha masks with shared geometry and a cached result', async () => {
  const { renderer, canvases, created, revoked } = await loadRenderer()
  const first = renderer.crescentMasks(460, 1)
  const again = renderer.crescentMasks(460, 1)

  assert.equal(again, first, 'the same hero size and scale reuse one render job')
  const result = await first
  const expected = crescentSpec(460)
  assert.deepEqual(result.box, expected.box, 'callers receive the field box needed to align every mask with the ring')
  assert.deepEqual(Object.keys(result.urls), ['haze', 'halo', 'core'], 'all three paid-for light layers receive a mask URL')
  assert.equal(new Set(Object.values(result.urls)).size, 3, 'each light layer receives its own mask rather than another layer’s image')
  assert.equal(canvases.length, 3, 'one canvas is encoded for each light layer, even when the job is requested twice')
  assert.equal(created.length, 3, 'each completed layer exposes one usable blob URL')

  for (const canvas of canvases) {
    assert.equal(canvas.width, Math.round(expected.box.width), 'mask bitmap width follows the caller’s requested scale')
    assert.equal(canvas.height, Math.round(expected.box.height), 'mask bitmap height follows the caller’s requested scale')
    assert.equal(canvas.image.width, canvas.width)
    assert.equal(canvas.image.height, canvas.height)
    const rgbIsWhite = canvas.image.data.every((value, index) => index % 4 === 3 || value === 255)
    assert.equal(rgbIsWhite, true,
      'mask intensity is carried by alpha while every RGB pixel remains neutral white')
    assert.ok(canvas.image.data.some((value, index) => index % 4 === 3 && value > 0),
      'each paid-for layer contains visible alpha, not an empty mask')
  }

  renderer.releaseCrescentMasks()
  await Promise.resolve()
  assert.deepEqual(new Set(revoked), new Set(Object.values(result.urls)),
    'release revokes every real mask URL so repeated hero sizes do not leak blobs')
})

test('a worker refusal falls back to the deterministic local renderer', async () => {
  const { renderer, canvases } = await loadRenderer({ worker: 'reject' })
  const result = await renderer.crescentMasks(460, 1)

  assert.deepEqual(Object.keys(result.urls), ['haze', 'halo', 'core'],
    'a worker that could not rasterise must not erase the crescent when the local renderer is available')
  assert.ok(Object.values(result.urls).every(url => url?.startsWith('blob:')),
    'worker refusal still resolves to three definite local mask URLs')
  assert.equal(canvases.length, 3, 'the refusal takes the complete three-layer local path')
})

test('an encoder failure is explicit uncertainty and is not cached', async () => {
  let encodingAvailable = false
  const { renderer, created, canvases } = await loadRenderer({ blobs: () => encodingAvailable })
  const first = renderer.crescentMasks(460, 1)

  await assert.rejects(first, error => {
    assert.equal(error.code, 'CRESCENT_MASK_ENCODE_UNKNOWN')
    assert.match(error.message, /not claiming the mask is absent/i)
    return true
  }, 'a null encoder callback reports could-not-tell rather than definite absent URLs')
  assert.equal(created.length, 0, 'failed encodes never manufacture object URLs')

  encodingAvailable = true
  const replacement = renderer.crescentMasks(460, 1)
  assert.notEqual(replacement, first, 'a could-not-tell result is evicted without requiring release')
  const result = await replacement
  assert.ok(Object.values(result.urls).every(url => url?.startsWith('blob:')),
    'a later attempt can establish three real mask URLs')
  assert.equal(canvases.length, 4, 'the retry starts encoding again after the first layer failed')
})
