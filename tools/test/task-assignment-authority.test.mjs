import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const { createTaskAssignmentAuthority } = require_(path.join(ROOT, 'shell', 'task-assignment-target-authority.cjs'))

function fixture() {
  const sessions = new Map([['worker-session', {
    sessionId: 'worker-session', state: 'ready', closeRequested: false,
    agentId: 'worker-seat', roleId: 'worker',
    treeNodeKey: 'worker-node', threadId: 'worker-thread',
    treeRequestIdentity: { treeAnchors: ['root-node', 'controller-node', 'worker-node'] },
    requestedModelTier: 'luna', provider: 'codex',
    nativeModeSettings: { model: 'gpt-test' }, effort: 'low',
  }]])
  const org = {
    ok: true,
    org: { revision: 7, agents: [
      { id: 'controller-seat', enabled: true, role: 'manager' },
      { id: 'worker-seat', enabled: true, role: 'worker' },
    ] },
    roles: [{ id: 'manager', revision: 2 }, { id: 'worker', revision: 3 }],
  }
  const current = {
    actor: 'agent', agentId: 'controller-seat', sessionId: 'controller-session', nodeId: 'controller-node',
    hostSessionId: 'app-host-session', treeId: 'root-node',
    treeAnchors: ['root-node', 'controller-node'], roleId: 'manager', roleRevision: 2,
    orgRevision: 7,
  }
  return { sessions, org, current }
}

test('host assignment authority binds a live target and rejects revision/session drift', () => {
  const f = fixture()
  const authority = createTaskAssignmentAuthority({
    readOrg: () => f.org,
    readSessions: () => f.sessions,
    readCurrentCoordinator: () => f.current,
    readSettings: () => ({ values: { 'agent.task_difficulty_enabled': true }, rejected: [], revision: 7 }),
    resolveTargetConfiguration: session => ({
      tier: session.requestedModelTier, provider: session.provider,
      model: session.nativeModeSettings.model, effort: session.effort,
    }),
  })
  const task = { id: 'T1', scope: 'tree', scopeKey: 'root-node', status: 'in-progress', difficulty: 'easy', failedReviewCount: 0 }
  const bound = authority.resolveAssignmentAuthority({ task, nodeId: 'worker-node', assignmentId: 'assignment-1' })
  assert.deepEqual(bound.target, {
    targetAgentId: 'worker-node', agentId: 'worker-seat', nodeId: 'worker-node', roleId: 'worker', scope: 'tree', scopeKey: 'worker-node', ownerNodeId: 'worker-node',
    sessionId: 'worker-session', treeId: 'root-node',
    treeAnchors: ['root-node', 'controller-node', 'worker-node'], threadId: 'worker-thread',
  })
  assert.equal(bound.authorityRevision, 7)
  assert.deepEqual(bound.locality, { sameHost: true, sameTree: true })
  assert.equal(bound.targetConfiguration.model, 'gpt-test')
  assert.equal(typeof bound.assertCurrent, 'function')
  bound.assertCurrent()
  assert.equal(typeof authority.assertCurrent, 'function')
  authority.assertCurrent()

  const globalBound = authority.resolveAssignmentAuthority({
    task: { id: 'T-global', scope: 'global', status: 'open' },
    nodeId: 'worker-node', assignmentId: 'global-assignment',
  })
  assert.equal(globalBound.target.scope, 'tree')
  assert.equal(globalBound.target.scopeKey, 'worker-node')
  assert.equal(globalBound.target.ownerNodeId, 'worker-node')

  const replay = authority.resolveAssignmentAuthority({
    task: { id: 'T-global', scope: 'tree', scopeKey: 'worker-node', status: 'in-progress' },
    nodeId: 'worker-node', assignmentId: 'global-assignment',
    assignmentReplayContext: {
      kind: 'task-assignment-replay', taskId: 'T-global', assignmentId: 'global-assignment',
      source: { scope: 'global', scopeKey: null, ownerNodeId: null, coreSha256: 'a'.repeat(64) },
      targetAgentId: globalBound.targetAgentId, target: globalBound.target,
      targetConfiguration: globalBound.targetConfiguration,
      authorityRevision: globalBound.authorityRevision,
      authorityReceipt: globalBound.authorityReceipt,
      actor: 'codex', reason: 'retry the same assignment',
    },
  })
  assert.deepEqual(replay.target, globalBound.target, 'replay rebinds the original source while retaining recipient ownership')

  f.current.hostSessionId = 'replacement-host-session'
  assert.throws(() => authority.assertCurrent(), { code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED' })
  f.current.hostSessionId = 'app-host-session'

  f.sessions.get('worker-session').state = 'ended'
  assert.throws(() => bound.assertCurrent(), { code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED' })
})

test('host assignment authority binds thread scope to the saved node, not provider conversation', () => {
  const f = fixture()
  const authority = createTaskAssignmentAuthority({
    readOrg: () => f.org,
    readSessions: () => f.sessions,
    readCurrentCoordinator: () => f.current,
    readSettings: () => ({ values: { 'agent.task_difficulty_enabled': true }, rejected: [], revision: 7 }),
    resolveTargetConfiguration: () => ({ tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' }),
  })
  const task = { id: 'T-thread', scope: 'thread', scopeKey: 'controller-node', status: 'open' }
  const bound = authority.resolveAssignmentAuthority({ task, nodeId: 'worker-node', assignmentId: 'thread-assignment' })
  assert.equal(bound.target.nodeId, 'worker-node')
  assert.equal(bound.target.scope, 'thread')
  assert.equal(bound.target.scopeKey, 'worker-node')
  assert.equal(bound.target.ownerNodeId, 'worker-node')
  assert.equal(bound.target.threadId, 'worker-thread')
  assert.throws(() => authority.resolveAssignmentAuthority({
    task: { ...task, scopeKey: 'worker-thread' }, nodeId: 'worker-node', assignmentId: 'provider-thread-key',
  }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })
})

test('host assignment authority freezes coordinator scalars and refuses duplicate or sibling targets', () => {
  const f = fixture()
  const authority = createTaskAssignmentAuthority({
    readOrg: () => f.org,
    readSessions: () => f.sessions,
    readCurrentCoordinator: () => f.current,
    readSettings: () => ({ values: { 'agent.task_difficulty_enabled': true }, rejected: [], revision: 7 }),
    resolveTargetConfiguration: () => ({ tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' }),
  })
  const task = { id: 'T1', scope: 'tree', scopeKey: 'root-node', status: 'open', difficulty: 'easy', failedReviewCount: 0 }
  assert.throws(() => authority.resolveAssignmentAuthority({ task, nodeId: 'missing-node', assignmentId: 'a-1' }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_UNKNOWN' })
  f.org.org.agents.push({ id: 'worker-seat', enabled: true, role: 'worker' })
  assert.throws(() => authority.resolveAssignmentAuthority({ task, nodeId: 'worker-node', assignmentId: 'a-2' }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })
  f.org.org.agents.pop()
  f.sessions.get('worker-session').treeRequestIdentity.treeAnchors = ['root-node', 'sibling-node', 'worker-node']
  assert.throws(() => authority.resolveAssignmentAuthority({ task, nodeId: 'worker-node', assignmentId: 'a-3' }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })
  f.sessions.get('worker-session').treeRequestIdentity.treeAnchors = ['root-node', 'controller-node', 'worker-node']
  f.sessions.get('worker-session').treeRequestIdentity.treeAnchors = ['other-root', 'worker-node']
  assert.throws(() => authority.resolveAssignmentAuthority({ task, nodeId: 'worker-node', assignmentId: 'a-4' }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })
})

/* T1736: hand-out is a role function, so the host authority must serve a
 * Builder exactly as it serves a Manager: its own children only, and a second
 * claimant is told who already holds the task. */
function builderTree() {
  const live = (sessionId, agentId, nodeId, treeAnchors) => [sessionId, {
    sessionId, state: 'ready', closeRequested: false, agentId, roleId: 'worker',
    treeNodeKey: nodeId, threadId: nodeId + '-thread', treeRequestIdentity: { treeAnchors },
    requestedModelTier: 'luna', provider: 'codex', nativeModeSettings: { model: 'gpt-test' }, effort: 'low',
  }]
  const sessions = new Map([
    live('b-child-session', 'b-child-seat', 'b-child', ['root-node', 'controller-node', 'builder-b', 'b-child']),
    live('b-grandchild-session', 'b-grandchild-seat', 'b-grandchild', ['root-node', 'controller-node', 'builder-b', 'b-child', 'b-grandchild']),
    live('c-child-session', 'c-child-seat', 'c-child', ['root-node', 'controller-node', 'builder-c', 'c-child']),
  ])
  const org = {
    ok: true,
    org: { revision: 9, agents: [
      { id: 'builder-b', nodeId: 'builder-b', displayName: 'Builder 11 (bbbb0001)', enabled: true, role: 'builder' },
      { id: 'builder-c', nodeId: 'builder-c', displayName: 'Builder 13 (cccc0001)', enabled: true, role: 'builder' },
      { id: 'b-child-seat', nodeId: 'b-child', displayName: 'Worker 5 (b0b00001)', enabled: true, role: 'worker' },
      { id: 'b-grandchild-seat', nodeId: 'b-grandchild', displayName: 'Worker 6 (b0b00002)', enabled: true, role: 'worker' },
      { id: 'c-child-seat', nodeId: 'c-child', displayName: 'Worker 7 (c0c00001)', enabled: true, role: 'worker' },
    ] },
    roles: [{ id: 'builder', revision: 4 }, { id: 'worker', revision: 3 }],
  }
  const coordinator = (agentId, nodeId, treeAnchors, roleId) => ({
    actor: 'agent', agentId, sessionId: agentId + '-session', nodeId, hostSessionId: 'app-host-session',
    treeId: 'root-node', treeAnchors, roleId, roleRevision: roleId === 'builder' ? 4 : 3, orgRevision: 9,
  })
  const authorityFor = current => createTaskAssignmentAuthority({
    readOrg: () => org,
    readSessions: () => sessions,
    readCurrentCoordinator: () => current,
    readSettings: () => ({ values: { 'agent.task_difficulty_enabled': true }, rejected: [], revision: 9 }),
    resolveTargetConfiguration: () => ({ tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' }),
  })
  return {
    builderB: authorityFor(coordinator('builder-b', 'builder-b', ['root-node', 'controller-node', 'builder-b'], 'builder')),
    builderC: authorityFor(coordinator('builder-c', 'builder-c', ['root-node', 'controller-node', 'builder-c'], 'builder')),
    owner: authorityFor(coordinator('b-child-seat', 'b-child', ['root-node', 'controller-node', 'builder-b', 'b-child'], 'worker')),
  }
}

test('a Builder hands its own child a task, never another subtree, and a second claimant is told the current owner (T1736)', () => {
  const { builderB, builderC, owner } = builderTree()
  const task = { id: 'T1239', scope: 'tree', scopeKey: 'controller-node', status: 'open' }
  const bound = builderB.resolveAssignmentAuthority({ task, nodeId: 'b-child', assignmentId: 'hand-out-b-1' })
  assert.equal(bound.target.ownerNodeId, 'b-child')
  assert.equal(bound.target.roleId, 'worker')
  assert.equal(bound.coordinator.roleId, 'builder')
  assert.deepEqual(bound.locality, { sameHost: true, sameTree: true })
  // Outside its own subtree: Builder B cannot pick Builder C's child.
  assert.throws(() => builderB.resolveAssignmentAuthority({ task, nodeId: 'c-child', assignmentId: 'hand-out-b-2' }),
    { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })

  // The store records the hand-out: owner b-child, scope moved to its node.
  const owned = { ...task, scope: 'tree', scopeKey: 'b-child', status: 'in-progress', ownerState: 'assigned', ownerNodeId: 'b-child' }
  // A second claimant is refused by name, before any target is read.
  for (const [claimant, nodeId] of [[builderC, 'c-child'], [builderC, 'not-a-live-node'], [builderB, 'b-grandchild']]) {
    assert.throws(() => claimant.resolveAssignmentAuthority({ task: owned, nodeId, assignmentId: 'hand-out-second' }), error => {
      assert.equal(error.code, 'T_LEDGER_ASSIGNMENT_ALREADY_OWNED')
      assert.match(error.message, /^T1239 is already assigned to Worker 5 \(b0b00001\), node b-child\. /)
      assert.match(error.message, /No task was changed\.$/)
      return true
    })
  }
  // The owner itself may hand it on to its own child.
  const onward = owner.resolveAssignmentAuthority({ task: owned, nodeId: 'b-grandchild', assignmentId: 'hand-out-owner-1' })
  assert.equal(onward.target.ownerNodeId, 'b-grandchild')
  // A task that is out of scope but not assigned keeps the generic refusal.
  assert.throws(() => builderC.resolveAssignmentAuthority({
    task: { id: 'T9', scope: 'tree', scopeKey: 'b-child', status: 'open' }, nodeId: 'c-child', assignmentId: 'hand-out-c-9',
  }), { code: 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED' })
})
