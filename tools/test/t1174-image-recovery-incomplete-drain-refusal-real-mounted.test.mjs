import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('an incomplete drain refusal stays fatal and retains the image without a continuation notice', async () => {
  const retained = queueEntry('t1174-incomplete-drain-envelope')
  const result = await runMountedImageRecovery({
    mode: 'drain-incomplete-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.doesNotMatch(result.visibleStatusNote, /Retained images were kept/)
  assert.deepEqual(result.incompleteResponses, [{
    envelopeId: retained.envelopeId,
    responseCode: 'IMAGE_RECOVERY_DRAIN_REFUSED',
    hasDisposition: false,
    hasResult: false,
  }])
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 1)
  assert.equal(result.dispatches.length, 0, 'an incomplete refusal cannot be counted as an image send')
  assert.deepEqual(result.queue.entries, [retained])
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
})
