import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'
import { prepareRetainedSourceFixture } from './lib/source-fixture-root.mjs'
import { randomUUID } from 'node:crypto'

register('./helpers/css-stub-loader.mjs', import.meta.url)

import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { COMPUTER_ID, fleetFetch, installWorld, mountView, settle } from './lib/tree-command-real-mount.mjs'

// Retain diagnostic receipts outside the immutable application checkout.
const fixtureRoot = process.env.T839_IMAGE_FIXTURE_ROOT
  || prepareRetainedSourceFixture().root
console.log('RETAINED_T839_FIXTURE ' + fixtureRoot)
const nodeId = 't839-refused-handoff-node'
const predecessor = 't839-refused-handoff-predecessor'
const successor = 't839-refused-handoff-successor'
const createdAt = '2026-09-06T05:11:00.000Z'
const ownerContext = Object.freeze({
  version: 1,
  ownerId: 't839-synthetic-owner',
  currentEpoch: 't839-synthetic-epoch-1',
  kind: 'local',
})
const envelopeId = randomUUID()

function fixture(label) {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const filename = path.join(fixtureRoot, 'retained-' + label + '-' + process.pid + '-' + randomUUID() + '.json')
  fs.writeFileSync(filename, JSON.stringify({
    label, computerId: COMPUTER_ID, nodeId, predecessor, successor,
    retainedRows: 1, custody: 'synthetic-only',
  }), { encoding: 'utf8', flag: 'wx' })
  return filename
}

function snapshot(destination, generation, entries) {
  return {
    version: 1,
    generation,
    destinationSessionId: destination,
    automaticSend: false,
    entries: entries.map(entry => ({ ...entry })),
  }
}

async function until(check, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function seedNode(storage) {
  storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({
    version: 1,
    computerId: COMPUTER_ID,
    trees: [{ id: 'tree-refused', name: null, createdAt, updatedAt: createdAt, profileId: null }],
    nodes: [{
      id: nodeId, treeId: 'tree-refused', status: 'running', createdAt, updatedAt: createdAt,
      role: 'builder', message: '', statusNote: '', sessionId: predecessor, parentId: null,
    }],
  }))
}

function refusedHandoffBridge(world) {
  let busy = true
  let queue = snapshot(predecessor, 'generation-refused-source', [{
    envelopeId,
    state: 'not-sent',
    text: 'synthetic refused words',
    imageReceipts: [{ imageCount: 1, receiptHash: 'synthetic-receipt' }],
  }])
  const listeners = new Set()
  const ownerListeners = new Set()
  const imageCalls = []
  const starts = []
  const closes = []
  const dispatches = []
  let handoffAttempts = 0
  const bridge = world.bridge
  bridge.ownerContext = async () => ownerContext
  bridge.onOwnerContextChanged = listener => {
    ownerListeners.add(listener)
    return () => ownerListeners.delete(listener)
  }
  bridge.onEvent = listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  bridge.close = async request => {
    closes.push({ sessionId: request.sessionId })
    return { ok: true, closed: true, sessionId: request.sessionId }
  }
  bridge.start = async request => {
    starts.push({ sessionId: request.sessionId, replacesSessionId: request.replacesSessionId })
    return { ok: true, sessionId: successor, threadId: 't839-refused-thread' }
  }
  bridge.send = async () => ({ ok: true, turnId: 'synthetic-person-turn' })
  bridge.sendAutomatic = async () => {
    handoffAttempts += 1
    busy = false
    return {
      ok: false,
      deliveryDisposition: 'not-sent',
      dispatchStarted: false,
      retryable: false,
      code: 'AGENT_TURN_ACTIVE',
      result: structuredClone(queue),
    }
  }
  bridge.updateTreeAddress = async () => ({ ok: true })
  bridge.sessionActivity = async () => ({ ok: true, busy, closing: false, turnsCompleted: busy ? 0 : 1 })
  bridge.models = async () => ({ provider: 'claude', catalogSupported: true, models: [] })
  bridge.history = async () => ({ ok: true, entries: [] })
  bridge.availability = async () => ({ ok: true, available: true })
  bridge.ledger = async () => ({ ok: true, records: [] })
  bridge.imageQueue = async request => {
    imageCalls.push({
      operation: request.operation,
      conversationId: request.conversationId,
      sourceSessionId: request.sourceSessionId,
      destinationSessionId: request.destinationSessionId || request.sessionId,
      envelopeId: request.envelopeId || null,
    })
    if (request.operation === 'read') {
      return { ok: true, operation: 'read', result: structuredClone(queue) }
    }
    if (request.operation === 'transfer') {
      assert.equal(request.expectedDestinationSessionId, predecessor)
      assert.equal(request.destinationSessionId, successor)
      assert.equal(request.expectedGeneration, queue.generation)
      queue = snapshot(successor, 'generation-refused-successor', queue.entries)
      return { ok: true, operation: 'transfer', result: structuredClone(queue) }
    }
    if (request.operation === 'dispatch') {
      const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
      assert.ok(entry, 'refused handoff must still name a retained envelope')
      entry.state = 'accepted'
      dispatches.push({ envelopeId: request.envelopeId, sessionId: request.sessionId })
      queue = snapshot(successor, 'generation-unwanted-dispatch', queue.entries)
      return {
        ok: true,
        operation: 'dispatch',
        deliveryDisposition: 'accepted',
        dispatchStarted: true,
        attemptId: 't839-unwanted-image-attempt',
        ownerContext,
        conversationId: nodeId,
        sessionId: successor,
        envelopeId: request.envelopeId,
        result: structuredClone(queue),
      }
    }
    throw new Error('unexpected imageQueue operation: ' + request.operation)
  }
  return {
    emit(packet) { for (const listener of [...listeners]) listener(packet) },
    ownerChanged(value) { for (const listener of [...ownerListeners]) listener(value) },
    imageCalls,
    starts,
    closes,
    dispatches,
    get handoffAttempts() { return handoffAttempts },
    get busy() { return busy },
    get queue() { return queue },
  }
}

test('a definite refused handoff never installs image draining before an idle successor event', async t => {
  let world = null
  let view = null
  let image = null
  t.after(() => {
    try { view?.destroy?.() } catch { /* retain synthetic fixture; cleanup is in-memory */ }
    world?.restore?.()
  })
  fixture('handoff-refused-retained')
  world = await installWorld(fleetFetch({ computerId: COMPUTER_ID }), { asyncFrames: true })
  seedNode(world.storage)
  image = refusedHandoffBridge(world)
  window.mcTranscripts = {
    list: async () => ({ ok: true, records: [{ computerId: COMPUTER_ID, nodeId }] }),
    read: async request => ({
      ok: true, entries: [], metadata: { computerId: request.computerId, nodeId: request.nodeId },
      before: null, recoveryDirectory: '/synthetic/conversations/' + request.nodeId,
    }),
    append: async () => ({ ok: true }),
    bind: async () => ({ ok: true }),
    onError: () => () => {},
  }
  world.storage.setItem('mc.write.agent-session', 'enabled')
  view = await mountView(world, { computerId: COMPUTER_ID })
  assert.ok(view.el.classList.contains('computers'), 'the real Computers view must mount')
  image.emit({
    sessionId: predecessor,
    event: {
      type: 'account_recovery_needed',
      recoveryId: 't839-refused-handoff-recovery',
      handoff: 'Continue synthetic refused words and image custody.',
    },
  })
  await until(() => image.starts.length === 1, 'the real coordinator never started the successor')
  await until(() => image.handoffAttempts === 1, 'the real coordinator never attempted the handoff')
  assert.equal(image.busy, false, 'the native synthetic world is idle only after definite handoff refusal')
  image.emit({
    sessionId: successor,
    event: { type: 'turn_completed', turnId: 't839-refused-turn', status: 'completed' },
  })
  await settle(80)
  assert.equal(image.dispatches.length, 0, 'a refused handoff must not dispatch retained images on a later idle/turn event')
  assert.deepEqual(image.queue.destinationSessionId, successor)
  assert.equal(image.queue.entries.length, 1)
  assert.equal(image.queue.entries[0].envelopeId, envelopeId)
  assert.equal(image.queue.entries[0].state, 'not-sent', 'the refused handoff keeps its words and image retained')
  assert.equal(image.queue.entries[0].text, 'synthetic refused words')
  assert.deepEqual(image.queue.entries[0].imageReceipts, [{ imageCount: 1, receiptHash: 'synthetic-receipt' }])
  assert.equal(image.imageCalls.some(row => row.operation === 'dispatch'), false)
})
