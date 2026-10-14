/* THE ACKNOWLEDGEMENT MUST NOT RE-OPEN A TURN THAT ALREADY ENDED.
 *
 * THE DEFECT (owner, Local Observer node16-8a2ff6c3, session cedebfeb-0079,
 * 2026-09-12): treeCardSend's bridge.send(...).then(sent => ...) marks a node
 * 'running' unconditionally once the send's own IPC round trip settles. A
 * local turn whose first event is already its last -- LOCAL_NODE_RESPONSE_
 * INVALID, "the local model finished without returning an answer" -- can have
 * its turn_completed event processed by the OTHER IPC channel (the persistent
 * event stream) and paint 'turn-failed' BEFORE this .then() callback's own
 * round trip resolves (see tools/test/agent-host-local-turn-completion-
 * ordering.test.mjs CASE 1, which proves this ordering through the real host
 * with the real adapter's own event-then-resolve shape). The unconditional
 * write then overwrote the correct terminal status back to 'running', with
 * nothing left to clear it: the failure sentence was already on screen, Stop
 * was still enabled, and only pressing Stop -- which found no turn left to
 * interrupt -- cleared the busy state via a DIFFERENT, unrelated recovery
 * path (AGENT_TURN_NONE, see computers.js's own stopStillOwnsNode check).
 *
 * THE FIX. sessionCompletedTurnIds records, in the turn_completed handler,
 * the exact turn id a completion already settled -- before that handler
 * clears its own bookkeeping. treeCardSend's acknowledgement checks the SAME
 * map for the SAME turn id before writing 'running', and skips the write
 * when that exact turn is already known over. A newer turn on the same
 * session is unaffected: its own, different turn id was never recorded, so
 * the ordinary 'running' mark still fires precisely as before.
 *
 * WHY SOURCE SLICES: the view is a 5,000-line closure over a live DOM,
 * exactly as tools/test/tree-turn-marks-running.test.mjs's own header
 * explains for the sibling 'running' mark this suite sits beside. What is
 * pinned here is the wiring: that the map is declared once, is written by
 * the completion handler naming the SAME id used to mean "this turn is over"
 * elsewhere in that same handler, is read by treeCardSend's acknowledgement
 * to gate the write it must skip, and is forgotten wherever a session's
 * other per-turn bookkeeping (sessionOpenTurns) already is -- so it can never
 * outlive the session it was recorded for.
 *
 * WHAT THIS SUITE CAN AND CANNOT CATCH. This IS the regression guard for the
 * fix: confirmed by running it against a computers.js checked out from
 * before sessionCompletedTurnIds existed, where all five cases here fail.
 * agent-host-local-turn-completion-ordering.test.mjs, by contrast, never
 * touches this file and passes identically with or without the guard -- it
 * characterises the ordering the guard depends on, not the guard itself.
 * But a source slice pins TEXT, not runtime behaviour: a refactor of
 * treeCardSend or the completion handler that keeps these exact identifiers
 * and call shapes while changing what surrounds them could pass this suite
 * with the underlying bug back. Nothing here runs the view against a real or
 * simulated DOM, and nothing here proves the guard behaves correctly when
 * the view is actually exercised -- only that its wiring, as written, is the
 * wiring the fix requires. */

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

function sliceFrom(source, header, endMarker, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const end = source.indexOf(endMarker, at + header.length)
  assert.ok(end !== -1, `${what}'s end marker ${JSON.stringify(endMarker)} was not found after it`)
  return source.slice(at, end + endMarker.length)
}

test('sessionCompletedTurnIds is declared once, beside sessionOpenTurns', () => {
  const count = (code.match(/const sessionCompletedTurnIds = new Map\(\)/g) || []).length
  assert.equal(count, 1, `expected exactly one declaration, found ${count}`)
})

test('the turn_completed handler records the completing turn id before it clears its own open-turn bookkeeping', () => {
  const handler = sliceFrom(code,
    'const completingTurnId = sessionEventTurnId(packet, sessionId) || sessionOpenTurns.get(sessionId)',
    'sessionOpenTurns.delete(sessionId)',
    'the completion handler')
  assert.match(handler, /sessionCompletedTurnIds\.set\(sessionId, completingTurnId\)/,
    'completingTurnId is computed but never recorded, so a later acknowledgement cannot tell this turn already ended')
  const recordAt = handler.indexOf('sessionCompletedTurnIds.set(sessionId, completingTurnId)')
  const clearAt = handler.indexOf('sessionOpenTurns.delete(sessionId)')
  assert.ok(recordAt < clearAt, 'the id is recorded after the open-turn slot it was read from is already cleared')
})

test("treeCardSend's send acknowledgement skips the optimistic 'running' write for a turn sessionCompletedTurnIds already has", () => {
  const block = sliceFrom(code, '}).then(sent => {', "}, error => {", "treeCardSend's send().then()")
  assert.match(block, /sessionCompletedTurnIds\.get\(node\.sessionId\) === sent\.turnId/,
    'the acknowledgement no longer checks whether this exact turn already completed')
  assert.match(block, /if \(treeStore && !alreadySettled\) \{/,
    "the guard does not gate the store write, so it would still mark 'running' over an already-terminal status")
  const guardAt = block.indexOf('alreadySettled')
  const writeAt = block.indexOf("treeStore.setNodeStatus(node.id, 'running'")
  assert.ok(guardAt !== -1 && writeAt !== -1 && guardAt < writeAt, 'the guard is not evaluated before the write it must gate')
})

test('sessionCompletedTurnIds is forgotten everywhere sessionOpenTurns already is, so it cannot outlive its session', () => {
  const retire = sliceBlock(code, 'function retireTreeSessionRuntime(sessionId) {', 'retireTreeSessionRuntime')
  assert.match(retire, /sessionOpenTurns\.delete\(sessionId\)[\s\S]{0,80}sessionCompletedTurnIds\.delete\(sessionId\)/,
    'retireTreeSessionRuntime clears sessionOpenTurns but leaves sessionCompletedTurnIds behind')

  const reset = sliceBlock(code, 'function resetSessionMetrics(sessionId) {', 'resetSessionMetrics')
  assert.match(reset, /sessionOpenTurns\.delete\(sessionId\)[\s\S]{0,80}sessionCompletedTurnIds\.delete\(sessionId\)/,
    'resetSessionMetrics clears sessionOpenTurns but leaves sessionCompletedTurnIds behind')

  const teardownAt = code.indexOf('for (const buffer of sessionActions.values()) buffer.resetMetrics()')
  assert.ok(teardownAt !== -1, 'the view-teardown block that clears sessionOpenTurns is gone; the slice marker is stale')
  const teardown = code.slice(teardownAt, teardownAt + 200)
  assert.match(teardown, /sessionOpenTurns\.clear\(\)[\s\S]{0,40}sessionCompletedTurnIds\.clear\(\)/,
    'view teardown clears sessionOpenTurns but leaves sessionCompletedTurnIds behind')
})

test("a stale completion from an EARLIER turn cannot block a DIFFERENT, later turn's acknowledgement -- the guard names the exact id, not merely \"this session had some prior completion\"", () => {
  const block = sliceFrom(code, '}).then(sent => {', "}, error => {", "treeCardSend's send().then()")
  assert.match(block, /sessionCompletedTurnIds\.get\(node\.sessionId\) === sent\.turnId/,
    'the guard must compare against sent.turnId itself, not just check that this session has some entry')
  assert.doesNotMatch(block, /sessionCompletedTurnIds\.has\(node\.sessionId\)/,
    'a bare .has(sessionId) check would treat ANY earlier completed turn as blocking every later one, including a genuinely new, accepted turn')
})
