import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('an incomplete source-changed drain response cannot use the pre-dispatch shortcut', async () => {
  const retained = queueEntry('t1174-incomplete-source-changed-envelope')
  const result = await runMountedImageRecovery({
    mode: 'source-changed-incomplete-drain-refusal',
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
    responseCode: 'IMAGE_RECOVERY_SOURCE_CHANGED',
    hasDisposition: false,
    hasResult: false,
  }])
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 1)
  assert.equal(result.dispatches.length, 0, 'an incomplete source-changed drain response cannot count as an image send')
  assert.deepEqual(result.queue.entries, [retained])
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
})
