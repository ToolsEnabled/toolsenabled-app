import test from 'node:test'
import assert from 'node:assert/strict'
import { labelFor, layoutTree } from '../../src/tree-layout.js'

const nodes = [
  { id: 'root', name: 'Coordinator', role: 'coordinator' },
  { id: 'manager-a', name: 'Manager A', role: 'manager', parentId: 'root' },
  { id: 'manager-b', name: 'Manager B', role: 'manager', parentId: 'root' },
  { id: 'worker-a', name: 'Worker A', role: 'default', parentId: 'manager-a' },
]

test('layoutTree is deterministic and layered by hierarchy depth', () => {
  const first = layoutTree({ nodes, W: 900, H: 600 })
  const second = layoutTree({ nodes, W: 900, H: 600 })
  assert.deepEqual([...first.slots], [...second.slots])
  assert.equal(first.slots.get('root').x, 450)
  assert.ok(first.slots.get('root').y < first.slots.get('manager-a').y)
  assert.equal(first.slots.get('manager-a').y, first.slots.get('manager-b').y)
  assert.ok(first.slots.get('manager-a').y < first.slots.get('worker-a').y)
  assert.equal(first.drillRequired, false)
})

test('explicit tier ranks win over parent depth', () => {
  const ranked = nodes.map((node, index) => ({ ...node, tierRank: index === 0 ? 0 : 2 }))
  const result = layoutTree({ nodes: ranked, W: 900, H: 600 })
  assert.equal(result.slots.get('manager-a').y, result.slots.get('worker-a').y)
})

test('over-capacity tiers remain readable, request drill, and cull by priority', () => {
  const crowded = [{ id: 'root', name: 'Coordinator', role: 'coordinator' }]
  for (let index = 0; index < 18; index += 1) {
    crowded.push({
      id: `worker-release-seat-${index}`,
      name: `Long worker name release seat ${index}`,
      role: 'spawned',
      parentId: 'root',
      cullable: true,
      cullRank: index,
    })
  }
  const result = layoutTree({ nodes: crowded, W: 640, H: 420 })
  assert.equal(result.drillRequired, true)
  assert.ok(result.culled.size > 0)
  /* PINNING THE TWO ENDPOINTS WAS NOT PINNING THE RULE. "seat 0 survives" and
     "seat 17 is culled" both stayed TRUE after the numeric cullRank comparator
     was deleted -- measured, by deleting it: what came back was visible ranks
     0,1,10-15 against culled 2-9,16,17, which keeps both endpoints and honours
     no ordering at all. Two true facts about a broken result.
     The property is that culling follows the RANK: everything kept must outrank
     everything dropped. That is what fails when the comparator goes. */
  const rankOf = id => Number(String(id).replace('worker-release-seat-', ''))
  const visibleRanks = [...result.slots.keys()].filter(id => id.startsWith('worker-release-seat-')).map(rankOf)
  const culledRanks = [...result.culled].map(rankOf)
  assert.ok(visibleRanks.length > 0 && culledRanks.length > 0, 'this case no longer exercises culling at all')
  assert.ok(Math.max(...visibleRanks) < Math.min(...culledRanks),
    `culling ignored the rank order: kept ${visibleRanks.sort((a, b) => a - b).join(',')} `
    + `while dropping ${culledRanks.sort((a, b) => a - b).join(',')}`)
  assert.ok(result.labels.get('worker-release-seat-0').maxWidth >= 70)
})

test('declared hierarchy edges are consumed without accepting a cycle', () => {
  const flat = [
    { id: 'a', name: 'A', role: 'coordinator' },
    { id: 'b', name: 'B', role: 'manager' },
    { id: 'c', name: 'C', role: 'default' },
  ]
  const result = layoutTree({
    nodes: flat,
    edges: [
      { from: 'a', to: 'b', type: 'manages' },
      { from: 'b', to: 'c', type: 'delegates_to' },
      { from: 'c', to: 'a', type: 'manages' },
    ],
    W: 800,
    H: 500,
  })
  assert.equal(result.slots.size, 3)
  /* "THREE NODES ON AT LEAST TWO ROWS" IS TRUE OF THE WRONG ANSWER TOO.
     Measured by deleting delegates_to support: the layout then read the cycle
     the other way round and produced c -> a -> b, which is still three nodes on
     more than one row -- so this test stayed green while the hierarchy it exists
     to check was inverted.
     What must hold is WHICH edges were accepted: manages a->b and delegates_to
     b->c are honoured, and the closing c->a is refused because taking it would
     make a cycle. Pin the parentage, not the shape. */
  assert.deepEqual(Object.fromEntries(result.parents), { b: 'a', c: 'b' },
    'the declared hierarchy was not the one accepted; a cycle-closing edge may have been taken')
})

/* The three properties the vertical fitter and the grouped packer are FOR.
   Written as unit tests rather than screenshots because the interesting
   inputs here are the degenerate ones — no nodes, one node, no room — and a
   screenshot is worst at exactly those. */

test('a rank under one parent is packed under it, not smeared across the canvas', () => {
  const family = [
    { id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 },
    ...['a', 'b', 'c', 'd'].map(key => ({
      id: `manager-${key}`, name: `Manager ${key.toUpperCase()}`, role: 'manager', parentId: 'root', bornAt: 1,
    })),
    // Two of the managers own a worker: the subtree pass must keep every
    // property above AND put each worker straight under its own manager.
    { id: 'worker-a', name: 'Worker A', role: 'default', parentId: 'manager-a', bornAt: 1 },
    { id: 'worker-b', name: 'Worker B', role: 'default', parentId: 'manager-b', bornAt: 1 },
  ]
  const narrow = layoutTree({ nodes: family, W: 840, H: 700 })
  const wide = layoutTree({ nodes: family, W: 1260, H: 700 })
  const pitchOf = (result) =>
    result.slots.get('manager-b').x - result.slots.get('manager-a').x
  // The rank keeps ONE spacing as the canvas grows: a wider window buys the
  // tree room around itself, never a rank stretched to the window's width.
  assert.equal(pitchOf(wide), pitchOf(narrow))
  const span = wide.slots.get('manager-d').x - wide.slots.get('manager-a').x
  assert.ok(span < 1260 / 2, `rank span ${span} should stay a family, not fill the canvas`)
  // ...and it stays centred on its own parent.
  const mid = (wide.slots.get('manager-a').x + wide.slots.get('manager-d').x) / 2
  assert.ok(Math.abs(mid - wide.slots.get('root').x) < 2, `${mid} vs ${wide.slots.get('root').x}`)
  // A worker sits directly under its manager at either width, so the
  // connector is a vertical line. The per-rank cursor put worker-b 154px
  // right of manager-b at W=840 (493 vs 339): the two single-child families
  // were separated by the between-family gap instead of sharing the root's.
  for (const result of [narrow, wide]) {
    for (const key of ['a', 'b']) {
      const dx = Math.abs(result.slots.get(`worker-${key}`).x - result.slots.get(`manager-${key}`).x)
      assert.ok(dx < 1.5, `worker-${key} sits ${dx}px off its manager; the drop should be vertical`)
    }
  }
})

/* THE OWNER'S SCREENSHOT, AS ARITHMETIC (P-O3). Three roots A/B/C (r39,
   78px claim), D2 under A, one child slot under each root (r34 unnamed, 68px
   claim), and the new-tree slot S. Canvas ≈ 900px. The per-rank packer put
   the child row at 89/230/536/842 under a root row at 236/382/528: B's slot
   154px right of B, C's 314px right of C, on elbows that should have been
   straight drops. With the subtree pass, air 68 fits (forest 642 ≤ 852):
   row0 A 238.5 / B 450 / C 596 / S 737; row1 D2 168 / sA 309 / sB 450 /
   sC 596. */
const screenshotSlot = (id, parentId) => ({
  id, name: '', role: 'default', parentId, r: 34, cullable: true, cullRank: 9000, orderHint: 1,
})
const screenshot = [
  { id: 'A', name: 'Agent A', role: 'default', bornAt: 1 },
  { id: 'B', name: 'Agent B', role: 'default', bornAt: 1 },
  { id: 'C', name: 'Agent C', role: 'default', bornAt: 1 },
  { id: 'D2', name: 'Agent D2', role: 'default', parentId: 'A', bornAt: 1 },
  screenshotSlot('empty-A', 'A'),
  screenshotSlot('empty-B', 'B'),
  screenshotSlot('empty-C', 'C'),
  screenshotSlot('new-tree'),
]
const xOf = (result, id) => result.slots.get(id).x

test('parents make room for their subtrees; children sit straight under them', () => {
  const result = layoutTree({ nodes: screenshot, W: 900, H: 700 })
  const x = (id) => xOf(result, id)
  assert.equal(result.culled.size, 0)
  assert.equal(result.drillRequired, false)
  // Single children hang straight down from their parent.
  assert.ok(Math.abs(x('empty-B') - x('B')) < 0.5, `B's slot ${x('empty-B')} vs B ${x('B')}`)
  assert.ok(Math.abs(x('empty-C') - x('C')) < 0.5, `C's slot ${x('empty-C')} vs C ${x('C')}`)
  // A is centred over its two children, and the agent comes before the slot.
  assert.ok(Math.abs((x('D2') + x('empty-A')) / 2 - x('A')) < 1, `A ${x('A')} is not over the D2/slot midpoint`)
  assert.ok(x('D2') < x('empty-A'))
  // A's family takes more room than a bare root, so B stands further off.
  assert.ok(x('B') - x('A') > 146, `B - A = ${x('B') - x('A')}; A made no room for its subtree`)
  // The new-tree slot trails the roots.
  assert.ok(x('new-tree') > x('C'))
  // The worked example's numbers, to the half pixel.
  const expected = { A: 238.5, B: 450, C: 596, 'new-tree': 737, D2: 168, 'empty-A': 309, 'empty-B': 450, 'empty-C': 596 }
  for (const [id, want] of Object.entries(expected)) {
    assert.ok(Math.abs(x(id) - want) <= 0.5, `${id} at ${x(id)}, expected ${want}`)
  }
  // No overlap within a row, and everything inside the canvas.
  for (const row of result.rowYs) {
    const inRow = [...result.slots].filter(([, slot]) => slot.y === row).sort((l, r) => l[1].x - r[1].x)
    for (let index = 1; index < inRow.length; index += 1) {
      const [leftId, left] = inRow[index - 1]
      const [rightId, right] = inRow[index]
      assert.ok(right.x - left.x >= result.radii.get(leftId) + result.radii.get(rightId), `${leftId} and ${rightId} overlap`)
    }
    for (const [id, slot] of inRow) {
      assert.ok(slot.x - result.radii.get(id) >= 0 && slot.x + result.radii.get(id) <= 900, `${id} outside the canvas`)
    }
  }
})

test('a narrow canvas shrinks the air before it gives up the under-parent placement', () => {
  // 520px: the forest fits at air 25; children are still straight under
  // their parents and nothing is culled.
  const narrow = layoutTree({ nodes: screenshot, W: 520, H: 700 })
  assert.equal(narrow.culled.size, 0)
  assert.ok(Math.abs(xOf(narrow, 'empty-B') - xOf(narrow, 'B')) < 0.5)
  assert.ok(Math.abs(xOf(narrow, 'empty-C') - xOf(narrow, 'C')) < 0.5)
  assert.ok(Math.abs((xOf(narrow, 'D2') + xOf(narrow, 'empty-A')) / 2 - xOf(narrow, 'A')) < 1)
  // 400px: no rung fits the forest, so the per-rank geometry stands. The
  // numbers pinned here were read off the packer BEFORE the subtree pass
  // existed; neither path culls anything at this width.
  const tight = layoutTree({ nodes: screenshot, W: 400, H: 700 })
  assert.equal(tight.culled.size, 0)
  assert.equal(tight.drillRequired, false)
  const fallback = { A: 73, B: 161, C: 249, 'new-tree': 332, D2: 83, 'empty-A': 160, 'empty-B': 240, 'empty-C': 320 }
  for (const [id, want] of Object.entries(fallback)) {
    assert.equal(xOf(tight, id), want, `${id}: the 400px fallback drifted from the per-rank geometry`)
  }
  /* THE WHOLE SUITE WAS GREEN AGAINST A DELETED TIE-BREAK, and that is the
     finding this line exists for. Removing the id tie-break from the packer
     changed nothing anywhere, because every fixture in this file -- including
     the one above -- is already written in canonical order. So the numbers
     above pinned the geometry perfectly and pinned the ORDERING not at all:
     they would hold just as well for a packer that depended on whatever order
     the caller happened to enumerate in.
     Feeding the same nodes reversed is the cheapest way to say "position comes
     from the node, not from its place in the argument". With the tie-break
     deleted this fails with A and C swapped and their children with them. */
  const reordered = layoutTree({ nodes: [...screenshot].reverse(), W: 400, H: 700 })
  const xsById = laid => Object.fromEntries([...laid.slots].map(([id, slot]) => [id, slot.x]))
  assert.deepEqual(xsById(reordered), xsById(tight),
    'the fallback geometry depends on the order the caller listed the nodes in')
})

test('the subtree pass is deterministic, honours orderHint, and keeps strays on their rank', () => {
  const forest = [
    { id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 },
    // Ids chosen so id order alone would put the slot FIRST; orderHint 1 must
    // still put it last in its family.
    { id: 'zeta', name: 'Zeta', role: 'default', parentId: 'root', bornAt: 1 },
    { id: 'alpha-slot', name: '', role: 'default', parentId: 'root', r: 34, cullable: true, cullRank: 9000, orderHint: 1 },
    // A stray: it names root as its parent but an explicit tierRank keeps it
    // on root's own rank, so no placed ancestor is shallower than it.
    { id: 'stray', name: 'Stray', role: 'default', parentId: 'root', tierRank: 0, bornAt: 1 },
  ]
  const first = layoutTree({ nodes: forest, W: 1000, H: 600 })
  const second = layoutTree({ nodes: forest, W: 1000, H: 600 })
  assert.deepEqual([...first.slots], [...second.slots])
  assert.deepEqual([...first.labels], [...second.labels])
  assert.ok(first.slots.get('zeta').x < first.slots.get('alpha-slot').x, 'the empty slot must come last in its family')
  assert.equal(first.slots.get('stray').y, first.slots.get('root').y, 'a stray keeps its rank')
  assert.ok(first.slots.get('stray').x > first.slots.get('root').x, 'a stray trails the forest')
  assert.ok(first.slots.get('stray').x + first.radii.get('stray') <= 1000)
  assert.equal(first.culled.size, 0)
})

test('a canvas too short for the tiers shrinks the circles instead of overlapping them', () => {
  const deep = [
    { id: 'root', name: 'Coordinator', role: 'coordinator', bornAt: 1 },
    { id: 'mid', name: 'Manager', role: 'manager', parentId: 'root', bornAt: 1 },
    { id: 'leaf', name: 'Lane', role: 'default', parentId: 'mid', bornAt: 1 },
  ]
  const roomy = layoutTree({ nodes: deep, W: 900, H: 760 })
  const cramped = layoutTree({ nodes: deep, W: 900, H: 339 })
  assert.equal(roomy.radii.get('root'), 62, 'a canvas with room keeps the full role size')
  const pitch = cramped.slots.get('mid').y - cramped.slots.get('root').y
  const circles = cramped.radii.get('root') + cramped.radii.get('mid')
  assert.ok(circles <= pitch, `circles ${circles} must clear the ${pitch}px row pitch`)
  assert.ok(cramped.radii.get('root') >= 34, 'never below the readable floor')
  // Growing the window back must give the full size back, not ratchet down.
  assert.equal(layoutTree({ nodes: deep, W: 900, H: 760 }).radii.get('root'), 62)
})

test('absence is answered without a slot, a radius or a throw', () => {
  const empty = layoutTree({ nodes: [], W: 1260, H: 800 })
  assert.equal(empty.slots.size, 0)
  assert.equal(empty.radii.size, 0)
  assert.equal(empty.drillRequired, false)
  assert.deepEqual(empty.rowYs, [])
  // No argument at all is the same answer as an empty fleet.
  assert.equal(layoutTree().slots.size, 0)
  // One node, no parent, no edges: centred, full size, nothing culled.
  const lone = layoutTree({ nodes: [{ id: 'only', name: 'Only', role: 'coordinator', bornAt: 1 }], W: 1260, H: 800 })
  assert.equal(lone.slots.get('only').x, 630)
  assert.equal(lone.radii.get('only'), 62)
  assert.equal(lone.culled.size, 0)
  assert.equal(lone.drillRequired, false)
})

test('a name whose longest word misses its line by a sliver widens instead of cutting', () => {
  /* Measured at Large text on the desktop press-through (2026-08-27): the
     canvas shrinks in local pixels, a second-rank pitch lands in the high 80s,
     and "Default 2" rendered as "Defau… 2" beside "Manag…" — names cut by one
     or two characters while the label margin (pitch - 10) sat unused beside
     them. labelFor may now spend that margin down to 4px when doing so fits
     the longest word whole; the ellipsis remains for words the rank genuinely
     cannot hold, and the roomy case is untouched. */
  const record = { name: 'Default 2', id: 'tree-node-x' }

  // pitch 87: the old budget (77px) cut "Default" to "Defau…"; the word needs
  // ceil(7 * 7.6 + 26) = 80px, and 80 <= 87 - 4, so the label widens and keeps
  // the whole name.
  const tight = labelFor(record, 87)
  assert.equal(tight.text, 'Default 2', `a name the rank can hold was cut to "${tight.text}"`)
  assert.equal(tight.maxWidth, 80, 'the widened budget must be the word’s own need, never the whole pitch')
  assert.ok(tight.maxWidth <= 87 - 4, 'the widened label must keep at least 4px of the pitch as air')

  // pitch 80: even the full margin cannot hold the word — the cut stands, and
  // it says so with the ellipsis plus the full name in the title.
  const cramped = labelFor(record, 80)
  assert.ok(cramped.text.includes('…'), 'a word the rank cannot hold must still be cut, never overflow a neighbour')
  assert.equal(cramped.title, 'Default 2')
  assert.equal(cramped.maxWidth, 70, 'the readable floor moved')

  // pitch 120: room to spare — the widen branch must not touch the roomy case.
  const roomy = labelFor(record, 120)
  assert.equal(roomy.text, 'Default 2')
  assert.equal(roomy.maxWidth, 110, 'the ordinary budget (pitch - 10) changed')

  // No pitch means no neighbour: uncapped, whole, exactly as before.
  assert.deepEqual(labelFor(record, null), { maxWidth: null, text: 'Default 2', title: 'Default 2' })
})

test('spacious trees keep every agent and sibling gap when the viewport is narrow', () => {
  const nodes = [{ id: 'root', name: 'Controller' },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `agent-${i}`, parentId: 'root', name: `Worker ${i}` }))]
  for (const W of [390, 1100, 1854]) {
    const result = layoutTree({ nodes, W, H: 400, spacious: true })
    assert.equal(result.slots.size, nodes.length)
    assert.equal(result.culled.size, 0)
    const children = nodes.slice(1).map(node => result.slots.get(node.id)).sort((a, b) => a.x - b.x)
    for (let i = 1; i < children.length; i++) assert.ok(children[i].x - children[i - 1].x >= 200)
    assert.ok(children.at(-1).x > W, 'overflow is available to pan/overview instead of culling')
    assert.ok(result.rowYs[1] - result.rowYs[0] >= 310)
  }
})

test('spacious branch placement is deterministic and keeps separate subtrees apart', () => {
  const nodes = [{ id: 'root' }, { id: 'left', parentId: 'root' }, { id: 'right', parentId: 'root' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `left-${i}`, parentId: 'left' })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `right-${i}`, parentId: 'right' }))]
  const first = layoutTree({ nodes, W: 1100, H: 700, spacious: true })
  const reversed = layoutTree({ nodes: nodes.slice().reverse(), W: 1100, H: 700, spacious: true })
  for (const node of nodes) assert.deepEqual(first.slots.get(node.id), reversed.slots.get(node.id))
  const left = nodes.filter(node => node.parentId === 'left').map(node => first.slots.get(node.id).x)
  const right = nodes.filter(node => node.parentId === 'right').map(node => first.slots.get(node.id).x)
  assert.ok(Math.min(...right) - Math.max(...left) >= 200)
  assert.equal(first.slots.get('left').x, (Math.min(...left) + Math.max(...left)) / 2)
})
