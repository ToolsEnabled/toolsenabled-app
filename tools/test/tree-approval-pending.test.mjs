/* AN APPROVAL REQUEST THAT ARRIVES WHILE YOU ARE NOT LOOKING MUST STILL BE
 * ANSWERABLE.
 *
 * MEASURED on the shipped 1.0.20 build, driving as a new user at the
 * `standard` level with autonomy "Act when I start it": a child agent called
 * agent_comms.send_local, the engine raised approval_request, and the child's
 * card read "The tool call was blocked pending your permission." The fleet page
 * was open, but the CHILD'S RAIL was not -- and the approval branch rendered
 * its card only inside
 *
 *     if (currentRailTreeNode && currentRailTreeNode.id === nodeId)
 *
 * so the one event that could ever paint the Approve button passed unrendered.
 * Clicking the node afterwards rebuilt the rail from scratch; nothing re-read
 * the request, no control existed anywhere on any screen, and the session sat
 * blocked until interrupted. The product promised "it stops and asks you
 * whenever it needs permission" -- it stopped, and asked nobody.
 *
 * The contract these tests pin, in order of the failure they prevent:
 *   1. the request is REMEMBERED per session, before any is-the-rail-open test;
 *   2. opening a node's rail RENDERS a remembered request;
 *   3. answering it FORGETS it (the card already removes itself);
 *   4. the turn ending forgets it too -- an interrupted turn's request must not
 *      resurface as an Approve button for work nothing is waiting to do.
 *
 * Source-contract tests, in the idiom of tree-chat-transcript.test.mjs: this
 * view is not importable into a unit test, so the shape of the wiring is
 * asserted where behaviour cannot be.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const view = readFileSync(path.resolve(HERE, '..', '..', 'src', 'views', 'computers.js'), 'utf8')

test('a pending approval is remembered before anyone asks whether its rail is open', () => {
  const branch = view.slice(view.indexOf("if (activity.kind === 'approval' && activity.approvalId)"))
  assert.ok(branch.length > 100, 'the approval activity branch is gone; these tests are about it')
  const body = branch.slice(0, 900)
  assert.match(branch.slice(0, 900), /sessionPendingApprovals\.set\(sessionId,/,
    'the approval request is not stored, so the only render is the one the event itself triggers -- look away once and the Approve button can never exist')
  assert.ok(
    body.indexOf('sessionPendingApprovals.set') < body.indexOf('currentRailTreeNode'),
    'the store happens inside the rail-is-open test, which is the exact defect: the memory must not depend on who was looking')
})

test('opening a node rail renders the approval that arrived while it was closed', () => {
  const open = view.slice(view.indexOf('function showTreeNodeControls(node)'))
  const body = open.slice(0, open.indexOf('\n  function ', 10))
  assert.match(body, /sessionPendingApprovals\.get\(node\.sessionId\)/,
    'showTreeNodeControls never asks whether an approval is waiting, so a person who arrives after the event finds no button')
  assert.match(body, /renderApprovalCard\(/,
    'the pending approval is read but never rendered on rail open')
})

test('answering the approval forgets it', () => {
  /* THE DELETE MOVED, 2026-08-28: B3's two-doors approval plumbing factored the
     cleanup shared by the rail card and buildChat's inline onApprovalDecision
     into finishApprovalSettle(sessionId, approvalId) -- one path, not two -- so
     this pin now watches both halves: the delete itself, wherever it truly
     lives, and that renderApprovalCard's own answer path actually reaches it. */
  const settle = view.slice(view.indexOf('function finishApprovalSettle'), view.indexOf('function finishApprovalSettle') + 500)
  assert.match(settle, /sessionPendingApprovals\.settle\(sessionId, approvalId\)/,
    'an answered approval stays remembered, so reopening the rail would offer an Approve button for a decision already made')
  const card = view.slice(view.indexOf('function renderApprovalCard(sessionId, approval)'))
  const body = card.slice(0, card.indexOf('\n  function ', 10))
  assert.match(body, /settleApproval\(sessionId, approval\.approvalId, decision\)/,
    'renderApprovalCard no longer routes its answer through the shared cleanup — the rail card could remove itself without ever forgetting the question, or without telling a registered chat panel')
})

test('answering one session does not tear a different, still-pending session\'s card off the rail', () => {
  /* MEASURED 2026-09-03, reading finishApprovalSettle against controlsPage.
   *
   * [data-tree-approval] is a SINGLETON: `controlsPage.querySelector(...)`
   * finds whichever one node's rail happens to be open right now, never "the
   * node this settle call is actually for". finishApprovalSettle is the
   * cleanup shared by both doors (b3-approval-two-doors.test.mjs) — a compact
   * card answering session A's question, or the rail-card door itself once
   * the person switches the rail to a different, also-pending node B while
   * `await bridge.answerApproval(...)` is still in flight for A's press
   * (settleApproval / renderApprovalCard's own click handler both await
   * answerWithinBound before calling this).
   *
   * Unguarded, finishApprovalSettle(sessionIdA, ...) called
   * controlsPage.querySelector('[data-tree-approval]')?.remove() with no
   * check that the card on screen was ever A's: B's still-live, unanswered
   * Approve/Refuse card vanished from the rail with no sentence and no click,
   * while B's own request sat blocked exactly as before -- recoverable only
   * by leaving node B and reopening it, since sessionPendingApprovals keeps
   * B's entry regardless of what happened to A's DOM.
   *
   * The other two places this same function/selector pair is used already
   * carry the fix (session-end cleanup, turn-completion cleanup, both below
   * in this file's source) -- this pins finishApprovalSettle to the same
   * pattern rather than being the one caller that forgot it. */
  const start = view.indexOf('function finishApprovalSettle')
  const body = view.slice(start, view.indexOf('async function settleApproval', start))
  assert.match(body, /if \(currentRailTreeNode && currentRailTreeNode\.id === sessionNodeIds\.get\(sessionId\)\)/,
    'finishApprovalSettle removes [data-tree-approval] with no session check at all -- answering session A tears session B\'s still-pending card off the rail whenever the rail happens to be showing B at that moment')
  const guardIndex = body.indexOf('if (currentRailTreeNode')
  const removeIndex = body.indexOf("controlsPage.querySelector('[data-tree-approval]')?.remove()")
  assert.ok(guardIndex !== -1 && removeIndex !== -1 && guardIndex < removeIndex,
    'the session guard exists somewhere in this function but does not wrap the rail-card removal, so the removal still runs unconditionally')
})

test('the turn ending forgets it too', () => {
  /* The completion branch is the one that files the answer; an approval whose
     turn is over (completed OR interrupted) is not a pending question. */
  const completion = view.slice(view.indexOf('if (!completionSettlesOpenTurn(packet, sessionId'))
  const body = completion.slice(0, completion.indexOf('scheduleChipRefresh'))
  assert.match(body, /clearSessionApprovals\(sessionId\)/,
    'a dead turn leaves its approval remembered; interrupt a blocked agent and the ghost Approve button would return on the next rail open')
})

/* ---------- the rewind refusal, made truthful ---------- */

test('a rewind the engine can never do says so instead of asking for a retry', async () => {
  const { REWIND_PANEL } = await import('../../src/fleet-tree-copy.js')
  assert.ok(typeof REWIND_PANEL.cannotFork === 'string' && REWIND_PANEL.cannotFork.length > 0,
    'the permanent-refusal sentence is gone; a Claude rewind failure falls back to "Try once more", which is false forever')
  assert.match(REWIND_PANEL.cannotFork, /Resume with a fresh agent/,
    'the sentence stopped naming the door that actually works')
  const rewind = view.slice(view.indexOf('async function performRewind'))
  const body = rewind.slice(0, rewind.indexOf('/* The agent'))
  assert.match(body, /CLAUDE_CLI_FORK_UNSUPPORTED/,
    'performRewind no longer tells the fork-unsupported refusal apart, so it retries a permanent refusal')
})
