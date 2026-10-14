/* 1.0.49 video box, phase 1: the main-process host (shell/video-box-host.cjs),
 * its wiring in shell/main.cjs, and the refusal that keeps agent app control
 * away from the video controls (shell/accessibility-app.cjs).
 *
 * Every rule here was measured in the Electron 43 spike (video-box/spike/REPORT.md):
 * the display handler must answer synchronously and exactly once; the frame's
 * origin, not securityOrigin, is compared; the app's own windows and every id
 * that does not end in ":0" are left out; X11 reuses window ids, so a pick
 * needs the same id and the same name; and agent app control clicks with a
 * real user gesture, so the gesture check alone cannot keep it out.
 *
 * Fakes only: a fake desktopCapturer, fake windows and fake sessions. No
 * Electron process, no display.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shellRequire = createRequire(new URL('../../shell/main.cjs', import.meta.url))
const { createVideoBoxHost, programFromTitle, TOKEN_TTL_MS, PICK_TTL_MS, MAX_SOURCES, GRANT_CHECK_MS, ACTIVATION_WORLD, ACTIVATION_READ_MS } = require('../../shell/video-box-host.cjs')
const { createAgentVideoSources } = require('../../shell/agent-video-sources.cjs')
const { desktopCaptureSupported } = require('../../shell/screen-control-adapter.cjs')
const { createAccessibilityAppAdapter } = require('../../shell/accessibility-app.cjs')
const MAIN = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

const ORIGIN = 'http://127.0.0.1:4600'
const CREATED = '2026-09-26T10:00:00.000Z'
const WINDOWS = Object.freeze([
  { id: 'window:100:1', name: 'ToolsEnabled' }, // the main BrowserWindow
  { id: 'window:200:2', name: 'Screen control' }, // a second BrowserWindow
  { id: 'window:100:3', name: 'DevTools - 127.0.0.1:4600/' }, // detached DevTools: not a BrowserWindow
  { id: 'window:500:0', name: 'Own window with a :0 id' }, // listed by getMediaSourceId, so still ours
  { id: 'screen:0:0', name: 'Entire screen' },
  { id: 'window:300:0', name: 'ROS \u00b7 agent' },
  { id: 'window:400:0', name: 'notes.txt - Mousepad' },
])

function fixture(t, { windows = WINDOWS, supported = true } = {}) {
  let clock = Date.parse('2026-09-26T10:05:00.000Z')
  let listed = [...windows]
  let gate = null
  const lists = []
  const desktopCapturer = {
    async getSources(options) {
      lists.push(options)
      if (gate) await gate
      return listed.map(window => ({ ...window, thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' } }))
    },
  }
  const ownIds = ['window:100:1', 'window:200:2', 'window:500:0']
  const BrowserWindow = { getAllWindows: () => ownIds.map(id => ({ getMediaSourceId: () => id })) }
  const state = { supported, active: true }
  // Main reads the page's click itself, in its own isolated world.
  const reads = []
  const makeOwner = () => {
    const owner = { destroyed: false, isDestroyed() { return this.destroyed },
      executeJavaScriptInIsolatedWorld(world, scripts, gesture) {
        reads.push({ world, code: scripts?.[0]?.code, gesture })
        return state.active === 'never' ? new Promise(() => {}) : Promise.resolve(state.active)
      } }
    owner.mainFrame = { origin: ORIGIN, owner }
    return owner
  }
  const owner = makeOwner(), other = makeOwner()
  const webContents = { fromFrame: frame => frame?.owner ?? null }
  const nodes = new Map(['node-a', 'node-b', 'node-c'].map(nodeId => [nodeId, { treeId: 'tree-1', nodeId, nodeCreatedAt: CREATED }]))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-box-host-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createAgentVideoSources({ directory, now: () => new Date(clock) })
  // Timers wait for the test to run them; a stray capture's reload is recorded.
  const timers = new Map()
  let nextTimer = 0
  const stray = []
  const host = createVideoBoxHost({ desktopCapturer, BrowserWindow, webContents, shellOrigin: () => ORIGIN,
    supported: () => state.supported, store, readIdentity: () => nodeId => nodes.get(nodeId) ?? null, now: () => clock,
    setTimer: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer },
    clearTimer: id => { timers.delete(id) },
    endStrayCapture: contents => { stray.push(contents) } })
  return {
    host, owner, other, nodes, store, lists, state, webContents, reads, timers, stray,
    runTimers: () => { for (const [id, { callback }] of [...timers]) { timers.delete(id); callback() } },
    advance: ms => { clock += ms },
    setWindows: next => { listed = [...next] },
    hold: () => { let release; gate = new Promise(resolve => { release = () => { gate = null; resolve() } }); return release },
  }
}
async function tokenFor(f, name, owner = f.owner) {
  const answer = await f.host.sources(owner)
  assert.equal(answer.ok, true)
  const row = answer.sources.find(source => source.name === name)
  assert.ok(row, `the list offers ${name}`)
  return row.token
}
async function armed(f, nodeId = 'node-a', name = 'ROS \u00b7 agent') {
  const answer = await f.host.arm(f.owner, { token: await tokenFor(f, name), nodeId })
  assert.equal(answer.ok, true)
}
function request(f, overrides = {}) {
  return { frame: f.owner.mainFrame, securityOrigin: ORIGIN + '/', videoRequested: true, audioRequested: false, userGesture: true, ...overrides }
}
/* Electron's order: the permission gate for the owner, then the display
   handler. Calls the real handler and proves it answered exactly once before
   returning. */
function ask(f, overrides = {}, { permit = true } = {}) {
  if (permit) f.host.allowsDisplayCapture(f.owner)
  const answers = []
  f.host.displayHandler(f.owner)(request(f, overrides), streams => answers.push(streams))
  assert.equal(answers.length, 1, 'the handler answers exactly once, synchronously')
  return answers[0]
}

test('the list leaves out every window of this app, DevTools and whole screens, gives tokens instead of ids, and stops at 40', async t => {
  const f = fixture(t)
  const answer = await f.host.sources(f.owner)
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.sources.map(source => source.name), ['ROS \u00b7 agent', 'notes.txt - Mousepad'])
  // 1.0.50 review video F7: how many other windows there are, so the list can say when it was cut.
  assert.equal(answer.total, 2, 'the app\u2019s own windows and whole screens are not counted')
  for (const source of answer.sources) {
    assert.deepEqual(Object.keys(source).sort(), ['name', 'thumbnail', 'token'])
    assert.match(source.token, /^[0-9a-f]{32}$/)
  }
  assert.equal(JSON.stringify(answer).includes('window:'), false, 'the renderer never sees a window id')
  assert.deepEqual(f.lists[0], { types: ['window'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false })
  f.setWindows(Array.from({ length: 50 }, (_, index) => ({ id: `window:${1000 + index}:0`, name: 'Window ' + index })))
  const many = await f.host.sources(f.owner)
  assert.equal(many.sources.length, MAX_SOURCES)
  assert.equal(many.total, 50)
})

test('video is offered only on Windows and on a Linux X11 desktop, the one rule screen control uses', async t => {
  const f = fixture(t, { supported: false })
  assert.deepEqual(await f.host.sources(f.owner), { ok: false, code: 'VIDEO_UNAVAILABLE', reason: 'Video is not available on this desktop. It needs Windows or a Linux desktop that uses X11.' })
  assert.equal((await f.host.arm(f.owner, { token: 'a'.repeat(32), nodeId: 'node-a' })).code, 'VIDEO_UNAVAILABLE')
  assert.equal(f.lists.length, 0, 'no window is listed where video is unavailable')
  assert.equal(f.host.saved().supported, false)
  const cases = [
    [{ platform: 'win32', environment: {} }, true],
    [{ platform: 'linux', environment: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' } }, true],
    [{ platform: 'linux', environment: { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' } }, false],
    [{ platform: 'linux', environment: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } }, false],
    [{ platform: 'linux', environment: {} }, false],
    [{ platform: 'darwin', environment: { DISPLAY: ':0' } }, false],
  ]
  for (const [input, expected] of cases) assert.equal(desktopCaptureSupported(input), expected, JSON.stringify(input))
})

test('a token works only for the window that listed it, for 60 seconds, until the next list', async t => {
  const f = fixture(t)
  const token = await tokenFor(f, 'ROS \u00b7 agent')
  assert.equal((await f.host.arm(f.other, { token, nodeId: 'node-a' })).code, 'VIDEO_PICK_EXPIRED', 'another owner cannot use it')
  f.advance(TOKEN_TTL_MS)
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).code, 'VIDEO_PICK_EXPIRED', 'it expires')
  const fresh = await tokenFor(f, 'ROS \u00b7 agent')
  await tokenFor(f, 'ROS \u00b7 agent')
  assert.equal((await f.host.arm(f.owner, { token: fresh, nodeId: 'node-a' })).code, 'VIDEO_PICK_EXPIRED', 'a new list ends the old tokens')
  for (const bad of [null, 'token', [], { token: fresh }, { token: fresh, nodeId: 'node-a', id: 'window:300:0' },
    { token: 'x', nodeId: 'node-a' }, { token: 'a'.repeat(32), nodeId: '' }, { token: 'a'.repeat(32), nodeId: 'bad\nid' }]) {
    assert.equal((await f.host.arm(f.owner, bad)).code, 'VIDEO_REQUEST_INVALID', JSON.stringify(bad))
  }
})

test('the pick is checked again when armed: the same id AND the same name, still not an app window', async t => {
  const f = fixture(t)
  let token = await tokenFor(f, 'ROS \u00b7 agent')
  // X11 handed the id to a different window.
  f.setWindows(WINDOWS.map(window => window.id === 'window:300:0' ? { ...window, name: 'Private mail' } : window))
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).code, 'VIDEO_WINDOW_GONE')
  f.setWindows(WINDOWS)
  token = await tokenFor(f, 'ROS \u00b7 agent')
  f.setWindows(WINDOWS.filter(window => window.id !== 'window:300:0'))
  const closed = await f.host.arm(f.owner, { token, nodeId: 'node-a' })
  assert.equal(closed.code, 'VIDEO_WINDOW_GONE', 'the window closed')
  // 1.0.50 review video F5: on X11 a minimized window drops out of the list too, so the reason says so.
  assert.equal(closed.reason, 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.')
  assert.equal(f.host.allowsDisplayCapture(f.owner), false)
  assert.deepEqual(f.lists.at(-1), { types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
  f.setWindows(WINDOWS)
  token = await tokenFor(f, 'ROS \u00b7 agent')
  f.nodes.delete('node-a')
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).code, 'VIDEO_AGENT_GONE', 'only an agent on this computer\u2019s tree')
})

test('one pick waits at a time, for 10 seconds, including while an earlier pick is still being checked', async t => {
  const f = fixture(t)
  const token = await tokenFor(f, 'ROS \u00b7 agent')
  const release = f.hold()
  const first = f.host.arm(f.owner, { token, nodeId: 'node-a' })
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-b' })).code, 'VIDEO_PICK_PENDING', 'a second pick during the check')
  release()
  assert.equal((await first).ok, true)
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-b' })).code, 'VIDEO_PICK_PENDING', 'a second pick while one waits')
  f.advance(PICK_TTL_MS)
  assert.equal(f.host.allowsDisplayCapture(f.owner), false, 'an expired pick opens nothing')
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-b' })).ok, true, 'an expired pick no longer blocks')
})

test('the display handler grants the armed window once, to the owner\u2019s main frame, at the app origin, after a click', async t => {
  const f = fixture(t)
  assert.equal(f.host.allowsDisplayCapture(f.owner), false, 'the permission gate is shut until a pick waits')
  await armed(f)
  assert.equal(f.host.allowsDisplayCapture(f.owner), true)
  assert.equal(f.host.allowsDisplayCapture(f.other), false, 'only for the owner that armed it')
  assert.deepEqual(ask(f), { video: { id: 'window:300:0', name: 'ROS \u00b7 agent' } })
  assert.equal(f.host.allowsDisplayCapture(f.owner), false, 'the pick is used up')
  assert.deepEqual(ask(f), {}, 'one pick, one stream')
})

test('the display handler refuses every other request and still uses the pick up', async t => {
  const cases = {
    'no frame': f => ({ frame: null }),
    'another window': f => ({ frame: f.other.mainFrame }),
    'a frame inside the page': f => ({ frame: { origin: ORIGIN, owner: f.owner } }),
    'another origin': f => { f.owner.mainFrame.origin = 'https://example.com'; return {} },
    'an origin with a trailing slash': f => { f.owner.mainFrame.origin = ORIGIN + '/'; return {} },
    'no user gesture': () => ({ userGesture: false }),
    'an unknown gesture': () => ({ userGesture: undefined }),
    'audio too': () => ({ audioRequested: true }),
    'no video': () => ({ videoRequested: false }),
    'a closed window': f => { f.owner.destroyed = true; return {} },
    'a frame lookup that throws': f => { f.webContents.fromFrame = () => { throw new Error('frame gone') }; return {} },
  }
  for (const [name, change] of Object.entries(cases)) {
    const f = fixture(t)
    await armed(f)
    assert.deepEqual(ask(f, change(f)), {}, name)
    assert.equal(f.host.allowsDisplayCapture(f.owner), false, `${name}: the refused request used the pick up`)
    f.owner.destroyed = false
    f.owner.mainFrame.origin = ORIGIN
    f.webContents.fromFrame = frame => frame?.owner ?? null
    assert.deepEqual(ask(f), {}, `${name}: a correct request after it has no pick`)
  }
  const f = fixture(t)
  assert.deepEqual(ask(f), {}, 'no pick at all')
  await armed(f)
  f.advance(PICK_TTL_MS)
  assert.deepEqual(ask(f), {}, 'an expired pick')
})

/* REVIEW F1 (1.0.49 security review), measured in Electron 43.3.0: the
   permission request Electron sends for getDisplayMedia is the same one it
   sends for the old getUserMedia desktop capture ({chromeMediaSource:
   'desktop'}), which never reaches the display handler. That path took the
   whole screen, the app's own window and system audio with no click. So a
   pick lets exactly one request through the gate, and a grant the display
   handler never took reloads the page, which ends every capture. */
test('a pick lets one capture request through; a grant the display handler never took reloads the page', async t => {
  const f = fixture(t)
  await armed(f)
  assert.equal(f.host.allowsDisplayCapture(f.owner), true, 'the first request after the pick')
  assert.equal(f.host.allowsDisplayCapture(f.owner), false, 'a second request on the same pick')
  assert.equal(f.host.allowsDisplayCapture(f.other), false)
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [GRANT_CHECK_MS], 'one check waits for the display handler')
  // The page cannot call the check off: not by forgetting, clearing or picking again.
  assert.deepEqual(f.host.forget(f.owner, { nodeId: 'node-a', pickOnly: true }), { ok: true })
  assert.deepEqual(f.host.forget(f.owner, { nodeId: 'node-a' }), { ok: true })
  assert.deepEqual(f.host.clear(f.owner), { ok: true })
  assert.equal((await f.host.arm(f.owner, { token: await tokenFor(f, 'notes.txt - Mousepad'), nodeId: 'node-b' })).code, 'VIDEO_PICK_PENDING',
    'no new pick while a grant is out')
  assert.equal(f.stray.length, 0)
  f.runTimers()
  assert.equal(f.stray.length, 1, 'the grant went to another kind of capture: the page reloads')
  assert.equal(f.stray[0] === f.owner, true, 'only the window that armed the pick')
  assert.deepEqual(ask(f), {}, 'nothing is left to grant')
  // The intended order: the display handler takes the grant, and nothing reloads.
  await armed(f)
  assert.equal(f.host.allowsDisplayCapture(f.owner), true)
  assert.deepEqual(ask(f, {}, { permit: false }), { video: { id: 'window:300:0', name: 'ROS · agent' } })
  assert.equal(f.timers.size, 0, 'the display handler calls the check off')
  f.runTimers()
  assert.equal(f.stray.length, 1)
  // A refused display request also uses the grant up, and reloads nothing.
  await armed(f)
  assert.deepEqual(ask(f, { userGesture: false }), {})
  assert.equal(f.timers.size, 0)
  // A reload or a closed window drops a grant that is still out; its check then does nothing.
  await armed(f)
  assert.equal(f.host.allowsDisplayCapture(f.owner), true)
  f.host.close(f.owner)
  f.runTimers()
  assert.equal(f.stray.length, 1)
})

test('listing the windows and arming a pick need the person’s own click, read by main where the page cannot fake it', async t => {
  const f = fixture(t)
  f.state.active = false
  assert.deepEqual(await f.host.sources(f.owner), { ok: false, code: 'VIDEO_NEEDS_CLICK', reason: 'Video starts only from your own click. Press the button again.' })
  assert.equal(f.lists.length, 0, 'no window is listed and no thumbnail is made')
  f.state.active = true
  const token = await tokenFor(f, 'ROS · agent')
  f.state.active = false
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).code, 'VIDEO_NEEDS_CLICK')
  assert.equal(f.host.allowsDisplayCapture(f.owner), false, 'nothing was armed')
  // Main asks in its own isolated world, without a gesture of its own.
  assert.equal(f.reads.length, 3)
  assert.equal(f.reads.every(read => read.world === ACTIVATION_WORLD && read.gesture === false), true)
  assert.equal(ACTIVATION_WORLD !== 0 && ACTIVATION_WORLD !== 1004, true, 'neither the page’s world nor app control’s')
  assert.equal(f.reads.every(read => /navigator\.userActivation/.test(read.code || '')), true)
  // A read that never answers counts as no click, and does not hold up the next pick.
  f.state.active = 'never'
  const waiting = f.host.arm(f.owner, { token, nodeId: 'node-a' })
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-b' })).code, 'VIDEO_PICK_PENDING', 'one pick is checked at a time')
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [ACTIVATION_READ_MS])
  f.runTimers()
  assert.equal((await waiting).code, 'VIDEO_NEEDS_CLICK')
  f.state.active = true
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).ok, true)
})

test('a reload or a closed window ends the list, the waiting pick and any check still running', async t => {
  const f = fixture(t)
  const token = await tokenFor(f, 'ROS \u00b7 agent')
  let release = f.hold()
  const arming = f.host.arm(f.owner, { token, nodeId: 'node-a' })
  f.host.close(f.owner)
  release()
  assert.equal((await arming).code, 'VIDEO_PAGE_CHANGED')
  assert.equal(f.host.allowsDisplayCapture(f.owner), false)
  assert.equal((await f.host.arm(f.owner, { token, nodeId: 'node-a' })).code, 'VIDEO_PICK_EXPIRED', 'the old list is gone')
  release = f.hold()
  const listing = f.host.sources(f.owner)
  f.host.close(f.owner)
  release()
  assert.equal((await listing).code, 'VIDEO_PAGE_CHANGED')
  await armed(f)
  f.host.close(f.owner)
  assert.equal(f.host.allowsDisplayCapture(f.owner), false)
  assert.deepEqual(ask(f), {})
  // A window that is already closed is not listed to and cannot arm.
  const listed = f.lists.length
  f.owner.destroyed = true
  assert.equal((await f.host.sources(f.owner)).code, 'VIDEO_PAGE_CHANGED')
  assert.equal((await f.host.arm(f.owner, { token: 'a'.repeat(32), nodeId: 'node-a' })).code, 'VIDEO_PAGE_CHANGED')
  assert.equal(f.lists.length, listed, 'no window list is read for a closed window')
})

test('remembering saves the title of the window actually granted, never one the page names', async t => {
  const f = fixture(t)
  assert.equal(f.host.remember(f.owner, { nodeId: 'node-a' }).code, 'VIDEO_NOT_STARTED')
  await armed(f, 'node-a', 'notes.txt - Mousepad')
  assert.equal(ask(f).video.name, 'notes.txt - Mousepad')
  assert.equal(f.host.remember(f.owner, { nodeId: 'node-a', title: 'Something else' }).code, 'VIDEO_REQUEST_INVALID')
  assert.equal(f.host.remember(f.owner, { nodeId: 'node-b' }).code, 'VIDEO_NOT_STARTED', 'a grant belongs to its agent')
  assert.equal(f.host.remember(f.other, { nodeId: 'node-a' }).code, 'VIDEO_NOT_STARTED', 'and to its window')
  const answer = f.host.remember(f.owner, { nodeId: 'node-a' })
  assert.deepEqual(answer, { ok: true, saved: { nodeId: 'node-a', title: 'notes.txt - Mousepad', app: 'Mousepad', savedAt: '2026-09-26T10:05:00.000Z' } })
  const onDisk = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).sources
  assert.deepEqual(onDisk, [{ treeId: 'tree-1', nodeId: 'node-a', nodeCreatedAt: CREATED, title: 'notes.txt - Mousepad', app: 'Mousepad', savedAt: '2026-09-26T10:05:00.000Z' }])
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes('window:'), false)
  assert.equal(f.host.remember(f.owner, { nodeId: 'node-a' }).code, 'VIDEO_NOT_STARTED', 'a grant is remembered once')
  assert.equal(programFromTitle('ROS \u00b7 agent'), '')
  assert.equal(programFromTitle('Report \u2014 LibreOffice Writer'), 'LibreOffice Writer')
})

test('the saved choices list only agents still on the tree; turning video off forgets them', async t => {
  const f = fixture(t)
  for (const nodeId of ['node-a', 'node-b', 'node-c']) {
    await armed(f, nodeId)
    assert.equal(ask(f).video.id, 'window:300:0')
    assert.equal(f.host.remember(f.owner, { nodeId }).ok, true)
  }
  f.nodes.delete('node-c')
  f.nodes.set('node-b', { ...f.nodes.get('node-b'), nodeCreatedAt: '2026-09-26T11:00:00.000Z' })
  const saved = f.host.saved()
  assert.equal(saved.ok, true)
  assert.equal(saved.supported, true)
  assert.deepEqual(saved.records, [{ nodeId: 'node-a', title: 'ROS \u00b7 agent', app: '', savedAt: '2026-09-26T10:05:00.000Z' }])
  // A start that failed withdraws only its waiting pick; the saved choice stays for a retry.
  await armed(f, 'node-a')
  assert.deepEqual(f.host.forget(f.owner, { nodeId: 'node-a', pickOnly: true }), { ok: true })
  assert.equal(f.host.allowsDisplayCapture(f.owner), false)
  assert.deepEqual(f.host.saved().records.map(record => record.nodeId), ['node-a'])
  for (const bad of [{ nodeId: 'node-a', pickOnly: false }, { nodeId: 'node-a', pickOnly: 'yes' }, { nodeId: 'node-a', all: true }]) {
    assert.equal(f.host.forget(f.owner, bad).code, 'VIDEO_REQUEST_INVALID', JSON.stringify(bad))
  }
  // Turning one agent off drops its waiting pick and its saved choice.
  await armed(f, 'node-a')
  assert.deepEqual(f.host.forget(f.owner, { nodeId: 'node-a' }), { ok: true })
  assert.equal(f.host.allowsDisplayCapture(f.owner), false)
  assert.deepEqual(f.host.saved().records, [])
  await armed(f, 'node-b')
  ask(f)
  f.host.remember(f.owner, { nodeId: 'node-b' })
  assert.deepEqual(f.host.clear(f.owner), { ok: true })
  assert.equal(fs.existsSync(f.store.file), false, '"Turn off all video" forgets every choice')
  const broken = createVideoBoxHost({ desktopCapturer: { getSources: async () => [] }, BrowserWindow: { getAllWindows: () => [] },
    webContents: { fromFrame: () => null }, shellOrigin: () => ORIGIN, supported: () => true, store: f.store,
    readIdentity: () => { throw Object.assign(new Error('The saved tree parser is not ready.'), { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' }) } })
  assert.equal(broken.saved().code, 'VIDEO_SAVED_UNAVAILABLE', 'an unreadable tree prunes nothing')
})

/* ---- shell/main.cjs wiring ------------------------------------------------ */

function slice(start, end) {
  const first = MAIN.indexOf(start)
  const last = MAIN.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, `main.cjs no longer has ${start} .. ${end}`)
  return MAIN.slice(first, last)
}

test('each video channel checks for the app\u2019s own main frame before it reaches the host', async () => {
  const first = MAIN.indexOf("ipcMain.handle('mc-video-box:sources'")
  const lastStart = MAIN.indexOf("ipcMain.handle('mc-video-box:clear'")
  assert.ok(first >= 0 && lastStart > first, 'main registers the video channels together')
  const block = MAIN.slice(first, MAIN.indexOf('\n', lastStart))
  const handlers = new Map()
  const calls = []
  const videoBoxHost = Object.fromEntries(['sources', 'arm', 'forget', 'saved', 'remember', 'clear'].map(name =>
    [name, (owner, value) => { calls.push({ name, owner, value }); return { ok: true, name } }]))
  vm.runInNewContext(block, {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedAgentSender: event => { if (event?.trusted !== true) throw Object.assign(new Error('refused'), { code: 'MC_AGENT_SENDER_REFUSED' }) },
    videoBoxHost,
  })
  assert.deepEqual([...handlers.keys()].sort(), ['mc-video-box:arm', 'mc-video-box:clear', 'mc-video-box:forget',
    'mc-video-box:remember', 'mc-video-box:saved', 'mc-video-box:sources'])
  const sender = { id: 'owner' }
  for (const [channel, handler] of handlers) {
    const name = channel.slice('mc-video-box:'.length)
    await assert.rejects(async () => handler({ trusted: false, sender }, { nodeId: 'node-a' }), { code: 'MC_AGENT_SENDER_REFUSED' }, channel)
    assert.equal(calls.length, 0, `${channel} reached the host from an untrusted frame`)
    assert.deepEqual(await handler({ trusted: true, sender }, { nodeId: 'node-a' }), { ok: true, name })
    const call = calls.pop()
    assert.equal(call.name, name)
    assert.equal(call.owner, sender, `${channel} acts for the sending window only`)
    assert.deepEqual(call.value, ['sources', 'saved', 'clear'].includes(name) ? undefined : { nodeId: 'node-a' })
  }
})

test('the window\u2019s session gets the synchronous display handler and the gated display permission', () => {
  const block = slice('  // Voice and opt-in hand controls hold separate media permissions.', "  window.on('blur'")
  let requestHandler, installedDisplay
  let waiting = false, address = ORIGIN + '/#/'
  const inputOwner = { getURL: () => address, session: {
    setPermissionCheckHandler() {}, setPermissionRequestHandler(fn) { requestHandler = fn },
    setDisplayMediaRequestHandler(fn, options) { installedDisplay = { fn, options } },
  } }
  const displayHandler = () => {}
  const videoBoxHost = {
    allowsDisplayCapture: contents => contents === inputOwner && waiting,
    displayHandler: owner => { assert.equal(owner, inputOwner); return displayHandler },
  }
  vm.runInNewContext(block, {
    require: name => { assert.equal(name, './voice-permissions.cjs'); return shellRequire('./voice-permissions.cjs') },
    inputOwner, videoBoxHost, voiceHost: { allowsMicrophone: () => false }, handCameraOwners: new Set(),
    window: { isDestroyed: () => false, isFocused: () => true }, shellOrigin: ORIGIN,
  })
  assert.equal(installedDisplay?.fn, displayHandler, 'the host\u2019s handler answers getDisplayMedia')
  assert.equal(installedDisplay.options, undefined, 'no system picker')
  const ask = (requestingUrl = ORIGIN + '/#/') => { let answer; requestHandler(inputOwner, 'media', value => { answer = value }, { isMainFrame: true, requestingUrl, mediaTypes: [] }); return answer }
  assert.equal(ask(), false)
  waiting = true
  assert.equal(ask(), true)
  // 1.0.50 M3: main hands the session its own origin, so the window after
  // leaving that origin is refused even while a pick waits.
  address = 'https://attacker.example/'
  assert.equal(ask(address), false, 'only the application origin is granted')
})

test('main ends a stray capture by reloading that window, and never through a page request', () => {
  const block = slice("const videoBoxHost = require('./video-box-host.cjs').createVideoBoxHost({", '\n})')
  assert.match(block, /endStrayCapture: owner => \{ if \(!owner\.isDestroyed\(\)\) owner\.reload\(\) \}/)
  // close() also ends a grant that is still out, so no page channel may reach it.
  const channels = MAIN.slice(MAIN.indexOf("ipcMain.handle('mc-video-box:sources'"), MAIN.indexOf("ipcMain.handle('mc-accessibility:prepareEnable'"))
  assert.equal(/videoBoxHost\.close\(/.test(channels), false)
})

test('a closed window closes the video host; a reload is covered by the navigation handler', () => {
  const block = slice("  inputOwner.once('destroyed', () => {", '  /* A RELOAD IS A MAIN-FRAME NAVIGATION')
  let destroyed
  const closed = []
  const inputOwner = { once: (name, handler) => { assert.equal(name, 'destroyed'); destroyed = handler } }
  const owned = name => ({ close: owner => { assert.equal(owner, inputOwner); closed.push(name) } })
  vm.runInNewContext(block, {
    inputOwner, handCameraOwners: new Set(),
    accessibilityApp: { invalidateDocument() {} }, accessibilityHost: owned('accessibility'),
    screenControlHost: owned('screen-control'), voiceHost: owned('voice'), videoBoxHost: owned('video'),
  })
  destroyed()
  assert.equal(closed.includes('video'), true)
  const navigation = slice("  window.webContents.on('did-start-navigation', details => {", "  window.webContents.on('did-finish-load'")
  assert.match(navigation, /videoBoxHost\.close\(inputOwner\)/)
})

test('the video choice file is shell-owned, sealed by Erase, removed by Erase with the node data and by delete-on-exit', () => {
  assert.match(MAIN, /createAgentVideoSources\(\{\s*directory: app\.getPath\('userData'\),\s*sealed: \(\) => localDataErased,?\s*\}\)/)
  const cleanup = slice("const nodePrivacyCleanup = require('./node-privacy-cleanup.cjs').createNodePrivacyCleanup({", '\n})')
  assert.match(cleanup, /videoSources: agentVideoSources/)
  const erase = slice("ipcMain.handle('mc-reset:erase'", '/* Two ways to get the bootstrap proof')
  const priority = erase.slice(erase.indexOf('priority: ['), erase.indexOf('],', erase.indexOf('priority: [')))
  const names = [...priority.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.equal(names[names.indexOf('renderer-fleet-documents.json') + 1], 'agent-video-sources.json',
    'the saved video choices go with the saved trees')
})

/* ---- agent app control ---------------------------------------------------- */

/* A small element model that answers what appControlWorld asks, including
   comma selector lists in closest(), which the shared DOM stand-in does not. */
class Control {
  constructor(tag, label, { attributes = {}, parent = null, type = undefined } = {}) {
    Object.assign(this, { tagName: tag, _label: label, attributes: { ...attributes }, parent, type, clicks: 0,
      disabled: false, readOnly: false, autocomplete: '', isConnected: true })
  }
  get textContent() { return this._label }
  get parentElement() { return this.parent }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null }
  getClientRects() { return [{ width: 10, height: 10 }] }
  querySelector() { return null }
  matchesOne(selector) {
    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)
    if (attribute) return Object.hasOwn(this.attributes, attribute[1]) && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2])
    if (selector.startsWith('.')) return String(this.attributes.class || '').split(/\s+/).includes(selector.slice(1))
    return false
  }
  closest(selector) {
    const parts = selector.split(',').map(part => part.trim())
    for (let node = this; node; node = node.parent) if (parts.some(part => node.matchesOne(part))) return node
    return null
  }
  click() { this.clicks++ }
}

test('agent app control cannot see or press the video controls, the window list or a panel', async () => {
  const page = new Control('DIV', '')
  const settings = new Control('BUTTON', 'Open settings', { parent: page })
  const section = new Control('SECTION', '', { attributes: { 'data-video-box-controls': '' }, parent: page })
  const turnOn = new Control('BUTTON', 'Turn on video\u2026', { parent: section })
  const turnOff = new Control('BUTTON', 'Turn off all video', { parent: section })
  const picker = new Control('DIALOG', '', { attributes: { 'data-video-box-controls': '' }, parent: page })
  const windowChoice = new Control('BUTTON', 'ROS \u00b7 agent', { parent: picker })
  const panel = new Control('DIV', '', { attributes: { 'data-video-box-controls': '', class: 'tree-box-video' }, parent: page })
  const resume = new Control('BUTTON', 'Click to resume', { parent: panel })
  const later = new Control('DIV', '', { parent: page })
  const moving = new Control('BUTTON', 'Pick', { parent: later })
  const controls = [settings, turnOn, turnOff, windowChoice, resume, moving]
  const context = vm.createContext({
    location: new URL(ORIGIN + '/#/computers'), crypto: { randomUUID }, Map, WeakRef, Date,
    document: { querySelectorAll: () => controls },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  })
  const gestures = []
  const owner = {
    isDestroyed: () => false,
    async executeJavaScriptInIsolatedWorld(world, scripts, gesture) {
      assert.equal(world, 1004)
      gestures.push(gesture)
      return vm.runInContext(scripts[0].code, context)
    },
  }
  const adapter = createAccessibilityAppAdapter({ profileRoot: '\x43:\\Users\\redacted-profile', trustedOrigin: () => ORIGIN })
  const mode = { owner, controller: new AbortController() }
  const inspected = await adapter.inspect(mode)
  const labels = inspected.controls.map(control => control.label)
  assert.equal(labels.includes('Open settings'), true, 'ordinary controls stay usable')
  for (const hidden of ['Turn on video\u2026', 'Turn off all video', 'ROS \u00b7 agent', 'Click to resume']) {
    assert.equal(labels.includes(hidden), false, `agent app control was offered "${hidden}"`)
  }
  // A control that is inside the video controls when pressed is refused too.
  const target = inspected.controls.find(control => control.label === 'Pick')
  later.attributes['data-video-box-controls'] = ''
  const action = adapter.plan({ kind: 'click', targetId: target.id }, mode)
  await assert.rejects(action.execute(mode.controller.signal), /changed or expired/)
  assert.equal(moving.clicks, 0)
  // Why the gesture check cannot be the gate: app control presses with a gesture.
  const again = await adapter.inspect(mode)
  const open = again.controls.find(control => control.label === 'Open settings')
  await adapter.plan({ kind: 'click', targetId: open.id }, mode).execute(mode.controller.signal)
  assert.equal(settings.clicks, 1)
  assert.equal(gestures.at(-1), true)
})
