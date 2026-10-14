import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createVideoBoxBroker, videoBoxBroker, videoBoxConstraints,
  VIDEO_BOX_CHANGE_EVENT, VIDEO_BOX_IDLE_MS, VIDEO_BOX_LIMIT,
} from '../../src/video-box-broker.js'

/* 1.0.49 VIDEO BOX, the renderer's stream holder (SPEC-49 delivery B).
   The page and main are stand-ins: a window with the preload's mcVideoBox
   shape and a getDisplayMedia that hands back fake tracks. Every assertion is
   on the broker's own answers and on what it asked the page to do. */

const FULL = rate => ({ width: { max: 854 }, height: { max: 480 }, frameRate: { max: rate } })
const TOKEN = index => String(index).padStart(32, 'a').slice(-32).replace(/[^0-9a-f]/g, 'a')

function fakeTrack() {
  const listeners = new Map()
  return {
    readyState: 'live', stopped: 0, applied: [],
    stop() { this.stopped++; this.readyState = 'ended' },
    applyConstraints(constraints) { this.applied.push(constraints); return Promise.resolve() },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener) },
    fire(type) { for (const listener of listeners.get(type) || []) listener({ type }) },
  }
}

function fakePage({ bridge = true, media = true } = {}) {
  const listeners = new Map(), docListeners = new Map()
  const calls = [], events = [], tracks = []
  const answers = { arm: { ok: true }, remember: { ok: true, saved: {} }, forget: { ok: true }, clear: { ok: true },
    sources: { ok: true, sources: [] }, media: null }
  const on = map => (type, listener) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(listener) }
  const off = map => (type, listener) => map.get(type)?.delete(listener)
  const win = {
    addEventListener: on(listeners), removeEventListener: off(listeners),
    dispatchEvent(event) { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); return true },
    document: { visibilityState: 'visible', addEventListener: on(docListeners), removeEventListener: off(docListeners) },
    navigator: {},
  }
  if (media) {
    win.navigator.mediaDevices = {
      async getDisplayMedia(constraints) {
        calls.push(['getDisplayMedia', structuredClone(constraints)])
        if (answers.media) throw answers.media
        const track = fakeTrack()
        tracks.push(track)
        return { getVideoTracks: () => [track], getTracks: () => [track] }
      },
    }
  }
  if (bridge) {
    win.mcVideoBox = Object.freeze({
      sources: async () => { calls.push(['sources']); return answers.sources },
      arm: async request => { calls.push(['arm', request]); return answers.arm },
      forget: async request => { calls.push(['forget', request]); return answers.forget },
      saved: async () => ({ ok: true, records: [] }),
      remember: async request => { calls.push(['remember', request]); return answers.remember },
      clear: async () => { calls.push(['clear']); return answers.clear },
    })
  }
  const fire = type => { for (const listener of listeners.get(type) || []) listener({ type }) }
  const fireDocument = type => { for (const listener of docListeners.get(type) || []) listener({ type }) }
  return { win, calls, events, tracks, answers, listeners, fire, fireDocument }
}

function fakeTimers() {
  const timers = new Map()
  let next = 0
  return {
    timers,
    setTimer: (callback, ms) => { timers.set(++next, { callback, ms }); return next },
    clearTimer: id => { timers.delete(id) },
    runAll() { for (const [id, { callback }] of [...timers]) { timers.delete(id); callback() } },
  }
}

function subject(options = {}) {
  const page = fakePage(options)
  const clock = fakeTimers()
  const broker = createVideoBoxBroker({ host: page.win, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  return { page, clock, broker }
}
const changes = page => page.events.filter(event => event.type === VIDEO_BOX_CHANGE_EVENT)

test('without the desktop bridge the broker does nothing and says why', async () => {
  for (const options of [{ bridge: false }, { media: false }]) {
    const { page, broker } = subject(options)
    assert.equal(broker.available(), false)
    const answer = await broker.start('node-1', { token: TOKEN(1), label: 'ROS · agent' })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'VIDEO_UNAVAILABLE')
    assert.equal(typeof answer.reason, 'string')
    assert.deepEqual(page.calls, [], 'nothing is armed or captured')
    assert.equal(page.listeners.size, 0, 'no page listener is installed')
    assert.equal(broker.get('node-1'), null)
    assert.equal(broker.retain([]), 0)
    assert.deepEqual(await broker.stop('node-1'), { ok: true })
  }
  // The shared broker reads the page lazily: with no window at all it is inert too.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    delete globalThis.window
    assert.equal(videoBoxBroker().available(), false)
    assert.equal(videoBoxBroker(), videoBoxBroker(), 'one broker per page')
  } finally { if (saved) Object.defineProperty(globalThis, 'window', saved) }
})

test('start arms the pick first, then asks for the window with the full constraint set', async () => {
  const { page, broker } = subject()
  assert.equal(broker.available(), true)
  const answer = await broker.start('node-1', { token: TOKEN(1), label: 'ROS · agent' })
  assert.deepEqual(answer, { ok: true, remembered: true })
  assert.deepEqual(page.calls, [
    ['arm', { token: TOKEN(1), nodeId: 'node-1' }],
    ['getDisplayMedia', { video: FULL(10), audio: false }],
    ['remember', { nodeId: 'node-1' }],
  ], 'arm, then capture, then remember; main saves the granted title, never one this page sends')
  const view = broker.get('node-1')
  assert.equal(view.state, 'live')
  assert.equal(view.label, 'ROS · agent')
  assert.equal(view.stream.getVideoTracks()[0], page.tracks[0])
  assert.deepEqual(changes(page).map(event => event.detail.nodeIds), [['node-1'], ['node-1']], 'starting, then live')
  assert.deepEqual(broker.nodeIds(), ['node-1'])
  // A choice that could not be saved still streams, and says so plainly.
  page.answers.remember = { ok: false, code: 'VIDEO_SAVED_WRITE_FAILED', reason: 'This video choice could not be saved, so it will not come back after a restart.' }
  const unsaved = await broker.start('node-2', { token: TOKEN(2), label: 'Second' })
  assert.equal(unsaved.ok, true)
  assert.equal(unsaved.remembered, false)
  assert.equal(unsaved.reason, page.answers.remember.reason)
  // Bad input never reaches main.
  const before = page.calls.length
  for (const [nodeId, token] of [['', TOKEN(3)], ['node-3', 'not-a-token'], ['bad\u0000id', TOKEN(3)]]) {
    assert.equal((await broker.start(nodeId, { token })).code, 'VIDEO_REQUEST_INVALID')
  }
  assert.equal(page.calls.length, before)
})

test('video starts only from the person\'s own click', async () => {
  const { page, broker } = subject()
  page.win.navigator.userActivation = { isActive: false }
  const answer = await broker.start('node-1', { token: TOKEN(1), label: 'A' })
  assert.equal(answer.code, 'VIDEO_NEEDS_CLICK')
  assert.deepEqual(page.calls, [], 'no pick is armed without a click')
  page.win.navigator.userActivation = { isActive: true }
  assert.equal((await broker.start('node-1', { token: TOKEN(1), label: 'A' })).ok, true)
})

test('every rate change passes the whole constraint set, never the frame rate alone', async () => {
  const { page, broker } = subject()
  await broker.start('node-1', { token: TOKEN(1), label: 'A' })
  const track = page.tracks[0]
  // No panel draws it yet: it drops to 1 frame a second.
  assert.deepEqual(track.applied, [FULL(1)])
  assert.equal(broker.get('node-1').frameRate, 1)
  const main = {}, split = {}
  broker.watch('node-1', main, 5)
  broker.watch('node-1', split, 10)
  broker.unwatch('node-1', split)
  assert.equal(broker.setTier('node-1', 1), true)
  assert.equal(broker.setTier('node-1', 7), false, 'only 10, 5 and 1 are rates')
  assert.equal(broker.setTier('node-1', 1), true)
  assert.deepEqual(track.applied, [FULL(1), FULL(5), FULL(10), FULL(5), FULL(1)])
  for (const constraints of track.applied) {
    assert.ok(constraints.width.max <= 854 && constraints.height.max <= 480, 'the size cap is in every set')
  }
  assert.deepEqual(videoBoxConstraints(99), FULL(10))
  // A hidden app window runs every stream at 1, whatever the panels ask.
  broker.watch('node-1', main, 10)
  page.win.document.visibilityState = 'hidden'
  page.fireDocument('visibilitychange')
  assert.equal(broker.get('node-1').frameRate, 1)
  page.win.document.visibilityState = 'visible'
  page.fireDocument('visibilitychange')
  assert.equal(broker.get('node-1').frameRate, 10)
  assert.deepEqual(track.applied.slice(-3), [FULL(10), FULL(1), FULL(10)])
})

test(`at most ${VIDEO_BOX_LIMIT} videos capture at once`, async () => {
  const { page, broker } = subject()
  for (let index = 0; index < VIDEO_BOX_LIMIT; index++) {
    assert.equal((await broker.start(`node-${index}`, { token: TOKEN(index), label: `W${index}` })).ok, true)
  }
  const arms = page.calls.filter(([name]) => name === 'arm').length
  const refused = await broker.start('node-extra', { token: TOKEN(9), label: 'Extra' })
  assert.equal(refused.code, 'VIDEO_LIMIT')
  assert.match(refused.reason, /Turn one off/)
  assert.equal(page.calls.filter(([name]) => name === 'arm').length, arms, 'the seventh is refused before it is armed')
  // Picking another window for an agent that already has one is not a seventh.
  assert.equal((await broker.start('node-0', { token: TOKEN(20), label: 'Again' })).ok, true)
  assert.equal(page.tracks[0].stopped, 1, 'the agent\'s old stream ends')
  // A closed window no longer captures, so it frees a place.
  page.tracks[1].fire('ended')
  assert.equal(broker.get('node-1').state, 'ended')
  assert.equal((await broker.start('node-extra', { token: TOKEN(9), label: 'Extra' })).ok, true)
})

test('a failed start gives the pick back and never shows the browser\'s own message', async () => {
  for (const [name, message, code] of [
    ['NotAllowedError', 'Permission denied', 'VIDEO_START_FAILED'],
    ['AbortError', 'Invalid capture constraints', 'VIDEO_START_FAILED'],
    ['NotReadableError', 'Could not start video source', 'VIDEO_WINDOW_GONE'],
  ]) {
    const { page, broker } = subject()
    page.answers.media = Object.assign(new Error(message), { name })
    const answer = await broker.start('node-1', { token: TOKEN(1), label: 'A' })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, code)
    assert.equal(answer.reason.includes(message), false, 'the page never shows err.message')
    assert.deepEqual(page.calls.at(-1), ['forget', { nodeId: 'node-1', pickOnly: true }], 'the armed pick is given back')
    assert.equal(broker.get('node-1'), null)
    assert.equal(page.calls.some(([call]) => call === 'remember'), false)
  }
  // Main's own refusal keeps its plain sentence, and nothing is captured.
  const { page, broker } = subject()
  page.answers.arm = { ok: false, code: 'VIDEO_WINDOW_GONE', reason: 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.' }
  const refused = await broker.start('node-1', { token: TOKEN(1), label: 'A' })
  assert.deepEqual(refused, { ok: false, ...page.answers.arm })
  assert.equal(page.calls.some(([call]) => call === 'getDisplayMedia'), false)
})

test('a new pick that fails leaves the agent\'s earlier video running', async () => {
  const { page, broker } = subject()
  await broker.start('node-1', { token: TOKEN(1), label: 'First' })
  const [first] = page.tracks
  page.answers.media = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' })
  const failed = await broker.start('node-1', { token: TOKEN(2), label: 'Second' })
  assert.equal(failed.code, 'VIDEO_WINDOW_GONE')
  assert.equal(first.stopped, 0, 'the old capture was never cut')
  assert.equal(broker.get('node-1').state, 'live')
  assert.equal(broker.get('node-1').label, 'First')
  assert.equal(broker.get('node-1').stream.getVideoTracks()[0], first)
  // Turning video off while the new pick starts ends both.
  let release
  page.answers.media = null
  page.win.navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { release = resolve })
  const starting = broker.start('node-1', { token: TOKEN(3), label: 'Third' })
  await new Promise(resolve => setImmediate(resolve))
  await broker.stop('node-1')
  assert.equal(first.stopped, 1)
  const late = fakeTrack()
  release({ getVideoTracks: () => [late], getTracks: () => [late] })
  assert.equal((await starting).code, 'VIDEO_CANCELLED')
  assert.equal(late.stopped, 1)
  assert.equal(broker.get('node-1'), null)
})

test('turning video off forgets the choice; turning all video off clears every choice', async () => {
  const { page, broker } = subject()
  await broker.start('node-1', { token: TOKEN(1), label: 'A' })
  await broker.start('node-2', { token: TOKEN(2), label: 'B' })
  await broker.start('node-3', { token: TOKEN(3), label: 'C' })
  assert.deepEqual(await broker.stop('node-1'), { ok: true })
  assert.equal(page.tracks[0].stopped, 1)
  assert.equal(broker.get('node-1'), null)
  assert.deepEqual(page.calls.at(-1), ['forget', { nodeId: 'node-1' }])
  assert.deepEqual(await broker.stopAll(), { ok: true })
  assert.deepEqual(page.tracks.map(track => track.stopped), [1, 1, 1], 'every track ends')
  assert.deepEqual(broker.list(), [])
  assert.deepEqual(page.calls.at(-1), ['clear'])
  assert.deepEqual(changes(page).at(-1).detail.nodeIds, ['node-2', 'node-3'])
})

test('agents that left the tree lose their stream but keep their saved choice', async () => {
  const { page, broker } = subject()
  for (const nodeId of ['keep', 'gone']) await broker.start(nodeId, { token: TOKEN(nodeId.length), label: nodeId })
  const calls = page.calls.length
  assert.equal(broker.retain(['keep', 'someone-else']), 1)
  assert.deepEqual(broker.nodeIds(), ['keep'])
  assert.deepEqual(page.tracks.map(track => track.stopped), [0, 1])
  assert.equal(page.calls.length, calls, 'main keeps the choice; it drops it when the node is gone')
  assert.deepEqual(changes(page).at(-1).detail.nodeIds, ['gone'])
})

test('leaving the page stops every track and keeps every saved choice', async () => {
  const { page, broker } = subject()
  await broker.start('node-1', { token: TOKEN(1), label: 'A' })
  await broker.start('node-2', { token: TOKEN(2), label: 'B' })
  const calls = page.calls.length
  page.fire('pagehide')
  assert.deepEqual(page.tracks.map(track => track.stopped), [1, 1])
  assert.deepEqual(broker.list(), [])
  assert.equal(page.calls.length, calls, 'a reload is not the person turning video off')
})

test('turning video off while it starts ends the stream that arrives late', async () => {
  const { page, broker } = subject()
  let release
  page.win.navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { release = resolve })
  const starting = broker.start('node-1', { token: TOKEN(1), label: 'A' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(broker.get('node-1').state, 'starting')
  assert.equal((await broker.start('node-1', { token: TOKEN(2), label: 'B' })).code, 'VIDEO_PICK_PENDING')
  await broker.stop('node-1')
  const track = fakeTrack()
  release({ getVideoTracks: () => [track], getTracks: () => [track] })
  const answer = await starting
  assert.equal(answer.code, 'VIDEO_CANCELLED')
  assert.equal(track.stopped, 1, 'a capture nobody wants any more is ended at once')
  assert.equal(broker.get('node-1'), null)
})

/* REVIEW 0, items 1 and 2. Turning video off while main is still arming the
   pick used to leave main's pick armed for 10 s (every other agent's pick was
   refused as "starting"), and a start cancelled while getDisplayMedia was
   pending answered "did not start" under the Off badge. */
test('turning video off while the pick is being armed gives the pick back and says it was turned off', async () => {
  for (const [name, cancel] of [
    ['Turn off video', broker => broker.stop('node-1')],
    ['Turn off all video', broker => broker.stopAll()],
    ['the agent left the tree', broker => broker.retain([])],
  ]) {
    const { page, broker } = subject()
    let release
    page.answers.arm = new Promise(resolve => { release = () => resolve({ ok: true }) })
    const starting = broker.start('node-1', { token: TOKEN(1), label: 'A' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(broker.get('node-1').state, 'starting', name)
    await cancel(broker)
    release()
    const answer = await starting
    assert.equal(answer.code, 'VIDEO_CANCELLED', name)
    assert.deepEqual(page.calls.at(-1), ['forget', { nodeId: 'node-1', pickOnly: true }], `${name}: main's armed pick is given back`)
    assert.equal(page.calls.some(([call]) => call === 'getDisplayMedia'), false, `${name}: nothing is captured`)
    assert.equal(broker.get('node-1'), null)
  }
  // An arm that main refused has no pick to give back.
  const { page, broker } = subject()
  let release
  page.answers.arm = new Promise(resolve => { release = () => resolve({ ok: false, code: 'VIDEO_WINDOW_GONE', reason: 'gone' }) })
  const starting = broker.start('node-1', { token: TOKEN(1), label: 'A' })
  await new Promise(resolve => setImmediate(resolve))
  await broker.stop('node-1')
  release()
  assert.equal((await starting).code, 'VIDEO_CANCELLED')
  assert.equal(page.calls.filter(([call, request]) => call === 'forget' && request.pickOnly).length, 0)
})

test('a start turned off while the window was being asked for says it was turned off, never that it failed', async () => {
  const { page, broker } = subject()
  let reject
  page.win.navigator.mediaDevices.getDisplayMedia = () => new Promise((_, no) => { reject = no })
  const starting = broker.start('node-1', { token: TOKEN(1), label: 'A' })
  await new Promise(resolve => setImmediate(resolve))
  await broker.stop('node-1')
  reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
  const answer = await starting
  assert.equal(answer.code, 'VIDEO_CANCELLED')
  assert.deepEqual(page.calls.at(-1), ['forget', { nodeId: 'node-1', pickOnly: true }])
  assert.equal(broker.get('node-1'), null)
})

test('ten minutes not shown stops the capture, and Click to resume finds the same window', async () => {
  const { page, clock, broker } = subject()
  await broker.start('node-1', { token: TOKEN(1), label: 'ROS · agent' })
  const [first] = page.tracks
  assert.equal(clock.timers.size, 1, 'not drawn anywhere: the ten minutes start')
  assert.equal([...clock.timers.values()][0].ms, VIDEO_BOX_IDLE_MS)
  const panel = {}
  broker.watch('node-1', panel, 5)
  assert.equal(clock.timers.size, 0, 'shown again: the stop is called off')
  broker.watch('node-1', panel, 1)
  assert.equal(clock.timers.size, 1)
  clock.runAll()
  assert.equal(first.stopped, 1, 'the capture itself ends, not only the drawing')
  assert.deepEqual({ ...broker.get('node-1') }, { nodeId: 'node-1', state: 'paused', label: 'ROS · agent', stream: null, frameRate: null, note: null })
  assert.equal(changes(page).at(-1).detail.nodeIds[0], 'node-1')
  // Resume lists the windows again and picks the one with the same name.
  page.answers.sources = { ok: true, sources: [{ token: TOKEN(7), name: 'Terminal' }, { token: TOKEN(8), name: 'ROS · agent' }] }
  const resumed = await broker.resume('node-1')
  assert.equal(resumed.ok, true)
  assert.deepEqual(page.calls.filter(([name]) => name === 'arm').at(-1), ['arm', { token: TOKEN(8), nodeId: 'node-1' }])
  assert.equal(broker.get('node-1').state, 'live')
  assert.equal(broker.get('node-1').stream.getVideoTracks()[0], page.tracks[1])
  // Two windows with that name, or none: the panel says so and waits.
  for (const sources of [[{ token: TOKEN(8), name: 'ROS · agent' }, { token: TOKEN(9), name: 'ROS · agent' }], []]) {
    clock.runAll()
    broker.unwatch('node-1', panel)
    clock.runAll()
    assert.equal(broker.get('node-1').state, 'paused')
    page.answers.sources = { ok: true, sources }
    const answer = await broker.resume('node-1')
    assert.equal(answer.ok, false)
    assert.equal(broker.get('node-1').state, 'paused')
    assert.equal(broker.get('node-1').note, answer.reason)
    // 1.0.50 review video F5: no window with that name may be a minimized one, not only a closed one.
    if (!sources.length) assert.equal(answer.reason, 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.')
    broker.watch('node-1', panel, 5)
  }
  assert.equal((await broker.resume('nobody')).code, 'VIDEO_NOT_PAUSED')
  page.win.navigator.userActivation = { isActive: false }
  const calls = page.calls.length
  assert.equal((await broker.resume('node-1')).code, 'VIDEO_NEEDS_CLICK')
  assert.equal(page.calls.length, calls, 'resuming needs the person\'s click too')
})
