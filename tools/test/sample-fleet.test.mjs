/* THE EXAMPLE FLEET IS PINNED TO THE SHAPE THE LIVE RENDERS CONSUME.
 *
 * src/sample-fleet.js exists so the live computers page and agent drill-in can
 * be fed an example when no real host answers, with a badge — handled
 * elsewhere — as the only difference the person sees. That promise dies the
 * moment the example's shape drifts from what mountProjection() and
 * declaredAgentProjection() read, and drift is exactly what a hand-built
 * record does the first time the real shape changes. So this suite validates
 * the record against the SHIPPED schema (public/data/schema/fleet.schema.json),
 * read at run time rather than transcribed here — a transcribed field list
 * would be a second copy of the schema, aging separately.
 *
 * WHAT IS DELIBERATELY NOT VALIDATED: the fleet schema requires a
 * `contentHash` beside the graph's revision. No render reads it, and
 * declaredFleetData() in src/declared-fleet.js — the live synthesiser the
 * sample must stay shape-compatible with — does not produce one. Its absence
 * is asserted below as a decision, so the day someone adds a real hash they
 * meet this sentence instead of tripping over silent disagreement.
 *
 * Run: node --test tools/test/sample-fleet.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sampleFleetData, sampleAgentsData } from '../../src/sample-fleet.js'
import { ROLES } from '../../src/vocab.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const schema = JSON.parse(readFileSync(
  path.join(REPO, 'public', 'data', 'schema', 'fleet.schema.json'), 'utf8'))
const DEFS = schema.$defs

/* A fixed instant, so a failure reproduces byte-for-byte. Nothing below may
   read the wall clock: determinism is one of the properties under test. */
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0)

/* The declared-role vocabulary src/vocab.js ROLES carries a colour and label
   for. The schema deliberately types `role` as any short string — the
   projection must survive a role it has never heard of — so the schema
   cannot hold this list, and it is read from ROLES itself instead: a sample
   node wearing a role ROLES has no entry for would render with a generic
   caption and no ring colour of its own, which is the exact defect this
   file's fix (src/views/computers.js's now-removed graphRole()) existed to
   paper over for the fleet page alone before ROLES covered these roles
   directly. */
const GRAPH_ROLES = new Set(Object.keys(ROLES))

/* A small, honest checker for the subset of JSON Schema the fleet defs use:
   type, enum, $ref, string bounds/pattern/date-time, numeric bounds, array
   bounds. It is not a general validator and must not grow into one — it walks
   exactly the constructs the shipped defs contain, and it fails on an unknown
   field (the defs all declare additionalProperties: false), which is the
   check that catches a sample inventing a field the render never reads. */
function checkValue(value, prop, where) {
  if (prop.$ref) {
    checkObject(value, DEFS[prop.$ref.split('/').at(-1)], where)
    return
  }
  if (prop.enum) {
    assert.ok(prop.enum.includes(value),
      `${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(prop.enum)}`)
    return
  }
  const types = Array.isArray(prop.type) ? prop.type : [prop.type]
  const matches = types.some(type =>
    type === 'string' ? typeof value === 'string'
      : type === 'boolean' ? typeof value === 'boolean'
        : type === 'integer' ? Number.isSafeInteger(value)
          : type === 'number' ? (typeof value === 'number' && Number.isFinite(value))
            : type === 'null' ? value === null
              : type === 'array' ? Array.isArray(value)
                : false)
  assert.ok(matches, `${where}: ${JSON.stringify(value)} is not ${types.join(' | ')}`)
  if (value === null) return
  if (typeof value === 'string') {
    if (prop.minLength !== undefined) assert.ok(value.length >= prop.minLength, `${where}: shorter than ${prop.minLength}`)
    if (prop.maxLength !== undefined) assert.ok(value.length <= prop.maxLength, `${where}: longer than ${prop.maxLength}`)
    if (prop.pattern !== undefined) assert.match(value, new RegExp(prop.pattern), `${where}: fails ${prop.pattern}`)
    if (prop.format === 'date-time') assert.ok(Number.isFinite(Date.parse(value)), `${where}: not a parseable date-time`)
  }
  if (typeof value === 'number') {
    if (prop.minimum !== undefined) assert.ok(value >= prop.minimum, `${where}: below ${prop.minimum}`)
    if (prop.maximum !== undefined) assert.ok(value <= prop.maximum, `${where}: above ${prop.maximum}`)
  }
  if (Array.isArray(value)) {
    if (prop.minItems !== undefined) assert.ok(value.length >= prop.minItems, `${where}: fewer than ${prop.minItems} items`)
    if (prop.maxItems !== undefined) assert.ok(value.length <= prop.maxItems, `${where}: more than ${prop.maxItems} items`)
    value.forEach((item, index) => checkValue(item, prop.items, `${where}[${index}]`))
  }
}

function checkObject(value, def, where) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${where}: not an object`)
  for (const key of def.required || []) {
    assert.ok(Object.hasOwn(value, key), `${where}: schema-required field '${key}' is missing`)
  }
  for (const [key, entry] of Object.entries(value)) {
    const prop = def.properties?.[key]
    assert.ok(prop, `${where}.${key}: not a field the schema names (additionalProperties: false)`)
    checkValue(entry, prop, `${where}.${key}`)
  }
}

test('every graph node satisfies the schema graphNode contract and the graphRole vocabulary', () => {
  const { graph } = sampleFleetData(NOW)
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'the example fleet must have nodes')
  const seen = new Set()
  for (const node of graph.nodes) {
    checkObject(node, DEFS.graphNode, `node ${node?.id}`)
    assert.ok(GRAPH_ROLES.has(node.role),
      `node ${node.id}: role '${node.role}' would fall to the grey default bucket in graphRole()`)
    assert.equal(typeof node.enabled, 'boolean', `node ${node.id}: enabled must be a boolean`)
    assert.ok(!seen.has(node.id), `node id '${node.id}' appears twice`)
    seen.add(node.id)
  }
})

test('computers, services and edges satisfy their schema contracts', () => {
  const { computers, graph } = sampleFleetData(NOW)
  assert.ok(Array.isArray(computers) && computers.length > 0, 'the example fleet must have computers')
  for (const computer of computers) {
    checkObject(computer, DEFS.computer, `computer ${computer?.id}`)
    assert.ok(['observed', 'declared'].includes(computer.sourceKind),
      `computer ${computer.id}: sourceKind '${computer.sourceKind}' has no RECORD_SOURCE sentence`)
    /* The computer ids are the only identifiers here that are not the sample
       roster's own agent names, so they carry the example flavour in the id
       itself — a screenshot of a route or a rail must never read as a real
       machine's identity. */
    assert.match(computer.id, /^sample-/, `computer id '${computer.id}' does not read as an example`)
  }
  for (const edge of graph.edges) {
    checkObject(edge, DEFS.graphEdge, `edge ${edge?.from}->${edge?.to}`)
  }
  assert.ok(Number.isSafeInteger(graph.revision) && graph.revision >= 1, 'graph.revision must be an integer >= 1')
  /* Pinned as a decision, not an accident — see the header comment. */
  assert.ok(!Object.hasOwn(graph, 'contentHash'),
    'graph.contentHash appeared: the sample now claims a fingerprint; decide what stands behind it')
})

test('same nowMs, same record — and nowMs is load-bearing', () => {
  assert.deepStrictEqual(sampleFleetData(NOW), sampleFleetData(NOW))
  assert.deepStrictEqual(sampleAgentsData(NOW), sampleAgentsData(NOW))
  /* If a different instant produced the same record, every timestamp would be
     hard-coded and the "born 4h ago" clocks would age with the build. */
  assert.notDeepStrictEqual(sampleFleetData(NOW), sampleFleetData(NOW + 60_000))
  assert.notDeepStrictEqual(sampleAgentsData(NOW), sampleAgentsData(NOW + 60_000))
})

test('the two views describe one fleet: every declared agent is a node, and they agree', () => {
  const { graph } = sampleFleetData(NOW)
  const agents = sampleAgentsData(NOW)
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  assert.equal(agents.declared.length, graph.nodes.length,
    'the drill-in record and the graph must cover the same seats')
  for (const declared of agents.declared) {
    const node = nodesById.get(declared.id)
    assert.ok(node, `declared agent '${declared.id}' has no node — a drill-in with no door`)
    assert.equal(declared.role, node.role, `'${declared.id}': role differs between the two views`)
    assert.equal(declared.enabled, node.enabled, `'${declared.id}': enabled differs between the two views`)
    assert.equal(declared.displayName, node.label, `'${declared.id}': name differs between the two views`)
    /* The drill-in's runtime clock reads bornAt/stoppedAt from the declared
       record (liveAgentRuntimeSource in src/views/agent.js); a clock that
       disagreed with the card the person just clicked is two fleets. */
    assert.equal(declared.bornAt, node.bornAt, `'${declared.id}': bornAt differs between the two views`)
    assert.equal(declared.stoppedAt, node.stoppedAt, `'${declared.id}': stoppedAt differs between the two views`)
  }
  assert.equal(agents.revision, graph.revision, 'one record, one revision')
})

test('edges and relationships reference only existing agents', () => {
  const { graph } = sampleFleetData(NOW)
  const agents = sampleAgentsData(NOW)
  const nodeIds = new Set(graph.nodes.map(node => node.id))
  assert.ok(graph.edges.some(edge => edge.type === 'manages'), 'the hierarchy needs manages edges')
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from), `edge from '${edge.from}': no such node`)
    assert.ok(nodeIds.has(edge.to), `edge to '${edge.to}': no such node`)
    assert.notEqual(edge.from, edge.to, 'an agent must not manage itself')
  }
  const declaredIds = new Set(agents.declared.map(agent => agent.id))
  const edgeTypes = DEFS.graphEdge.properties.type.enum
  for (const relation of agents.relationships) {
    assert.ok(declaredIds.has(relation.from) && declaredIds.has(relation.to),
      `relationship ${relation.from}->${relation.to}: names an undeclared agent`)
    assert.ok(edgeTypes.includes(relation.type), `relationship type '${relation.type}' is not in the vocabulary`)
    assert.ok(graph.edges.some(edge => edge.from === relation.from
      && edge.to === relation.to && edge.type === relation.type),
    `relationship ${relation.from}->${relation.to} (${relation.type}) differs from the fleet graph`)
  }
})

test('the render\'s honest gaps stay exercised', () => {
  const { graph } = sampleFleetData(NOW)
  const requiredOnly = DEFS.graphNode.required.slice().sort()
  /* At least one seat must carry NOTHING optional, so the "not provided by
     fleet projection" rows are always on screen somewhere in the example. */
  assert.ok(graph.nodes.some(node => Object.keys(node).sort().join(',') === requiredOnly.join(',')),
    'no node omits every optional field — the not-provided rows have gone dark')
  assert.ok(graph.nodes.some(node => node.enabled === false), 'no disabled seat in the example')
  assert.ok(graph.nodes.some(node => node.origin === 'user'), 'no owner-started seat in the example')
  assert.ok(graph.nodes.some(node => node.origin === 'self'), 'no self-started seat in the example')
  /* The released lane: both ends of a runtime, in the order the render
     requires (it discards stoppedAt < bornAt as nonsense). */
  assert.ok(graph.nodes.some(node => Number.isSafeInteger(node.bornAt)
    && Number.isSafeInteger(node.stoppedAt) && node.stoppedAt >= node.bornAt),
  'no seat shows a completed runtime')
  /* Most seats carry a birth time; a fleet of mostly unmeasured seats would
     demonstrate the empty render, which already has its own screen. */
  const born = graph.nodes.filter(node => Number.isSafeInteger(node.bornAt)).length
  assert.ok(born * 2 > graph.nodes.length, 'most nodes should carry bornAt')
})

test('observedSessions says what the example world can honestly say', () => {
  const agents = sampleAgentsData(NOW)
  /* agent.js reads `ok` to choose between "not matched by name" (true) and
     "could not be read" (false). The example world HAS a run record of its
     own (src/sample-activity.js), so claiming it could not be read would be
     the lie; the sessions are simply not matched to seats by name. */
  assert.equal(agents.observedSessions.ok, true)
  assert.equal(agents.observedSessions.reason, null)
})
