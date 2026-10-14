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
/* 1.0.49 video box: getDisplayMedia asks as 'media' with EMPTY mediaTypes
   (Electron 43 spike). It is refused by default and allowed only while the
   video host holds a pick for the owned main frame; nothing else changes. */
test('display capture is refused by default and allowed only while a video pick waits for the owned main frame', () => {
  let check, request, waiting = false
  const owner = { getURL: () => 'http://127.0.0.1:4600/#/computers' }
  const other = { getURL: () => 'http://127.0.0.1:4600/#/computers' }
  installVoicePermissions({ setPermissionCheckHandler(fn) { check = fn }, setPermissionRequestHandler(fn) { request = fn } }, {
    owns: contents => contents === owner, allows: () => true, allowsCamera: () => true,
    allowsDisplayCapture: contents => waiting && contents === owner,
  })
  const ask = (contents, details, permission = 'media') => { let answer; request(contents, permission, value => { answer = value }, details); return answer }
  const display = { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4600/#/', mediaTypes: [] }
  assert.equal(ask(owner, display), false, 'no pick waits')
  waiting = true
  assert.equal(ask(owner, display), true)
  for (const changed of [{ isMainFrame: false }, { requestingUrl: 'https://example.com/' }, { mediaTypes: undefined }]) {
    assert.equal(ask(owner, { ...display, ...changed }), false, JSON.stringify(changed))
  }
  assert.equal(ask(other, display), false, 'another window')
  // Microphone and camera follow their own switches, pick or no pick.
  assert.equal(ask(owner, { ...display, mediaTypes: ['audio'] }), true)
  assert.equal(ask(owner, { ...display, mediaTypes: ['video', 'audio'] }), true)
  assert.equal(ask(owner, { ...display, mediaTypes: ['audio', 'audio'] }), false)
  assert.equal(ask(owner, { isMainFrame: true, requestingUrl: display.requestingUrl }, 'notifications'), true, 'other permissions are unchanged')
  assert.equal(check(owner, 'media', '', { isMainFrame: true, requestingUrl: display.requestingUrl }), false, 'a check with no media type never passes')
  let defaults
  installVoicePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler(fn) { defaults = fn } }, { owns: () => true, allows: () => true })
  let answer
  defaults(owner, 'media', value => { answer = value }, display)
  assert.equal(answer, false, 'without a video host, display capture stays refused')
})
/* 1.0.50 M3: THIS SESSION'S GRANTS BELONG TO THE APPLICATION'S OWN PAGE.
   A linked page used to open in a window inside the application's session,
   where every non-media permission answered true from any origin: it could
   read the clipboard and launch any OS protocol handler with no prompt. A page
   from anywhere else now gets nothing, and two permissions no page of this
   application uses are never granted at all. */
test('non-media permissions are granted only to the owned main frame on the application origin', () => {
  const ORIGIN = 'http://127.0.0.1:4600', FOREIGN = 'https://attacker.example'
  let check, request
  const owner = { getURL: () => ORIGIN + '/#/chat' }
  const stranger = { getURL: () => FOREIGN + '/phish' }
  installVoicePermissions({ setPermissionCheckHandler(fn) { check = fn }, setPermissionRequestHandler(fn) { request = fn } }, {
    owns: contents => contents === owner, allows: () => true, allowsCamera: () => true, origin: () => ORIGIN,
  })
  const ask = (contents, permission, details) => { let answer; request(contents, permission, value => { answer = value }, details); return answer }
  const own = { isMainFrame: true, requestingUrl: ORIGIN + '/#/' }
  const foreign = { isMainFrame: true, requestingUrl: FOREIGN + '/phish' }
  for (const permission of ['clipboard-read', 'openExternal', 'notifications', 'geolocation', 'fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'fileSystem']) {
    assert.equal(check(stranger, permission, FOREIGN, foreign), false, `a foreign page's ${permission} check`)
    assert.equal(ask(stranger, permission, { ...foreign, externalURL: 'ms-officecmd:x' }), false, `a foreign page's ${permission} request`)
    assert.equal(check(null, permission, FOREIGN, {}), false, `a foreign origin's ${permission} check with no webContents`)
  }
  // The application's own page keeps what it uses (copy, directory picker, fullscreen).
  for (const permission of ['clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock', 'fileSystem']) {
    assert.equal(check(owner, permission, ORIGIN, own), true, `own ${permission} check`)
    assert.equal(ask(owner, permission, own), true, `own ${permission} request`)
  }
  assert.equal(check(null, 'notifications', ORIGIN + '/', {}), true, 'a check with no webContents is answered by its origin')
  for (const permission of ['clipboard-read', 'openExternal']) {
    assert.equal(check(owner, permission, ORIGIN, own), false, `${permission} is never granted`)
    assert.equal(ask(owner, permission, { ...own, externalURL: 'vscode://file/x' }), false, `${permission} is never granted`)
    assert.equal(check(null, permission, ORIGIN, {}), false, `${permission} is never granted`)
  }
  for (const changed of [{ isMainFrame: false }, { requestingUrl: FOREIGN + '/' }, { requestingUrl: undefined }]) {
    assert.equal(check(owner, 'notifications', ORIGIN, { ...own, ...changed }), false, JSON.stringify(changed))
    assert.equal(ask(owner, 'notifications', { ...own, ...changed }), false, JSON.stringify(changed))
  }
  assert.equal(ask(null, 'notifications', own), false, 'a request always names its webContents')
})
test('voice, camera and display capture are granted only on the application origin', () => {
  const ORIGIN = 'http://127.0.0.1:4600', FOREIGN = 'https://attacker.example/'
  let check, request, address = FOREIGN
  // The owned window itself, after its document has left the application's origin.
  const owner = { getURL: () => address }
  installVoicePermissions({ setPermissionCheckHandler(fn) { check = fn }, setPermissionRequestHandler(fn) { request = fn } }, {
    owns: contents => contents === owner, allows: () => true, allowsCamera: () => true, allowsDisplayCapture: () => true, origin: () => ORIGIN,
  })
  const ask = (permission, details) => { let answer; request(owner, permission, value => { answer = value }, details); return answer }
  const at = url => ({ isMainFrame: true, requestingUrl: url })
  assert.equal(check(owner, 'media', '', { ...at(FOREIGN), mediaType: 'audio' }), false)
  assert.equal(check(owner, 'media', '', { ...at(FOREIGN), mediaType: 'video' }), false)
  assert.equal(ask('media', { ...at(FOREIGN), mediaTypes: ['audio'] }), false)
  assert.equal(ask('media', { ...at(FOREIGN), mediaTypes: [] }), false)
  assert.equal(ask('notifications', at(FOREIGN)), false)
  // Back on the application's own page, voice works exactly as before.
  address = ORIGIN + '/#/chat'
  assert.equal(check(owner, 'media', '', { ...at(ORIGIN + '/#/'), mediaType: 'audio' }), true)
  assert.equal(check(owner, 'media', '', { ...at(ORIGIN + '/#/'), mediaType: 'video' }), true)
  assert.equal(ask('media', { ...at(ORIGIN + '/#/'), mediaTypes: ['audio'] }), true)
  assert.equal(ask('media', { ...at(ORIGIN + '/#/'), mediaTypes: ['audio', 'video'] }), true)
  assert.equal(ask('media', { ...at(ORIGIN + '/#/'), mediaTypes: [] }), true)
})
