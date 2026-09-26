import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_PREDECESSOR,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('a native custody authority refusal stays fatal despite a valid not-sent terminal snapshot', async () => {
  const retained = queueEntry('t1174-authority-terminal-envelope')
  const result = await runMountedImageRecovery({
    mode: 'authority-terminal-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.doesNotMatch(result.visibleStatusNote, /Retained images were kept/)
  // The native refusal is returned by post-accepted drain. Text handoff and
  // outbox movement therefore already happened, but the authority refusal
  // must still stop the image-only continuation before thread persistence.
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.deepEqual(result.authorityResponses, [{
    envelopeId: retained.envelopeId,
    responseCode: 'IMAGE_CUSTODY_CANDIDATE_REFUSED',
    responseSessionId: T1174_SUCCESSOR,
    deliveryDisposition: 'not-sent',
    dispatchStarted: false,
    candidateCreated: false,
    replay: false,
  }])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 1)
  assert.equal(result.dispatches.length, 0, 'the authority refusal cannot be counted as an image send')
  assert.deepEqual(result.queue.entries, [retained])
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
  assert.equal(result.queue.destinationSessionId, T1174_SUCCESSOR)
  assert.equal(result.queue.entries[0].state, 'not-sent')
  assert.notEqual(result.queue.destinationSessionId, T1174_PREDECESSOR)
})
