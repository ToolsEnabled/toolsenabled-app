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

test('unchanged retained custody transfers, handoff, outbox and one known image on the mounted Computers path', async () => {
  const retained = queueEntry('t1174-control-envelope')
  const result = await runMountedImageRecovery({
    mode: 'control',
    initialEntries: [retained],
  })

  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_SUCCESSOR)
  assert.equal(result.node.status, 'running')
  assert.equal(result.node.statusNote, 'Continuing from the saved handoff.')
  assert.deepEqual(result.handoffSends, [T1174_SUCCESSOR])
  assert.deepEqual(result.predecessorOutbox, [])
  assert.deepEqual(result.successorOutbox, ['words the person queued before the limit'])
  assert.equal(result.dispatches.length, 1)
  assert.equal(result.dispatches[0].envelopeId, retained.envelopeId)
  assert.equal(result.queue.entries.find(entry => entry.envelopeId === retained.envelopeId)?.state, 'accepted')
  assert.equal(result.starts[0]?.threadId, T1174_START_THREAD)
  assert.equal(result.transcript?.threadId, T1174_THREAD)
  assert.notEqual(result.starts[0]?.threadId, result.transcript?.threadId)
  assert.deepEqual(result.visibleImageRows, [])
})
