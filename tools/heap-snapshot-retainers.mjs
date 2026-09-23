#!/usr/bin/env node

/* WHO HOLDS A DEAD VIEW: the reader for --snapshot's .heapsnapshot files.
 *
 * WHY IT EXISTS. tools/performance-budget-qa.mjs says HOW MUCH is retained per
 * lap and tools/dom-retention-probe.mjs says WHAT (whole detached settings and
 * computers pages) -- neither can say WHO. The census asks weak references,
 * which see the retained thing but not its retainer; the budget subtracts two
 * totals. The only instrument that records the retaining EDGES is a V8 heap
 * snapshot, and this file is the part that reads one: it walks a detached DOM
 * node backwards along retainer edges to the GC root and prints the chain, so
 * the holder has a name instead of a theory.
 *
 * WHAT IT DOES, exactly:
 *   1. streams the snapshot's flat `nodes` / `edges` integer arrays out of the
 *      file byte-by-byte (a 300MB JSON document must never become one JS
 *      string; V8 refuses strings that size, and the tool would die of the
 *      thing it measures);
 *   2. BFSes from the snapshot's root along every NON-WEAK edge to give each
 *      reachable object its DevTools distance;
 *   3. finds every "Detached <Element>" native node, groups the census the way
 *      the probe reports it (counts per tag), and for the asked-for targets
 *      walks: repeatedly step to any retainer one distance closer to the root.
 *      That chain IS the shortest retaining path -- the same one DevTools'
 *      Retainers pane shows -- and the first JS object on it is the holder.
 *
 * A DETACHED NODE THAT HAS NO NON-WEAK PATH would have been collected by the
 * snapshot's own full GC, so everything this prints is genuinely retained.
 *
 *   node tools/heap-snapshot-retainers.mjs <file.heapsnapshot> --counts
 *   node tools/heap-snapshot-retainers.mjs <file.heapsnapshot> --paths "Detached HTMLInputElement" --max 4
 */

import { readFileSync } from 'node:fs'

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const flag = (name) => process.argv.includes(name)

const FILE = process.argv[2]
if (!FILE || FILE.startsWith('--')) {
  console.error('usage: node tools/heap-snapshot-retainers.mjs <file.heapsnapshot> [--counts] [--paths <name substring>] [--max <n>]')
  process.exit(2)
}
const COUNTS = flag('--counts')
const PATHS = argument('--paths', null)
const MAX_PATHS = Number(argument('--max', 3))

const say = (line) => process.stdout.write(`${line}\n`)

/* ---------- read the file without ever making one giant string ---------- */

const buf = readFileSync(FILE)

function indexOfAscii(needle, from = 0) {
  const at = buf.indexOf(needle, from, 'latin1')
  if (at === -1) throw new Error(`the snapshot has no ${JSON.stringify(needle)} section`)
  return at
}

/* The numeric arrays are ASCII digits, commas and newlines. Scanned by byte;
   pushed into a growable Float64Array (self_size of a large string can pass
   2^32, so unsigned 32-bit storage would quietly corrupt exactly the nodes an
   investigation cares about). */
function scanNumbers(start) {
  let capacity = 1 << 20
  let out = new Float64Array(capacity)
  let count = 0
  let value = 0
  let inNumber = false
  let i = start
  for (; ; i += 1) {
    const c = buf[i]
    if (c >= 48 && c <= 57) { value = value * 10 + (c - 48); inNumber = true; continue }
    if (inNumber) {
      if (count === capacity) {
        capacity *= 2
        const next = new Float64Array(capacity)
        next.set(out)
        out = next
      }
      out[count++] = value
      value = 0
      inNumber = false
    }
    if (c === 93 /* ] */) break
    /* commas, newlines, spaces: separators */
  }
  return { numbers: out.subarray(0, count), end: i }
}

const nodesAt = indexOfAscii('"nodes":[')
const meta = JSON.parse(`${buf.toString('utf8', 0, nodesAt).replace(/,\s*$/, '')}}`).snapshot
const nodeFields = meta.meta.node_fields
const nodeTypes = meta.meta.node_types[nodeFields.indexOf('type')]
const edgeFields = meta.meta.edge_fields
const edgeTypes = meta.meta.edge_types[edgeFields.indexOf('type')]

const { numbers: nodes, end: nodesEnd } = scanNumbers(nodesAt + '"nodes":['.length)
const edgesAt = indexOfAscii('"edges":[', nodesEnd)
const { numbers: edges, end: edgesEnd } = scanNumbers(edgesAt + '"edges":['.length)

/* strings: a real JSON array, parsed as such -- names contain escapes -- but
   never as part of the whole document. It is the LAST section of the file. */
const stringsAt = indexOfAscii('"strings":[', edgesEnd)
const stringsJson = buf.toString('utf8', stringsAt + '"strings":'.length, buf.length)
const strings = JSON.parse(stringsJson.replace(/\}\s*$/, ''))

const NODE_SIZE = nodeFields.length
const EDGE_SIZE = edgeFields.length
const F_TYPE = nodeFields.indexOf('type')
const F_NAME = nodeFields.indexOf('name')
const F_ID = nodeFields.indexOf('id')
const F_EDGES = nodeFields.indexOf('edge_count')
/* Detachedness is a FIELD, not a name. DevTools' "Detached" labels are
   synthesized in the UI from this field (0 unknown, 1 attached, 2 detached);
   nothing in the file carries a "Detached " prefix. The first version of this
   tool matched on the prefix, found zero detached nodes in a snapshot its own
   positive control had planted sixty into, and would have condemned the
   product as clean -- which is exactly what the control exists to catch. */
const F_DETACHED = nodeFields.indexOf('detachedness')
const E_TYPE = edgeFields.indexOf('type')
const E_NAME = edgeFields.indexOf('name_or_index')
const E_TO = edgeFields.indexOf('to_node')
const WEAK = edgeTypes.indexOf('weak')

const nodeCount = nodes.length / NODE_SIZE
const edgeCount = edges.length / EDGE_SIZE
say(`${nodeCount} nodes, ${edgeCount} edges, ${strings.length} strings`)

const nodeName = (ordinal) => strings[nodes[ordinal * NODE_SIZE + F_NAME]] ?? ''
const nodeType = (ordinal) => nodeTypes[nodes[ordinal * NODE_SIZE + F_TYPE]] ?? '?'
const nodeId = (ordinal) => nodes[ordinal * NODE_SIZE + F_ID]

/* first edge index per node: edges are stored in node order */
const firstEdge = new Uint32Array(nodeCount + 1)
for (let n = 0, acc = 0; n < nodeCount; n += 1) {
  firstEdge[n] = acc
  acc += nodes[n * NODE_SIZE + F_EDGES]
  firstEdge[n + 1] = acc
}

/* reverse index: for every node, which edges point AT it */
const inDegree = new Uint32Array(nodeCount)
for (let e = 0; e < edgeCount; e += 1) inDegree[edges[e * EDGE_SIZE + E_TO] / NODE_SIZE] += 1
const inFirst = new Uint32Array(nodeCount + 1)
for (let n = 0, acc = 0; n < nodeCount; n += 1) { inFirst[n] = acc; acc += inDegree[n]; inFirst[n + 1] = acc }
const inEdge = new Uint32Array(edgeCount)   /* edge index */
const inFrom = new Uint32Array(edgeCount)   /* from-node ordinal */
{
  const cursor = Uint32Array.from(inFirst.subarray(0, nodeCount))
  for (let n = 0; n < nodeCount; n += 1) {
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += 1) {
      const to = edges[e * EDGE_SIZE + E_TO] / NODE_SIZE
      const slot = cursor[to]++
      inEdge[slot] = e
      inFrom[slot] = n
    }
  }
}

/* distances from the root, weak edges skipped -- DevTools' own definition */
const dist = new Int32Array(nodeCount).fill(-1)
{
  const queue = new Uint32Array(nodeCount)
  let head = 0
  let tail = 0
  dist[0] = 0
  queue[tail++] = 0
  while (head < tail) {
    const n = queue[head++]
    const d = dist[n] + 1
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += 1) {
      if (edges[e * EDGE_SIZE + E_TYPE] === WEAK) continue
      const to = edges[e * EDGE_SIZE + E_TO] / NODE_SIZE
      if (dist[to] === -1) { dist[to] = d; queue[tail++] = to }
    }
  }
}

const edgeLabel = (e) => {
  const type = edgeTypes[edges[e * EDGE_SIZE + E_TYPE]]
  const raw = edges[e * EDGE_SIZE + E_NAME]
  const name = (type === 'element' || type === 'hidden') ? `[${raw}]` : (strings[raw] ?? String(raw))
  return { type, name }
}

/* ---------- the detached census, from the retainer side ---------- */

const detachedOrdinals = []
for (let n = 0; n < nodeCount; n += 1) {
  if (nodeType(n) !== 'native') continue
  const detached = F_DETACHED === -1
    ? nodeName(n).startsWith('Detached ')
    : nodes[n * NODE_SIZE + F_DETACHED] === 2
  if (detached) detachedOrdinals.push(n)
}

if (COUNTS || !PATHS) {
  const byName = new Map()
  for (const n of detachedOrdinals) {
    const name = nodeName(n)
    const entry = byName.get(name) || { count: 0, reachable: 0 }
    entry.count += 1
    if (dist[n] !== -1) entry.reachable += 1
    byName.set(name, entry)
  }
  const rows = [...byName.entries()].sort((a, b) => b[1].count - a[1].count)
  say(`\n${detachedOrdinals.length} detached native nodes, ${rows.length} distinct names (count / non-weakly reachable):`)
  for (const [name, entry] of rows.slice(0, 40)) say(`  ${String(entry.count).padStart(6)} / ${String(entry.reachable).padStart(6)}  ${name}`)
}

/* ---------- shortest retaining paths for the asked-for targets ---------- */

if (PATHS) {
  const targets = detachedOrdinals.filter((n) => nodeName(n).includes(PATHS) && dist[n] !== -1)
  say(`\n${targets.length} reachable detached node(s) matching ${JSON.stringify(PATHS)}; showing ${Math.min(MAX_PATHS, targets.length)} path(s):`)
  /* Spread the sample across the population rather than printing three
     siblings from one page: if three laps each retained a view, the holders of
     interest are one per lap. */
  const stride = Math.max(1, Math.floor(targets.length / Math.max(1, MAX_PATHS)))
  let shown = 0
  for (let i = 0; i < targets.length && shown < MAX_PATHS; i += stride, shown += 1) {
    const target = targets[i]
    say(`\n== ${nodeType(target)} ${nodeName(target)} @${nodeId(target)} (distance ${dist[target]}) ==`)
    let cur = target
    const lines = []
    let guard = 0
    while (dist[cur] > 0 && guard++ < 200) {
      let pickEdge = -1
      let pickFrom = -1
      /* any retainer one step closer to the root is on a shortest path; among
         those, a named property/context edge reads better than an internal one,
         so prefer it when both exist */
      for (let slot = inFirst[cur]; slot < inFirst[cur + 1]; slot += 1) {
        const e = inEdge[slot]
        if (edges[e * EDGE_SIZE + E_TYPE] === WEAK) continue
        const from = inFrom[slot]
        if (dist[from] !== dist[cur] - 1) continue
        const type = edgeTypes[edges[e * EDGE_SIZE + E_TYPE]]
        const better = pickEdge === -1
          || ((type === 'property' || type === 'context') && !['property', 'context'].includes(edgeTypes[edges[pickEdge * EDGE_SIZE + E_TYPE]]))
        if (better) { pickEdge = e; pickFrom = from }
      }
      if (pickEdge === -1) { lines.push('    (no retainer one step closer -- weak-only from here)'); break }
      const label = edgeLabel(pickEdge)
      lines.push(`    <- ${label.type} "${label.name}" of ${nodeType(pickFrom)} "${nodeName(pickFrom)}" @${nodeId(pickFrom)} (distance ${dist[pickFrom]})`)
      cur = pickFrom
    }
    for (const line of lines) say(line)
  }
}
