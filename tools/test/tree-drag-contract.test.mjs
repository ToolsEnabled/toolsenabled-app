// DID-NOT-BITE-NOW-FIXED
// Mutation: `if (circle < 0) return circle` became
// `if (circle < 0) return Math.abs(circle)` in src/tree-graph.js.
// Mutation landed: yes. Before repair: test exit 0 (green).
// After behavioural assertion: test exit 1 (red). Module restored by sha256.
// THE DRAG CONTRACTS PHASE 1.4 INTRODUCED, PINNED AT THE SOURCE LEVEL.
//
// The graph is DOM-heavy, so its geometry is exercised by the CDP acceptance
// pass on the installed build; what THIS file pins is the source-level shape
// of the rules — the parts that a later edit can silently undo while every
// runtime path still "works" on the happy case.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StaticTreeGraph } from '../../src/tree-graph.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')
const graph = readFileSync(join(SRC, 'tree-graph.js'), 'utf8')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')

test('an override dies with its parent: v2 entries carry parentId and are validated on apply', () => {
  // Written with the parent it was measured under...
  assert.match(graph, /v:\s*2,[\s\S]{0,200}parentId:\s*record\.agent\.parentId/, 'writes no longer record the parent')
  // ...validated against the CURRENT parent at apply time...
  assert.match(graph, /offset\.v === 2 && \(offset\.parentId \?\? null\) !== \(record\.agent\.parentId \?\? null\)/, 'apply no longer checks the recorded parent')
  // ...and v1 blobs are discarded on read.
  assert.match(graph, /value\?\.v !== 2\) continue/, 'v1 position blobs are readable again -- they preserve the exact displacement defect 2 was')
})

test('the drop threshold leaves no dead annulus and nearest wins', () => {
  // The old factor: `< candidate.r + record.r * 0.55` -- smaller than the
  // packed non-overlap distance, which is what made a child-on-parent drop
  // MISS. Matched as the comparison expression, not the bare number, so the
  // explanatory comment in tree-graph.js does not trip this guard (a guard
  // reading its own documentation has bitten this repo four times).
  assert.ok(!/<\s*candidate\.r \+ record\.r \* 0\.55/.test(graph), 'the 0.55 dead-ring threshold is back')
  assert.match(graph, /candidate\.r \+ record\.r \+ DROP_SLOP/, 'the threshold no longer clears the non-overlap distance')
  assert.match(graph, /const DROP_SLOP = 8/, 'DROP_SLOP changed or vanished; re-derive against MIN_AIR before accepting')
  // Nearest, not first-in-insertion-order.
  assert.match(graph, /score < 0 && score < best/, 'drop targeting reverted to first-match insertion order')

  // Drive the hit test: source-shape assertions alone stayed green when the
  // method turned a genuine hit into a positive (therefore refused) score.
  const hit = StaticTreeGraph.prototype._dropHit.call({
    _labelBox: () => ({ left: 100, right: 110, top: 100, bottom: 110 }),
  }, { x: 0, y: 0, r: 10 }, { x: 20, y: 0, r: 10 })
  assert.ok(hit < 0, 'two circles at exact visual contact must be inside the drop threshold')
})

test('draggability is injected, never inferred from a free-text role', () => {
  // The graph must not decide from role text...
  assert.ok(
    !/record\.agent\.role !== 'coordinator'/.test(graph),
    "the graph regained an inline role !== 'coordinator' rule; tree roles are free text, so a node NAMED coordinator goes undraggable again",
  )
  // Exercise the actual injected predicate: a native snapshot is read-only,
  // while writable tree roles remain free text and fleet org roots stay fixed.
  const declaration = view.match(/canDrag:\s*(agent => [^\r\n]+),/)
  assert.ok(declaration, 'the view must inject a draggability predicate')
  for (const authoritativeTreeSnapshot of [false, true]) {
    const canDrag = new Function('authoritativeTreeSnapshot', `return (${declaration[1]})`)(authoritativeTreeSnapshot)
    for (const role of ['worker', 'coordinator', 'custom role']) {
      assert.equal(canDrag({ role, treeNode: {}, orgRoot: true }), !authoritativeTreeSnapshot)
      assert.equal(canDrag({ role, orgRoot: false }), !authoritativeTreeSnapshot)
      assert.equal(canDrag({ role, orgRoot: true }), false)
    }
  }
  assert.match(view, /orgRoot: rolePosture\.get\(node\.role\)\?\.orgRoot === true/, 'fleet draggability no longer comes from the authoritative role posture')
})

test('a refused drop speaks a sentence and a parent-drop stores nothing', () => {
  assert.match(graph, /onDropRefused\('alreadyUnder'/, 'the parent-drop refusal lost its sentence')
  assert.match(graph, /onDropRefused\('wouldCycle'/, 'the cycle refusal lost its sentence')
  // The refuse branch must RETURN before the position write: a refused drop
  // that still stored an override would displace the node afterwards.
  const refuseBranch = graph.slice(graph.indexOf("classList.add('refuse')"))
  const returnAt = refuseBranch.indexOf('return')
  const writeAt = refuseBranch.indexOf('this._positions[record.id] =')
  assert.ok(returnAt !== -1 && (writeAt === -1 || returnAt < writeAt), 'the refuse branch no longer returns before the override write')
})

test('the cycle check reads the same resolver as the layout', () => {
  assert.match(graph, /hierarchyParents\(this\.computer\?\.agents/, '_wouldCycle no longer uses the shared hierarchy resolver; declared-edge cycles slip past it again')
})

test('the corridor constrains nudges and NEVER the layout\'s own position', () => {
  /* Owner amendment (iteration 6): "keep the new version but make it act
     and feel like before". The corridor stays — iteration 5's "top circles
     stay at the top" — but its band must always CONTAIN the record's own
     slot, so an un-nudged node sits exactly where the layout put it. The
     first corridor kept the old canvas-edge floor (r + 64), which
     disagrees with the layout's padTop for big circles and pushed the
     whole top row down AT REST — the regression the owner screenshotted. */
  const graph = graphNow()
  assert.match(graph, /_rankCorridor\(record, result, slot\.y\)/, 'the offset apply no longer clamps into a slot-containing rank corridor')
  assert.match(graph, /_rankCorridor\(focusRecord, this\._layoutResult, targetSlot\.y\)/, 'the focus-animation path lost the slot-containing corridor; the settle jumps or shifts at rest')
  /* THE LIVE DRAG STARTS FROM THE CORRIDOR AND IS WIDENED BY REACH.
   *
   * This used to pin the bare corridor on the pointermove, and that pin was
   * the regression: the corridor is half the pitch to the next row, every
   * empty slot is in a DIFFERENT row from the node you would drag onto it, and
   * contact needs about 77px. So no cross-row drop could register at any
   * realistic window size -- the owner's "you cant drag and drop the nodes
   * onto the new bubbles anymore", all three of his cases at once.
   *
   * The corridor still bounds a NUDGE, which is what stops the snap on
   * release; dragBand() widens it by the reach of the targets on screen, so a
   * release outside the corridor is always either a move or a refusal with a
   * sentence. Both halves are pinned, because either one alone rots. */
  assert.match(graph, /record\.y = clamp\(point\.y \+ offset\.y, \.\.\.this\._dragBand\(record\)\)/, 'the live drag no longer uses the reach-widened band; cross-row drops cannot register')
  assert.match(graph, /corridor: this\._rankCorridor\(record, this\._layoutResult\)/, 'the drag band stopped starting from the rank corridor; nudges will jump on release again')
  assert.match(graph, /slop: DROP_SLOP/, 'the band widens by a number the hit test does not use; the two can now disagree about reach')
  assert.match(graph, /Math\.min\(Math\.max\(canvasLow, rowY - up\), slotY\)/, 'the corridor stopped containing the slot — un-nudged nodes will shift at rest again')
  /* The band is the midline between ranks, full half-pitch each way: the
     label-stack subtraction plus zero floor made tight rows refuse every
     nudge, the snap-back feel the owner rejected. The precise label veto
     below is the overlap check, not this fence. */
  assert.ok(!/TREE_LABEL_STACK \/ 2/.test(graph), 'the corridor re-grew the label-stack subtraction; tight rows will refuse nudges again (the snap-back feel)')
})

test('the override veto sees words at their TRUE width, not only circles', () => {
  const graph = graphNow()
  assert.match(graph, /rectsMeet\(recordBox, otherBox\)/, 'the veto lost its label-vs-label test')
  assert.match(graph, /circleMeetsRect\(/, 'the veto lost its label-vs-circle test')
  // One label geometry for every rule: the hardcoded 7 + 58 is gone and the
  // exported constant is the single source.
  assert.ok(!/7 \+ 58/.test(graph), 'tree-graph.js re-hardcoded the label stack; import TREE_LABEL_STACK instead')
  assert.match(graph, /_labelBox\(record\)/, 'the shared label box vanished')
  /* The box mirrors the CSS width — min(r + 59, labelMax / 2). The first
     version spanned max(r,35)+12, half the truth; a veto measuring half
     the words missed half the collisions. */
  assert.match(graph, /Math\.min\(record\.r \+ 59, \(record\.labelMax \|\| Infinity\) \/ 2\)/, '_labelBox no longer mirrors the CSS label width')
  assert.match(graph, /record\.labelMax = label\?\.maxWidth \|\| null/, 'labelMax is no longer recorded at layout time, so _labelBox measures a stale width')
})

test('a status tick moves nothing: geometry follows structure, not events', () => {
  /* Owner, iteration 7: "the tree action is a mess like the way it moves and
     such". Every reply, usage reading and status change ran the full layout
     — packers plus the vertical fitter, which may rescale every radius —
     and nodes carry no transition on left/top, so each one was an instant
     jump. The reconcile now skips the layout when the shape is unchanged. */
  const graph = graphNow()
  const reconcile = graph.slice(graph.indexOf('_reconcile({'), graph.indexOf('_structureKey() {'))
  assert.match(reconcile, /this\._layoutKey === this\._structureKey\(\)/,
    'the reconcile lays out unconditionally again; a reply will move the tree')
  const key = graph.slice(graph.indexOf('_structureKey() {'), graph.indexOf('_structureKey() {') + 900)
  for (const part of ['this.rootId', 'this.editMode', 'this.W', 'this.H', '_positionsRevision', 'agent.parentId']) {
    assert.ok(key.includes(part), `the structure key stopped reading ${part}; a real shape change would not re-lay out`)
  }
  /* Nothing that only changes what a node SAYS may enter the key, or the
     skip is defeated and we are back to laying out on every tick. */
  for (const forbidden of ['status', 'runtime', 'reply', 'usage']) {
    assert.ok(!key.includes(forbidden), `the structure key reads ${forbidden}; status ticks will re-lay out the tree again`)
  }
  assert.match(graph, /this\._layoutKey = this\._structureKey\(\)/, 'a completed layout no longer stamps its key; the skip check goes stale')
  assert.match(graph.slice(graph.indexOf('_writePositions() {'), graph.indexOf('_writePositions() {') + 300), /_positionsRevision \+= 1/,
    'a saved or cleared nudge no longer bumps the revision, so a drag would not re-lay out')
})

test('a collision revert returns to the layout position verbatim', () => {
  const graph = graphNow()
  /* Anchor past the veto's geometry helpers: the FIRST _clearPosition call
     in the file is the stale-parent branch, which restores nothing. */
  const revert = graph.slice(graph.indexOf('this._clearPosition(record.id)', graph.indexOf('rectsMeet')))
  assert.match(revert.slice(0, 600), /record\.x = record\.slot\.x/, 'the veto revert clamps again instead of restoring the slot — reverted nodes land where the layout never chose')
  assert.match(revert.slice(0, 600), /record\.y = record\.slot\.y/, 'the veto revert clamps y again instead of restoring the slot')
})

function graphNow() {
  return readFileSync(join(SRC, 'tree-graph.js'), 'utf8')
}

/* EDIT MODE MOVES FREELY TO THE RIGHT (owner, 2026-09-10: "i cant move any
   agents in edit mode they cant be moved right which is where the + are").
   Three things stopped it: the canvas edge was a wall, a drop near the node's
   own family "+" was refused as "already under" and snapped back, and the
   layout threw away any nudge that sat on an offered "+". */
const classes = (lit = []) => ({ classList: { add: name => lit.push(name), remove() {} } })
function editDrag({ raw = null, target = null } = {}) {
  const calls = { refused: [], reparent: [], writes: 0 }
  const record = { id: 'w1', agent: { id: 'w1', name: 'Worker', parentId: 'manager' }, x: 560, y: 300, r: 40, slot: { x: 300, y: 300 }, el: classes() }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    W: 1000, nodes: new Map([[record.id, record]]), _positions: {}, _chatTimers: new Set(),
    _dropRec: target, _dropRaw: raw ?? target,
    onReparent: (id, parent) => { calls.reparent.push([id, parent]); return true },
    onDropRefused: (...args) => calls.refused.push(args),
    _writePositions() { calls.writes += 1 }, _renderLinks() {}, _positionRecord() {}, _clearPosition() {}, _layoutNow() {},
  })
  return { graph, record, calls }
}

test('a drop on its own family "+" is a free move, not a refused snap-back', () => {
  const f = editDrag({ raw: { kind: 'child', parentId: 'manager', el: classes() } })
  f.graph._finishEditDrag(f.record, { recordX: 300, recordY: 300 })
  assert.deepEqual([f.calls.refused, f.calls.reparent], [[], []])
  assert.equal(f.record.x, 560, 'the node stays where it was put')
  assert.equal(f.graph._positions.w1.dx, 260)
  assert.equal(f.calls.writes, 1)
})

test('another family "+" still makes it a child there, and a drop on its own parent still refuses with a sentence', () => {
  const other = editDrag({ target: { kind: 'child', parentId: 'controller', el: classes() } })
  other.graph._finishEditDrag(other.record, { recordX: 300, recordY: 300 })
  assert.deepEqual(other.calls.reparent, [['w1', 'controller']])
  const parent = { id: 'manager', agent: { id: 'manager', name: 'Manager', parentId: null }, el: classes() }
  const same = editDrag({ raw: parent })
  same.graph.nodes.set('manager', parent)
  same.graph._finishEditDrag(same.record, { recordX: 300, recordY: 300 })
  assert.equal(same.calls.refused[0]?.[0], 'alreadyUnder')
  assert.equal(same.record.x, 300, 'a refused drop still returns the node')
})

test('its own family "+" and, for a tree head, the new-tree "+" never light up as drop targets', () => {
  const lit = []
  const worker = { id: 'w1', agent: { id: 'w1', parentId: 'manager' }, el: { hidden: false } }
  const own = { kind: 'child', parentId: 'manager', hidden: false, el: classes(lit) }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    nodes: new Map([['w1', worker]]), emptySlots: new Map([['own', own]]), _culled: new Set(),
    computer: { agents: [worker.agent, { id: 'manager', parentId: null }] }, declaredEdges: [], _dropHit: () => -1,
  })
  graph._updateDropTarget(worker)
  assert.deepEqual([graph._dropRec, graph._dropRaw, lit], [null, own, []])
  const head = { id: 'root', agent: { id: 'root', parentId: null }, el: { hidden: false } }
  const newTree = { kind: 'new-tree', parentId: null, hidden: false, el: classes(lit) }
  Object.assign(graph, { nodes: new Map([['root', head]]), emptySlots: new Map([['new', newTree]]), computer: { agents: [head.agent] } })
  graph._updateDropTarget(head)
  assert.deepEqual([graph._dropRec, lit], [null, []])
  Object.assign(graph, { nodes: new Map([['w1', worker]]), computer: { agents: [worker.agent, { id: 'manager', parentId: null }] } })
  graph._updateDropTarget(worker)
  assert.equal(graph._dropRec, newTree, 'a branch can still be dragged out to its own tree')
  assert.deepEqual(lit, ['drop-ok'])
})

test('an agent can be moved a canvas width past the edge, and an offered "+" under it gives way', () => {
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { W: 1000 })
  assert.equal(graph._rightReach({ r: 40 }, 700), 1948)
  assert.equal(graph._rightReach({ r: 40 }, 2100), 2100, 'a slot beyond the reach is never pulled in')
  const source = graphNow()
  assert.equal((source.match(/this\._rightReach\((?:record|focusRecord), (?:slotX|slot\.x|targetSlot\.x)\)/g) || []).length, 3,
    'the live drag, the layout re-application and the focus animation share one right reach')
  assert.ok(!/this\.W - (?:record|focusRecord)\.r - 12/.test(source), 'the canvas-edge wall came back')
  assert.match(source, /covered\.add\(plan\.id\)/, 'a nudge on an offered "+" is discarded again')
  assert.match(source, /_syncEmptySlots\(covered\.size \? plans\.filter\(plan => !covered\.has\(plan\.id\)\) : plans, result\)/)
})
