/* THE RENDERER'S OWN GATE ON A DISPATCHED TREE-NODE COMMAND.
 *
 * src/main.js cannot be imported directly under `node --test` -- it pulls in
 * font and stylesheet assets that only a bundler resolves -- so every other
 * suite that touches it (tools/test/tree-node-command-wiring.test.mjs) reads
 * the file as text and asserts against the source. That style catches a
 * function being ABSENT or renamed; it cannot catch cleanTreeNodeCommand
 * REJECTING a value it should accept, because a regex over the source cannot
 * evaluate the function's own branches. This suite extracts the live function
 * body from the real file and runs it, so a wrong verdict is a wrong verdict
 * here, not a passing string match.
 *
 * MEASURED 2026-09-03: commit 14ca4fb ("Agents can stop, restart and remove
 * the circles below them") taught shell/main.cjs's dispatchTreeSpawn to carry
 * a caller's action instead of the hard-coded 'create-and-start-node', taught
 * src/views/computers.js's runTreeNodeCommand to perform 'stop-node' and
 * 'remove-node', and gave both verbs sentences in
 * shell/tree-command-refusal-sentences.cjs. It never touched this gate. Two
 * independent defects in the one function between the IPC message and that
 * view meant every one of the owner's three new capabilities -- agent.stop,
 * agent.restart, agent.remove -- was unreachable from an assistant:
 *
 *   1. cleanTreeNodeCommand's action allow-list still named only
 *      fresh-start-existing-node, send-to-bound-node and create-and-start-node,
 *      so a stop-node or remove-node value failed the very first check and
 *      returned null before reaching the other four defects below.
 *
 *   2. dispatchTreeSpawn builds ONE object literal for every locally-dispatched
 *      action and always writes parentSessionId, role, tier and brief on it
 *      (null when the verb has no use for them). cleanTreeNodeCommand's
 *      non-create guard used Object.prototype.hasOwnProperty, which does not
 *      care that the value is null -- so it also rejected a locally-dispatched
 *      fresh-start-existing-node (agent.restart), which WAS already on the
 *      allow-list, for the unrelated reason that the key merely existed.
 *
 * A command dropped at this gate is not a decline: pendingTreeNodeCommands
 * never receives it, so drainTreeNodeCommands never calls bridge.complete, and
 * the caller is left on the tree-command-broker's own five-minute completion
 * timeout (shell/tree-node-command-broker.cjs, DEFAULT_TIMEOUT_MS) reading
 * "The application could not add that assistant to the tree
 * (MC_TREE_COMMAND_COMPLETION_TIMEOUT)" -- a sentence about an add, for a
 * request that was never one.
 *
 *   node --test tools/test/tree-node-command-clean-gate.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const mainSource = readFileSync(path.join(repoRoot, 'src', 'main.js'), 'utf8')

/* Extracted from the real file, not retyped here, so a future edit to the
   function is exactly what this suite runs against -- there is no second copy
   of the rule to drift out of sync with the first. */
function loadCleanTreeNodeCommand() {
  const start = mainSource.indexOf('function cleanTreeNodeCommand(value) {')
  const end = mainSource.indexOf('\nasync function completeTreeNodeCommand(', start)
  assert.ok(start >= 0, 'cleanTreeNodeCommand was not found in src/main.js')
  assert.ok(end > start, 'the end of cleanTreeNodeCommand was not found in src/main.js')
  const body = mainSource.slice(start, end)
  // eslint-disable-next-line no-new-func -- isolating one function from a file `node --test` cannot import.
  const factory = new Function('FLEET_TREE_LIMITS', `${body}\nreturn cleanTreeNodeCommand;`)
  return factory(FLEET_TREE_LIMITS)
}

const REQUEST_ID = 'tnc-12345678-1234-4123-8123-123456789abc'

test('actual lifecycle token format survives the real normalizer only for an exact bound replacement', () => {
  const clean = loadCleanTreeNodeCommand()
  for (const action of ['resume-node', 'fresh-start-existing-node']) {
    const request = localDispatchPayload(action, { delegationToken: '12345678-1234-4123-8123-123456789abc.1',
      reservedNodeId: 'node-1', expectedSessionId: 'session-old' })
    assert.equal(clean(request)?.delegationToken, request.delegationToken)
    for (const patch of [{ nodeId: 'other' }, { expectedSessionId: null }, { parentSessionId: null },
      { action: 'stop-node' }, { delegationToken: request.delegationToken + '.2' }]) {
      assert.equal(clean({ ...request, ...patch }), null)
    }
  }
})

test('real renderer normalizer preserves a paired delegation and refuses partial/foreign-action packets', () => {
  const clean = loadCleanTreeNodeCommand()
  const request = localDispatchPayload('create-and-start-node', { treeId: null, nodeId: null,
    role: 'worker', tier: 'claude-sonnet', brief: 'Write a bounded artifact.',
    delegationToken: '12345678-1234-4123-8123-123456789abc', reservedNodeId: 'node-reserved' })
  const result = clean(request)
  assert.ok(result)
  assert.equal(result.delegationToken, request.delegationToken)
  assert.equal(result.reservedNodeId, request.reservedNodeId)
  for (const patch of [{ delegationToken: undefined }, { reservedNodeId: undefined },
    { delegationToken: 'oversized'.repeat(100) }, { reservedNodeId: '../escape' }, { action: 'stop-node' }]) {
    assert.equal(clean({ ...request, ...patch }), null)
  }
})

/* Exactly the shape shell/main.cjs's dispatchTreeSpawn builds for a command an
   already-running session dispatches locally (agent.spawn's stop/restart/
   remove verbs): every field always present, role/tier/brief/effort/provider/
   model null when the verb does not use them, and no message field at all.

   THE THREE NULLS ARE NOT DECORATION. dispatchTreeSpawn writes one object
   literal for every locally dispatched action, so the day agent.spawn learned
   effort/provider/model (2026-09-19) every stop, restart, remove and resume
   started carrying those keys too -- present and null. This helper is only
   worth having if it keeps matching what that dispatcher actually sends: the
   second defect this file's own header records is a non-create command refused
   for the unrelated reason that a key merely EXISTED. */
function localDispatchPayload(action, overrides = {}) {
  const now = Date.now()
  return {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action,
    computerId: 'c1',
    treeId: 'tree-1',
    nodeId: 'node-1',
    expectedSessionId: null,
    parentSessionId: 'ses-manager',
    role: null,
    tier: null,
    brief: null,
    effort: null,
    provider: null,
    model: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    containsSecretMaterial: false,
    ...overrides,
  }
}

/* Exactly the shape the file-spool coordinator's validateTreeNodeCommandRequest
   returns for fresh-start-existing-node: no parentSessionId, role, tier or
   brief key at all (see shell/tree-node-command.cjs). */
function fileCoordinatorFreshPayload(overrides = {}) {
  const now = Date.now()
  return {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action: 'fresh-start-existing-node',
    computerId: 'c1',
    treeId: 'tree-1',
    nodeId: 'node-1',
    expectedSessionId: 'ses-old',
    containsSecretMaterial: false,
    ...overrides,
  }
}

test('a locally dispatched restart (agent.restart) is accepted, not silently dropped', () => {
  const clean = loadCleanTreeNodeCommand()
  const out = clean(localDispatchPayload('fresh-start-existing-node'))
  assert.notEqual(out, null, 'fresh-start-existing-node from the local dispatcher must not be dropped')
  assert.equal(out.action, 'fresh-start-existing-node')
  assert.equal(out.treeId, 'tree-1')
  assert.equal(out.nodeId, 'node-1')
})

test('a locally dispatched stop (agent.stop) is accepted, not silently dropped', () => {
  const clean = loadCleanTreeNodeCommand()
  const out = clean(localDispatchPayload('stop-node'))
  assert.notEqual(out, null, 'stop-node must not be dropped by the action allow-list')
  assert.equal(out.action, 'stop-node')
  assert.equal(out.treeId, 'tree-1')
  assert.equal(out.nodeId, 'node-1')
})

test('a locally dispatched remove (agent.remove) is accepted, and carries the caller forward', () => {
  const clean = loadCleanTreeNodeCommand()
  const out = clean(localDispatchPayload('remove-node'))
  assert.notEqual(out, null, 'remove-node must not be dropped by the action allow-list')
  assert.equal(out.action, 'remove-node')
  /* THE LOAD-BEARING FIELD. executeRemoveNode (src/agent-removal-rule.js)
     resolves "where the asker stands" from command.parentSessionId alone. If
     this gate accepted the action but still stripped the field, every removal
     would fail closed with MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN -- a second,
     quieter version of the same defect. */
  assert.equal(out.parentSessionId, 'ses-manager', 'remove-node must carry parentSessionId for its own authorization check')
})

/* THE THIRD VERB THAT MISSED THIS GATE. agent.resume dispatches 'resume-node'
 * (app/capability/src/lib/agent-tree-spawn.js, TREE_ACTIONS.resume) and
 * src/views/computers.js's runTreeNodeCommand has always fully implemented it,
 * but this gate's action allow-list never learned the word, so a resume fell
 * through to `return null` -- the caller read MC_TREE_COMMAND_REQUEST_INVALID
 * for a request the view downstream already accepts, exactly as stop-node and
 * remove-node once did before commit 14ca4fb. */
test('a locally dispatched resume (agent.resume) is accepted, not silently dropped', () => {
  const clean = loadCleanTreeNodeCommand()
  const out = clean(localDispatchPayload('resume-node'))
  assert.notEqual(out, null, 'resume-node must not be dropped by the action allow-list')
  assert.equal(out.action, 'resume-node')
  assert.equal(out.treeId, 'tree-1')
  assert.equal(out.nodeId, 'node-1')
  assert.equal(out.parentSessionId, 'ses-manager', 'resume-node must carry parentSessionId for callerCircleRefusal')
})

/* THE TOOL PROMISES "the application resolves it when omitted", AND THE
 * APPLICATION DROPPED THE REQUEST INSTEAD.
 *
 * agent.stop / agent.restart / agent.remove require only nodeId; treeId is
 * "Optional tree the circle belongs to; the application resolves it when
 * omitted" (src/lib/tool-registry.js, engine). shell/main.cjs's dispatcher
 * writes `treeId: request.treeId || null`, so an omitted tree arrives here as
 * null -- and this gate demanded a string for every non-create command, so the
 * command was never queued, completeTreeNodeCommand was never called, and the
 * assistant's call sat for the broker's five-minute timeout. A manager knows
 * circles by nodeId (agent.spawn's answer, agent_comms.local_roster) and has no
 * treeId to give, so this was every stop, restart and remove without one. */
test('a lifecycle verb dispatched without a treeId is accepted, and the tree is left for the view to resolve', () => {
  const clean = loadCleanTreeNodeCommand()
  for (const action of ['stop-node', 'remove-node', 'fresh-start-existing-node', 'resume-node']) {
    const out = clean(localDispatchPayload(action, { treeId: null }))
    assert.notEqual(out, null, `${action} with no treeId must not be dropped`)
    assert.equal(out.treeId, null, `${action} carries the omission forward, not a made-up tree`)
    assert.equal(out.nodeId, 'node-1')
    assert.equal(out.parentSessionId, 'ses-manager')
  }
  /* A named tree is still checked for shape, and a send still needs one: the
     message route binds to a tree the way it always did. */
  assert.equal(clean(localDispatchPayload('stop-node', { treeId: 'has a space' })), null)
  assert.equal(clean(localDispatchPayload('send-to-bound-node', { treeId: null, expectedSessionId: 'ses-old', message: 'hi' })), null)
})

/* THE GATE'S OWN OTHER TWO OPTIONAL FIELDS ACCEPT EITHER SHAPE OF ABSENT.
 *
 * Two lines below this exact treeId check, the SAME function reads
 * expectedSessionId with `!= null` and parentSessionId with `!= null` --
 * loose equality, so a key that is missing entirely (`undefined`) and a key
 * explicitly written as `null` are the same "not supplied" to both of them.
 * The treeId carve-out above them was written `value.treeId === null`, strict,
 * so of the three optional identifiers on this exact command shape, only
 * treeId singles out one JavaScript representation of "there is no tree" and
 * refuses the other.
 *
 * Nothing that builds a command today produces the strict miss:
 * dispatchTreeSpawn (shell/main.cjs) writes `treeId: request.treeId || null`
 * unconditionally, and the file-spool coordinator's validateTreeNodeCommandRequest
 * (shell/tree-node-command.cjs) lists treeId as REQUIRED and fails the whole
 * request before this gate ever sees it missing. So this was invisible on
 * every call this build makes. It stops being invisible the moment a THIRD
 * producer builds this object with `{ ...rest, treeId: someMaybeValue }` or
 * plain destructuring rather than the `|| null` idiom the one caller happens
 * to use today -- which is exactly how `undefined` reaches a plain object in
 * this codebase everywhere else. A stop, restart or remove built that way
 * would silently read as an unparseable request (refuseUnreadableTreeNodeCommand),
 * not as "no tree named", even though the tool's own contract (see the
 * comment on the line above this gate) promises a bare-nodeId lifecycle call
 * is enough. */
test('treeId omitted is exactly as absent as an explicit null, matching this gate\'s own sibling optional fields', () => {
  const clean = loadCleanTreeNodeCommand()
  for (const action of ['stop-node', 'remove-node', 'fresh-start-existing-node', 'resume-node']) {
    const keyPresentButUndefined = clean(localDispatchPayload(action, { treeId: undefined }))
    assert.notEqual(keyPresentButUndefined, null, `${action} with treeId explicitly undefined must not be dropped`)
    assert.equal(keyPresentButUndefined.treeId, null)

    const keyEntirelyMissing = localDispatchPayload(action, { treeId: null })
    delete keyEntirelyMissing.treeId
    const out = clean(keyEntirelyMissing)
    assert.notEqual(out, null, `${action} with no treeId key at all must not be dropped`)
    assert.equal(out.treeId, null)
  }
  /* A send still needs a real tree either way: omission is not a free pass
     for the one verb that actually binds to one. */
  const sendMissingKey = localDispatchPayload('send-to-bound-node', { expectedSessionId: 'ses-old', message: 'hi' })
  delete sendMissingKey.treeId
  assert.equal(clean(sendMissingKey), null)
})

test('the view compares the tree only when the command named one', () => {
  const view = readFileSync(path.join(repoRoot, 'src', 'views', 'computers.js'), 'utf8')
  const body = view.slice(view.indexOf('async runTreeNodeCommand(command) {'))
  assert.match(body, /if \(!node \|\| \(command\.treeId && node\.treeId !== command\.treeId\)\)/,
    'runTreeNodeCommand refuses a circle as not found whenever the command carries no treeId')
})

test('the file-spool coordinator\'s restart, which never sends parentSessionId, still validates', () => {
  const clean = loadCleanTreeNodeCommand()
  const out = clean(fileCoordinatorFreshPayload())
  assert.notEqual(out, null, 'the coordinator flow must not regress')
  assert.equal(out.parentSessionId, null, 'a request that never named a caller carries none, not a crash')
})

test('create-and-start-node keeps role optional while requiring tier and a bounded brief', () => {
  const clean = loadCleanTreeNodeCommand()
  const now = Date.now()
  const base = {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action: 'create-and-start-node',
    computerId: 'c1',
    treeId: null,
    nodeId: null,
    expectedSessionId: null,
    parentSessionId: 'ses-manager',
    role: 'worker',
    tier: 'claude-sonnet',
    brief: 'do one bounded thing',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    containsSecretMaterial: false,
  }
  const ok = clean(base)
  assert.notEqual(ok, null)
  assert.equal(ok.role, 'worker')
  assert.equal(ok.tier, 'claude-sonnet')
  assert.equal(ok.brief, 'do one bounded thing')
  assert.equal(ok.parentSessionId, 'ses-manager')

  const roleless = clean({ ...base, role: '' })
  assert.notEqual(roleless, null, 'the explicit roleless choice must reach the ordinary start path')
  assert.equal(roleless.role, '', 'the roleless choice must remain empty on the command')
  assert.equal(clean({ ...base, brief: 'x'.repeat(FLEET_TREE_LIMITS.maxMessageChars + 1) }), null, 'a brief over the store\'s own ceiling is still refused')
  assert.equal(clean({ ...base, treeId: 'tree-1' }), null, 'create still may not name an existing node')
})

test('a non-create command still cannot smuggle real role, tier or brief content', () => {
  const clean = loadCleanTreeNodeCommand()
  assert.equal(clean(localDispatchPayload('fresh-start-existing-node', { role: 'sneaky' })), null)
  assert.equal(clean(localDispatchPayload('stop-node', { tier: 'claude-opus' })), null)
  assert.equal(clean(localDispatchPayload('remove-node', { brief: 'not actually create' })), null)
  assert.equal(clean(localDispatchPayload('resume-node', { role: 'sneaky' })), null)
})

test('stop, remove and resume still cannot carry a message, exactly like restart', () => {
  const clean = loadCleanTreeNodeCommand()
  assert.equal(clean(localDispatchPayload('stop-node', { message: 'hi' })), null)
  assert.equal(clean(localDispatchPayload('remove-node', { message: 'hi' })), null)
  assert.equal(clean(localDispatchPayload('fresh-start-existing-node', { message: 'hi' })), null)
  assert.equal(clean(localDispatchPayload('resume-node', { message: 'hi' })), null)
})

test('an unrecognized action is still refused outright', () => {
  const clean = loadCleanTreeNodeCommand()
  assert.equal(clean(localDispatchPayload('delete-everything')), null)
})

test('send-to-bound-node is unaffected: still requires expectedSessionId and a bounded message', () => {
  const clean = loadCleanTreeNodeCommand()
  const now = Date.now()
  const base = {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action: 'send-to-bound-node',
    computerId: 'c1',
    treeId: 'tree-1',
    nodeId: 'node-1',
    expectedSessionId: 'ses-new',
    message: 'go',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    containsSecretMaterial: false,
  }
  assert.notEqual(clean(base), null)
  assert.equal(clean({ ...base, expectedSessionId: null }), null, 'a send with no bound session is still refused')
  assert.equal(clean({ ...base, message: '' }), null, 'an empty message is still refused')
})

test('a malformed parentSessionId on a lifecycle command is still refused, not passed through', () => {
  const clean = loadCleanTreeNodeCommand()
  assert.equal(clean(localDispatchPayload('remove-node', { parentSessionId: 'has a space' })), null)
  assert.equal(clean(localDispatchPayload('remove-node', { parentSessionId: '' })), null)
  assert.equal(clean(localDispatchPayload('resume-node', { parentSessionId: 'has a space' })), null)
})

/* THE DEPTH, PROVIDER AND MODEL AN ASSISTANT NAMES WHEN IT ASKS FOR A CIRCLE.
 *
 * Owner, 2026-09-19: "you NEED to be able to select effort level when you spawn
 * agents". This gate is the first thing on the app side that sees those three,
 * and a value it drops is not a decline: pendingTreeNodeCommands never receives
 * the command, so the caller waits out the broker's five-minute completion
 * timeout reading a sentence about a request that was never refused.
 *
 * MEASURED BY MUTATION 2026-09-19: with `effort`, `provider` and `model` taken
 * back out of this gate's `allowed` set, every check in this file still passed
 * while the whole spawn path went RED (laneB-item1-redgreen.mjs, 2/6). These
 * are the checks that close that hole. */
const CREATE_BASE = Object.freeze({
  protocol: 'toolsenabled.tree-node-command',
  schemaVersion: 1,
  requestId: REQUEST_ID,
  action: 'create-and-start-node',
  computerId: 'c1',
  treeId: null,
  nodeId: null,
  expectedSessionId: null,
  parentSessionId: 'ses-manager',
  role: 'worker',
  tier: 'astra',
  brief: 'do one bounded thing',
  effort: null,
  provider: null,
  model: null,
  containsSecretMaterial: false,
})
const createPayload = (overrides = {}) => {
  const now = Date.now()
  return {
    ...CREATE_BASE,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

test('create-and-start-node admits the depth, provider and model an assistant chose', () => {
  const clean = loadCleanTreeNodeCommand()

  const chosen = clean(createPayload({ effort: 'xhigh', provider: 'codex', model: 'gpt-6-astra' }))
  assert.notEqual(chosen, null, 'a command naming all three must reach the view, not be dropped into a five-minute timeout')
  assert.equal(chosen.effort, 'xhigh')
  assert.equal(chosen.provider, 'codex')
  assert.equal(chosen.model, 'gpt-6-astra')

  /* Naming none of them is the ordinary case, and must come out as the field's
     own "not chosen" rather than undefined: executeCreateAndStartNode reads
     these off the frozen object instead of re-deriving whether one was
     supplied. */
  const unchosen = clean(createPayload())
  assert.notEqual(unchosen, null)
  assert.equal(unchosen.effort, null)
  assert.equal(unchosen.provider, null)
  assert.equal(unchosen.model, null)

  /* A model name carries `/` and `.` -- LAUNCH_TIERS writes claude/opus,
     local/auto and gpt-5.6-luna -- so those are part of the shape here, not an
     exception to it. */
  for (const model of ['claude/opus', 'gpt-5.6-luna', 'local/auto', 'gemini/antigravity/gemini-3.8-flash-high']) {
    assert.notEqual(clean(createPayload({ model })), null, model)
  }

  /* Every value the engine's own vocabulary offers has to survive this gate,
     or a depth agent.spawn accepts would die here instead. */
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(clean(createPayload({ effort }))?.effort, effort, effort)
  }
})

test('the three new fields are shape-checked, and a malformed one is refused rather than carried', () => {
  const clean = loadCleanTreeNodeCommand()
  for (const [label, overrides] of [
    ['a depth that is not a string', { effort: 7 }],
    ['a depth with a space in it', { effort: 'very high' }],
    ['a depth past its bound', { effort: 'xxxxxxxxxx' }],
    ['a provider with a space', { provider: 'cod ex' }],
    ['a model that is an object', { model: { id: 'gpt-6-astra' } }],
    ['an upper-case provider', { provider: 'Codex' }],
    ['an empty depth', { effort: '' }],
  ]) {
    assert.equal(clean(createPayload(overrides)), null, label)
  }
})

test('a non-create command still cannot smuggle a real depth, provider or model', () => {
  /* Present-and-null is what dispatchTreeSpawn sends for every lifecycle verb
     and must stay inert; a real value on one of them is what this refuses. */
  const clean = loadCleanTreeNodeCommand()
  for (const action of ['stop-node', 'remove-node', 'resume-node', 'fresh-start-existing-node']) {
    assert.notEqual(clean(localDispatchPayload(action)), null, `${action}: present-and-null stays inert`)
    assert.equal(clean(localDispatchPayload(action, { effort: 'xhigh' })), null, `${action}: effort`)
    assert.equal(clean(localDispatchPayload(action, { provider: 'codex' })), null, `${action}: provider`)
    assert.equal(clean(localDispatchPayload(action, { model: 'gpt-6-astra' })), null, `${action}: model`)
  }
})
