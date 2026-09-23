/* T158 (re-scoped 2026-09-17, chat-lifecycle cluster) -- THE CARRIED
 * CONVERSATION ITSELF, NOT JUST THE HANDOFF LINE.
 *
 * tools/test/t158-cross-provider-model-switch.test.mjs (landed 21fa83ad)
 * presses the real "Continue on <model>" row and asserts the seat, the start
 * ordering and the ONE line the recovery handoff sends. None of its five
 * cases reads back the node's SAVED CONVERSATION after the switch, so a
 * change that carried the handoff sentence but dropped the turns that came
 * before it would still pass all five.
 *
 * RESUME-DURABILITY-FINDING-20260917.md (Worker 85): "SWITCH-MODEL must carry
 * the transcript from the bridge read, not the node record" -- the node
 * record (mc.fleet.trees.v1) holds only the first ask and the last reply, so
 * reading the conversation from THERE after a switch would silently drop
 * every middle turn. This file reads the node's saved conversation back the
 * way a reopened chat does: mc.fleet.transcripts.v1's own per-node record
 * (src/session-transcript-store.js), the same seam account-recovery-
 * coordinator.js's `transcriptStore.get/readLatest` reads and writes through.
 *
 * THE MUTATION THIS GATES: account-recovery-coordinator.js's recover()
 * builds the replacement's opening line list as
 * `[...(saved?.lines || []), handoffLine]` before it ever closes the old
 * session. Drop the `saved?.lines` half -- start the replacement's record
 * from `[handoffLine]` alone -- and every turn spoken before the switch is
 * gone from the saved conversation even though the handoff sentence still
 * arrives. That is the regression this file exists to catch; see
 * REPORT-T158-WORKER93-20260917.md for the RED/GREEN proof of this exact
 * mutation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { transcriptStorageKey } from '../../src/session-transcript-store.js'
import { payloadSkip, CROSS_ROW, runningCircle, waitFor, pressContinueRow } from './lib/t158-switch-model-harness.mjs'

const savedLines = ctx => {
  const raw = ctx.world.storage.getItem(transcriptStorageKey(ctx.COMPUTER_ID))
  const record = raw ? JSON.parse(raw)?.nodes?.[ctx.NODE_ID] : null
  return record?.lines || []
}

/* A second real turn, sent and completed through the product's own send path,
   so the saved conversation has more than the seeded opening message before
   the switch is pressed -- a carry that only kept "line zero" must fail this
   exactly as hard as a carry that kept nothing. */
async function sendAndCompleteTurn(ctx, text) {
  const chat = ctx.liveChat()
  const input = chat.querySelector('.chat-input input')
  assert.ok(input, 'the running circle has a composer to send a second turn through')
  input.value = text
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.calls.some(entry => entry.call === 'send' && entry.sessionId === ctx.OLD_SESSION),
    'the second turn to reach the bridge')
  const turnId = `turn-second-${ctx.calls.length}`
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId } })
  await waitFor(() => ctx.readNode().status === 'finished', 'the second turn to settle before the switch')
}

test('a cross-provider switch carries every prior turn into the replacement, not only the handoff sentence',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })

  const beforeSwitch = savedLines(ctx)
  assert.ok(beforeSwitch.some(line => line.who === 'you' && line.text === 'Answer my questions.'),
    'the opening turn is on the saved conversation before any switch is pressed')

  await sendAndCompleteTurn(ctx, 'A second question before switching models.')
  const beforeSwitchWithSecondTurn = savedLines(ctx)
  assert.ok(beforeSwitchWithSecondTurn.some(line => line.who === 'you' && line.text === 'A second question before switching models.'),
    'the second turn is on the saved conversation before any switch is pressed')

  await pressContinueRow(ctx, CROSS_ROW)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the circle to take over the replacement session')
  await waitFor(() => ctx.calls.some(entry => entry.call === 'send' && entry.sessionId === ctx.NEW_SESSION),
    'the handoff to be sent to the replacement')

  const afterSwitch = savedLines(ctx)
  assert.ok(afterSwitch.some(line => line.who === 'you' && line.text === 'Answer my questions.'),
    'THE CARRY: the FIRST turn is still on the saved conversation after the switch')
  assert.ok(afterSwitch.some(line => line.who === 'you' && line.text === 'A second question before switching models.'),
    'THE CARRY: the SECOND turn -- not just the first -- is still on the saved conversation after the switch')
  assert.ok(afterSwitch.some(line => line.who === 'action' && line.tool === 'Recovery handoff'),
    'the recovery handoff itself is also on the saved conversation, appended after what came before it')

  const order = afterSwitch.map(line => line.text)
  const firstAt = order.indexOf('Answer my questions.')
  const secondAt = order.indexOf('A second question before switching models.')
  const handoffAt = afterSwitch.findIndex(line => line.tool === 'Recovery handoff')
  assert.ok(firstAt < secondAt && secondAt < handoffAt,
    `the conversation keeps its own order across the switch: ${JSON.stringify(order)}`)
})
