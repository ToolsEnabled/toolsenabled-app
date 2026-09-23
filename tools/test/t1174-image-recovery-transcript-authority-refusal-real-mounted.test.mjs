import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_OWNER,
  T1174_PREDECESSOR,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('owner epoch loss during the awaited recording save blocks handoff publication', async () => {
  const retained = queueEntry('t1174-transcript-authority-envelope')
  const result = await runMountedImageRecovery({
    mode: 'transcript-authority-refusal',
    initialEntries: [retained],
    mutateDuringTranscriptSave: ({ changeOwner }) => {
      changeOwner(Object.freeze({
        ...T1174_OWNER,
        currentEpoch: 't1174-synthetic-epoch-2',
      }))
    },
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.equal(result.starts.length, 1)
  assert.deepEqual(result.closes, [T1174_PREDECESSOR])
  assert.deepEqual(result.handoffSends, [])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false)
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.queue.destinationSessionId, T1174_SUCCESSOR)
  assert.deepEqual(result.queue.entries, [retained])
  assert.equal(result.transcript, null)
})
