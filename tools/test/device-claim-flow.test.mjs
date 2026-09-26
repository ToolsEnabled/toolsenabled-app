/* The device-claim rules are deliberately DOM-free. These tests exercise the
 * values connect-computer-settings.js passes to the exported helpers and the
 * customer-visible distinctions the state machine must preserve. */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultDeviceName,
  canBeginConnection,
  clockShouldRun,
  initialState,
  nameToClaim,
  pollDue,
  pollSeconds,
  reduce,
  remainingText,
} from '../../src/device-claim-flow.js'

const NOW = 1_800_000_000_000
const CODE = 'TC-4KQ2-9WFA'

test('caller inputs retain the chosen device name and the service polling cadence', () => {
  const defaultName = defaultDeviceName({ profileLabel: '  Front desk  ', platform: 'Win32' })
  let state = initialState({ name: defaultName, platform: 'Win32' })

  assert.equal(nameToClaim({ ...state, name: '   ' }), defaultName,
    'clearing the input must retain the name that the caller originally displayed')

  state = reduce(state, {
    type: 'begin-result',
    nowMs: NOW,
    result: { ok: true, code: CODE, expiresAtMs: NOW + 60_000, intervalSeconds: 7 },
  })
  assert.equal(state.claimedName, defaultName,
    'the waiting state must describe the same device name sent by the caller')
  assert.equal(pollSeconds(7), 7,
    'the polling helper must preserve a valid cadence supplied by the service')
  assert.equal(pollDue(state, NOW + 6_999), false,
    'the next poll must not become due before the service cadence elapses')
  assert.equal(pollDue(state, NOW + 7_000), true,
    'the next poll must become due when the service cadence elapses')
})

test('a status that could not be read remains unknown rather than becoming a definite answer', () => {
  const state = reduce(initialState({ name: 'Front desk' }), {
    type: 'status',
    result: {
      ok: false,
      code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE',
      reason: 'The audited connection is not answering yet.',
    },
  })

  assert.equal(state.phase, 'unknown',
    'a could-not-read status must not collapse into the definite idle answer')
  assert.equal(state.refusalPressed, false,
    'a background read failure must not be presented as a refusal caused by the user')
  assert.match(state.refusal, /not answering/i,
    'the unknown state must explain that the connection could not be read')
})

test('a successful answer without a usable code refuses to invent one and offers recovery', () => {
  const state = reduce(initialState({ name: 'Front desk' }), {
    type: 'begin-result',
    nowMs: NOW,
    result: { ok: true, code: 'not-a-device-code' },
  })

  assert.equal(state.phase, 'idle',
    'an unusable code must return the user to the screen that can request another')
  assert.equal(state.code, null,
    'an unusable service value must never be exposed as a device code')
  assert.match(state.refusal, /ask.+again/i,
    'the codeless-answer refusal must offer the user a way to request another code')
})

test('replacing an open claim explains both the replacement and the unfinished account entry', () => {
  const state = reduce(initialState({ name: 'Front desk' }), { type: 'claim-dropped' })

  assert.match(state.note, /new one/i,
    'the dropped-claim note must direct the user to the replacement code')
  assert.match(state.note, /remove.+account page/i,
    'the dropped-claim note must explain how to clean up a half-finished account entry')
})

test('expiry copy distinguishes unread timing from a code that is definitely spent', () => {
  assert.match(remainingText(undefined, NOW), /not told/i,
    'a missing expiry must be described as unknown rather than as expired')
  assert.match(remainingText(NOW - 1, NOW), /new one/i,
    'a definitely expired code must offer the user a fresh-code next step')
})

const stopped = { remoteAccessBlocked: true, remoteStopped: true, childQuiescent: true, restartSafety: 'recorded', disconnectPending: false }
const joined = () => reduce(initialState({ name: 'Front desk' }), { type: 'status', result: { ok: true, connected: true, name: 'Front desk' } })
const disconnected = result => reduce(reduce(joined(), { type: 'disconnect-requested' }), { type: 'disconnect-result', result })

test('disconnect immediately expires the earlier joined observation and claim clock', () => {
  const state = reduce({ ...joined(), serviceConfirmed: true }, { type: 'disconnect-requested' })
  assert.equal(state.phase, 'disconnecting')
  assert.equal(state.device, null); assert.equal(state.serviceConfirmed, false)
  assert.equal(clockShouldRun(state), false); assert.equal(canBeginConnection(state), false)
  assert.equal(state.disconnect.remoteStopped, null)
})

test('missing or failed disconnect receipts never assert unchanged credentials or offer a retry', () => {
  for (const result of [null, {}, { ok: false, code: 'DEVICE_CLAIM_DISCONNECT_FAILED', reason: 'Nothing changed. Restart and try once more. token=private' }]) {
    const state = disconnected(result)
    assert.equal(state.phase, 'disconnect-review'); assert.equal(state.serviceConfirmed, false)
    assert.equal(state.disconnect.mutationOutcome, 'UNCERTAIN')
    assert.equal(state.disconnect.credentialCleared, null)
    assert.equal(canBeginConnection(state), false); assert.equal(clockShouldRun(state), false)
    assert.doesNotMatch(state.refusal, /Nothing changed|restart|try once more|private/i)
    assert.match(state.refusal, /Check connection status/)
  }
})

test('confirmed removal is distinct from a fresh read of credential absence', () => {
  let state = disconnected({ ok: true, wasConnected: true, credentialCleared: true, mutationOutcome: 'REMOVED_SYNCED', ...stopped })
  assert.equal(state.disconnect.credentialCleared, true)
  assert.equal(state.disconnect.credentialObservedAbsent, false)
  assert.equal(canBeginConnection(state), false)
  state = reduce(state, { type: 'status', result: { ok: true, connected: false, ...stopped } })
  assert.equal(state.phase, 'idle'); assert.equal(canBeginConnection(state), true)
  assert.equal(state.disconnect.mutationOutcome, 'REMOVED_SYNCED')
  assert.equal(state.disconnect.remoteAccessBlocked, true)
})

test('later absence preserves the earlier mutation outcome and requires observed process completion', () => {
  for (const mutationOutcome of ['NOT_ATTEMPTED', 'REMOVED_SYNCED', 'UNCERTAIN']) {
    const prior = disconnected({ ok: false, mutationOutcome, ...stopped })
    for (const incomplete of [{ childQuiescent: false }, { childQuiescent: 'true' }, { remoteStopped: false }, { remoteAccessBlocked: false }]) {
      const state = reduce(prior, { type: 'status', result: { ok: true, connected: false, ...stopped, ...incomplete } })
      assert.equal(state.disconnect.credentialObservedAbsent, true)
      assert.equal(state.disconnect.mutationOutcome, mutationOutcome)
      assert.equal(canBeginConnection(state), false)
    }
    const absent = reduce(prior, { type: 'status', result: { ok: true, connected: false, ...stopped } })
    assert.equal(canBeginConnection(absent), true)
    assert.equal(absent.disconnect.mutationOutcome, mutationOutcome)
  }
})

test('a blocked credential observed at startup is not an active connection', () => {
  const state = reduce(initialState(), { type: 'status', result: { ok: true, connected: true, ...stopped, disconnectPending: true } })
  assert.equal(state.phase, 'disconnect-review')
  assert.equal(state.disconnect.credentialPresent, true)
  assert.equal(state.device, null); assert.equal(state.serviceConfirmed, false)
  assert.equal(canBeginConnection(state), false)
})

test('unrecognized fields and contradictory clear receipts cannot manufacture certainty', () => {
  const state = disconnected({ ok: true, credentialCleared: true, mutationOutcome: 'UNCERTAIN',
    childQuiescent: 1, remoteStopped: 'true', remoteAccessBlocked: {}, restartSafety: 'maybe',
    localCause: 'SECRET_UNTRUSTED_PRIVATE_DATA', credentialObservedAbsent: true, connected: false })
  assert.equal(state.disconnect.credentialCleared, null)
  assert.equal(state.disconnect.childQuiescent, null); assert.equal(state.disconnect.remoteStopped, null)
  assert.equal(state.disconnect.localCause, null); assert.equal(state.disconnect.restartSafety, 'unknown')
  assert.equal(state.disconnect.credentialObservedAbsent, false)
  assert.equal(canBeginConnection(state), false)
})

test('late connected polls and direct new-code requests cannot escape disconnect review', () => {
  const state = disconnected({ ok: false, mutationOutcome: 'UNCERTAIN', ...stopped })
  assert.equal(reduce(state, { type: 'poll-result', result: { ok: true, state: 'connected' } }), state)
  assert.equal(reduce(state, { type: 'begin-requested' }), state)
})

test('cancel and claim-finalization refusals retain recovery without restart advice or a polling clock', () => {
  const prior = disconnected({ ok: false, mutationOutcome: 'UNCERTAIN', ...stopped })
  const absent = reduce(prior, { type: 'status', result: { ok: true, connected: false, ...stopped } })
  const cancelled = reduce(absent, { type: 'cancel-refused', result: { ok: false, reason: 'Restart and try again.' } })
  assert.equal(cancelled.phase, 'disconnect-review'); assert.doesNotMatch(cancelled.refusal, /restart|try again/i)
  for (const code of ['DEVICE_CLAIM_INVALIDATED', 'DEVICE_CLAIM_CONSENT_CLEAR_FAILED', 'DEVICE_CLAIM_CONNECTION_STATE_WRITE_FAILED']) {
    const waiting = { ...absent, phase: 'waiting', nextPollAtMs: NOW + 1000 }
    const refused = reduce(waiting, { type: 'poll-result', result: { ok: false, code, remoteAccessBlocked: true } })
    assert.equal(refused.phase, 'disconnect-review'); assert.equal(clockShouldRun(refused), false)
    assert.equal(refused.nextPollAtMs, null)
  }
})

test('only a new completed claim with a cleared native fence restores the connected phase', () => {
  let state = disconnected({ ok: false, mutationOutcome: 'UNCERTAIN', ...stopped })
  state = reduce(state, { type: 'status', result: { ok: true, connected: false, ...stopped } })
  state = reduce(state, { type: 'begin-requested' })
  state = reduce(state, { type: 'begin-result', nowMs: NOW, result: { ok: true, code: CODE, expiresAtMs: NOW + 60000 } })
  const refused = reduce(state, { type: 'poll-result', result: { ok: true, state: 'connected', remoteAccessBlocked: true } })
  assert.equal(refused.phase, 'disconnect-review')
  const connected = reduce(state, { type: 'poll-result', result: { ok: true, state: 'connected', remoteAccessBlocked: false } })
  assert.equal(connected.phase, 'connected'); assert.equal(connected.disconnect, null)
})
