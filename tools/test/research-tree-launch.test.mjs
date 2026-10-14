import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { prepareRetainedSourceFixture } from './lib/source-fixture-root.mjs'
import { createFleetTreeStore, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { executeCreateAndStartNode } from '../../src/create-and-start-node.js'
import { nodeManagerContext, composeNodeBrief } from '../../src/tree-node-brief.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import test from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { bindResearchTreeSession, withResearchTreeBinding } from '../../src/research-tree-session.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { refusalCodeOf } from '../../src/refusal-copy.js'

// Execute the complete exported launch declarations from the actual view.
// Remove only their module export keyword for the same source extraction seam
// used by tree-start-cleanup-retention.test.mjs. Browser presentation and native
// IPC are the fixture; the launch flow, retained identity and binder are real.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  .replace(/^export (?=(?:async )?function )/gm, '')
const declarations = ['withRetainedStartIdentity', 'endedAgentStartOutcome', 'startAgentForNode']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const projectId = 'rp-0123456789abcdef'
const project = { projectId, name: 'Authoritative research title', status: 'active', enabled: false }
const deferred = () => {
  let resolve
  const promise = new Promise(answer => { resolve = answer })
  return { promise, resolve }
}

function fixture({ missingProject = false, assignGate = null, closeFails = false } = {}) {
  const calls = { starts: [], sends: [], closes: [], assigned: [], opened: [], cleanup: [], order: [] }
  const assignmentEntered = deferred()
  const native = {
    async start(request) {
      calls.starts.push(request); calls.order.push('native.start')
      return { sessionId: request.sessionId, threadId: 'provider-thread', roleIntroduction: 'Configured role' }
    },
    async send(request) {
      calls.sends.push(request); calls.order.push('native.send')
      return { sessionId: request.sessionId, turnId: 'accepted-turn' }
    },
    async close(request) {
      calls.closes.push(request); calls.order.push('native.close')
      if (closeFails) throw new Error('Close refused')
      return { sessionId: request.sessionId, closed: true }
    },
  }
  const bind = args => bindResearchTreeSession({
    ...args, requireDestination: false,
    snapshot: async () => {
      calls.order.push('research.snapshot')
      return { ok: true, receipt: { projects: missingProject ? [] : [project] } }
    },
    postAction: async (action, body) => {
      calls.assigned.push({ action, body }); calls.order.push('research.assign')
      assignmentEntered.resolve()
      if (assignGate) await assignGate.promise
      calls.order.push('research.receipt')
      return { ok: true, receipt: { projectId, assigned: [{
        assignmentId: 'ra-abcdef0123456789', disposition: 'assigned',
        kind: 'observed', ref: body.assign[0].ref,
      }], unassigned: [] } }
    },
  })
  const scope = {
    window: { mcAgent: native },
    withResearchTreeBinding: (bridge, options = {}) => withResearchTreeBinding(bridge, { ...options, bind, requireDestination: false }),
    currentDataSource: () => 'local', isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'agent-session', START_NEEDS_APP_TEXT: () => 'Needs app',
    exampleBoardText: () => 'Example', startControlOffReason: () => 'Starting is off',
    refusalCode, refusalCodeOf,
    readerRemedy: sentence => sentence,
    startRefusalSentence: result => result?.reason || result?.code || 'Start refused',
    sendRefusalSentence: result => result?.reason || result?.code || 'Send refused',
    refusalNeedsAssistantProgram: () => false,
    TERMINAL_AGENT_SESSION_CODES: new Set(['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']),
  }
  const launch = new Function(...Object.keys(scope), declarations
    + '\nreturn { startAgentForNode, withRetainedStartIdentity }')(...Object.values(scope))
  const start = (extra = {}) => launch.startAgentForNode({
    text: 'Review the project findings.', surface: 'fleet-tree', researchProjectId: projectId,
    onSessionOpen: value => { calls.opened.push(value); calls.order.push('onSessionOpen') },
    onCleanupRequired: value => calls.cleanup.push(value),
    ...extra,
  })
  return { calls, native, start, launch, assignmentEntered }
}

test('actual tree launch confirms service membership before publish/send and strips renderer-only IPC fields', async () => {
  const gate = deferred()
  const f = fixture({ assignGate: gate })
  let settled = false
  const pending = f.start({ researchProjectName: 'Stale browser title' }).then(result => { settled = true; return result })
  await f.assignmentEntered.promise
  assert.equal(settled, false)
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectId'), false)
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectName'), false)
  const actualId = f.calls.starts[0].sessionId
  assert.deepEqual(f.calls.assigned, [{
    action: 'research-session-assign',
    body: { projectId, assign: [{ kind: 'observed', ref: actualId }] },
  }])
  gate.resolve()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, actualId)
  assert.deepEqual(f.calls.order, [
    'native.start', 'research.snapshot', 'research.assign', 'research.receipt', 'onSessionOpen', 'native.send',
  ])
  assert.ok(f.calls.opened[0].roleIntroduction.includes(project.name))
  assert.ok(f.calls.sends[0].text.startsWith('Review the project findings.\n\n'))
  assert.ok(f.calls.sends[0].text.includes(project.name))
  assert.equal(f.calls.sends[0].text.includes('Stale browser title'), false)
  assert.ok(f.calls.sends[0].text.includes(JSON.stringify({ refs: [{ kind: 'observed', ref: actualId }] })))
})

test('actual tree launch closes a session after failed binding and never publishes or sends', async () => {
  const f = fixture({ missingProject: true })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RESEARCH_PROJECT_NOT_FOUND')
  assert.equal(result.sessionId, null)
  assert.equal(result.cleanupPending, undefined)
  assert.deepEqual(f.calls.cleanup, [], 'Exact confirmed close leaves no phantom Stop target')
  assert.deepEqual(f.calls.closes, [{ sessionId: f.calls.starts[0].sessionId }])
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.calls.assigned.length, 0)
})

test('actual retained-start identity keeps the real Stop target when binding cleanup fails', async () => {
  const f = fixture({ missingProject: true, closeFails: true })
  const result = await f.start()
  const actualId = f.calls.starts[0].sessionId
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(result.sessionId, actualId)
  assert.equal(result.cleanupPending, true)
  assert.deepEqual(f.calls.cleanup, [{ sessionId: actualId, code: 'AGENT_SESSION_CLEANUP_FAILED' }])
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
})

test('actual retained native resume passes its thread and shares project context with the later send wrapper', async () => {
  const f = fixture()
  const retained = f.launch.withRetainedStartIdentity(f.native)
  const result = await retained.start({ resumeThreadId: 'saved-provider-thread', researchProjectId: projectId })
  assert.equal(f.calls.starts[0].resumeThreadId, 'saved-provider-thread')
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectId'), false)
  assert.ok(result.roleIntroduction.includes(project.name))
  assert.equal(f.calls.sends.length, 0)
  await withResearchTreeBinding(f.native).send({ sessionId: result.sessionId, text: 'Continue the research.' })
  assert.ok(f.calls.sends[0].text.includes(project.name))
  assert.ok(f.calls.sends[0].text.includes(result.sessionId))
})

test('direct research setup marker is forwarded only when supplied and invalid values are not hidden', async () => {
  const f = fixture()
  await f.start({ researchProjectId: null, text: 'Clean-room setup', researchSetup: true })
  await f.start({ researchProjectId: null, text: 'Invalid setup marker', researchSetup: 'unexpected' })
  await f.start({ researchProjectId: null, text: 'Ordinary task' })
  assert.equal(f.calls.starts[0].researchSetup, true)
  assert.equal(f.calls.starts[1].researchSetup, 'unexpected')
  assert.equal(Object.hasOwn(f.calls.starts[2], 'researchSetup'), false)
})

test('actual ordinary tree launch uses its unchanged native path without research service reads or writes', async () => {
  const f = fixture()
  const result = await f.start({ researchProjectId: null, text: 'Ordinary task' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls.order, ['native.start', 'onSessionOpen', 'native.send'])
  assert.equal(f.calls.assigned.length, 0)
  assert.equal(f.calls.sends[0].text, 'Ordinary task')
  assert.equal(f.calls.opened[0].roleIntroduction, 'Configured role')
})


// Join the real issuer, renderer normalizer, creation orchestration, view
// callback and first-send path. Native IPC and role/resource presentation are
// controlled fixtures; no provider process or application window is opened.
function restrictedCreateFixture({ access = 'read-only', ordinary = false,
  callbackThrows = false, sendGate = null, sendRefuses = false, closeFails = false,
  startDisabled = false, mutateRequest = null, failRestrictionSave = false } = {}) {
  const require = createRequire(import.meta.url)
  const { createResearchDelegationAuthority } = require('../../shell/research-delegation-authority.cjs')
  const { cleanupTreeDelegation } = require('../../shell/tree-delegation-cleanup.cjs')
  const engine = canonicalRootForTests({ requireConfigured: true })
  const { normalizeResearchDelegation } = require(path.join(engine, 'src/lib/research-delegation-request.js'))
  const { validateResearchAccess, enforceResearchAccess } = require(path.join(engine, 'src/lib/research-access.js'))
  const { root } = prepareRetainedSourceFixture()
  const folder = path.join(root, 'inputs')
  mkdirSync(folder)
  const cells = new Map()
  let failNextWrite = false
  let refuseNextRead = false
  const storage = {
    read: key => cells.has(key) ? JSON.parse(cells.get(key)) : null,
    readResult: key => {
      if (refuseNextRead) { refuseNextRead = false; return { ok: false } }
      return { ok: true, text: cells.get(key) ?? null }
    },
    write: (key, value) => {
      if (failNextWrite) { failNextWrite = false; return false }
      cells.set(key, JSON.stringify(value)); return true
    },
  }
  let nextId = 0
  const store = { ...createFleetTreeStore({ computerId: 'computer-fixture', storage,
    makeId: kind => kind + '-' + (++nextId) }) }
  const parent = store.addNode({ role: 'manager', tier: 'astra', message: 'Private parent task.' }).node
  store.attachSession(parent.id, 'parent-session')
  store.setNodeStatus(parent.id, 'running', { note: '' })
  const parentAuthority = { sessionId: 'parent-session', owner: 'fixture-owner',
    agentId: parent.id, nodeId: parent.id, treeId: parent.treeId, treeAnchors: [parent.id],
    cwd: root, permissionSession: { origin: 'local', tier: 'full' } }
  const authority = createResearchDelegationAuthority({
    readParent: id => id === parentAuthority.sessionId ? parentAuthority : null,
    normalizeRequest: normalizeResearchDelegation, validateAccess: validateResearchAccess,
    enforceAccess: enforceResearchAccess, roomsRoot: path.join(root, 'rooms'),
  })
  const research = { mode: 'folder', access, folder, prompt: 'Review only the explicit synthetic input.' }
  const reservedNodeId = 'node-restricted-fixture'
  const issued = ordinary ? null : authority.issue(parentAuthority.sessionId, parentAuthority.owner,
    { tier: 'astra', role: 'manager', research }, reservedNodeId)
  const now = Date.now()
  const packet = {
    protocol: 'toolsenabled.tree-node-command', schemaVersion: 1,
    requestId: 'tnc-12345678-1234-4123-8123-123456789abc', action: 'create-and-start-node',
    computerId: 'computer-fixture', treeId: null, nodeId: null, expectedSessionId: null,
    parentSessionId: parentAuthority.sessionId, role: 'manager', tier: 'astra',
    effort: 'xhigh', provider: 'codex', model: 'gpt-6-astra',
    // Distinct strings prove restricted transcripts use the issued purpose,
    // rather than falling back to ordinary draft/context when those differ.
    brief: 'Ordinary draft is separate from the restricted purpose.', reservedNodeId,
    ...(issued ? { delegationToken: issued.token, research: issued.research } : {}),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    containsSecretMaterial: false,
  }
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  const clean = new Function('FLEET_TREE_LIMITS',
    main.slice(main.indexOf('function cleanTreeNodeCommand(value) {'),
      main.indexOf('\nasync function completeTreeNodeCommand(')) + '\nreturn cleanTreeNodeCommand')(FLEET_TREE_LIMITS)
  const command = clean(packet)
  assert.ok(command, 'the actual issued research command must pass renderer admission')
  const calls = { starts: [], sends: [], closes: [], order: [], cleanup: [], statuses: [], restrictions: [] }
  const sessions = new Map()
  const liveSessions = new Map([['parent-session', parent.id]])
  const transcripts = createTranscriptStore({ computerId: 'computer-fixture', storage })
  const delegation = { ownerKey: parentAuthority.owner, childSessionId: null, permit: null }
  const native = {
    async start(request) {
      calls.starts.push({ sessionId: request.sessionId, research: request.research })
      if (issued) {
        let redemption = { ...request, agentId: request.roleBinding.agentId,
          agentAuthority: { roleId: 'manager' } }
        if (mutateRequest) redemption = mutateRequest(redemption)
        try {
          delegation.permit = authority.redeem(request.delegationToken, redemption, parentAuthority.owner)
          delegation.permit.assertStart()
        } catch (error) {
          return { ok: false, code: error.code, startOutcome: { requestSessionId: request.sessionId,
            custody: 'none', admission: 'not-admitted', cleanup: 'not-required' } }
        }
      }
      delegation.childSessionId = request.sessionId
      sessions.set(request.sessionId, { ownerKind: 'local', owner: parentAuthority.owner,
        treeDelegationStart: delegation.permit })
      calls.order.push('native.start')
      return { sessionId: request.sessionId, threadId: 'synthetic-thread',
        ...(issued ? { researchRestriction: delegation.permit.researchAccess } : {}) }
    },
    async send(request) {
      calls.sends.push(request); calls.order.push('native.send')
      if (sendGate) await sendGate.promise
      return sendRefuses ? { ok: false, code: 'MC_AGENT_SEND_FAILED', reason: 'Synthetic first send refused.' }
        : { sessionId: request.sessionId, turnId: 'synthetic-turn' }
    },
    async close(request) {
      calls.closes.push(request.sessionId)
      if (closeFails) throw new Error('Synthetic close unconfirmed.')
      sessions.delete(request.sessionId)
      return { closed: true }
    },
  }

  const pendingStores = new Map()
  const pendingNodes = new Set()
  const originalSetRestriction = store.setNodeResearchRestriction
  store.setNodeResearchRestriction = (...args) => {
    calls.order.push('save-restriction')
    if (callbackThrows) throw Object.assign(new Error('Synthetic restriction save failed.'),
      { code: 'RESEARCH_RESTRICTION_NOT_SAVED' })
    if (failRestrictionSave === 'read') refuseNextRead = true
    else if (failRestrictionSave === 'invalid') args[1] = { ...args[1], root: 'relative-scope' }
    else if (failRestrictionSave) failNextWrite = true
    const result = originalSetRestriction(...args)
    calls.restrictions.push({ ok: result.ok, persistenceFailed: result.snapshot?.persistenceFailed })
    return result
  }
  const scope = {
    window: { mcAgent: native }, withResearchTreeBinding, slotAccountStartOptions,
    treeStore: store, treeStoreId: 'computer-fixture', treeStoreProblem: '', destroyed: false,
    transcriptStore: transcripts, sessionTranscripts: new Map(),
    standaloneSettledTurns: new Map(), TRANSCRIPT_MAX_ENTRIES: 60, LAUNCH_TIERS,
    RUN_STARTING_TREE_STORES: pendingStores, startingNodeIds: pendingNodes,
    sessionNodeIds: liveSessions, sessionEfforts: new Map(), sessionThreadIds: new Map(),
    sessionAccountNames: new Map(),
    /* computers.js declares this beside sessionAccountNames in the same view
       closure; startDraftNodeUnguarded records the started account in it. */
    sessionAccountRecords: new Map(), composePanel: null,
    mockSource: () => false, currentDataSource: () => 'local',
    isWriteEnabled: () => !startDisabled, START_CONTROL_FLAG: 'start',
    START_NEEDS_APP_TEXT: () => 'Needs app', startControlOffReason: () => 'Starting is off',
    exampleBoardText: () => 'Example', draftStartEffort: () => 'xhigh',
    tierEffortOf: () => 'xhigh', identityRoleForTreeNode: value => value,
    ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: id => ({ ok: true, binding: { agentId: id } }),
    treeNodeName: node => node.id === parent.id ? 'Parent private name' : 'Child',
    roleDisplayFor: value => value, startingLine: () => 'Starting',
    runningLine: () => 'Running', statusNote: value => value || '',
    startProfileId: value => value, composeNodeBrief, nodeManagerContext,
    briefContextFor: () => ({ selfName: 'Child', parentName: 'Parent private name' }),
    readEngineCatalog: () => {}, rememberBoundSessionProfile: () => {},
    setOrgStatus: (...args) => calls.statuses.push(args),
    refreshTree: () => {}, rebindRailToSession: () => {}, closeComposePanel: () => {},
    setTimeout: () => 1, clearTimeout: () => {}, startStallMs: () => 10000,
    isResourceHold: () => false, ENDED_SESSION: { note: 'Ended' },
    retireTreeSessionRuntime: id => liveSessions.delete(id),
    retainTreeSessionCleanup: (_store, nodeId, sessionId) => calls.cleanup.push({ nodeId, sessionId }),
    startCleanupSentence: () => 'Cleanup pending',
    START_REFUSAL: { assistantProgramNote: 'Install assistant' },
    TREE_RUNTIME_NOT_SAVED_TEXT: 'Not saved', refusalCode, refusalCodeOf,
    readerRemedy: sentence => sentence,
    startRefusalSentence: result => result?.reason || result?.code || 'Start refused',
    sendRefusalSentence: result => result?.reason || result?.code || 'Send refused',
    refusalNeedsAssistantProgram: () => false,
    TERMINAL_AGENT_SESSION_CODES: new Set(['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']),
  }
  const joined = declarations + '\n' + [
    'retainStartingTreeStore', 'startDraftNodeUnguarded', 'transcriptAppend',
    'persistTranscript', 'treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity',
    'savedResearchRestrictionRefusal',
  ].map(name => declaredFunctionSource(source, name)).join('\n')
  const view = new Function(...Object.keys(scope), joined +
    '\nreturn {startDraftNodeUnguarded, savedResearchRestrictionRefusal}')(...Object.values(scope))
  const start = () => executeCreateAndStartNode({
    command, treeStore: store, sessionNodeIds: liveSessions,
    roleRecordFor: role => role === 'manager' ? { id: role } : null,
    launchTiers: LAUNCH_TIERS, startDraftNode: view.startDraftNodeUnguarded,
    treeNodeName: scope.treeNodeName,
  })
  return { calls, store, transcripts, research, packet, command, sessions,
    pendingStores, pendingNodes, liveSessions, reservedNodeId, start, view,
    sessionTranscripts: scope.sessionTranscripts,
    // Real cleanup primitive, controlled IPC. This models the shell's reject
    // settlement after the renderer returns; it is never called on a real ID.
    async settleFailure() {
      await cleanupTreeDelegation(delegation, {
        readSession: id => sessions.get(id), ownerKey: principal => principal.owner,
        close: sessionId => native.close({ sessionId }),
      })
      if (issued) authority.finish(issued.token)
    },
    finish() { if (issued) authority.finish(issued.token) },
  }
}

for (const access of ['read-only', 'read-write']) {
  test('issued restricted creation opens with only its explicit prompt: ' + access, async () => {
    const f = restrictedCreateFixture({ access })
    try {
      const result = await f.start()
      assert.equal(result.ok, true, result.reason)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.calls.sends.length, 1)
      assert.equal(f.calls.sends[0].text, f.research.prompt)
      assert.deepEqual(f.transcripts.get(result.nodeId).lines.map(line => line.text), [f.research.prompt])
      assert.equal(f.store.getNode(result.nodeId).researchRestriction.access, access)
      assert.equal(f.store.getNode(result.nodeId).researchRestriction.root, f.research.folder)
      assert.equal(f.store.getNode(result.nodeId).sessionId, result.sessionId)
      assert.equal(f.store.getNode(result.nodeId).status, 'running')
      assert.equal(f.pendingStores.size, 0)
      assert.equal(f.pendingNodes.size, 0)
      assert.deepEqual(f.calls.order, ['native.start', 'save-restriction', 'native.send'])
      assert.equal(f.view.savedResearchRestrictionRefusal(f.store.getNode(result.nodeId)).code,
        'AGENT_RESEARCH_RESTART_REFUSED')
    } finally { f.finish() }
  })
}

test('ordinary creation preserves separate draft and manager transcript entries', async () => {
  const f = restrictedCreateFixture({ ordinary: true })
  const result = await f.start()
  assert.equal(result.ok, true, result.reason)
  const texts = f.sessionTranscripts.get(result.sessionId).map(line => line.text)
  assert.deepEqual(texts, [f.packet.brief, nodeManagerContext({ selfName: 'Child', parentName: 'Parent private name' })])
  assert.equal(f.calls.sends[0].text, texts.join('\n\n'))
  const saved = f.transcripts.get(result.nodeId).lines.map(line => line.text)
  assert.equal(saved[0], texts[0])
  assert.ok(texts[1].startsWith(saved[1]))
  assert.match(saved[1], /^Tree address:/)
  assert.equal(f.store.getNode(result.nodeId).researchRestriction, undefined)
  assert.deepEqual(f.calls.order, ['native.start', 'native.send'])
})

test('restricted callback refusal sends nothing and leaves exact session for confirmed shell cleanup', async () => {
  const f = restrictedCreateFixture({ callbackThrows: true })
  try {
    const result = await f.start()
    assert.equal(result.ok, false)
    assert.match(result.reason, /Synthetic restriction save failed/)
    assert.equal(f.calls.sends.length, 0)
    const node = f.store.getNode(result.nodeId)
    assert.equal(node.status, 'failed')
    assert.equal(f.sessions.has(node.sessionId), true, 'renderer failure alone is not a close receipt')
    assert.equal(f.liveSessions.get(node.sessionId), node.id)
    assert.equal(f.calls.closes.length, 0)
    await f.settleFailure()
    assert.equal(f.sessions.size, 0)
    assert.deepEqual(f.calls.closes, [node.sessionId])
    assert.equal(f.store.getNode(node.id).sessionId, node.sessionId, 'failed history is retained')
    assert.equal(f.pendingStores.size, 0)
    assert.equal(f.pendingNodes.size, 0)
  } finally { f.finish() }
})

test('restricted callback failure retains custody when exact shell cleanup cannot confirm close', async () => {
  const f = restrictedCreateFixture({ callbackThrows: true, closeFails: true })
  try {
    const result = await f.start()
    assert.equal(result.ok, false)
    assert.equal(f.calls.sends.length, 0)
    await assert.rejects(f.settleFailure(), /Synthetic close unconfirmed/)
    assert.equal(f.sessions.size, 1)
    assert.equal(f.store.getNode(result.nodeId).status, 'failed')
    assert.equal(f.calls.closes.length, 1)
  } finally { f.finish() }
})

for (const sendRefuses of [false, true]) {
  test('delegated creation submits once and tracks later first-send outcome: ' + (sendRefuses ? 'refused' : 'accepted'), async () => {
    const gate = deferred()
    const f = restrictedCreateFixture({ sendGate: gate, sendRefuses })
    try {
      const result = await f.start()
      assert.equal(result.ok, true, result.reason)
      assert.equal(f.calls.sends.length, 1, 'spawn submits without awaiting provider completion')
      assert.equal(f.store.getNode(result.nodeId).status, 'running')
      gate.resolve()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.calls.sends.length, 1)
      assert.equal(f.store.getNode(result.nodeId).status, sendRefuses ? 'failed' : 'running')
      assert.equal(f.sessions.size, 1, 'first-send failure preserves the owned session')
      assert.equal(f.calls.closes.length, 0)
      if (sendRefuses) assert.match(f.store.getNode(result.nodeId).statusNote, /Synthetic first send refused/)
    } finally { gate.resolve(); f.finish() }
  })
}

test('joined research creation keeps disabled launch and changed issued purpose refusals', async () => {
  for (const options of [{ startDisabled: true },
    { mutateRequest: request => ({ ...request, research: { ...request.research, prompt: 'Changed purpose.' } }) },
    { mutateRequest: request => ({ ...request, requestKeys: { ...request.requestKeys, treeAnchors: ['foreign-parent', request.agentId] } }) }]) {
    const f = restrictedCreateFixture(options)
    try {
      const result = await f.start()
      assert.equal(result.ok, false)
      assert.equal(f.calls.sends.length, 0)
      assert.equal(f.sessions.size, 0)
      assert.equal(f.calls.cleanup.length, 0)
      if (options.startDisabled) assert.equal(f.calls.starts.length, 0)
      else assert.match(result.reason, /RESEARCH_DELEGATION_REFUSED/)
    } finally { f.finish() }
  }
})

test('failed restricted creation cannot silently redeliver as a new same-node draft', async () => {
  const f = restrictedCreateFixture({ callbackThrows: true })
  try {
    const result = await f.start()
    assert.equal(result.ok, false)
    await f.settleFailure()
    const again = await f.start()
    assert.equal(again.ok, false)
    assert.equal(again.code, 'MC_TREE_SPAWN_PLACE_REFUSED')
    assert.equal(f.calls.starts.length, 1)
    assert.equal(f.calls.sends.length, 0)
    assert.equal(f.store.snapshot().nodes.length, 2)
  } finally { f.finish() }
})

for (const failure of ['write', 'read', 'invalid']) {
  for (const closeFails of [false, true]) {
    test('restricted creation refuses actual store failure before first send: ' + failure + '/' + closeFails, async () => {
      const f = restrictedCreateFixture({ failRestrictionSave: failure, closeFails })
      try {
        const result = await f.start()
        assert.equal(f.calls.sends.length, 0, 'an unsaved restriction must not release the first task')
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'The restricted research session could not be saved.')
        assert.equal(f.calls.restrictions.length, 1)
        assert.equal(f.calls.restrictions[0].ok, failure === 'write')
        assert.equal(f.calls.restrictions[0].persistenceFailed, failure === 'invalid' ? undefined : true)
        const node = f.store.getNode(result.nodeId)
        assert.equal(f.sessions.has(node.sessionId), true)
        if (closeFails) {
          await assert.rejects(f.settleFailure(), /Synthetic close unconfirmed/)
          assert.equal(f.sessions.has(node.sessionId), true)
        } else {
          await f.settleFailure()
          assert.equal(f.sessions.size, 0)
        }
        assert.deepEqual(f.calls.closes, [node.sessionId])
        assert.equal(f.pendingStores.size, 0)
        assert.equal(f.pendingNodes.size, 0)
      } finally { f.finish() }
    })
  }
}
