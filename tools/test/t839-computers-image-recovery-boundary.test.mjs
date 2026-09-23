import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const testRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testRoot, '..', '..')
const { installDomStandIn } = await import(pathToFileURL(path.join(testRoot, 'lib', 'dom-stand-in.mjs')).href)
const { buildChat } = await import(pathToFileURL(path.join(repoRoot, 'src', 'components.js')).href)
const transferModulePath = process.env.T839_TRANSFER_MODULE
  || path.join(repoRoot, 'src', 'automatic-image-recovery-transfer.js')
const { createAutomaticImageRecoveryTransfer } = await import(
  pathToFileURL(transferModulePath).href,
)
const binderModulePath = process.env.T839_BINDER_MODULE
  || path.join(repoRoot, 'src', 'automatic-image-recovery-binder.js')
const { createAutomaticImageRecoveryBinder } = await import(
  pathToFileURL(binderModulePath).href,
)

const fixtureRoot = process.env.T839_FIXTURE_ROOT
  || path.join(testRoot, 't839-retained-boundary-fixtures')
const ownerContext = Object.freeze({
  version: 1,
  ownerId: 't839-synthetic-owner',
  currentEpoch: 't839-epoch-1',
  kind: 'local',
})
const conversationId = 't839-synthetic-conversation'
const nodeId = 't839-synthetic-node'
const sourceSessionId = 't839-predecessor-session'
const destinationSessionId = 't839-successor-session'
const nodeCreatedAt = 't839-node-incarnation-1'
const firstEnvelopeId = randomUUID()
const secondEnvelopeId = randomUUID()
const unknownEnvelopeId = randomUUID()
const tinyGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

function makeSnapshot(destination, generation, entries) {
  return {
    version: 1,
    generation,
    destinationSessionId: destination,
    automaticSend: false,
    entries: entries.map(entry => ({ ...entry })),
  }
}

function writeRetainedFixture(label) {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const fixturePath = path.join(fixtureRoot, `retained-${label}-${process.pid}-${randomUUID()}.json`)
  fs.writeFileSync(fixturePath, JSON.stringify({
    label,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    entries: 3,
  }), { encoding: 'utf8', flag: 'wx' })
  return fixturePath
}

function makeBoundaryHarness({ gateFirstRead = false } = {}) {
  const entries = [
    { envelopeId: firstEnvelopeId, state: 'not-sent', text: 'first synthetic words', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: secondEnvelopeId, state: 'not-sent', text: 'second synthetic words', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: unknownEnvelopeId, state: 'unknown', text: 'unknown synthetic words', imageReceipts: [{ imageCount: 1 }] },
  ]
  let snapshot = makeSnapshot(sourceSessionId, 'generation-source', entries)
  let node = {
    id: nodeId,
    createdAt: nodeCreatedAt,
    sessionId: sourceSessionId,
    status: 'running',
    lastTurnId: 'turn-predecessor',
  }
  let busy = true
  const nodeListeners = new Set()
  const eventListeners = new Set()
  const dispatches = []
  const ownerChecks = []
  let releaseReadResolve = null
  let firstReadGatePending = gateFirstRead

  const bridge = {
    ownerContext: () => ownerContext,
    async imageQueue(request) {
      if (request.operation === 'read') {
        if (firstReadGatePending) {
          firstReadGatePending = false
          await new Promise(resolve => { releaseReadResolve = resolve })
        }
        return { ok: true, operation: 'read', result: structuredClone(snapshot) }
      }
      if (request.operation === 'transfer') {
        assert.equal(request.expectedDestinationSessionId, sourceSessionId)
        assert.equal(request.destinationSessionId, destinationSessionId)
        assert.equal(request.expectedGeneration, snapshot.generation)
        snapshot = makeSnapshot(destinationSessionId, 'generation-successor', snapshot.entries)
        return { ok: true, operation: 'transfer', result: structuredClone(snapshot) }
      }
      if (request.operation === 'dispatch') {
        dispatches.push(structuredClone(request))
        const entry = snapshot.entries.find(row => row.envelopeId === request.envelopeId)
        assert.ok(entry, 'dispatch must name a retained envelope')
        assert.equal(entry.state, 'not-sent')
        entry.state = 'accepted'
        snapshot = makeSnapshot(destinationSessionId, `generation-dispatch-${dispatches.length}`, snapshot.entries)
        return {
          ok: true,
          operation: 'dispatch',
          deliveryDisposition: 'accepted',
          dispatchStarted: true,
          attemptId: `attempt-${dispatches.length}`,
          ownerContext,
          conversationId,
          sessionId: destinationSessionId,
          envelopeId: request.envelopeId,
          result: structuredClone(snapshot),
        }
      }
      throw new Error(`unexpected imageQueue operation: ${request.operation}`)
    },
  }

  const setNode = patch => {
    node = { ...node, ...patch }
  }
  const emitStatus = () => {
    for (const listener of [...nodeListeners]) listener()
  }
  const emitTurnCompleted = turnId => {
    for (const listener of [...eventListeners]) listener({
      sessionId: destinationSessionId,
      event: { type: 'turn_completed', status: 'completed', turnId },
    })
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const transfer = createAutomaticImageRecoveryTransfer({
    bridge,
    captureOwnerContext: () => ownerContext,
    newOperationId: () => randomUUID(),
  })
  const binder = createAutomaticImageRecoveryBinder({
    transfer,
    bridge,
    getNode: candidate => candidate === nodeId ? node : null,
    nodeBusy: () => busy,
    readinessRevision: () => `${node.sessionId}:${node.lastTurnId}:${node.status}:${busy ? 'busy' : 'idle'}`,
    ownerIsCurrent: (_candidate, context) => {
      ownerChecks.push(context)
      return context === null
        || JSON.stringify(context) === JSON.stringify(ownerContext)
    },
    canContinue: () => true,
    subscribeNodeStatus(_candidate, listener) {
      nodeListeners.add(listener)
      return () => nodeListeners.delete(listener)
    },
    subscribeAgentEvents(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
  })
  return {
    bridge,
    binder,
    transfer,
    node,
    get snapshot() { return snapshot },
    get dispatches() { return dispatches.slice() },
    get ownerChecks() { return ownerChecks.slice() },
    setNode,
    releaseFirstRead() { releaseReadResolve?.(); releaseReadResolve = null },
    setBusy(value) { busy = value },
    emitStatus,
    emitTurnCompleted,
    tick,
  }
}

async function prepareAndRecover(harness) {
  const prepared = await harness.binder.prepare({
    nodeId,
    conversationId,
    sourceSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceIdentity: { sessionId: sourceSessionId },
  })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.pending, true)
  harness.setNode({ sessionId: destinationSessionId, status: 'running' })
  const recovered = await harness.binder.recover({
    nodeId,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceIdentity: { sessionId: sourceSessionId },
    destinationIdentity: { sessionId: destinationSessionId },
    sourceBinding: prepared.sourceBinding,
    validatedSuccessor: true,
  })
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.transferred, true, JSON.stringify(recovered))
  return recovered
}

test('real Computers boundary binding retains ready:false work and drains one known envelope per actual turn event without chat', async () => {
  writeRetainedFixture('two-envelope-boundaries')
  const harness = makeBoundaryHarness()
  const recovered = await prepareAndRecover(harness)

  const firstDrain = await harness.binder.drain({
    nodeId,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceBinding: recovered.sourceBinding,
  })
  // A busy successor is retained for a future boundary; it is not silently
  // discarded and it does not dispatch before the host says the turn ended.
  assert.equal(firstDrain.retryable, true)
  assert.equal(firstDrain.dispatched, false)
  assert.equal(harness.dispatches.length, 0)
  assert.equal(harness.binder.pending(), 1, 'ready:false must retain a lifetime boundary waiter')

  // A generic readiness/status notification has no new turn revision.
  harness.emitStatus()
  await harness.tick()
  assert.equal(harness.dispatches.length, 0)

  // The actual successor boundary sends the first known row, then retains the
  // second row for the next boundary.
  harness.setBusy(false)
  harness.setNode({ status: 'finished', lastTurnId: 'turn-1' })
  harness.emitTurnCompleted('turn-1')
  await harness.tick()
  await harness.tick()
  assert.equal(harness.dispatches.length, 1)
  assert.equal(harness.dispatches[0].envelopeId, firstEnvelopeId)
  assert.equal(harness.binder.pending(), 1, 'remaining known work must stay pending')

  // Repeating the same completed turn is not an authentic new boundary.
  harness.emitTurnCompleted('turn-1')
  await harness.tick()
  await harness.tick()
  assert.equal(harness.dispatches.length, 1)

  harness.setNode({ status: 'finished', lastTurnId: 'turn-2' })
  harness.emitTurnCompleted('turn-2')
  await harness.tick()
  await harness.tick()
  assert.equal(harness.dispatches.length, 2)
  assert.equal(harness.dispatches[1].envelopeId, secondEnvelopeId)
  assert.equal(new Set(harness.dispatches.map(request => request.envelopeId)).size, 2)
  assert.equal(harness.dispatches.some(request => request.envelopeId === unknownEnvelopeId), false,
    'unknown delivery must never be replayed')
  assert.equal(harness.snapshot.entries.filter(entry => entry.state === 'not-sent').length, 0)
  assert.equal(harness.snapshot.entries.filter(entry => entry.state === 'unknown').length, 1)
  assert.equal(harness.binder.pending(), 0)
  harness.binder.dispose()
})

test('ready successor at initial drain installs a watcher for each remaining envelope', async () => {
  writeRetainedFixture('initial-ready-two-boundaries')
  const harness = makeBoundaryHarness()
  const recovered = await prepareAndRecover(harness)
  harness.setBusy(false)
  harness.setNode({ status: 'finished', lastTurnId: 'turn-0' })

  const first = await harness.binder.drain({
    nodeId,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceBinding: recovered.sourceBinding,
  })
  assert.equal(first.ok, true)
  assert.equal(first.dispatched, true)
  assert.equal(first.envelopeId, firstEnvelopeId)
  assert.equal(first.remaining, 1)
  assert.equal(harness.binder.pending(), 1,
    'accepted initial drain with remaining work must install a boundary watcher')

  harness.setNode({ status: 'finished', lastTurnId: 'turn-next' })
  harness.emitTurnCompleted('turn-next')
  await harness.tick()
  await harness.tick()
  assert.equal(harness.dispatches.length, 2)
  assert.equal(harness.dispatches[1].envelopeId, secondEnvelopeId)
  assert.equal(harness.dispatches.some(request => request.envelopeId === unknownEnvelopeId), false)
  assert.equal(harness.snapshot.entries.filter(entry => entry.state === 'unknown').length, 1)
  assert.equal(harness.binder.pending(), 0)
  harness.binder.dispose()
})

test('authority loss while a deferred dispatch is awaited returns a retained refusal without an unhandled rejection', async () => {
  writeRetainedFixture('authority-loss-during-boundary')
  const harness = makeBoundaryHarness()
  const recovered = await prepareAndRecover(harness)
  const held = await harness.binder.drain({
    nodeId,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceBinding: recovered.sourceBinding,
  })
  assert.equal(held.retryable, true)

  const originalImageQueue = harness.bridge.imageQueue
  let enteredResolve
  let releaseResolve
  let authorityLost = false
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const release = new Promise(resolve => { releaseResolve = resolve })
  harness.bridge.imageQueue = async request => {
    if (request.operation === 'dispatch') {
      enteredResolve()
      await release
      if (authorityLost) return { ok: false, code: 'IMAGE_RECOVERY_STALE' }
    }
    return originalImageQueue(request)
  }

  harness.setBusy(false)
  harness.setNode({ status: 'finished', lastTurnId: 'turn-authority' })
  const pending = harness.binder.signal(
    held.boundaryKey,
    't839-successor-session:turn-authority:completed:idle',
  )
  const dispatchWasEntered = await Promise.race([
    entered.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ])
  assert.equal(dispatchWasEntered, true, 'a retained boundary must reach the guarded dispatch await')
  authorityLost = true
  harness.setNode({ createdAt: 't839-node-incarnation-authority-lost' })
  releaseResolve()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IMAGE_RECOVERY_STALE')
  assert.equal(result.retained, true)
  assert.equal(harness.dispatches.length, 0)
  assert.equal(harness.binder.pending(), 0)
  harness.binder.dispose()
})


test('stale owner or node incarnation after an awaited read refuses recovery before any mutation', async () => {
  writeRetainedFixture('stale-await')
  const harness = makeBoundaryHarness({ gateFirstRead: true })
  const pending = harness.binder.prepare({
    nodeId,
    conversationId,
    sourceSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceIdentity: { sessionId: sourceSessionId },
  })
  harness.setNode({ createdAt: 't839-node-incarnation-replaced' })
  harness.releaseFirstRead()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IMAGE_RECOVERY_STALE')
  assert.equal(harness.dispatches.length, 0)
  harness.binder.dispose()
})

test('mounted Computers projection keeps words, thumbnail, Send again and Remove while no-chat turn events drain exactly once', async () => {
  writeRetainedFixture('mounted-no-chat')
  const harness = makeBoundaryHarness()
  const recovered = await prepareAndRecover(harness)
  harness.setBusy(true)
  harness.setNode({ status: 'running', lastTurnId: 'turn-predecessor' })
  const held = await harness.binder.drain({
    nodeId,
    conversationId,
    sourceSessionId,
    destinationSessionId,
    expectedNodeCreatedAt: nodeCreatedAt,
    sourceBinding: recovered.sourceBinding,
  })
  assert.equal(held.retryable, true)
  assert.equal(harness.dispatches.length, 0)

  const dom = installDomStandIn()
  try {
    let view = {
      state: 'ready',
      entries: [{
        envelopeId: firstEnvelopeId,
        state: 'not-sent',
        text: 'first synthetic words',
        imageReceipts: [{ imageCount: 1 }],
        thumbnail: tinyGif,
      }],
    }
    const imageOutbox = {
      subscribe(listener) {
        listener(view)
        return () => {}
      },
      refresh: async () => ({ ok: true }),
      retry: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
    }
    const chat = buildChat({
      seed: 0,
      imageOutbox,
      onSend: () => assert.fail('mounted queue must not dispatch from the composer'),
    })
    dom.document.body.appendChild(chat)
    const row = chat.querySelector('.chat-image-queue-row')
    assert.ok(row)
    assert.match(row.querySelector('.chat-image-queue-text').textContent, /first synthetic words/)
    assert.equal(row.querySelector('.chat-image-queue-thumbnail').src, tinyGif)
    assert.ok(row.querySelector('.chat-image-queue-retry'))
    assert.ok(row.querySelector('.chat-image-queue-cancel'))

    // Dispose the mounted chat before the boundary. Automatic transfer is
    // lifetime-owned by the Computers binder, so no mounted chat is required.
    chat.dispose()
    chat.remove()
    harness.setBusy(false)
    harness.setNode({ status: 'finished', lastTurnId: 'turn-1' })
    harness.emitTurnCompleted('turn-1')
    await harness.tick()
    await harness.tick()
    assert.equal(harness.dispatches.length, 1)
    assert.equal(harness.dispatches[0].envelopeId, firstEnvelopeId)

    harness.setNode({ status: 'finished', lastTurnId: 'turn-2' })
    harness.emitTurnCompleted('turn-2')
    await harness.tick()
    await harness.tick()
    assert.equal(harness.dispatches.length, 2)
    assert.equal(harness.dispatches[1].envelopeId, secondEnvelopeId)
    assert.equal(new Set(harness.dispatches.map(request => request.envelopeId)).size, 2)
    assert.equal(harness.dispatches.some(request => request.envelopeId === unknownEnvelopeId), false,
      'unknown delivery must never be replayed')
    assert.equal(harness.snapshot.entries.filter(entry => entry.state === 'not-sent').length, 0)
    assert.equal(harness.snapshot.entries.filter(entry => entry.state === 'unknown').length, 1)
    assert.ok(harness.ownerChecks.length >= 4)
    harness.binder.dispose()
  } finally {
    dom.restore()
  }
  assert.equal(recovered.snapshot.destinationSessionId, destinationSessionId)
})
