import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(repo, relative), 'utf8')
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('single-instance handoff carries opaque data and command launches suppress focus', () => {
  const main = read('shell/main.cjs')
  assert.match(main, /requestSingleInstanceLock\(treeNodeCommandAdditionalData\(launchTreeNodeCommandId\)\)/)
  assert.match(main, /treeNodeCommandRequestIdFromArgv\(commandLine/)
  assert.match(main, /treeNodeCommandRequestIdFromAdditionalData\(additionalData\)/)
  const handler = main.slice(main.indexOf('handleSecondInstance:'), main.indexOf('getWindow:', main.indexOf('handleSecondInstance:')))
  /* A REFUSED QUEUE ATTEMPT MUST STILL ANSWER THE SPOOL, THE SAME RULE
     dispatchTreeSpawn's LOCAL path already follows (see
     tools/test/tree-command-refusal-reason.test.mjs, "answers a queue that
     said no at once"). queueRequest can refuse silently -- a disposed broker
     racing app shutdown, or an id this process already queued -- and this
     handoff has no Promise to reject and no console anybody is reading: the
     spooled result file is the only place left to say so. See
     shell/tree-node-command-broker.cjs queueRequestOrRefuse and its own
     driver tests in tools/test/tree-node-command-broker.test.mjs. */
  assert.match(handler, /queueRequestOrRefuse\(treeNodeCommandBroker, requestId, \(code, reason\) => refuseTreeNodeCommandLaunch\(requestId, code, reason\)\)/)
  assert.match(handler, /return \{ focus: false \}/)
  assert.doesNotMatch(handler, /focus\(|restore\(/)
  assert.doesNotMatch(handler, /queueTreeNodeCommand\(requestId\)/,
    'the bare call that swallowed a refused queue attempt must not come back')
  const lock = main.slice(main.indexOf('requestLock:'), main.indexOf('quit:', main.indexOf('requestLock:')))
  assert.match(lock, /refuseTreeNodeCommandWithoutPrimary\(launchTreeNodeCommandId\)/)
  assert.match(lock, /releaseSingleInstanceLock\(\)/)
  assert.match(lock, /return false/)
})

/* THE TWO GRAMMAR CALL SITES MUST DESCRIBE THE SAME PROCESS.
 *
 * MEASURED 2026-09-03 on the owner's Live tier: nine spooled resume commands
 * were written and none was claimed, because both call sites told the grammar
 * the one permitted entry argument was `__filename` while the development
 * launch names the app DIRECTORY. The behaviour that fixes it is asserted by
 * calling the grammar with values in tools/test/tree-node-command.test.mjs;
 * this is the wiring half -- that main.cjs asks Electron which application and
 * which profile this process is, in both places, and that neither goes back to
 * the single-filename spelling. */
test('both command-grammar call sites take their identity from Electron, not from one filename', () => {
  const main = withoutComments(read('shell/main.cjs'))
  assert.match(main, /const treeNodeCommandLaunchIdentity = \(form = 'launch'\) => \{/)
  assert.match(main, /app\.getAppPath\(\)/)
  assert.match(main, /developmentUserDataPath: app\.commandLine\.hasSwitch\('user-data-dir'\)/)
  /* MEASURED 2026-09-04 on Electron 43.3.0: the primary's second-instance argv
     is Chromium's order plus every switch the helper appended before the lock,
     so the relayed call site names those switches and the helper's own call
     site does not -- a stray on a helper's own argv still refuses. */
  assert.match(main, /\.\.\.treeNodeCommandLaunchIdentity\('launch'\)/)
  assert.match(main, /\.\.\.treeNodeCommandLaunchIdentity\('relayed'\)/)
  assert.equal(main.match(/\.\.\.treeNodeCommandLaunchIdentity\(/g)?.length, 2)
  assert.match(main, /appendedSwitches = form === 'relayed' \? OUTSIDE_CONTROL_SWITCHES : \[\]/)
  assert.match(main, /const \{ OUTSIDE_CONTROL_SWITCHES \} = require\('\.\/outside-control\.cjs'\)/)
  assert.doesNotMatch(main, /developmentEntry: app\.isPackaged \? null : __filename/)
})

test('a command launch refused before the broker writes its reason into the request result', () => {
  const main = withoutComments(read('shell/main.cjs'))
  /* MEASURED 2026-09-04T08:16Z: a Live result file said
     MC_TREE_COMMAND_ARGUMENT_INVALID and nothing else, because every call site
     threw the grammar's sentence away. The reason now travels beside the code
     at all three: module scope, the second-instance handoff, and no-primary. */
  assert.match(main, /function refuseTreeNodeCommandLaunch\(requestId, code, reason = null\)/)
  assert.match(main, /publishTreeNodeCommandLaunchRefusal\(\{ userDataRoot: SHELL_USER_DATA_PATH, requestId, code, reason \}\)/)
  assert.match(main, /publishTreeNodeCommandLaunchRefusal\(\{ userDataRoot: SHELL_USER_DATA_PATH, requestId: candidate, code, reason \}\)/)
  assert.match(main, /refuseTreeNodeCommandLaunch\(candidate, code, reason\)/)
  /* The argv refusal at module scope, and the second-instance handoff refusal:
     both name the request before exiting, because the helper is detached with
     stdio ignored and a stderr line reaches nobody. */
  assert.equal(main.match(/treeNodeCommandRequestIdCandidateFromArgv\(/g)?.length, 2)
  assert.match(main, /refuseTreeNodeCommandWithoutPrimary\(requestId\) \{\n  return refuseTreeNodeCommandLaunch\(requestId, 'MC_TREE_COMMAND_PRIMARY_INSTANCE_REQUIRED',\n\s+'No running ToolsEnabled instance/)
})

test('loaded preload exposes one bounded main-to-renderer request and completion path', () => {
  const preload = read('shell/fleet-profile-preload.cjs')
  const at = preload.indexOf("contextBridge.exposeInMainWorld('mcTreeCommand'")
  assert.ok(at >= 0)
  const surface = preload.slice(at, preload.indexOf('/* NOTIFICATIONS:', at))
  assert.match(surface, /ipcRenderer\.on\('mc-tree-command:request'/)
  assert.match(surface, /ipcRenderer\.invoke\('mc-tree-command:complete'/)
  assert.doesNotMatch(surface, /start:|resumeThreadId|path:/)
})

test('main resolves commands only below its own userData and delegates liveness to the broker', () => {
  const main = withoutComments(read('shell/main.cjs'))
  assert.match(main, /locateTreeNodeCommandRequest\(\{ userDataRoot: SHELL_USER_DATA_PATH, requestId \}\)/)
  assert.match(main, /createTreeNodeCommandBroker\(\{/)
  assert.match(main, /treeNodeCommandBroker\.rendererReloaded\(\)/)
  assert.match(main, /treeNodeCommandBroker\.setRendererReady\(true\)/)
  assert.doesNotMatch(main, /locateTreeNodeCommandRequest\(\{ workspaceRoot/)
  assert.doesNotMatch(main, /AGENT-SUPPORT-CHANNEL/)
})

/* THE SENTENCE HAS TO TRAVEL THE LAST STEP.
 *
 * The words themselves, and the rule that a code without words leaves the
 * caller on its own wording, are asserted by calling the broker with values in
 * tools/test/tree-node-command-broker.test.mjs. This is the wiring half: that
 * the one place a waiting assistant is answered -- resolveLocalTreeCommand,
 * whose rejection becomes the tool error agent.spawn reads -- asks the broker
 * for that sentence, and keeps its generic line only as the fallback. Without
 * this line the broker can hold a perfectly good sentence nobody is shown. */
/* MERGE 2026-09-03: the fallback line moved out of this function. Two lanes
 * gave this refusal real words -- this one's broker table, and the removal
 * rule's errand table in shell/tree-command-refusal-sentences.cjs -- and
 * main.cjs now asks the broker first and that table second. The fallback
 * SENTENCE is unchanged for the verb this test named; it is simply no longer
 * spelled inline, so the last assertion asks the table for it by calling it
 * with values rather than matching a literal in the caller. */
test('a waiting assistant is answered with the broker sentence, and the generic line only as fallback', async () => {
  const main = withoutComments(read('shell/main.cjs'))
  assert.match(main, /treeNodeCommandRefusalSentence \} = require\('\.\/tree-node-command-broker\.cjs'\)/)
  const start = main.indexOf('function resolveLocalTreeCommand(')
  const resolve = main.slice(start, main.indexOf('function dispatchTreeSpawn(', start))
  assert.ok(start >= 0 && resolve.length > 0)
  assert.match(resolve, /treeNodeCommandRefusalSentence\(code\)\s*\n?\s*\|\|/)
  /* Three arguments: the errand, the code, and the renderer's own bounded
     reason -- see tools/test/tree-command-refusal-reason.test.mjs. */
  assert.match(resolve, /\|\|\s*\n?\s*treeCommandRefusalSentence\(envelope\?\.request\?\.action, code, result\?\.reason\)/)

  const { treeCommandRefusalSentence } = (await import('../../shell/tree-command-refusal-sentences.cjs')).default
  assert.match(
    treeCommandRefusalSentence('create-and-start-node', 'MC_TREE_COMMAND_RENDERER_FAILED'),
    /could not add that assistant to the tree/,
  )
})

test('renderer queue mounts Computers and delegates to the view-owned command method', () => {
  const main = read('src/main.js')
  assert.match(main, /pendingTreeNodeCommands/)
  assert.match(main, /#\/computers\/\$\{command\.computerId\}/)
  assert.match(main, /current\.view\.runTreeNodeCommand\(command\)/)
  assert.match(main, /void drainTreeNodeCommands\(\)/)
})

/* THE GATE THAT DROPS A REQUEST ON THE FLOOR WITHOUT A WORD.
 *
 * MEASURED 2026-09-03 (REPORT-controller-2-tree-spawn-regression-20260903.md):
 * cleanTreeNodeCommand returns null for a create-and-start-node brief over its
 * own length check, and the onRequest listener below does `if (!command ...)
 * return` -- nothing calls bridge.complete, so the waiting caller gets no
 * refusal, only the generic 90-second timeout. That make this ceiling special:
 * unlike every other field this function rejects with a reason, getting the
 * NUMBER wrong here does not just refuse a spawn, it hangs one. The number
 * used to be a literal 4,000 restated a third time (engine's
 * MAX_TREE_BRIEF_CHARS and fleet-trees.js's FLEET_TREE_LIMITS.maxMessageChars
 * are the other two, and the engine's side had already moved to 12,000) --
 * measured real contracts of 4,229-5,035 characters hung this way. This reads
 * the actual comparison out of the source, in the idiom this file already
 * uses above, so a literal number reintroduced here fails exactly the way the
 * original bug did rather than passing because some OTHER file agrees with it. */
test('the create-command gate refuses a brief by the store\'s own ceiling, never a number of its own', () => {
  const main = read('src/main.js')
  assert.match(main, /import \{ FLEET_TREE_LIMITS \} from '\.\/fleet-trees\.js'/,
    'the ceiling must be imported from the store, not declared a second time in this file')
  const start = main.indexOf('function cleanTreeNodeCommand(value)')
  const end = main.indexOf('async function completeTreeNodeCommand(', start)
  assert.ok(start >= 0 && end > start)
  const gate = main.slice(start, end)
  assert.match(gate, /value\.brief\.length > FLEET_TREE_LIMITS\.maxMessageChars/)
  assert.doesNotMatch(gate, /value\.brief\.length > \d/,
    'a literal number here is the exact shape of the 2026-09-03 regression, even if the digits happen to be 12000')
})

test('clean replacement core cannot resume, seed, or send before binding the new session', () => {
  const clean = withoutComments(read('src/fresh-start-existing-node.js'))
  assert.match(clean, /transcriptStore\.remove\(node\.id\)/)
  assert.match(clean, /diffHistoryStore\.remove\(node\.id\)/)
  assert.match(clean, /started = await bridge\.start\(\{/)
  assert.match(clean, /requestKeys/)
  assert.doesNotMatch(clean, /resumeThreadId/)
  assert.doesNotMatch(clean, /transcriptSeedText\(/)
  assert.doesNotMatch(clean, /bridge\.send\(/)
  const bind = clean.indexOf('nodeIds.set(started.sessionId, node.id)')
  const attached = clean.indexOf('treeStore.attachSession(node.id, started.sessionId)')
  const success = clean.indexOf('return { ok: true')
  assert.ok(bind >= 0 && attached > bind && success > attached, 'event map and tree store bind before session id is returned')
})

test('view command checks computer, tree, node, and optional old session before replacement', () => {
  const view = read('src/views/computers.js')
  const start = view.indexOf('async runTreeNodeCommand(command)')
  const end = view.indexOf('destroy() {', start)
  const command = view.slice(start, end)
  assert.match(command, /treeStoreId !== command\.computerId/)
  assert.match(command, /node\.treeId !== command\.treeId/)
  assert.match(command, /command\.expectedSessionId && node\.sessionId !== command\.expectedSessionId/)
  assert.match(command, /freshStartExistingNode\(node, \{\s*afterBind:/,
    'agent.restart stopped holding the clean-replacement flight through its saved-brief send')
  assert.match(command, /executeRestartExistingNodeCommand\(\{/,
    'agent.restart creates a fresh session but never sends the node\'s saved brief')
  assert.match(command, /briefContextFor\(rebound, parent\)/,
    'agent.restart stopped rebuilding the manager/report context from the saved tree')
  assert.match(command, /executeSendToBoundNode\(\{/)
})

test('the person-facing clear action remains a no-send clean replacement', () => {
  const view = read('src/views/computers.js')
  const start = view.indexOf("if (id === 'clear')")
  const end = view.indexOf("if (id === 'resume')", start)
  const clear = view.slice(start, end)
  assert.match(clear, /freshStartExistingNode\(node\)/)
  assert.doesNotMatch(clear, /afterBind|executeRestartExistingNodeCommand|bridge\.send/)
})

test('writer and documentation use app userData and keep messages off argv', () => {
  const writer = withoutComments(read('tools/write-tree-node-command.mjs'))
  const docs = read('docs/coordinator-tree-node-command.md')
  assert.match(writer, /createTreeNodeCommandRequest/)
  assert.match(writer, /readFileSync\(0, 'utf8'\)/)
  assert.match(writer, /user-data-root/)
  assert.doesNotMatch(writer, /workspace-root|--message/)
  assert.doesNotMatch(writer, /spawn|exec|ToolsEnabled\.exe/)
  assert.match(docs, /private per-user data/i)
  assert.match(docs, /stays mutation-dead/i)
  assert.match(docs, /request file alone never starts or sends anything/i)
  assert.match(docs, /never uses\s+`resumeThreadId`/)
  assert.match(docs, /message.*never placed in argv/is)
})

/* A RELOAD IS A MAIN-FRAME NAVIGATION, NOT A SPINNER. MEASURED 2026-09-04
   15:16-15:39Z: three tree commands were refused MC_TREE_COMMAND_RENDERER_RELOADED
   while the window never reloaded, because rendererReloaded() hung off
   did-start-loading, which also fires when a frame inside the page starts
   loading. Only a top-level navigation that replaces the document can lose the
   renderer's queue. */
test('the broker learns of a reload only from a main-frame, new-document navigation', () => {
  const main = read('shell/main.cjs')
  assert.doesNotMatch(main, /on\('did-start-loading',\s*\(\)\s*=>\s*\{\s*void treeNodeCommandBroker\.rendererReloaded\(\)/,
    'rendererReloaded is wired to did-start-loading again, which fires for frames inside the page')
  const handlers = [...main.matchAll(/window\.webContents\.on\('did-start-navigation', (details => \{[\s\S]*?\n  \})\)/g)]
  assert.equal(handlers.length, 1, 'one main-document navigation handler owns reload invalidation')
  const calls = []
  const inputOwner = Object.freeze({ fixture: 'document-owner' })
  const ownedCall = name => owner => {
    assert.equal(owner, inputOwner)
    calls.push(name)
  }
  // Run the actual callback. Other document-scoped cleanup may precede the
  // broker notification, but none of it may run for a hash or child frame.
  const navigate = vm.runInNewContext(`(${handlers[0][1]})`, {
    inputOwner,
    accessibilityApp: { invalidateDocument: ownedCall('document') },
    accessibilityHost: { close: ownedCall('accessibility') },
    screenControlHost: { close: ownedCall('screen-control') },
    treeNodeCommandBroker: { rendererReloaded: () => calls.push('broker') },
    handCameraOwners: { delete: ownedCall('camera') },
    voiceHost: { close: ownedCall('voice') },
  })
  for (const details of [undefined, null, {}, { isMainFrame: false },
    { isMainFrame: 1 }, { isMainFrame: true, isSameDocument: true }]) {
    navigate(details)
    assert.deepEqual(calls, [], 'non-document navigation must preserve every owner')
  }
  navigate({ isMainFrame: true, isSameDocument: false })
  assert.deepEqual(calls, ['document', 'accessibility', 'screen-control', 'broker', 'camera', 'voice'])
})
