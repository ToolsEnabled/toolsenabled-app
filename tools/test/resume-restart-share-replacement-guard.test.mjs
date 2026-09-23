/* RESTART RACING RESUME ON THE SAME CIRCLE MUST REFUSE ONE OF THEM, NOT RUN BOTH.
 *
 * freshStartExistingNode (fresh-start-existing-node: the person's own "Start
 * over" row, an assistant's agent.restart tool call routed through
 * runTreeNodeCommand, and the app-userData coordinator) and resumeNodeSession
 * (the person's own Resume/"restart at this depth"/"restart in the new
 * folder" rows, AND the automatic dead-session recovery inside treeCardSend)
 * do the exact same thing to a node: close whatever session it currently
 * holds, start a brand new one, and rebind node.sessionId to it. Both are the
 * "replace this circle's live session" operation single-flight.js was written
 * to guard -- see its own module comment: "the resume one did not exist at
 * all until a second press on a dead node was found starting a SECOND live
 * agent... Both agents then ran, the later one owned the node, and the
 * earlier kept working and spending with nothing on screen able to reach it."
 *
 * THE GAP: each of the two verbs was wrapped in its OWN createSingleFlight()
 * instance (cleanReplacementFlight for freshStartExistingNode, resumeFlight
 * for resumeNodeSession), each keyed by the same node.id -- so the guard
 * stops a second press of the SAME verb, but not the OTHER verb, on the same
 * node. An assistant's agent.restart landing the instant after the person
 * presses Resume on the same finished circle (or the instant the automatic
 * dead-session recovery starts one) sees no in-flight guard at all: both
 * bodies run, both call bridge.start, and whichever settles last wins
 * node.sessionId while the other's freshly started agent is orphaned --
 * exactly the failure this file's own module comment describes, just
 * reachable from the door neither single test covered.
 *
 * resumeNodeSessionUnguarded and freshStartExistingNode are closure-private
 * inside computersView (a CSS loader hook makes the module importable under
 * Node, but nothing exported reaches either without a full DOM + tree-store +
 * palette harness) -- tools/test/resume-destroyed-session-leak.test.mjs hits
 * the same wall for the same neighbourhood and pins its rule the identical
 * way this does: by reading the source and asserting the structural
 * invariant the rule requires. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* CODE ONLY, same reasoning as resume-destroyed-session-leak.test.mjs: this
   file's own comments (above, and inside the view) narrate the bug using the
   very identifiers being asserted on, so a raw scan would trip over its own
   explanation. Offsets are taken after stripping. */
const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')
const body = stripBlockComments(view)

function slice(startMarker, endMarker, fromIndex = 0) {
  const start = body.indexOf(startMarker, fromIndex)
  assert.notEqual(start, -1, `could not find ${JSON.stringify(startMarker)} -- it was renamed or removed`)
  const end = body.indexOf(endMarker, start)
  assert.notEqual(end, -1, `could not find ${JSON.stringify(endMarker)} after ${JSON.stringify(startMarker)} -- it was renamed, removed, or moved`)
  return { text: body.slice(start, end), start, end }
}

function flightIdentifierUsedBy(fnText, fnLabel) {
  const match = fnText.match(/(\w+)\.run\(/)
  assert.ok(match, `${fnLabel} no longer wraps its work in a single-flight .run(...) call at all`)
  return match[1]
}

test('freshStartExistingNode and resumeNodeSession single-flight against each other, not only against themselves', () => {
  /* NAMED BY THE FUNCTION, NOT BY ITS WHOLE PARAMETER LIST. Both landmarks
     used to carry their arguments verbatim, so adding one option -- as
     fix/1041-page2-interactions did, giving freshStartExistingNode an
     `afterBind` callback -- made this test red about a rename that had not
     happened. The trailing '(' still rules out the Unguarded sibling, which is
     the only other thing either name prefixes, and the end markers still pin
     where each guarded wrapper stops. */
  const freshStart = slice('async function freshStartExistingNode(', '\n  async function freshStartExistingNodeUnguarded')
  const resume = slice('async function resumeNodeSession(', '\n  async function resumeNodeSessionUnguarded')

  const freshStartFlight = flightIdentifierUsedBy(freshStart.text, 'freshStartExistingNode')
  const resumeFlight = flightIdentifierUsedBy(resume.text, 'resumeNodeSession')

  assert.equal(freshStartFlight, resumeFlight,
    `freshStartExistingNode guards node replacement with "${freshStartFlight}" and resumeNodeSession guards it with ` +
    `"${resumeFlight}" -- two separate single-flight instances keyed by the same node.id do not see each other's ` +
    'in-flight state, so an assistant\'s agent.restart racing the person\'s Resume (or the automatic dead-session ' +
    'recovery) on the same circle runs BOTH bodies: two live bridge.start calls, two sessions, and whichever settles ' +
    'last wins node.sessionId while the other keeps running and spending with nothing on screen able to reach it -- ' +
    'the identical failure this codebase already fixed for a second press of ONE of these verbs, just reachable from ' +
    'the other door.')

  // Follow the view alias to the one module instance, including recovery.
  // Count declarations so a private copy with the same name cannot pass.
  const declarations = [...body.matchAll(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*([^\n]+)/gm)]
  const aliases = declarations.filter(match => match[1] === freshStartFlight)
  assert.equal(aliases.length, 1, 'both verbs must resolve one shared binding')
  assert.equal(aliases[0][2].trim(), 'RUN_NODE_REPLACEMENTS')
  const instances = declarations.filter(match => match[1] === 'RUN_NODE_REPLACEMENTS')
  assert.equal(instances.length, 1, 'a private replacement lock must not shadow the shared instance')
  assert.equal(instances[0][2].trim(), 'createSingleFlight()')
  const viewAt = body.indexOf('export function computersView(')
  assert.ok(viewAt >= 0 && instances[0].index < viewAt,
    'the shared replacement lock must survive mounted view replacement')
  const shared = aliases[0][2].trim()
  for (const fn of [freshStart.text, resume.text]) {
    assert.match(fn, new RegExp(`${freshStartFlight}\\.run\\(\\s*node && node\\.id != null \\? node\\.id : null`),
      'both verbs must reserve the exact same node key')
    assert.ok(fn.indexOf('recoveryCoordinator()?.isRecovering(node?.id)') < fn.indexOf(`${freshStartFlight}.run(`)
      && fn.includes('recoveryCoordinator()?.isRecovering(node?.id)'),
    'ordinary replacement must refuse an account recovery before starting its own flight')
  }
  assert.match(body, new RegExp(`isReplacing:\\s*nodeId\\s*=>\\s*${shared}\\.busy\\(nodeId\\)`),
    'account recovery must observe the same app-level ordinary replacement lock')
})

test('the Clear and Resume menu actions enter the guarded replacement wrappers', () => {
  const clear = slice("if (id === 'clear') {", "if (id === 'resume') {")
  const resume = slice("if (id === 'resume') {", "if (id === 'mention') {")
  assert.match(clear.text, /await freshStartExistingNode\(node\)/)
  assert.match(resume.text, /await resumeNodeSession\(node,\s*\{ out \}\)/)
  for (const fn of [clear.text, resume.text]) {
    assert.doesNotMatch(fn, /bridge\.start\(|(?:freshStartExistingNode|resumeNodeSession)Unguarded\(/,
      'menu entry points must not bypass the shared replacement guards')
  }
})

test('automatic and manual account continuation refuse an ordinary replacement already in flight', () => {
  const source = stripBlockComments(readFileSync(join(ROOT, 'src', 'account-recovery-coordinator.js'), 'utf8'))
  const recover = source.slice(source.indexOf('async function recover('), source.indexOf('flights.add(node.id)'))
  assert.match(recover, /if \(isReplacing\(node\.id\)\) return/,
    'automatic account recovery must check the shared replacement lock before reserving a flight')
  const manual = source.slice(source.indexOf('async continueOnAnotherAccount('), source.indexOf('activeStore:'))
  assert.match(manual, /flights\.has\(nodeId\) \|\| isReplacing\(nodeId\)\) return false/,
    'the manual account action must obey both account recovery and ordinary replacement guards')
})
