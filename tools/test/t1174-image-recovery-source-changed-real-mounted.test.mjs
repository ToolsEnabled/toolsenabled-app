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

test('SOURCE_CHANGED keeps retained rows while text handoff and outbox move complete on the mounted Computers path', async () => {
  const retained = queueEntry('t1174-source-changed-envelope')
  const unaffected = queueEntry('t1174-source-unchanged-envelope', 'unaffected retained synthetic image')
  const result = await runMountedImageRecovery({
    mode: 'source-changed',
    initialEntries: [retained, unaffected],
    mutateDuringStart: ({ queue, replaceQueue }) => {
      replaceQueue({
        ...queue,
        generation: 'generation-after-remove',
        entries: queue.entries.map(entry => entry.envelopeId === retained.envelopeId
          ? { ...entry, state: 'cancelled' }
          : { ...entry }),
      })
    },
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'running')
  assert.equal(result.node.statusNote,
    'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.')
  assert.equal(result.visibleStatusNote,
    'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.')
  assert.doesNotMatch(result.visibleStatusNote, /IMAGE_RECOVERY_/)
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false,
    'a refused recover result must not enable an image watcher or send')
  assert.deepEqual(result.queue.entries.map(entry => entry.envelopeId),
    [retained.envelopeId, unaffected.envelopeId])
  assert.deepEqual(result.queue.entries[0].imageReceipts, retained.imageReceipts)
  assert.deepEqual(result.queue.entries[1].imageReceipts, unaffected.imageReceipts)
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: unaffected.envelopeId,
    deliveryState: 'not-sent',
    text: unaffected.text,
    buttons: ['Send again', 'Remove'],
  }])
  assert.equal(result.starts[0]?.threadId, T1174_START_THREAD)
  assert.equal(result.transcript?.threadId, T1174_THREAD)
  assert.notEqual(result.starts[0]?.threadId, result.transcript?.threadId)
})
