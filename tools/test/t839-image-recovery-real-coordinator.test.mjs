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
const nodeId = 't839-image-node'
const predecessor = 't839-image-predecessor'
const successor = 't839-image-successor'
const createdAt = '2026-09-06T04:51:00.000Z'
const ownerContext = Object.freeze({
  version: 1,
  ownerId: 't839-synthetic-owner',
  currentEpoch: 't839-synthetic-epoch-1',
  kind: 'local',
})
const envelopeIds = [randomUUID(), randomUUID(), randomUUID()]

function fixture(label) {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const filename = path.join(fixtureRoot, 'retained-' + label + '-' + process.pid + '-' + randomUUID() + '.json')
  fs.writeFileSync(filename, JSON.stringify({
    label, computerId: COMPUTER_ID, nodeId, predecessor, successor,
    retainedRows: 3, custody: 'synthetic-only',
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

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
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
    trees: [{ id: 'tree-1', name: null, createdAt, updatedAt: createdAt, profileId: null }],
    nodes: [{
      id: nodeId, treeId: 'tree-1', status: 'running', createdAt, updatedAt: createdAt,
      role: 'builder', message: '', statusNote: '', sessionId: predecessor, parentId: null,
    }],
  }))
}

function retainedImageBridge(world) {
  let queue = snapshot(predecessor, 'generation-source', [
    { envelopeId: envelopeIds[0], state: 'not-sent', text: 'synthetic words one', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: envelopeIds[1], state: 'not-sent', text: 'synthetic words two', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: envelopeIds[2], state: 'unknown', text: 'synthetic unknown words', imageReceipts: [{ imageCount: 1 }] },
  ])
  const listeners = new Set()
  const ownerListeners = new Set()
  const imageCalls = []
  const starts = []
  const closes = []
  const dispatches = []
  const gate = deferred()
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
    await gate.promise
    return { ok: true, sessionId: successor, threadId: 't839-image-thread-successor' }
  }
  bridge.send = async () => ({ ok: true, turnId: 'synthetic-person-turn' })
  bridge.sendAutomatic = async () => ({ ok: true, deliveryDisposition: 'accepted', result: { ok: true } })
  bridge.updateTreeAddress = async () => ({ ok: true })
  bridge.sessionActivity = async () => ({ ok: true, busy: true, closing: false, turnsCompleted: 0 })
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
      queue = snapshot(successor, 'generation-successor', queue.entries)
      return { ok: true, operation: 'transfer', result: structuredClone(queue) }
    }
    if (request.operation === 'dispatch') {
      const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
      assert.ok(entry, 'the actual coordinator dispatch must name a retained envelope')
      assert.equal(entry.state, 'not-sent')
      assert.equal(request.sessionId, successor)
      entry.state = 'accepted'
      dispatches.push({
        envelopeId: request.envelopeId,
        sessionId: request.sessionId,
        operationId: request.operationId,
      })
      queue = snapshot(successor, 'generation-dispatch-' + dispatches.length, queue.entries)
      return {
        ok: true,
        operation: 'dispatch',
        deliveryDisposition: 'accepted',
        dispatchStarted: true,
        attemptId: 't839-image-attempt-' + dispatches.length,
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
    gate,
    emit(packet) { for (const listener of [...listeners]) listener(packet) },
    ownerChanged(value) { for (const listener of [...ownerListeners]) listener(value) },
    imageCalls,
    starts,
    closes,
    dispatches,
    get queue() { return queue },
  }
}

test('real Computers coordinator transfers and dispatches retained synthetic images after view teardown', async t => {
  let world = null
  let view = null
  let image = null
  t.after(() => {
    try { view?.destroy?.() } catch { /* the case deliberately destroys the view */ }
    world?.restore?.()
  })
  fixture('real-coordinator-view-teardown')
  world = await installWorld(fleetFetch({ computerId: COMPUTER_ID }), { asyncFrames: true })
  seedNode(world.storage)
  image = retainedImageBridge(world)
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
    event: { type: 'account_recovery_needed', recoveryId: 't839-image-recovery', handoff: 'Continue the synthetic image work.' },
  })
  await until(() => image.starts.length === 1, 'the real coordinator never reached native successor start')
  assert.deepEqual(image.closes.map(row => row.sessionId), [predecessor], 'the actual coordinator must close its predecessor')
  assert.ok(image.imageCalls.some(row => row.operation === 'read'), 'the coordinator-owned host must read retained custody before close')
  let destroyed = false
  const destroyView = view.destroy.bind(view)
  view.destroy = () => { destroyed = true; return destroyView() }
  view.destroy()
  view = null
  assert.equal(destroyed, true, 'the mounted Computers view must be destroyed while recovery start is held')
  image.gate.resolve()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(image.dispatches.length, 0, 'a busy successor must not receive retained images before a real turn boundary')
  image.emit({
    sessionId: successor,
    event: { type: 'turn_completed', turnId: 't839-image-turn-0', status: 'completed' },
  })
  await until(() => image.dispatches.length === 1, 'the coordinator-owned host never dispatched the first retained image envelope at the first real boundary')
  assert.equal(image.dispatches[0].envelopeId, envelopeIds[0])
  assert.deepEqual(image.dispatches.map(row => row.sessionId), [successor])
  assert.ok(image.imageCalls.some(row => row.operation === 'transfer'), 'the coordinator must transfer after successor attachment')
  image.emit({
    sessionId: successor,
    event: { type: 'turn_completed', turnId: 't839-image-turn-1', status: 'completed' },
  })
  await until(() => image.dispatches.length === 2, 'the retained second image envelope was not delivered at the next real boundary')
  assert.equal(image.dispatches[1].envelopeId, envelopeIds[1])
  assert.deepEqual(image.dispatches.map(row => row.envelopeId), [envelopeIds[0], envelopeIds[1]])
  assert.equal(image.dispatches.some(row => row.envelopeId === envelopeIds[2]), false, 'unknown delivery must never replay')
  assert.equal(image.queue.entries.filter(row => row.state === 'not-sent').length, 0)
  assert.equal(image.queue.entries.filter(row => row.state === 'unknown').length, 1)
  assert.equal(image.starts[0].replacesSessionId, predecessor)
  assert.equal(image.imageCalls.filter(row => row.operation === 'transfer').length, 1)
})
