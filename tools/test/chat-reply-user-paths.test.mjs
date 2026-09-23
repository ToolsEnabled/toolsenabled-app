import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'

register('./css-loader.mjs', import.meta.url)

const { fleetFetch, installWorld, seedTreeNode, settle } = await import('./lib/tree-command-real-mount.mjs')

/* These are real computersView mounts over the in-memory fleet tree, agent
   event bridge, DOM stand-in and transcript bridge. They do not claim browser
   or native execution. Every user gesture below calls a supported mounted
   surface control: openDetails() or the visible Close controls button. */

const FINAL_A = 'Reply A stays with node A.'
const FINAL_B = 'Reply B stays with node B.'
const NEXT_A = 'A final-only next turn stays separate.'
const TOOL_COUNT = 6

function addNode(storage, computerId, { nodeId, sessionId, parentId }) {
  const key = fleetTreesStorageKey(computerId)
  const saved = JSON.parse(storage.getItem(key))
  const template = saved.nodes[0]
  saved.nodes.push({
    ...template,
    id: nodeId,
    sessionId,
    status: 'running',
    parentId,
    message: '',
    reply: '',
  })
  storage.setItem(key, JSON.stringify(saved))
}

function transcriptBridge(computerId, nodeIds, entriesByNode) {
  return {
    list: async () => ({ ok: true, records: nodeIds.map(nodeId => ({ computerId, nodeId })) }),
    read: async ({ nodeId }) => ({
      ok: true,
      entries: [...(entriesByNode.get(nodeId) || [])],
      metadata: { computerId, nodeId },
      before: null,
    }),
    append: async ({ nodeId, entries }) => {
      const held = entriesByNode.get(nodeId) || []
      const seen = new Set(held.map(entry => entry.id))
      for (const entry of entries || []) {
        if (!seen.has(entry.id)) held.push({ ...entry })
      }
      entriesByNode.set(nodeId, held)
      return { ok: true }
    },
    bind: async () => ({ ok: true }),
    onError: () => () => {},
  }
}

async function mounted(t, { computerId, nodes }) {
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  let view = null
  const hosts = new Map()
  const surfaces = new Map()
  t.after(() => {
    try {
      for (const surface of surfaces.values()) surface.dispose()
      for (const host of hosts.values()) host.remove()
      view?.destroy()
      delete window.mcTranscripts
    } finally {
      world.restore()
    }
  })

  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  seedTreeNode(world.storage, { computerId, ...nodes[0] })
  for (const node of nodes.slice(1)) addNode(world.storage, computerId, node)

  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 })
  const entriesByNode = new Map(nodes.map(node => [node.nodeId, []]))
  window.mcTranscripts = transcriptBridge(computerId, nodes.map(node => node.nodeId), entriesByNode)

  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: computerId, navigate() {}, chatWorkspace: true })
  document.body.appendChild(view.el)
  await view.chatWorkspace.ready
  await settle(12)

  for (const node of nodes) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.set(node.nodeId, host)
    surfaces.set(node.nodeId, view.chatWorkspace.mount(host, { nodeId: node.nodeId }))
  }
  await settle(12)

  const emit = async (sessionId, event) => {
    const packet = { turnId: event.turnId || 'turn-a', ...event }
    for (const listener of [...listeners]) await listener({ sessionId, event: packet })
    await settle(8)
  }
  const openRail = async nodeId => {
    surfaces.get(nodeId).openDetails()
    await settle(16)
    const rail = document.querySelector('[data-rail-chat-host] .chat')
    assert.ok(rail, `the mounted Controls door opens node ${nodeId}'s rail chat`)
    return rail
  }
  const closeControls = async () => {
    const close = document.querySelector('.home-workspace-controls-close')
    assert.ok(close, 'the mounted Controls door exposes its visible Close controls button')
    close.click()
    await settle(12)
    assert.equal(document.querySelector('.home-workspace-controls-close'), null, 'closing Controls removes the overlay')
  }
  const answers = rail => [...rail.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  const toolRows = rail => rail.querySelectorAll('[data-action-kind="call"]')
  const saveAgentEntry = (nodeId, sessionId, turnId, text) => {
    entriesByNode.set(nodeId, [{ id: `agent:${sessionId}:${turnId}`, who: 'agent', text, turnStamp: turnId, at: 2 }])
  }
  return { world, view, nodes, surfaces, entriesByNode, emit, openRail, closeControls, answers, toolRows, saveAgentEntry }
}

test('stage 1 final reply -> stage 2 close/reopen -> stage 3 final-only next turn stays one reply per turn', async t => {
  const node = { nodeId: 'reply-reopen-node', sessionId: 'reply-reopen-session' }
  const f = await mounted(t, { computerId: 'reply-reopen-computer', nodes: [node] })
  const rail = await f.openRail(node.nodeId)

  await f.emit(node.sessionId, { type: 'assistant_text_delta', itemId: 'first', turnId: 'first-turn', text: FINAL_A })
  await f.emit(node.sessionId, { type: 'assistant_text', itemId: 'first', turnId: 'first-turn', text: FINAL_A })
  f.saveAgentEntry(node.nodeId, node.sessionId, 'first-turn', FINAL_A)
  await f.emit(node.sessionId, { type: 'turn_completed', turnId: 'first-turn', status: 'completed' })
  assert.deepEqual(f.answers(rail), [FINAL_A], 'stage 1 shows the completed reply once')

  await f.closeControls()
  const reopened = await f.openRail(node.nodeId)
  assert.deepEqual(f.answers(reopened), [FINAL_A], 'stage 2 reopening the same rail keeps the completed reply without duplication')

  f.entriesByNode.set(node.nodeId, [
    { id: `agent:${node.sessionId}:first-turn`, who: 'agent', text: FINAL_A, turnStamp: 'first-turn', at: 2 },
    { id: `agent:${node.sessionId}:next-turn`, who: 'agent', text: NEXT_A, turnStamp: 'next-turn', at: 3 },
  ])
  await f.emit(node.sessionId, { type: 'assistant_text', itemId: 'next', turnId: 'next-turn', text: NEXT_A })
  await f.emit(node.sessionId, { type: 'turn_completed', turnId: 'next-turn', status: 'completed' })
  assert.deepEqual(f.answers(reopened), [FINAL_A, NEXT_A], 'stage 3 final-only next turn becomes a second visible reply, not a rewrite of the first')
  assert.equal(f.answers(reopened).filter(text => text === FINAL_A).length, 1, 'the first reply remains exactly once')
  assert.equal(f.answers(reopened).filter(text => text === NEXT_A).length, 1, 'the final-only next reply remains exactly once')
})

test('stage 1 node A reply -> stage 2 switch to node B -> stage 3 switch back preserves rail identity and text', async t => {
  const nodeA = { nodeId: 'reply-switch-node-a', sessionId: 'reply-switch-session-a' }
  const nodeB = { nodeId: 'reply-switch-node-b', sessionId: 'reply-switch-session-b', parentId: nodeA.nodeId }
  const f = await mounted(t, { computerId: 'reply-switch-computer', nodes: [nodeA, nodeB] })

  let rail = await f.openRail(nodeA.nodeId)
  await f.emit(nodeA.sessionId, { type: 'assistant_text', itemId: 'a-final', turnId: 'a-turn', text: FINAL_A })
  f.saveAgentEntry(nodeA.nodeId, nodeA.sessionId, 'a-turn', FINAL_A)
  await f.emit(nodeA.sessionId, { type: 'turn_completed', turnId: 'a-turn', status: 'completed' })
  assert.deepEqual(f.answers(rail), [FINAL_A], 'stage 1 node A rail shows only node A reply')

  rail = await f.openRail(nodeB.nodeId)
  assert.deepEqual(f.answers(rail), [], 'stage 2 switching to node B starts with no node A reply')
  await f.emit(nodeB.sessionId, { type: 'assistant_text', itemId: 'b-final', turnId: 'b-turn', text: FINAL_B })
  f.saveAgentEntry(nodeB.nodeId, nodeB.sessionId, 'b-turn', FINAL_B)
  await f.emit(nodeB.sessionId, { type: 'turn_completed', turnId: 'b-turn', status: 'completed' })
  assert.deepEqual(f.answers(rail), [FINAL_B], 'stage 2 node B rail shows only node B reply')
  assert.equal(f.answers(rail).includes(FINAL_A), false, 'node A text does not cross into node B')

  rail = await f.openRail(nodeA.nodeId)
  assert.deepEqual(f.answers(rail), [FINAL_A], 'stage 3 switching back restores node A reply')
  assert.equal(f.answers(rail).includes(FINAL_B), false, 'node B text does not cross back into node A')
  assert.equal(f.toolRows(rail).length, 0, 'identity switch does not fabricate tool rows')
})

test('stage 1 two tools -> stage 2 open during the turn -> stage 3 remaining tools and final arrive without duplicate text', async t => {
  const node = { nodeId: 'reply-tools-node', sessionId: 'reply-tools-session' }
  const f = await mounted(t, { computerId: 'reply-tools-computer', nodes: [node] })

  const emitTool = async index => {
    await f.emit(node.sessionId, {
      type: 'tool_call', itemId: `tool-${index}`, toolCallId: `tool-${index}`,
      tool: 'commandExecution', payload: { command: `inspect fixture ${index}` },
      turnId: 'tools-turn',
    })
    await f.emit(node.sessionId, {
      type: 'tool_result', itemId: `tool-${index}`, toolCallId: `tool-${index}`,
      tool: 'commandExecution', payload: { status: 'completed', exitCode: 0, aggregatedOutput: `fixture ${index} verified` },
      turnId: 'tools-turn',
    })
  }
  await emitTool(0)
  await emitTool(1)
  const rail = await f.openRail(node.nodeId)
  assert.equal(f.toolRows(rail).length, 2, 'stage 2 opening during tools shows the two completed tool rows')

  for (let index = 2; index < TOOL_COUNT; index++) await emitTool(index)
  await f.emit(node.sessionId, { type: 'assistant_text', itemId: 'tools-final', turnId: 'tools-turn', text: FINAL_A })
  f.saveAgentEntry(node.nodeId, node.sessionId, 'tools-turn', FINAL_A)
  await f.emit(node.sessionId, { type: 'turn_completed', turnId: 'tools-turn', status: 'completed' })

  assert.deepEqual(f.answers(rail), [FINAL_A], 'stage 3 final arrival leaves one visible reply after the tools')
  assert.equal(f.toolRows(rail).length, TOOL_COUNT, 'stage 3 keeps every tool row visible exactly once')
  assert.equal(f.answers(rail).filter(text => text === FINAL_A).length, 1, 'the final reply is not duplicated by completion')
})
