import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { fleetFetch, installWorld, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

register('./css-loader.mjs', import.meta.url)

for (const status of ['interrupted', 'failed', 'completed']) {
  test(`Home shared chat reattaches a saved remote session and respects its ${status} ending`, async t => {
    const computerId = `home-owner-${status}`, nodeId = `node-${status}`, sessionId = `session-${status}`
    const world = await installWorld(fleetFetch({ computerId }))
    const outbox = await import('../../src/session-outbox.js')
    let view
    t.after(() => { view?.destroy(); outbox.clearSession(sessionId); setBridgeTransport(null); world.restore() })
    delete window.mcShell.getBridgeProof
    setBridgeTransport(async () => ({ ok: false, reason: 'Unrelated fixture capability unavailable.' }))
    world.storage.setItem('mc.write.agent-session', 'enabled')
    seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
    const calls = []
    world.bridge.onEvent = () => () => {}
    world.bridge.models = async request => { calls.push(['models', request.sessionId]); return { provider: 'codex', catalogSupported: true, models: [] } }
    world.bridge.send = async request => { calls.push(['send', request.sessionId]); return { ok: true, turnId: 'next-turn' } }
    window.mcRemoteEvents = { read: async request => {
      calls.push(['history', request.sessionId])
      return { ok: true, seq: 1, events: [{ seq: 1, packet: { sessionId,
        event: { type: 'turn_completed', turnId: 'prior-turn', status } } }] }
    } }
    outbox.enqueue(sessionId, 'The next isolated queued task.')
    const { computersView } = await import('../../src/views/computers.js')
    view = computersView({ initialComputer: computerId, chatNodeId: nodeId, navigate() {} })
    document.body.appendChild(view.el)
    await settle()
    assert.deepEqual(calls.slice(0, 2), [['models', sessionId], ['history', sessionId]],
      'opening Home full chat must perform the same session ownership and history reads as Computers')
    const successful = status === 'completed'
    assert.equal(calls.filter(([kind]) => kind === 'send').length, successful ? 1 : 0)
    assert.equal(outbox.list(sessionId).length, successful ? 0 : 1)
    const saved = JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId)))
    assert.equal(saved.nodes.find(node => node.id === nodeId).status, successful ? 'running' : 'turn-failed')
    assert.equal(view.el.querySelectorAll('.computer-tree-canvas').length, 0, 'the shared owner does not mount a second canvas')
  })
}

test('closing Home shared chat during reconnect ignores late history and retains queued words', async t => {
  const computerId = 'home-closing-owner', nodeId = 'closing-node', sessionId = 'closing-session'
  const world = await installWorld(fleetFetch({ computerId }))
  const outbox = await import('../../src/session-outbox.js')
  let view, finishHistory
  const history = new Promise(resolve => { finishHistory = resolve })
  t.after(() => { finishHistory({ ok: false }); view?.destroy(); outbox.clearSession(sessionId); setBridgeTransport(null); world.restore() })
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'Unrelated fixture capability unavailable.' }))
  world.storage.setItem('mc.write.agent-session', 'enabled')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
  const calls = []
  world.bridge.onEvent = () => () => {}
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.send = async request => { calls.push(['send', request.sessionId]); return { ok: true } }
  window.mcRemoteEvents = { read: async request => { calls.push(['history', request.sessionId]); return history } }
  outbox.enqueue(sessionId, 'The retained isolated queued task.')
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: computerId, chatNodeId: nodeId, navigate() {} })
  document.body.appendChild(view.el)
  await settle()
  assert.deepEqual(calls, [['history', sessionId]], 'the close must interrupt an actual pending reconnect')
  view.destroy(); view = null
  finishHistory({ ok: true, seq: 1, events: [{ seq: 1, packet: { sessionId,
    event: { type: 'turn_completed', turnId: 'late-turn', status: 'completed' } } }] })
  await settle(20)
  assert.deepEqual(calls, [['history', sessionId]], 'a retired Home owner cannot drain queued work')
  assert.equal(outbox.list(sessionId).length, 1)
})
