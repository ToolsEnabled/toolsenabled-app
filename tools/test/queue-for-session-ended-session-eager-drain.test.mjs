/* QUEUEFORSESSION HAS THE SAME "false MEANS THREE THINGS" DEFECT
 * recoverDeadSessionSend HAD, IN A SIBLING CALL SITE THIS LANE NEVER TOUCHED.
 *
 * Verifying R6b-comms-app (attempt 2 verification round). This lane's own
 * fixes (293ef76, 29c92e7, aeaad75) all landed inside recoverDeadSessionSend,
 * gating each of that function's two `!ok`/in-flight branches on the same
 * question: is the session this node names actually reachable, or did the
 * app already decide it is over. aeaad75 in particular added a
 * nodeSessionEnded() guard specifically because `freshAfterFailure.sessionId`
 * reads truthy for BOTH a live in-flight replacement and a resume the engine
 * already said had ENDED (resumeNodeSessionUnguarded's own ended branch
 * attaches the dead session id and deliberately preserves a
 * 'starting'/'running' status rather than clearing it).
 *
 * queueForSession -- the ONE enqueue door this same file's own comment names
 * (line ~9628: "THE ONE ENQUEUE DOOR (queueForSession, above
 * drainOutboxMessage)") -- asks the sibling predicate, nodeBusy, to decide
 * whether it is safe to attempt an immediate drain:
 *
 *   function queueForSession(node, text) {
 *     const live = treeStore ? treeStore.getNode(node.id) || node : node
 *     const queued = outboxEnqueue(live.sessionId, text)
 *     if (!queued.ok) return queued
 *     if (nodeBusy(live)) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
 *     const entry = outboxTakeNext(live.sessionId)
 *     if (!entry) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
 *     void drainOutboxMessage(live.sessionId, live.id, entry)
 *     return { ok: true, entry: queued.entry, sentence: ... }
 *   }
 *
 * nodeBusy(live) = nodeIsBusy(live, sessionNodeIds) = BUSY_STATUSES.has(status)
 * && sessionIsLive(live, sessionNodeIds) (src/tree-session-liveness.js).
 * `!nodeBusy(live)` is therefore true for TWO different facts, exactly the
 * shape aeaad75's own commit message already named for the sibling function:
 * a genuinely idle node (never busy, or a turn that finished cleanly) --
 * where an immediate drain is correct -- and a node whose status STILL READS
 * 'starting'/'running' while sessionIsLive is false, i.e. nodeSessionEnded(live)
 * is true -- the app already decided this session is over. queueForSession
 * does not ask nodeSessionEnded (or sessionEndedWithApp) at all, so it cannot
 * tell these apart: it takes the ended node's branch as "idle, drain now",
 * calls drainOutboxMessage, which fires bridge.send() at a session id nothing
 * on the other end answers to, replies an OPTIMISTIC "Queued" / "Queued --
 * sends now" (QUEUE_PANEL.cardQueued / cardQueuedIdle) synchronously and
 * BEFORE that send has even been attempted, and only corrects itself a round
 * trip later with a sticky "did not reach the agent" refusal
 * (drainOutboxMessage's catch branch, setOrgStatus(QUEUE_PANEL.notSent,
 * 'refuse', { sticky: true, ... })) once bridge.send() rejects.
 *
 * THIS IS DIRECTLY REACHABLE, NO RACE REQUIRED: the explicit `/queue <text>`
 * slash command calls queueForSession(node, slash.rest) with no
 * nodeSessionEnded pre-check at either of its two call sites --
 * treeCardSend's slash.action === 'queue' branch (~line 9626-9639) and the
 * busy-composer's send handler (~line 3503-3505) -- so typing "/queue hi" at
 * any node whose session has already silently ended (the exact
 * resumeNodeSessionUnguarded ended-branch shape aeaad75 just fixed one call
 * site for) reaches this gap today.
 *
 * queueForSession is closure-private inside computersView and cannot be
 * exercised directly under Node (same wall as recoverDeadSessionSend; see
 * tools/test/dead-session-recovery-second-send.test.mjs) -- pinned the same
 * way, by reading the source and asserting the structural invariant a fix
 * needs.
 *
 *   node tools/test/queue-for-session-ended-session-eager-drain.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
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

test('queueForSession only takes the two call sites that name it (the explicit /queue command)', () => {
  /* Pins reachability: no guard anywhere upstream of either call site checks
     nodeSessionEnded before reaching queueForSession, so a fix belongs inside
     queueForSession itself, not in a caller. */
  const occurrences = [...body.matchAll(/queueForSession\(/g)].length
  assert.ok(occurrences >= 3,
    'expected queueForSession to have its one definition plus at least two call sites (treeCardSend\'s /queue branch ' +
    'and the busy composer\'s send handler) -- if a call site was removed, re-check which paths can still reach it')
})

test('queueForSession does not eagerly drain behind a session this app already decided has ended', () => {
  const fn = slice('function queueForSession(node, text) {', 'async function drainOutboxMessage(sessionId, nodeId, entry)')
  /* The short-circuit's CONDITION is allowed to widen -- b6b3102b3 added
     `|| pendingModelChoice(live)` -- so pin the gate, not the exact line. */
  const busyAt = fn.search(/if \(nodeBusy\(live\)/)
  assert.notEqual(busyAt, -1, 'the nodeBusy short-circuit moved, was renamed, or was removed -- re-check this function\'s premise')
  const drainAt = fn.indexOf('drainOutboxMessage(live.sessionId, live.id, entry)')
  assert.notEqual(drainAt, -1, 'the eager-drain call moved, was renamed, or was removed -- re-check this function\'s premise')
  /* THE MISSING GUARD -- same predicate, same shape of defect, as
     recoverDeadSessionSend's !ok branch before aeaad75. nodeBusy(live) reads
     false both for a genuinely idle node and for one whose status still
     looks busy while sessionIsLive is false (nodeSessionEnded(live) true);
     queueForSession treats both as "safe to drain now". */
  const guardAt = fn.search(/nodeSessionEnded\(|sessionEndedWithApp\(/)
  assert.notEqual(guardAt, -1,
    'queueForSession never calls nodeSessionEnded (or sessionEndedWithApp) before treating `!nodeBusy(live)` as "safe ' +
    'to drain immediately" -- but nodeBusy is false both for a genuinely idle node AND for one whose status still ' +
    'reads \'starting\'/\'running\' while the session behind it already ended (the exact resumeNodeSessionUnguarded ' +
    'ended-branch shape commit aeaad75 fixed for recoverDeadSessionSend\'s !ok branch, on the OTHER call site sharing ' +
    'this same sessionNodeIds/nodeBusy machinery). Reachable today with no race via the explicit "/queue <text>" ' +
    'command at any node (treeCardSend\'s slash.action === \'queue\' branch, and the busy composer\'s send handler) -- ' +
    'it calls drainOutboxMessage on a dead session id, replies an optimistic "Queued" sentence before bridge.send() has ' +
    'even been attempted, and only a round trip later corrects itself with drainOutboxMessage\'s sticky "did not reach ' +
    'the agent" refusal. See tools/test/dead-session-recovery-ended-session-false-queue.test.mjs for the sibling fix ' +
    'this same guard needs to mirror here.')
  assert.ok(guardAt > busyAt && guardAt < drainAt,
    'nodeSessionEnded/sessionEndedWithApp must gate the eager-drain branch -- checked after the nodeBusy short-circuit ' +
    'and before calling drainOutboxMessage -- not merely referenced elsewhere in this function')
})
