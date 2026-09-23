import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { StaticTreeGraph } from '../../src/tree-graph.js'

/* THE EXAMPLE SAYS IT IS NOT YOURS TO REARRANGE, AND EVERY DOOR AGREES.
 *
 * Measured on both press-throughs (desktop and phone, 2026-08-27): the Edit
 * button refused with "This is the example fleet — nothing in it is yours to
 * rearrange." while the Details tab's Reports-to → Save re-parented that same
 * example tree, announced "Saved. Default 1 now reports to Manager.", removed
 * the "say hey" chip from the switcher, and offered no way back short of a
 * reload. One policy, three doors:
 *
 *   the drag        locked by mountGraph's null onReparent under mock
 *                   (tree-graph.js refuses any drop with no callback)
 *   the Edit button disabled by syncEditAvailability with the sentence
 *   Reports-to Save the gate these tests pin — it must refuse under mock with
 *                   the SAME sentence, before it reads the picker at all
 *
 * The sentence itself is asserted by value through the view's export; the
 * wiring is pinned against the source in the idiom of
 * computers-account-door.test.mjs, because the rule under test is which gate
 * runs first inside a DOM module the size of a small program. */

/* computers.js imports stylesheets; node has no CSS module format. Same empty
   stand-in loader computers.test.mjs registers. */
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)

const { EXAMPLE_REARRANGE_TEXT } = await import('../../src/views/computers.js')
const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

test('the refusal is one exported sentence, and it is the Edit button’s own', () => {
  assert.equal(
    EXAMPLE_REARRANGE_TEXT,
    'This is the example fleet — nothing in it is yours to rearrange.',
    'the example-rearrange sentence changed; the Edit disable, the Save gate and this suite must all change together',
  )
  /* The Edit disable reads the constant, never a second spelling. */
  const sync = VIEW.slice(VIEW.indexOf('function syncEditAvailability'), VIEW.indexOf('function handleReparent'))
  assert.match(sync, /mockSource\(\)\s*\?\s*EXAMPLE_REARRANGE_TEXT/,
    'syncEditAvailability no longer refuses the example with the shared sentence')
})

test('the Reports-to Save refuses under mock, before it reads the picker', () => {
  const save = VIEW.slice(
    VIEW.indexOf("moveSave.addEventListener('click'"),
    VIEW.indexOf('showTreeNodeControls(treeStore.getNode(node.id))'),
  )
  assert.ok(save.length > 0, 'the moveSave click handler is gone from src/views/computers.js')
  const gate = save.indexOf('if (mockSource())')
  const refusal = save.indexOf('moveOut.textContent = EXAMPLE_REARRANGE_TEXT')
  const pick = save.indexOf('moveSelect.value')
  const write = save.indexOf('treeStore.moveNode(node.id, parentId)')
  assert.ok(gate !== -1, 'the Save path no longer asks whether this is the example')
  assert.ok(refusal !== -1, 'the Save refusal no longer states the example sentence')
  assert.ok(pick !== -1 && write !== -1, 'the Save handler’s real path went missing — the gate must not have deleted the feature')
  assert.ok(gate < pick,
    'the mock gate runs after the picker is read — a person on the example is told to pick a parent for a move that can only refuse')
  assert.ok(gate < write, 'the store write is reachable before the mock gate')
})

test('the drag stays locked by the same truth: onReparent is null under mock', () => {
  // 2443f5d0 also refuses renderer-side reparenting of the authoritative tree.
  assert.match(VIEW, /onReparent:\s*!mockSource\(\)\s*&&\s*!authoritativeTreeSnapshot\s*&&\s*orgReady\(\)\s*\?\s*handleReparent\s*:\s*null/,
    'mountGraph no longer nulls onReparent for the example — the drag becomes a fourth door with its own policy')
})

test('a drop with no applier states a refusal instead of wiggling in silence', () => {
  /* THE THIRD DOOR, and the one that said nothing at all. On the example
     board onReparent is null by design, so every legal-looking drag hit the
     graph's refusal path, matched none of its three SHAPE rules (cycle,
     non-draggable root, already-under) and fell through to the wiggle alone —
     "no movement, no refusal" (desktop press-through, 2026-08-27), with the
     rule stated only in a hover title a dragging person never sees.
     Driven through the real method over the minimum context it touches: a
     source pin would pass on both sides of this, because the wiggle, the
     revert and the three shape rules are all still there. */
  const refusals = []
  const record = {
    id: 'child',
    agent: { id: 'child', name: 'Default 2', parentId: 'root', treeNode: {} },
    el: { classList: { add() {}, remove() {} }, dataset: {}, style: {} },
    x: 0, y: 0, r: 30, slot: { x: 0, y: 0 },
  }
  const target = {
    id: 'other',
    agent: { id: 'other', name: 'Manager', parentId: null },
    el: { classList: { add() {}, remove() {} }, dataset: {}, style: {} },
    r: 30, x: 200, y: 0,
  }
  /* The drop target travels on the instance, the way a real drag leaves it. */
  const contextFor = (overrides) => ({
    onReparent: null,            // the example board's own wiring
    onDetachToNewTree: null,
    canDrag: () => true,
    nodes: new Map([['other', target]]),
    _dropRec: target,
    _dropRaw: target,
    _chatTimers: new Set(),
    _positions: {},
    _positionsRevision: 0,
    _wouldCycle: () => false,
    _clearPosition() {},
    _layoutNow() {},
    _positionRecord() {},
    _renderLinks() {},
    ...overrides,
  })

  StaticTreeGraph.prototype._finishEditDrag.call(
    contextFor({ onDropRefused: (rule, detail) => refusals.push({ rule, detail }) }),
    record,
    { recordX: 0, recordY: 0 },
  )
  assert.equal(refusals.length, 1, 'a drop nobody can apply is still silent; the bubble wiggles and says nothing')
  assert.equal(refusals[0].rule, 'noApplier',
    'the no-applier refusal is reported under another rule, so the view answers with the wrong sentence')
  assert.equal(refusals[0].detail.name, 'Default 2', 'the refusal no longer names the agent that was dragged')

  /* And with an applier present, the shape rules still own the message —
     this must not become a blanket refusal that swallows the real ones. */
  const withApplier = []
  StaticTreeGraph.prototype._finishEditDrag.call(
    contextFor({ onReparent: () => false, onDropRefused: (rule) => withApplier.push(rule) }),
    record,
    { recordX: 0, recordY: 0 },
  )
  assert.ok(!withApplier.includes('noApplier'),
    'a board WITH a reparent callback now reports no-applier; the real shape refusals would be replaced by it')
})
