import assert from 'node:assert/strict'
import test from 'node:test'
import {
  T1174_NODE,
  T1174_PREDECESSOR,
  queueEntry,
  runMountedImageRecovery,
} from './lib/t1174-image-recovery-real-mounted.mjs'

test('a mounted host replacement during prepare cannot replace the producer identity', async () => {
  const retained = queueEntry('t1174-host-replaced-envelope')
  const result = await runMountedImageRecovery({
    mode: 'host-replaced-during-prepare',
    initialEntries: [retained],
  })

  assert.equal(result.hostReplacementMounted, true)
  assert.equal(result.prepareReadTriggered, true)
  assert.equal(result.node.id, T1174_NODE)
  assert.equal(result.node.sessionId, T1174_PREDECESSOR)
  assert.equal(result.node.status, 'turn-failed')
  assert.match(result.node.statusNote, /Recovery paused:/)
  assert.match(result.visibleStatusNote, /Recovery paused:/)
  assert.deepEqual(result.starts, [])
  assert.deepEqual(result.closes, [])
  assert.deepEqual(result.handoffSends, [])
  assert.deepEqual(result.predecessorOutbox, ['words the person queued before the limit'])
  assert.deepEqual(result.successorOutbox, [])
  assert.equal(result.imageCalls.filter(call => call.operation === 'transfer').length, 0)
  assert.equal(result.imageCalls.filter(call => call.operation === 'dispatch').length, 0)
  assert.deepEqual(result.queue, {
    version: 1,
    generation: 'generation-source',
    destinationSessionId: T1174_PREDECESSOR,
    automaticSend: false,
    entries: [retained],
  })
  assert.deepEqual(result.visibleImageRows, [{
    envelopeId: retained.envelopeId,
    deliveryState: 'not-sent',
    text: retained.text,
    buttons: ['Send again', 'Remove'],
  }])
})
