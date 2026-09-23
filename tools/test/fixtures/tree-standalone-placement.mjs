import './tree-box-workspace.mjs'

// Explicitly synthetic adoption and transport. This fixture verifies tab/DOM
// ownership and browser drops, not native store or session adoption.
localStorage.setItem('mc.write.agent-session', 'enabled')
const listeners = new Set(), calls = [], placements = []
const state = window.placementFixture = { listeners, calls, placements, fail: false, hold: false,
  emit: (sessionId, event) => listeners.forEach(listener => listener({ sessionId, event })) }
graph.standaloneAgent = { live: true, bridge: {
  availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
  onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
  send: async value => { calls.push(['send', value]); return { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
  interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
  close: async value => { calls.push(['close', value]); return { closed: true } },
} }
graph.canExtend = agent => !agent || agent.id !== 'review-child'
graph.onPlaceStandalone = async ({ record, parentId, computerId }) => {
  placements.push({ id: record.id, parentId, computerId })
  if (state.hold) await new Promise(resolve => { state.finish = resolve })
  if (state.fail) return { ok: false, sentence: 'Fixture parent is temporarily unavailable.' }
  const parent = fixture.nodes.find(agent => agent.id === parentId)
  const nodeId = `placed-${placements.length}`
  const node = { id: nodeId, parentId, name: `Placed ${record.agent.name}`, role: 'default', declaredRole: 'default', state: 'idle',
    treeNode: { id: nodeId, treeId: parent?.treeNode.treeId || `tree-${nodeId}` } }
  fixture.nodes.push(node); fixture.queues.set(nodeId, [])
  graph.refresh()
  if (!parentId) graph.treeWindows.choose(graph.treeWindows.windows[0], [...graph.windowRootIds, nodeId])
  return { ok: true, nodeId, sentence: `Added ${node.name}${parent ? ` under ${parent.name}` : ' as a new tree'}.` }
}
graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer'])
graph.setCardSize('medium')
graph.refresh()
document.addEventListener('drop', event => {
  if (event.dataTransfer?.types.includes('application/x-toolsenabled-standalone-agent')) state.lastDrag = {
    payload: event.dataTransfer.getData('application/x-toolsenabled-standalone-agent'), effect: event.dataTransfer.effectAllowed,
  }
}, true)
state.ready = true
