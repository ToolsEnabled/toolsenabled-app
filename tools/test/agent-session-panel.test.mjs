import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { agentSessionEntryState, createStreamRelay, mountAgentSessionSurface } from '../../src/agent-session.js'

/* THE RAW <pre data-session-output> IS GONE. This surface now mounts the same
 * Dense chat panel (buildChat, src/components.js) as every other agent
 * surface, fed through openStream (words) and addAction (tool calls), instead
 * of dumping text into an unstyled <pre>.
 *
 * WHAT THIS FILE PINS, AND WHY EACH HALF IS SHAPED THE WAY IT IS. buildChat
 * and the markup functions it calls (mountSessionControls, mountSessionSwitchedOff)
 * all go through src/components.js's `el()`, which is `document.createElement`
 * under the hood -- a real browser API this test environment does not have
 * (`npm test` runs plain `node --test`, no jsdom is installed; every existing
 * suite that touches this file's DOM-mounting functions -- agent-session-
 * surface.test.mjs -- reaches them the same way this file does, through source
 * text, never by calling them). So:
 *
 *   - createStreamRelay is pure and DOM-free (it is handed a `push` callback,
 *     never a real bubble), so it is proven by REAL EXECUTION below, the same
 *     way agent-session-transcript.test.mjs proves createTranscriptAppender.
 *   - mountAgentSessionSurface's `live !== true` fence is provable by REAL
 *     EXECUTION too: for a non-live call it returns before touching `root` at
 *     all, so a Proxy that throws on any touch proves the negative directly,
 *     with no DOM required. The positive direction (a live call really does
 *     proceed) is proven the same way, from the other side: past the fence
 *     this file needs a document, which this environment does not have, so a
 *     live call reliably throws reaching for one -- and THAT throw is the
 *     proof it did not take the render-nothing path.
 *   - the write-disabled destination is selected by an exported pure decision
 *     that the renderer itself consumes, so both directions run below without
 *     a DOM. Everything else pinned here (the destination's markup,
 *     no <pre> remains, buildChat is fed through composerReason and not a
 *     second way to answer, addAction/openStream are both used, incremental
 *     delivery is not reintroduced as a quadratic per-delta push) is pinned on
 *     the source text, the same way tools/test/agent-session-surface.test.mjs
 *     already pins this file's other properties. Each such assertion below is
 *     mutation-refuted in the report this test file was written for: broken in
 *     the module (never in the test), confirmed red, restored, confirmed green.
 */

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const AGENT_SESSION_PATH = join(ROOT, 'src', 'agent-session.js')
const AGENT_SESSION_CONTROLS_PATH = join(ROOT, 'src', 'agent-session-controls.js')
const source = () => readFileSync(AGENT_SESSION_PATH, 'utf8')

// ------------------------------------------------------------------
// (a) THE `live !== true` FENCE -- real execution, no DOM required.
// ------------------------------------------------------------------

function touchProxy() {
  return new Proxy({}, {
    get(_target, prop) { throw new Error(`root.${String(prop)} was touched by a non-live mount`) },
  })
}

test('a non-live mount renders nothing: it never touches the host element and returns a harmless no-op', () => {
  // Every value that is not the exact boolean `true`, including a string that
  // reads as truthy -- the fence is `!== true`, not `== true`, and a loose
  // read would let 'true' or 1 slip through.
  const notLive = [false, undefined, null, 0, 1, 'true', 'false', {}]
  for (const live of notLive) {
    const root = touchProxy()
    let dispose
    assert.doesNotThrow(
      () => { dispose = mountAgentSessionSurface(root, { live }) },
      `mountAgentSessionSurface(root, { live: ${JSON.stringify(live)} }) touched the host element instead of rendering nothing`,
    )
    assert.equal(typeof dispose, 'function', 'a non-live mount must still return a disposer')
    assert.doesNotThrow(() => dispose(), 'the no-op disposer for a non-live mount must be safe to call')
  }
})

test('a live mount does not take the render-nothing path', () => {
  // Past the fence, this surface needs a real document (el() is
  // document.createElement under the hood) -- which this plain-node test
  // environment does not have. So the discriminator here is simply: does it
  // ATTEMPT real work (and therefore throw, for a reason that has nothing to
  // do with `live`) rather than silently returning the render-nothing no-op.
  assert.throws(
    () => mountAgentSessionSurface({}, { live: true }),
    /./,
    'live: true must attempt to mount a real surface, not silently render nothing',
  )
})

// ------------------------------------------------------------------
// (c) INCREMENTAL DELIVERY -- createStreamRelay, real execution.
//
// Mirrors tools/test/agent-session-transcript.test.mjs's proof for
// createTranscriptAppender, adapted for openStream's contract: push()
// REPLACES a bubble's whole text with whatever it is given (the caller owns
// accumulation), so the property worth measuring is CALL COUNT, not bytes
// copied -- calling push() once per delta is the quadratic shape reborn one
// level up, however cheap each individual call is made later.
// ------------------------------------------------------------------

function relayHarness() {
  const pushed = []
  const frames = []
  let nextHandle = 1
  const relay = createStreamRelay({
    push: text => pushed.push(text),
    scheduleFrame: fn => { const h = nextHandle++; frames.push({ h, fn }); return h },
    cancelFrame: h => { const i = frames.findIndex(f => f.h === h); if (i >= 0) frames.splice(i, 1) },
  })
  return {
    relay, pushed, frames,
    runFrames() { while (frames.length) frames.shift().fn() },
  }
}

test('createStreamRelay requires its three collaborators', () => {
  assert.throws(() => createStreamRelay({ scheduleFrame: () => {}, cancelFrame: () => {} }), TypeError)
  assert.throws(() => createStreamRelay({ push: () => {}, cancelFrame: () => {} }), TypeError)
  assert.throws(() => createStreamRelay({ push: () => {}, scheduleFrame: () => {} }), TypeError)
})

test('every delta reaches the caller exactly once, in order, as the whole accumulated string', () => {
  const { relay, pushed, runFrames } = relayHarness()
  const deltas = Array.from({ length: 3000 }, (_, i) => `d${i} `)
  deltas.forEach((d, i) => {
    relay.append(d)
    if (i % 53 === 0) runFrames()
  })
  runFrames()
  assert.equal(pushed.at(-1), deltas.join(''), 'the last push must carry the exact concatenation of every delta, in order')
  assert.equal(relay.text, deltas.join(''), 'the relay\'s own accumulator must match what was pushed')
})

test('deltas arriving within one frame produce exactly one push call, not one per delta', () => {
  const { relay, pushed, frames, runFrames } = relayHarness()
  for (let i = 0; i < 20_000; i++) relay.append('x')
  assert.equal(pushed.length, 0, 'buffering must call push zero times')
  assert.equal(frames.length, 1, '20,000 deltas in one frame must request exactly one frame, not 20,000')
  runFrames()
  assert.equal(pushed.length, 1, '20,000 buffered deltas must land in a single push call')
  assert.equal(pushed[0], 'x'.repeat(20_000))
})

test('push-call count stays bounded by frames actually run, never by delta count', () => {
  // The direct analogue of agent-session-transcript.test.mjs's linear-cost
  // proof, restated for an API that replaces rather than appends: the number
  // of times openStream's push() is called must track how often a frame ran,
  // not how many deltas arrived. 20,000 deltas flushed every 60 must produce
  // on the order of 20,000/60 push calls, never 20,000.
  const { relay, pushed, runFrames } = relayHarness()
  const deltas = 20_000
  for (let i = 0; i < deltas; i++) {
    relay.append(' token')
    if (i % 60 === 59) runFrames()
  }
  runFrames()
  const expectedFrames = Math.ceil(deltas / 60)
  assert.ok(
    pushed.length <= expectedFrames + 1,
    `expected roughly ${expectedFrames} push calls for ${deltas} deltas flushed every 60, got ${pushed.length}`,
  )
  assert.ok(pushed.length < deltas / 10, `push was called ${pushed.length} times for ${deltas} deltas; batching is not working`)
})

test('flushNow pushes immediately and cancels the frame it made redundant', () => {
  const { relay, pushed, frames } = relayHarness()
  relay.append('done')
  relay.flushNow()
  assert.equal(pushed.at(-1), 'done')
  assert.equal(frames.length, 0, 'flushNow must cancel the frame it made redundant')
})

test('reset clears the buffer and cancels a pending frame, so a stale frame cannot leak into the next session', () => {
  const { relay, pushed, frames, runFrames } = relayHarness()
  relay.append('old session')
  assert.equal(frames.length, 1)
  relay.reset()
  assert.equal(frames.length, 0, 'a scheduled frame would push the previous session\'s tail into the new one')
  runFrames()
  assert.equal(pushed.length, 0, 'nothing from before the reset may be pushed')
  relay.append('new session')
  relay.flushNow()
  assert.equal(pushed.at(-1), 'new session')
})

test('dispose cancels pending work and pushes nothing afterwards', () => {
  const { relay, pushed, frames, runFrames } = relayHarness()
  relay.append('pending')
  relay.dispose()
  assert.equal(frames.length, 0, 'a frame must not fire against a disposed relay')
  relay.append('after dispose')
  runFrames()
  assert.equal(pushed.length, 0, 'a disposed relay must never call push')
})

// ------------------------------------------------------------------
// (b) THE WRITE-DISABLED DESTINATION, and (d) NO <pre> REMAINS -- source text,
// for the reason explained in the header comment: mountSessionControls and
// mountSessionSwitchedOff both go through el(), which needs a real document.
// ------------------------------------------------------------------

test('no <pre data-session-output> markup remains anywhere in this file', () => {
  assert.doesNotMatch(
    source(),
    /<pre[^>]*data-session-output/,
    'the raw transcript <pre> must be fully replaced by the mounted chat panel',
  )
  assert.doesNotMatch(
    source(),
    /from '\.\/agent-session-transcript\.js'/,
    'the DOM-append appender module must no longer be imported (its API cannot feed openStream -- see createStreamRelay above)',
  )
})

test('the live agent page routes a disabled write flag to a stated-unavailable destination', () => {
  const off = agentSessionEntryState({ live: true, writeEnabled: false })
  assert.equal(off.kind, 'switched-off',
    'a disabled write flag did not route to the switched-off destination')
  assert.equal(off.startEnabled, false, 'the switched-off destination represented Start as available')
  assert.match(off.reason, /switched off/i, 'the switched-off destination did not carry a visible reason')

  const on = agentSessionEntryState({ live: true, writeEnabled: true })
  assert.equal(on.kind, 'controls', 'an enabled write flag did not route to the Start controls')
  assert.equal(on.startEnabled, true, 'the enabled destination represented Start as unavailable')

  const example = agentSessionEntryState({ live: false, writeEnabled: true })
  assert.equal(example.kind, 'hidden', 'a non-live page exposed a session destination')
  assert.equal(example.startEnabled, false, 'a non-live page represented Start as available')
})

test('the transcript remains the default and only the explicit chat mode receives a live sender', () => {
  const call = /chat = buildChat\(\{([\s\S]*?)\n {4}\}\)/.exec(source())
  assert.ok(call, 'mountChat() must build the panel with a literal buildChat({...}) call')
  const args = call[1]
  assert.match(args, /composerReason:\s*SESSION_TRANSCRIPT_COMPOSER_REASON/, 'the panel must be gated by composerReason')
  assert.match(source(), /chatComposer = false/, 'existing callers must retain their read-only transcript')
  assert.match(args, /chatComposer \? \{[\s\S]*onSend:[\s\S]*\} : \{ composerReason:/,
    'the sender and read-only reason must remain mutually exclusive; mounted behavior is covered by tree-standalone-agent.test.mjs')
  assert.doesNotMatch(args, /\bsampleConversation\s*:/, 'a read-only transcript panel must not also request the seeded simulator')
})

test('the composer reason is a real sentence, not a machine code, and is plain-language clean', () => {
  const text = source()
  const match = /const SESSION_TRANSCRIPT_COMPOSER_REASON = '([^']+)'/.exec(text)
  assert.ok(match, 'the composer reason must be a named constant, not a string buried inline')
  const sentence = match[1]
  assert.ok(sentence.length > 20, 'the composer reason is too short to explain anything')
  assert.doesNotMatch(sentence, /^[A-Z][A-Z0-9_]+$/, 'the composer reason must not be a bare machine code')
  for (const clause of sentence.split(/(?<=[.!?])\s+/)) {
    const words = clause.trim().split(/\s+/).filter(Boolean)
    assert.ok(words.length <= 25, `"${clause}" is ${words.length} words; the plain-language gate caps a sentence at 25`)
  }
})

test('the panel is fed live words through openStream and live actions through addAction', () => {
  const text = source()
  assert.match(text, /replyAt = Date\.now\(\)\s+turnStream = chat\.openStream\(\{ at: replyAt \}\)/, 'a turn opens a stream with the same timestamp as its transcript snapshot')
  assert.match(text, /const row = \{ who: 'action', \.\.\.sessionActionChatRow\(filed\.row\) \}[\s\S]*?chat\.addAction\(row\)/, 'the snapshot and mounted panel consume the same filed action row')
})

test('the mounted text-delta path batches deltas and a whole-output correction before paint', async () => {
  const { document, restore } = installDomStandIn(globalThis)
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }

  const listeners = new Set()
  const frames = new Map()
  let nextFrame = 1
  const scheduleFrame = callback => {
    const handle = nextFrame++
    frames.set(handle, callback)
    return handle
  }
  const cancelFrame = handle => { frames.delete(handle) }
  const paint = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(Date.now())
  }
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async request => ({ ok: true, sessionId: request.sessionId }),
    send: async () => ({ ok: true, turnId: 'turn-1' }),
    interrupt: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
  }
  const root = document.createElement('div')
  document.body.appendChild(root)
  let controller = null
  let dispose = null
  try {
    dispose = mountAgentSessionSurface(root, {
      live: true,
      agentId: 'panel-relay-fixture',
      bridge,
      chatComposer: true,
      publishSession: false,
      onController: value => { controller = value },
      scheduleFrame,
      cancelFrame,
    })
    await settle()
    assert.ok(controller, 'the mounted panel did not publish its session controller')
    const started = await controller.send('stream this answer')
    assert.equal(started.ok, true, started.code || 'the fixture session did not start')
    for (let attempt = 0; frames.size && attempt < 10; attempt += 1) paint()
    assert.equal(frames.size, 0, 'the initial frame queue did not drain within the 10-frame fixture bound')

    const emit = event => {
      for (const listener of [...listeners]) listener({ sessionId: started.sessionId, event })
    }
    const bubble = () => root.querySelector('.them .chat-msg-text')
    assert.ok(bubble(), 'the mounted panel did not open an answer bubble')

    emit({ type: 'assistant_text_delta', turnId: 'turn-1', itemId: 'answer-1', text: 'hel' })
    emit({ type: 'assistant_text_delta', turnId: 'turn-1', itemId: 'answer-1', text: 'lo' })
    /* The provider's whole-message receipt corrects/reconciles the streamed
       prefix. The reader contributes only the new suffix, so the relay still
       sees one accumulated answer rather than a duplicate whole message. */
    emit({ type: 'assistant_text', turnId: 'turn-1', itemId: 'answer-1', text: 'hello!' })

    assert.equal(bubble().textContent, '', 'a delta wrote into the mounted bubble before the scheduled paint')
    assert.equal(frames.size, 1, 'multiple deltas and their whole-output correction must share one animation frame')
    paint()
    assert.equal(bubble().textContent, 'hello!', 'the mounted bubble did not receive the corrected whole output after paint')
    assert.equal(frames.size, 0, 'painting the relay left a stale frame scheduled')
  } finally {
    dispose?.()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
    restore()
  }
})

test('every new session rebuilds the panel, keeping the confirmed "transcript is lost" claim true', () => {
  const text = source()
  const startFn = /const startSession = async[\s\S]*?\n {2}\}/.exec(text)
  assert.ok(startFn, 'startSession must still exist as a single function this file defines once')
  assert.match(startFn[0], /mountChat\(\)/, 'every new session (a plain Start or a Respawn, which both call startSession) must rebuild the panel')

  const controls = readFileSync(AGENT_SESSION_CONTROLS_PATH, 'utf8')
  assert.match(
    controls,
    /The current transcript and everything it remembers are lost/,
    'this file\'s rebuild-on-new-session behaviour exists to keep this confirmed claim true; if the claim\'s wording moved, the comment explaining the rebuild is now stale',
  )
})

test('the mounted panel is disposed on every teardown path, so its observers do not leak', () => {
  const text = source()
  const disposeCalls = text.match(/chat\.dispose\?\.\(\)/g) || []
  assert.ok(disposeCalls.length >= 2, `expected chat.dispose?.() on both the bridge-absent early return and the normal teardown, found ${disposeCalls.length}`)
  assert.match(text, /previous\.dispose\?\.\(\)/, 'rebuilding the panel for a new session must dispose the panel it replaces')
})
