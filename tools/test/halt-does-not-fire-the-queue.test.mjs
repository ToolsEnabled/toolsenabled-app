/* A HALT THE PERSON ASKED FOR IS NOT A STARTING GUN FOR THE NEXT MESSAGE.
 *
 * THE DEFECT. The fleet view drains the outbox from one place, the engine's
 * turn-completed branch, on the stated reason that a completion is "the
 * engine's only 'I am free' signal". It drained on EVERY completion -- and a
 * turn the person halted completes like any other. So: queue two messages
 * behind a long turn, press Halt, watch the turn stop, and watch the agent
 * start talking again inside the same tick, because the completion the halt
 * produced took the next queued message straight back out and sent it. The
 * person pressed the one control whose whole meaning is "stop", and the
 * product answered by starting the next turn. That reads as Halt not working,
 * and it is also the queue firing a message its owner had not released.
 *
 * The branch already knows. Two lines above the drain it reads
 * `sessionsInterrupted`, the set that records an interrupt the ENGINE
 * accepted, into `userStopped`, and uses it to write the honest status
 * ('interrupted', "Stopped by you.") rather than 'turn-failed'. The same fact
 * gates the drain here.
 *
 * NOTHING IS LOST, WHICH IS WHY THIS IS A GATE AND NOT A DROP. The queued
 * words stay in the store and stay drawn in the strip: the person can press
 * Send now on a row (idle, that row really sends), type into the box, or let
 * the next completion drain one, exactly as before. Only the automatic send
 * that rode the halt is gone. Dropping the queue is a different act with a
 * different door -- the Stop row's close, which calls outboxClearSession and
 * says how many it dropped -- and this branch must not quietly become a
 * second one of those.
 *
 * The completion drain runs from its actual AST block against the full real
 * outbox. Separate wiring pins retain the event's interrupt read and single
 * drain count, so changing the branch cannot make a copied predicate pass.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { realOutbox } from './fixtures/recovery-outbox.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const stripped = source => source
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

const code = stripped(view)

const STOPPED = 'const userStopped = turnInterrupts.consume('
const stoppedAt = code.indexOf(STOPPED)

/* Everything the completion branch does after it has the fact in hand. */
const tail = () => {
  assert.notEqual(stoppedAt, -1, 'the completion branch no longer reads the interrupt the person asked for')
  return code.slice(stoppedAt)
}

test('the completion branch still captures the halt the person asked for', () => {
  const at = code.indexOf(STOPPED)
  assert.notEqual(at, -1,
    'the completion branch no longer consumes sessionsInterrupted, so it cannot tell a halt from a turn that ended on its own')
  assert.match(code.slice(at, at + 2000), /outcome = nodeStatusForTurn\(status, \{ userStopped \}\)/,
    'the captured fact no longer decides the status word, so this pin is watching something the branch has stopped using')
})

test('there is exactly one place a completion drains the queue', () => {
  const drains = code.split('outboxTakeNext(sessionId)').length - 1
  assert.equal(drains, 1,
    'a second completion drain appeared -- a guard on one of them is not a guard, and the halt can be walked around through the other')
})

for (const userStopped of [false, true]) for (const replacing of [false, true]) for (const isHistoricalReplay of [false, true]) {
  test(`the actual completion drain preserves Halt=${userStopped} and pending replacement=${replacing} and replay=${isHistoricalReplay}`, () => {
    const drains = []
    function collect(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === 'IfStatement' && view.slice(node.test.start, node.test.end).includes('userStopped') &&
          view.slice(node.consequent.start, node.consequent.end).includes('outboxTakeNext(sessionId)')) drains.push(view.slice(node.start, node.end))
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === 'object') collect(value)
      }
    }
    collect(parseAst(view))
    assert.equal(drains.length, 1)
    const outbox = realOutbox(), sent = []
    outbox.enqueue('session', 'FIRST'); outbox.enqueue('session', 'SECOND')
    const complete = vm.runInNewContext(`(function () { ${drains[0]} })`, {
      userStopped, isHistoricalReplay, nativeReplayIdle: false, sessionId: 'session', nodeId: 'node', nodeReplacementFlight: { busy: () => replacing },
      outboxTakeNext: outbox.takeNext,
      drainOutboxMessage(sessionId, nodeId, entry) { sent.push(entry.text); outbox.confirmDelivered(sessionId, entry) },
    })
    complete()
    const held = userStopped || replacing || isHistoricalReplay
    assert.deepEqual(sent, held ? [] : ['FIRST'])
    assert.deepEqual(Array.from(outbox.list('session'), row => row.text), held ? ['FIRST', 'SECOND'] : ['SECOND'])
  })
}

test('the halt leaves the waiting words waiting -- it is a gate, not a drop', () => {
  const after = tail()
  const drainAt = after.indexOf('outboxTakeNext(sessionId)')
  assert.notEqual(drainAt, -1, 'the completion branch no longer drains at all')
  assert.ok(!after.slice(0, drainAt).includes('outboxClearSession('),
    'the halted completion now throws the queue away; dropping queued words is the Stop row\'s act, and it says how many it dropped')
})
