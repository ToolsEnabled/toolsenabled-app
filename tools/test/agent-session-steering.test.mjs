// STEERING A SESSION THIS APP OWNS.
//
// THE DEFECT: with a session genuinely running, Pause, Respawn and Terminate
// all reported that no observed control target was mapped to the declared
// agent. Starting and watching an agent worked; steering one did not.
//
// THE ROOT was not in the controls. src/agent-session.js took `agentId` and
// never read it, so the session it started was anonymous -- there was nothing
// for a control to be mapped TO. The Controls panel meanwhile asked the
// mission-bridge projection for a `controlTarget`, which describes a REMOTE
// observed run and is null on every local install. Both halves were correct in
// isolation; nothing joined them.
//
// WHAT THIS SUITE CAN AND CANNOT SEE. It exercises the mapping and the
// decision, which are pure and belong in `node --test`. It cannot see whether
// the buttons are wired to them -- source text greps the same for live code and
// dead code -- so the reachability half is measured on the real window by
// `node tools/run-steering-controls-e2e.cjs`, and the two are deliberately not
// substitutes for each other.
//
// THAT SENTENCE USED TO NAME tools/agent-steering-packaged-qa.mjs, WHICH DOES
// NOT EXIST. A suite header claiming a second half that was never written is
// the same defect this file is about, one level up: the half that proves the
// control reaches a process was the half nobody had. The named runner boots
// shell/main.cjs, presses Start, Pause, Respawn and Terminate on the real page,
// and checks each claim against the Windows process table by pid.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  LIVE_SESSION_PHASES,
  liveSessionFor,
  onLiveSession,
  publishLiveSession,
  readLiveSession,
  resetLiveSessionForTest,
} from '../../src/agent-session-registry.js'
import {
  CONFIRMED_CONTROLS,
  SESSION_CONTROL_IDS,
  sessionControlAvailability,
  sessionControlFace,
} from '../../src/agent-session-controls.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

const control = () => ({ pause: async () => ({ ok: true }), respawn: async () => ({ ok: true }), terminate: async () => ({ ok: true }) })
const record = (over = {}) => ({ agentId: 'terra-01', sessionId: 'session-1', phase: 'open', control: control(), ...over })

/* ---------- the mapping ---------- */

test('a session started on an agent page belongs to that agent', () => {
  resetLiveSessionForTest()
  assert.equal(readLiveSession(), null, 'nothing is running before anything starts')
  publishLiveSession(record())
  assert.equal(liveSessionFor('terra-01').sessionId, 'session-1')
  /* THE DEFECT, STATED AS AN ASSERTION. This is the exact question the Controls
     panel asks, and before the mapping existed the answer was always null. */
  assert.notEqual(liveSessionFor('terra-01'), null, 'a running session is not mapped to the agent whose page started it')
})

test('one agent page cannot steer another agent’s session', () => {
  resetLiveSessionForTest()
  publishLiveSession(record({ agentId: 'terra-01' }))
  assert.equal(liveSessionFor('codex'), null)
  assert.equal(liveSessionFor(''), null, 'an empty id must not match anything')
  assert.equal(liveSessionFor(null), null)
  assert.equal(liveSessionFor('TERRA-01'), null, 'the comparison is exact, not case-folded')
})

/* A PARTIAL RECORD IS THE DANGEROUS SHAPE. Three destructive controls read this
   module to decide whether they may act, so a record naming an agent but not a
   session would map a control to something it cannot address. */
test('a record that cannot be acted on is not a record', () => {
  for (const broken of [
    { agentId: '', sessionId: 's', phase: 'open', control: control() },
    { agentId: 'a', sessionId: '', phase: 'open', control: control() },
    { agentId: 'a', sessionId: 's', phase: 'invented', control: control() },
    { agentId: 'a', sessionId: 's', phase: 'open' },
    { agentId: 'a', sessionId: 's', phase: 'open', control: { pause: async () => {} } },
    { agentId: 'a', sessionId: 's', phase: 'open', control: 'yes' },
  ]) {
    resetLiveSessionForTest()
    publishLiveSession(record())
    publishLiveSession(broken)
    assert.equal(readLiveSession(), null, `a malformed record was stored instead of clearing: ${JSON.stringify(Object.keys(broken))}`)
  }
})

test('subscribers are told, and one that throws does not silence the rest', () => {
  resetLiveSessionForTest()
  const seen = []
  onLiveSession(() => { throw new Error('a subscriber may be broken') })
  onLiveSession(session => seen.push(session?.phase ?? null))
  publishLiveSession(record({ phase: 'starting' }))
  publishLiveSession(record({ phase: 'working' }))
  publishLiveSession(null)
  assert.deepEqual(seen, ['starting', 'working', null])
})

test('publishing the same state twice does not repaint', () => {
  resetLiveSessionForTest()
  let announcements = 0
  onLiveSession(() => { announcements += 1 })
  const shared = control()
  publishLiveSession(record({ control: shared }))
  publishLiveSession(record({ control: shared }))
  assert.equal(announcements, 1, 'an unchanged record must not announce')
  publishLiveSession(record({ control: shared, phase: 'working' }))
  assert.equal(announcements, 2)
})

test('every phase the registry accepts is one the controls decide about', () => {
  for (const phase of LIVE_SESSION_PHASES) {
    const decision = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase }) })
    assert.ok(typeof decision.reason === 'string' && decision.reason.length > 10, `${phase} produces no sentence`)
    for (const id of SESSION_CONTROL_IDS) {
      assert.equal(typeof decision[id].enabled, 'boolean', `${id} has no decision at phase ${phase}`)
    }
  }
})

/* ---------- the decision ---------- */

test('with a session running for this agent, all three are steerable', () => {
  const decision = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }) })
  assert.equal(decision.mapped, true)
  assert.equal(decision.pause.enabled, true)
  assert.equal(decision.respawn.enabled, true)
  assert.equal(decision.terminate.enabled, true)
})

/* PAUSE IS OFFERED ONLY OVER A RUNNING TURN, and this is the house rule about
   controls that look wired and change nothing: interrupt() over an idle session
   succeeds and stops nothing. */
test('pause is not offered when there is no turn to stop', () => {
  const idle = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'open' }) })
  assert.equal(idle.pause.enabled, false)
  assert.match(idle.pause.reason, /Nothing is running/)
  assert.equal(idle.terminate.enabled, true, 'an idle session is still a session that can be ended')
  assert.equal(idle.respawn.enabled, true)
})

test('a session that is starting or stopping is not yet, or no longer, steerable', () => {
  for (const [phase, pattern] of [['starting', /still starting/], ['stopping', /closing/]]) {
    const decision = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase }) })
    assert.equal(decision.mapped, false)
    assert.match(decision.reason, pattern)
    for (const id of SESSION_CONTROL_IDS) assert.equal(decision[id].enabled, false)
  }
})

test('nothing is steerable from the demonstration page', () => {
  const decision = sessionControlAvailability({ live: false, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }) })
  assert.equal(decision.mapped, false)
  for (const id of SESSION_CONTROL_IDS) assert.equal(decision[id].enabled, false)
  assert.match(decision.reason, /example agents/i)
  /* `live` defaults to false, so a caller that never considered the question
     cannot accidentally answer yes -- the same direction the Start control's
     own fence takes. */
  assert.equal(sessionControlAvailability({ agentId: 'a', session: record({ agentId: 'a' }) }).mapped, false)
  assert.equal(sessionControlAvailability().mapped, false)
})

test('the refusal a person actually reads tells them what to do', () => {
  const decision = sessionControlAvailability({ live: true, agentId: 'a', session: null })
  assert.equal(decision.mapped, false)
  /* The sentence this replaces was "no observed control target is mapped to
     this declared agent": accurate, and useless to the person reading it. */
  assert.doesNotMatch(decision.reason, /observed control target|declared agent/i)
  assert.match(decision.reason, /Start one above/)
})

test('one control at a time, because respawn is a close and a start', () => {
  const decision = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }), busy: 'respawn' })
  assert.equal(decision.mapped, false)
  for (const id of SESSION_CONTROL_IDS) assert.equal(decision[id].enabled, false)
  assert.match(decision.reason, /Respawn is still running/)
})

/* ---------- what the button says ---------- */

test('the two that destroy a running child confirm first', () => {
  assert.deepEqual([...CONFIRMED_CONTROLS], ['respawn', 'terminate'])
  const state = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }) })
  const confirming = sessionControlFace('terminate', state.terminate, { step: 'confirm' })
  assert.equal(confirming.phase, 'confirm')
  assert.match(confirming.message, /Select Terminate again/)
  /* Pause is recoverable -- the session survives it -- so it does not ask
     twice, and asking twice for it would train people to click through the
     question that matters. */
  assert.equal(sessionControlFace('pause', state.pause, { step: 'confirm' }).phase, 'ready')
})

test('a control whose session ended cannot show a confirm step', () => {
  const gone = sessionControlAvailability({ live: true, agentId: 'a', session: null })
  const face = sessionControlFace('terminate', gone.terminate, { step: 'confirm' })
  assert.equal(face.phase, 'unavailable', 'availability outranks the step, always')
  assert.equal(face.note, 'Unavailable')
})

/* THE PENDING FACE, COMPUTED THE WAY THE VIEW COMPUTES IT.
 *
 * Not `sessionControlFace(id, someEnabledState, { step: 'pending' })`. That call
 * passes a state the product cannot produce: the view derives every state from
 * ONE sessionControlAvailability({ busy }) reading, and the busy control is
 * precisely the one that reading answers off() for. Asserting against a
 * hand-made enabled state is how "Working…" stayed green for a release while
 * every real press painted "Unavailable" -- a passing test over an unreachable
 * branch.
 *
 * So this test builds the availability first, with `busy` set, and reads the
 * face out of it exactly as src/views/agent.js does. */
test('the control being pressed says it is working, not that it is unavailable', () => {
  for (const busy of SESSION_CONTROL_IDS) {
    const state = sessionControlAvailability({
      live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }), busy,
    })
    const face = sessionControlFace(busy, state[busy], { step: 'pending' })
    assert.equal(face.phase, 'pending', `${busy} must report the action it is running`)
    assert.equal(face.note, 'Working…')
    assert.match(face.message, /Nothing else is sent until it answers/)
    /* It must still be un-pressable. The view disables from the availability,
       which is the thing that stayed false; saying "Working…" must not be a
       route to a second press of a destructive control. */
    assert.equal(state[busy].enabled, false)
    /* And the OTHER two are unavailable, not pending: only the control that was
       pressed is running. */
    for (const other of SESSION_CONTROL_IDS.filter(id => id !== busy)) {
      assert.equal(sessionControlFace(other, state[other], { step: 'idle' }).phase, 'unavailable')
    }
  }
})

test('an idle control over a dead session never borrows the pending face', () => {
  /* The absence case: `step` defaults to idle, so a caller that forgot to pass
     one cannot get "Working…" over a session that is not there. */
  const gone = sessionControlAvailability({ live: true, agentId: 'a', session: null })
  assert.equal(sessionControlFace('terminate', gone.terminate).phase, 'unavailable')
  assert.equal(sessionControlFace('terminate', gone.terminate, { step: 'idle' }).phase, 'unavailable')
  assert.equal(sessionControlFace('terminate', undefined).phase, 'unavailable')
})

test('every control names what it does, not the fleet verb it resembles', () => {
  const state = sessionControlAvailability({ live: true, agentId: 'a', session: record({ agentId: 'a', phase: 'working' }) })
  /* Pause is an interrupt, so it must not promise to resume. This is the
     "dont lie like we cant control temperature" rule applied to a word. */
  assert.doesNotMatch(state.pause.reason, /resume|continue where|pick up/i)
  assert.match(state.pause.reason, /Stops the turn/)
  assert.match(state.respawn.reason, /lost/, 'respawn destroys the transcript and must say so')
  assert.match(state.terminate.reason, /child process/)
})

/* ---------- the two halves are joined in the shipped code ---------- */

/* Source text cannot prove reachability, so these assert only that the join
   EXISTS at all: the surface reads the agent id it is given, and the view asks
   the registry about it. Whether the buttons then move is measured on the
   packaged window. */
test('the session surface records which agent it belongs to', () => {
  const surface = read('src/agent-session.js')
  assert.match(surface, /publishLiveSession\(\{/, 'the surface must publish its session')
  assert.match(surface, /agentId,\n\s*sessionId,/, 'the published record must carry the agent id')
  assert.match(surface, /publishLiveSession\(null\)/, 'the record must be cleared when the surface goes away')
})

test('the controls panel asks the registry about this agent', () => {
  const view = read('src/views/agent.js')
  assert.match(view, /liveSessionFor\(agent\.id\)/)
  assert.match(view, /sessionControlAvailability\(/)
  /* And the bridge terminate is not replaced: the remote observed-run path and
     its refusals are the other case, not the wrong one. */
  assert.match(view, /createTerminateController\(/, 'the bridge terminate must still exist for a remote observed run')
})
