import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONFIRMED_CONTROLS,
  SESSION_CONTROL_IDS,
  sessionControlAvailability,
  sessionControlFace,
} from '../../src/agent-session-controls.js'

const session = (overrides = {}) => ({
  agentId: 'terra-01',
  sessionId: 'session-1',
  phase: 'working',
  control: {},
  ...overrides,
})

test('a caller’s working session exposes exactly the controls the view renders', () => {
  const availability = sessionControlAvailability({
    live: true,
    agentId: 'terra-01',
    session: session(),
  })

  assert.deepEqual(SESSION_CONTROL_IDS, ['pause', 'respawn', 'terminate'],
    'the session-control roster no longer matches the three buttons rendered by the agent view')
  assert.equal(availability.mapped, true,
    'the working session was not mapped to the agent whose page started it')
  assert.deepEqual(SESSION_CONTROL_IDS.map(id => availability[id].enabled), [true, true, true],
    'a working session did not enable Pause, Respawn, and Terminate')
})

test('identity, transition, and in-flight failures fail closed rather than steering the wrong session', () => {
  const cases = [
    ['another agent', session({ agentId: 'luna-02' }), null],
    ['a session still starting', session({ phase: 'starting' }), null],
    ['a session already stopping', session({ phase: 'stopping' }), null],
    ['another control in flight', session(), 'respawn'],
  ]

  for (const [name, record, busy] of cases) {
    const availability = sessionControlAvailability({ live: true, agentId: 'terra-01', session: record, busy })
    assert.equal(availability.mapped, false, `${name} was represented as a steerable session`)
    assert.deepEqual(SESSION_CONTROL_IDS.map(id => availability[id].enabled), [false, false, false],
      `${name} left a session control enabled`)
    assert.match(availability.reason, /[.!?]$/,
      `${name} did not produce a complete refusal sentence`)
  }
})

test('a session that cannot be read does not collapse into the definite “no session” answer', () => {
  const unreadable = new Proxy({}, {
    get() { throw new Error('session registry could not be read') },
  })

  assert.throws(
    () => sessionControlAvailability({ live: true, agentId: 'terra-01', session: unreadable }),
    /session registry could not be read/,
    'an unreadable session was reported as a definite availability answer',
  )
})

test('the absence and idle answers tell a person what can be done without overstating Pause', () => {
  const absent = sessionControlAvailability({ live: true, agentId: 'terra-01', session: null })
  assert.equal(absent.mapped, false, 'no session was represented as a mapped session')
  assert.match(absent.reason, /start.+above/i,
    'the no-session refusal did not tell the person where to start one')
  assert.doesNotMatch(absent.reason, /observed control target|declared agent/i,
    'the no-session refusal exposed an internal mapping concept')

  const idle = sessionControlAvailability({ live: true, agentId: 'terra-01', session: session({ phase: 'open' }) })
  assert.equal(idle.pause.enabled, false, 'Pause was enabled even though no turn was running')
  assert.equal(idle.respawn.enabled, true, 'Respawn was disabled for an open session')
  assert.equal(idle.terminate.enabled, true, 'Terminate was disabled for an open session')
  assert.match(idle.pause.reason, /nothing.+running|stops a turn/i,
    'the idle Pause refusal did not explain when Pause can do work')
})

test('faces preserve confirmation safety and report an action already in flight', () => {
  assert.deepEqual(CONFIRMED_CONTROLS, ['respawn', 'terminate'],
    'the destructive controls no longer require confirmation exactly once')

  const ready = sessionControlAvailability({ live: true, agentId: 'terra-01', session: session() })
  assert.equal(sessionControlFace('pause', ready.pause, { step: 'confirm' }).phase, 'ready',
    'the recoverable Pause action was turned into a confirmation gesture')
  const confirming = sessionControlFace('terminate', ready.terminate, { step: 'confirm' })
  assert.equal(confirming.phase, 'confirm', 'Terminate did not enter its confirmation step')
  assert.match(confirming.message, /select.+terminate.+again/i,
    'the Terminate confirmation did not explain the second gesture')

  const gone = sessionControlAvailability({ live: true, agentId: 'terra-01', session: null })
  assert.equal(sessionControlFace('terminate', gone.terminate, { step: 'confirm' }).phase, 'unavailable',
    'confirmation overrode a session that was no longer available')

  const busy = sessionControlAvailability({ live: true, agentId: 'terra-01', session: session(), busy: 'terminate' })
  const pending = sessionControlFace('terminate', busy.terminate, { step: 'pending' })
  assert.equal(pending.phase, 'pending',
    'the in-flight Terminate action was displayed as unavailable instead of pending')
  assert.equal(busy.terminate.enabled, false,
    'reporting an in-flight action made the destructive control clickable again')
  assert.match(pending.message, /nothing else.+until.+answers/i,
    'the pending face did not explain that another action will not be sent')
})
