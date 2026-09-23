import assert from 'node:assert/strict'
import test from 'node:test'
import { assertInterruptedEvidence } from '../lib/page2-native-functions-scenarios.cjs'

function evidence(method = 'actions') {
  const before = { id: 'selected-child', sessionId: 'selected-session' }
  return { method, before, after: { ...before, status: 'interrupted' },
    visibleStatus: 'stopped by you', actionVisible: method === 'actions', actionReceipt: 'Interrupted.',
    partialBefore: '1. owned interruption check', replyAfter: '1. owned interruption check\n2. owned interruption check' }
}

test('a confirmed same-session interruption keeps partial output and the actual visible result', () => {
  for (const method of ['slash', 'actions']) {
    const value = evidence(method)
    assert.equal(assertInterruptedEvidence(value).sessionId, 'selected-session')
    assert.equal(assertInterruptedEvidence(value).partialCharacters, value.partialBefore.length)
    value.partialBefore = ''
    value.replyAfter = 'Interrupted.'
    assert.equal(assertInterruptedEvidence(value).partialCharacters, 0)
  }
})

test('a different child or session and non-user terminal states cannot earn interruption credit', () => {
  for (const mutate of [
    value => { value.after.id = 'other-child' },
    value => { value.after.sessionId = 'replacement-session' },
    ...['finished', 'turn-failed', 'running'].map(status => value => { value.after.status = status }),
  ]) {
    const value = evidence()
    mutate(value)
    assert.throws(() => assertInterruptedEvidence(value))
  }
})

test('a missing, hidden or non-accepted visible interruption receipt stays a failure', () => {
  for (const mutate of [
    value => { value.visibleStatus = '' },
    value => { value.visibleStatus = 'finished' },
    value => { value.actionVisible = false },
    value => { value.actionReceipt = '[object Object]' },
    value => { value.actionReceipt = 'Nothing was interrupted; the turn may already be over.' },
  ]) {
    const value = evidence()
    mutate(value)
    assert.throws(() => assertInterruptedEvidence(value))
  }
})

test('interruption cannot silently drop the already-visible partial reply', () => {
  for (const replyAfter of ['', 'Interrupted.', '2. owned interruption check']) {
    assert.throws(() => assertInterruptedEvidence({ ...evidence(), replyAfter }))
  }
})
