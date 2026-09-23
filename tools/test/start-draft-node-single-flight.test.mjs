/* A DRAFT NODE CAN BE STARTED TWICE, BECAUSE NOTHING EVER CHECKS startingNodeIds.
 *
 * THE DEFECT, found by tracing startDraftNode's own body in
 * src/views/computers.js top to bottom. Its only gate against running twice
 * for the same node is `liveNode.status !== 'draft'`, read once at entry --
 * and the status is not written to 'starting' until AFTER `await
 * ensureSeatForNode(node, identityRole)`, a real seat-provisioning round trip
 * (with its own revision-conflict retry, per
 * tools/test/start-draft-node-anonymous-reason.test.mjs). Anything that
 * enters startDraftNode for the same node before an earlier call has reached
 * that write reads the same 'draft' status, passes the same gate, and goes on
 * to call bridge.start -- exactly like the earlier one.
 *
 * startingNodeIds (const startingNodeIds = new Set(), just above
 * createAndStartNode) is the very Set single-flight.js's own header names as
 * one of the three hand-rolled guards createSingleFlight replaced ("each a
 * Set with an add before the first await and a delete in a finally"). But
 * startDraftNode's copy adds to it AFTER the first await, not before, and --
 * more importantly -- NOTHING in the function ever calls
 * startingNodeIds.has(node.id) to refuse a second entry. It is only read
 * elsewhere, for display (a stale 'starting' status left over from a
 * previous app run, and an "active agent" count), never as a guard.
 *
 * REACHABLE THREE WAYS WITH NOTHING ELSE IN COMMON: a fast double press of
 * Start on one draft node's own panel; startSetTree's bulk "Start Set"
 * racing an individual Start on one of the very drafts it just gathered
 * (startSetTree guards ITSELF against a second startSetTree for the same
 * TREE with startingTreeIds -- checked and added to synchronously, before
 * any await, the pattern this file is missing -- but that says nothing about
 * one node inside the tree also being started by hand); and an assistant's
 * create-and-start-node handing its brand-new draft node to this same
 * function while the person, watching refreshTree() paint that circle
 * immediately, presses Start on it themselves before the assistant's own
 * call reaches its first await's continuation. Two bridge.start calls for
 * one draft node is the identical failure resumeFlight's own historical
 * comment already names as the reason createSingleFlight exists: the later
 * one wins the node, the earlier keeps running -- and spending -- with
 * nothing on screen able to reach it again.
 *
 * THE FIX: startDraftNode must hold a single-flight lock keyed by node id,
 * exactly like freshStartExistingNode and resumeNodeSession already do (see
 * tools/test/node-session-start-shared-lock.test.mjs), so a second call for
 * the same node while the first is still mid-flight is refused rather than
 * silently doubled.
 *
 * startDraftNode is closure-private inside computersView -- this pins the
 * structural fact the same way tools/test/resume-destroyed-session-leak.
 * test.mjs and tools/test/node-session-start-shared-lock.test.mjs already do
 * for its two siblings: by reading the source rather than driving a full DOM
 * + tree-store + palette harness.
 *
 *   node tools/test/start-draft-node-single-flight.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* CODE ONLY, so this file's own explanation cannot be mistaken for the code
   it describes. */
const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')

/* BOUNDED SHORT, ON PURPOSE. startDraftNode's full body (the seat/identity
   gate, the bridge.start call and every branch of its result) is roughly two
   hundred lines and would swallow almost any other single-flight call in the
   file if the window were not kept to "the wrapper itself, and nothing
   past it" -- see freshStartExistingNode and resumeNodeSession, both of
   which hold their own lock in the first handful of lines after their
   declaration. A fixed, short window is what makes this assertion mean
   "startDraftNode itself is guarded", not "a guard exists somewhere in this
   file". */
const WRAPPER_WINDOW_CHARS = 700

test('startDraftNode holds a single-flight lock keyed by node id (bad value: no .run() call in its own wrapper)', () => {
  const at = view.indexOf('async function startDraftNode')
  assert.notEqual(at, -1, 'startDraftNode was renamed or removed; this test has nothing to check')
  const wrapper = stripBlockComments(view.slice(at, at + WRAPPER_WINDOW_CHARS))
  const call = wrapper.match(/(\w+)\.run\(/)
  assert.ok(call,
    'no single-flight ".run(...)" call appears in the first ' + WRAPPER_WINDOW_CHARS + ' characters of startDraftNode -- ' +
    'a second call for the same still-draft node, made before the first reaches its own await ensureSeatForNode, ' +
    'reads the same \'draft\' status this function\'s only gate checks, passes it exactly as the first one did, and ' +
    'goes on to call bridge.start a second time for one circle: the later start wins the node, the earlier keeps ' +
    'running -- and spending -- with nothing on screen able to reach it again.')

  const lockName = call[1]
  const declarations = [...view.matchAll(/const\s+(\w+)\s*=\s*createSingleFlight\(\)/g)].map(m => m[1])
  assert.equal(declarations.filter(name => name === lockName).length, 1,
    `expected exactly one "const ${lockName} = createSingleFlight()" feeding startDraftNode's lock`)
})
