import { strict as assert } from 'node:assert'
import test from 'node:test'

const messages = []
const workerScope = {
  postMessage(message, transfer) {
    messages.push({ message, transfer })
  },
}

globalThis.self = workerScope
await import('../../src/crescent-worker.js')

test.after(() => {
  delete globalThis.self
})

test('the worker returns every raster plane at the requested device scale', () => {
  messages.length = 0
  workerScope.onmessage({ data: { id: 'hero-7', size: 32, scale: 1 } })

  assert.equal(messages.length, 1, 'one request must produce exactly one worker reply')
  const { message, transfer } = messages[0]
  assert.equal(message.id, 'hero-7', 'the reply must retain the caller request id')
  assert.equal(message.ok, true, 'a valid raster request must succeed')
  assert.ok(message.width > 0 && message.height > 0,
    'a successful raster must report positive pixel dimensions')
  assert.deepEqual(Object.keys(message.planes).sort(), ['core', 'halo', 'haze'],
    'a successful raster must contain the three mask layers callers consume')

  const planes = Object.values(message.planes)
  for (const plane of planes) {
    assert.ok(plane instanceof Uint8ClampedArray,
      'each raster layer must be an 8-bit clamped alpha plane')
    assert.equal(plane.length, message.width * message.height,
      'each alpha plane must fill the reported pixel dimensions')
  }
  assert.deepEqual(transfer, planes.map(plane => plane.buffer),
    'the reply must transfer the exact alpha-plane buffers instead of copying them')
})

test('a rasterization failure is reported as indeterminate rather than success', () => {
  messages.length = 0
  workerScope.onmessage({ data: { id: 'hero-bad', size: 32, scale: Symbol('unreadable') } })

  assert.equal(messages.length, 1, 'a failed request must still produce exactly one worker reply')
  const { message, transfer } = messages[0]
  assert.equal(message.id, 'hero-bad', 'a failure reply must retain the caller request id')
  assert.equal(message.ok, false, 'a rasterization failure must not become a definite success')
  assert.equal(typeof message.error, 'string', 'a failure reply must explain the error to its caller')
  assert.ok(message.error.length > 0, 'a failure explanation must not be empty')
  assert.equal(transfer, undefined, 'a failure must not claim any buffers for transfer')
})
