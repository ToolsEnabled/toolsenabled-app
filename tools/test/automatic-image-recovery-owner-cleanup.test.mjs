import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutomaticImageRecoveryHostRegistry } from '../../src/automatic-image-recovery-host-registry.js'
import { createAutomaticImageRecoveryHost } from '../../src/automatic-image-recovery-host.js'
import { createImageOwnerClient } from '../../src/image-owner-client.js'

function fixture() {
  const listeners = { owner: new Set(), event: new Set(), status: new Set() }
  const calls = []
  let reads = 0
  let epoch = 1
  const node = { id: 'node', createdAt: 'synthetic-created', sessionId: 'session', status: 'running' }
  const queue = {
    version: 1, generation: 'synthetic-generation', destinationSessionId: 'session', automaticSend: false,
    entries: [{ envelopeId: '22222222-2222-4222-8222-222222222222', state: 'not-sent', text: 'retained words', imageReceipts: [{ imageCount: 1 }] }],
  }
  const original = structuredClone(queue)
  const subscribe = (kind, listener) => {
    listeners[kind].add(listener)
    return () => listeners[kind].delete(listener)
  }
  const bridge = {
    ownerContext: async () => { reads++; return { version: 1, ownerId: 'synthetic-owner', currentEpoch: 'epoch-' + epoch, kind: 'local' } },
    onOwnerContextChanged: listener => subscribe('owner', listener),
    onEvent: listener => subscribe('event', listener),
    sessionActivity: async () => ({ ok: true, busy: true }),
    imageQueue: async request => {
      calls.push(request.operation)
      assert.equal(request.operation, 'read', 'lifecycle cleanup must not mutate or dispatch retained messages')
      return { ok: true, operation: 'read', result: structuredClone(queue) }
    },
  }
  const treeStore = { getNode: () => node, subscribe: listener => subscribe('status', listener) }
  const input = {
    nodeId: node.id, sourceSessionId: node.sessionId, expectedNodeCreatedAt: node.createdAt,
    operationId: '11111111-1111-4111-8111-111111111111',
  }
  return {
    bridge, treeStore, listeners, calls, input, queue, original,
    reads: () => reads,
    invalidate() { epoch++; for (const listener of [...listeners.owner]) listener({ version: 1, invalidated: true }) },
    counts: () => Object.fromEntries(Object.entries(listeners).map(([kind, set]) => [kind, set.size])),
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('owner invalidation releases the real recovery host subscriptions before registry retirement', async t => {
  const f = fixture()
  const registry = createAutomaticImageRecoveryHostRegistry()
  t.after(() => registry.destroy())
  for (let cycle = 0; cycle < 3; cycle++) {
    const host = registry.register('computer', { treeStore: f.treeStore, imageRecovery: { bridge: f.bridge } })
    const prepared = await host.prepare(f.input)
    assert.equal(prepared.ok, true)
    const waiting = await host.drain({ ...f.input, destinationSessionId: f.input.sourceSessionId, sourceBinding: prepared.sourceBinding })
    assert.equal(waiting.retryable, true)
    assert.equal(host.pending(), 1)
    assert.deepEqual(f.counts(), { owner: 1, event: 1, status: 1 })

    const readsBefore = f.reads()
    f.invalidate()
    assert.equal(registry.size(), 0)
    assert.equal(host.pending(), 0)
    assert.deepEqual(f.counts(), { owner: 0, event: 0, status: 0 }, 'retired hosts must release native owner listeners too')
    await settle()
    assert.equal(f.reads(), readsBefore, 'retired owner clients must not refresh after invalidation')
    assert.equal((await host.prepare(f.input)).ok, false)
    assert.deepEqual(f.queue, f.original, 'the queued words and image receipts remain intact')
    host.dispose()
  }
  registry.destroy()
  assert.deepEqual(f.counts(), { owner: 0, event: 0, status: 0 })
  assert.deepEqual(f.calls, ['read', 'read', 'read'])
})

test('a recovery host releases its observation without disposing a caller-owned owner client', async t => {
  const f = fixture()
  const ownerClient = createImageOwnerClient({ bridge: f.bridge })
  const host = createAutomaticImageRecoveryHost({ bridge: f.bridge, treeStore: f.treeStore, ownerClient })
  t.after(() => { host.dispose(); ownerClient.dispose() })
  assert.equal((await host.prepare(f.input)).ok, true)
  f.invalidate()
  await settle()
  assert.equal(ownerClient.snapshot().status, 'ready')
  assert.equal(ownerClient.capture().currentEpoch, 'epoch-2')
  assert.equal(f.listeners.owner.size, 1, 'the external client retains its own native subscription')
  assert.equal((await host.prepare(f.input)).ok, false, 'the retired host must not use the new owner epoch')
  host.dispose()
  assert.equal(ownerClient.snapshot().status, 'ready')
  assert.deepEqual(f.queue, f.original)
  ownerClient.dispose()
  assert.equal(f.listeners.owner.size, 0)
})
