/* Owner-reported top priority (Controller, 2026-09-17): pressing Halt/Stop
 * does nothing on the live build -- a running turn cannot be stopped.
 *
 * WHY THE EXISTING GREEN DID NOT ANSWER THIS. Every existing Halt/Stop test
 * found by search (chat-composer-chips.test.mjs, chat-surface-behaviors.test.mjs)
 * presses the real HALT chip or working-step button against a STUBBED
 * `onStop: () => { stopped += 1 }` -- proving the component calls whatever
 * onStop it is given, never that the tree conversation's REAL onStop
 * (src/views/computers.js's `runPaletteAction('interrupt', ...)`) reaches
 * `window.mcAgent.interrupt`. Symmetrically, tools/test/agent-host-interrupt-
 * cleanup.test.mjs and the Claude CLI adapter's own tests prove the HOST and
 * the ADAPTER interrupt correctly once asked -- never that a real button
 * press in the tree conversation asks them. No case connects a real press to
 * a real bridge call for a tree circle. That is the exact shape of the T158
 * gap this file's neighbours (t158-model-switch-chip-visible.test.mjs,
 * t158-model-switch-transcript-carry.test.mjs) already closed for the model
 * switch; this closes it for Halt.
 *
 * Comparing the owner's actually-running generation (git commit ecee7986,
 * live-control/runtime-generations/gen-b05b415a...) against this worktree
 * (328b9dac and later) found the interrupt() body itself unchanged past a
 * T61 goal-pause addition that does not apply to an ordinary turn -- so a
 * stale build does not explain an ordinary Halt press doing nothing. This
 * file presses the real UI to find out whether the WIRING, not the mechanism,
 * is where it breaks.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { payloadSkip, runningCircle, waitFor } from './lib/t158-switch-model-harness.mjs'

/* Send a real turn through the composer and leave it BUSY -- no
 * turn_completed emitted -- which is the state a person presses Halt from. */
async function sendWithoutCompleting(ctx, text) {
  const chat = ctx.liveChat()
  const input = chat.querySelector('.chat-input input')
  assert.ok(input, 'the running circle has a composer to send a turn through')
  input.value = text
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.calls.some(entry => entry.call === 'send' && entry.sessionId === ctx.OLD_SESSION),
    'the turn to reach the bridge')
}

const interruptCalls = ctx => ctx.calls.filter(entry => entry.call === 'interrupt')

test('the tree conversation\'s HALT chip reaches the real bridge interrupt on a busy circle',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async () => { throw new Error('not used by this case') } })
  await sendWithoutCompleting(ctx, 'A long-running turn.')
  await waitFor(() => ctx.readNode().status === 'running' || ctx.readNode().status === 'starting',
    'the circle to be busy after a turn is sent, not still finished')

  const chat = ctx.liveChat()
  const halt = chat.querySelector('.chat-chip-halt')
  assert.ok(halt, 'a HALT chip exists on a busy circle\'s composer')
  await waitFor(() => halt.hidden === false, 'the HALT chip to become visible while the circle is busy')
  assert.equal(halt.disabled, false, 'the HALT chip is pressable, not disabled, while busy')

  halt.dispatch('click')
  await waitFor(() => interruptCalls(ctx).length === 1, 'pressing HALT to reach window.mcAgent.interrupt')
  assert.equal(interruptCalls(ctx)[0].sessionId, ctx.OLD_SESSION,
    'the interrupt names the session actually running, not a stale or wrong one')
})

test('the tree conversation\'s Actions → Interrupt row reaches the same real bridge interrupt',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async () => { throw new Error('not used by this case') } })
  await sendWithoutCompleting(ctx, 'Another long-running turn.')
  await waitFor(() => ctx.readNode().status === 'running' || ctx.readNode().status === 'starting',
    'the circle to be busy after a turn is sent')

  const chat = ctx.liveChat()
  chat.openActions()
  const rows = chat.querySelectorAll('.chat-actions-row')
  const interruptRow = rows.find(row => row.textContent.includes('Interrupt the running turn'))
  assert.ok(interruptRow, `Actions offers "Interrupt the running turn" among: ${rows.map(row => row.textContent).join(' | ')}`)
  assert.notEqual(interruptRow.getAttribute('aria-disabled'), 'true', 'the interrupt row is pressable while busy')
  interruptRow.dispatch('click')

  await waitFor(() => interruptCalls(ctx).length === 1, 'pressing the Actions interrupt row to reach window.mcAgent.interrupt')
  assert.equal(interruptCalls(ctx)[0].sessionId, ctx.OLD_SESSION, 'the interrupt names the session actually running')

  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'interrupted', turnId: 'turn-interrupted' } })
  await waitFor(() => ctx.readNode().status !== 'running' && ctx.readNode().status !== 'starting',
    'the turn to actually end after the host acknowledges the interrupt')
})
