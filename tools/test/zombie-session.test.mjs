/* CLOSING THE APP MID-TURN MUST NOT LEAVE A ZOMBIE.
 *
 * THE JOURNEY, measured on the packaged build 2026-08-16. Start an agent, close
 * ToolsEnabled while it is answering (the child is killed correctly), reopen the
 * same profile. The circle is blue with a runtime clock climbing 0:00:33 ->
 * 0:04:12, the chip says "starting", the chat header says "live session", and a
 * typed message is answered with "Queued — sends by itself when this turn
 * finishes." It never finishes. Resume is DISABLED because the node looks busy;
 * Stop and Interrupt are ENABLED over a process that no longer exists.
 *
 * TWO INDEPENDENT DEFECTS MADE IT, and fixing either alone leaves the other:
 *   1. every saved session id was re-registered as live when the store opened,
 *      which destroyed the premise the liveness test depends on, and
 *   2. the clock's stop time was granted only to `finished` and `failed`, and
 *      a node saved mid-turn loads back as `starting`, which is neither.
 *
 * A third one sat behind the way out: resuming the node cleared the outbox, so
 * a message the composer had already promised to send was destroyed in silence
 * by the very action taken to rescue it.
 *
 * These are driven for real. The rules live in DOM-free modules
 * (src/tree-session-liveness.js, src/session-outbox.js) precisely so a plain
 * `node --test` process can run them rather than match their source; the
 * wiring in src/views/computers.js, which imports three stylesheets and cannot
 * be loaded here, is pinned at the end and driven end-to-end by the packaged
 * run.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

import {
  nodeIsBusy,
  sessionEndedWithApp,
  sessionIsLive,
  treeNodeClock,
} from '../../src/tree-session-liveness.js'
import { clearSession, enqueue, list, moveSession } from '../../src/session-outbox.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* Extract the complete local function, ending at its own two-space-indented
   closing brace. Fixed character windows turn an added comment into a test
   failure and can miss the call they meant to prove. */
function viewFunction(name) {
  const match = new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm').exec(view)
  assert.ok(match, `function ${name} was not found in the computers view`)
  return match[0]
}

function assertContextUsesEndedSession(contextFeed, statusWord) {
  assert.match(contextFeed, /current:\s*treeNodeStatusWord\(node\)/,
    'the context feed stopped getting its status through the shared status word')
  assert.match(statusWord, /nodeSessionEnded\(node\)/,
    'the shared status word stopped applying ended-session liveness')
}

/* A node as src/fleet-trees.js hands one back after a restart: parseFleetTrees
   loads a saved 'running' as 'starting', and the timestamps are real. The run
   clock comes back CLOSED for the same reason the status comes back demoted --
   the interval that was open when the file was written ended when the app did,
   and 33s is what was measured of it before the close. */
const STARTED_AT = Date.parse('2026-08-16T10:00:00.000Z')
const LAST_WRITE = Date.parse('2026-08-16T10:00:33.000Z')
const midTurnNode = (over = {}) => ({
  id: 'node-1',
  sessionId: 'session-from-the-last-run',
  status: 'starting',
  createdAt: new Date(STARTED_AT).toISOString(),
  updatedAt: new Date(LAST_WRITE).toISOString(),
  runMs: LAST_WRITE - STARTED_AT,
  runStartedAt: null,
  ...over,
})

/* Sessions THIS run opened. After a restart this is empty, which is the whole
   point: nothing on disk can put an entry in here. */
const noSessions = new Map()
const thisRunOwns = node => new Map([[node.sessionId, node.id]])

test('a session from a previous run is not live, however busy the record looks', () => {
  const node = midTurnNode()
  assert.equal(sessionIsLive(node, noSessions), false)
  assert.equal(nodeIsBusy(node, noSessions), false,
    'the node reads busy over a session this run never opened, so Stop stands over a corpse and every send queues forever')
  assert.equal(sessionEndedWithApp(node, noSessions), true)

  /* And the same record IS live while its session really is. */
  assert.equal(nodeIsBusy(node, thisRunOwns(node)), true,
    'a session this run opened must still read busy, or a working agent loses its stop button')
  assert.equal(sessionEndedWithApp(node, thisRunOwns(node)), false)
})

test('the clock stops when the session does, not only when the turn does', () => {
  const stale = treeNodeClock(midTurnNode(), noSessions)
  /* runtimeEpoch, not bornAt: the field is the instant the digits count FROM,
     and for a node that has run more than once it is shifted back by the runs
     already banked. Here there is one run of 33s, so the epoch lands exactly
     on the start -- the run that happened must still show its start. */
  assert.equal(stale.runtimeEpoch, STARTED_AT, 'the run that happened must still show its start')
  assert.equal(stale.stoppedAt, LAST_WRITE,
    'a null stop time binds a LIVE clock in the graph: this is the runtime that climbed past four minutes over a dead child')
  assert.equal(stale.running, false)

  /* A genuinely running agent keeps its ticking clock. */
  const live = treeNodeClock(midTurnNode(), thisRunOwns(midTurnNode()))
  assert.equal(live.stoppedAt, null, 'a live agent lost its running clock')
  assert.equal(live.running, true)

  /* A turn that really ended still freezes where it ended. */
  const finished = treeNodeClock(midTurnNode({ status: 'finished' }), noSessions)
  assert.equal(finished.stoppedAt, LAST_WRITE)
  assert.equal(finished.running, false)

  /* A node that never held a session has no clock at all, rather than one
     starting at its creation. runMs 0 is part of "never ran": a draft that
     had banked run time would be a node that ran and was let go, which is a
     different record and keeps its figure. */
  const never = treeNodeClock(midTurnNode({ sessionId: null, status: 'draft', runMs: 0 }), noSessions)
  assert.equal(never.runtimeEpoch, null)
  assert.equal(never.stoppedAt, null)
})

test('a set refilled from storage puts the zombie straight back', () => {
  /* The exact shape of the defect: the store re-registered every saved session
     id at open, so the liveness test was asking a question whose answer had
     already been forced to yes. This is here so that regression is a failing
     test and not a walkthrough. */
  const node = midTurnNode()
  const refilledFromDisk = new Map([[node.sessionId, node.id]])
  assert.equal(nodeIsBusy(node, refilledFromDisk), true,
    'this is the defect, reproduced: a set built from saved records makes every dead session live')
  assert.match(
    declaredFunctionSource(view, 'openTreeStore'),
    /for \(const node of treeStore\.snapshot\(\)\.nodes\) \{\s*\n\s*if \(node\.reply\)/,
    'the store is registering saved session ids again at open; the liveness test has nothing left to measure',
  )
  assert.doesNotMatch(declaredFunctionSource(view, 'openTreeStore'), /sessionNodeIds\.set\(/,
    'loading stored nodes must not register a session as live anywhere in the open path')
})

test('the queued words survive the resume that was meant to rescue them', () => {
  clearSession('old-session')
  clearSession('new-session')
  enqueue('old-session', 'seventeen times twenty-three?')
  enqueue('old-session', 'and then stop')
  assert.equal(list('old-session').length, 2)

  const moved = moveSession('old-session', 'new-session')
  assert.equal(moved, 2, 'the messages did not follow the agent to its new session')
  assert.equal(list('old-session').length, 0)
  assert.deepEqual(
    list('new-session').map(entry => entry.text),
    ['seventeen times twenty-three?', 'and then stop'],
    'the words changed or lost their order on the way across',
  )
  clearSession('new-session')
})

test('moving a queue keeps what was already waiting, and refuses the nonsense cases', () => {
  clearSession('from')
  clearSession('to')
  enqueue('to', 'said first, at the new session')
  enqueue('from', 'said second, waiting at the old one')
  assert.equal(moveSession('from', 'to'), 1)
  assert.deepEqual(
    list('to').map(entry => entry.text),
    ['said first, at the new session', 'said second, waiting at the old one'],
    'a carried message jumped the queue it was merged into',
  )
  assert.equal(moveSession('from', 'to'), 0, 'moving an empty queue reported a move')
  assert.equal(moveSession('to', 'to'), 0, 'a session moved to itself')
  assert.equal(moveSession(null, 'to'), 0)
  assert.deepEqual(list('to').length, 2, 'a refused move disturbed the queue')
  clearSession('to')
})

test('the resume carries the queue instead of clearing it, and stop still says what it dropped', () => {
  const resume = view.slice(view.indexOf('async function resumeNodeSession'), view.indexOf('async function runPaletteAction'))
  assert.ok(!/outboxClearSession\(oldSessionId\)/.test(resume),
    'the resume destroys the queued messages again; the composer promised to send them')
  assert.match(resume, /outboxMoveSession\(oldSessionId, result\.sessionId\)/,
    'the queue is not carried to the session that replaces the old one')
  /* Stop is the place where dropping them IS the honest act, and it still says
     how many. This is here so "carry them everywhere" never becomes the fix.
     LANDMARK-BOUNDED, not a fixed character count: a fixed +900 window broke
     here once already (a race guard grew between the branch's own start and
     its "queued message" sentence) even though neither the drop nor the
     sentence moved. performNodeRemoval is the honest boundary: the palette's
     'stop' row is the last branch runPaletteAction has, and that function's
     next sibling declaration is exactly where the row ends. */
  const stopAt = view.indexOf("if (id === 'stop')")
  assert.notEqual(stopAt, -1, 'the palette lost its own Stop row')
  const stopEndAt = view.indexOf('async function performNodeRemoval', stopAt)
  assert.notEqual(stopEndAt, -1, 'performNodeRemoval was renamed, removed, or moved before the Stop row')
  const stop = view.slice(stopAt, stopEndAt)
  /* BOTH HALVES OF THE PROMISE, NEITHER OF THEM A CALL SHAPE. Stop has to drop
     the queue AND say how many it dropped. T50 retired the queue behind an
     injected collaborator, so the drop is wired in as clearOutbox rather than
     called inline as outboxClearSession(node.sessionId) -- the same act, one layer
     out. Pinning the inline form would have forced that refactor back out, so what
     is asserted is that the row still wires the clear and still reports the count. */
  assert.match(stop, /outboxClearSession/,
    'Stop no longer wires the outbox clear, so the queue it tells the person it dropped would quietly survive')
  assert.match(stop, /result\.dropped/,
    'Stop no longer reports how many queued messages it dropped')
  assert.match(stop, /queued message/, 'Stop stopped saying how many messages it dropped')
})

test('every surface that asks "is it running" asks the shared rule', () => {
  /* The defect was six near-copies of one question. Each of these was one of
     them; a raw status test returning to any of them brings back its own
     version of the zombie. */
  const statusWord = viewFunction('treeNodeStatusWord')
  assert.match(statusWord, /nodeSessionEnded\(node\)/,
    'the chip and rail word stopped using the shared liveness rule')

  const graphRecord = viewFunction('treeAgentRecord')
  assert.match(graphRecord, /const running = nodeBusy\(node\)/,
    'the graph record stopped using shared busy-session liveness')
  /* The clock takes the SAME expiring evidence the other three rules take. A
     clock still ticking over a session the rest of the screen had given up on
     is this file's own defect reassembled one rule at a time. */
  assert.match(graphRecord, /const clock = treeNodeClock\(node, ownedSessions\(\), sessionEvidence\(\)\)/,
    'the graph record stopped using the shared ended-session clock with its expiring evidence')
  /* The owned set is this run's session map -- never a saved id re-registered
     as live -- except while the example's own simulated store is on the page,
     when it is the simulation's own running set (2026-09-11 example upgrade). */
  assert.match(view, /const ownedSessions = \(\) => \(sampleRun && treeStore && treeStore === sampleRunStore \? sampleRun\.liveSessions : sessionNodeIds\)/,
    'the view\'s owned sessions stopped being this run\'s session map')

  const contextFeed = viewFunction('treeContextFeed')
  assertContextUsesEndedSession(contextFeed, statusWord)
  /* Mutation control: the context call alone is not enough. If its callee ever
     drops ended-session liveness, this proof must still turn red. */
  assert.throws(
    () => assertContextUsesEndedSession(contextFeed, statusWord.replace('nodeSessionEnded(node)', 'false')),
    /shared status word stopped applying ended-session liveness/,
  )
  const resumeVerb = view.slice(view.indexOf("if (id === 'resume')"), view.indexOf("if (id === 'resume')") + 700)
  assert.match(resumeVerb, /if \(nodeBusy\(node\)\)/,
    'Resume refuses on the saved status again, which is the refusal that left no way out of a dead node')
})
