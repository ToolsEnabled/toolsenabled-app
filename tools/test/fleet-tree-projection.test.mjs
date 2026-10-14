import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { declaredFleetData } from '../../src/declared-fleet.js'
import { mergeFleetTreeProjection } from '../../src/fleet-tree-projection.js'
import { roleGraphPosture } from '../../src/role-graph-posture.js'
import { readCloudLane } from '../../src/lane-marks.js'

// Execute the view's small production adapters without mounting a browser or
// starting an agent. The substantive merging rule is imported directly above.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const graphBody = /function graphComputer\(\) \{([\s\S]*?)\n  \}/.exec(source)
assert.ok(graphBody)
const graphComputer = new Function('computer', 'treeAgents', 'mergeFleetTreeProjection', 'authoritativeTreeComputer = null', graphBody[1])
const projectionBody = /function projectedComputer\(computer, projection, roles = \[\]\) \{([\s\S]*?)\n\}/.exec(source)
assert.ok(projectionBody)
const projectInScope = new Function('readCloudLane', 'computer', 'projection', 'roles', 'roleGraphPosture', 'graphRole', 'drivenComputerCopy', projectionBody[1])
const project = (...args) => projectInScope(readCloudLane, ...args)

const circle = (id, name, sessionId = null, parentId = null) => ({
  id, name, sessionId, parentId, treeNode: { id, sessionId, parentId },
})

test('the mounted graph draws one saved circle when the fleet repeats its raw node ID', () => {
  const saved = circle('node-2-6c518599-05aa-4c77-a154-cefe49b278ed', 'Controller', 'session-one')
  const computer = { agents: [{ id: saved.id, name: saved.id }], graphEdges: [] }
  const result = graphComputer(computer, () => [saved], mergeFleetTreeProjection)
  assert.deepEqual(result.agents, [saved])
  assert.equal(result.agents[0].name, 'Controller')
  assert.equal(computer.agents[0].name, saved.id, 'the source projection is never mutated')
})

test('the declared session ID reaches the graph and joins a Controller seat to its exact saved circle', () => {
  const org = { revision: 1, agents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'codex', enabled: true }], relationships: [] }
  const data = declaredFleetData(org, { agentId: 'controller', sessionId: 'controller-session' })
  assert.equal(data.graph.nodes[0].sessionId, 'controller-session')
  const computer = project(data.computers[0], data.graph, [], roleGraphPosture, role => role, local => local)
  assert.equal(computer.agents[0].sessionId, 'controller-session')
  const saved = circle('saved-controller-node', 'Controller', 'controller-session')
  assert.deepEqual(graphComputer(computer, () => [saved], mergeFleetTreeProjection).agents, [saved])
})

test('same names and roles on different sessions are kept as distinct circles', () => {
  const projected = { id: 'independent-controller', name: 'Controller', sessionId: 'other-session' }
  const saved = circle('saved-controller', 'Controller', 'saved-session')
  assert.deepEqual(mergeFleetTreeProjection({ agents: [projected] }, [saved]).agents, [projected, saved])
})

test('remapped projection children keep their parent and stale edges cannot reparent a saved node', () => {
  const savedRoot = circle('saved-root', 'Controller', 'root-session')
  const savedChild = circle('saved-child', 'Worker', 'worker-session', 'saved-root')
  const computer = {
    agents: [
      { id: 'controller-seat', name: 'Controller', sessionId: 'root-session' },
      { id: 'observed-child', name: 'Observer', parentId: 'controller-seat' },
      { id: 'saved-child', name: 'Old worker name', parentId: 'observed-child' },
    ],
    graphEdges: [
      { from: 'controller-seat', to: 'observed-child', type: 'manages' },
      { from: 'observed-child', to: 'saved-child', type: 'manages' },
    ],
  }
  const result = mergeFleetTreeProjection(computer, [savedRoot, savedChild])
  assert.equal(result.agents.find(agent => agent.id === 'observed-child').parentId, 'saved-root')
  assert.equal(result.agents.find(agent => agent.id === 'saved-child').parentId, 'saved-root')
  assert.deepEqual(result.graphEdges, [{ from: 'saved-root', to: 'observed-child', type: 'manages' }])
  assert.equal(result.spawnedTotal, 3)
})

test('a computer with no saved circles keeps its original projection', () => {
  const computer = { agents: [{ id: 'recorded', name: 'Recorded' }] }
  assert.equal(mergeFleetTreeProjection(computer, []), computer)
})
