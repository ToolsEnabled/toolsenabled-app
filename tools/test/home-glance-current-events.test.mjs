import test from 'node:test'
import assert from 'node:assert/strict'
import { homeFixture, THIS_COMPUTER_ID, until, settle } from './helpers/home-additions-world.mjs'
import { createFleetTreeStore, safeTreeStorage, fleetTreesStorageKey } from '../../src/fleet-trees.js'

const figuresOf = view => Object.fromEntries(['agents', 'runs', 'working', 'attention'].map(name => [
  name, Number(view.el.querySelector(`[data-glance="${name}"]`).textContent),
]))

const boardFiguresOf = view => {
  const summary = view.el.querySelector('[data-agents-summary]').textContent
  return {
    working: Number(summary.match(/(\d+)\s*working/)?.[1] || 0),
    attention: Number(summary.match(/(\d+)\s*needs? you/)?.[1] || 0),
  }
}

const rowStatusOf = view => view.el.querySelector('.home-run')?.dataset.status || ''

test('persisted Home session changes from observed work to approval and session end', async t => {
  const f = await homeFixture(t, { source: 'local' })
  const listeners = new Set()
  f.world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  f.world.bridge.availability = async () => ({ ok: true, available: true })
  f.world.bridge.usage = async () => ({ ok: true, entries: [] })

  const sessionId = 'current-events-session'
  const runAt = '2026-09-24T01:41:00.000Z'
  f.world.bridge.history = async () => ({ ok: true, verified: true, entries: [{
    sequence: 1,
    action: 'agent_session_start',
    at: runAt,
    sessionId,
    details: { agentId: 'node-current-events-1' },
  }] })

  const storage = safeTreeStorage(f.world.storage)
  const writer = createFleetTreeStore({
    computerId: THIS_COMPUTER_ID,
    storage,
    makeId: kind => `${kind}-current-events-1`,
    now: () => runAt,
  })
  const added = writer.addNode({ role: 'builder', message: 'Observe current event state.' })
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const nodeId = added.node.id
  assert.equal(nodeId, 'node-current-events-1')
  assert.equal(writer.attachSession(nodeId, sessionId).ok, true)
  assert.equal(writer.setNodeStatus(nodeId, 'running').ok, true)

  // The actual persisted reader converts saved running to starting and does
  // not add the drawing-only `agent` projection. Liveness must come from the
  // subscribed event stream, never from this saved status.
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID)
  const persistedBeforeEvents = f.world.storage.getItem(key)
  const reopened = createFleetTreeStore({ computerId: THIS_COMPUTER_ID, storage }).getNode(nodeId)
  assert.equal(reopened.sessionId, sessionId)
  assert.equal(reopened.status, 'starting')

  const view = await f.mount()
  const emit = event => {
    const packet = { sessionId, event }
    for (const listener of [...listeners]) listener(packet)
  }
  assert.ok(listeners.size > 0, 'Home subscribed to the inert event bridge')
  assert.deepEqual(figuresOf(view), { agents: 1, runs: 1, working: 0, attention: 0 })
  assert.deepEqual(boardFiguresOf(view), { working: 0, attention: 0 })

  emit({ type: 'assistant_text_delta', turnId: 'turn-current', itemId: 'answer-current', text: 'Observed work.' })
  await until(() => figuresOf(view).working === 1, 'assistant_text_delta must reach the Home reader')
  assert.deepEqual(figuresOf(view), { agents: 1, runs: 1, working: 1, attention: 0 })
  assert.deepEqual(boardFiguresOf(view), { working: 1, attention: 0 })
  assert.equal(rowStatusOf(view), 'working')

  emit({
    type: 'approval_request',
    turnId: 'turn-current',
    approval: {
      approvalId: 'approval-current',
      kind: 'command',
      availableDecisions: ['allow'],
      details: { command: 'echo current' },
    },
  })
  await until(() => figuresOf(view).attention === 1 && figuresOf(view).working === 0,
    'approval_request must withdraw current work and show attention')
  assert.deepEqual(figuresOf(view), { agents: 1, runs: 1, working: 0, attention: 1 })
  assert.deepEqual(boardFiguresOf(view), { working: 0, attention: 1 })
  assert.equal(rowStatusOf(view), 'attention')

  // A separate observed turn restores work so end must withdraw it itself,
  // rather than merely preserving the idle state left by approval.
  emit({ type: 'assistant_text_delta', turnId: 'turn-after-approval', itemId: 'answer-after-approval', text: 'Work resumed.' })
  await until(() => figuresOf(view).working === 1, 'a later observed turn restores current work')
  assert.deepEqual(figuresOf(view), { agents: 1, runs: 1, working: 1, attention: 0 })
  assert.deepEqual(boardFiguresOf(view), { working: 1, attention: 0 })
  assert.equal(rowStatusOf(view), 'working')

  emit({
    type: 'session_ended',
    reason: 'exited',
    exit: { code: 0, signal: null },
  })
  await until(() => view.el.querySelector('.run-state-label')?.textContent === 'Session ended',
    'session_ended must remain an attention state in the Home row')
  assert.deepEqual(figuresOf(view), { agents: 1, runs: 1, working: 0, attention: 1 })
  assert.deepEqual(boardFiguresOf(view), { working: 0, attention: 1 })
  assert.equal(rowStatusOf(view), 'attention')
  assert.equal(f.world.storage.getItem(key), persistedBeforeEvents, 'event painting does not rewrite the persisted tree')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
  await f.close(view)
  await settle(2)
})
