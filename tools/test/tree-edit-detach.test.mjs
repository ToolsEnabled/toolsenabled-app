import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

function editingGraph(t, { rootIds = ['root'], onDetach, onReparent } = {}) {
  const agents = [
    { id: 'root', parentId: null, treeNode: { treeId: 'first' } },
    { id: 'child', parentId: 'root', treeNode: { treeId: 'first' } },
    { id: 'grandchild', parentId: 'child', treeNode: { treeId: 'first' } },
    { id: 'other-root', parentId: null, treeNode: { treeId: 'second' } },
    { id: 'other-child', parentId: 'other-root', treeNode: { treeId: 'second' } },
    { id: 'excluded', parentId: null, treeNode: { treeId: 'outside' } },
  ]
  const snapshots = [], cleared = []
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    computer: { id: 'edit-detach-fixture', agents }, declaredEdges: [],
    smartScope: true, editMode: true, rootId: null, _editRootIds: rootIds,
    windowRootIds: [...rootIds], nodes: new Map(), _chatTimers: new Set(),
    _reconcile() { snapshots.push(this.visibleAgents()) },
    _layoutNow() { snapshots.push(this.visibleAgents()) },
    _clearPosition(id) { cleared.push(id) },
    _positionRecord() {}, _renderLinks() {}, _positions: {}, _writePositions() {},
    onDetachToNewTree: onDetach ? id => onDetach({ graph, agents, id, snapshots }) : null,
    onReparent: onReparent ? (id, parentId) => onReparent({ graph, agents, id, parentId, snapshots }) : null,
  })
  const record = { id: 'child', agent: agents[1], el: new Element('div'), x: 30, y: 40, slot: { x: 10, y: 20 } }
  const slot = { id: 'new-tree-slot', kind: 'new-tree', el: new Element('div') }
  graph._dropRec = graph._dropRaw = slot
  t.after(() => { for (const timer of graph._chatTimers) clearTimeout(timer) })
  return { graph, agents, record, slot, snapshots, cleared,
    drop: () => graph._finishEditDrag(record, { recordX: 10, recordY: 20 }) }
}

const ids = agents => agents.map(agent => agent.id)

function headerDrag(t, { secondary = false, canDrag = () => true } = {}) {
  const { document, restore } = installDomStandIn()
  t.after(restore)
  // The newer edge-pan path schedules frames while a pointer is outside the
  // canvas. Keep a browser-shaped queue instead of recursively running RAF.
  const frames = new Map()
  let nextFrame = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const detached = []
  const f = editingGraph(t, { onDetach({ agents, id }) {
    detached.push(id)
    agents[1].parentId = null
    agents[1].treeNode.treeId = agents[2].treeNode.treeId = 'detached'
    return true
  } })
  const button = document.createElement('button')
  document.body.appendChild(button)
  button.getBoundingClientRect = () => ({ left: 480, top: 10, right: 520, bottom: 50, width: 40, height: 40 })
  document.elementFromPoint = () => button
  const workspace = { newTreeDropTarget: { id: 'empty:new-tree', kind: 'new-tree', parentId: null, el: button } }
  Object.assign(f.graph, {
    W: 900, H: 600, nodes: new Map([[f.record.id, f.record]]), emptySlots: new Map(), _culled: new Set(), canDrag,
    zoomHost: { getBoundingClientRect: () => ({ left: 0, top: 100, right: 900, bottom: 700 }) },
    ...(secondary ? { chatOwner: { workspace } } : { workspace }),
    // The canvas begins below the header and constrains the dragged node.
    // Only the actual pointer can reach the header outside that corridor.
    _toGraph: event => ({ x: event.clientX, y: event.clientY - 100 }), _dragBand: () => [40, 550],
  })
  f.record.r = 30
  f.record.el.setPointerCapture = () => {}
  f.record.el.releasePointerCapture = () => {}
  f.graph._dropRec = f.graph._dropRaw = null
  f.graph._wireNode(f.record)
  return { ...f, button, detached, document, frames,
    pointer(type, point = { clientX: 500, clientY: 30 }) {
      f.record.el.dispatch(type, { pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...point })
    },
  }
}

for (const secondary of [false, true]) test(`the ${secondary ? 'secondary' : 'main'} canvas pointer drop detaches through the header outside its drag band`, t => {
  const f = headerDrag(t, { secondary })
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove')
  assert.equal(f.record.y, 40, 'the canvas node stays in its ordinary drag band')
  assert.equal(f.graph._dropRec?.el, f.button)
  assert.equal(f.button.classList.contains('drop-ok'), true)
  assert.equal(f.frames.size, 1, 'the edge-pan frame is queued while the pointer is held')
  f.pointer('pointerup')
  assert.equal(f.frames.size, 0, 'release cancels the pending edge-pan frame')
  assert.deepEqual(f.detached, ['child'])
  assert.equal(f.agents[1].parentId, null)
  assert.equal(f.agents[2].parentId, 'child')
  assert.equal(f.agents[2].treeNode.treeId, f.agents[1].treeNode.treeId)
  assert.deepEqual(f.graph._editRootIds, ['root', 'child'])
  assert.equal(f.button.classList.contains('drop-ok'), false)
})

for (const ending of ['pointercancel', 'lostpointercapture', 'pointermove']) {
  test(`${ending} without a held button cancels a branch drag without detaching or saving a nudge`, t => {
    const f = headerDrag(t)
    let writes = 0
    f.graph._writePositions = () => { writes++ }
    const before = structuredClone(f.agents)
    f.pointer('pointerdown', { clientX: 30, clientY: 140 })
    f.pointer('pointermove')
    assert.equal(f.graph._dropRec?.el, f.button)
    f.pointer(ending, { clientX: 500, clientY: 30, buttons: 0 })
    assert.deepEqual(f.detached, [], 'an interrupted gesture is not a confirmed drop')
    assert.deepEqual(f.agents, before)
    assert.deepEqual([f.record.x, f.record.y], [30, 40])
    assert.equal(writes, 0)
    assert.equal(f.frames.size, 0)
    assert.equal(f.record.el.classList.contains('dragging'), false)
    assert.equal(f.button.classList.contains('drop-ok'), false)
    assert.equal(f.graph._dropRec, null)
    assert.equal(f.graph._dropRaw, null)
    f.pointer('pointerup')
    assert.deepEqual(f.detached, [], 'a late release cannot revive the cancelled drag')
    f.pointer('pointerdown', { clientX: 30, clientY: 140 })
    f.pointer('pointermove')
    f.pointer('pointerup')
    assert.deepEqual(f.detached, ['child'], 'the next deliberate gesture still works')
  })
}

test('a second pointer cannot replace the pointer dragging a branch', t => {
  const f = headerDrag(t)
  const captures = []
  f.record.el.setPointerCapture = id => captures.push(id)
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove')
  f.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 200 })
  assert.deepEqual(captures, [1])
  f.pointer('pointermove', { pointerId: 2, clientX: 500, clientY: 30 })
  f.pointer('pointerup', { pointerId: 2, clientX: 500, clientY: 30 })
  assert.deepEqual(f.detached, [])
  assert.equal(f.record.el.classList.contains('dragging'), true)
  f.pointer('pointerup')
  assert.deepEqual(f.detached, ['child'])
})

test('releasing capture cannot reenter and commit the same branch drop twice', t => {
  const f = headerDrag(t)
  let releases = 0
  f.record.el.releasePointerCapture = pointerId => {
    if (++releases === 1) f.pointer('lostpointercapture', { pointerId, clientX: 500, clientY: 30 })
  }
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove')
  f.pointer('pointerup')
  assert.equal(releases, 1)
  assert.deepEqual(f.detached, ['child'])
  assert.equal(f.frames.size, 0)
})

test('cancelling a free move preserves the saved position and never writes a new nudge', t => {
  const f = headerDrag(t)
  f.graph._positions.child = { v: 2, parentId: 'root', dx: 20, dy: 20, at: 1 }
  const saved = structuredClone(f.graph._positions)
  let writes = 0
  f.graph._writePositions = () => { writes++ }
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove', { clientX: 300, clientY: 300 })
  assert.equal(f.graph._dropRec, null)
  assert.notEqual(f.record.x, 30)
  f.pointer('pointercancel', { clientX: 300, clientY: 300 })
  assert.deepEqual([f.record.x, f.record.y], [30, 40])
  assert.deepEqual(f.graph._positions, saved)
  assert.equal(writes, 0)
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove', { clientX: 300, clientY: 300 })
  f.pointer('pointerup', { clientX: 300, clientY: 300 })
  assert.equal(writes, 1, 'deliberately releasing a free move still saves it')
  assert.equal(f.graph._positions.child.dx, 290)
})

test('a node the model marks fixed cannot be picked up or nudged into saved positions', t => {
  const f = headerDrag(t, { canDrag: () => false })
  const captured = [], refused = []
  f.record.el.setPointerCapture = id => captured.push(id)
  f.graph.onDropRefused = reason => refused.push(reason)
  let writes = 0
  f.graph._writePositions = () => { writes++ }
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove', { clientX: 300, clientY: 300 })
  f.pointer('pointerup', { clientX: 300, clientY: 300 })
  assert.deepEqual(captured, [], 'canDrag applies before pointer capture, even over empty space')
  assert.deepEqual(refused, ['notDraggable'])
  assert.deepEqual([f.record.x, f.record.y], [30, 40])
  assert.equal(writes, 0)
  assert.deepEqual(f.detached, [])
})

test('revoking draggability while a node is held cancels its unsaved position', t => {
  let permitted = true
  const f = headerDrag(t, { canDrag: () => permitted })
  const refused = []
  f.graph.onDropRefused = reason => refused.push(reason)
  let writes = 0
  f.graph._writePositions = () => { writes++ }
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove', { clientX: 300, clientY: 300 })
  assert.notEqual(f.record.x, 30)
  permitted = false
  f.pointer('pointerup', { clientX: 300, clientY: 300 })
  assert.deepEqual(refused, ['notDraggable'])
  assert.deepEqual([f.record.x, f.record.y], [30, 40])
  assert.equal(writes, 0)
  assert.equal(f.graph._nodeDrag, null)
})

test('another node and the background cannot claim an active branch drag', t => {
  const f = headerDrag(t)
  const other = { id: 'other-root', agent: f.agents[3], el: new Element('div'), x: 200, y: 200 }
  const captures = []
  other.el.setPointerCapture = id => captures.push(id)
  other.el.releasePointerCapture = () => {}
  f.graph._wireNode(other)
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  other.el.dispatch('pointerdown', { pointerId: 2, button: 0, clientX: 200, clientY: 300 })
  assert.deepEqual(captures, [])
  assert.equal(other.el.classList.contains('dragging'), false)
  f.pointer('pointermove')
  // A pan and a node drag share the camera. Even a second primary device
  // (for example, a mouse while a pen is held) cannot take over that camera.
  f.graph.zoomHost = new Element('div')
  f.graph._wireHostInteractions()
  f.graph._onPanDown({ pointerId: 2, button: 0, target: f.graph.zoomHost,
    preventDefault() {}, clientX: 200, clientY: 300 })
  assert.equal(f.graph._panState, undefined)
  f.pointer('pointerup')
  assert.deepEqual(f.detached, ['child'])
})

test('a secondary touch or failed pointer capture cannot leave a branch dragging', t => {
  const f = headerDrag(t)
  let captures = 0
  f.record.el.setPointerCapture = () => { captures++; throw new Error('pointer is no longer active') }
  f.pointer('pointerdown', { isPrimary: false, clientX: 30, clientY: 140 })
  assert.equal(captures, 0)
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  assert.equal(captures, 1)
  assert.equal(f.record.el.classList.contains('dragging'), false)
  assert.equal(f.graph._nodeDrag, null)
  f.pointer('pointermove')
  f.pointer('pointerup')
  assert.deepEqual(f.detached, [])
})

test('the header drop retains the injected read-only refusal and rejects a covered or departed target', t => {
  const f = headerDrag(t, { canDrag: () => false })
  const before = structuredClone(f.agents)
  f.pointer('pointerdown', { clientX: 30, clientY: 140 })
  f.pointer('pointermove')
  assert.equal(f.graph._dropRec, null)
  f.pointer('pointerup')
  assert.deepEqual(f.detached, [])
  assert.deepEqual(f.agents, before)
  f.graph.canDrag = () => true
  f.document.elementFromPoint = () => f.document.body
  f.graph._updateDropTarget(f.record, { clientX: 500, clientY: 30 })
  assert.equal(f.graph._dropRec, null, 'an overlay must prevent the header drop')
  f.button.remove()
  f.graph._updateDropTarget(f.record, { clientX: 500, clientY: 30 })
  assert.equal(f.graph._dropRec, null, 'a removed header cannot accept a captured pointer')
})

test('a detached edit branch remains selected during synchronous store refresh and retains every descendant', t => {
  const selected = ['root']
  const { graph, record, drop, snapshots, cleared } = editingGraph(t, {
    rootIds: selected,
    onDetach({ graph, agents, id, snapshots }) {
      assert.equal(id, 'child')
      agents[1].parentId = null
      agents[1].treeNode.treeId = agents[2].treeNode.treeId = 'detached'
      graph.refresh()
      assert.deepEqual(ids(snapshots.at(-1)), ['root', 'child', 'grandchild'],
        'the store notification cannot remove the emerging tree before its callback returns')
      return true
    },
  })
  assert.deepEqual(ids(graph.visibleAgents()), ['root', 'child', 'grandchild'])
  drop()
  assert.deepEqual(graph._editRootIds, ['root', 'child'])
  assert.deepEqual(selected, ['root'], 'the original selection array is never mutated')
  assert.deepEqual(graph.windowRootIds, ['root'], 'the normal tree view keeps its own selection')
  assert.ok(snapshots.every(agents => ids(agents).join(',') === 'root,child,grandchild'))
  assert.ok(snapshots.flat().every(agent => !agent.treeScope?.group))
  assert.deepEqual(cleared, [record.id])
  assert.equal(graph._dropRec, null)
})

test('a refused detach restores the exact selection even when the callback refreshes first', t => {
  const selected = ['root']
  const { graph, agents, record, drop, snapshots, cleared } = editingGraph(t, {
    rootIds: selected,
    onDetach({ graph }) { graph.refresh(); return false },
  })
  const before = structuredClone(agents)
  drop()
  assert.equal(graph._editRootIds, selected)
  assert.deepEqual(ids(graph.visibleAgents()), ['root', 'child', 'grandchild'])
  assert.ok(snapshots.every(agents => ids(agents).join(',') === 'root,child,grandchild'))
  assert.deepEqual(agents, before)
  assert.deepEqual(cleared, [])
  assert.equal(record.el.classList.contains('refuse'), true)
  assert.deepEqual([record.x, record.y], [10, 20])
})

test('a thrown detach callback cannot leave a speculative tree selection behind', t => {
  const selected = ['root']
  const { graph, drop } = editingGraph(t, { rootIds: selected,
    onDetach() { throw new Error('Store unavailable') },
  })
  assert.throws(drop, /Store unavailable/)
  assert.equal(graph._editRootIds, selected)
  assert.deepEqual(ids(graph.visibleAgents()), ['root', 'child', 'grandchild'])
})

test('a missing detach callback leaves edit selection and topology unchanged', t => {
  const selected = ['root']
  const { graph, agents, drop } = editingGraph(t, { rootIds: selected })
  const before = structuredClone(agents)
  drop()
  assert.equal(graph._editRootIds, selected)
  assert.deepEqual(agents, before)
})

test('an already selected head dropped on the new-tree "+" is a plain move: no detach, no duplicate tree', t => {
  // A tree head is already its own tree, so that "+" asks for nothing new (owner, 2026-09-10:
  // agents must move freely to the right, "which is where the + are").
  const selected = ['root']
  let detached = 0
  const { graph, agents, record, drop } = editingGraph(t, { rootIds: selected,
    onDetach({ graph }) { detached += 1; graph.refresh(); return true },
  })
  record.id = 'root'; record.agent = agents[0]
  drop()
  assert.equal(detached, 0)
  assert.equal(graph._editRootIds, selected)
  assert.deepEqual(ids(graph.visibleAgents()), ['root', 'child', 'grandchild'])
  assert.deepEqual([graph._positions.root.dx, graph._positions.root.dy], [20, 20], 'the head keeps the spot it was moved to')
})

test('merging selected trees keeps all selected descendants once without adding unrelated agents', t => {
  const selected = ['root', 'other-root']
  const { graph, agents, record, slot, drop, snapshots } = editingGraph(t, {
    rootIds: selected,
    onReparent({ graph, agents, id, parentId }) {
      assert.deepEqual([id, parentId], ['other-root', 'root'])
      agents[3].parentId = parentId
      agents[3].treeNode.treeId = agents[4].treeNode.treeId = 'first'
      graph.refresh()
      return true
    },
  })
  record.id = 'other-root'; record.agent = agents[3]
  slot.kind = 'child'; slot.parentId = 'root'
  drop()
  assert.equal(graph._editRootIds, selected)
  for (const agents of snapshots) assert.deepEqual(ids(agents), ['root', 'child', 'grandchild', 'other-root', 'other-child'])
  assert.equal(new Set(ids(graph.visibleAgents())).size, 5)
})
