import test from 'node:test'
import assert from 'node:assert/strict'
import { homeFixture, THIS_COMPUTER_ID, until, settle } from './helpers/home-additions-world.mjs'
import { createFleetTreeStore, safeTreeStorage, fleetTreesStorageKey } from '../../src/fleet-trees.js'

// Actual Home mount and persisted store reader; no native transport or geometry.
test('persisted Home members join observed session work before and after their run is recorded', async t => {
  const f = await homeFixture(t, { source: 'local' })
  const listeners = new Set()
  f.world.bridge.onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn) }
  f.world.bridge.availability = async () => ({ ok: true, available: true })
  f.world.bridge.usage = async () => ({ ok: true, entries: [] })
  let history = []
  f.world.bridge.history = async () => ({ ok: true, verified: true, entries: history })
  let id = 0
  const options = { computerId: THIS_COMPUTER_ID, storage: safeTreeStorage(f.world.storage),
    makeId: kind => `${kind}-persisted-${++id}`, now: () => new Date().toISOString() }
  const writer = createFleetTreeStore(options)
  const added = writer.addNode({ role: 'builder', message: 'Check the saved reader.' })
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const nodeId = added.node.id, sessionId = 'persisted-home-session'
  assert.equal(writer.attachSession(nodeId, sessionId).ok, true)
  assert.equal(writer.setNodeStatus(nodeId, 'running').ok, true)
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID)
  const persisted = f.world.storage.getItem(key)
  const reopened = createFleetTreeStore(options).getNode(nodeId)
  assert.equal(reopened.sessionId, sessionId)
  assert.equal(reopened.status, 'starting', 'saved running is unconfirmed after reopening')
  assert.equal(f.world.storage.getItem(key), persisted, 'the reader preserves saved bytes')

  const figures = view => Object.fromEntries(['agents', 'runs', 'working', 'attention'].map(name =>
    [name, Number(view.el.querySelector(`[data-glance="${name}"]`).textContent)]))
  const boardWorking = view => Number(view.el.querySelector('[data-agents-summary]').textContent.match(/(\d+)\s*working/)?.[1] || 0)
  for (const recorded of [false, true]) {
    history = recorded ? [{ sequence: 1, action: 'agent_session_start', at: new Date().toISOString(),
      sessionId, details: { agentId: nodeId } }] : []
    const view = await f.mount()
    assert.equal(figures(view).working, 0, 'persisted status alone is not observed work')
    assert.equal(boardWorking(view), 0)
    assert.ok(listeners.size > 0, 'Home has subscribed to the inert event bridge')
    for (const listener of [...listeners]) listener({ sessionId, event: {
      type: 'assistant_text_delta', turnId: recorded ? 'turn-recorded' : 'turn-before-record',
      itemId: 'message-one', text: 'Observed reply from the retained session.',
    } })
    await until(() => figures(view).working === 1, `Home must join the persisted session with observed work (recorded=${recorded})`)
    assert.deepEqual(figures(view), { agents: 1, runs: recorded ? 1 : 0, working: 1, attention: 0 })
    assert.equal(boardWorking(view), 1, 'actual panel and strip agree')
    await f.close(view)
    await settle(2)
  }
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})
