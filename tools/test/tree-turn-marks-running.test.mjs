/* A CIRCLE THAT IS WORKING MUST NOT READ AS FINISHED.
 *
 * THE DEFECT, measured 2026-09-04 on the owner's Live tier (fifth tree): the
 * tree courier hands a message from one circle to another inside
 * shell/agent-host.cjs (pumpTreeSessionOnce -> sendTurn, origin 'agent').
 * The renderer marks a node `running` only for turns IT sends -- the composer
 * and drainOutboxMessage both call treeStore.setNodeStatus(nodeId, 'running')
 * before their send -- so a turn the shell started on the courier's behalf
 * never touched the node's status. Manager and Manager 2 each ran judge
 * builds, merges and spawns for ten minutes while their circles showed
 * "finished" with a reply from the previous turn; the owner read the whole
 * tree as idle. The run clock and the supervisor's quiet check read the same
 * status, so both were wrong for the same reason.
 *
 * THE FIX IS AT THE ONE SEAM EVERY TURN CROSSES. The engine names each turn
 * on the first event it emits (sessionEventTurnId); the view already installs
 * that id in settleTurnBoundary from both the words branch and the tool
 * branch of its session listener. A turn id the view has not seen before is
 * a turn beginning, whoever started it, so that is where the node is marked
 * running -- once, and only when it is not already busy.
 *
 * WHY SOURCE SLICES: the view is a 5,000-line closure over a live DOM
 * (tools/test/rail-status-repaint.test.mjs gives the same reason). What is
 * pinned here is the wiring: that the boundary marks, that the mark writes
 * `running` through the store and repaints in place, and that both listener
 * branches still reach the boundary. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const stripped = source => source
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

const code = stripped(view)

function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

test('POSITIVE CONTROL: both listener branches hand the engine turn id to settleTurnBoundary', () => {
  /* If the words branch or the tool branch stopped naming the turn, the mark
     below would never fire for a courier turn and this suite would be
     guarding a seam that no longer exists. */
  const calls = code.match(/settleTurnBoundary\(sessionId, sessionEventTurnId\(packet, sessionId\)\)/g) || []
  assert.ok(calls.length >= 2, `expected the words branch and the tool branch to name the turn; found ${calls.length} call(s)`)
})

test('a turn id the view has not seen before marks the node running, before the boundary returns early', () => {
  const boundary = sliceBlock(code, 'function settleTurnBoundary(sessionId, turnId) {', 'settleTurnBoundary')
  const mark = boundary.indexOf('markTurnRunning(sessionId)')
  assert.ok(mark !== -1, 'settleTurnBoundary no longer marks the node running when a new turn id arrives, so a courier-started turn shows the previous status while it works')
  const earlyReturn = boundary.indexOf('if (!open || open === turnId) return')
  assert.ok(earlyReturn !== -1, 'the early return for an unchanged turn id is gone; the slice marker is stale')
  assert.ok(mark < earlyReturn, 'the mark sits after the early return, so the FIRST turn of a session (open is null) is never marked')
  assert.match(boundary, /if \(open !== turnId\) markTurnRunning\(sessionId\)/, 'the mark fires only when the turn id actually changed')
})

test('markTurnRunning writes running through the store, only when the node is not already busy, and repaints in place', () => {
  const mark = sliceBlock(code, 'function markTurnRunning(sessionId) {', 'markTurnRunning')
  assert.match(mark, /treeStore\.setNodeStatus\(nodeId, 'running', \{ note: '' \}\)/, 'the mark does not write running through the store')
  assert.match(mark, /node\.status === 'starting' \|\| node\.status === 'running'/, 'the mark does not leave an already-busy node alone, so a person-sent turn would be re-marked and its note lost')
  assert.match(mark, /refreshTree\(\)/, 'the canvas is not refreshed, so the ring and clock stay on the old status')
  assert.match(mark, /repaintRailStatus\(\{ \.\.\.currentRailTreeNode, status: 'running' \}\)/, 'the open rail is not repainted in place (rail-status-repaint.test.mjs: never a rebuild)')
  assert.doesNotMatch(mark, /showTreeNodeControls\(/, 'the mark rebuilds the rail, which closes an open actions popup under the person')
})
