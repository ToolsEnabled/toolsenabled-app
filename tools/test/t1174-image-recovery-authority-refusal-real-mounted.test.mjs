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

test('owner epoch loss after attach remains a visible recovery failure and preserves text and images', async () => {
  const retained = queueEntry('t1174-authority-refusal-envelope')
  const result = await runMountedImageRecovery({
    mode: 'authority-refusal',
    initialEntries: [retained],
    mutateDuringStart: ({ changeOwner }) => {
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
  assert.deepEqual(result.handoffSends, [])
  assert.equal(result.imageCalls.some(call => call.operation === 'transfer'), false,
    'authority loss must not be treated as a queue CAS refusal')
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false)
  assert.deepEqual(result.predecessorOutbox, ['words the person queued before the limit'])
  assert.deepEqual(result.successorOutbox, [])
  assert.equal(result.queue.destinationSessionId, T1174_PREDECESSOR)
  assert.deepEqual(result.queue.entries, [retained])
})

