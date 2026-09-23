/* SEND NOW's RESERVATION, DRIVEN THROUGH THE ACTUAL MOUNTED COMPOSER (T785).
 *
 * The host-level proof lives in send-now-reservation.test.mjs. This suite is
 * the other half Controller asked for: the REAL src/components.js buildChat,
 * mounted over the DOM stand-in and the REAL src/session-outbox.js store, with
 * a queue-strip "Send now" clicked as a person clicks it. It records the
 * onReserveHold / onReleaseHold calls the renderer makes and traces the whole
 * lifecycle -- deferred interrupt, confirmed send, refused stop, parked hold,
 * and a plain Halt -- to prove:
 *   - the reservation is placed BEFORE the interrupt (onStop), for a held Send
 *     now only;
 *   - it is released, in the finally tied to the delivery outcome, on every
 *     path where the words do NOT go (refused/failed stop, parked hold), and
 *     NOT on the confirmed-delivery path (the host clears it on land);
 *   - a plain Halt reserves nothing.
 *
 * NON-DESTRUCTIVE (R1225): this suite creates and deletes nothing on disk; the
 * store is in-memory (localStorage stand-in).
 */

import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'

const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
const { restore } = installDomStandIn(globalThis)
const previousStorage = globalThis.localStorage
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: key => saved.delete(key),
}
after(() => {
  restore()
  if (previousStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previousStorage
})

const { buildChat } = await import('../../src/components.js')
const outbox = await import('../../src/session-outbox.js')

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
let seq = 0
const mounted = new Set()
afterEach(() => {
  for (const fixture of mounted) { try { fixture.root.dispose() } catch {} outbox.clearSession(fixture.sessionId) }
  mounted.clear()
})

/* `stop` decides what the interrupt does: 'accepted' ends the turn (busy ->
   false, words go); 'refused' returns {ok:false}; 'parked' accepts but never
   goes idle, so the composer's own release budget parks the hold. */
function mount({ stop = 'accepted', reserveGate = null, sendImpl = null, takeEffect = null } = {}) {
  const sessionId = `snr-composer-${++seq}`
  outbox.clearSession(sessionId)
  const state = { busy: true }
  const events = []
  const statusListeners = new Set()
  let tokenSeq = 0
  /* The reservation's owner, and a recording host bridge per owner. This mirrors
     src/agent-session.js: onReserveHold captures { bridge, sessionId, token } at
     reserve, and onReleaseHold releases THAT captured owner while swallowing the
     promise's rejection. `live.owner` can be rebound mid-hold to prove the
     release still targets the owner captured at reserve, not a fresh read. */
  const bridges = {}
  const bridgeFor = owner => (bridges[owner] ||= {
    owner, released: [], rejects: false,
    releaseSendNow(request) {
      this.released.push(request)
      return this.rejects ? Promise.reject(new Error('release rejected by bridge')) : Promise.resolve({ ok: true, released: true })
    },
  })
  const live = { owner: 'A' }
  bridgeFor('A')
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: {
      busy: () => state.busy,
      subscribe: listener => { statusListeners.add(listener); return () => statusListeners.delete(listener) },
    },
    queue: {
      list: () => outbox.list(sessionId).map(entry => ({
        id: entry.id,
        text: entry.text,
        ...(entry.deliveryUnconfirmed ? { deliveryUnconfirmed: true } : {}),
        ...(typeof entry.heldReason === 'string' && entry.heldReason ? { heldReason: entry.heldReason } : {}),
      })),
      add: text => outbox.enqueue(sessionId, text),
      cancel: id => outbox.cancel(sessionId, id),
      replace: (id, text) => outbox.replace(sessionId, id, text),
      hold: request => {
        const held = outbox.holdForSend(sessionId, request)
        if (!takeEffect || !held.ok) return held
        return { ...held, take() { const entry = held.take(); takeEffect(); return entry } }
      },
      sendNow: id => (outbox.promoteFront(sessionId, id) ? { ok: true, sentence: 'moved' } : { ok: false, sentence: 'gone' }),
    },
    chips: {},
    onSend: (text, callbacks) => {
      const { reply, fail, accepted } = callbacks
      if (sendImpl) return sendImpl(text, callbacks)
      if (state.busy) { const queued = outbox.enqueue(sessionId, text); if (!queued.ok) { fail(queued.sentence); return } accepted?.(); reply('queued'); return }
      accepted?.(); events.push({ type: 'sent', text }); reply(`answered: ${text}`)
    },
    onReserveHold: async () => {
      /* Capture the EXACT owner -- bridge and session id -- at reserve, as
         src/agent-session.js does; the handle is opaque to the composer. */
      const heldOwner = live.owner
      const heldBridge = bridgeFor(heldOwner)
      const token = ++tokenSeq
      events.push({ type: 'reserve', token, owner: heldOwner })
      if (reserveGate) await reserveGate
      return { bridge: heldBridge, sessionId: heldOwner, token }
    },
    onReleaseHold: hold => {
      if (!hold || hold.token == null) return
      events.push({ type: 'release', token: hold.token, owner: hold.sessionId })
      try { Promise.resolve(hold.bridge.releaseSendNow({ sessionId: hold.sessionId, token: hold.token })).catch(() => {}) }
      catch { /* the host self-clears when the words land */ }
    },
    onStop: () => {
      events.push({ type: 'stop' })
      if (stop === 'refused') return { ok: false, sentence: 'The interrupt was refused.' }
      if (stop === 'parked') return { ok: true, settled: false, sentence: 'Interrupted.' }
      state.busy = false
      for (const listener of statusListeners) listener()
      return 'stopped'
    },
  })
  const fixture = { root, sessionId, state, events, live, bridges, bridgeFor, input: root.querySelector('.chat-input input') }
  mounted.add(fixture)
  return fixture
}

/* Type a message while the agent is busy: it queues, and the strip grows a row
   with a real "Send now" button. */
function queueOne(fixture, text) {
  fixture.input.value = text
  fixture.root.querySelector('.chat-send').dispatch('click')
}
const strip = fixture => fixture.root.querySelectorAll('.chat-queue-row')

test('Send now reserves BEFORE the interrupt, and on a confirmed delivery does not release (the host clears it)', async () => {
  const f = mount({ stop: 'accepted' })
  queueOne(f, 'the held words')
  assert.equal(strip(f).length, 1, 'the busy message queued and drew a row')

  strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  await tick(); await tick()

  const kinds = f.events.map(e => e.type)
  const reserveAt = kinds.indexOf('reserve')
  const stopAt = kinds.indexOf('stop')
  assert.ok(reserveAt !== -1 && stopAt !== -1 && reserveAt < stopAt,
    'the reservation is placed before the interrupt')
  assert.ok(f.events.some(e => e.type === 'sent'), 'the words were delivered once the turn was stopped')
  assert.ok(!f.events.some(e => e.type === 'release'),
    'a confirmed delivery does not release from the renderer -- the host clears personWaitingSince on land')
})

test('a refused interrupt releases the reservation, and the words stay queued', async () => {
  const f = mount({ stop: 'refused' })
  queueOne(f, 'the held words')

  strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  await tick(); await tick()

  const reserve = f.events.find(e => e.type === 'reserve')
  const release = f.events.find(e => e.type === 'release')
  assert.ok(reserve, 'the reservation was placed')
  assert.ok(release && release.token === reserve.token,
    'the refused interrupt released the exact reservation it placed')
  assert.ok(!f.events.some(e => e.type === 'sent'), 'nothing was sent into a turn the interrupt did not stop')
  assert.equal(outbox.list(f.sessionId).length, 1, 'the words stay in the queue')
})

test('a parked hold (stop accepted, idle never came) releases the reservation inside the budget', async () => {
  const f = mount({ stop: 'parked' })
  queueOne(f, 'the held words')

  strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  /* The composer's release budget is 250 ms; wait past it. */
  await tick(400)

  const reserve = f.events.find(e => e.type === 'reserve')
  const release = f.events.find(e => e.type === 'release')
  assert.ok(reserve, 'the reservation was placed')
  assert.ok(release && release.token === reserve.token,
    'the parked hold released the exact reservation it placed')
  assert.ok(!f.events.some(e => e.type === 'sent'), 'a parked hold sends nothing')
})

test('a plain Halt reserves nothing', async () => {
  const f = mount({ stop: 'accepted' })
  /* The working-step Stop button is a plain Halt: it calls runStop with no
     held Send now, so it must reserve nothing. */
  const halt = f.root.querySelector('.working-step button')
  assert.ok(halt, 'the busy composer shows a Halt control')
  halt.dispatch('click')
  await tick(); await tick()

  assert.ok(f.events.some(e => e.type === 'stop'), 'the Halt interrupted')
  assert.ok(!f.events.some(e => e.type === 'reserve'), 'a plain Halt places no reservation')
})

test('the release targets the owner captured at reserve, even after the session rebinds mid-hold', async () => {
  /* Parked: the release waits out the 250 ms budget, giving a real window in
     which the live session rebinds before the release fires. */
  const f = mount({ stop: 'parked' })
  queueOne(f, 'the held words')

  strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  await tick()
  assert.ok(f.events.some(e => e.type === 'reserve'), 'the reservation was placed on A')
  assert.ok(!f.events.some(e => e.type === 'release'), 'not released yet -- still inside the budget')

  /* The session rebinds to a replacement WHILE the hold is parked. A renderer
     that re-read the live session at release time would send it to B and leak A. */
  f.live.owner = 'B'
  await tick(400)

  const reserve = f.events.find(e => e.type === 'reserve')
  const release = f.events.find(e => e.type === 'release')
  assert.equal(reserve.owner, 'A', 'the reservation captured A')
  assert.ok(release, 'the parked hold released')
  assert.equal(release.owner, 'A', 'the release went to the captured owner A, not the rebound B')
  assert.deepEqual(f.bridgeFor('A').released.map(r => r.sessionId), ['A'],
    'A\'s own bridge received the release')
  assert.equal(f.bridges.B, undefined, 'the rebound B, which never owned the hold, was never released')
})

test('a release whose host bridge rejects raises no unhandled rejection', async () => {
  const seen = []
  const onUnhandled = reason => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const f = mount({ stop: 'refused' })
    f.bridgeFor('A').rejects = true   // the host bridge rejects the release call
    queueOne(f, 'the held words')

    strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
    await tick(); await tick(); await tick(10)

    const release = f.events.find(e => e.type === 'release')
    assert.ok(release, 'the refused interrupt still released')
    assert.equal(f.bridgeFor('A').released.length, 1, 'the release reached the rejecting bridge')
    assert.deepEqual(
      seen.filter(r => /release rejected by bridge/.test(String(r?.message || r))), [],
      'the rejected release was swallowed -- no unhandled rejection',
    )
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('disposing the composer mid-hold is safe: no throw, and no leaked second release', async () => {
  const f = mount({ stop: 'parked' })
  queueOne(f, 'the held words')

  strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  await tick()
  assert.ok(f.events.some(e => e.type === 'reserve'), 'the reservation was placed')

  /* Tear the whole surface down while the hold is still parked. */
  assert.doesNotThrow(() => f.root.dispose(), 'disposal mid-hold does not throw')
  await tick(400)

  const releases = f.events.filter(e => e.type === 'release')
  assert.equal(releases.length, 1, 'disposal releases the captured reservation exactly once')
  for (const r of releases) assert.equal(r.owner, 'A', 'any release after disposal still targets the captured owner')
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function pressSendNow(f, door, words = 'successor held words') {
  if (door === 'strip') {
    queueOne(f, words)
    strip(f)[0].querySelector('.chat-queue-now').dispatch('click')
  } else {
    f.input.value = words
    f.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  }
}

for (const door of ['strip', 'composer']) {
  test(`successor: disposal during reservation acquisition releases its captured owner without interrupt or send (${door})`, async () => {
    const gate = deferred()
    let sends = 0
    const f = mount({ reserveGate: gate.promise, sendImpl: () => { sends++ } })
    pressSendNow(f, door)
    await tick()
    assert.equal(f.events.filter(e => e.type === 'reserve').length, 1)
    f.live.owner = 'B'
    f.root.dispose()
    gate.resolve()
    await tick(); await tick()
    assert.equal(sends, 0)
    assert.equal(f.events.filter(e => e.type === 'stop').length, 0)
    assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
    assert.equal(f.bridges.B, undefined)
  })
}

test('successor: disposal after taking the row but before issue releases once without dispatch', async () => {
  let sends = 0
  const f = mount({ sendImpl: () => { sends++ }, takeEffect: () => f.root.dispose() })
  pressSendNow(f, 'composer')
  await tick(); await tick()
  assert.equal(sends, 0)
  assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
  assert.equal(outbox.list(f.sessionId).length, 1)
  assert.equal(outbox.list(f.sessionId)[0].deliveryUnconfirmed, undefined)
})

test('successor: disposal during a known pre-host retry releases once and prevents another dispatch', async () => {
  let sends = 0
  const f = mount({ sendImpl: (text, { fail }) => {
    sends++
    fail('not ready', { code: 'AGENT_SESSION_NOT_READY', unconfirmed: false })
  } })
  pressSendNow(f, 'composer')
  await tick(); await tick()
  assert.equal(sends, 1)
  assert.equal(f.bridgeFor('A').released.length, 0, 'retry still owns reservation')
  f.root.dispose()
  await tick(160)
  assert.equal(sends, 1)
  assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
  assert.equal(outbox.list(f.sessionId).length, 1)
  assert.equal(outbox.list(f.sessionId)[0].deliveryUnconfirmed, undefined)
})

test('successor: a vanished retry row releases once without reissuing its words', async () => {
  let sends = 0
  const f = mount({ sendImpl: (text, { fail }) => {
    sends++
    fail('not ready', { code: 'AGENT_SESSION_NOT_READY', unconfirmed: false })
  } })
  pressSendNow(f, 'composer')
  await tick(); await tick()
  assert.equal(sends, 1)
  const entry = outbox.list(f.sessionId)[0]
  assert.ok(entry)
  assert.equal(outbox.cancel(f.sessionId, entry.id), true)
  await tick(160)
  assert.equal(sends, 1, 'removed words must not be dispatched again')
  assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
  assert.equal(outbox.list(f.sessionId).length, 0)
})

test('successor: a retry throwing asynchronously settles once and keeps delivery unconfirmed', async () => {
  let sends = 0
  const f = mount({ sendImpl: (text, { fail }) => {
    sends++
    if (sends === 1) { fail('not ready', { code: 'AGENT_SESSION_NOT_READY', unconfirmed: false }); return }
    return Promise.reject(Object.assign(new Error('unknown'), { code: 'AGENT_SEND_UNKNOWN' }))
  } })
  pressSendNow(f, 'composer')
  await tick(180)
  assert.equal(sends, 2)
  assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
  assert.equal(outbox.list(f.sessionId)[0].deliveryUnconfirmed, true)
  await tick(150)
  assert.equal(sends, 2, 'unknown dispatched outcome is not replayed')
})

test('successor: disposal cannot turn a dispatched pending send into a retryable envelope', async () => {
  let callbacks
  let sends = 0
  const f = mount({ sendImpl: (text, value) => { sends++; callbacks = value } })
  pressSendNow(f, 'composer')
  await tick(); await tick()
  assert.equal(sends, 1)
  f.root.dispose()
  await tick()
  assert.equal(f.bridgeFor('A').released.length, 0, 'pending dispatched custody is not guessed settled')
  assert.equal(outbox.list(f.sessionId)[0].deliveryUnconfirmed, true)
  callbacks.fail('unknown', { unconfirmed: true, code: 'AGENT_SEND_UNKNOWN' })
  await tick()
  assert.deepEqual(f.bridgeFor('A').released, [{ sessionId: 'A', token: 1 }])
  assert.equal(outbox.list(f.sessionId)[0].deliveryUnconfirmed, true)
  assert.equal(sends, 1)
})

