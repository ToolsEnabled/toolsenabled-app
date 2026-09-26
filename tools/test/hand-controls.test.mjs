import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHandPointer } from '../../src/hand-pointer.js'
import { readHandChoice, startHandControls } from '../../src/hand-controls.js'
const { installVoicePermissions } = createRequire(import.meta.url)('../../shell/voice-permissions.cjs')
function hand(ratio, x = 0.5, y = 0.5) {
  const values = Array.from({ length: 21 }, () => ({ x, y, z: 0 }))
  values[5].x -= 0.09; values[17].x += 0.09; values[8].x += ratio * 0.18
  return values
}
test('hand tracking defaults off, including corrupt or inaccessible preferences', () => {
  for (const value of [null, undefined, '', 'false', '1', 'TRUE', '{}']) assert.equal(readHandChoice({ getItem: () => value }), false)
  assert.equal(readHandChoice({ getItem() { throw Error('unavailable') } }), false)
  assert.equal(readHandChoice({ getItem: () => 'true' }), true)
})
test('off hand controls do not require an asset base or request camera or worker startup', () => {
  let baseReads = 0, cameraStarts = 0, workers = 0, media = 0
  const doc = new EventTarget()
  Object.defineProperty(doc, 'baseURI', { get() { baseReads++; throw Error('no document base') } })
  const control = startHandControls({ doc, win: new EventTarget(), storage: { getItem: () => null },
    camera: { async setEnabled(value) { if (value) cameraStarts++ } },
    createWorker() { workers++; throw Error('must stay off') },
    getMedia() { media++; throw Error('must stay off') },
  })
  try {
    assert.equal(control.getState().enabled, false)
    assert.equal(control.getState().phase, 'off')
    assert.deepEqual({ baseReads, cameraStarts, workers, media }, { baseReads: 0, cameraStarts: 0, workers: 0, media: 0 })
  } finally { control.destroy() }
})
test('pinch requires an open hand first and fires once until a complete release', () => {
  const controller = createHandPointer()
  for (let at = 0; at < 300; at += 50) assert.equal(controller.update(hand(0.1), at).click, false)
  for (let at = 300; at < 600; at += 50) controller.update(hand(0.8), at)
  const presses = []
  for (let at = 600; at < 1300; at += 50) if (controller.update(hand(0.1), at).click) presses.push(at)
  assert.equal(presses.length, 1)
  for (let at = 1300; at < 1600; at += 50) controller.update(hand(0.8), at)
  for (let at = 1600; at < 2000; at += 50) if (controller.update(hand(0.1), at).click) presses.push(at)
  assert.equal(presses.length, 2)
})
test('tracking loss, stale frames, changed hand and malformed geometry cancel a pending pinch', () => {
  for (const interrupt of [
    c => c.update(null, 500),
    c => c.update(hand(0.1), 1000),
    c => c.update(hand(0.1), 500, { hand: 'other' }),
    c => c.update(hand(0.1).map(p => ({ ...p, x: NaN })), 500),
  ]) {
    const c = createHandPointer()
    for (let at = 0; at <= 400; at += 50) c.update(hand(0.8), at)
    c.update(hand(0.1), 450); interrupt(c)
    assert.equal(c.update(hand(0.1), 1050).click, false)
  }
})
test('pinch freezes palm aim and a brief near-pinch never fires', () => {
  const c = createHandPointer()
  for (let at = 0; at < 300; at += 50) c.update(hand(0.8), at)
  const before = c.update(hand(0.8), 300)
  const pinching = c.update(hand(0.1, 0.55), 350)
  assert.equal(pinching.x, before.x)
  assert.equal(c.update(hand(0.4), 400).click, false)
  assert.equal(c.update(hand(0.1), 450).click, false)
  assert.equal(c.update(hand(0.1), 500).click, false)
  assert.equal(c.update(hand(0.1), 550).click, true)
})
test('camera opt-in and microphone contact are independent and reject other documents', () => {
  let check, request, mic = false, camera = false
  const owner = { getURL: () => 'http://127.0.0.1:4600/#/settings' }
  installVoicePermissions({ setPermissionCheckHandler(fn) { check = fn }, setPermissionRequestHandler(fn) { request = fn } }, {
    owns: contents => contents === owner, allows: () => mic, allowsCamera: () => camera,
  })
  const detail = { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4600/#/', mediaType: 'video' }
  assert.equal(check(owner, 'media', '', detail), false)
  camera = true
  assert.equal(check(owner, 'media', '', detail), true)
  assert.equal(check(owner, 'media', '', { ...detail, mediaType: 'audio' }), false)
  mic = true
  let granted
  request(owner, 'media', value => { granted = value }, { ...detail, mediaTypes: ['video', 'audio'] })
  assert.equal(granted, true)
  for (const changed of [{ isMainFrame: false }, { requestingUrl: 'https://example.com' }, { mediaType: 'unknown' }]) {
    assert.equal(check(owner, 'media', '', { ...detail, ...changed }), false)
  }
  camera = false
  assert.equal(check(owner, 'media', '', detail), false)
  assert.equal(check(owner, 'media', '', { ...detail, mediaType: 'audio' }), true)
})
