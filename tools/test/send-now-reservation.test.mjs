/* SEND NOW RESERVES THE BOUNDARY BEFORE THE INTERRUPT (T785).
 *
 * THE RACE. "Send now" on a busy session holds the person's words locally,
 * then interrupts the running turn so they can go into the next one. Between
 * the interrupt freeing the boundary and the renderer's drain reaching
 * sendTurn(), the tree courier can take that boundary -- the SECOND LOST RACE
 * in shell/tree-turn-priority.cjs, for the one shape its per-boundary window
 * does not itself cover here: an interrupt the person just forced, with words
 * waiting behind it that have not yet touched the host.
 *
 * THE FIX UNDER TEST. shell/agent-host.cjs gains reserveSendNow / releaseSendNow.
 * reserve stamps the SAME session.personWaitingSince a person-origin refusal
 * would leave -- the field pumpTreeSessionOnce() reads to stand aside -- but
 * BEFORE the interrupt, so the freed boundary is the person's. tree-turn-
 * priority.cjs is NOT changed, so the bounded yield is exactly as shipped.
 *
 * OWNERSHIP IS A GENERATION, NOT A TIMESTAMP. session.personWaitingSince stays
 * a wall-clock time, for the priority algorithm alone. The reservation's
 * OWNERSHIP identity is a distinct monotonic generation, session.personWaiting-
 * Token, returned by reserve. Release is a compare-and-clear on that token, so
 * two holds -- or a hold and a same-millisecond refused person send -- are told
 * apart and an old release can never clear a newer wait. An ordinary refused
 * person send REVISES the generation (invalidating a stale Send-now token)
 * while preserving the wait (personWaitingSince stays set).
 *
 * These ownership controls are CLOCK-INDEPENDENT: the token is a generation, so
 * no clock advance -- real or injected -- is needed to tell reservations apart.
 * (An earlier timestamp design needed a 2 ms wait to force distinct values;
 * this does not, which is the whole point of the correction.)
 *
 * WHAT THIS PROVES, against the REAL host (createAgentHost, a faked provider
 * ADAPTER only) and the REAL decision module:
 *   1. PRIORITY + DEFERRED INTERRUPT. reserve returns a positive-integer
 *      generation; the real treeTurnDecision yields PERSON_FIRST for a fresh
 *      personWaitingSince and the take for none; the reservation survives the
 *      interrupt (release with the same token AFTER it still clears it).
 *   2. ORDINARY HALT reserves nothing.
 *   3. SAME-SESSION NEWER HOLD. A second reserve's token is the next
 *      generation; the first (now stale) release clears nothing; the second
 *      does -- with no clock advance at all.
 *   4. NEWER REFUSAL. A refused person send between two reserves consumes a
 *      generation (revising the identity) so the first token is stale, while
 *      the wait itself is preserved.
 *   5. CROSS-SESSION. Releasing session A with session B's token is refused.
 *   6. WIRING. The renderer places the reservation before the interrupt for a
 *      held Send now only and releases it only when the words do not go; the
 *      validated command-surface / IPC / preload routing is in place.
 *
 * Inert adapter and existing read-only fixture directory; no scratch creation
 * or physical fixture cleanup. Actual courier composition is covered by the
 * companion e2e suite; the decision helper below is a bounded unit check.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'


const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
const { treeTurnDecision, TREE_TURN_REASONS } = require('../../shell/tree-turn-priority.cjs')

// Existing read-only fixture directory; the adapter and session state are inert.
const FIXTURE_CWD = fileURLToPath(new URL('./fixtures/confined-engine/', import.meta.url))

/* The real courier decision, asked whether it may take an idle boundary while
   one tree turn waits. personWaitingSince is the wall-clock time reserve/refusal
   write; treeTurnDecision reads it exactly as the host feeds it. */
function courierDecision(personWaitingSince, now) {
  return treeTurnDecision({
    now,
    queuedTreeTurns: 1,
    turnActive: false,
    personWaitingSince,
    boundaryAt: null,
    personYieldMs: 1200,
    queuedSince: now,
  })
}

function fixture(t) {
  const cwd = FIXTURE_CWD
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const sent = []
  let interrupts = 0
  const adapter = {
    transport: { child },
    sendTurn: async request => { sent.push(request); return { turnId: `turn-${sent.length}` } },
    interrupt: async () => { interrupts += 1 },
    answerApproval() {},
  }
  const started = async () => ({ threadId: 'thread-1', adapter, close() {} })
  t.mock.method(engine, 'startCodexSession', started)

  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: cwd,
    profileRoot: path.parse(cwd).root,
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  t.after(async () => {
    await host.closeAll()
  })
  return { host, sent, interrupts: () => interrupts }
}

/* Put a running turn on the session -- Send now only interrupts a busy one. */
async function busy(host, sessionId) {
  await host.startSession({ sessionId })
  await host.sendTurn({ sessionId, text: 'the running turn', origin: 'person' })
}

test('reserve holds the freed boundary via the real priority decision, and survives the interrupt', async t => {
  const f = fixture(t)
  await busy(f.host, 'circle')

  const reserved = f.host.reserveSendNow({ sessionId: 'circle' })
  assert.equal(reserved.ok, true)
  assert.equal(typeof reserved.token, 'number')
  assert.ok(Number.isInteger(reserved.token) && reserved.token > 0, 'the token is a positive generation, not a timestamp')

  /* The host wrote personWaitingSince = a fresh wall-clock time; the real
     treeTurnDecision it feeds holds the boundary for a fresh wait and yields it
     when there is none. */
  const now = Date.now()
  assert.equal(courierDecision(now, now).reason, TREE_TURN_REASONS.PERSON_FIRST,
    'a fresh reservation holds the boundary the courier wanted')
  assert.equal(courierDecision(null, now).reason, TREE_TURN_REASONS.TAKE,
    'with nobody waiting the tree takes an idle boundary')

  await f.host.interrupt({ sessionId: 'circle' })
  assert.equal(f.interrupts(), 1, 'the interrupt reached the provider')

  /* The reservation survived the interrupt: releasing with the SAME token still
     clears it, which is impossible if the interrupt had dropped the generation. */
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: reserved.token }).released, true,
    'the reservation placed before the interrupt was still the session\'s after it')
})

test('an ordinary Halt reserves nothing', async t => {
  const f = fixture(t)
  await busy(f.host, 'circle')

  await f.host.interrupt({ sessionId: 'circle' })
  assert.equal(f.interrupts(), 1)

  /* Halt never called reserveSendNow, so the session has nothing of its own to
     release, and the courier is free at the boundary it frees. */
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: 1 }).released, false)
  assert.equal(courierDecision(null, Date.now()).reason, TREE_TURN_REASONS.TAKE)
})

test('same-session newer hold: a stale token clears nothing (clock-independent)', async t => {
  const f = fixture(t)
  await f.host.startSession({ sessionId: 'circle' })

  const first = f.host.reserveSendNow({ sessionId: 'circle' }).token
  const second = f.host.reserveSendNow({ sessionId: 'circle' }).token
  /* Distinct with no clock advance at all: the generation increments. */
  assert.equal(second, first + 1, 'the second reservation has the next generation')

  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: first }).released, false,
    'the first, now stale, hold clears nothing')
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: second }).released, true,
    'the current generation clears it')
})

test('a refused person send revises the reservation identity without losing the wait (frozen clock)', async t => {
  /* Freeze the clock so every personWaitingSince write is the SAME instant: only
     the GENERATION can tell the owners apart. If the token were a timestamp it
     would collide here and the release below would clear the wrong wait. */
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  const f = fixture(t)
  await busy(f.host, 'circle')

  const first = f.host.reserveSendNow({ sessionId: 'circle' }).token
  /* An overlapping person send is refused by design; that refusal REVISES the
     reservation generation (the host change) while PRESERVING the wait. */
  await assert.rejects(
    f.host.sendTurn({ sessionId: 'circle', text: 'send now words', origin: 'person' }),
    err => err?.code === 'AGENT_TURN_ACTIVE' || /already has an active turn/.test(err?.message || ''))

  /* Release the first token IMMEDIATELY, before any later reserve can mint over
     it: it clears nothing, and the only thing that could have made it stale --
     no clock advance, no second reserve -- is the refusal itself revising the
     generation. A later reserve would mask this, so it must come first. */
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: first }).released, false,
    'the refusal alone made the pre-refusal token stale')

  /* The refusal consumed exactly one generation, so the live owner of the still
     -standing wait is first + 1; releasing it clears the preserved wait, proving
     the wait was revised, not dropped. */
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: first + 1 }).released, true,
    'the refusal\'s revised generation still owns the preserved wait')
})

test('holdQueuedUserMessage keeps a live owner idempotently and re-mints only after it is cleared', async t => {
  /* Frozen clock: personWaitingSince cannot distinguish owners, so every claim
     below rests on the generation the pending tracker keeps or mints. */
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  const f = fixture(t)
  await f.host.startSession({ sessionId: 'circle' })

  /* A live reservation is a known owner. */
  const owner = f.host.reserveSendNow({ sessionId: 'circle' }).token

  /* waiting=true on a session that ALREADY waits KEEPS its owner: the tracker
     does not blindly re-mint an identity on every call, so repeated calls are a
     no-op on the generation. */
  f.host.holdQueuedUserMessage('circle', true)
  f.host.holdQueuedUserMessage('circle', true)
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: owner }).released, true,
    'the original owner still clears the hold after repeated waiting=true calls')

  /* The release cleared the owner; a fresh waiting=true is a NEW wait, so it
     mints the next generation -- distinct from the one just cleared. */
  f.host.holdQueuedUserMessage('circle', true)
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: owner }).released, false,
    'the cleared owner does not clear the freshly minted wait')
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: owner + 1 }).released, true,
    'the fresh waiting=true minted exactly the next generation')

  /* waiting=false clears; the next waiting=true mints yet another distinct owner,
     so waiting=false really dropped the identity rather than preserving it. */
  f.host.holdQueuedUserMessage('circle', true)   // owner + 2
  f.host.holdQueuedUserMessage('circle', false)  // cleared
  f.host.holdQueuedUserMessage('circle', true)   // owner + 3
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: owner + 2 }).released, false,
    'the owner minted before waiting=false no longer clears -- waiting=false cleared it')
  assert.equal(f.host.releaseSendNow({ sessionId: 'circle', token: owner + 3 }).released, true,
    'the waiting=true after waiting=false minted a new distinct owner')
})

test('holdQueuedUserMessage preserves a distinct owner per session', async t => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  const f = fixture(t)
  await f.host.startSession({ sessionId: 'a' })
  await f.host.startSession({ sessionId: 'b' })

  const ownerA = f.host.reserveSendNow({ sessionId: 'a' }).token
  const ownerB = f.host.reserveSendNow({ sessionId: 'b' }).token
  assert.notEqual(ownerA, ownerB, 'the two sessions were minted distinct owners')

  /* Idempotent waiting=true on each keeps ITS OWN owner: it neither re-mints nor
     adopts the other session's generation. */
  f.host.holdQueuedUserMessage('a', true)
  f.host.holdQueuedUserMessage('b', true)

  /* Cross-session release is refused; each session is cleared only by the owner
     the tracker preserved for it. */
  assert.equal(f.host.releaseSendNow({ sessionId: 'a', token: ownerB }).released, false,
    'session a is not cleared by session b\'s owner')
  assert.equal(f.host.releaseSendNow({ sessionId: 'a', token: ownerA }).released, true,
    'session a is cleared by its own preserved owner')
  assert.equal(f.host.releaseSendNow({ sessionId: 'b', token: ownerB }).released, true,
    'session b is cleared by its own preserved owner')
})

test('a release on one session, with another session\'s token, is refused', async t => {
  const f = fixture(t)
  await f.host.startSession({ sessionId: 'a' })
  await f.host.startSession({ sessionId: 'b' })

  const a = f.host.reserveSendNow({ sessionId: 'a' }).token
  const b = f.host.reserveSendNow({ sessionId: 'b' }).token
  assert.notEqual(a, b)

  assert.equal(f.host.releaseSendNow({ sessionId: 'a', token: b }).released, false,
    'session A\'s reservation is not cleared by session B\'s token')
  assert.equal(f.host.releaseSendNow({ sessionId: 'a', token: a }).released, true)
  assert.equal(f.host.releaseSendNow({ sessionId: 'b', token: b }).released, true)
})

/* THE WIRING (source guard). The runtime tests above prove the host mechanism;
   nothing here runs a DOM, so this pins the CALLS the renderer makes and the
   validated command-surface / IPC / preload routing the reservation travels.
   Like tree-turn-busy-race.test.mjs's own guard, a source slice pins wiring,
   not runtime behaviour; the runtime validated-path coverage of the two verbs
   is agent-command-surface.test.mjs (inventory balance + read-only refusal). */
test('the renderer reserves before the interrupt for a held Send now only, releases only when the words do not go, and the validated routing is in place (wiring guard)', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1 ')
  const read = rel => strip(readFileSync(path.join(ROOT, rel), 'utf8'))
  const components = read('src/components.js')
  const session = read('src/agent-session.js')
  const tree = read('src/views/computers.js')
  const surface = read('shell/agent-command-surface.cjs')
  const main = read('shell/main.cjs')
  const fleetPreload = read('shell/fleet-profile-preload.cjs')
  const remotePreload = read('shell/remote-workspace-preload.cjs')

  /* Renderer: reserve before the interrupt, only for a held Send now, on BOTH
     the queue-strip and composer Send-now paths. */
  assert.match(components, /onReserveHold = null, onReleaseHold = null/, 'buildChat accepts the reservation callbacks')
  const reservePins = components.match(/stopFirst && held && typeof onReserveHold === 'function'/g) || []
  assert.equal(reservePins.length, 2, 'both Send-now paths reserve only for a held Send now that will interrupt')
  /* The release is TIED TO THE ACTUAL SEND RESULT, not a pre-send flag: both
     paths hand deliverTurn an onSendOutcome that releases ONLY when the words
     did not reach the host, and no path pre-commits a `delivered` flag before
     the send settles (M12's v3 correction). */
  const outcomePins = components.match(/onSendOutcome: reachedHost => \{ if \(!reachedHost\) releaseReservation\(\) \}/g) || []
  assert.equal(outcomePins.length, 2, 'both Send-now paths release through deliverTurn\'s real send outcome')
  assert.ok(!/\bdelivered = true\b/.test(components) && !/\bdelivered = stopped\b/.test(components),
    'no path pre-commits a delivered flag before the send settles')
  /* deliverTurn fires the outcome exactly once: true when the words reach the
     host (accepted/queued), false on every terminal where they do not, and NOT
     on a retryable silent hold -- the reservation is preserved while pending. */
  assert.match(components, /const settleSend = reachedHost => \{\s+if \(sendOutcomeFired\) return/, 'deliverTurn has the fire-once send-outcome settler')
  assert.match(components, /settleSend\(true\)\s+if \(!optimisticRetracted\) confirmOwnerMessage/, 'an accepted turn settles the outcome as reached-host')
  const settleFalse = components.match(/settleSend\(false\)/g) || []
  assert.ok(settleFalse.length >= 5, `every not-sent terminal settles the outcome false (found ${settleFalse.length})`)
  /* The queue-strip finally releases ONLY before hand-off to delivery; after
     it, deliverTurn's outcome owns the release. The composer resolves its
     delivery gate on every path, so the outcome can never be stranded. */
  assert.match(components, /if \(!handedToDelivery\) releaseReservation\(\)/, 'the queue-strip releases in the finally only before hand-off to delivery')
  assert.match(components, /finally \{ openGate\?\.\(stopped\) \}/, 'the composer resolves the delivery gate on every path so the outcome always fires')

  /* Both renderer surfaces route the reservation through the host bridge. The
     method call is pinned form-agnostically (bridge or heldBridge) so the owner
     -capture upgrade below does not have to move the routing pin. */
  for (const [name, src] of [['agent-session.js', session], ['views/computers.js', tree]]) {
    assert.match(src, /reserveSendNow\(\{ sessionId/, `${name} reserves through the host bridge`)
    assert.match(src, /releaseSendNow\(\{ sessionId/, `${name} releases through the host bridge`)
  }

  /* OWNER CAPTURE (agent-session.js). The reservation handle captures the exact
     { bridge, sessionId, token } at reserve, and release targets THAT owner --
     never a sessionId re-read at release time -- so a hold reserved on session A
     releases on A even after the composer rebinds to B. The release promise's
     rejection is swallowed, so a bridge that rejects raises no unhandled
     rejection. */
  assert.match(session, /reserveSendNow\(\{ sessionId: heldSessionId \}\)/,
    'agent-session reserves against the session captured at reserve time')
  assert.match(session, /\{ bridge: heldBridge, sessionId: heldSessionId, token: reserved\.token \}/,
    'agent-session returns a handle that captures the exact owner')
  assert.match(session, /hold\.bridge\.releaseSendNow\(\{ sessionId: hold\.sessionId, token: hold\.token \}\)/,
    'agent-session releases the captured owner, not a fresh re-read')
  assert.match(session, /Promise\.resolve\(hold\.bridge\.releaseSendNow\([^)]*\)\)\.catch\(/,
    'agent-session swallows an async release rejection')

  /* The mounted tree/Send-now flow above exercises the tree callbacks through
     real clicks and IPC; no source-spelling assertion stands in for that behavior. */

  /* Validated command-surface / IPC / preload routing. */
  assert.match(surface, /'agent:reserve-send-now': Object\.freeze\(\{ write: true/, 'reserve is a write verb')
  assert.match(surface, /'agent:release-send-now': Object\.freeze\(\{ write: true/, 'release is a write verb')
  assert.match(surface, /currentAgentHost\(\)\.reserveSendNow\(request\)/, 'reserve routes to the host method')
  assert.match(surface, /currentAgentHost\(\)\.releaseSendNow\(\{ sessionId, token \}\)/, 'release forwards sessionId + token')
  assert.match(surface, /ownedAgentSession\(principal, request\.sessionId\)/, 'reserve is owner/session validated')
  assert.match(main, /ipcMain\.handle\('mc-agent:reserve-send-now'/, 'main.cjs registers reserve')
  assert.match(main, /ipcMain\.handle\('mc-agent:release-send-now'/, 'main.cjs registers release')
  assert.match(fleetPreload, /reserveSendNow: request => ipcRenderer\.invoke\('mc-agent:reserve-send-now', request\)/, 'fleet preload exposes reserve')
  assert.match(fleetPreload, /releaseSendNow: request => ipcRenderer\.invoke\('mc-agent:release-send-now', request\)/, 'fleet preload exposes release')
  assert.match(remotePreload, /reserveSendNow: 'reserve-send-now', releaseSendNow: 'release-send-now'/, 'remote preload maps both ops')
})
