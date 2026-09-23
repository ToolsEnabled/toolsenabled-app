import { mountComputers as mountBase, settle, COMPUTER_ID } from './t1308-computers-fixture.mjs'
import { fleetTreesStorageKey } from '../../../src/fleet-trees.js'
export { settle }
export const family = () => [
  { id: 'root', role: 'controller', name: 'Controller' },
  { id: 'manager-a', parentId: 'root', role: 'manager', name: 'Manager A' },
  { id: 'manager-b', parentId: 'root', role: 'manager', name: 'Manager B' },
  { id: 'worker', parentId: 'manager-a', name: 'Worker' },
]
export async function mountComputers(t, nodes = family()) {
  const fixture = await mountBase(t, { nodes })
  const query = selector => fixture.view.el.querySelector(selector)
  return { ...fixture, get graph() { return fixture.graph }, query,
    saved: () => JSON.parse(fixture.world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))),
    replaceSaved: value => fixture.world.storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify(value)),
    choices: () => [...query('[data-tree-move-select]').querySelectorAll('option')].map(option => option.value).filter(Boolean),
    async move(id, parentId) {
      const result = fixture.graph.onReparent(id, parentId)
      await settle()
      return result
    },
  }
}
// Only hit geometry is controlled here. Target eligibility and drop/refusal
// behavior run through the actual mounted StaticTreeGraph and view callbacks.
export function hover(graph, nodeId, targetId) {
  if (!graph.editMode) graph.setEditMode(true)
  if (!graph.editMode) throw new Error('Actual graph could not enter Edit')
  const record = graph.nodes.get(nodeId), target = graph.nodes.get(targetId)
  if (!record || !target) throw new Error('Mounted drag records are missing')
  const oldHit = graph._dropHit, oldHeader = graph._headerNewTreeDropTarget
  const culled = graph._culled
  graph._dropHit = candidate => candidate === target ? -1 : 1
  graph._headerNewTreeDropTarget = () => null
  graph._culled = new Set()
  try { graph._updateDropTarget(record, {}) } finally {
    graph._dropHit = oldHit; graph._headerNewTreeDropTarget = oldHeader; graph._culled = culled
  }
  return { record, target, allowed: graph._dropRec === target }
}
