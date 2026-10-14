/* The band the graph header owns: title, crumb and tools. tree-graph.js
   reserves the same 72px as SCREEN_TOP before it will seat a context card, so
   a row centre above it collides with chrome that is always drawn. padTop
   starts at 104, so it may give 28px and stop -- four short of the 32 that
   would put a row centre exactly on the band. */
const HEADER_BAND = 72
const PAD_TOP_FLOOR_GIVE = 104 - HEADER_BAND - 4

const ROLE_RADII = Object.freeze({
  coordinator: 62,
  helper: 52,
  shadow: 52,
  manager: 47,
  default: 39,
  spawned: 39,
})

const HIERARCHY_EDGE_TYPES = new Set(['manages', 'delegates_to', 'hierarchy'])
/* The last rung was [12, -6]: literal minus-six pixels of air, overlap by
   sanction. It existed because a jammed rank had nowhere else to go — but the
   tierRank fix in views/computers.js spreads a deep tree across its true
   ranks, so the pressure that rung relieved is gone, and the ladder now ends
   at the smallest HONEST air instead. No rung may ever be negative again:
   below MIN_AIR the answers are culling and drill, which exist. */
const MIN_AIR = 2
const PACKING_LADDER = Object.freeze([
  [44, 10],
  [12, 10],
  [12, MIN_AIR],
])

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null
const idOf = (node) => String(node?.id ?? node?.agent?.id ?? '')
const roleOf = (node) => String(node?.role ?? node?.agent?.role ?? 'default')
/* F10 / R13 / OD14 / N7: "readable circle names (name and role visible, id
   only in details)". A record with no name used to fall all the way through
   to its own internal id, painted whole as the circle's one piece of
   identifying text -- unreadable by construction, since an id names nothing
   a person recognises. This module is deliberately dependency-free (see its
   header), so the fallback is built from the role KEY already on the record,
   never from vocab.js's role captions: "shadow-manager" reads as "Shadow
   Manager" here, not the exact wording tree-graph.js's separate role sublabel
   shows underneath. That sublabel remains the authoritative role name; this
   is only the last-resort word painted where a real name belongs. */
const titleCaseWord = (word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : word
const readableRoleFallback = (role) => {
  const words = String(role || '').split(/[-_]+/).filter(Boolean).map(titleCaseWord)
  return words.length ? words.join(' ') : 'Agent'
}
const nameOf = (node) => {
  const explicit = node?.name ?? node?.agent?.name
  return explicit != null ? String(explicit) : readableRoleFallback(roleOf(node))
}

/* A circle whose only content is emptiness is wasted room: it pushes its
   siblings apart and makes the tree sprawl for nothing. A node with no
   runtime to show carries one short state word instead, so it can be sized
   for that word rather than for a clock it does not have. 34 is the floor
   the packer already treats as "still readable". */
const SILENT_SCALE = 0.72
/* The smallest circle this file will draw, and the height of the name+role
   stack that hangs under every one of them. Both are used by the vertical
   fitter in layoutTree; 34 is the same floor the horizontal packer already
   treats as "still readable", so the two axes agree on what readable means. */
const RADIUS_FLOOR = 34
/* The height of the name+role stack under every circle, as a CORRECTED
   CONSTANT, not a measurement: layoutTree's contract is DOM-free determinism,
   so this number is computed from the stack's own worst case, not read back
   from a rendered page. A name may wrap to two 13px lines (2 × 17px line
   height) plus the role row clamped to ONE line (14px, clamped in
   tree-graph.css precisely so this worst case is computable) plus the 6px gap
   above the stack: 34 + 14 + 6 = 54, padded to 58 for the role bead's
   descender box. The old value, 34, was one wrapped name with no role row at
   all — every two-line label under a tight rank painted into the row below.
   Exported, and written once into CSS as --tree-label-stack, so the sheet and
   the layout cannot drift apart; a guard asserts they match. */
const LABEL_STACK = 58
export const TREE_LABEL_STACK = LABEL_STACK
/* A named circle's horizontal claim is its label's minimum readable width,
   not just its diameter: two 34px circles side by side hold 68px of circle
   and two 70px labels. Packing by radius alone made exactly those labels
   overlap. Unnamed records (empty slots) claim only their circle. */
const LABEL_FOOT_MIN = 70
const halfFoot = (record) => Math.max(record.r, record.name ? LABEL_FOOT_MIN / 2 : 0)
export function treeNodeRadius(node) {
  const explicit = finite(node?.r) ?? finite(node?.radius)
  if (explicit !== null) return Math.max(RADIUS_FLOOR, explicit)
  const base = ROLE_RADII[roleOf(node)] ?? ROLE_RADII.default
  const source = node?.agent ?? node
  const silent = !Number.isFinite(Number(source?.bornAt))
  return Math.max(RADIUS_FLOOR, silent ? Math.round(base * SILENT_SCALE) : base)
}
const radiusOf = treeNodeRadius

export function hierarchyParents(nodes, edges) {
  const ids = new Set(nodes.map(idOf))
  const parents = new Map()

  for (const node of nodes) {
    const id = idOf(node)
    const parentId = node?.parentId ?? node?.agent?.parentId
    if (id && parentId != null && ids.has(String(parentId)) && String(parentId) !== id) {
      parents.set(id, String(parentId))
    }
  }

  const ordered = [...(Array.isArray(edges) ? edges : [])].sort((left, right) => {
    const observed = (edge) => edge?.sourceKind === 'observed' ? 0 : 1
    return observed(left) - observed(right)
      || String(left?.from ?? left?.source ?? '').localeCompare(String(right?.from ?? right?.source ?? ''))
      || String(left?.to ?? left?.target ?? '').localeCompare(String(right?.to ?? right?.target ?? ''))
  })
  for (const edge of ordered) {
    if (edge?.type && !HIERARCHY_EDGE_TYPES.has(edge.type)) continue
    const parentId = String(edge?.from ?? edge?.source ?? '')
    const childId = String(edge?.to ?? edge?.target ?? '')
    if (!ids.has(parentId) || !ids.has(childId) || parentId === childId || parents.has(childId)) continue

    let current = parentId
    const seen = new Set([childId])
    let cyclic = false
    while (current && !seen.has(current)) {
      seen.add(current)
      current = parents.get(current)
    }
    if (current && seen.has(current)) cyclic = true
    if (!cyclic) parents.set(childId, parentId)
  }
  return parents
}

function depthFor(id, record, parents) {
  if (record.tierRank !== null) return Math.max(0, Math.round(record.tierRank))
  let depth = 0
  let current = id
  const seen = new Set([id])
  while (parents.has(current) && depth < 12) {
    current = parents.get(current)
    if (seen.has(current)) break
    seen.add(current)
    depth += 1
  }
  return depth
}

function packedXs(list, width) {
  if (!list.length) return null
  if (list.length === 1) return [width / 2]

  const step = width / (list.length + 1)
  const naive = list.map((record, index) =>
    Math.max(record.r + 44, Math.min(width - record.r - 44, step * (index + 1))))
  const naiveOk = naive.every((x, index) => index === 0
    || x - naive[index - 1] >= halfFoot(list[index - 1]) + halfFoot(list[index]) + MIN_AIR)
  if (naiveOk) return naive

  for (const [edge, air] of PACKING_LADDER) {
    const gaps = list.map((record, index) => index
      ? halfFoot(list[index - 1]) + halfFoot(record) + air
      : 0)
    const span = gaps.reduce((sum, gap) => sum + gap, 0)
    const available = width - edge * 2 - halfFoot(list[0]) - halfFoot(list.at(-1))
    if (span > available) continue
    let x = edge + halfFoot(list[0]) + Math.max(0, (available - span) / 2)
    return list.map((record, index) => (x += gaps[index]))
  }
  return null
}

/* Nesting, made visible without tracing a single edge.
   Spacing a rank evenly makes every node in it look equally related to every
   node above it — the rank reads as a flat row and you cannot see which
   manager owns which lane. Siblings of one parent are packed TIGHT; different
   parents' groups are separated by a gap several times larger, and each group
   is centred under its own parent. The whitespace does the work the edges were
   being asked to do alone.

   WHAT THIS PACKER IS NOW, AND WHAT IT IS NOT.
   It is a PER-RANK packer: each rank is positioned on its own, after the rank
   above it has been fixed, with no knowledge of how wide the subtrees under
   it will turn out to be. It wants to centre every family under its parent
   (`desired` below) but it places families with a monotone left-to-right
   cursor, so the moment one family cannot sit under its parent without
   touching the family to its left, it is pushed right, and every family after
   it is pushed further. Measured on the owner's screenshot (canvas ≈ 900px,
   three roots and one new-tree slot, one child and three child slots): the
   root row sat at the within-family pitch, 78 + 68 = 146px, while the child
   row's families were 68 wide with 238px BETWEEN them — a 306px family pitch
   under a 146px parent pitch — so the child row ran to 89/230/536/842 and
   B's slot sat 80px right of B, C's 150px right of C, on elbowed connectors
   that should have been straight drops. Parents were placed first, with no
   room made for their children, and the children were pushed wherever the
   cursor left them.

   The cure is not a better cursor; it is a pass that knows subtree widths
   before any parent is placed. That pass is packSubtreeXs below: one
   post-order measure from the leaves up, then top-down placement, so every
   parent is centred over exactly the room its own children need and a
   child's connector collapses to a vertical line. This rank packer stays for
   two reasons that are not nostalgia: it is the sole CULL AUTHORITY — which
   records fit a rank, and whether the drill is required, are decided here
   and only here, so the subtree overlay can never make an agent disappear —
   and it is the FALLBACK geometry whenever the subtree pass cannot fit the
   forest even at its tightest rung. `culled` and `drillRequired` are byte
   for byte what they were before the overlay existed.

   The two earlier lessons still hold and are kept in this packer:
   1. A rank whose nodes all share ONE parent is still one group, packed and
      centred, never handed to packedXs to be smeared across the canvas.
   2. The air between siblings is the largest value up to AIR_WITHIN_MAX that
      still fits, and the gap BETWEEN groups keeps a constant ratio to it, so
      "tight siblings, wide gap between families" survives at every width. */
const AIR_WITHIN = 18
const AIR_WITHIN_MAX = 68
const BETWEEN_RATIO = 3.5
const RANK_EDGE = 24
function packGroupedXs(list, width, anchorOf) {
  if (!list.length) return null
  const groups = []
  for (const record of list) {
    const anchor = anchorOf(record)
    const key = anchor?.key ?? '~orphan'
    const last = groups.at(-1)
    if (last && last.key === key) last.items.push(record)
    else groups.push({ key, items: [record], anchor: anchor?.x ?? null })
  }

  /* Footprints, not diameters: a named record's claim includes its label's
     minimum readable width (halfFoot), so labels are a packing input here the
     same way they are in packedXs. */
  const circleSpan = list.reduce((sum, record) => sum + halfFoot(record) * 2, 0)
  const room = width - RANK_EDGE * 2 - circleSpan
  if (room < 0) return null
  /* total(air) = circleSpan + air * (n - g) + air * RATIO * (g - 1), so the
     widest air the rank can afford is one division rather than a search. */
  const airUnits = (list.length - groups.length) + BETWEEN_RATIO * (groups.length - 1)
  let air = AIR_WITHIN_MAX
  if (airUnits > 0) {
    air = Math.floor(Math.min(AIR_WITHIN_MAX, room / airUnits))
    if (air < AIR_WITHIN) return null
  }
  const between = Math.floor(air * BETWEEN_RATIO)

  const widthOf = (group) => group.items.reduce((sum, record) => sum + halfFoot(record) * 2, 0)
    + air * (group.items.length - 1)
  const total = groups.reduce((sum, group) => sum + widthOf(group), 0)
    + between * (groups.length - 1)
  if (total > width - RANK_EDGE * 2) return null

  let cursor = RANK_EDGE
  for (const group of groups) {
    const groupWidth = widthOf(group)
    const desired = group.anchor == null ? (width - groupWidth) / 2 : group.anchor - groupWidth / 2
    group.left = Math.max(cursor, desired)
    cursor = group.left + groupWidth + between
  }
  // A group centred under a right-hand parent can push the rank past the edge;
  // pull the whole run back, then re-seat it against the left edge.
  const last = groups.at(-1)
  if (last.left + widthOf(last) > width - RANK_EDGE) {
    let limit = width - RANK_EDGE
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]
      group.left = Math.min(group.left, limit - widthOf(group))
      limit = group.left - between
    }
    let floor = RANK_EDGE
    for (const group of groups) {
      group.left = Math.max(group.left, floor)
      floor = group.left + widthOf(group) + between
    }
  }

  const xs = []
  for (const group of groups) {
    let x = group.left
    for (const record of group.items) {
      xs.push(x + halfFoot(record))
      x += halfFoot(record) * 2 + air
    }
  }
  return xs.at(-1) + list.at(-1).r <= width - 4 ? xs : null
}

/* ONE POST-ORDER SUBTREE PASS, THEN TOP-DOWN PLACEMENT.
   This is the pass packGroupedXs could not be (see the block above it): it
   measures every subtree from the leaves up BEFORE any parent is placed, so a
   parent is put over the middle of the room its own children take, and the
   children are laid out under it from that room's left edge. A parent with one
   child sits exactly over it; a parent with two sits over their midpoint; the
   connector the graph draws is then a straight drop, which is the picture the
   owner drew for us: children directly beneath, no elbow, no family pushed
   sideways by a neighbour that happened to be placed first.

   Families. A record whose parent is placed and strictly shallower is that
   parent's child. A record whose parent was culled (or sits on its own rank or
   deeper, which an explicit tierRank can do) is hung from its nearest placed,
   strictly shallower ancestor instead, so a culled manager does not orphan its
   lanes. A true root is a family of its own tree — keyed exactly as the rank
   packer keys it, `tree:${treeId}` or '~orphan', so the two agree about what a
   tree is — and families stand in the order their first root appears, which on
   the root rank is (orderHint, id): the same order the rank packer uses when
   every parent is at the same x, so the root row does not reshuffle. A record
   with a parent but no placed shallower ancestor at all is a stray; strays keep
   their rank's y and trail the forest in a family of their own rather than be
   dropped, because this pass never removes anything — removal is the rank
   packer's job and it has already been done by the time this runs.

   Measure. Deepest rank first, so every child is measured before its parent,
   without recursion. A leaf is its footprint, `2 * halfFoot` (its label's
   minimum readable width, the same primitive both rank packers use, read from
   the radius the vertical fitter may already have shrunk). An internal node's
   children span their footprints plus `air` between; the node's own centre is
   the midpoint of its first and last child's centres; the subtree's box is the
   union of that span and the node's own footprint, so a parent wider than its
   children (a coordinator over one lane) still claims its full width and two
   such parents never touch. The forest is the families in a row, `air` between
   roots of one tree and `between = floor(air * BETWEEN_RATIO)` between trees —
   paid between TREES only. Inside one tree a cousin stands as close as a
   sibling, which is what a family looks like; the wide gap says "another
   tree", and today's per-rank packer was spending it between every pair of
   families, which is how a three-child row came to need 306px per child.

   Ladder. The widest air that fits wins: AIR_WITHIN_MAX down to AIR_WITHIN one
   pixel at a time at the normal rank edge, then the rank packer's own
   PACKING_LADDER rungs — spread in, never copied, so the two ladders cannot
   drift — which narrow the edge and finally the air to MIN_AIR. No rung fits →
   null, and the per-rank geometry already computed stands: every placed
   record keeps its x, nothing is culled or un-culled by this pass.

   Returns Map id → x for every placed record, or null. */
function packSubtreeXs({ tierKeys, tiers, parents, placed, width, treeIdOf, spacious = false, contextWidth = 0 }) {
  const depthOf = new Map()
  const ranks = tierKeys.map((tierKey, rowIndex) => {
    const list = tiers.get(tierKey)
      .filter(record => placed.has(record.id))
      .sort((left, right) => left.orderHint - right.orderHint || left.id.localeCompare(right.id))
    for (const record of list) depthOf.set(record.id, rowIndex)
    return list
  })
  const ordered = ranks.flat()
  if (!ordered.length) return null
  const byId = new Map(ordered.map(record => [record.id, record]))

  const childrenOf = new Map(ordered.map(record => [record.id, []]))
  const families = new Map()
  const familyOf = (key) => {
    if (!families.has(key)) families.set(key, [])
    return families.get(key)
  }
  const strays = []
  for (const record of ordered) {
    const depth = depthOf.get(record.id)
    if (!parents.has(record.id)) {
      const treeId = treeIdOf(record)
      familyOf(treeId ? `tree:${treeId}` : '~orphan').push(record)
      continue
    }
    /* Walk up to the nearest placed, strictly shallower ancestor; the bound
       and the seen-guard are depthFor's, because a parent map built from
       declared edges is cycle-safe but a tierRank can still put a parent on
       its child's rank or below it. */
    let current = record.id
    let host = null
    const seen = new Set([current])
    for (let step = 0; step < 12 && parents.has(current); step += 1) {
      current = parents.get(current)
      if (seen.has(current)) break
      seen.add(current)
      if (depthOf.has(current) && depthOf.get(current) < depth) { host = current; break }
    }
    if (host) childrenOf.get(host).push(record)
    else strays.push(record)
  }
  const groups = [...families.values()]
  if (strays.length) groups.push(strays)

  const measure = (air) => {
    const box = new Map()
    for (let rowIndex = ranks.length - 1; rowIndex >= 0; rowIndex -= 1) {
      for (const record of ranks[rowIndex]) {
        const foot = spacious ? Math.max(68, halfFoot(record)) : halfFoot(record)
        const kids = childrenOf.get(record.id)
        if (!kids.length) {
          box.set(record.id, { w: foot * 2, nodeOff: foot, kidsOff: 0 })
          continue
        }
        const span = kids.reduce((sum, kid) => sum + box.get(kid.id).w, 0) + air * (kids.length - 1)
        const first = box.get(kids[0].id)
        const last = box.get(kids.at(-1).id)
        const mid = (first.nodeOff + (span - last.w + last.nodeOff)) / 2
        const left = Math.min(0, mid - foot)
        const right = Math.max(span, mid + foot)
        box.set(record.id, { w: right - left, nodeOff: mid - left, kidsOff: -left })
      }
    }
    const between = Math.floor(air * BETWEEN_RATIO)
    const forest = groups.reduce((sum, roots) =>
      sum + roots.reduce((inner, root) => inner + box.get(root.id).w, 0) + air * (roots.length - 1), 0)
      + between * (groups.length - 1)
    return { box, between, forest }
  }

  for (const [edge, air] of spacious ? [[40, 64 + Math.round(contextWidth * 0.15)]] : SUBTREE_LADDER) {
    const { box, between, forest } = measure(air)
    // A readable tree may extend beyond the viewport. The graph supplies pan
    // and an explicit overview; compressing the gaps would undo this mode.
    const available = spacious ? Math.max(width - edge * 2, forest) : width - edge * 2
    if (forest > available) continue
    const xs = new Map()
    let cursor = edge + (available - forest) / 2
    const place = (record, left) => {
      const own = box.get(record.id)
      xs.set(record.id, left + own.nodeOff)
      let kidLeft = left + own.kidsOff
      for (const kid of childrenOf.get(record.id)) {
        place(kid, kidLeft)
        kidLeft += box.get(kid.id).w + air
      }
    }
    for (const roots of groups) {
      for (const root of roots) {
        place(root, cursor)
        cursor += box.get(root.id).w + air
      }
      cursor += between - air
    }
    return xs.size === byId.size ? xs : null
  }
  return null
}
/* AIR_WITHIN_MAX down to AIR_WITHIN at the rank edge, then the rank packer's
   own rungs. Spread from PACKING_LADDER so a rung edited there is a rung
   edited here; a test guards the spread. */
const SUBTREE_LADDER = Object.freeze([
  ...Array.from({ length: AIR_WITHIN_MAX - AIR_WITHIN + 1 }, (_, index) => [RANK_EDGE, AIR_WITHIN_MAX - index]),
  ...PACKING_LADDER,
])

function keepReadable(list, width) {
  const priority = [...list].sort((left, right) =>
    Number(left.cullable) - Number(right.cullable)
    || left.cullRank - right.cullRank
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id))
  const keep = []
  for (const record of priority) {
    const candidate = [...keep, record]
    if (packedXs(candidate, width) || keep.length === 0) keep.push(record)
  }
  return new Set(keep.map(record => record.id))
}

/* Each record's label budget comes from ITS OWN two neighbours, not from
   the rank minimum: one tight pair used to shrink every label in the row,
   including labels standing next to open space. An end record has one
   neighbour; a lone record has none and stays uncapped. `xs` must be the
   rank's x values in left-to-right order, or a budget is read off a record
   that is not a neighbour at all. */
function pitchBetween(xs, index) {
  const left = index > 0 ? xs[index] - xs[index - 1] : null
  const right = index + 1 < xs.length ? xs[index + 1] - xs[index] : null
  if (left == null && right == null) return null
  if (left == null) return right
  if (right == null) return left
  return Math.min(left, right)
}

/* Middle-truncation destroys the word — "assi…ant", "reco…ile" — and the
   owner asked for readable context, so it is gone. The budget is two wrapped
   lines instead of one clipped line; if a name still cannot fit, the id's own
   trailing segment is a real word ("reconcile", "assistant") and reads better
   than any cut; only if THAT overflows do we clip, and then at the END. */
const LABEL_CHAR_PX = 7.6
// The name row carries a 6px role bead and a 5px gap before the first glyph,
// and the row itself is inset — measured, not guessed, from the rendered rows.
const LABEL_CHROME_PX = 26
const LABEL_LINES = 2
export function labelFor(record, pitch) {
  const full = record.name
  if (pitch == null) return { maxWidth: null, text: full, title: full }
  /* Floor 70, not 96: the packers now guarantee every named record at least
     LABEL_FOOT_MIN of footprint, so 70 is a width the rank actually HAS. The
     96 floor promised more room than a tight rank owned, which is how labels
     painted over their neighbours. 70 is also the width the over-capacity
     test has always pinned as the readable minimum. */
  const maxWidth = Math.max(LABEL_FOOT_MIN, Math.round(pitch - 10))
  const perLine = Math.max(6, Math.floor((maxWidth - LABEL_CHROME_PX) / LABEL_CHAR_PX))
  const budget = perLine * LABEL_LINES
  /* The total budget is not enough: "Coordinator 1" fits 14 chars over two
     lines, but the single word "Coordinator" does not fit EITHER line, so
     the renderer broke it mid-word — "Coordinat / or 1" (owner walkthrough,
     iteration 6). A name is accepted whole only when its longest word also
     fits one line. When the name fits the budget but one word cannot fit a
     line, that WORD is end-ellipsised in place ("Coordin… 1") — the name
     stays a name, the full text rides in the hover title, and nothing is
     ever broken mid-word. Names over the whole budget keep their id-segment
     and end-ellipsis forms below, unchanged. */
  const words = full.split(/\s+/)
  const longestWord = words.reduce((longest, word) => Math.max(longest, word.length), 0)
  if (full.length <= budget) {
    if (longestWord <= perLine) return { maxWidth, text: full, title: full }
    /* WIDEN BEFORE CUTTING, when the rank has the room. The -10 margin above
       is generous, and at tight pitches it was the whole difference between a
       name and a stump: at Large text the canvas shrinks in local pixels, a
       second-rank pitch lands in the high 80s, perLine floors at 6, and
       "Default 2" rendered as "Defau… 2" with "Manager" as "Manag…" — each
       cut by one or two characters while 6px of deliberate margin sat unused
       beside them (desktop press-through, 2026-08-27). So when the longest
       word misses its line by a sliver, the label may spend the margin down
       to 4px: two neighbours widened the same way still keep 4px of air,
       because each holds half its pitch. Only the WIDTH grows — a word the
       rank genuinely cannot hold still ellipsises exactly as before. */
    const wordWidth = Math.ceil(longestWord * LABEL_CHAR_PX + LABEL_CHROME_PX)
    if (wordWidth > maxWidth && wordWidth <= Math.round(pitch - 4)) {
      return { maxWidth: wordWidth, text: full, title: full }
    }
    const text = words
      .map(word => word.length > perLine ? `${word.slice(0, Math.max(3, perLine - 1))}…` : word)
      .join(' ')
    return { maxWidth, text, title: full }
  }

  const segments = record.id.split(/[-_.]/).filter(Boolean)
  let suffix = ''
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = segments.slice(index).join('-')
    if (candidate.length > budget) break
    suffix = candidate
  }
  if (suffix) return { maxWidth, text: suffix, title: full }

  const tail = segments.at(-1) || full
  const text = tail.length > budget ? `${tail.slice(0, Math.max(3, budget - 1))}…` : tail
  return { maxWidth, text, title: full }
}

/**
 * Deterministic, DOM-free top-down tree layout for ToolsEnabled page 2.
 * The returned maps and sets are new values on every call; input records are
 * never mutated.
 */
export function layoutTree({ nodes = [], edges = [], W = 800, H = 600, spacious = false, contextWidth = 0 } = {}) {
  const width = Math.max(160, finite(W) ?? 800)
  contextWidth = Math.max(0, Math.min(700, finite(contextWidth) ?? 0))
  let height = Math.max(180, finite(H) ?? 600)
  const records = [...(Array.isArray(nodes) ? nodes : [])]
    .map((node) => ({
      source: node,
      id: idOf(node),
      name: nameOf(node),
      r: radiusOf(node),
      tierRank: finite(node?.tierRank ?? node?.agent?.tierRank),
      cullable: (node?.cullable ?? node?.agent?.cullable) === true,
      cullRank: finite(node?.cullRank ?? node?.agent?.cullRank) ?? 0,
      /* WHERE A NODE SITS AMONG ITS OWN SIBLINGS, when the id is the wrong
         answer. Sibling order in a rank falls back to `id.localeCompare`,
         which is exactly right for agents — it is stable, it is derived from
         data the caller already has, and no agent has a claim to be first.
         It is wrong for a node that is not an agent. The empty "add a child
         here" slot in src/tree-graph.js belongs at the END of the family it
         hangs off — "the next one goes here" is the whole sentence it says —
         and an id-sorted rank drops it wherever its generated id happens to
         fall, usually between two running agents, where it reads as one of
         them rather than as the space after them.
         A number, not a boolean "last", because ordering is the layout's job
         and a caller with two kinds of appendix should be able to say which
         comes first without this file learning what either of them is.
         Absent on every existing caller, so every existing rank keeps the
         id order it has today. */
      orderHint: finite(node?.orderHint ?? node?.agent?.orderHint) ?? 0,
      /* WHICH TREE a parentless record belongs to, for the grouped packer.
         Without it every root keyed '~orphan' and unrelated trees packed as
         one tight cluster — visually a single family that nobody drew (owner
         defect 5's structural half). Optional: absent on fleet records, whose
         single organisation has nothing to separate.

         FOUR PLACES, and deliberately not one. Measured 2026-08-22 along the
         live path: treeAgentRecord in src/views/computers.js builds each record
         with `treeNode: node` at the TOP level and NO top-level treeId, and
         src/tree-graph.js hands those records to layoutTree bare —
         visibleAgents returns computer.agents as they are, and _layoutAgents
         only spreads them. So a read that stopped at node.agent.treeNode.treeId
         found nothing on any real node: every root fell into '~orphan', the
         packer saw one family, and three unrelated trees stood at the
         within-family pitch (~146px) rather than BETWEEN_RATIO apart.
         The cure is to read every place the id honestly lives — the record's
         own treeId, its top-level treeNode, and those same two under the
         `agent` wrapper the rest of this file already tolerates — rather than
         to swap one guess for another. A single-shape read is what failed
         here, and re-pointing it would only set the date on which the layout
         silently collapses back to one family again. */
      treeId: String(
        node?.treeId
        ?? node?.treeNode?.treeId
        ?? node?.agent?.treeId
        ?? node?.agent?.treeNode?.treeId
        ?? '',
      ) || null,
    }))
    .filter(record => record.id)
  const parents = hierarchyParents(nodes, edges)
  const byId = new Map(records.map(record => [record.id, record]))
  const tiers = new Map()

  for (const record of records) {
    const depth = depthFor(record.id, record, parents)
    if (!tiers.has(depth)) tiers.set(depth, [])
    tiers.get(depth).push(record)
  }

  const tierKeys = [...tiers.keys()].sort((left, right) => left - right)
  const rows = tierKeys.length
  if (spacious) height = Math.max(height, 320 + (rows - 1) * 310)
  /* The label stack under a circle is a name that may wrap to two lines plus a
     role row that may wrap to two more. 92px of bottom pad let the last tier's
     role row fall off the panel edge; 116 clears the tallest stack. */
  let padTop = 104
  let padBottom = 116
  if (rows > 1) {
    const deficit = 86 * (rows - 1) - (height - padTop - padBottom)
    if (deficit > 0) {
      /* THE TOP PAD HAS A FLOOR, AND IT IS THE HEADER BAND.
         This gave up to 40px, taking padTop from 104 to 64 — but the graph
         title, the crumb and the tools occupy the top 72px, which is the same
         band _placeChips reserves as SCREEN_TOP before it will seat a card. So
         under vertical pressure the FIRST row's centre could rise above the
         header while every row below it kept an even pitch: one row crowding
         the title, the rest evenly spaced. That is the "funky" reading — an
         inconsistency between the top row and the others, not a spacing taste.
         The circle's own radius carries it further up still.
         Floored just clear of that band. The cost is that a short canvas
         reaches the radius shrinker slightly sooner, which is the right trade:
         a marginally smaller tree that clears its own header beats a full-size
         one whose top row overlaps the title. The number is stated here rather
         than imported because tree-layout takes no dependency on the graph
         module; a guard in the test pins the two together so they cannot
         drift apart silently. */
      const topGive = Math.min(40, PAD_TOP_FLOOR_GIVE, Math.round(deficit * 0.55))
      padTop -= topGive
      padBottom -= Math.min(22, deficit - topGive)
    }
  }
  const rowHeight = rows > 1 ? (height - padTop - padBottom) / (rows - 1) : 0

  /* THE VERTICAL AXIS HAD NO FITTER.
     Horizontally a rank that will not fit is packed, then culled, then
     drilled — three lines of defence. Vertically the row pitch was simply
     (height - pads) / (rows - 1) and NOTHING compared it against the circles
     it had to carry, so a short canvas drew the tiers straight through each
     other and painted every name under the neighbouring circle. Measured on
     the shipped build at 1024x768: a 339px canvas, three tiers, an 85px pitch
     holding 114px of circle — six overlapping pairs and three names hidden
     behind a bubble.
     The circles shrink TOGETHER, so a coordinator stays visibly larger than a
     lane and the role sizing still reads, down to the same 34px floor the
     packer already calls readable. A canvas too short for the tree gets a
     smaller tree, never a broken one. Below the floor the honest answer is
     more height, which is why the stacked breakpoint in src/styles.css now
     asks for enough of it. */
  /* When even the radius floor cannot make the tiers fit, the honest answer
     is MORE HEIGHT, and layoutTree says how much: minHeight is the canvas
     height at which this same tree lays out without any pair of adjacent
     tiers overlapping. The caller grows or scrolls the wrap (the stacked
     breakpoint in src/styles.css is the precedent). Rank count depends only
     on parentId and edges, never on H, so the value is a fixed point of the
     layout — found by iterating the fitter's own arithmetic below, and
     GUARDED by a test that re-lays at minHeight, because "should converge"
     is a claim, not a property, until it is pinned. */
  let minHeight = null
  if (rows > 1 && rowHeight > 0) {
    const fullRadii = records.map(record => record.r)
    /* LABEL_STACK is the label BOX; the box hangs 7px below the circle's
       edge (the CSS `top: calc(100% + 7px)` — the same 7 the graph's
       _labelBox counts). Reserving only the box budgeted zero air and left
       the stack ~7px into the next circle's space whenever rows ran tight,
       a constant sliver of the overlap the owner keeps photographing. */
    const LABEL_CLEARANCE = LABEL_STACK + 7
    const tallestPair = (radii) => {
      const byTier = tierKeys.map(key =>
        tiers.get(key).reduce((max, record) => Math.max(max, radii.get(record.id)), 0))
      let needed = 0
      for (let index = 0; index + 1 < byTier.length; index += 1) {
        needed = Math.max(needed, byTier[index] + byTier[index + 1] + LABEL_CLEARANCE)
      }
      return needed
    }
    const asMap = (values) => new Map(records.map((record, index) => [record.id, values[index]]))
    const scaledRadii = (pitch) => {
      const fullNeeded = tallestPair(asMap(fullRadii))
      const circles = fullNeeded - LABEL_CLEARANCE
      const scale = circles > 0 ? Math.max(0, pitch - LABEL_CLEARANCE) / circles : 1
      return fullRadii.map(r => scale < 1 ? Math.max(RADIUS_FLOOR, Math.round(r * scale)) : r)
    }

    const needed = tallestPair(asMap(fullRadii))
    if (needed > rowHeight) {
      const shrunk = scaledRadii(rowHeight)
      records.forEach((record, index) => { record.r = shrunk[index] })
      /* Still colliding after the floor bit? Then no scale fits this height;
         iterate the fitter's own arithmetic to the height that does. */
      let residual = tallestPair(asMap(shrunk))
      if (residual > rowHeight) {
        let candidate = residual
        for (let step = 0; step < 6; step += 1) {
          const at = tallestPair(asMap(scaledRadii(candidate)))
          if (at <= candidate) break
          candidate = at
        }
        minHeight = Math.ceil(104 + 116 + (rows - 1) * candidate)
      }
    }
  }

  const slots = new Map()
  const labels = new Map()
  const culled = new Set()
  const rowYs = []
  const rowOf = new Map()
  let drillRequired = false

  tierKeys.forEach((tierKey, rowIndex) => {
    const list = tiers.get(tierKey)
    list.sort((left, right) => {
      const leftParentX = slots.get(parents.get(left.id))?.x ?? width / 2
      const rightParentX = slots.get(parents.get(right.id))?.x ?? width / 2
      return leftParentX - rightParentX
        || left.orderHint - right.orderHint
        || left.id.localeCompare(right.id)
    })
    const y = rows > 1 ? padTop + rowIndex * rowHeight : height / 2
    rowYs.push(y)

    const anchorOf = (record) => {
      const parentId = parents.get(record.id)
      const parentSlot = parentId ? slots.get(parentId) : null
      if (parentSlot) return { key: parentId, x: parentSlot.x }
      /* A parentless record groups with its own TREE, so two trees' roots get
         the wide between-family gap instead of packing shoulder to shoulder
         as one '~orphan' cluster. No anchor x: a root family centres itself. */
      return record.treeId ? { key: `tree:${record.treeId}`, x: null } : null
    }
    let visible = list
    let xs = packGroupedXs(visible, width, anchorOf) || packedXs(visible, width)
    const naiveReadableRadius = list.length ? width / (2 * (list.length + 1)) : Infinity
    if (!spacious && (!xs || naiveReadableRadius < 34)) {
      drillRequired = true
      const keep = keepReadable(list, width)
      visible = list.filter(record => keep.has(record.id))
      for (const record of list) if (!keep.has(record.id)) culled.add(record.id)
      xs = packGroupedXs(visible, width, anchorOf) || packedXs(visible, width)
    }

    if (spacious) xs = visible.map((_, index) => 40 + index * (200 + Math.round(contextWidth * 0.15)))
    if (!xs && visible.length) {
      // The widest single record always fits the minimum canvas. This branch
      // is a defensive guarantee for malformed radii or extreme test inputs.
      visible = [visible[0]]
      xs = [width / 2]
      drillRequired = true
      for (const record of list.slice(1)) culled.add(record.id)
    }

    visible.forEach((record, index) => {
      slots.set(record.id, { x: xs[index], y })
      rowOf.set(record.id, rowIndex)
      labels.set(record.id, labelFor(record, pitchBetween(xs, index)))
    })
  })

  /* THE SUBTREE OVERLAY. The loop above has decided what fits (culled,
     drillRequired) and given every placed record a per-rank x. Now, with the
     survivors known, the forest is measured from the leaves up and placed from
     the roots down, and when it fits the canvas its x values replace the
     per-rank ones: children directly under their parents, parents centred over
     their children, the wide gap spent between trees only. When it does not
     fit — a canvas too narrow even at MIN_AIR — the per-rank geometry stands
     untouched, so a narrow window degrades to the layout it had before this
     pass existed rather than to an overflow. Each rank is re-sorted by its new
     x before the label budgets are read: a budget is the distance to the two
     NEIGHBOURS, and after the overlay a record's neighbours can be different
     records from the ones the per-rank order put beside it. */
  const overlay = packSubtreeXs({
    tierKeys, tiers, parents, placed: new Set(slots.keys()), width,
    treeIdOf: (record) => record.treeId, spacious, contextWidth,
  })
  if (overlay) {
    for (const tierKey of tierKeys) {
      const rank = tiers.get(tierKey)
        .filter(record => overlay.has(record.id))
        .sort((left, right) => overlay.get(left.id) - overlay.get(right.id))
      const xs = rank.map(record => overlay.get(record.id))
      rank.forEach((record, index) => {
        slots.get(record.id).x = xs[index]
        labels.set(record.id, labelFor(record, pitchBetween(xs, index)))
      })
    }
  }

  /* The radius is not a number this file kept to itself: it is the drawn
     diameter, the origin of every leader line and the obstacle the context
     blocks are routed around. If the fitter above changed it, the caller has
     to be told, or the canvas draws full-size circles into slots that were
     packed for smaller ones. */
  const radii = new Map(records.map(record => [record.id, record.r]))
  return { slots, rowYs, rowOf, culled, drillRequired, labels, parents, radii, minHeight }
}

export const TREE_ROLE_RADII = ROLE_RADII

/* HOW FAR A NODE BEING DRAGGED MAY TRAVEL VERTICALLY.
 *
 * THE DEFECT THIS ARITHMETIC EXISTS FOR (owner, 2026-08-18): "you cant drag
 * and drop the nodes onto the new bubbles anymore." The live drag was clamped
 * to the node's RANK CORRIDOR -- half the pitch to each neighbouring row --
 * and every empty slot on the canvas is in a different row from the node you
 * would drag onto it. Contact needs about 77px between centres; half a pitch
 * is 200px on a two-row canvas. The node stopped half-way, the ring never lit,
 * and the release stored a nudge instead of a move.
 *
 * THE RULE. Start from the corridor -- which is what makes an ordinary nudge
 * land where the hand left it, with no snap on release -- and widen it by the
 * REACH of every drop target actually on screen. Outside the corridor the node
 * can then only be within reach of something, so a release out there is either
 * a move or a refusal with a sentence, never an unexplained jump.
 *
 * It lives here, and not in the graph, because it is arithmetic and the graph
 * is a DOM module a test process cannot load. `candidates` are plain
 * `{x, y, r}` records: circles and empty slots alike, which is the point --
 * a slot is an ordinary target to this file, exactly as it is to layoutTree.
 *
 * @param corridor   [low, high] from the caller's own rank corridor
 * @param record     the node being dragged: {x, y, r}
 * @param candidates every visible drop target: [{x, y, r}]
 * @param slop       the caller's DROP_SLOP -- the same number the hit test uses
 * @param height     the canvas height, the outer bound
 */
export function dragBand({ corridor, record, candidates = [], slop = 0, height = 0 } = {}) {
  const [low, high] = Array.isArray(corridor) ? corridor : [record.y, record.y]
  let lowest = low
  let highest = high
  for (const candidate of candidates) {
    if (!candidate || candidate === record) continue
    const reach = candidate.r + record.r + slop
    lowest = Math.min(lowest, candidate.y - reach)
    highest = Math.max(highest, candidate.y + reach)
  }
  /* The canvas is the outer bound, and the node's own position is admitted
     whatever the arithmetic says: a band that excluded where the node already
     is would move it on the first pointermove. */
  return [
    Math.min(Math.max(record.r + 12, lowest), record.y),
    Math.max(Math.min(height - record.r - 12, highest), record.y),
  ]
}
