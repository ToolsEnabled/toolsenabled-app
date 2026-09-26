import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('a dispatch identity mismatch remains fatal and cannot become an image-only refusal', async () => {
  const retained = queueEntry('t1174-dispatch-identity-envelope')
  const result = await runMountedImageRecovery({
    mode: 'dispatch-identity-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.doesNotMatch(result.visibleStatusNote, /IMAGE_RECOVERY_DISPATCH_IDENTITY_CHANGED/)
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 1)
  assert.deepEqual(result.dispatches, [])
  assert.deepEqual(result.identityResponses, [{
    envelopeId: retained.envelopeId,
    responseCode: 'IMAGE_DELIVERY_NOT_SENT',
    responseSessionId: 't1174-image-predecessor',
    replay: false,
    retained: true,
  }])
  assert.equal(result.queue.destinationSessionId, T1174_SUCCESSOR)
  assert.deepEqual(result.queue.entries, [retained])
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
})
