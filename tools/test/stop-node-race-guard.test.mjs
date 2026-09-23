/* BOTH STOP DOORS MUST ASK stopStillOwnsNode BEFORE STAMPING "STOPPED" ONTO
 * THE TREE, NOT ONLY CLOSE THE SESSION.
 *
 * See tools/test/stop-node-session.test.mjs and src/stop-node-session.js for
 * the defect and the pure predicate that closes it: a stop's own
 * bridge.close(...) is a real, possibly slow await, and a concurrent
 * fresh-start or resume for the SAME node can replace node.sessionId while
 * that close is in flight. The predicate is fully covered on its own; this
 * file pins the OTHER half -- that both places in computers.js which can
 * still write 'finished' onto a node after a stop's close settles actually
 * call it first, rather than writing unconditionally the way both did
 * before this fix.
 *
 * runPaletteAction's 'stop' branch and runTreeNodeCommand's 'stop-node'
 * branch are closure-private inside computersView, the same wall this
 * neighbourhood's sibling tests (resume-restart-share-replacement-guard,
 * resume-destroyed-session-leak, start-control-flag-gates-the-tree) already
 * document and pin the same way: reading the source and asserting the
 * structural invariant.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')
const body = stripBlockComments(view)

function slice(startMarker, endMarker) {
  const start = body.indexOf(startMarker)
  assert.notEqual(start, -1, `could not find ${JSON.stringify(startMarker)} -- it was renamed, removed, or moved`)
  const end = body.indexOf(endMarker, start)
  assert.notEqual(end, -1, `could not find ${JSON.stringify(endMarker)} after ${JSON.stringify(startMarker)} -- it was renamed, removed, or moved`)
  return body.slice(start, end)
}

test('the view imports the race guard from its own module, not a private reimplementation', () => {
  assert.match(view, /import \{ stopStillOwnsNode \} from '\.\.\/stop-node-session\.js'/,
    'computers.js no longer imports stopStillOwnsNode -- either stop branch below may be unguarded again')
})

test('runTreeNodeCommand\'s stop-node branch asks stopStillOwnsNode before writing "finished", not unconditionally', () => {
  /* Exact string, not the combined `... || ... 'fresh-start-existing-node'`
     check a few lines above it -- see the audit commit for why the trailing
     ") {" matters: a landmark that is also a PREFIX of a different, earlier
     check can silently re-target the wrong one. */
  const stopNode = slice("if (command.action === 'stop-node') {", "if (command.action === 'remove-node') {")

  const closeAt = stopNode.indexOf('await bridge.close(')
  assert.notEqual(closeAt, -1, 'the stop-node branch no longer closes the session at all')
  const guardAt = stopNode.indexOf('stopStillOwnsNode(', closeAt)
  assert.notEqual(guardAt, -1,
    'stop-node writes the tree status without ever asking stopStillOwnsNode -- a fresh-start or resume racing this ' +
    'stop on the same node can have this stop\'s stale write land on top of the newer, live session it replaced')
  const writeAt = stopNode.indexOf("setNodeStatus(node.id, 'finished'", guardAt)
  assert.notEqual(writeAt, -1,
    'the "finished" status write no longer follows the guard where this test expects it')

  /* Not merely PRESENT somewhere after the guard call -- actually INSIDE the
     block the guard's own if() controls. Every line between the guard's own
     "if (" and the status write must stay inside one unclosed brace, i.e. no
     "}" that isn't itself immediately reopened has appeared -- a guard whose
     if-body was accidentally emptied (write moved back outside it, or the
     guard demoted to a truthiness check that discards its own comparison)
     would still satisfy the two indexOf checks above while writing
     unconditionally again. */
  const ifAt = stopNode.lastIndexOf('if (', guardAt + 'stopStillOwnsNode('.length)
  assert.notEqual(ifAt, -1, 'stopStillOwnsNode is not the condition of an if () at all')
  const between = stopNode.slice(ifAt, writeAt)
  const opens = (between.match(/\{/g) || []).length
  const closesBeforeLast = (between.slice(0, between.lastIndexOf('{')).match(/\}/g) || []).length
  assert.ok(opens > closesBeforeLast,
    'the guard\'s own if-block closed before the "finished" write -- the write sits after the guard, not inside it, ' +
    'so it would still run whether or not stopStillOwnsNode said the node had moved on')
})

test('the palette and hosted person Stop use the same confirmed-close helper and fresh node predicate', () => {
  const palette = slice("if (id === 'stop') {", 'function closePersonNode(')
  assert.match(palette, /await closePersonNode\(node, request => bridge.close\(request\)\)/)
  const shared = slice('function closePersonNode(', 'function hostedStopNode(')
  assert.match(shared, /const latest = store\?\.getNode\(node.id\)/)
  assert.match(shared, /stopStillOwnsNode\(node.sessionId, latest\)/)
  assert.match(shared, /return stopNativePersonSession\(node,/)
  const helper = readFileSync(join(ROOT, 'src', 'native-person-stop.js'), 'utf8')
  assert.ok(helper.indexOf('await deps.close(') < helper.indexOf('deps.ownsNode(node)'))
  assert.match(helper, /if \(active && deps.ownsNode\(node\)\) \{\s*const result = deps.saveStopped\(node\)/)
  // Actual delayed close/replacement and mounted native lifecycle cases live
  // in native-stop-renderer and native-stop-mounted, alongside this wiring check.
})

test('both stop branches ask a FRESH treeStore read, never comparing the node parameter against itself', () => {
  /* node.sessionId is the parameter's own frozen field -- reading it again
     here (rather than a captured local) is safe and correct, since node is
     never reassigned in either branch: it is the SAME value that was handed
     to bridge.close. The guard only means anything if its SECOND argument is
     a fresh treeStore.getNode(...) read taken AFTER the close settled, not
     `node` itself -- comparing node.sessionId against node.sessionId would
     trivially always agree and silently defeat the whole guard. */
  const stopNode = slice("if (command.action === 'stop-node') {", "if (command.action === 'remove-node') {")
  /* THE STORE'S NAME IS NOT THE CONTRACT; THE FRESH READ IS. This pinned the
     identifier `treeStore`, and the stop branch now resolves the live store
     first (resolveLiveTreeStore()) so that a view which disappeared while the
     close was in flight returns the authoritative close receipt instead of a
     retryable "nothing was done". That is a better implementation of the same
     guarantee, and a spelling pin would have forced it back out. What still
     has to hold -- and what this now asserts -- is that the SECOND argument is
     a getNode(node.id) read taken on some store, never `node` itself and never
     a value captured before the close, either of which would trivially agree
     with node.sessionId and silently defeat the guard. */
  assert.match(stopNode, /stopStillOwnsNode\(node\.sessionId, [A-Za-z_$][\w$]*\.getNode\(node\.id\)\)/,
    'stop-node\'s guard call no longer compares node.sessionId against a FRESH treeStore.getNode read -- comparing ' +
    'node against itself (or a value captured before the close) would always agree and defeat the guard')

  const shared = slice('function closePersonNode(', 'function hostedStopNode(')
  assert.match(shared, /const latest = store\?\.getNode\(node.id\)/)
  assert.match(shared, /stopStillOwnsNode\(node.sessionId, latest\)/)
})
