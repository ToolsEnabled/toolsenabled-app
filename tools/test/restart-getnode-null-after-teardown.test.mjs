/* THE SECOND, INDEPENDENT DEFECT BEHIND THE TRANSCRIPT-RESET ONE.
 *
 * MEASURED, Controller 2026-09-06T19:46:40Z, against the shipped transcript-
 * reset fix in gen-eee4d40e: agent.restart got past
 * MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED (that defect is gone) and instead
 * failed with MC_TREE_COMMAND_RENDERER_FAILED, "Cannot read properties of
 * null (reading 'getNode')" -- moments after a replacement session had
 * already launched.
 *
 * src/views/computers.js's runTreeNodeCommand, action 'fresh-start-existing-
 * node', used to read the view's own mutable `treeStore` closure variable
 * fresh, unguarded, in a callback (restartAfterBind) not run until AFTER
 * bridge.start() resolves -- a real, slow call. This view's own destroy()
 * (navigation, a route change, the page closing) sets that same variable to
 * null and says plainly that an in-flight start is not cancelled by it: "A
 * start already sent is NOT cancelled by any of this... What stops here is
 * this view's interest in the answer."
 *
 * THE FIX RE-RESOLVES AT CALL TIME (openTreeStore's own read-only lookup
 * order: the live binding if it still matches this computer, else
 * recoveryCoordinator().activeStore, else RUN_STARTING_TREE_STORES, else
 * RUN_TREE_RUNTIME_STORES) and refuses by name (MC_TREE_COMMAND_COMPUTER_NOT_FOUND)
 * only when none of those answer -- it never throws.
 *
 * HOW THIS IS TESTED, AND WHY IT CHANGED. An earlier version of this file
 * located the fix's own internal helper by its literal name
 * ("const resolveLiveTreeStore = () =>") before extracting the callback
 * around it. Controller measured that as a spelling pin: renaming or
 * restructuring the fix's internals -- with its behaviour unchanged -- would
 * have failed a test built that way, which is the exact failure mode the
 * project's own standing rule warns against. This version extracts the
 * WHOLE 'fresh-start-existing-node' branch as one opaque block and drives it
 * as a black box: a stub `freshStartExistingNode` invokes the branch's own
 * `afterBind` callback exactly as the real one does, and every assertion is
 * on the branch's final returned result or on what the stubbed
 * `executeRestartExistingNodeCommand` was actually called with. Nothing here
 * names any identifier internal to the branch; a rewrite that keeps the same
 * resolve-or-refuse behaviour under any internal names or structure still
 * passes.
 *
 * computers.js cannot be imported under `node --test` (DOM/asset globals at
 * module scope) -- the same constraint tools/test/tree-rail-rebind.test.mjs
 * and tools/test/tree-node-command-clean-gate.test.mjs already document for
 * this file. This reads its real, current text and executes it, so a wrong
 * verdict here is a wrong verdict in the real branch, not a passing string
 * match.
 *
 *   node --test tools/test/restart-getnode-null-after-teardown.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resumeNodeCommandResult } from '../../src/resume-node-command-result.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/** Slice a brace-balanced block whose header text ENDS with its opening
    brace -- the same utility tools/test/tree-rail-rebind.test.mjs already
    uses for this same un-importable file. Used only to find the OUTER
    boundary of the branch under test, never to name anything inside it. */
function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.notEqual(at, -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = at + header.length - 1
  assert.equal(source[open], '{', `${what}: the slice marker does not end at its opening brace`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  return assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

/* The header text itself ("if (command.action === 'fresh-start-existing-
   node') {") is the tool's own public contract with the broker -- the
   action name a real agent.restart dispatches -- not an internal spelling of
   this fix. It also appears, as a sub-string, inside a DIFFERENT `if` a few
   lines above (a shared caller-authorization check for stop/restart/resume
   together), so the exact trailing ") {" is load-bearing: that other line
   reads ".. || command.action === 'resume-node') {" at the equivalent
   position, which cannot match this header text. */
/* resolveLiveTreeStore is now hoisted ABOVE both the resume-node and
   fresh-start-existing-node branches (shared between them, MEASURED,
   Worker 35 and Controller 2026-09-06, resume-node found to need the
   identical guard) -- so it no longer lives inside the branch slice below
   and must be extracted and prepended separately, by the same boundary
   marker used everywhere else in this file: its own start and its own
   closing `|| null)`. */
function loadResolveLiveTreeStore() {
  const start = SOURCE.indexOf('const resolveLiveTreeStore = () =>')
  assert.notEqual(start, -1, 'resolveLiveTreeStore is gone from runTreeNodeCommand')
  const end = SOURCE.indexOf('|| null)', start)
  assert.notEqual(end, -1, 'resolveLiveTreeStore\'s own closing fallback ("|| null)") is gone')
  return SOURCE.slice(start, end + '|| null)'.length)
}

function loadRestartBranch() {
  const branch = sliceBlock(SOURCE, "if (command.action === 'fresh-start-existing-node') {", 'the assistant restart branch')
  const resolveSource = loadResolveLiveTreeStore()

  // eslint-disable-next-line no-new-func -- isolating one branch from a file `node --test` cannot import.
  const factory = new Function(
    'command', 'node', 'treeStore', 'treeStoreId', 'recoveryCoordinator',
    'RUN_STARTING_TREE_STORES', 'RUN_TREE_RUNTIME_STORES', 'freshStartExistingNode',
    'rebindRailToSession', 'window', 'executeRestartExistingNodeCommand', 'sessionNodeIds',
    'briefContextFor', 'transcriptAppend', 'treeNodeName', 'refreshTree', 'statusNote',
    'PALETTE_PANEL', 'refusalCode', 'refusalCodeOf',
    `${resolveSource}\nreturn (async () => {\n${branch}\n})()`,
  )
  return factory
}

/* resume-node's own copy of the same hazard: MEASURED, Worker 35 and
   Controller 2026-09-06, `const resumed = treeStore.getNode(node.id)` sat
   bare after `await resumeNodeSession(node)` -- exactly as slow as a
   restart's own bridge.start(), per resumeNodeSessionUnguarded's own
   comment ("A resume IS a start -- bridge.start, a real child process").
   Extracted and driven the same way as the restart branch above: the whole
   branch as one opaque block, a stub resumeNodeSession that awaits before
   returning (simulating the real async gap destroy() can land inside), and
   the REAL resumeNodeCommandResult (a small, pure, already-tested helper)
   rather than a stub, so a wrong verdict here is a wrong verdict against
   real code on both sides of the boundary. */
function loadResumeBranch() {
  const branch = sliceBlock(SOURCE, "if (command.action === 'resume-node') {", 'the assistant resume branch')
  const resolveSource = loadResolveLiveTreeStore()

  // eslint-disable-next-line no-new-func -- isolating one branch from a file `node --test` cannot import.
  const factory = new Function(
    'command', 'node', 'treeStore', 'treeStoreId', 'recoveryCoordinator',
    'RUN_STARTING_TREE_STORES', 'RUN_TREE_RUNTIME_STORES',
    'nodeBusy', 'nodeReplacementFlight', 'nodeCleanupPending', 'isWriteEnabled', 'START_CONTROL_FLAG',
    'transcriptStore', 'resumeNodeSession', 'rebindRailToSession', 'resumeNodeCommandResult',
    'sessionNodeIds', 'sessionThreadIds',
    `${resolveSource}\nreturn (async () => {\n${branch}\n})()`,
  )
  return factory
}

const COMPUTER_ID = 'computer-1'
const NODE_ID = 'node-34'
const node = Object.freeze({ id: NODE_ID })
const command = Object.freeze({ action: 'fresh-start-existing-node', computerId: COMPUTER_ID })

function makeStore(nodes) {
  return { getNode: id => nodes.get(id) || null }
}

/* The real freshStartExistingNode's own contract, quoted in this report:
   `restarted?.ok && typeof afterBind === 'function' ? await afterBind(restarted) : restarted`.
   This stub keeps exactly that shape, including the await, so the branch
   under test is driven the same way bridge.start() resolving really drives
   it -- afterBind runs, and whatever it returns is what the branch returns. */
async function fakeFreshStartExistingNode(nodeArg, { afterBind } = {}) {
  const restarted = { ok: true, sessionId: 'session-new', threadId: 'thread-new' }
  await new Promise(resolve => setTimeout(resolve, 0))
  return typeof afterBind === 'function' ? await afterBind(restarted) : restarted
}

function baseDeps(overrides = {}) {
  return {
    rebindRailToSession: () => {},
    window: undefined,
    executeRestartExistingNodeCommand: () => { throw new Error('executeRestartExistingNodeCommand should not run on a refusal path') },
    sessionNodeIds: new Map(),
    briefContextFor: () => ({}),
    transcriptAppend: () => {},
    treeNodeName: () => 'name',
    refreshTree: () => {},
    statusNote: text => text,
    PALETTE_PANEL: { restartBriefFailed: 'failed' },
    refusalCode: () => null,
    refusalCodeOf: () => null,
    ...overrides,
  }
}

function runBranch(env, overrides = {}) {
  const factory = loadRestartBranch()
  const deps = baseDeps(overrides)
  return factory(
    command, node, env.treeStore ?? null, env.treeStoreId ?? COMPUTER_ID,
    env.recoveryCoordinator ?? (() => null), env.runStartingTreeStores ?? new Map(),
    env.runTreeRuntimeStores ?? new Map(), env.freshStartExistingNode ?? fakeFreshStartExistingNode,
    deps.rebindRailToSession, deps.window, deps.executeRestartExistingNodeCommand, deps.sessionNodeIds,
    deps.briefContextFor, deps.transcriptAppend, deps.treeNodeName, deps.refreshTree, deps.statusNote,
    deps.PALETTE_PANEL, deps.refusalCode, deps.refusalCodeOf,
  )
}

test('a live treeStore matching the command\'s computer resolves and completes, exactly as before', async () => {
  const store = makeStore(new Map([[NODE_ID, node]]))
  const calls = []
  const result = await runBranch(
    { treeStore: store, treeStoreId: COMPUTER_ID },
    { executeRestartExistingNodeCommand: request => { calls.push(request); return { ok: true, code: null } } },
  )
  assert.deepEqual(result, { ok: true, code: null })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].treeStore, store, 'the resolved store, not a stale one, must be handed onward')
})

test('a released treeStore (destroy() ran) with the SAME store retained in RUN_STARTING_TREE_STORES still completes the restart', async () => {
  const retained = makeStore(new Map([[NODE_ID, node]]))
  const calls = []
  const result = await runBranch(
    { treeStore: null, treeStoreId: COMPUTER_ID, runStartingTreeStores: new Map([[COMPUTER_ID, { store: retained, count: 1 }]]) },
    { executeRestartExistingNodeCommand: request => { calls.push(request); return { ok: true, code: null } } },
  )
  assert.deepEqual(result, { ok: true, code: null },
    'a store retained across the teardown must let the restart finish, not merely stop it from throwing')
  assert.equal(calls[0].treeStore, retained)
})

/* recoveryCoordinator().activeStore is DELIBERATELY excluded from this
 * resolution chain -- VERIFIED, Controller and Worker 36, 2026-09-06T20:55Z,
 * in account-recovery-coordinator.js: its underlying entry is captured ONCE
 * by the first overlapping recover() call for a computerId and never
 * reassigned by a later one, so while a recovery is in flight it can answer
 * a store from BEFORE this exact view's destroy()-and-reopen -- the one
 * situation that sends resolveLiveTreeStore looking for a fallback at all.
 * A released treeStore recoverable ONLY through activeStore (retained- and
 * runtime-store maps both empty) must therefore still refuse, proving the
 * source is not silently consulted as a last resort either. */
test('a released treeStore recoverable only through recoveryCoordinator().activeStore(...) still refuses -- that source is never trusted', async () => {
  const recovered = makeStore(new Map([[NODE_ID, node]]))
  let activeStoreCalled = false
  const result = await runBranch({
    treeStore: null, treeStoreId: COMPUTER_ID,
    recoveryCoordinator: () => ({ activeStore: id => { activeStoreCalled = true; return id === COMPUTER_ID ? recovered : null } }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND')
  assert.equal(activeStoreCalled, false, 'a store this stale must never even be asked for, not merely ignored once returned')
})

test('a released treeStore with nothing retained anywhere refuses by name -- it does not throw', async () => {
  const result = await runBranch({ treeStore: null, treeStoreId: COMPUTER_ID })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND')
  assert.equal(result.nodeId, NODE_ID)
})

test('a resolved store that no longer has this node refuses MC_TREE_COMMAND_NODE_NOT_FOUND, not a crash', async () => {
  const store = makeStore(new Map()) // node genuinely gone from this store
  const result = await runBranch({ treeStore: store, treeStoreId: COMPUTER_ID })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_NODE_NOT_FOUND')
  assert.equal(result.nodeId, NODE_ID)
})

test('a live treeStore for a DIFFERENT computer is not trusted; the retained/recovered lookup is keyed by this command\'s computerId', async () => {
  const wrongComputerStore = makeStore(new Map([[NODE_ID, node]]))
  const correctStore = makeStore(new Map([[NODE_ID, node]]))
  const calls = []
  const result = await runBranch(
    {
      treeStore: wrongComputerStore, treeStoreId: 'a-different-computer',
      runStartingTreeStores: new Map([[COMPUTER_ID, { store: correctStore, count: 1 }]]),
    },
    { executeRestartExistingNodeCommand: request => { calls.push(request); return { ok: true, code: null } } },
  )
  assert.deepEqual(result, { ok: true, code: null })
  assert.equal(calls[0].treeStore, correctStore, 'must not silently write through a store open on a different computer than this command names')
})

/* THE RESUME-NODE HALF OF THE SAME FIX.
 *
 * MEASURED, Worker 35 and Controller 2026-09-06: resume-node's own
 * `treeStore.getNode(node.id)` sat bare, immediately after
 * `await resumeNodeSession(node)` -- an await exactly as slow as a
 * restart's own bridge.start(). The equivalent restart defect produced
 * MC_TREE_COMMAND_RENDERER_FAILED, "Cannot read properties of null (reading
 * 'getNode')"; this one had not yet been observed to fire, only found by
 * reading the code after the restart fix shipped. */
const RESUME_NODE_ID = 'node-resume-1'
const RESUME_NODE = Object.freeze({ id: RESUME_NODE_ID, sessionId: 'session-old' })
const RESUME_COMMAND = Object.freeze({ action: 'resume-node', computerId: COMPUTER_ID })

async function fakeResumeNodeSession() {
  await new Promise(resolve => setTimeout(resolve, 0))
  return true
}

function resumeBaseDeps(overrides = {}) {
  return {
    nodeBusy: () => false,
    nodeReplacementFlight: { busy: () => false },
    nodeCleanupPending: () => false,
    isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'start-control',
    transcriptStore: { ready: Promise.resolve() },
    resumeNodeSession: fakeResumeNodeSession,
    rebindRailToSession: () => {},
    resumeNodeCommandResult,
    sessionNodeIds: new Map([['session-new', RESUME_NODE_ID]]),
    sessionThreadIds: new Map(),
    ...overrides,
  }
}

function runResumeBranch(env, overrides = {}) {
  const factory = loadResumeBranch()
  const deps = resumeBaseDeps(overrides)
  return factory(
    RESUME_COMMAND, RESUME_NODE, env.treeStore ?? null, env.treeStoreId ?? COMPUTER_ID,
    env.recoveryCoordinator ?? (() => null), env.runStartingTreeStores ?? new Map(),
    env.runTreeRuntimeStores ?? new Map(),
    deps.nodeBusy, deps.nodeReplacementFlight, deps.nodeCleanupPending, deps.isWriteEnabled, deps.START_CONTROL_FLAG,
    deps.transcriptStore, deps.resumeNodeSession, deps.rebindRailToSession, deps.resumeNodeCommandResult,
    deps.sessionNodeIds, deps.sessionThreadIds,
  )
}

test('resume-node: a live treeStore matching the computer resolves and completes, exactly as before', async () => {
  const resumedNode = { id: RESUME_NODE_ID, sessionId: 'session-new', status: 'running' }
  const store = makeStore(new Map([[RESUME_NODE_ID, resumedNode]]))
  const result = await runResumeBranch({ treeStore: store, treeStoreId: COMPUTER_ID })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-new')
})

test('resume-node: a released treeStore with nothing retained anywhere refuses MC_TREE_COMMAND_COMPUTER_NOT_FOUND -- it does not throw', async () => {
  const result = await runResumeBranch({ treeStore: null, treeStoreId: COMPUTER_ID })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND')
  assert.equal(result.nodeId, RESUME_NODE_ID)
})

test('resume-node: a released treeStore with the computer\'s store still held in RUN_STARTING_TREE_STORES (by some other overlapping operation) still completes', async () => {
  const resumedNode = { id: RESUME_NODE_ID, sessionId: 'session-new', status: 'running' }
  const retained = makeStore(new Map([[RESUME_NODE_ID, resumedNode]]))
  const result = await runResumeBranch({
    treeStore: null, treeStoreId: COMPUTER_ID,
    runStartingTreeStores: new Map([[COMPUTER_ID, { store: retained, count: 1 }]]),
  })
  assert.equal(result.ok, true, 'a store still retained by anything must let the resume finish, not merely stop it from throwing')
  assert.equal(result.sessionId, 'session-new')
})

test('resume-node: a resolved store that no longer has this node refuses cleanly through resumeNodeCommandResult, not a crash', async () => {
  const store = makeStore(new Map()) // node genuinely gone from this store
  const result = await runResumeBranch({ treeStore: store, treeStoreId: COMPUTER_ID })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
})
