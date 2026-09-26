import assert from 'node:assert/strict'
import test from 'node:test'

import { createAutomaticImageRecoveryBinder } from '../../src/automatic-image-recovery-binder.js'
import { createAutomaticImageRecoveryTransfer } from '../../src/automatic-image-recovery-transfer.js'

const ownerContext = Object.freeze({
  version: 1,
  ownerId: 't839-flight-owner',
  currentEpoch: 't839-flight-epoch',
  kind: 'local',
})
const operationId = '11111111-1111-4111-8111-111111111111'
const nodeId = 't839-flight-node'
const predecessor = 't839-flight-predecessor'
const createdAt = '2026-09-06T04:51:00.000Z'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function snapshot() {
  return {
    version: 1,
    generation: 't839-flight-generation',
    destinationSessionId: predecessor,
    automaticSend: false,
    entries: [{
      envelopeId: '22222222-2222-4222-8222-222222222222',
      state: 'not-sent',
      text: 'synthetic guarded words',
      imageReceipts: [{ imageCount: 1 }],
    }],
  }
}

test('an awaited retained-queue read is refused after the recovery guard cancels', async () => {
  const readStarted = deferred()
  const releaseRead = deferred()
  const calls = []
  let current = true
  const node = { id: nodeId, createdAt, sessionId: predecessor, status: 'running' }
  const bridge = {
    async imageQueue(request) {
      calls.push(request.operation)
      assert.equal(request.operation, 'read')
      readStarted.resolve()
      await releaseRead.promise
      return { ok: true, operation: 'read', result: snapshot() }
    },
  }
  const transfer = createAutomaticImageRecoveryTransfer({
    bridge,
    captureOwnerContext: async () => ownerContext,
  })
  const binder = createAutomaticImageRecoveryBinder({
    transfer,
    bridge,
    getNode: id => id === nodeId ? node : null,
  })

  const preparing = binder.prepare({
    nodeId,
    conversationId: nodeId,
    sourceSessionId: predecessor,
    expectedNodeCreatedAt: createdAt,
    operationId,
    ownerContext,
    sourceIdentity: { sessionId: predecessor },
    isCurrent: () => current,
  })
  await readStarted.promise
  current = false
  releaseRead.resolve()
  const result = await preparing

  assert.equal(result.ok, false)
  assert.equal(result.code, 'IMAGE_RECOVERY_STALE')
  assert.deepEqual(calls, ['read'])
  binder.dispose()
})
