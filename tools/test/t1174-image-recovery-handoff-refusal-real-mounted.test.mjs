import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('sendAutomatic refusal does not enable image draining after the successor is attached', async () => {
  const retained = queueEntry('t1174-handoff-refusal-envelope')
  const result = await runMountedImageRecovery({
    mode: 'handoff-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.equal(result.handoffSends.length, 1)
  assert.equal(result.handoffSends[0], T1174_SUCCESSOR)
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false,
    'a sendAutomatic refusal must not enable image draining')
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.deepEqual(result.queue.entries, [retained])
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
})

