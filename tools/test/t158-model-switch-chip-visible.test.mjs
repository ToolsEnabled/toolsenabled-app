/* T158 (chat-lifecycle, Controller correction 2026-09-17) -- THE TRIGGER.
 *
 * Worker 82's on-screen walk: neither chat surface offers a way to change the
 * MODEL on a running agent -- the tree conversation exposes Effort only. Read
 * against src/components.js's chip markup, this is because the effort chip
 * button carries no `hidden` attribute and is never gated
 * (`typeof chips.onOpenEffort === 'function'` is the only condition), while
 * the model chip is markup-hidden and paintChips() only clears that
 * (`chipModel.hidden = !label`) when `chips.model()` in
 * src/views/computers.js's treeChatConfigFor already returns a label -- and
 * that function returned null until a same-provider mid-thread override
 * already existed. A chip that only appears after the switch it exists to
 * start is not a trigger a person can find.
 *
 * This file asserts the trigger is REACHABLE: pressed as a person presses a
 * chip, before any override exists, on the FIRST running session -- not
 * describing what the row list contains (session-model-switch.test.mjs
 * already does that) and not pressing the Actions overflow row directly
 * (t158-cross-provider-model-switch.test.mjs already does that). Between
 * them there was no case that ever asked "can a person find this at all",
 * which is exactly what Worker 82 measured missing on screen.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { payloadSkip, CROSS_ROW, FROM_TIER, runningCircle, waitFor } from './lib/t158-switch-model-harness.mjs'

test('the running circle offers a model chip before any override exists, and it opens the same switch',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })

  const chip = () => ctx.liveChat().querySelector('.chat-chip-model')
  await waitFor(() => chip() && chip().hidden === false, 'the model chip to be visible on a running agent with no override yet')
  assert.match(chip().textContent, /Sonnet/, `the chip names the model actually running (tier ${FROM_TIER}): ${chip().textContent}`)

  chip().dispatch('click')
  await waitFor(() => ctx.liveChat().querySelectorAll('.chat-actions-row').some(row => row.textContent.includes(CROSS_ROW)),
    'clicking the chip to open the same "Switch model" stage the Actions row opens')

  const target = ctx.liveChat().querySelectorAll('.chat-actions-row').find(row => row.textContent.includes(CROSS_ROW))
  assert.notEqual(target.getAttribute('aria-disabled'), 'true', 'the cross-provider row reached through the chip is pressable')
  target.dispatch('click')
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the switch started through the chip takes the circle over')
  assert.equal(ctx.readNode().tier, 'astra', 'the chip-triggered switch lands on the tier that was pressed')
})
