import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_PREDECESSOR,
  T1174_SUCCESSOR,
  T1174_START_THREAD,
  T1174_THREAD,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('a terminal image drain refusal after accepted handoff keeps the successor running and saves its threadId', async () => {
  const retained = queueEntry('t1174-drain-refusal-envelope')
  const result = await runMountedImageRecovery({
    mode: 'drain-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'running')
  assert.equal(result.node.statusNote,
    'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.')
  assert.equal(result.visibleStatusNote,
    'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.')
  assert.doesNotMatch(result.visibleStatusNote, /IMAGE_RECOVERY_/)
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.predecessorOutbox.length, 0)
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 1)
  assert.equal(result.dispatches.length, 0, 'a not-sent drain refusal must not be counted as an image send')
  assert.equal(result.queue.entries.find(entry => entry.envelopeId === retained.envelopeId)?.state, 'not-sent')
  assert.equal(result.starts[0]?.threadId, T1174_START_THREAD)
  assert.equal(result.transcript?.threadId, T1174_THREAD)
  assert.notEqual(result.starts[0]?.threadId, result.transcript?.threadId)
})
