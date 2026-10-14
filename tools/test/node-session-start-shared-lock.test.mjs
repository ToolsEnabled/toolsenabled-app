/* RESUME AND "START OVER" MUST REFUSE EACH OTHER, NOT ONLY THEMSELVES.
 *
 * THE DEFECT, found by tracing resumeNodeSessionUnguarded and
 * freshStartExistingNodeUnguarded side by side in src/views/computers.js.
 * Both are "start a session for a node that already has one": both await
 * ensureSeatForNode (identity/seat resolution) BEFORE closing the old
 * session, both then close it, clear the same session maps, and call
 * bridge.start to bind a fresh sessionId onto the same node. Each is guarded
 * against a SECOND PRESS OF ITSELF -- resumeNodeSession through resumeFlight,
 * freshStartExistingNode through cleanReplacementFlight -- but those were two
 * INDEPENDENT createSingleFlight() instances, each with its own private Set.
 * Neither lock has ever heard of the other.
 *
 * So: a person opens a finished node's palette and presses Resume. Before
 * its first await (ensureSeatForNode) resolves, an assistant's
 * fresh-start-existing-node command reaches runTreeNodeCommand for the SAME
 * node (or the person presses "Start over" on it from another window/tab of
 * the same palette). nodeBusy() -- the only thing gating either row --
 * reads the node's STATUS, which stays 'finished'/'failed' for the entire
 * window between the press and the new session opening; it says nothing
 * about either flight already being under way. cleanReplacementFlight has
 * never heard of resumeFlight's key, so it proceeds. Both
 * ...Unguarded functions now run concurrently, both eventually call
 * bridge.start, and both write node.sessionId / sessionNodeIds / the tree
 * store's attached session for the SAME node -- exactly the failure
 * resumeFlight's own comment says createSingleFlight exists to prevent:
 * "two bridge.start calls ran. Both sessions registered in sessionNodeIds
 * and both wrote to the same node; the later one won node.sessionId, and
 * the loser kept running -- and spending -- with Stop and Interrupt both
 * addressing the winner, so nothing on screen could reach it." That bug is
 * back, just reachable through two different verbs instead of one doubled
 * press.
 *
 * THE FIX: freshStartExistingNode and resumeNodeSession must hold the SAME
 * single-flight lock, keyed by node id, so whichever of the two starts
 * first for a node refuses the other until it settles.
 *
 * resumeNodeSessionUnguarded and freshStartExistingNodeUnguarded are
 * closure-private inside computersView -- tools/test/resume-destroyed-
 * session-leak.test.mjs and tools/test/resume-keeps-the-conversation.test.mjs
 * hit the same wall for the same functions and pin their rules the same way
 * this does: by reading the source and asserting the structural fact the
 * rule requires, rather than driving a full DOM + tree-store + palette
 * harness neither of those files needed either.
 *
 *   node tools/test/node-session-start-shared-lock.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* CODE ONLY. This file's own comments narrate the bug being pinned, so a raw
   scan of the text would trip over its own explanation the way the sibling
   files above already note. */
const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')

function slice(startMarker, endMarker, fromIndex = 0) {
  const start = view.indexOf(startMarker, fromIndex)
  assert.notEqual(start, -1, `"${startMarker}" not found -- renamed or removed`)
  const end = view.indexOf(endMarker, start)
  assert.notEqual(end, -1, `"${endMarker}" not found after "${startMarker}" -- renamed, removed, or reordered`)
  return view.slice(start, end)
}

/* THE FUNCTION'S NAME IS THE LANDMARK, NOT ITS PARAMETER LIST. These markers
   used to carry the arguments verbatim, so fix/1041-page2-interactions adding
   an `afterBind` option to freshStartExistingNode made both tests below red
   about a rename that had not happened. The trailing '(' still rules out the
   Unguarded sibling -- the only other identifier either name prefixes -- and
   the end markers still say where each guarded wrapper stops. */
function lockNameUsedBy(label, startMarker, endMarker) {
  const body = stripBlockComments(slice(startMarker, endMarker))
  const call = body.match(/(\w+)\.run\(/)
  assert.ok(call, `${label} no longer guards itself through a single-flight ".run(...)" call`)
  return call[1]
}

test('freshStartExistingNode and resumeNodeSession hold the SAME single-flight lock for a node (bad value: two different lock names)', () => {
  const freshLock = lockNameUsedBy(
    'freshStartExistingNode',
    'async function freshStartExistingNode(',
    '\n  async function freshStartExistingNodeUnguarded',
  )
  const resumeLock = lockNameUsedBy(
    'resumeNodeSession',
    'async function resumeNodeSession(',
    '\n  async function resumeNodeSessionUnguarded',
  )

  assert.equal(freshLock, resumeLock,
    `freshStartExistingNode locks a node id through "${freshLock}" and resumeNodeSession locks the SAME node id ` +
    `through "${resumeLock}" -- two different single-flight instances, each blind to the other's key. A person's ` +
    'Resume press and an assistant\'s (or the person\'s own) "Start over" press for the same node can now run ' +
    'concurrently: both await ensureSeatForNode before touching a session, so neither lock has closed before the ' +
    'other opens. Both go on to call bridge.start and bind their own sessionId onto the SAME node -- the exact ' +
    'defect resumeFlight was built to prevent, reachable again through the other verb.')
})

test('exactly one createSingleFlight() call feeds the shared node-session-start lock (bad value: a second private instance behind the same name)', () => {
  const freshLock = lockNameUsedBy(
    'freshStartExistingNode',
    'async function freshStartExistingNode(',
    '\n  async function freshStartExistingNodeUnguarded',
  )
  const code = stripBlockComments(view)
  const declarations = [...code.matchAll(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*([^\n]+)/gm)]
  const feedingThisName = declarations.filter(match => match[1] === freshLock)
  assert.equal(feedingThisName.length, 1, 'the shared lock name must have exactly one declaration')
  // The lock now survives view replacement so account recovery shares it too.
  // Follow the one alias to its module instance and reject local shadow copies.
  assert.equal(feedingThisName[0][2].trim(), 'RUN_NODE_REPLACEMENTS',
    'resume and fresh start must use the process-wide replacement lock')
  const instances = declarations.filter(match => match[1] === 'RUN_NODE_REPLACEMENTS')
  assert.equal(instances.length, 1, 'a second declaration can hide an independent replacement lock')
  assert.equal(instances[0][2].trim(), 'createSingleFlight()',
    'the shared instance must be created by the actual single-flight implementation')
  const viewStart = code.indexOf('export function computersView(')
  assert.ok(viewStart >= 0 && instances[0].index < viewStart,
    'the replacement lock must outlive individual mounted views')
})
