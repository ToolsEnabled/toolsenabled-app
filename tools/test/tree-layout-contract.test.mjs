// THE CONTRACTS PHASE 1.3 INTRODUCED, PINNED.
//
// Four claims became true when defect 1a's root cause was fixed, and each is
// the kind that silently rots: a constant edited in one place, a rung added to
// a ladder, a "should converge" that stops converging. Every test here reads
// the real modules; nothing is mocked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { layoutTree, TREE_LABEL_STACK } from '../../src/tree-layout.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')

test('tree nodes carry NO explicit tierRank -- a four-level tree gets four ranks', () => {
  // The exact shape defect 1a shipped with: root -> child -> grandchild ->
  // great-grandchild. Under `tierRank: parentId ? 2 : 0` this drew as TWO
  // rows; the fix walks parentId chains.
  const lineage = [
    { id: 'root', name: 'Coordinator', role: 'coordinator' },
    { id: 'child', name: 'Manager', role: 'manager', parentId: 'root' },
    { id: 'grand', name: 'Worker', role: 'default', parentId: 'child' },
    { id: 'great', name: 'Helper', role: 'default', parentId: 'grand' },
  ]
  const result = layoutTree({ nodes: lineage, W: 900, H: 760 })
  const ys = new Set([...result.slots.values()].map(slot => slot.y))
  assert.equal(ys.size, 4, `a 4-deep lineage must occupy 4 distinct rank rows, got ${ys.size}`)
  // And no hierarchy link may connect two nodes within one rank.
  for (const [child, parent] of result.parents) {
    assert.notEqual(
      result.slots.get(child)?.y,
      result.slots.get(parent)?.y,
      `${parent} -> ${child} runs within one rank; the connector would be a flat diagonal`,
    )
  }
  // The view really does send null: the record builder in views/computers.js
  // must not reintroduce a computed tierRank for tree nodes.
  const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
  assert.ok(!/tierRank:\s*node\.parentId/.test(view), 'views/computers.js reintroduced a parentId-derived tierRank for tree nodes')
})

test('the packing ladder never sanctions overlap', async () => {
  const source = readFileSync(join(SRC, 'tree-layout.js'), 'utf8')
  const ladder = source.match(/const PACKING_LADDER = Object\.freeze\(\[[\s\S]*?\]\)/)?.[0]
  assert.ok(ladder, 'PACKING_LADDER not found')
  const airs = [...ladder.matchAll(/\[\s*\d+\s*,\s*(-?\w+)\s*\]/g)].map(match => match[1])
  assert.ok(airs.length >= 2, 'ladder should have rungs')
  for (const air of airs) {
    assert.ok(!air.startsWith('-'), `ladder rung with negative air: ${air} -- that is overlap by sanction`)
  }
})

test('label budgets are per-neighbour, not the rank minimum', () => {
  // One tight pair (long-named siblings under one parent) next to a record
  // with open space: the spaced record's budget must exceed the tight pair's.
  const nodes = [
    { id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 },
    { id: 'a', name: 'Left crowded worker seat', role: 'default', parentId: 'root', bornAt: 1 },
    { id: 'b', name: 'Right crowded worker seat', role: 'default', parentId: 'root', bornAt: 1 },
    // A second family far to the side: its sole child has a whole flank free.
    { id: 'root2', name: 'Second Coordinator', role: 'coordinator', bornAt: 1 },
    { id: 'solo', name: 'Solo worker with room', role: 'default', parentId: 'root2', bornAt: 1 },
  ]
  const result = layoutTree({ nodes, W: 1100, H: 700 })
  const budgetOf = (id) => result.labels.get(id).maxWidth
  if (budgetOf('a') != null && budgetOf('solo') != null) {
    assert.ok(
      budgetOf('solo') >= budgetOf('a'),
      `the record with open space (${budgetOf('solo')}) must not inherit the tight pair's budget (${budgetOf('a')})`,
    )
  }
  // And every named, laid-out record keeps at least the readable floor.
  for (const [id, label] of result.labels) {
    if (label.maxWidth != null) assert.ok(label.maxWidth >= 70, `${id} label budget ${label.maxWidth} under the 70px readable floor`)
  }
})

test('minHeight is a fixed point: re-laying at the asked height fits', () => {
  // Five tiers into 300px cannot fit even at the 34px radius floor, so the
  // layout must ask for height -- and the ask must be SUFFICIENT, because the
  // wrap grows exactly once on the strength of it.
  const deep = ['root']
  const nodes = [{ id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 }]
  for (let index = 1; index < 5; index += 1) {
    nodes.push({ id: `n${index}`, name: `Tier ${index} agent`, role: 'default', parentId: index === 1 ? 'root' : `n${index - 1}`, bornAt: 1 })
    deep.push(`n${index}`)
  }
  const cramped = layoutTree({ nodes, W: 900, H: 300 })
  assert.ok(Number.isFinite(cramped.minHeight), 'a tree the floor cannot save must ask for height')
  assert.ok(cramped.minHeight > 300)

  const grown = layoutTree({ nodes, W: 900, H: cramped.minHeight })
  assert.equal(grown.minHeight, null, `laying out at the asked height (${cramped.minHeight}) must fit -- the ask was insufficient`)
  // No adjacent pair of tiers may overlap at the granted height.
  const rows = grown.rowYs
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const upper = [...grown.slots.entries()].filter(([, slot]) => slot.y === rows[index])
    const lower = [...grown.slots.entries()].filter(([, slot]) => slot.y === rows[index + 1])
    const tallestUpper = Math.max(...upper.map(([id]) => grown.radii.get(id)))
    const tallestLower = Math.max(...lower.map(([id]) => grown.radii.get(id)))
    assert.ok(
      rows[index + 1] - rows[index] >= tallestUpper + tallestLower,
      `tiers ${index} and ${index + 1} overlap at the granted height`,
    )
  }
})

test('the label stack constant and the stylesheet agree', () => {
  const css = readFileSync(join(SRC, 'tree-graph.css'), 'utf8')
  const declared = css.match(/--tree-label-stack:\s*(\d+)px/)?.[1]
  assert.ok(declared, 'tree-graph.css no longer declares --tree-label-stack')
  assert.equal(
    Number(declared),
    TREE_LABEL_STACK,
    `tree-graph.css says ${declared}px but tree-layout.js reserves ${TREE_LABEL_STACK}px -- the sheet and the layout have drifted`,
  )
  // The role row must stay clamped to ONE line: the constant's worst case is
  // computed from one role line, and a two-line role overflows the reserve.
  assert.match(css, /\.node-role\s*{[^}]*-webkit-line-clamp:\s*1/s, 'the role row is no longer one-line; TREE_LABEL_STACK is now a lie')
})

test('two trees separate: their roots get the between-family gap, not shoulder packing', () => {
  // Two 2-node trees. Before treeId grouping, all parentless records keyed
  // '~orphan' and packed as ONE tight family nobody drew.
  const nodes = [
    { id: 'a-root', name: 'First Coordinator', role: 'coordinator', treeId: 'tree-a', bornAt: 1 },
    { id: 'a-kid', name: 'First worker', role: 'default', parentId: 'a-root', treeId: 'tree-a', bornAt: 1 },
    { id: 'b-root', name: 'Second Coordinator', role: 'coordinator', treeId: 'tree-b', bornAt: 1 },
    { id: 'b-kid', name: 'Second worker', role: 'default', parentId: 'b-root', treeId: 'tree-b', bornAt: 1 },
  ]
  const result = layoutTree({ nodes, W: 1200, H: 700 })
  const gapBetweenRoots = Math.abs(result.slots.get('b-root').x - result.slots.get('a-root').x)
  // Same shape WITHOUT treeIds: the old single-cluster packing, as control.
  const merged = layoutTree({ nodes: nodes.map(({ treeId, ...rest }) => rest), W: 1200, H: 700 })
  const mergedGap = Math.abs(merged.slots.get('b-root').x - merged.slots.get('a-root').x)
  assert.ok(
    gapBetweenRoots > mergedGap,
    `tree-separated roots (${gapBetweenRoots}px apart) must stand wider than the orphan-cluster control (${mergedGap}px)`,
  )
})

/* P-O3: THE WIDE GAP IS BETWEEN TREES, NOT BETWEEN FAMILIES INSIDE ONE TREE.
   One root, two managers, two workers each, on a 1200px canvas. Before the
   subtree pass the worker rank was packed per family with BETWEEN (238px at
   air 68) between the two families, so cousins stood 316px apart while
   siblings stood 146 — and each manager was NOT over its own pair. Now the
   cousin gap equals the sibling gap (78 + 68 = 146) and the between-family
   gap is spent only where a second tree begins. */
test('BETWEEN separates trees, not families inside one tree', () => {
  const nodes = [
    { id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 },
    { id: 'm1', name: 'Manager One', role: 'default', parentId: 'root', bornAt: 1 },
    { id: 'm2', name: 'Manager Two', role: 'default', parentId: 'root', bornAt: 1 },
    { id: 'w1a', name: 'Worker 1a', role: 'default', parentId: 'm1', bornAt: 1 },
    { id: 'w1b', name: 'Worker 1b', role: 'default', parentId: 'm1', bornAt: 1 },
    { id: 'w2a', name: 'Worker 2a', role: 'default', parentId: 'm2', bornAt: 1 },
    { id: 'w2b', name: 'Worker 2b', role: 'default', parentId: 'm2', bornAt: 1 },
  ]
  const result = layoutTree({ nodes, W: 1200, H: 700 })
  const x = (id) => result.slots.get(id).x
  const sibling = x('w1b') - x('w1a')
  const cousin = x('w2a') - x('w1b')
  assert.equal(cousin, sibling, `cousins ${cousin}px apart, siblings ${sibling}px: the between-tree gap was spent inside one tree`)
  const siblingClearance = result.radii.get('w1a') + result.radii.get('w1b')
  assert.ok(
    sibling >= siblingClearance,
    `siblings overlap: their centres are ${sibling}px apart but their radii require at least ${siblingClearance}px`,
  )
  // Each manager stands over the middle of its own pair; the root over both.
  assert.ok(Math.abs((x('w1a') + x('w1b')) / 2 - x('m1')) < 1)
  assert.ok(Math.abs((x('w2a') + x('w2b')) / 2 - x('m2')) < 1)
  assert.ok(Math.abs((x('m1') + x('m2')) / 2 - x('root')) < 1)
})

/* THE SEAM THAT PIN DOCUMENTED, NOW CLOSED. The pin that stood here asserted
   the defect: layoutTree read a root's tree from node.treeId,
   node.agent.treeId or node.agent.treeNode.treeId only, while the live page
   hands each record its treeNode at TOP level (treeAgentRecord in
   src/views/computers.js; src/tree-graph.js passes the records bare). Every
   root therefore keyed '~orphan', the packer saw one family, and unrelated
   trees stood at the within-family pitch. Retiring that pin was the deliberate
   flip it asked for; this test is the same shape asserted the right way round.
   It fails against the old read — with everything '~orphan' the two halves
   below measure identically — so it cannot pass by accident. */
test('a top-level treeNode.treeId separates two trees; one shared id does not', () => {
  const twoTrees = [
    { id: 'a-root', name: 'First Coordinator', role: 'coordinator', treeNode: { treeId: 'tree-a' }, bornAt: 1 },
    { id: 'a-kid', name: 'First worker', role: 'default', parentId: 'a-root', treeNode: { treeId: 'tree-a' }, bornAt: 1 },
    { id: 'b-root', name: 'Second Coordinator', role: 'coordinator', treeNode: { treeId: 'tree-b' }, bornAt: 1 },
    { id: 'b-kid', name: 'Second worker', role: 'default', parentId: 'b-root', treeNode: { treeId: 'tree-b' }, bornAt: 1 },
  ]
  // The SAME four records, one tree id on all of them: two roots of one
  // organisation, which have nothing between them to separate.
  const oneTree = twoTrees.map(node => ({ ...node, treeNode: { treeId: 'tree-a' } }))
  const rootGap = (nodes) => {
    const result = layoutTree({ nodes, W: 1200, H: 700 })
    return Math.abs(result.slots.get('b-root').x - result.slots.get('a-root').x)
  }
  const separated = rootGap(twoTrees)
  const shared = rootGap(oneTree)
  assert.ok(
    separated > shared,
    `two treeIds put the roots ${separated}px apart and one shared id ${shared}px: the top-level treeNode.treeId is not reaching the packer`,
  )
  /* BOTH SHAPES, not one guess swapped for another: the same four records
     under the `agent` wrapper the rest of tree-layout.js tolerates must
     measure exactly the same, or the read has only moved which caller it
     fails for. The WHOLE record goes under .agent because that is what a
     wrapper is — treeNodeRadius takes `node.agent ?? node` as its one source,
     so a half-filled wrapper would lose bornAt, shrink both roots to the
     silent radius, and change this gap for a reason that has nothing to do
     with tree ids. */
  const nested = twoTrees.map(node => ({ agent: node }))
  assert.equal(rootGap(nested), separated, 'agent.treeNode.treeId no longer measures the same as a top-level treeNode.treeId')
})

test('the subtree ladder spreads PACKING_LADDER instead of copying its rungs', () => {
  const source = readFileSync(join(SRC, 'tree-layout.js'), 'utf8')
  assert.match(source, /\.\.\.PACKING_LADDER/, 'SUBTREE_LADDER no longer spreads PACKING_LADDER; the two ladders can now drift apart')
})

test('zoom has separate entry and exit thresholds around the fitted view', () => {
  const graph = readFileSync(join(SRC, 'tree-graph.js'), 'utf8')
  const at = graph.match(/const ZOOM_DRILL_AT = ([\d.]+)/)?.[1]
  const out = graph.match(/const ZOOM_DRILL_OUT_AT = ([\d.]+)/)?.[1]
  assert.ok(at && out, 'the drill thresholds vanished')
  assert.ok(Number(out) < Number(at), 'drill-out must sit BELOW drill-in, or the boundary oscillates on every wheel notch')
  // Fitted branch views are near 1x. Entry and exit must remain distinct;
  // actual pointer capture and multi-level return are exercised in the browser.
  assert.ok(1 < Number(at), `zoom 1 must sit below the drill-in threshold (${at})`)
  assert.ok(Number(out) < 1, `zoom 1 must sit above the drill-out threshold (${out})`)
})
