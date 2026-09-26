/* THE COMPOSER CHIPS (design/chat/picked-card.png, "Dense — light-mode
 * palette"): AGENT · EFFORT · model on the left, HALT · QUEUE · SEND on the
 * right. Every chip is driven by ONE new optional buildChat config field,
 * `chips`, spread into the same config object treeChatConfigFor already
 * builds once for the card and the rail -- no existing caller passes it, so
 * every existing call site renders exactly as before.
 *
 * THE RULE THIS FILE PINS MOST: a control a person can press either does
 * something or says why. The AGENT and model chips render as a plain,
 * non-interactive <span> rather than a <button> when there is no press
 * handler to back them -- this component does not draw a button that does
 * nothing. QUEUE and HALT need no new config at all: they read straight off
 * the `queue`/`onStop` configs buildChat already had, and their presses
 * reuse the composer's own internal stop/send paths rather than a second
 * implementation of either.
 *
 * MOST OF THIS FILE IS SOURCE PINS, deliberately: buildChat needs a DOM to
 * run, and node --test has none by default (see tools/test/chat-
 * composer.test.mjs's header for the same note). The one dispatched-click
 * test near the end is the exception, reusing the small DOM stand-in
 * tools/test/chat-message-identity.test.mjs established -- it closes the
 * gap a harness catalog named: a source pin proves the HALT chip's click
 * handler calls runStop(); it does not prove a real click on the real
 * chip element actually reaches the caller's onStop.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { CHIP_EFFORT_LABEL, QUEUE_SEND_NOW, QUEUE_SEND_NOW_LABEL, QUEUE_SEND_NOW_OFF_EMPTY, QUEUE_SEND_NOW_OFF_STOPPING, queueSendNowOffBlocked, NO_SENDER_WIRED } from '../../src/chat-copy.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))
const template = chat.slice(0, chat.indexOf('const log ='))

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { document, restore } = installDomStandIn(globalThis)
after(() => restore())
assert.equal(document, globalThis.document)

const { buildChat: buildChatLive } = await import('../../src/components.js')

test('chips is a new optional parameter; no existing caller is required to pass it', () => {
  const signature = chat.slice(0, chat.indexOf('{\n') + 1)
  assert.match(signature, /sampleConversation = false, chips = null, onApprovalDecision = null/,
    'chips (and onApprovalDecision) must default to null so every existing buildChat({...}) call compiles unchanged')
  /* The whole chips row is gated on the config being truthy -- omit it and
     nothing about the composer's markup changes at all. */
  assert.match(template, /\$\{chips \? `<div class="chat-chips">/,
    'the chips row is no longer conditional on the chips config; a caller that never asked for it would get one anyway')
})

test('the AGENT and model chips render as a button only when a press handler exists', () => {
  const left = template.slice(template.indexOf('chat-chips-left'), template.indexOf('chat-chips-right'))
  assert.match(left, /typeof chips\.onOpenTier === 'function'\s*\n\s*\? '<button type="button" class="chat-chip chat-chip-tier"/,
    'the tier chip no longer checks onOpenTier before deciding button vs span')
  assert.match(left, /: '<span class="chat-chip chat-chip-tier chat-chip-static"/,
    'the tier chip lost its non-interactive fallback -- it would render a dead button with no onOpenTier')
  assert.match(left, /typeof chips\.onOpenModel === 'function'\s*\n\s*\? '<button type="button" class="chat-chip chat-chip-model"/,
    'the model chip no longer checks onOpenModel before deciding button vs span')
  assert.match(left, /: '<span class="chat-chip chat-chip-model chat-chip-static"/,
    'the model chip lost its non-interactive fallback')
  /* Presence of the chip at all is gated on the ACCESSOR (chips.tier /
     chips.model being a function), independent of whether a press handler
     exists -- a caller can show a read-only tier/model chip. */
  assert.match(left, /typeof chips\.tier === 'function'/, 'the tier chip no longer checks for its accessor function')
  assert.match(left, /typeof chips\.model === 'function'/, 'the model chip no longer checks for its accessor function')
})

test('the EFFORT chip is gated on onOpenEffort alone, with a fixed label', () => {
  const left = template.slice(template.indexOf('chat-chips-left'), template.indexOf('chat-chips-right'))
  assert.match(left, /typeof chips\.onOpenEffort === 'function'/, 'the EFFORT chip no longer checks onOpenEffort before rendering')
  assert.match(left, /chat-chip-effort" data-chat-chip="effort">\$\{CHIP_EFFORT_LABEL\}/,
    'the EFFORT chip no longer uses the fixed CHIP_EFFORT_LABEL word')
})

test('one door under the arrow, and it is Send now -- no second Send and no Queue chip', () => {
   /* W18c: under the arrow there were a send and a queue button; the arrow
     sends, and the button below is for Send now. The old SEND chip
     called the same send() the arrow calls, and the old QUEUE chip called
     send() too, because send()'s busy branch IS the queue -- so both were the
     arrow, spelled twice. */
  const right = template.slice(template.indexOf('chat-chips-right'))
  assert.match(right, /\$\{onStop \? `<button type="button" class="chat-chip chat-chip-halt"/,
    'the HALT chip no longer gates on the existing onStop config')
  assert.match(right, /class="chat-chip chat-chip-sendnow" data-chat-chip="sendnow"/,
    'the one door under the arrow is no longer the Send now chip')
  assert.doesNotMatch(right, /data-chat-chip="send"/,
    'the duplicate SEND chip is back -- the arrow already sends, so this chip only ever spelled the arrow twice')
  assert.doesNotMatch(right, /data-chat-chip="queue"/,
    'the QUEUE chip is back -- queueing is what the arrow does when the agent is busy')
  assert.doesNotMatch(right, /chat-chip-sendnow" data-chat-chip="sendnow" hidden/,
    'the Send now chip has "hidden" baked in -- paintChips never unhides it, so it would never appear')
})

test('paintChips is reassigned once isBusy/runStop/send exist, not written where the refs are declared', () => {
  const chipsStart = chat.indexOf('const chipTier =')
  const placeholderEnd = chat.indexOf('\n', chat.indexOf('let paintChips =', chipsStart))
  const chipsBlock = chat.slice(chipsStart, placeholderEnd)
  assert.match(chipsBlock, /let paintChips = \(\) => \{\}/,
    'the forward-reference placeholder for paintChips is gone -- reassigning it later would throw instead of silently no-op-ing before isBusy exists')
  const realPaint = chat.slice(chat.indexOf('paintChips = () => {\n    if (!chips) return'))
  assert.match(realPaint, /const stoppable = isBusy\(\) && typeof onStop === 'function'/,
    'the HALT chip no longer reflects the same busy+onStop rule the send button\'s stop-face already uses')
  assert.match(realPaint, /chipHalt\.hidden = !stoppable/, 'the HALT chip no longer hides itself when nothing is running')
  /* W18c: the QUEUE and SEND chips are gone, so their rules are gone with
     them. What remains is the one chip, and the rule that matters for it is
     that a BUSY agent must NOT disable it -- interrupting is the whole act --
     while an empty box must, because send-with-an-empty-box is the stop
     action. That is asserted with real clicks below rather than only here. */
  /* The three conditions are unchanged; they are now NAMED, because the name
     is what the disabled chip announces (T1601, below). The pin follows the
     shape so a fourth silent condition cannot appear without this line. */
  assert.match(realPaint, /const off = cannotSend \? 'blocked'/,
    'the Send now chip stopped naming the composer-level refusal that switches it off')
  assert.match(realPaint, /: stopping \? 'stopping'/,
    'the Send now chip stopped naming the in-flight halt that switches it off')
  assert.match(realPaint, /: \(!input\.value\.trim\(\) && pendingAttachments\.length === 0\) \? 'empty'/,
    'the Send now chip can act with no words or images')
  assert.match(realPaint, /chipSendNow\.disabled = off !== null/,
    'the chip is switched off by something other than the three named reasons, so its name cannot state one')
  assert.doesNotMatch(realPaint, /isBusy\(\)[^\n]*chipSendNow|chipSendNow[^\n]*isBusy\(\)/,
    'the Send now chip is gated on isBusy() again -- a busy agent is exactly when this door exists')
})

test('chip presses reuse the composer\'s own internal paths -- no second stop/send implementation', () => {
  const wiring = chat.slice(chat.indexOf('chipTier?.addEventListener'), chat.indexOf('let chipsUnsub'))
  assert.match(wiring, /chipTier\?\.addEventListener\('click', \(\) => \{ if \(!disposed\) chips\?\.onOpenTier\?\.\(\) \}\)/,
    'the tier chip no longer calls chips.onOpenTier on press')
  assert.match(wiring, /chipEffort\?\.addEventListener\('click', \(\) => \{ if \(!disposed\) chips\?\.onOpenEffort\?\.\(root\) \}\)/,
    'the effort chip must identify the composer whose picker it opens')
  assert.match(wiring, /chipModel\?\.addEventListener\('click', \(\) => \{ if \(!disposed\) chips\?\.onOpenModel\?\.\(root\) \}\)/,
    'the model chip must identify the composer whose picker it opens')
  assert.match(wiring, /chipHalt\?\.addEventListener\('click', \(\) => \{ if \(!disposed && !chipHalt\.disabled\) void runStop\(\) \}\)/,
    'the HALT chip no longer calls the same runStop() the composer\'s stop-face uses -- a second stop path would be the defect')
  assert.match(wiring, /chipSendNow\?\.addEventListener\('click', \(\) => \{ if \(!disposed && !chipSendNow\.disabled\) void sendNowFromInput\(\) \}\)/,
    'the Send now chip no longer calls the same sendNowFromInput() the ⇧⏎ chord uses -- two implementations of one act is how the queue strip\'s own doors drifted apart before W18b')
})

test('chips.subscribe follows the exact status/queue.subscribe shape, and is torn down on dispose', () => {
  const subscribeWiring = chat.slice(chat.indexOf('let chipsUnsub = null'), chat.indexOf('let chipsUnsub = null') + 300)
  assert.match(subscribeWiring, /if \(chips && typeof chips\.subscribe === 'function'\)/,
    'chips.subscribe is no longer feature-detected the same way status.subscribe/queue.subscribe already are')
  assert.match(subscribeWiring, /chipsUnsub = chips\.subscribe\(\(\) => paintChips\(\)\)/,
    'a chips.subscribe firing no longer repaints the chips')
  /* The WHOLE dispose body, located by its own closing brace. A fixed character
     window silently stopped covering the later teardown lines as dispose grew:
     measured 2026-09-09 at an earlier app commit, statusUnsub sat at offset 1385 but
     queueUnsub at 1467 and chipsUnsub at 1519, so a 1400 window reported
     "dispose leaks the queue subscription" while dispose unsubscribes on the
     very next line. A pin that silently stops measuring is worse than no pin. */
  const disposeAt = chat.indexOf('const dispose = ()')
  const dispose = chat.slice(disposeAt, chat.indexOf('\n  }', disposeAt) + 4)
  assert.match(dispose, /chipsUnsub\?\.\(\)/, 'dispose leaks the chips subscription')
  /* The existing pins in chat-composer.test.mjs already require statusUnsub
     and queueUnsub inside this same 1400-character window; widened here to
     1600 to also reach chipsUnsub without those two existing pins needing
     to move themselves further from the start of dispose. */
  assert.match(dispose, /statusUnsub\?\.\(\)/, 'the existing status teardown moved out of reach -- re-check the window length against chat-composer.test.mjs')
  assert.match(dispose, /queueUnsub\?\.\(\)/, 'the existing queue teardown moved out of reach -- re-check the window length against chat-composer.test.mjs')
})

/* ---------------------------------------------------------------
   A REAL DISPATCHED CLICK ON THE HALT CHIP. Everything above proves the
   source wires HALT to runStop(); this proves a real click on the real
   .chat-chip-halt element reaches the CALLER's own onStop, unhidden and
   enabled exactly when status.busy() says a turn is running.
   --------------------------------------------------------------- */

test('a real click on the HALT chip reaches the caller\'s onStop, the same as the composer\'s own stop-face', async () => {
  let stopped = 0
  const root = buildChatLive({
    title: '·', seed: 0, composerReason: NO_SENDER_WIRED,
    status: { busy: () => true },
    onStop: () => { stopped += 1; return null },
    chips: {},
  })
  const halt = root.querySelector('.chat-chip-halt')
  assert.ok(halt, 'the HALT chip did not render for a busy session with onStop configured')
  assert.equal(halt.hidden, false, 'the HALT chip stayed hidden even though status.busy() is true and onStop is configured')
  assert.equal(halt.disabled, false, 'the HALT chip stayed disabled even though it should be pressable')
  halt.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(stopped, 1, 'a real click on the HALT chip did not reach the caller\'s onStop')
  root.dispose()
})

test('the Send now chip never becomes a second HALT button when the box is empty', async () => {
  let stopped = 0
  const root = buildChatLive({
    title: 'agent', seed: 0,
    status: { busy: () => true },
    onSend: () => null,
    onStop: () => { stopped += 1; return null },
    chips: {},
  })
  const now = root.querySelector('[data-chat-chip="sendnow"]')
  assert.equal(now.disabled, true,
    'the chip is pressable with an empty box, where its shared path is armed as Stop')
  now.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(stopped, 0, 'pressing the chip with nothing written halted the running reply')
  root.dispose()
})

test('the Send now chip interrupts the running turn and then delivers the words -- once', async () => {
   /* R17: the user can send a Send now that actually interrupts the agent, and
     W18c puts that act under the arrow. The point
     of this test is the ORDER and the COUNT: the turn is stopped, the words
     are delivered, and a second press of the same button cannot deliver them
     twice or fall through to the bare stop. */
  const acts = []
  let busy = true
  const root = buildChatLive({
    title: 'agent', seed: 0,
    status: { busy: () => busy },
    onSend: text => { acts.push(`send:${text}`); return null },
    onStop: () => { acts.push('stop'); busy = false; return null },
    chips: {},
  })
  const input = root.querySelector('.chat-input textarea')
  const now = root.querySelector('[data-chat-chip="sendnow"]')
  input.value = 'stop what you are doing and read this'
  input.dispatch('input')
  assert.equal(now.disabled, false, 'the door a busy agent is exactly what this button is for was shut')
  now.dispatch('click')
  now.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(acts, ['stop', 'send:stop what you are doing and read this'],
    'Send now must halt the running turn first and then deliver those words exactly once')
  assert.equal(input.value, '', 'the box kept the words it had already sent')
  root.dispose()
})

test('every stop door shows the same pending single-flight state', async () => {
  let stopped = 0
  let release
  const pending = new Promise(resolve => { release = resolve })
  const root = buildChatLive({
    title: 'agent', seed: 0,
    status: { busy: () => true, step: () => 'Working' },
    onSend: () => null,
    onStop: () => { stopped += 1; return pending },
    chips: {},
  })
  const halt = root.querySelector('[data-chat-chip="halt"]')
  const composer = root.querySelector('.chat-send')
  const working = root.querySelector('.working-step button')

  halt.dispatch('click')
  assert.equal(stopped, 1)
  assert.equal(halt.disabled, true, 'HALT still looks pressable while its first press is pending')
  assert.equal(composer.disabled, true, 'the composer stop face still looks pressable while HALT is pending')
  assert.equal(working.disabled, true, 'the working-row Cancel still looks pressable while HALT is pending')

  halt.dispatch('click')
  working.dispatch('click')
  assert.equal(stopped, 1, 'several stop doors dispatched several interrupts')
  release(null)
  await new Promise(resolve => setTimeout(resolve, 0))
  root.dispose()
})

test('the HALT chip stays hidden with no onStop configured, even inside a chips row -- no dead button', () => {
  const root = buildChatLive({
    title: '·', seed: 0, composerReason: NO_SENDER_WIRED,
    chips: { onOpenEffort: () => null },
  })
  assert.equal(root.querySelector('.chat-chip-halt'), null, 'a HALT chip rendered with no onStop to back it -- a dead button, not a control')
  root.dispose()
})

test('value-bearing selectors distinguish the mounted EFFORT and SEND NOW sibling chips', () => {
  const root = buildChatLive({
    title: '·', seed: 0, composerReason: NO_SENDER_WIRED,
    chips: { onOpenEffort: () => null },
  })
  const effort = root.querySelector('[data-chat-chip="effort"]')
  const now = root.querySelector('[data-chat-chip="sendnow"]')
  assert.ok(effort, 'the configured EFFORT chip did not mount')
  assert.ok(now, 'the component-owned SEND NOW chip did not mount')
  assert.notEqual(effort, now, 'value-bearing selectors collapsed two same-name sibling chips onto one node')
  assert.equal(effort.textContent, CHIP_EFFORT_LABEL)
  assert.equal(now.textContent, QUEUE_SEND_NOW)
  root.dispose()
})

/* T1601: A SWITCHED-OFF "Send now" SAYS WHICH OF ITS THREE REASONS IT IS.
 *
 * MEASURED 2026-09-24 on the packaged 1.0.46 Linux build (standalone agent
 * chat, White theme, real composer): the disabled chip's words render at
 * 2.78:1 against the composer surface -- `opacity: .55` over
 * `color(srgb 0.964863 0.969882 0.955608)` -- and 2.94:1 (Tan) / 3.17:1
 * (Black). WCAG 1.4.3 exempts an inactive control from the 4.5:1 floor, which
 * is precisely why the ACCESSIBLE NAME has to carry the reason: it is the only
 * channel left. It carried the act instead -- "Send this message now, even if
 * that means stopping what the agent is writing to do it" -- announced over a
 * button that could not do any of it.
 *
 * The three reasons are syncComposer's own: no sender wired (cannotSend), a
 * halt already in flight (stopping), an empty box. The /goal and /loop chips
 * one row up already answer this way ("/goal -- This agent has not started
 * yet."), so this is the product's existing shape, applied to the door the
 * owner reports people struggling with.
 */
test('the Send now chip names WHY it is off, and names the act again when it is on', async () => {
  const root = buildChatLive({
    title: 'agent', seed: 0,
    status: { busy: () => true },
    onSend: () => null,
    onStop: () => null,
    chips: {},
  })
  const now = root.querySelector('[data-chat-chip="sendnow"]')
  const input = root.querySelector('.chat-input textarea')

  assert.equal(now.disabled, true, 'an empty box must still switch the chip off')
  assert.equal(now.getAttribute('aria-label'), QUEUE_SEND_NOW_OFF_EMPTY,
    'a switched-off Send now announced the act it cannot perform instead of the reason it cannot')
  assert.equal(now.title, QUEUE_SEND_NOW_OFF_EMPTY,
    'the same sentence must reach a sighted pointer, not only a screen reader')
  assert.equal(now.textContent, QUEUE_SEND_NOW, 'the visible word on the chip is unchanged')

  input.value = 'stop and read this'
  input.dispatch('input')
  assert.equal(now.disabled, false)
  assert.equal(now.getAttribute('aria-label'), QUEUE_SEND_NOW_LABEL,
    'a chip that CAN act must name the act, not a stale reason')
  assert.equal(now.title, '', 'a live chip must not keep a tooltip that says it is off')

  /* The empty-box round trip is NOT asserted here on purpose. dom-stand-in's
     requestAnimationFrame calls back synchronously (lib/dom-stand-in.mjs), so
     onInputTyped's coalescing guard latches after the first keystroke and no
     later `input` event reaches syncComposer in this harness at all. That is
     the stand-in, not the product. Measured on the packaged 1.0.46 build over
     CDP (Tab x16 to the composer, type, then Backspace to empty): the chip
     read disabled=false with words in the box and disabled=true once it was
     empty, so syncComposer does run on every real input event and the name
     this test pins follows it. */
  root.dispose()
})

test('a composer with no sender wired hands the Send now chip that refusal by name', () => {
  const root = buildChatLive({
    title: '·', seed: 0, composerReason: NO_SENDER_WIRED,
    chips: { onOpenEffort: () => null },
  })
  const now = root.querySelector('[data-chat-chip="sendnow"]')
  assert.equal(now.disabled, true)
  assert.equal(now.getAttribute('aria-label'), queueSendNowOffBlocked(NO_SENDER_WIRED),
    'the chip repeated the act while the whole composer was refusing to send')
  root.dispose()
})

test('the three off-state names are three different sentences, each naming Send now', () => {
  /* A single generic "unavailable" would be the same defect in a new coat:
     the person still cannot tell an empty box from a halt in flight. */
  const names = [QUEUE_SEND_NOW_OFF_EMPTY, QUEUE_SEND_NOW_OFF_STOPPING, queueSendNowOffBlocked(NO_SENDER_WIRED)]
  assert.equal(new Set(names).size, 3, 'two off-states share one sentence')
  for (const name of names) {
    assert.ok(name.startsWith(QUEUE_SEND_NOW), `an off-state name that does not say which control it is: ${name}`)
    assert.notEqual(name, QUEUE_SEND_NOW_LABEL)
  }
})
