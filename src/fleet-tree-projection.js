/* The live fleet and the saved tree can describe the same circle. The saved
 * node owns its name, placement, and controls; matching by a role or display
 * name would hide unrelated circles, so only exact node/session IDs join. */
const sessionOf = agent => agent?.sessionId || agent?.treeNode?.sessionId || null
const hierarchy = new Set(['manages', 'delegates_to'])

export function mergeFleetTreeProjection(computer, treeAgents = []) {
  if (!computer || !Array.isArray(treeAgents) || treeAgents.length === 0) return computer
  const byId = new Map(treeAgents.map(agent => [agent.id, agent]))
  const bySession = new Map()
  for (const agent of treeAgents) {
    const sessionId = sessionOf(agent)
    if (!sessionId) continue
    bySession.set(sessionId, bySession.has(sessionId) ? null : agent)
  }
  const aliases = new Map()
  const projected = []
  for (const agent of computer.agents || []) {
    const saved = byId.get(agent.id) || bySession.get(sessionOf(agent))
    if (saved) aliases.set(agent.id, saved.id)
    else projected.push(agent)
  }
  const currentId = id => aliases.get(id) || id
  const agents = projected.map(agent => aliases.has(agent.parentId)
    ? { ...agent, parentId: currentId(agent.parentId) } : agent).concat(treeAgents)
  const present = new Set(agents.map(agent => agent.id))
  const graphEdges = (computer.graphEdges || []).flatMap(edge => {
    const from = currentId(edge.from)
    const to = currentId(edge.to)
    if (from === to || !present.has(from) || !present.has(to)) return []
    // A saved node's current parent is authoritative over a stale fleet edge.
    if (hierarchy.has(edge.type) && byId.has(to)) return []
    return [{ ...edge, from, to }]
  })
  return { ...computer, agents, graphEdges, spawnedTotal: agents.length }
}
