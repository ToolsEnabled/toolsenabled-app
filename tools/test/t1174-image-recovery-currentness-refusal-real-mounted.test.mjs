import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_PREDECESSOR,
  T1174_SUCCESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('an injected IMAGE_RECOVERY_STALE transfer refusal remains fatal without text or image replay', async () => {
  const retained = queueEntry('t1174-currentness-refusal-envelope')
  const result = await runMountedImageRecovery({
    mode: 'currentness-refusal',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.deepEqual(result.handoffSends, [])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 1)
  assert.equal(result.imageCalls.some(call => call.operation === 'dispatch'), false)
  assert.deepEqual(result.predecessorOutbox, ['words the person queued before the limit'])
  assert.deepEqual(result.successorOutbox, [])
  assert.equal(result.queue.destinationSessionId, T1174_PREDECESSOR)
  assert.deepEqual(result.queue.entries, [retained])
})

