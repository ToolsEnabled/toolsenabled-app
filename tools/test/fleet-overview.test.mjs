import test from 'node:test'
import assert from 'node:assert/strict'
import { fleetOverviewSnapshot, overviewNodeState, OVERVIEW_STATES } from '../../src/fleet-overview.js'
import { createSampleTreeStore } from '../../src/sample-trees.js'

test('overview counts actual tree nodes, independently of the declared fleet', () => {
  const store = createSampleTreeStore()
  const result = fleetOverviewSnapshot(store, new Set(), { example: true })
  assert.equal(result.trees.length, 3)
  assert.equal(result.agents, 5)
  assert.equal(result.working, 1)
  assert.equal(result.review, 1)
  assert.equal(result.finished, 2)
  assert.equal(result.draft, 1)
  assert.equal(OVERVIEW_STATES.reduce((sum, state) => sum + result[state.key], 0), result.agents)
  for (const tree of result.trees) assert.equal(tree.rootId, store.rootOf(tree.id).id)
})

test('saved running status needs current session evidence outside the example', () => {
  const node = { status: 'running', sessionId: 'session-1' }
  assert.equal(overviewNodeState(node, new Set(['session-1'])), 'working')
  assert.equal(overviewNodeState(node, new Set()), 'review')
  assert.equal(overviewNodeState({ status: 'starting' }, new Set()), 'unconfirmed')
  assert.equal(overviewNodeState(node, new Set(), { example: true }), 'working')
})

test('turn completion and interruption update the summary without claiming task completion', () => {
  const store = createSampleTreeStore()
  const running = store.listTrees().flatMap(tree => store.listNodes(tree.id)).find(node => node.status === 'running')
  const owned = new Set([running.sessionId])
  assert.equal(fleetOverviewSnapshot(store, owned).working, 1)
  store.setNodeStatus(running.id, 'finished')
  const finished = fleetOverviewSnapshot(store, owned)
  assert.equal(finished.working, 0)
  assert.equal(finished.finished, 3)
  store.setNodeStatus(running.id, 'interrupted')
  assert.equal(fleetOverviewSnapshot(store, owned).review, 2)
})

test('an unavailable store remains unknown and never becomes an empty fleet', () => {
  assert.equal(fleetOverviewSnapshot(null, new Set()), null)
  assert.throws(() => fleetOverviewSnapshot({ listTrees() { throw new Error('unreadable') } }, new Set()), /unreadable/)
})

test('every persisted status has an explicit state, and unrecognised status stays unconfirmed', () => {
  for (const status of ['failed', 'turn-failed', 'interrupted']) {
    assert.equal(overviewNodeState({ status }, new Set()), 'review')
  }
  assert.equal(overviewNodeState({ status: 'finished' }, new Set()), 'finished')
  assert.equal(overviewNodeState({ status: 'draft' }, new Set()), 'draft')
  assert.equal(overviewNodeState({ status: 'future-status' }, new Set()), 'unconfirmed')
})

test('current evidence distinguishes pending starts, busy, idle, stale and unknown sessions', () => {
  const now = 1_800_000_000_000
  const owned = new Map([['busy-session', 'busy'], ['idle-session', 'idle'], ['quiet-session', 'quiet']])
  const evidence = { now, staleAfterMs: 90_000, seenAt: new Map([
    ['busy-session', now], ['idle-session', now], ['quiet-session', now - 90_001],
  ]) }
  const options = { evidence, startingNodeIds: new Set(['pending']) }
  for (const [node, expected] of [
    [{ id: 'busy', sessionId: 'busy-session', status: 'running' }, 'working'],
    [{ id: 'idle', sessionId: 'idle-session', status: 'finished' }, 'finished'],
    [{ id: 'quiet', sessionId: 'quiet-session', status: 'running' }, 'review'],
    [{ id: 'pending', sessionId: null, status: 'starting' }, 'working'],
    [{ id: 'old-start', sessionId: 'unknown-session', status: 'starting', runStartedAt: null }, 'review'],
    [{ id: 'wrong-session', sessionId: 'previous-session', status: 'running' }, 'review'],
    [{ id: 'never-started', sessionId: null, status: 'starting' }, 'unconfirmed'],
    [{ id: 'unrecognised', status: 'future-status' }, 'unconfirmed'],
  ]) assert.equal(overviewNodeState(node, owned, options), expected, node.id)
  for (const status of ['failed', 'turn-failed', 'interrupted', 'cancelled']) {
    assert.equal(overviewNodeState({ id: status, status }, owned, options), 'review', status)
  }
  assert.equal(overviewNodeState({ id: 'pending', status: 'starting' }, owned, { evidence }), 'unconfirmed',
    'a settled start must stop counting when its in-flight membership disappears')
  assert.throws(() => overviewNodeState({ status: 'running', sessionId: 'busy-session' },
    { has() { throw new Error('unreadable owned sessions') } }, options), /unreadable owned sessions/)
})

test('mounted restored cards, branch tooltips, collapsed groups and overview exclude phantom work', async t => {
  const { register } = await import('node:module')
  register('./helpers/css-stub-loader.mjs', import.meta.url)
  const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
  const { fleetTreesStorageKey } = await import('../../src/fleet-trees.js')
  const computerId = 'phantom-working-fixture'
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  document.createTextNode = text => {
    const node = document.createElement('span')
    node.textContent = text
    Object.defineProperty(node, 'data', { get: () => node.textContent, set: value => { node.textContent = value } })
    return node
  }
  world.storage.setItem('mc.set.tree_style', 'boxes')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  seedTreeNode(world.storage, { computerId, nodeId: 'root', sessionId: 'old-root', status: 'starting' })
  const key = fleetTreesStorageKey(computerId)
  const saved = JSON.parse(world.storage.getItem(key))
  const root = saved.nodes[0]
  const states = ['starting', 'starting', 'turn-failed', 'cancelled', 'interrupted', 'finished', 'failed']
  saved.nodes.push(...Array.from({ length: 30 }, (_, index) => ({
    ...root, id: `child-${index}`, parentId: root.id,
    status: states[index] || 'draft', sessionId: index < 6 ? `old-${index}` : null,
    message: index === 6 ? 'Run the retained fixture task.' : '',
    runMs: 0, runStartedAt: null,
  })))
  world.storage.setItem(key, JSON.stringify(saved))
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  const org = { revision: 1, source: 'overlay', agents: saved.nodes.map(node => ({ id: node.id, role: node.role, provider: 'codex', enabled: true })), edges: [] }
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  let starts = 0, sessionReads = 0, releaseStart
  const packets = new Set()
  world.bridge.onEvent = listener => { packets.add(listener); return () => packets.delete(listener) }
  world.bridge.start = async () => { starts++; throw new Error('display must not start a session') }
  world.bridge.send = async () => ({ turnId: 'fixture-turn' })
  world.bridge.sessionActivity = async () => { sessionReads++; throw new Error('MC_AGENT_UNKNOWN_SESSION') }
  let view
  t.after(() => {
    releaseStart?.({ ok: false, message: 'Fixture teardown' })
    view?.destroy()
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg)
    else delete globalThis.mcOrg
    world.restore()
  })
  view = await mountView(world, { computerId })
  const graph = window.__mcGraph
  assert.ok(graph, 'the real tree graph mounts')
  // The shared DOM stand-in lacks an unanchored child combinator. Resolve
  // the real box body without replacing any view, projection or render code.
  const paintBoxes = () => {
    for (const record of graph.nodes.values()) {
      const query = record.el.querySelector.bind(record.el)
      record.el.querySelector = selector => selector === '.tree-box-context > p'
        ? query('.tree-box-context')?.children.find(child => child.tagName === 'P') || null
        : query(selector)
    }
    graph._reconcile()
  }
  paintBoxes()
  const count = name => Number(view.el.querySelector(`[data-fleet-count="${name}"]`).textContent)
  assert.equal(count('working'), 0)
  assert.equal(count('review'), 7)
  const cards = view.el.querySelectorAll('.tree-agent-box')
  const rootCard = cards.find(card => card.dataset.agentId === root.id)
  assert.ok(rootCard, 'the actual restored root card is rendered')
  assert.doesNotMatch(rootCard.querySelector('.tree-box-status').textContent, /starting|running|working/i)
  assert.match(rootCard.querySelector('.tree-box-branch').title, /7 need review/)
  assert.doesNotMatch(rootCard.querySelector('.tree-box-branch').title, /working/)
  const groups = cards.filter(card => card.dataset.agentId?.startsWith('@tree-group:'))
  assert.ok(groups.length > 0, 'the fixture reaches actual collapsed-group rendering')
  for (const card of groups) assert.doesNotMatch(card.querySelector('.tree-box-status').textContent, /working/)
  assert.equal(starts, 0, 'display reconciliation never resumes saved circles')
  assert.equal(sessionReads, 0, 'summary/render adds no per-node host activity calls')

  graph.setRoot('child-6')
  await settle(6)
  view.el.querySelectorAll('.static-tree-node').find(card => card.dataset.agentId === 'child-6')
    .dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(6)
  const chat = view.el.querySelector('[data-rail-chat-host] .chat')
  chat.openActions()
  const retry = chat.querySelectorAll('.chat-actions-list button').find(button => button.textContent.startsWith('Retry starting this agent'))
  assert.ok(retry, 'the actual retained-task retry is available')
  world.bridge.start = () => { starts++; return new Promise(resolve => { releaseStart = resolve }) }
  retry.dispatch('click')
  await settle(8)
  assert.equal(starts, 1, 'the actual start producer reaches its pending bridge call')
  paintBoxes()
  assert.equal(count('working'), 1, 'a genuine pending start counts before it receives a session')
  assert.equal(graph._scopeModel().summary(root.id).working, 1)
  releaseStart({ ok: true, sessionId: 'current-session', threadId: 'fixture-thread' })
  await settle(12)
  paintBoxes()
  assert.equal(count('working'), 1)
  assert.equal(graph._scopeModel().summary(root.id).working, 1)
  assert.equal(graph.computer.agents.find(agent => agent.id === 'child-6').state, 'enabled')
  await Promise.all([...packets].map(listener => listener({ sessionId: 'current-session', event: {
    type: 'turn_completed', status: 'completed', turnId: 'fixture-turn',
  } })))
  await settle(6)
  paintBoxes()
  assert.equal(count('working'), 0, 'a live idle session is no longer working')
  assert.equal(graph._scopeModel().summary(root.id).working, 0)
  assert.equal(graph._scopeModel().summary(root.id).finished, 2)
  assert.equal(graph.computer.agents.find(agent => agent.id === 'child-6').state, 'finished')
  const after = JSON.parse(world.storage.getItem(key))
  for (const id of ['root', 'child-0', 'child-1']) {
    assert.equal(after.nodes.find(node => node.id === id).sessionId, saved.nodes.find(node => node.id === id).sessionId,
      'render correction must not rewrite or resume old sessions')
  }
})
