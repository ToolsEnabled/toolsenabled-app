/* A STARTED CIRCLE IS NEVER ANONYMOUS. Execute the actual nested identity
 * gates with a memory store and an explicit provider handoff boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createFleetTreeStore, draftStartEffort, safeTreeStorage } from '../../src/fleet-trees.js'

import { DEFAULT_TREE_IDENTITY_ROLE, identityRoleForTreeNode } from '../../src/tree-node-identity.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(repo, relative), 'utf8')

function identityGateFixture({ role = '', seat = { ok: true }, binding = { ok: true, binding: { agentId: 'declared-worker' } } } = {}) {
  const events = [], statuses = [], handoffs = []
  let releaseSeat
  const seatAnswer = new Promise(resolve => { releaseSeat = () => resolve(seat) })
  let saved = null
  const store = createFleetTreeStore({ computerId: 'identity-fixture', storage: safeTreeStorage({ getItem: () => saved, setItem: (_key, value) => { saved = value } }) })
  const node = store.addNode({ role, message: 'Keep this exact opening brief.', tier: 'luna' }).node
  const boundary = new Error('owned provider handoff boundary')
  const context = vm.createContext({
    treeStore: store, treeStoreProblem: '', composePanel: null, destroyed: false, transcriptStore: null,
    START_CONTROL_FLAG: 'start', startingNodeIds: new Set(),
    mockSource: () => false, isWriteEnabled: () => true, nodeCleanupPending: () => false,
    identityRoleForTreeNode, draftStartEffort, tierEffortOf: () => 'medium',
    ensureSeatForNode: async (current, selectedRole) => { events.push(['seat', current.id, selectedRole]); return seatAnswer },
    roleBindingForStart: (id, selectedRole) => { events.push(['binding', id, selectedRole]); return binding },
    setOrgStatus: (sentence, kind, metadata) => statuses.push({ sentence, kind, metadata }),
    currentDataSource: () => 'local', window: { mcAgent: {} },
    withRetainedStartIdentity: bridge => bridge, startProfileId: id => id,
    refreshTree: () => {}, roleDisplayFor: value => value, startingLine: () => 'Starting.',
    briefContextFor: () => ({}), composeNodeBrief: value => value.message, nodeManagerContext: () => '',
    nodeRequestKeys: () => [], nodeTreeIdentity: () => null, retainStartingTreeStore: () => () => {},
    startAgentForNode: options => { events.push(['handoff']); handoffs.push(options); throw boundary },
  })
  const source = read('src/views/computers.js')
  for (const name of ['startDraftNodeUnguarded', 'freshStartExistingNodeUnguarded']) vm.runInContext(declaredFunctionSource(source, name), context)
  return { node, context, events, statuses, handoffs, releaseSeat, boundary,
    start: () => context.startDraftNodeUnguarded(node), restart: () => context.freshStartExistingNodeUnguarded(node) }
}

test('a blank canvas role gets the bounded Worker identity role, while a selected role stays itself', () => {
  assert.equal(DEFAULT_TREE_IDENTITY_ROLE, 'worker')
  assert.equal(identityRoleForTreeNode(''), 'worker')
  assert.equal(identityRoleForTreeNode('   '), 'worker')
  assert.equal(identityRoleForTreeNode('manager'), 'manager')
})

test('startDraftNode provisions and confirms identity before it requests a session', async () => {
  for (const role of ['', 'manager']) {
    const f = identityGateFixture({ role })
    const pending = f.start()
    assert.deepEqual(f.events, [['seat', f.node.id, role || 'worker']])
    assert.equal(f.handoffs.length, 0, 'an unsettled identity cannot request a provider')
    f.releaseSeat()
    await assert.rejects(pending, error => error === f.boundary)
    assert.deepEqual(f.events, [['seat', f.node.id, role || 'worker'], ['binding', f.node.id, role || 'worker'], ['handoff']])
    assert.equal(f.handoffs.length, 1)
    assert.equal(f.handoffs[0].roleBinding.agentId, 'declared-worker')
    assert.equal(f.handoffs[0].text, 'Keep this exact opening brief.')
    assert.equal(Object.hasOwn(f.handoffs[0], 'anonymousReason'), false)
  }
  for (const options of [
    { seat: { ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', reason: 'The identity write was refused.' } },
    { binding: { ok: false, message: 'The role binding is missing.' } },
    { binding: { ok: true, binding: {} } },
  ]) {
    const f = identityGateFixture(options), pending = f.start()
    f.releaseSeat()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(f.handoffs.length, 0)
    assert.equal(result.message, f.statuses.at(-1).sentence)
    assert.equal(Object.hasOwn(result, 'anonymousReason'), false)
  }
})

test('a revision conflict is re-read and retried once instead of degrading a session to anonymous', () => {
  const view = read('src/views/computers.js')
  const start = view.indexOf('async function ensureSeatForNode(node, role,')
  const end = view.indexOf('\n  /* THE COUNTERPART OF ensureSeatForNode', start)
  assert.ok(start >= 0 && end > start)
  const body = view.slice(start, end)

  assert.match(body, /if \(isRevisionConflict\(result\) && retry\)/)
  const again = /return ensureSeatForNode\(node, role, \{([^}]*)\}\)/.exec(body)
  assert.ok(again, 'the revision conflict no longer re-reads and retries the seat write')
  assert.match(again[1], /retry:\s*false/,
    'the second attempt can retry again, so two conflicting writers retry each other forever')
  /* AND IT MUST BE THE SAME REQUEST, not just a second one. This read the
     literal `{ retry: false }`, which went red the moment the retry correctly
     started forwarding tierId -- and would have stayed green on a retry that
     dropped it and seated the node on a different tier than the person picked.
     The option list is derived from the function's own signature, so an option
     added later has to be forwarded here too rather than silently lost. */
  const signature = /async function ensureSeatForNode\(node, role, \{([^}]*)\} = \{\}\)/.exec(body)
  assert.ok(signature, 'ensureSeatForNode no longer declares its options object')
  const options = signature[1].split(',').map(part => part.trim().split(/[\s=]/)[0]).filter(Boolean)
  assert.ok(options.includes('retry'), 'the retry option left the signature')
  for (const option of options.filter(name => name !== 'retry')) {
    assert.ok(new RegExp(`\\b${option}\\b`).test(again[1]),
      `the retry drops ${option}, so the second attempt is not the one the caller asked for`)
  }
  assert.match(body, /MC_TREE_IDENTITY_UNAVAILABLE/)
})

test('fresh starts and resumes give older blank-role circles the same identity path', () => {
  const view = read('src/views/computers.js')
  const identityCalls = view.match(/const identityRole = identityRoleForTreeNode\(node\?\.role\)/g) || []
  assert.equal(identityCalls.length, 2, 'fresh start and resume must both derive the automatic identity role')
  assert.doesNotMatch(view, /await ensureSeatForNode\(node\)(?!,)/,
    'a restart path bypassed the identity role and would leave a blank-role circle anonymous')
})

test('a restart refused for its identity carries the same reason it just put on the status line', async () => {
  /* freshStartExistingNodeUnguarded's identity gate is a hand-rolled copy of
     startDraftNode's -- both compute `identityReason` and both hand it to
     setOrgStatus for the person watching the screen. startDraftNode's copy
     also puts that sentence on its returned `message`, which
     executeCreateAndStartNode reads and carries onward as `reason` (see its
     own "A REFUSAL CARRIES ITS SENTENCE WHEN IT HAS ONE"). This gate's result,
     by contrast, is returned to runTreeNodeCommand UNCHANGED, straight to
     src/main.js completeTreeNodeCommand, which reads a bounded `reason` off
     ANY tree-node-command refusal -- exactly the contract
     src/fresh-start-existing-node.js's own header comment and its sibling
     refusals (MC_TREE_COMMAND_CLOSE_FAILED, MC_TREE_COMMAND_START_FAILED, the
     returned-not-thrown start refusal) already honor. An assistant's
     agent.restart, refused here, read only
     "MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE" with no explanation, even
     though the exact sentence had already been computed and shown on screen
     one line above the return that drops it. */
  for (const options of [
    { seat: { ok: false, reason: 'The saved identity could not be read.' } },
    { binding: { ok: false, message: 'No declared binding is available.' } },
    { binding: { ok: true, binding: {} } },
  ]) {
    const f = identityGateFixture(options), pending = f.restart()
    assert.equal(f.handoffs.length, 0)
    f.releaseSeat()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE')
    assert.equal(result.reason, f.statuses.at(-1).sentence)
    assert.equal(result.nodeId, f.node.id)
    assert.equal(result.sessionId, null)
    assert.equal(result.threadId, null)
    assert.equal(f.handoffs.length, 0)
  }
})

test('resolveLocalTreeCommand only adds statusNote to a successful answer when the renderer result actually carried one', () => {
  const main = read('shell/main.cjs')
  const start = main.indexOf('function resolveLocalTreeCommand(')
  const end = main.indexOf('function dispatchTreeSpawn(', start)
  assert.ok(start >= 0 && end > start)
  const body = main.slice(start, end)

  assert.match(body, /\.\.\.\(result\.statusNote \? \{ statusNote: result\.statusNote \} : \{\}\)/,
    'an ordinary spawn (no statusNote on the renderer result) must not grow the field; a caller that reads Object.keys sees nothing new')
})
