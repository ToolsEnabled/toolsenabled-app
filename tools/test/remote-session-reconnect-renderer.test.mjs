import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { COMPUTER_ID, fleetFetch, installWorld, mountView, seedTreeNode } from './lib/tree-command-real-mount.mjs'

register('./css-loader.mjs', import.meta.url)

test('the real Computers view restores a remote completion through its session catalog', async (t) => {
  const world = await installWorld(fleetFetch())
  let view
  t.after(() => { view?.destroy(); setBridgeTransport(null); world.restore() })
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'Unrelated fixture capability is unavailable.' }))
  seedTreeNode(world.storage, { nodeId: 'remote-node', sessionId: 'remote-live', status: 'running' })
  const reads = []
  world.bridge.onEvent = () => () => {}
  world.bridge.models = async request => {
    reads.push(['models', request])
    return { provider: 'codex', catalogSupported: true, models: [{ id: 'fixture-model', efforts: [{ id: 'high' }] }] }
  }
  window.mcRemoteEvents = { read: async request => {
    reads.push(['history', request])
    return { ok: true, seq: 1, events: [{ seq: 1, packet: { sessionId: 'remote-live',
      event: { type: 'turn_completed', turnId: 'remote-turn', status: 'completed' } } }] }
  } }
  view = await mountView(world)
  assert.deepEqual(reads.map(([kind]) => kind), ['models', 'history'], 'the live ownership and history reads must both execute')
  assert.doesNotMatch(view.el.querySelector('.org-status').textContent, /could not be reconnected/i,
    'the catalog callback must not abort a successfully read remote conversation')
  const saved = JSON.parse(world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID)))
  assert.equal(saved.nodes.find(node => node.id === 'remote-node').status, 'finished',
    'the recovered completion must settle the actual saved running node')
})

for (const status of ['interrupted', 'cancelled', 'failed', 'unknown', 'completed']) test(`remote reload releases queued work only after successful completion: ${status}`, async (t) => {
  const computerId = `remote-${status}-computer`
  const sessionId = `remote-${status}`
  const world = await installWorld(fleetFetch({ computerId }))
  const outbox = await import('../../src/session-outbox.js')
  let view
  t.after(() => { view?.destroy(); outbox.clearSession(sessionId); setBridgeTransport(null); world.restore() })
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'Unrelated fixture capability is unavailable.' }))
  world.storage.setItem('mc.write.agent-session', 'enabled')
  seedTreeNode(world.storage, { computerId, nodeId: `node-${status}`, sessionId, status: 'running' })
  const sends = []
  world.bridge.onEvent = () => () => {}
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.send = async request => { sends.push(request); return { ok: true, turnId: 'unexpected-turn' } }
  outbox.enqueue(sessionId, 'The next queued task.')
  window.mcRemoteEvents = { read: async () => ({ ok: true, seq: 1, events: [{ seq: 1,
    packet: { sessionId, event: { type: 'turn_completed', turnId: 'recovered-turn', status } } }] }) }
  view = await mountView(world, { computerId })
  const successful = status === 'completed'
  assert.equal(sends.length, successful ? 1 : 0,
    'reloading may release a queued task only after positive successful completion')
  assert.equal(outbox.list(sessionId).length, successful ? 0 : 1,
    'a stopped or unsuccessful session must retain its queued words for an explicit send')
})
