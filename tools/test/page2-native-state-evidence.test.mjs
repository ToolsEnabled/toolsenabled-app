import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { fleetOverviewSnapshot } from '../../src/fleet-overview.js'
import { createTreeWorkController } from '../../src/tree-bounded-work.js'
import { assertReadOnlyIdentity, assertOverviewEvidence, assertStartingEvidence, assertConfinementEvidence,
  assertToolsEvidence, assertProfilesEvidence, assertBoundedPanelEvidence, beginObservedStart } from '../lib/page2-native-state-evidence.cjs'
import { assertVerifiedSessionSnapshot } from '../lib/page2-native-functions-scenarios.cjs'
import { selectScenarios, unavailable } from '../lib/page2-native-report.cjs'
import { scenarios as shared } from '../lib/page2-native-scenarios.cjs'
import { scenarios as controls } from '../lib/page2-native-controls-scenarios.cjs'
import { scenarios as bounded } from '../lib/page2-native-bounded-scenarios.cjs'

const clone = value => structuredClone(value)
const node = (status = 'finished') => ({ id: 'child', treeId: 'tree', parentId: 'parent', sessionId: status === 'draft' ? null : 'session-child',
  role: 'worker', tier: 'astra', effort: 'max', status, message: 'Owned fixture brief.' })
const parent = { ...node(), id: 'parent', parentId: null, sessionId: 'session-parent', role: 'manager' }
function readEvidence(status = 'finished') {
  const before = { computerId: 'computer', nodes: [parent, node(status)] }
  return { before, after: clone(before), nodeId: 'child', ledgerBefore: Buffer.from('owned bytes\n'), ledgerAfter: Buffer.from('owned bytes\n') }
}
test('a read binds the selected identity and every saved sibling to exact signed ledger bytes', () => {
  const value = readEvidence()
  assert.equal(assertReadOnlyIdentity(value).sessionId, 'session-child')
})
for (const [label, mutate] of [
  ['unknown node', v => { v.nodeId = 'missing' }],
  ['duplicated selected node', v => { v.before.nodes.push(node()) }],
  ['other computer', v => { v.after.computerId = 'other' }],
  ['replaced selected session', v => { v.after.nodes[1].sessionId = 'other' }],
  ['changed sibling', v => { v.after.nodes[0].sessionId = 'other' }],
  ['changed brief', v => { v.after.nodes[1].message = 'Other instructions' }],
  ['changed state', v => { v.after.nodes[1].status = 'running' }],
  ['missing sibling', v => { v.after.nodes.shift() }],
  ['ledger append', v => { v.ledgerAfter = Buffer.from('owned bytes\nextra') }],
  ['string instead of bytes', v => { v.ledgerBefore = 'owned bytes\n' }],
]) test(`read identity refuses ${label}`, () => {
  const value = readEvidence(); mutate(value)
  assert.throws(() => assertReadOnlyIdentity(value))
})

function overviewEvidence(status = 'finished') {
  const value = readEvidence(status)
  const expectedState = status === 'interrupted' ? 'review' : status
  return { ...value, expectedState, display: { mode: 'live', projection: 'available', treeId: 'tree', agents: 2,
    stateKeys: expectedState === 'finished' ? ['finished'] : ['finished', expectedState],
    states: expectedState === 'finished' ? { finished: 2 } : { finished: 1, [expectedState]: 1 } } }
}
test('the actual product store and overview classifier supply draft, finished and interrupted counts', () => {
  const memory = new Map(); let next = 0
  const store = createFleetTreeStore({ computerId: 'computer', makeId: kind => `${kind}-${++next}`,
    storage: { read: key => memory.get(key) || null, write: (key, value) => { memory.set(key, JSON.stringify(value)); return true } } })
  const created = store.addNode({ role: 'worker', message: 'Offline native proof validator; never sent.' })
  assert.equal(created.ok, true)
  const id = created.node.id
  for (const [status, expectedState] of [['draft', 'draft'], ['finished', 'finished'], ['interrupted', 'review']]) {
    if (status === 'finished') assert.equal(store.attachSession(id, 'real-fixture-session').ok, true)
    assert.equal(store.setNodeStatus(id, status).ok, true)
    const before = store.snapshot()
    const projection = fleetOverviewSnapshot(store, new Set(['real-fixture-session']))
    const tree = projection.trees.find(row => row.id === before.nodes[0].treeId)
    const states = Object.fromEntries(['draft', 'finished', 'review', 'working', 'unconfirmed'].filter(key => tree[key]).map(key => [key, tree[key]]))
    const proof = assertOverviewEvidence({ before, after: store.snapshot(), nodeId: id, expectedState,
      ledgerBefore: Buffer.alloc(0), ledgerAfter: Buffer.alloc(0),
      display: { mode: 'live', projection: 'available', treeId: tree.id, agents: tree.agents, states, stateKeys: Object.keys(states) } })
    assert.equal(proof.expectedState, expectedState)
    assert.equal(proof.counts[expectedState], 1)
  }
})
for (const [label, mutate] of [
  ['a different tree with the same counts', v => { v.display.treeId = 'other-tree' }],
  ['an example view', v => { v.display.mode = 'simulated' }],
  ['missing projection', v => { v.display.projection = 'unavailable' }],
  ['omitted finished sibling', v => { v.display.states.finished = 1 }],
  ['extra review count', v => { v.display.states.review = 1 }],
  ['duplicated state badge', v => { v.display.stateKeys.push('finished') }],
  ['wrong tree size', v => { v.display.agents = 1 }],
  ['invented review classification', v => { v.expectedState = 'review' }],
  ['unknown sibling ownership', v => { v.before.nodes[0] = { ...parent, status: 'running' }; v.after = clone(v.before) }],
]) test(`overview refuses ${label}`, () => {
  const value = overviewEvidence(); mutate(value)
  assert.throws(() => assertOverviewEvidence(value))
})
test('an actual interrupted node can prove review without classifying its sibling as interrupted', () => {
  assert.deepEqual(assertOverviewEvidence(overviewEvidence('interrupted')).counts, { finished: 1, review: 1 })
})

function startEvidence() {
  const before = { computerId: 'computer', nodes: [{ ...node('draft'), parentId: null }] }
  const starting = clone(before); starting.nodes[0].status = 'starting'
  const after = clone(starting); after.nodes[0].status = 'finished'; after.nodes[0].sessionId = 'session-child'
  return { before, starting, after, startingAt: 10, nodeId: 'child', records: [
    { sequence: 1, action: 'agent_session_start', sessionId: 'session-child', details: { agentId: 'child' } },
    { sequence: 2, action: 'agent_session_outcome', sessionId: 'session-child', outcome: { resolves: 1, result: 'started' } },
  ] }
}
test('an observed draft to starting to finished sequence binds its one successful start', () => {
  assert.equal(assertStartingEvidence(startEvidence()).sessionId, 'session-child')
})
for (const [label, mutate] of [
  ['missing starting observation', v => { v.starting = clone(v.after) }],
  ['earlier existing session', v => { v.before.nodes[0].sessionId = 'old-session' }],
  ['wrong observed session', v => { v.starting.nodes[0].sessionId = 'other-session' }],
  ['changed requested tier', v => { v.starting.nodes[0].tier = 'sol' }],
  ['changed selected folder profile', v => { v.starting.nodes[0].profileId = 'foreign-profile' }],
  ['unrelated final node', v => { v.after.nodes[0].id = 'other' }],
  ['failed actual provider turn', v => { v.after.nodes[0].status = 'turn-failed' }],
  ['refused start intent', v => { v.records[1].outcome.result = 'refused' }],
  ['duplicate successful start', v => { v.records.push(clone(v.records[0])) }],
  ['unrelated signed identity', v => { v.records[0].details.agentId = 'other' }],
]) test(`starting observation refuses ${label}`, () => {
  const value = startEvidence(); mutate(value)
  assert.throws(() => assertStartingEvidence(value))
})
test('starting retains each unrelated saved node across every observation boundary', () => {
  const value = startEvidence()
  const sibling = { ...node('draft'), id: 'unrelated', treeId: 'unrelated-tree', parentId: null, profileId: 'unrelated-profile' }
  for (const phase of ['before', 'starting', 'after']) value[phase].nodes.push(clone(sibling))
  assert.equal(assertStartingEvidence(value).sessionId, 'session-child')
  for (const phase of ['starting', 'after']) for (const field of ['sessionId', 'profileId', 'parentId', 'treeId', 'role', 'tier', 'effort', 'status', 'message']) {
    const changed = clone(value)
    changed[phase].nodes[1][field] = 'changed-unrelated-value'
    assert.throws(() => assertStartingEvidence(changed), `${phase}: ${field}`)
  }
})
test('a missed natural starting window produces explicit unavailable and no synthetic state', async () => {
  const events = []
  const context = { page: { evaluate: async () => [startEvidence().before], waitForFunction: async () => { events.push('read armed'); throw new Error('real observation timed out') } },
    step: async (id, action) => { events.push(id); return action() }, unavailable }
  await assert.rejects(beginObservedStart(context, 'child', async () => { events.push('visible click') }), { code: 'NATIVE_AUDIT_UNAVAILABLE' })
  assert.deepEqual(events, ['read armed', 'state-root-visible-start-action', 'visible click'])
})

const confinement = () => ({ ok: true, tier: 'standard', sandbox: 'workspace-write', approvalPolicy: 'never', isolated: true,
  recorded: true, failedClosed: false, toolsAllowed: 1, toolsTotal: 2 })
const tools = () => ({ ok: true, tier: 'standard', total: 2, tools: [{ name: 'agent_list', allowed: true, gated: false }, { name: 'file_write', allowed: false, gated: true }] })
test('permission and tool reads reconcile the chosen level, actual count and all named rows', () => {
  assert.equal(assertConfinementEvidence(confinement(), 'standard', 'standard · Files in the workspace').sandbox, 'workspace-write')
  assert.equal(assertToolsEvidence(tools(), confinement()).toolsAllowed, 1)
})
for (const [label, mutate] of [
  ['permission fallback', v => { v.failedClosed = true }],
  ['unrecorded choice', v => { v.recorded = false }],
  ['different level', v => { v.tier = 'guided' }],
  ['different sandbox', v => { v.sandbox = 'read-only' }],
  ['unknown count', v => { v.toolsTotal = null }],
]) test(`confinement refuses ${label}`, () => {
  const value = confinement(); mutate(value)
  assert.throws(() => assertConfinementEvidence(value, 'standard', 'standard · Files in the workspace'))
})
for (const [label, mutate] of [
  ['omitted tool with forged total', v => { v.tools.pop() }],
  ['omitted tool with lowered total', v => { v.tools.pop(); v.total = 1 }],
  ['duplicate name', v => { v.tools[1].name = v.tools[0].name }],
  ['unreviewed allowance', v => { v.tools[1].allowed = true }],
  ['absent gate flag', v => { delete v.tools[0].gated }],
  ['wrong returned tier', v => { v.tier = 'unrestricted' }],
]) test(`tool list refuses ${label}`, () => {
  const value = tools(); mutate(value)
  assert.throws(() => assertToolsEvidence(value, confinement()))
})

function profileEvidence(present = true) {
  const expected = { id: 'picked-id', name: 'Named native QA folder', cwd: 'C:\\owned\\qa-folder' }
  const profiles = present ? [expected] : []
  const bytes = Buffer.from(JSON.stringify({ v: 1, profiles: profiles.map(profile => ({ ...profile, createdAt: '2026-09-08T00:00:00Z' })) }))
  return { value: { ok: true, profiles }, fileBefore: bytes, fileAfter: Buffer.from(bytes), expected, present }
}
test('profile reads match actual saved bytes after native creation and removal', () => {
  for (const present of [true, false]) assert.equal(assertProfilesEvidence(profileEvidence(present)).present, present)
})
for (const [label, mutate] of [
  ['changed file during read', v => { v.fileAfter = Buffer.from('{}') }],
  ['stale empty list', v => { v.value.profiles = [] }],
  ['foreign profile ID', v => { v.expected.id = 'foreign-id' }],
  ['different chosen folder', v => { v.expected.cwd = 'C:\\other' }],
  ['removal that retained the target', v => { v.present = false }],
]) test(`profile evidence refuses ${label}`, () => {
  const value = profileEvidence(); mutate(value)
  assert.throws(() => assertProfilesEvidence(value))
})
test('history uses the maintained full projection verifier and refuses wrong or changed raw bytes', () => {
  const record = { sequence: 1, at: '2026-09-08T00:00:00Z', action: 'agent_session_start', sessionId: 'session-child' }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  const history = { ok: true, verified: true, total: 1, entries: [{ ...record, principal: null, outcome: null, usage: null, end: null }] }
  const value = { history, ledgerBefore: bytes, ledgerAfter: Buffer.from(bytes) }
  assert.equal(assertVerifiedSessionSnapshot(value).verifiedHistoryTotal, 1)
  for (const changed of [{ ...history, verified: false }, { ...history, total: 2 }, { ...history, entries: [] },
    { ...history, entries: [{ ...history.entries[0], sessionId: 'foreign' }] }]) assert.throws(() => assertVerifiedSessionSnapshot({ ...value, history: changed }))
  assert.throws(() => assertVerifiedSessionSnapshot({ ...value, ledgerAfter: Buffer.from('changed') }))
})

function boundedEvidence(phase = 'idle') {
  const value = readEvidence()
  return { ...value, nodeId: undefined, phase, parent: clone(parent), rows: [], statuses: [],
    display: { kind: 'launch', startEnabled: true, stopEnabled: false, message: 'Write a brief for the child work.', rows: [] } }
}
test('idle evidence is the actual initial controller state, with no started or closable work', () => {
  const controller = createTreeWorkController({ kind: 'launch', start: () => assert.fail('No start was authorized'), readStatus: () => assert.fail('No session exists'), close: () => assert.fail('No close was authorized') })
  const state = controller.getState()
  assert.equal(state.phase, 'idle'); assert.equal(state.message, ''); assert.equal(state.stoppable, false)
  assert.equal(assertBoundedPanelEvidence(boundedEvidence()).phase, state.phase)
})
function completedEvidence() {
  const value = boundedEvidence('completed')
  value.rows = [{ nodeId: 'child', sessionId: 'session-child' }]
  value.statuses = [{ ok: true, state: 'closed', sessionId: 'session-child', nodeId: 'child', parentNodeId: 'parent', parentSessionId: 'session-parent', endRecord: { sequence: 3, eventHash: 'a'.repeat(64) } }]
  value.display.message = 'The host confirmed all started work closed. No further run is scheduled.'
  value.display.rows = [{ ...value.rows[0], phase: 'closed' }]
  return value
}
test('completed evidence retains exact rows and signed ending identity after host closure', () => {
  assert.equal(assertBoundedPanelEvidence(completedEvidence()).rows[0].sessionId, 'session-child')
})
for (const [label, mutate] of [
  ['enabled Stop', v => { v.display.stopEnabled = true }],
  ['wrong control panel', v => { v.display.kind = 'team' }],
  ['unconfirmed closure message', v => { v.display.message = 'Some sessions are not confirmed closed.' }],
  ['missing retained row', v => { v.display.rows = [] }],
  ['other displayed session', v => { v.display.rows[0].sessionId = 'other' }],
  ['status for another session', v => { v.statuses[0].sessionId = 'other' }],
  ['different parent session', v => { v.statuses[0].parentSessionId = 'other' }],
  ['unsigned ending', v => { delete v.statuses[0].endRecord }],
  ['idle label borrowed from a completed panel', v => { v.phase = 'idle' }],
]) test(`bounded state refuses ${label}`, () => {
  const value = completedEvidence(); mutate(value)
  assert.throws(() => assertBoundedPanelEvidence(value))
})
test('the direct native profile command has an executable root identity prerequisite', () => {
  const selected = selectScenarios([...shared, ...controls, ...bounded], ['named-profile-create-refresh']).map(row => row.id)
  assert.ok(selected.indexOf('root-set') < selected.indexOf('named-profile-create-refresh'))
  assert.equal(selected.includes('root-start'), false, 'Reading a named profile needs no new provider start')
})
test('the helper has no bridge mutation calls or renderer storage writes', () => {
  const code = readFileSync(new URL('../lib/page2-native-state-evidence.cjs', import.meta.url), 'utf8')
  const methods = [...code.matchAll(/window\.mcAgent\.(\w+)\(/g)].map(match => match[1])
  assert.deepEqual([...new Set(methods)].sort(), ['confinement', 'history', 'profiles', 'tools', 'workStatus'])
  assert.doesNotMatch(code, /localStorage\.(?:setItem|removeItem|clear)\(/)
})
