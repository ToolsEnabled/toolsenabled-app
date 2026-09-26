/* A TURN THE PERSON STOPPED IS NOT A TURN THAT FAILED.
 *
 * Measured on the fresh-install walkthrough, 2026-08-19: press the Send
 * button's Stop face (or the palette's Interrupt) mid-stream, and after the
 * stream halts the node's chip reads "the last turn failed". Nothing failed —
 * the person asked for exactly this, the transcript honestly keeps the partial
 * words and "Interrupted.", and then the status contradicts both. The chip
 * word calling a deliberate act a failure is the same class of lie as the
 * "did not start" defect this vocabulary was built to fix, one notch softer.
 *
 * The truthful anchor is NOT the engine's status word (unmeasured for an
 * interrupt, and an allowlist that fails closed would read it as failure
 * anyway). It is that THIS WINDOW initiated the interrupt: both interrupt
 * doors — the palette row and the composer's Stop face — funnel through one
 * handler, so one recorded fact ("you pressed stop on this session") decides
 * the word when the not-successful completion lands.
 *
 * Suite shape: table membership is asserted by import (the tables are the
 * product), the wiring by source pin (the same style palette-rows uses for
 * rows the DOM cannot show without a live session).
 *
 * Run: node --test tools/test/interrupted-status.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { NODE_STATUSES } from '../../src/fleet-trees.js'
import { NODE_STATUS_WORDS } from '../../src/fleet-tree-copy.js'
import { treeNodeClock } from '../../src/tree-session-liveness.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const computers = readFileSync(path.join(REPO, 'src', 'views', 'computers.js'), 'utf8')

test('the store accepts an interrupted status and every status has its own word', () => {
  assert.ok(NODE_STATUSES.includes('interrupted'),
    'the store cannot record that a person stopped a turn')
  for (const status of NODE_STATUSES) {
    assert.equal(typeof NODE_STATUS_WORDS[status], 'string',
      `status "${status}" has no chip word — a surface would invent one`)
  }
})

test('the word for a stopped turn names the person, not a failure', () => {
  assert.equal(NODE_STATUS_WORDS.interrupted, 'stopped by you')
  assert.notEqual(NODE_STATUS_WORDS.interrupted, NODE_STATUS_WORDS['turn-failed'])
})

test('an interrupted session is terminal — the clock must stop', () => {
  const clock = treeNodeClock({
    status: 'interrupted',
    sessionId: 'stopped-session',
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:03.000Z',
  }, new Set(['stopped-session']))

  assert.equal(clock.terminal, true,
    'an interrupted session is not terminal')
  assert.equal(clock.stoppedAt, Date.parse('2026-08-25T10:00:03.000Z'),
    'liveness would keep ticking over a turn the person already stopped')
})

test('the interrupt handler and completion use the same turn-bound acknowledgement gate', () => {
  // Acceptance can cross IPC after its completion event. The behavioral races
  // are exercised in turn-interrupts and tree-start-persistence; pin both doors.
  const handler = computers.slice(computers.indexOf("if (id === 'interrupt')"))
  const tryBlock = handler.slice(0, handler.indexOf('catch'))
  assert.match(tryBlock, /await turnInterrupts\.request\(node\.sessionId, sessionOpenTurns\.get\(node\.sessionId\),\s*\(\) => bridge\.interrupt\(\{ sessionId: node\.sessionId \}\)\)/)

  /* The completion branch asks "did you stop this?" BEFORE it reaches for
     turn-failed, and consumes the record so the next turn answers for itself. */
  assert.match(computers, /const interruptPending = turnInterrupts\.pending\(sessionId, sessionEventTurnId\(packet, sessionId\)\)/)
  assert.match(computers, /await interruptPending/)
  assert.match(computers, /turnInterrupts\.consume\(sessionId, completingTurnIdEarly/)
  assert.match(computers, /nodeStatusForTurn\(status, \{ userStopped \}\)/,
    'the outcome choice does not place interrupted between success and failure')
})

test('the graph paints a stopped turn as settled, never as failed', () => {
  assert.match(computers, /'interrupted'[\s\S]{0,40}?'finished'/,
    "the canvas translate does not map interrupted to the settled colour — a deliberate stop would paint red")
})

test('the reports-to picker never offers two identical rows', () => {
  /* T1467 supersedes the old collision-only caption: generated name suffixes
     made that condition miss two parents with the same role. Every choice
     now names its tree, including an explicit "this tree" for the local one.
     Execute that actual builder against colliding and unique parent names. */
  const start = computers.indexOf('refreshRailMoveChoices = () => {')
  const end = computers.indexOf('const signature = JSON.stringify(choices)', start)
  assert.ok(start >= 0 && end > start, 'the actual Reports-to choice builder must be available')
  const body = computers.slice(start + 'refreshRailMoveChoices = () => {'.length, end)
  const parents = [{ id: 'a', treeId: 'first', name: 'Manager' },
    { id: 'b', treeId: 'second', name: 'Manager' }, { id: 'c', treeId: 'own', name: 'Worker' }]
  const store = { movePoints: () => parents.map(parent => ({ parentId: parent.id })),
    getNode: id => id === 'moving' ? { treeId: 'own' } : parents.find(parent => parent.id === id),
    treeLabel: id => ({ first: 'First tree', second: 'Second tree' })[id] }
  const choices = new Function('treeStore', 'node', 'treeNodeName', `${body}\nreturn choices`)(store, { id: 'moving' }, parent => parent.name)
  assert.deepEqual(choices, [{ id: 'a', label: 'Manager — First tree' },
    { id: 'b', label: 'Manager — Second tree' }, { id: 'c', label: 'Worker — this tree' }])
  assert.equal(new Set(choices.map(choice => choice.label)).size, choices.length,
    'parents with the same name must remain distinguishable')
})
