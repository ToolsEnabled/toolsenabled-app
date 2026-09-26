import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIVE_SESSION_PHASES,
  liveSessionFor,
  onLiveSession,
  publishLiveSession,
  readLiveSession,
  resetLiveSessionForTest,
} from '../../src/agent-session-registry.js'

const actions = () => ({
  pause: () => 'paused',
  respawn: () => 'respawned',
  terminate: () => 'terminated',
})

test.beforeEach(() => resetLiveSessionForTest())
test.after(() => resetLiveSessionForTest())

test('publishes the complete actionable record used by session surfaces', () => {
  const control = actions()
  const published = publishLiveSession({
    agentId: 'agent-7',
    sessionId: 'session-12',
    phase: 'working',
    control,
  })

  assert.notEqual(published, null,
    'a complete live-session record was rejected instead of being published')
  assert.strictEqual(readLiveSession(), published,
    'the registry reader did not return the record that the session publisher installed')
  assert.deepEqual(
    [published.agentId, published.sessionId, published.phase],
    ['agent-7', 'session-12', 'working'],
    'the published record lost identity or phase data that its real callers consume')
  assert.deepEqual(
    [published.control.pause(), published.control.respawn(), published.control.terminate()],
    ['paused', 'respawned', 'terminated'],
    'the published record did not preserve all three lifecycle actions')
  assert.ok(Object.isFrozen(published) && Object.isFrozen(published.control),
    'callers can mutate the registry record without publishing a change')
  assert.deepEqual([...LIVE_SESSION_PHASES], ['starting', 'open', 'working', 'stopping'],
    'a lifecycle phase emitted by the session owner is no longer accepted by the registry')
})

test('maps a live session only to the exact non-empty agent identity', () => {
  const published = publishLiveSession({
    agentId: 'agent-7', sessionId: 'session-12', phase: 'open', control: actions(),
  })

  assert.strictEqual(liveSessionFor('agent-7'), published,
    'the owning agent cannot recover its live session')
  for (const other of ['agent-8', '', '   ', null, undefined]) {
    assert.equal(liveSessionFor(other), null,
      `a non-owner identity (${String(other)}) was allowed to control the live session`)
  }
})

test('a malformed update clears an earlier mapping instead of leaving a definite answer', () => {
  publishLiveSession({ agentId: 'agent-7', sessionId: 'session-12', phase: 'open', control: actions() })
  const observations = []
  onLiveSession(record => observations.push(record))

  const result = publishLiveSession({
    agentId: 'agent-7', sessionId: 'session-12', phase: 'open', control: { pause() {} },
  })

  assert.equal(result, null,
    'a record whose required actions could not be established produced a definite mapping')
  assert.equal(readLiveSession(), null,
    'a malformed update left the previous session available as a definite answer')
  assert.deepEqual(observations, [null],
    'subscribers were not told that an unreadable mapping invalidated the previous answer')
})

test('subscribers are isolated, deduplicated, and can detach', () => {
  let safeCalls = 0
  const safe = () => { safeCalls += 1 }
  onLiveSession(() => { throw new Error('subscriber failed') })
  const unsubscribe = onLiveSession(safe)
  onLiveSession(safe)

  const record = { agentId: 'agent-7', sessionId: 'session-12', phase: 'starting', control: actions() }
  assert.doesNotThrow(() => publishLiveSession(record),
    'one failing subscriber escaped from publishLiveSession')
  assert.equal(safeCalls, 1,
    'one subscription function was notified more than once for a single change')
  unsubscribe()
  publishLiveSession({ ...record, phase: 'open' })
  assert.equal(safeCalls, 1,
    'an unsubscribed listener was called by a later change')
})

test('unchanged records do not manufacture change notifications', () => {
  const control = actions()
  const record = { agentId: 'agent-7', sessionId: 'session-12', phase: 'open', control }
  let changes = 0
  onLiveSession(() => { changes += 1 })

  const first = publishLiveSession(record)
  const repeated = publishLiveSession(record)

  assert.strictEqual(repeated, first,
    'republishing the same session replaced its stable record identity')
  assert.equal(changes, 1,
    'republishing an unchanged session announced a change that did not happen')
})

test('subscription refusal explains both the required operation and input kind', () => {
  assert.throws(
    () => onLiveSession('not callable'),
    error => error instanceof TypeError
      && /onLiveSession/i.test(error.message)
      && /listener|function|callable/i.test(error.message),
    'the invalid-subscription refusal does not identify the operation and callable requirement',
  )
})
