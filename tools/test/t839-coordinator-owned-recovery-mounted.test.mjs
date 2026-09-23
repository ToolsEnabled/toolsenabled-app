import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./helpers/css-stub-loader.mjs', import.meta.url)
import { randomUUID } from 'node:crypto'

import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createAutomaticImageRecoveryHostRegistry } from '../../src/automatic-image-recovery-host-registry.js'
import { createFleetTreeStore, fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { installWorld, fleetFetch, mountView, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

const hostFactory = process.env.T839_HOST_MODULE
  ? (await import(pathToFileURL(process.env.T839_HOST_MODULE).href)).createAutomaticImageRecoveryHost
  : undefined
const testRoot = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = process.env.T839_COORDINATOR_FIXTURE_ROOT
  || path.join(testRoot, 't839-coordinator-retained-fixtures')
const computerId = 't839-mounted-computer'
const nodeId = 't839-mounted-node'
const sourceSessionId = 't839-mounted-predecessor'
const destinationSessionId = 't839-mounted-successor'
const createdAt = '2026-09-06T04:51:00.000Z'
const ownerContext = Object.freeze({
  version: 1,
  ownerId: 't839-mounted-owner',
  currentEpoch: 't839-mounted-epoch-1',
  kind: 'local',
})
const envelopeIds = [randomUUID(), randomUUID(), randomUUID()]

function fixture(label) {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const filename = path.join(fixtureRoot, `retained-${label}-${process.pid}-${randomUUID()}.json`)
  fs.writeFileSync(filename, JSON.stringify({
    label, computerId, nodeId, sourceSessionId, destinationSessionId,
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

function retainedBridge() {
  let queue = snapshot(sourceSessionId, 'generation-source', [
    { envelopeId: envelopeIds[0], state: 'not-sent', text: 'synthetic words one', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: envelopeIds[1], state: 'not-sent', text: 'synthetic words two', imageReceipts: [{ imageCount: 1 }] },
    { envelopeId: envelopeIds[2], state: 'unknown', text: 'synthetic unknown words', imageReceipts: [{ imageCount: 1 }] },
  ])
  const dispatches = []
  const eventListeners = new Set()
  const ownerListeners = new Set()
  const bridge = {
    async ownerContext() { return ownerContext },
    onOwnerContextChanged(listener) { ownerListeners.add(listener); return () => ownerListeners.delete(listener) },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    close: async () => ({ ok: true, closed: true }),
    start: async () => ({ ok: false, code: 'FIXTURE_START_NOT_USED' }),
    async imageQueue(request) {
      if (request.operation === 'read') {
        return { ok: true, operation: 'read', result: structuredClone(queue) }
      }
      if (request.operation === 'transfer') {
        assert.equal(request.expectedDestinationSessionId, sourceSessionId)
        assert.equal(request.destinationSessionId, destinationSessionId)
        assert.equal(request.expectedGeneration, queue.generation)
        queue = snapshot(destinationSessionId, 'generation-successor', queue.entries)
        return { ok: true, operation: 'transfer', result: structuredClone(queue) }
      }
      if (request.operation === 'dispatch') {
        const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
        assert.ok(entry, 'the retained row named by dispatch must exist')
        assert.equal(entry.state, 'not-sent')
        entry.state = 'accepted'
        dispatches.push(structuredClone(request))
        queue = snapshot(destinationSessionId, `generation-dispatch-${dispatches.length}`, queue.entries)
        return {
          ok: true,
          operation: 'dispatch',
          deliveryDisposition: 'accepted',
          dispatchStarted: true,
          attemptId: `t839-attempt-${dispatches.length}`,
          ownerContext,
          conversationId: nodeId,
          sessionId: destinationSessionId,
          envelopeId: request.envelopeId,
          result: structuredClone(queue),
        }
      }
      throw new Error(`unexpected imageQueue operation: ${request.operation}`)
    },
  }
  return {
    bridge,
    get queue() { return queue },
    dispatches,
    emit(packet) { for (const listener of [...eventListeners]) listener(packet) },
    ownerChanged(value) { for (const listener of [...ownerListeners]) listener(value) },
  }
}

function stores(world) {
  return createFleetTreeStore({ computerId, storage: {
    read: key => world.storage.getItem(key),
    write: (key, value) => world.storage.setItem(key, value),
  } })
}

test('coordinator-owned recovery survives real Computers view destruction and drains known retained envelopes once per real boundary', async t => {
  let world = null
  let view = null
  let coordinator = null
  let registry = null
  let coordinatorAlive = true
  t.after(() => {
    coordinatorAlive = false
    registry?.destroy?.()
    coordinator?.destroy?.()
    view?.destroy?.()
    world?.restore?.()
  })
  fixture('view-destroy-before-boundary')
  world = await (async () => {
    const installed = await import('./lib/tree-command-real-mount.mjs')
    const value = await installed.installWorld(installed.fleetFetch({ computerId }), { asyncFrames: true })
    seedTreeNode(value.storage, {
      computerId, nodeId, sessionId: sourceSessionId, status: 'running',
    })
    return value
  })()
  const queue = retainedBridge()
  world.bridge.ownerContext = queue.bridge.ownerContext
  world.bridge.onOwnerContextChanged = queue.bridge.onOwnerContextChanged
  world.bridge.imageQueue = queue.bridge.imageQueue
  world.bridge.onEvent = queue.bridge.onEvent

  view = await mountView(world, { computerId })
  assert.ok(view.el.classList.contains('computers'), 'this must mount the real Computers view')
  const retainedStore = stores(world)
  const coordinatorCurrent = () => {
    const node = retainedStore.getNode(nodeId)
    return coordinatorAlive
      && world?.bridge?.imageQueue === queue.bridge.imageQueue
      && node?.id === nodeId
      && [sourceSessionId, destinationSessionId].includes(node.sessionId)
  }
  coordinator = createAccountRecoveryCoordinator({
    bridge: world.bridge,
    sessionNodeIds: new Map([[sourceSessionId, nodeId]]),
    canStart: coordinatorCurrent,
    canContinue: coordinatorCurrent,
  })
  registry = createAutomaticImageRecoveryHostRegistry(hostFactory ? { hostFactory } : {})
  coordinator.register(computerId, {
    treeStore: retainedStore,
    transcriptStore: { get: () => null, readLatest: async () => null, save: () => true, dispose() {} },
    handoffStore: { get: () => null },
    imageRecovery: { bridge: world.bridge, canContinue: coordinatorCurrent },
  })
  const host = registry.register(computerId, {
    treeStore: retainedStore,
    imageRecovery: { bridge: world.bridge, canContinue: coordinatorCurrent },
  })
  assert.ok(host, 'the coordinator context must provide a host-lifetime image owner')
  assert.equal(coordinator.hasContext(computerId), true)

  const prepared = await host.prepare({
    nodeId, conversationId: nodeId, sourceSessionId, expectedNodeCreatedAt: createdAt,
    sourceIdentity: { sessionId: sourceSessionId },
  })
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  assert.equal(prepared.pending, true)

  retainedStore.attachSession(nodeId, destinationSessionId)
  retainedStore.setNodeStatus(nodeId, 'running', { note: '' })
  const recovered = await host.recover({
    nodeId, conversationId: nodeId, sourceSessionId, destinationSessionId,
    expectedNodeCreatedAt: createdAt,
    sourceIdentity: { sessionId: sourceSessionId },
    destinationIdentity: { sessionId: destinationSessionId },
    sourceBinding: prepared.sourceBinding,
    validatedSuccessor: true,
  })
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.transferred, true, JSON.stringify(recovered))

  const held = await host.drain({
    nodeId, conversationId: nodeId, sourceSessionId, destinationSessionId,
    expectedNodeCreatedAt: createdAt, sourceBinding: recovered.sourceBinding,
  })
  assert.equal(held.retryable, true)
  assert.equal(held.dispatched, false)
  assert.equal(host.pending(), 1)

  let viewDestroyed = false
  const destroyView = view.destroy.bind(view)
  view.destroy = () => { viewDestroyed = true; return destroyView() }
  view.destroy()
  assert.equal(viewDestroyed, true, 'the real mounted Computers view is destroyed before boundary delivery')
  view = null
  retainedStore.setNodeStatus(nodeId, 'running', { note: '' })
  await settle(2)
  assert.equal(queue.dispatches.length, 0, 'same status notification cannot retry')
  retainedStore.setNodeStatus(nodeId, 'finished', { note: '', turnId: 'turn-1' })
  queue.emit({ sessionId: destinationSessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })
  await settle(6)
  assert.equal(queue.dispatches.length, 1)
  assert.equal(queue.dispatches[0].envelopeId, envelopeIds[0])

  retainedStore.setNodeStatus(nodeId, 'finished', { note: '', turnId: 'turn-2' })
  queue.emit({ sessionId: destinationSessionId, event: { type: 'turn_completed', turnId: 'turn-2', status: 'completed' } })
  await settle(6)
  assert.equal(queue.dispatches.length, 2)
  assert.equal(queue.dispatches[1].envelopeId, envelopeIds[1])
  assert.deepEqual(queue.dispatches.map(row => row.envelopeId), [envelopeIds[0], envelopeIds[1]])
  assert.equal(queue.dispatches.some(row => row.envelopeId === envelopeIds[2]), false,
    'unknown delivery must never be replayed')
  assert.equal(queue.queue.entries.filter(row => row.state === 'not-sent').length, 0)
  assert.equal(queue.queue.entries.filter(row => row.state === 'unknown').length, 1)

})
