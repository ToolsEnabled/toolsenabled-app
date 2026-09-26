import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parseBoundedWork, createBoundedTreeAuthority } = require('../../shell/tree-bounded-work.cjs')

function fixture() {
  const parent = { owner: 'window-1', sessionId: 'parent-session', nodeId: 'parent', treeId: 'root', selfName: 'Parent',
    treeAnchors: ['root', 'parent'], cwd: '/chosen', permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' } }
  const graph = { computerId: 'computer', trees: [{ id: 'tree', profileId: 'profile' }], nodes: [
    { id: 'root', treeId: 'tree', parentId: null, sessionId: 'root-session' },
    { id: 'parent', treeId: 'tree', parentId: 'root', sessionId: 'parent-session' },
    { id: 'child', treeId: 'tree', parentId: 'parent', sessionId: null, role: 'worker', tier: 'astra' },
  ] }
  const request = { sessionId: 'child-session', agentId: 'child', tier: 'astra', role: { id: 'worker' }, cwd: '/chosen',
    treeIdentity: { selfName: 'Child', managerName: 'Parent' },
    requestKeys: { threadId: 'child', treeAnchors: ['root', 'parent', 'child'] },
    boundedWork: { computerId: 'computer', treeId: 'tree', parentNodeId: 'parent', parentSessionId: 'parent-session', capMs: 1000 } }
  let time = 0, profile = '/chosen', live = parent
  const authority = createBoundedTreeAuthority({ readParent: () => live, readTree: () => graph,
    resolveProfile: () => profile, defaultCwd: () => '/default', now: () => time, wallNow: () => 10000 })
  return { authority, parent, graph, request, time: value => { time = value }, profile: value => { profile = value }, live: value => { live = value } }
}

test('bounded owner work binds the actual saved child, exact live parent, role, profile and audit identity', () => {
  const f = fixture(), permit = f.authority.begin(f.request, 'window-1')
  permit.assertStart()
  assert.equal(permit.details.action, 'tree.dispatch')
  assert.equal(permit.details.nodeId, 'child')
  assert.equal(permit.details.parentNodeId, 'parent')
  assert.equal(permit.details.agentId, 'child')
  assert.equal(permit.details.deadlineAt, 11000)
  f.graph.nodes[2].sessionId = 'child-session'
  permit.assertStart()
  f.time(999); assert.equal(permit.remainingMs(), 1)
  f.time(1000); assert.throws(() => permit.assertStart(), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
})

for (const [name, change] of [
  ['ended parent', f => f.live(null)],
  ['replaced parent', f => { f.parent.sessionId = 'new-session' }],
  ['other owner', f => { f.parent.owner = 'window-2' }],
  ['reparented child', f => { f.graph.nodes[2].parentId = 'root' }],
  ['moved parent', f => { f.graph.nodes[1].parentId = null }],
  ['removed child', f => { f.graph.nodes.pop() }],
  ['duplicate child', f => { f.graph.nodes.push({ ...f.graph.nodes[2] }) }],
  ['changed role', f => { f.graph.nodes[2].role = 'controller' }],
  ['changed model', f => { f.graph.nodes[2].tier = 'luna' }],
  ['changed tree profile', f => { f.graph.trees[0].profileId = 'other' }],
  ['changed profile folder', f => f.profile('/elsewhere')],
  ['changed scope', f => { f.parent.permissionSession.tier = 'unrestricted' }],
]) test(`final root admission refuses ${name}`, () => {
  const f = fixture(), permit = f.authority.begin(f.request, 'window-1')
  change(f)
  assert.throws(() => permit.assertStart(), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
})

test('owner bounded starts cannot borrow agent delegation or reset a resumed cap', () => {
  for (const field of ['delegationPermit', 'resumeThreadId', 'replacesSessionId', 'accountRecovery']) {
    const f = fixture(); f.request[field] = 'unrelated'
    assert.throws(() => f.authority.begin(f.request, 'window-1'), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
  }
})

test('cap and parent request shapes have a closed vocabulary', () => {
  for (const change of [value => { value.capMs = 0 }, value => { value.capMs = Infinity },
    value => { value.capMs = 86400001 }, value => { value.capMs = 1.5 }, value => { value.parentNodeId = '../other' },
    value => { value.launchId = 'made-up' }, value => { delete value.treeId }]) {
    const { boundedWork } = fixture().request; change(boundedWork)
    assert.throws(() => parseBoundedWork(boundedWork), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
  }
})
