/* THE FLEET PAGE HAS TO HAND declaredFleetData() THE HALF ONLY IT HOLDS.
 *
 * WHAT WAS MEASURED, 2026-08-18, on a staged packaged build with a fresh
 * profile: `.static-tree-node` = 0 on the live board, so
 * tools/team-panel-packaged-qa, tools/loop-packaged-qa and the live half of
 * tools/example-page-write-fence-qa all failed at the same line -- "clicking an
 * agent opens the rail board: absent" -- and every check behind it fell with it.
 *
 * THE CAUSE WAS ONE MISSING ARGUMENT. src/declared-fleet.js takes `(org,
 * started)` and is proven both ways under tools/test/declared-fleet.test.mjs:
 * hand it a started session and the agent is on the tree, hand it none and the
 * tree is empty. src/views/computers.js -- the only caller -- called it with
 * `(org)` at BOTH sites, from 6f0a34a until this file existed. So the second
 * argument defaulted to null on every call the product ever made, `running` was
 * always empty, and the declared fallback that every customer install falls back
 * to (public/data/fleet.json ships ok:false) could not draw a node whatever the
 * person did. Start an agent from its own page and return here and the board
 * said "Nothing has run on this computer yet" over a live child process.
 *
 * AND THE TREE IS NOT THE WORST OF IT. showProjectionControls() is the only
 * builder of the Dispatch, Team, Loop and Codex Cloud controls, and it is
 * reached by SELECTING A NODE. No node, no selection, no controls -- on every
 * install, for the life of the defect.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A MOUNT. The view is a 5,000-line closure
 * over a live DOM, and the argument list is the entire defect: unit-testing the
 * module it calls could not see it (that suite was green throughout), and the
 * packaged drivers that DID see it cost a staged Electron build each. This is
 * the same instrument tools/test/start-control-flag-gates-the-tree.test.mjs uses
 * on the same file for the same class of defect -- a call in this view that
 * silently stopped asking a question -- and it fails in under a second.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { declaredFleetData } from '../../src/declared-fleet.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* COMMENTS ARE NOT CALLS, and this file learned that the hard way: its first
   draft reported the header prose eighteen lines above the import as a defective
   call site, which is a harness fault wearing a product defect's words. Block
   and line comments are blanked to SPACES rather than deleted, so every reported
   line number is still the line number in the file a person will open. */
const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const code = view
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:])\/\/.*$/gm, (match, before) => before + blankButNewlines(match.slice(before.length)))

/* Every call, with its arguments. Nested parentheses are possible in an argument
   list (both sites pass a call), so the balance is counted rather than assumed,
   and a call this cannot parse FAILS rather than being skipped. */
function callsInView() {
  const calls = []
  const needle = 'declaredFleetData('
  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
    let depth = 1
    let end = at + needle.length
    while (end < view.length && depth > 0) {
      if (view[end] === '(') depth += 1
      else if (view[end] === ')') depth -= 1
      end += 1
    }
    assert.equal(depth, 0, `an unbalanced declaredFleetData( call at index ${at}`)
    calls.push({
      at,
      line: view.slice(0, at).split('\n').length,
      args: view.slice(at + needle.length, end - 1),
    })
  }
  return calls
}

test('the module still refuses to draw a node when the caller hands it nothing', () => {
  /* THE POSITIVE CONTROL FOR EVERYTHING BELOW. If this ever fails, the source
     assertions are worthless: they would be insisting on an argument that no
     longer decides anything. */
  const org = { revision: 3, agents: [{ id: 'helper-1', displayName: 'Helper', role: 'worker', provider: 'codex', enabled: true }] }
  assert.deepEqual(declaredFleetData(org).graph.nodes, [],
    'declaredFleetData with no started sessions must draw nothing -- the owner rule the argument exists to serve')
  assert.deepEqual(
    declaredFleetData(org, { agentId: 'helper-1', sessionId: 's-1', phase: 'open' }).graph.nodes.map(node => node.id),
    ['helper-1'],
    'declaredFleetData WITH a started session must draw it, or the argument this test guards is decorative')
})

test('the fleet page passes the started sessions to every projection it builds', () => {
  const calls = callsInView()
  assert.ok(calls.length >= 2, `the view no longer projects a declared fleet at all (${calls.length} calls found)`)
  for (const call of calls) {
    const args = call.args.split(',').map(part => part.trim()).filter(Boolean)
    assert.ok(args.length >= 2,
      `src/views/computers.js:${call.line} calls declaredFleetData(${call.args}) with no started sessions, `
      + 'so that projection can never contain a node, the rail can never be opened by selecting one, '
      + 'and Dispatch/Team/Loop/Codex Cloud are unreachable on this build')
    assert.match(args[1], /readLiveSession\(\)/,
      `src/views/computers.js:${call.line} passes "${args[1]}" as the started sessions. The live record is `
      + 'readLiveSession() from src/agent-session-registry.js -- the one module that knows which agent a '
      + 'session belongs to; anything else is a second answer to that question')
  }
})

test('a session that starts while the page is open redraws it', () => {
  /* Reading the registry at the two projection sites covers the navigation
     journey only. A start that happens with this page already on screen changes
     nothing a person can see unless the page is listening. */
  assert.match(view, /import \{[^}]*onLiveSession[^}]*\} from '\.\.\/agent-session-registry\.js'/,
    'the view does not subscribe to the live-session registry at all')
  assert.match(view, /unsubs\.push\(onLiveSession\(/,
    'the live-session subscription is not registered for teardown, so a closed page keeps redrawing itself')
})
