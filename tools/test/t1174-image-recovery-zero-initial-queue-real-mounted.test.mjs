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

test('an image queued after an empty prepare is retained and warned while text recovery still completes', async () => {
  const newlyQueued = queueEntry('t1174-zero-then-queued-envelope', 'new image while recovery starts')
  const result = await runMountedImageRecovery({
    mode: 'zero-initial-queue',
    initialEntries: [],
    mutateDuringStart: ({ queue, replaceQueue }) => {
      replaceQueue({
        ...queue,
        generation: 'generation-after-new-image',
        entries: [newlyQueued],
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
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false)
  assert.deepEqual(result.queue.entries.map(entry => entry.envelopeId), [newlyQueued.envelopeId])
  assert.deepEqual(result.queue.entries[0].imageReceipts, newlyQueued.imageReceipts)
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: newlyQueued.envelopeId,
    deliveryState: 'not-sent',
    text: newlyQueued.text,
    buttons: ['Send again', 'Remove'],
  }])
  assert.equal(result.starts[0]?.threadId, T1174_START_THREAD)
  assert.equal(result.transcript?.threadId, T1174_THREAD)
  assert.notEqual(result.starts[0]?.threadId, result.transcript?.threadId)
})
