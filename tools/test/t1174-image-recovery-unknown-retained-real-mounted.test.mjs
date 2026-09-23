import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_PREDECESSOR,
  T1174_SUCCESSOR,
  T1174_START_THREAD,
  T1174_THREAD,
  T1174_UNKNOWN_ENVELOPE,
  T1174_ORDINARY_ENVELOPE,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('an unknown retained image beside a terminal not-sent row is neither replayed nor dispatched', async () => {
  const ordinary = queueEntry(T1174_ORDINARY_ENVELOPE, 'ordinary retained image')
  const unknown = {
    ...queueEntry(T1174_UNKNOWN_ENVELOPE, 'unknown retained image'),
    state: 'unknown',
    deliveryDisposition: 'unknown',
    replay: false,
  }
  const result = await runMountedImageRecovery({
    mode: 'drain-refusal',
    initialEntries: [ordinary, unknown],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'running')
  assert.equal(result.visibleStatusNote,
    'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.')
  assert.doesNotMatch(result.visibleStatusNote, /IMAGE_/)
  assert.deepEqual(result.visibleImageRows, [
    {
      envelopeId: ordinary.envelopeId,
      deliveryState: 'not-sent',
      text: ordinary.text,
      buttons: ['Send again', 'Remove'],
    },
    {
      envelopeId: unknown.envelopeId,
      deliveryState: 'unknown',
      text: unknown.text,
      buttons: [],
    },
  ])
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.predecessorOutbox.length, 0)
  assert.deepEqual(result.imageCalls.filter(call => call.operation === 'dispatch')
    .map(call => call.envelopeId), [ordinary.envelopeId])
  assert.equal(result.imageCalls.some(call => call.envelopeId === unknown.envelopeId), false,
    'the unknown row must not be replayed by the accepted handoff')
  assert.deepEqual(result.dispatches, [])
  assert.deepEqual(result.unknownResponses, [])
  assert.deepEqual(result.queue.entries, [ordinary, unknown])
  assert.equal(result.queue.destinationSessionId, T1174_SUCCESSOR)
  assert.equal(result.starts[0]?.threadId, T1174_START_THREAD)
  assert.equal(result.transcript?.threadId, T1174_THREAD)
  assert.notEqual(result.starts[0]?.threadId, result.transcript?.threadId)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'running')
  assert.equal(result.node.sessionId === T1174_PREDECESSOR, false)
})
