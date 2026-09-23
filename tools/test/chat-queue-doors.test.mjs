/* THE QUEUE STRIP'S CONTROLS, DRIVEN AS A PERSON DRIVES THEM.
 *
 * The owner, 2026-09-03: "first que and send now buttons in chat dont wokr
 * properly." Both were true, and both had passing tests -- because every
 * existing pin on them reads the SOURCE (chat-composer.test.mjs pins
 * `deliverTurn(entry.text)`; chat-composer-chips.test.mjs pinned
 * `chipQueue.disabled = entries.length === 0`). A source pin proves the wire
 * is attached. It cannot prove what comes out the other end, and what came out
 * the other end was the opposite of the label.
 *
 * The owner, 2026-09-04 (R14): "the send now button just says send and then
 * the send next button just moves it around we need a thrid button there for
 * send now also" -- and (R17) that third button has to actually interrupt a
 * running turn. What was one button wearing two faces is now three
 * always-present doors: Send (the ordinary drain), Send next (unchanged --
 * moves a row to the head of the queue), and Send now (new -- may stop a
 * running turn through the composer's own runStop() to deliver its row).
 *
 * This suite mounts the REAL buildChat over the REAL src/session-outbox.js
 * store, dispatches REAL clicks on the real elements, and asserts on the queue
 * that comes back and the bubbles that land in the log. The `onSend` it passes
 * is the shape views/computers.js treeCardSend really has -- busy agents
 * enqueue there, because the engine refuses an overlapping send by design
 * (AGENT_TURN_ACTIVE, shell/agent-host.cjs sendTurn) -- since that shape is
 * precisely what turned "Send now" into "send last".
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { restore } = installDomStandIn(globalThis)
const previousStorage = globalThis.localStorage
const savedQueue = new Map()
const queueStorage = {
  getItem: key => savedQueue.get(key) ?? null,
  setItem: (key, value) => savedQueue.set(key, String(value)),
  removeItem: key => savedQueue.delete(key),
}
globalThis.localStorage = queueStorage
after(() => {
  restore()
  if (previousStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previousStorage
})

const { buildChat } = await import('../../src/components.js')
const outbox = await import('../../src/session-outbox.js')
const { QUEUE_SEND_NEXT, QUEUE_SEND_NEXT_LABEL, QUEUE_SEND_NOW, QUEUE_SEND_NOW_LABEL, QUEUE_UNQUEUE, QUEUE_UNQUEUE_LABEL } =
  await import('../../src/chat-copy.js')
const { QUEUE_PANEL } = await import('../../src/fleet-tree-copy.js')
const { parseSlashCommand } = await import('../../src/slash-commands.js')

// Execute the Page 2 adapter itself, whose surrounding view owns the live DOM.
const viewSource = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
const holdAdapter = viewSource.match(/hold: (request => \{[\s\S]*?\n        \}),/)
assert.ok(holdAdapter, 'Page 2 must wire the durable Send now hold')
const makePage2Hold = new Function('liveSessionId', 'notePersonSpokeTo', 'treeStore', 'node', 'parseSlashCommand', 'outboxHoldForSend',
  `return (${holdAdapter[1]})`)

let seq = 0
const mountedFixtures = new Set()
afterEach(() => {
  globalThis.localStorage = queueStorage
  for (const fixture of mountedFixtures) {
    fixture.root.dispose()
    fixture.state.releaseStop()
    outbox.clearSession(fixture.sessionId)
  }
  mountedFixtures.clear()
})
/* One mounted composer wired the way views/computers.js wires it: the real
   store behind `queue`, and an onSend that queues while busy exactly as
   treeCardSend does. `sent` records what really reached the wire. */
function mount({ busy = true, holdStop = false, withHold = false, attachment = null, acknowledgeBeforeCompletion = false, stopRefused = false, neverIdle = false } = {}) {
  const sessionId = `queue-doors-${++seq}`
  outbox.clearSession(sessionId)
  /* A REAL HALT IS NOT INSTANT. onStop on Page 2 is
     runPaletteAction('interrupt', ...) -- an IPC round trip to the host that
     resolves whenever the engine answers. `holdStop` keeps that promise open
     so a test can press other doors during the exact window a person has in
     front of them, instead of only after the stop has already landed. */
  const statusListeners = new Set()
  const state = {
    busy, sent: [], attempted: [], sentAttachments: [], commands: [], stopped: 0, releaseStop: () => {}, statusListeners,
    completeStop() { state.busy = false; for (const listener of statusListeners) listener() },
  }
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: {
      busy: () => state.busy,
      subscribe: listener => { statusListeners.add(listener); return () => statusListeners.delete(listener) },
    },
    queue: {
      /* The same fields views/computers.js's own list adapter hands the strip:
         the id, the words, and the store's named hold states. Leaving the
         states out would make a row that is held in the product look plain in
         this suite, which is the shape of miss that let "Send now" quietly
         mean "send last". */
      list: () => outbox.list(sessionId).map(entry => ({
        id: entry.id,
        text: entry.text,
        ...(entry.deliveryUnconfirmed ? { deliveryUnconfirmed: true } : {}),
        ...(typeof entry.heldReason === 'string' && entry.heldReason ? { heldReason: entry.heldReason } : {}),
      })),
      add: text => outbox.enqueue(sessionId, text),
      cancel: id => outbox.cancel(sessionId, id),
      replace: (id, text) => outbox.replace(sessionId, id, text),
      ...(withHold ? { hold: makePage2Hold(() => sessionId, () => {}, null, { sessionId }, parseSlashCommand, outbox.holdForSend) } : {}),
      sendNow: id => (outbox.promoteFront(sessionId, id)
        ? { ok: true, sentence: QUEUE_PANEL.movedFront }
        : { ok: false, sentence: QUEUE_PANEL.moveGone }),
    },
    chips: {},
    ...(attachment ? { onAttach: () => attachment } : {}),
    onSend: (text, { reply, fail, attachments, accepted }) => {
      if (parseSlashCommand(text)) { state.commands.push(text); return }
      state.attempted.push(text)
      /* treeCardSend's own first non-slash branch. */
      if (state.busy) {
        const queued = outbox.enqueue(sessionId, text)
        if (!queued.ok) { fail(queued.sentence); return }
        accepted?.()
        reply(QUEUE_PANEL.cardQueued)
        return
      }
      accepted?.()
      state.sent.push(text)
      state.sentAttachments.push(attachments || [])
      reply(`answered: ${text}`)
    },
    onStop: () => {
      state.stopped += 1
      if (stopRefused) return { ok: false, sentence: 'The interrupt was refused.' }
      /* The host took the interrupt and the completion never comes: the
         provider emitted nothing for the abandoned turn, or the host's own
         release wait timed out. `state.busy` stays true and no listener is
         ever told anything. This is the shape the release budget exists for. */
      if (neverIdle) return { ok: true, settled: false, sentence: 'Interrupted.' }
      if (acknowledgeBeforeCompletion) return 'Interrupted.'
      /* An accepted interrupt ends the turn it stopped -- the whole reason
         Send now's halt-then-deliver sequence is safe to follow with a real
         send. A stub that left `state.busy` untouched would make onSend's
         own busy branch enqueue the just-delivered row instead of sending
         it, which is not what a real interrupt does. */
      if (!holdStop) { state.busy = false; return 'stopped' }
      return new Promise(resolve => { state.releaseStop = () => { state.busy = false; resolve('stopped') } })
    },
  })
  const words = () => outbox.list(sessionId).map(entry => entry.text)
  const bubbles = () => root.querySelectorAll('.msg').map(node => node.className)
  const fixture = { root, state, sessionId, words, bubbles, input: root.querySelector('.chat-input input') }
  mountedFixtures.add(fixture)
  return fixture
}

const queueWhileBusy = (fixture, texts) => {
  const send = fixture.root.querySelector('.chat-send')
  for (const text of texts) {
    fixture.input.value = text
    send.dispatch('click')
  }
}
const rows = root => root.querySelectorAll('.chat-queue-row')

/* ------------------------------------------------------------------ the row door */

test('the promote door moves a waiting row to the FRONT while a turn runs — it used to move it to the back', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha', 'bravo', 'charlie'])
  assert.deepEqual(fixture.words(), ['alpha', 'bravo', 'charlie'], 'the three busy sends did not queue in the order they were written')
  assert.equal(rows(fixture.root).length, 3, 'the strip did not preview all three waiting messages')

  /* The whole defect in one press: charlie is LAST, the person asks for it
     first, and before this fix it came back last again (measured: alpha
     pressed on row 1 produced ['bravo','charlie','alpha']). Send next is the
     always-present door for this act now -- it used to be one of two faces
     a single button wore. */
  rows(fixture.root)[2].querySelector('.chat-queue-next').dispatch('click')
  assert.deepEqual(fixture.words(), ['charlie', 'alpha', 'bravo'],
    'the promoted message did not become the next one out')
  assert.deepEqual(fixture.state.sent, [],
    'the promote door reached the wire during a running turn — the engine refuses an overlapping send by design')
  fixture.root.dispose()
})

test('promoting says what happened and paints no message the agent never got', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha', 'bravo'])
  rows(fixture.root)[1].querySelector('.chat-queue-next').dispatch('click')
  const painted = fixture.bubbles()
  assert.ok(!painted.some(kind => /\bme\b/.test(kind)),
    'a you-bubble was painted for words that are still waiting — that claims a send that did not happen')
  assert.ok(!painted.some(kind => /\bthem\b/.test(kind)),
    'the product spoke in the agent\'s voice about its own queue')
  assert.deepEqual(painted, ['msg note'], 'the promote door answered with something other than one product note')
  assert.equal(fixture.root.querySelectorAll('.msg')[0].textContent.includes(QUEUE_PANEL.movedFront), true,
    'the note does not say where the message went')
  fixture.root.dispose()
})

test('a row whose message is gone says so instead of moving something else', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha', 'bravo'])
  const second = rows(fixture.root)[1]
  /* Unqueue it from underneath the row that is already on screen. */
  outbox.clearSession(fixture.sessionId)
  outbox.enqueue(fixture.sessionId, 'alpha')
  second.querySelector('.chat-queue-next').dispatch('click')
  assert.equal(fixture.root.querySelectorAll('.msg')[0].textContent.includes(QUEUE_PANEL.moveGone), true,
    '"could not find it" and "moved it" came back as the same answer')
  assert.deepEqual(fixture.words(), ['alpha'], 'a failed promote changed the queue')
  fixture.root.dispose()
})

test('a queued row wears no Send door, because the row is already sent -- only move it, jump the turn with it, or take it back', () => {
  /* THE OWNER, W18c, verbatim: "in the qued items, no need for an additional
     send button it is already sent at that point." A queued row is a message
     the person has already committed; the ordinary drain in
     views/computers.js takes it at the next turn boundary without being asked.
     The old Send door only did early what was going to happen anyway, and it
     was disabled exactly while a turn ran -- which is when a row exists to
     look at -- so its whole visible life was a greyed button beside two live
     ones. R14's three doors were about the strip's ONE two-faced button; this
     removes the one of them that turned out to have no act of its own. */
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha'])
  const row = rows(fixture.root)[0]
  assert.equal(row.querySelector('.chat-queue-send'), null,
    'the queued row still carries a Send door for a message that is already sent')
  const next = row.querySelector('.chat-queue-next')
  const now = row.querySelector('.chat-queue-now')
  const cancel = row.querySelector('.chat-queue-cancel')
  assert.ok(next && now && cancel, 'a queued row did not paint the three acts it does have')

  assert.equal(next.textContent, QUEUE_SEND_NEXT, 'the reorder door does not carry the reorder label')
  assert.equal(now.textContent, QUEUE_SEND_NOW, 'the interrupting door does not carry the Send now label')
  assert.equal(next.getAttribute('aria-label'), QUEUE_SEND_NEXT_LABEL)

  assert.equal(next.disabled, false, 'the reorder door went dead while there is a queue to reorder')
  assert.equal(now.disabled, false, 'Send now went dead while a turn runs -- interrupting a running turn is the one thing it exists to do')
  assert.equal(now.getAttribute('aria-label'), QUEUE_SEND_NOW_LABEL)
  assert.equal(cancel.textContent, QUEUE_UNQUEUE, 'the way-out door does not carry the Unqueue label')
  assert.equal(cancel.getAttribute('aria-label'), QUEUE_UNQUEUE_LABEL)

  fixture.state.busy = false
  fixture.input.dispatch('input')
  const idle = rows(fixture.root)[0]
  assert.equal(idle.querySelector('.chat-queue-send'), null, 'an idle row grew a Send door back')
  assert.equal(idle.querySelector('.chat-queue-next').disabled, false, 'the reorder door should not depend on busy at all')
  assert.equal(idle.querySelector('.chat-queue-now').disabled, false, 'Send now should not depend on busy at all')
  fixture.root.dispose()
})

test('a press landing after the row was already auto-drained does not put a second, live copy on the wire', async () => {
  /* Send and Send now both cancel-then-deliver. Either can meet a row that
     views/computers.js's own turn-completed branch already took
     (outboxTakeNext) a moment earlier, all before this door's own live
     isBusy() read would have any reason to say so. queue.cancel()'s return,
     not just whether it throws, is what tells the two cases apart. */
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha', 'bravo'])
  const staleNow = rows(fixture.root)[0].querySelector('.chat-queue-now')

  const drained = outbox.takeNext(fixture.sessionId)
  assert.equal(drained.text, 'alpha', 'the row under test must be the one the ordinary drain just took')

  staleNow.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, [],
    'the stale Send now press put a second, genuinely live copy of an already-drained message on the wire')
  assert.equal(fixture.state.stopped, 0, 'Send now tried to halt a turn for a row that had already left the queue')
  assert.deepEqual(fixture.words(), ['bravo'], 'the stale press changed the queue for a row that had already left it')
  const painted = fixture.bubbles()
  assert.ok(!painted.some(kind => /\bme\b/.test(kind)),
    'a you-bubble was painted for a row this press did not actually send')
  outbox.confirmDelivered(fixture.sessionId)
  fixture.root.dispose()
})

test('with nothing running, Send now delivers the row it was pressed on and leaves the rest of the queue alone', async () => {
  /* This was the Send door's test before W18c removed that door. The act it
     covers -- one specific row's words reach the wire, the OTHER rows do not,
     and no halt is called when nothing is running -- still exists, on the
     door that now carries it. */
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha', 'bravo'])
  fixture.state.busy = false
  fixture.input.dispatch('input')
  rows(fixture.root)[1].querySelector('.chat-queue-now').dispatch('click')
  /* deliverTurn hands the words to onSend on a microtask, so the wire is read
     one tick later -- the same shape chat-composer-chips.test.mjs waits on. */
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['bravo'], 'an idle press did not put that row\'s words on the wire')
  assert.deepEqual(fixture.words(), ['alpha'], 'the sent message is still sitting in the queue')
  assert.equal(fixture.state.stopped, 0, 'the door called the stop path for a turn that was not running')
  assert.ok(fixture.bubbles().some(kind => /\bme\b/.test(kind)), 'words that really went have no you-bubble')
  fixture.root.dispose()
})

/* ------------------------------------------------------- the third button */

test('Send now pressed while nothing runs delivers without calling stop at all', async () => {
  /* THE OWNER, 2026-09-04 (R17, verbatim): "the user needs to be able to
     send a send now that actually interrrupts the agent." Interrupting is
     only honest when there is something to interrupt -- idle, Send now is
     an ordinary send and must not reach for the halt path regardless. */
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha'])
  fixture.state.busy = false
  fixture.input.dispatch('input')
  rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, ['alpha'], 'Send now with nothing running did not deliver the row')
  assert.equal(fixture.state.stopped, 0, 'Send now called the stop path for a turn that was not running')
  assert.deepEqual(fixture.words(), [], 'the delivered row is still sitting in the queue')
  fixture.root.dispose()
})

test('Send now pressed while a turn runs reaches the stop path once and then delivers the row it was pressed on', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha'])
  rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')

  assert.equal(fixture.state.stopped, 1, 'Send now did not reach the same stop path the HALT chip uses')
  assert.deepEqual(fixture.state.sent, [], 'Send now delivered before the halt it started had resolved')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['alpha'], 'Send now did not deliver its own row once the halt it started resolved')
  assert.equal(fixture.state.stopped, 1, 'Send now reached the stop path more than once for one press')
  fixture.root.dispose()
})

test('Send now discards reply text immediately while preserving its accepted turn receipt', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  const stream = fixture.root.openStream({ turnStamp: 'discarded-turn' })
  stream.push('Abandoned provider text.')
  queueWhileBusy(fixture, ['replacement'])
  rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')
  const matchingReceipts = () => fixture.root.querySelectorAll('.them')
    .filter(row => row.querySelector('.turn-stamp')?.textContent === 'discarded-turn')
  const receipt = matchingReceipts()[0]
  assert.ok(receipt, 'the accepted turn must remain in the transcript')
  assert.equal(receipt.hasAttribute('aria-busy'), false)
  assert.equal(receipt.querySelector('.chat-msg-text').textContent, 'Reply discarded.')
  stream.push('Late abandoned provider text.')
  stream.close('Late completed provider text.')
  assert.equal(receipt.querySelector('.chat-msg-text').textContent, 'Reply discarded.')
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['replacement'])
  assert.equal(matchingReceipts().length, 1)
})

test('the Send now chip keeps a recalled queue edit without sending another copy', async () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['first', 'second'])
  fixture.input.dispatch('keydown', { key: 'ArrowUp' })
  fixture.input.value = 'second, corrected'
  fixture.input.dispatch('input')
  fixture.root.querySelector('[data-chat-chip="sendnow"]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), ['first', 'second, corrected'])
  assert.deepEqual(fixture.state.sent, [], 'editing a waiting message must not send another copy')
  assert.equal(fixture.state.stopped, 0, 'saving the edit must not interrupt the agent')
  assert.equal(fixture.input.value, '', 'saving the edit restores the original composer draft')
  fixture.root.dispose()
})

test('closing a chat during Send now keeps its queued row available for the next chat', async () => {
  const fixture = mount({ busy: true, holdStop: true, withHold: true })
  queueWhileBusy(fixture, ['first', 'send this now'])
  rows(fixture.root)[1].querySelector('.chat-queue-now').dispatch('click')
  fixture.root.dispose()
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), ['send this now', 'first'], 'the interrupted send must remain queued')
  assert.deepEqual(fixture.state.sent, [], 'a disposed chat must leave delivery to the surviving queue')
  const next = outbox.takeNext(fixture.sessionId)
  assert.equal(next?.text, 'send this now', 'closing the chat must release its hold')
  outbox.confirmDelivered(fixture.sessionId, next)
})

test('closing a chat during typed Send now keeps the committed text queued', async () => {
  const fixture = mount({ busy: true, holdStop: true, withHold: true })
  queueWhileBusy(fixture, ['first'])
  fixture.input.value = 'stop and read this'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  fixture.root.dispose()
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), ['stop and read this', 'first'], 'clearing the input must not discard the committed text')
  assert.deepEqual(fixture.state.sent, [])
})

test('a held Send now blocks automatic delivery until its interrupt returns, then sends once', async () => {
  const fixture = mount({ busy: true, holdStop: true, withHold: true })
  queueWhileBusy(fixture, ['first', 'send this now'])
  rows(fixture.root)[1].querySelector('.chat-queue-now').dispatch('click')

  assert.deepEqual(fixture.words(), ['send this now', 'first'], 'the pending message must stay visible')
  assert.equal(outbox.takeNext(fixture.sessionId), null, 'the turn completion must not race the explicit send')
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, ['send this now'])
  assert.deepEqual(fixture.words(), ['first'])
  fixture.root.dispose()
})

test('Send now waits for turn completion after the interrupt is acknowledged', async () => {
  const fixture = mount({ busy: true, withHold: true, acknowledgeBeforeCompletion: true })
  queueWhileBusy(fixture, ['ordinary queued message'])
  fixture.input.value = 'the explicit Send now'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.state.stopped, 1, 'the host acknowledged this interrupt')
  assert.deepEqual(fixture.state.attempted, [], 'acknowledgement must not trigger an overlapping send')
  assert.equal(fixture.root.querySelector('.chat-send').disabled, true, 'the pending stop must remain visible')
  assert.deepEqual(fixture.words(), ['the explicit Send now', 'ordinary queued message'])
  fixture.state.completeStop()
  assert.equal(outbox.takeNext(fixture.sessionId), null, 'the completion drain must not steal the held message')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.attempted, ['the explicit Send now'])
  assert.deepEqual(fixture.state.sent, ['the explicit Send now'])
  assert.deepEqual(fixture.words(), ['ordinary queued message'], 'plain queued words remain waiting behind the explicit send')
})

test('closing after interrupt acknowledgement releases the waiter and keeps the message queued', async () => {
  const fixture = mount({ busy: true, withHold: true, acknowledgeBeforeCompletion: true })
  fixture.input.value = 'still not sent'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.root.dispose()
  assert.equal(fixture.state.statusListeners.size, 0, 'closing must detach the completion waiter')
  fixture.state.completeStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.attempted, [])
  assert.deepEqual(fixture.words(), ['still not sent'])
})

test('a refused interrupt does not consume or send the committed message', async () => {
  const fixture = mount({ busy: true, withHold: true, stopRefused: true })
  fixture.input.value = 'keep this queued'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.attempted, [])
  assert.deepEqual(fixture.words(), ['keep this queued'])
  assert.equal(fixture.root.querySelector('.chat-send').disabled, false)
})

/* THE RELEASE BUDGET (HANDOFF-M13-BEFORE-INSTALL-20260918.md: "150-250ms
   release budget on the user path"), and the residue it ends.

   A Send now whose interrupt the host accepted still waits for THIS window's
   status to read idle before the engine send goes out. That wait had no bound.
   When the completion never arrives -- a provider that emits nothing for an
   abandoned turn, a host whose own release wait timed out -- the composer sat
   with `stopping` true, every stop door locked, the durable hold in place, and
   the next Send now was refused with "A Send now is already waiting for this
   agent to stop" until the row was unqueued by hand. Measured in this suite's
   own fixture before the bound: at +1 s the row still read "Send now" with all
   three doors disabled and the composer's send button disabled.

   The Controller's ruling on what the bound does: no hard kill (bridge.close()
   destroys the agent), and when idle never arrives the row shows a NAMED hold
   with Retry send and Unqueue -- never a silent stall, never a refusal on the
   glass. These assert exactly that, by what a person sees and can press. */
const settleWithin = async (ms, done) => {
  const started = performance.now()
  while (performance.now() - started < ms) {
    if (done()) return performance.now() - started
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return null
}
const heldRow = fixture => rows(fixture.root).find(row => row.querySelector('.chat-queue-state')?.dataset.heldReason)

test('a Send now whose stop never reports idle is parked under a NAMED hold inside the release budget, with Retry send and Unqueue', async () => {
  const fixture = mount({ busy: true, withHold: true, neverIdle: true })
  fixture.input.value = 'answer this instead'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fixture.state.stopped, 1, 'the press must reach the stop')
  assert.equal(fixture.root.querySelector('.chat-send').disabled, true, 'the stop doors are locked while the release is genuinely awaited')
  assert.equal(heldRow(fixture), undefined, 'nothing is parked before the budget is spent')

  /* The bar is the ratified range, asserted as a window rather than a number:
     parked no sooner than the bottom of the range would allow, and well
     inside one second, on a box this loaded. The measured figure is printed. */
  const elapsed = await settleWithin(1500, () => Boolean(heldRow(fixture)))
  assert.notEqual(elapsed, null, 'the wait for idle is still unbounded: no named hold appeared within 1.5 s')
  console.log(`# release budget spent after ${elapsed.toFixed(0)} ms (ratified range 150-250 ms, plus timer lateness on this box)`)
  assert.ok(elapsed >= 100, `parked at ${elapsed.toFixed(0)} ms, before a real completion could have been given its chance`)
  assert.ok(elapsed < 1000, `parked at ${elapsed.toFixed(0)} ms, outside anything the ratified range allows`)

  const row = heldRow(fixture)
  assert.equal(row.querySelector('.chat-queue-state').dataset.heldReason, 'SEND_NOW_RELEASE_BUDGET', 'the hold is not named')
  assert.equal(row.querySelector('.chat-queue-state').textContent.trim().length > 4, true, 'the named hold says nothing a person can read')
  const doors = row.querySelectorAll('button').map(button => [button.textContent, button.disabled])
  assert.deepEqual(doors.filter(([label]) => label === QUEUE_PANEL.retryUnconfirmed), [[QUEUE_PANEL.retryUnconfirmed, false]], 'Retry send is not on the parked row, enabled')
  assert.deepEqual(doors.filter(([label]) => label === QUEUE_UNQUEUE), [[QUEUE_UNQUEUE, false]], 'Unqueue is not on the parked row, enabled')
  assert.equal(fixture.root.querySelector('.chat-send').disabled, false, 'a spent budget must release the stop doors: this is the silent stall')
  assert.deepEqual(fixture.state.attempted, [], 'nothing may be sent into a turn this window cannot see the end of')
  assert.deepEqual(fixture.words(), ['answer this instead'], 'the words must still be queued, not lost and not duplicated')
  assert.ok(!fixture.bubbles().some(kind => /\bme\b/.test(kind)), 'a row parked in the strip must not also claim to be sent in the log')
  const notes = fixture.root.querySelectorAll('.msg').filter(node => /\bnote\b/.test(node.className)).map(node => node.textContent)
  assert.ok(!notes.some(text => /already waiting|refused|could not/i.test(text)), `a refusal reached the glass: ${JSON.stringify(notes)}`)
  fixture.root.dispose()
})

test('one Send now does not lock the next: after a parked Send now a second is taken, not refused as "already waiting"', async () => {
  const fixture = mount({ busy: true, withHold: true, neverIdle: true })
  fixture.input.value = 'first'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.notEqual(await settleWithin(1500, () => Boolean(heldRow(fixture))), null, 'setup: the first Send now never parked')

  fixture.input.value = 'second'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  const notes = fixture.root.querySelectorAll('.msg').filter(node => /\bnote\b/.test(node.className)).map(node => node.textContent)
  assert.ok(!notes.some(text => /already waiting/i.test(text)), `the second Send now was refused by the first one's spent reservation: ${JSON.stringify(notes)}`)
  assert.equal(fixture.state.stopped, 2, 'the second Send now must reach the stop like the first did')
  assert.deepEqual(fixture.words(), ['second', 'first'], 'the second Send now must take the front of the queue, behind nothing')
  fixture.root.dispose()
})

test('Retry send on a parked row asks for the stop again and drops the named hold while it waits', async () => {
  const fixture = mount({ busy: true, withHold: true, neverIdle: true })
  fixture.input.value = 'try again'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.notEqual(await settleWithin(1500, () => Boolean(heldRow(fixture))), null, 'setup: the Send now never parked')

  const retry = heldRow(fixture).querySelectorAll('button').find(button => button.textContent === QUEUE_PANEL.retryUnconfirmed)
  retry.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fixture.state.stopped, 2, 'Retry send must reach the stop again')
  assert.equal(heldRow(fixture), undefined, 'the row must stop claiming the old hold while a new stop is awaited')
  assert.equal(outbox.takeNext(fixture.sessionId), null, 'a retried row is reserved again; the drain must not take it out from under the retry')
  /* And when the turn genuinely ends this time, the retried words go once. */
  fixture.state.completeStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['try again'])
  assert.deepEqual(fixture.words(), [])
  fixture.root.dispose()
})

test('a parked Send now still goes on its own when the turn finally ends', async () => {
  const fixture = mount({ busy: true, withHold: true, neverIdle: true })
  fixture.input.value = 'lands later'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  assert.notEqual(await settleWithin(1500, () => Boolean(heldRow(fixture))), null, 'setup: the Send now never parked')
  const next = outbox.takeNext(fixture.sessionId)
  assert.equal(next?.text, 'lands later', 'the ordinary boundary drain must be able to take a parked row')
  outbox.confirmDelivered(fixture.sessionId, next)
  assert.deepEqual(fixture.words(), [])
  fixture.root.dispose()
})

test('typed Send now preserves the complete message beyond the old 4,000-character queue cap', async () => {
  const fixture = mount({ busy: true, withHold: true })
  const text = 'x'.repeat(5000) + 'END'
  fixture.input.value = text
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, [text], 'the held message must reach the wire without truncation')
  assert.equal(fixture.input.value, '')
  fixture.root.dispose()
})

test('Send now refuses an oversized serialized message without interrupting or clearing it', async () => {
  const fixture = mount({ busy: true, withHold: true })
  // JSON escaping makes this too large for the saved envelope even though
  // its plain text is shorter than the storage limit and the host limit.
  const text = '"'.repeat(31_000)
  fixture.input.value = text
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.input.value, text, 'the refusal must leave every character in the composer')
  assert.equal(fixture.state.stopped, 0)
  assert.deepEqual(fixture.state.sent, [])
  assert.deepEqual(fixture.words(), [])
  fixture.root.dispose()
})

test('a storage write refusal leaves typed Send now in the composer without interrupting', async () => {
  const fixture = mount({ busy: true, withHold: true })
  queueWhileBusy(fixture, ['already waiting'])
  globalThis.localStorage = { ...queueStorage, setItem() { throw new Error('write refused') } }
  const text = 'x'.repeat(5000) + 'END'
  fixture.input.value = text
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.input.value, text)
  assert.equal(fixture.state.stopped, 0)
  assert.deepEqual(fixture.words(), ['already waiting'], 'the refused reservation must restore the previous queue')
  assert.deepEqual(fixture.state.sent, [])
})

test('a storage write refusal keeps an existing Send now row in its original order', async () => {
  const fixture = mount({ busy: true, withHold: true })
  queueWhileBusy(fixture, ['first', 'second'])
  globalThis.localStorage = { ...queueStorage, setItem() { throw new Error('write refused') } }
  rows(fixture.root)[1].querySelector('.chat-queue-now').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), ['first', 'second'])
  assert.equal(fixture.state.stopped, 0)
  assert.deepEqual(fixture.state.sent, [])
})

test('busy Send now interrupts and delivers the message WITH its attachment', async () => {
  /* This used to assert the opposite: that a busy Send now with a file
     attached interrupted nothing, sent nothing, and left both in the composer
     until the person sent again at idle. That was the shipped behaviour and it
     made Send now mean "wait for the turn to end" for exactly the messages
     people press it for -- T335. The composer refused on the premise that "the
     durable outbox carries text only", which is true of holdForSend() and
     beside the point: the hold reserves the WORDS, and the file rides
     deliverTurn's own ridingAttachments, the same path every ordinary send
     already uses for files.

     Asserted by values, not by spelling: the interrupt happened, the words
     went, the file went with them, and the composer is empty afterwards. */
  const attachment = { ok: true, path: 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp/queue-test-image.png', size: 100 }
  const fixture = mount({ busy: true, holdStop: true, withHold: true, attachment })
  fixture.root.querySelector('[data-chat-attach]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.input.value = 'Analyze this picture'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.state.stopped, 1, 'Send now with a file must interrupt the running turn')
  assert.deepEqual(fixture.state.sent, [], 'delivery must wait for the interrupt to return')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, ['Analyze this picture'], 'the message must be delivered, not held back')
  assert.deepEqual(fixture.state.sentAttachments[0].map(item => item.path), [attachment.path],
    'the file must ride the same send as its words')
  assert.equal(fixture.input.value, '', 'the delivered words must leave the composer')
  assert.equal(fixture.root.querySelectorAll('.chat-attachment-chip').length, 0,
    'the delivered file must leave the composer with them')
  assert.deepEqual(fixture.words(), [], 'nothing may be left waiting in the queue after delivery')
  fixture.root.dispose()
})

test('a full queue refuses typed Send now without stopping or clearing the composer', async () => {
  const fixture = mount({ busy: true, withHold: true })
  queueWhileBusy(fixture, Array.from({ length: 12 }, (_, i) => `queued ${i}`))
  fixture.input.value = 'keep this draft'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.words().length, 12)
  assert.equal(fixture.input.value, 'keep this draft')
  assert.equal(fixture.state.stopped, 0)
  assert.deepEqual(fixture.state.sent, [])
  fixture.root.dispose()
})

test('Send now routes console commands without saving them as messages or interrupting first', async () => {
  const fixture = mount({ busy: true, withHold: true })
  fixture.input.value = '/help'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.commands, ['/help'])
  assert.deepEqual(fixture.words(), [], 'a console command must never reach the automatic model-send drain')
  assert.equal(fixture.state.stopped, 0, 'a console command must use its own action')
  fixture.root.dispose()
})

test('Unqueue in another chat cancels a pending Send now before it reaches the wire', async () => {
  const fixture = mount({ busy: true, holdStop: true, withHold: true })
  queueWhileBusy(fixture, ['do not send after I unqueue'])
  const [entry] = outbox.list(fixture.sessionId)
  rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')
  assert.equal(outbox.cancel(fixture.sessionId, entry.id), true)
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), [])
  assert.deepEqual(fixture.state.sent, [], 'a cancelled hold must not send its old captured text')
  fixture.root.dispose()
})

test('Send now cancels its own row out of the queue before the halt lands, so the automatic drain cannot also take it', async () => {
  /* THE GATE. The row must be out of the shared queue array BEFORE the halt
     starts, or views/computers.js's own turn-completed drain (outboxTakeNext
     + drainOutboxMessage, wired to the same turn-ending event the halt
     produces) can take this exact row and send it through the ORDINARY path
     -- a real race between the automatic drain and this button's own
     explicit send, for the row the person pressed. */
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha'])
  rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')

  /* Still inside the halt Send now itself started -- onStop's promise has
     not been released yet. The row must already be gone from the shared
     store, not merely destined to be. */
  assert.deepEqual(fixture.words(), [], 'Send now left its own row sitting in the queue while its halt was still in flight')
  assert.equal(outbox.takeNext(fixture.sessionId), null,
    'the automatic drain found a row to take -- Send now should have already claimed the only one there was')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['alpha'], 'the row Send now claimed before the halt never reached the wire once the halt resolved')
  fixture.root.dispose()
})

test('a Send now press during a pending stop is refused -- MUTATION CHECK: breaking the guard turns this red', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha'])
  fixture.root.querySelector('[data-chat-chip="halt"]').dispatch('click')
  assert.equal(fixture.state.stopped, 1, 'the HALT chip did not reach onStop, so nothing is pending yet')

  const now = rows(fixture.root)[0].querySelector('.chat-queue-now')
  assert.equal(now.disabled, true, 'Send now stayed live while the halt the person pressed has not landed')
  now.dispatch('click')
  assert.equal(fixture.state.stopped, 1, 'a disabled Send now still reached the stop path a second time')
  assert.deepEqual(fixture.words(), ['alpha'], 'a refused Send now press changed the queue anyway')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.root.dispose()
})

test('an idle row already taken at the boundary cannot send its captured words twice', async () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha'])
  fixture.state.busy = false
  fixture.input.dispatch('input')
  const staleDoor = rows(fixture.root)[0].querySelector('.chat-queue-now')

  /* The completion drain wins immediately before this old DOM listener. */
  outbox.takeNext(fixture.sessionId)
  staleDoor.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, [],
    'a stale Send now row sent the captured text after the queue had already handed that entry out')
  fixture.root.dispose()
})

test('a double-click on the morphing composer button cannot queue and then halt', async () => {
  const fixture = mount({ busy: true })
  const send = fixture.root.querySelector('.chat-send')
  fixture.input.value = 'one message'
  fixture.input.dispatch('input')
  send.dispatch('click', { detail: 1 })
  send.dispatch('click', { detail: 2 })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), ['one message'])
  assert.equal(fixture.state.stopped, 0,
    'the second half of one double-click saw the newly empty box and became Stop')
  fixture.root.dispose()
})

/* --------------------------------------------- every door, while a stop is pending */

/* THE HALF-RULE THIS SECTION CLOSES.
 *
 * A stop is an IPC round trip, not an instant: on Page 2 onStop is
 * runPaletteAction('interrupt', ...), and until it answers the composer holds
 * ITSELF shut -- the morphing send button is disabled, the SEND chip is
 * disabled, the QUEUE chip's add branch is refused and send() returns on its
 * own `stopping` line. That is one decision, made in one place: while the
 * person is waiting for the halt they asked for, no door of this composer
 * starts anything.
 *
 * Two doors never read it. The queue strip's rows are rebuilt by
 * paintQueueStrip, which knew about `queue` and `isBusy` and nothing about a
 * pending stop, so Send now / Unqueue stayed live and pressable; and ⇧⏎
 * reaches sendNowFromInput, which is the ONLY send door in this file with no
 * `stopping` line -- so the same box answered ⏎ with "not while I am
 * stopping" and ⇧⏎ with a queued message, which is exactly the trap the ⇧⏎
 * door's own comment says a chord must never be. */

test('a queued row\'s doors lock with every other door while a stop is in flight', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha'])
  fixture.root.querySelector('[data-chat-chip="halt"]').dispatch('click')
  assert.equal(fixture.state.stopped, 1, 'the HALT chip never reached onStop, so nothing is pending')

  const pressed = rows(fixture.root)[0]
  assert.equal(pressed.querySelector('.chat-queue-next').disabled, true,
    'the row still offers to reorder while the halt the person pressed has not landed')
  assert.equal(pressed.querySelector('.chat-queue-now').disabled, true,
    'the row still offers Send now while the halt the person pressed has not landed')
  assert.equal(pressed.querySelector('.chat-queue-cancel').disabled, true,
    'the row still offers to unqueue while the halt the person pressed has not landed')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  const after = rows(fixture.root)[0]
  assert.equal(after.querySelector('.chat-queue-next').disabled, false,
    'the reorder door stayed locked after the stop it was waiting on landed')
  assert.equal(after.querySelector('.chat-queue-now').disabled, false,
    'Send now stayed locked after the stop it was waiting on landed')
  assert.equal(after.querySelector('.chat-queue-cancel').disabled, false,
    'the unqueue door stayed locked after the stop it was waiting on landed')
  fixture.root.dispose()
})

test('a queued row\'s Send now, captured before the halt, refuses once repainted disabled -- not merely once repainted', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha'])
  const staleDoor = rows(fixture.root)[0].querySelector('.chat-queue-now')
  fixture.root.querySelector('[data-chat-chip="halt"]').dispatch('click')

  /* The engine's turn-stopped event can land before the interrupt CALL
     answers, and a click already queued against this exact (now detached)
     element can land after the repaint that disabled its replacement. The
     listener has to ask `stopping` itself rather than trust whatever its own
     `disabled` read at the moment it was created. */
  fixture.state.busy = false
  staleDoor.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.state.sent, [],
    'a queue row started a new turn while the stop the person pressed was still in flight')
  assert.deepEqual(fixture.words(), ['alpha'],
    'the row cancelled the waiting message on its way to a send it never made -- the words are simply gone')
  fixture.root.dispose()
})

/* THE ROW DOOR WAS THE ONE DOOR THAT NEVER ASKED cannotSend.
 *
 * Every other send path in the composer refuses first and acts second --
 * send(), sendNowFromInput() and deliverTurn() all open on that check, and
 * deliverTurn's own note says why the check has to be the FIRST line ("a
 * disabled input is only a suggestion"). The strip's row door acted first: it
 * cancelled the waiting entry, then handed the words to deliverTurn, which
 * returned at its own first line. The message was removed from the queue and
 * delivered nowhere, with no note and no bubble -- the silent skip, on a
 * surface whose whole promise is that these words will not be lost.
 *
 * The strip renders for any caller that passes `queue` (components.js's
 * markup gates it on that alone), so a read-only panel with a queue paints
 * live Send now buttons today. */
test('a composer that refuses sends does not eat a queued message through the row door', async () => {
  const sessionId = `queue-doors-nosend-${++seq}`
  outbox.clearSession(sessionId)
  outbox.enqueue(sessionId, 'alpha')
  const root = buildChat({
    title: 'Session transcript',
    seed: 0,
    composerReason: 'This panel is a second window onto the session, not a second way to talk to it.',
    status: { busy: () => false },
    queue: {
      list: () => outbox.list(sessionId).map(entry => ({ id: entry.id, text: entry.text })),
      add: text => outbox.enqueue(sessionId, text),
      cancel: id => outbox.cancel(sessionId, id),
    },
  })
  const row = root.querySelectorAll('.chat-queue-row')[0]
  assert.ok(row, 'the strip painted no row, so this door was never reached and the test proves nothing')
  assert.equal(row.querySelector('.chat-queue-next').disabled, true,
    'a composer that refuses sends still offers a live Send next on its queued rows')
  assert.equal(row.querySelector('.chat-queue-now').disabled, true,
    'a composer that refuses sends still offers a live Send now on its queued rows')
  row.querySelector('.chat-queue-next').dispatch('click')
  row.querySelector('.chat-queue-now').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(outbox.list(sessionId).map(entry => entry.text), ['alpha'],
    'the row unqueued the message on its way to a delivery its own composer refuses — the words are gone, with nothing said')
  root.dispose()
})

test('⇧⏎ answers the same as ⏎ while a stop is in flight — one box, one rule', async () => {
  const fixture = mount({ busy: true, holdStop: true })
  fixture.root.querySelector('[data-chat-chip="halt"]').dispatch('click')
  fixture.input.value = 'urgent'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(fixture.words(), [],
    '⇧⏎ acted on a composer whose plain ⏎ refuses while its own stop is pending')
  assert.deepEqual(fixture.state.sent, [], '⇧⏎ reached the wire during a pending stop')
  assert.equal(fixture.input.value, 'urgent',
    '⇧⏎ emptied the box without doing anything with the words')
  fixture.root.dispose()
})

test('a direct send that becomes queued retracts its optimistic bubble and paints only when accepted', async () => {
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: { busy: () => false },
    queue: {
      list: () => [],
      add: () => ({ ok: false }),
      cancel: () => false,
    },
    onSend: (text, { queued }) => queued(QUEUE_PANEL.turnBecameBusy),
  })
  const input = root.querySelector('.chat-input input')
  input.value = 'boundary-race'
  root.querySelector('.chat-send').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  const messages = () => root.querySelectorAll('.msg')
  const ofKind = kind => messages().filter(node => node.classList.contains(kind))
  assert.equal(ofKind('me').length, 0,
    'words waiting in the outbox still look as though the agent accepted them')
  assert.equal(ofKind('note').length, 1,
    'the boundary race did not explain that the message became next')

  root.addOwnerMessage('boundary-race', { at: Date.now(), turnStamp: 'turn-race' })
  assert.equal(ofKind('me').length, 1,
    'the accepted queued turn never gained the person bubble it had earned')
  assert.equal(ofKind('me')[0].querySelector('.turn-stamp')?.textContent, 'turn-race')
  root.dispose()
})

/* ------------------------------------------------------------------- ⇧⏎ */

test('⇧⏎ while a turn runs interrupts it and sends, rather than queueing at the front', async () => {
  /* W18c, the owner: "Send should be the default send now should be sahift
     enter", on top of R17's "a send now that actually interrrupts the agent".
     This chord used to queue-and-promote -- "next" wearing the word "now" --
     which was the best available act before W18b built a door that can really
     stop a turn. It is not the best available act any more, and a chord that
     says now and means next is a trap. Send next still exists on the row. */
  const fixture = mount({ busy: true, holdStop: true })
  queueWhileBusy(fixture, ['alpha', 'bravo'])
  fixture.input.value = 'urgent'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })

  assert.equal(fixture.state.stopped, 1, '⇧⏎ did not reach the same stop path the HALT chip uses')
  assert.deepEqual(fixture.state.sent, [], '⇧⏎ delivered before the halt it started had resolved')
  assert.equal(fixture.input.value, '', 'the composer kept words it had already committed to send')

  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['urgent'], '⇧⏎ did not deliver its words once the halt it started resolved')
  assert.deepEqual(fixture.words(), ['alpha', 'bravo'],
    '⇧⏎ disturbed the rows that were already waiting -- it sends the box, it does not reorder the queue')
  assert.equal(fixture.state.stopped, 1, '⇧⏎ reached the stop path more than once for one press')
  fixture.root.dispose()
})

test('a Send now that loses the settling race waits at the FRONT of the queue, never behind everything', async () => {
  /* THE OWNER, W18c clarification, verbatim: "send now should interrupt
     immediately. que should wait for the end of their turn (an idle)."
     The interrupt itself has no delay in it -- runStop calls onStop, which is
     bridge.interrupt, with no timer anywhere between the press and the wire.
     What CAN delay the words is the send that follows: the engine accepts the
     interrupt before the interrupted turn has fully settled, so the send
     immediately after can still be refused with AGENT_TURN_ACTIVE, and the
     view then writes those words into the durable queue -- at the back, behind
     everything already waiting. That is the person's "now" turning into
     "last". Nothing may overlap a turn the engine says is running, so the
     honest maximum is the FRONT of the queue: the next thing to go. */
  const sessionId = `queue-doors-race-${++seq}`
  outbox.clearSession(sessionId)
  outbox.enqueue(sessionId, 'alpha')
  outbox.enqueue(sessionId, 'bravo')
  let stopped = 0
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: { busy: () => true },
    queue: {
      list: () => outbox.list(sessionId).map(entry => ({ id: entry.id, text: entry.text })),
      add: text => outbox.enqueue(sessionId, text),
      cancel: id => outbox.cancel(sessionId, id),
      sendNow: id => (outbox.promoteFront(sessionId, id)
        ? { ok: true, sentence: QUEUE_PANEL.movedFront }
        : { ok: false, sentence: QUEUE_PANEL.moveGone }),
    },
    chips: {},
    /* The settling race, exactly: the engine has taken the interrupt but still
       refuses the send, so the view queues the words at the back and says so
       through `queued` -- the shape views/computers.js really produces. */
    onSend: (text, { queued }) => {
      outbox.enqueue(sessionId, text)
      queued(QUEUE_PANEL.cardQueued)
    },
    onStop: () => { stopped += 1; return 'stopped' },
  })
  const input = root.querySelector('.chat-input input')
  input.value = 'stop and read this'
  input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(stopped, 1, 'Send now did not interrupt at all')
  assert.deepEqual(outbox.list(sessionId).map(entry => entry.text), ['stop and read this', 'alpha', 'bravo'],
    'a Send now refused by the settling engine was left at the back of the queue, behind everything the person had already queued')
  root.dispose()
})

test('⇧⏎ with nothing running is still a plain send, and never reaches for the halt', async () => {
  const fixture = mount({ busy: false })
  fixture.input.value = 'go'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['go'], 'the idle chord stopped sending')
  assert.deepEqual(fixture.words(), [], 'an idle chord queued instead of sending')
  assert.equal(fixture.state.stopped, 0, 'the idle chord called the stop path with nothing to stop')
  fixture.root.dispose()
})

test('⏎ is the ordinary send: while a turn runs it queues, exactly as the arrow does', () => {
  /* W18c: "The arrow should send". Plain ⏎ and the arrow are one act, and at a
     busy agent that act is "wait your turn" -- which is why the Queue chip is
     gone: the arrow already is the queue door. */
  const fixture = mount({ busy: true })
  fixture.input.value = 'after you finish'
  fixture.input.dispatch('keydown', { key: 'Enter' })

  assert.deepEqual(fixture.words(), ['after you finish'], 'plain ⏎ at a busy agent did not queue the words')
  assert.deepEqual(fixture.state.sent, [], 'plain ⏎ reached the wire during a running turn')
  assert.equal(fixture.state.stopped, 0, 'plain ⏎ stopped the running turn -- that is ⇧⏎\'s act, not this one')
  assert.equal(fixture.input.value, '', 'the composer kept the words it had already queued')
  fixture.root.dispose()
})

/* ------------------------------------------------------------------ the store */

test('promoteFront moves a waiting message and refuses to invent one', () => {
  const sid = 'queue-doors-store'
  outbox.clearSession(sid)
  const first = outbox.enqueue(sid, 'one').entry
  outbox.enqueue(sid, 'two')
  const third = outbox.enqueue(sid, 'three').entry
  assert.equal(outbox.promoteFront(sid, third.id), true)
  assert.deepEqual(outbox.list(sid).map(entry => entry.text), ['three', 'one', 'two'])
  assert.equal(outbox.promoteFront(sid, third.id), true, 'promoting the message that is already first is not a failure')
  assert.deepEqual(outbox.list(sid).map(entry => entry.text), ['three', 'one', 'two'])
  assert.equal(outbox.promoteFront(sid, 'ob-not-a-real-id'), false, '"it is gone" came back as "it moved"')
  assert.equal(outbox.promoteFront('', first.id), false, 'a nameless session promoted something')
  assert.deepEqual(outbox.list(sid).map(entry => entry.text), ['three', 'one', 'two'], 'a refused promote reordered the queue anyway')
  /* The door only ever moves what is already waiting, so the per-session
     bound cannot be walked around through it. */
  outbox.clearSession(sid)
  for (let i = 0; i < 12; i += 1) outbox.enqueue(sid, `m${i}`)
  assert.equal(outbox.enqueue(sid, 'thirteenth').ok, false)
  assert.equal(outbox.promoteFront(sid, 'ob-nope'), false)
  assert.equal(outbox.list(sid).length, 12, 'promoting changed how many messages a session may hold')
  outbox.clearSession(sid)
})

/* ------------------------------------------------------------------ the idle enqueue
   THE ONE PIN IN THIS FILE THAT READS SOURCE, AND WHY. queueForSession lives
   inside the views/computers.js closure; there is no way to call it from
   node --test without standing up the whole fleet view. The precedent is
   session-outbox.test.mjs's own last test, which pins the drain's position in
   the turn-completed branch the same way. What is being held is that every
   enqueue door goes through the ONE helper, and that the helper asks whether a
   turn is running before it promises one will finish. */

test('every enqueue door goes through the one helper, and the helper knows an idle agent has no turn to wait behind', () => {
  const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const helper = view.slice(view.indexOf('function queueForSession(node, text)'), view.indexOf('async function drainOutboxMessage'))
  assert.ok(helper.length > 0, 'queueForSession is gone; the idle enqueue has no honest door')
  assert.match(helper, /if \(nodeBusy\(live\) \|\| pendingModelChoice\(live\)\) return \{ ok: true, entry: queued\.entry, sentence: QUEUE_PANEL\.cardQueued \}/,
    'the helper no longer answers "it will wait" only when there is really a turn to wait behind')
  assert.match(helper, /void drainOutboxMessage\(live\.sessionId, live\.id, entry\)/,
    'an idle enqueue no longer reaches the one wire; the words park where only a turn completion drains')
  assert.match(helper, /QUEUE_PANEL\.cardQueuedIdle/, 'the idle enqueue no longer says that it went rather than waited')
  /* Both /queue doors and the composer's own busy send share the helper --
     a second bare outboxEnqueue is how one of them drifts back. */
  const configAt = view.indexOf('      queue: {')
  const config = view.slice(configAt, view.indexOf('      actions:', configAt))
  assert.equal((config.match(/queueForSession\(node, /g) || []).length, 2,
    "the composer's queue config stopped routing both its enqueue doors through the helper")
  assert.doesNotMatch(config, /outboxEnqueue\(/, 'the composer queue config enqueues around the helper again')
  const card = view.slice(view.indexOf('function treeCardSend(node, text'), view.indexOf('function stripPhantomYouLine'))
  assert.match(card, /const queued = queueForSession\(node, slash\.rest\)/,
    '/queue on the card path enqueues around the helper, so it can still park words at an idle agent')
})

test('an idle snapshot that loses to AGENT_TURN_ACTIVE queues and later paints at acceptance', () => {
  const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const send = view.slice(view.indexOf('function treeCardSend(node, text'), view.indexOf('function stripPhantomYouLine'))
  const active = send.slice(send.indexOf("code === 'AGENT_TURN_ACTIVE'"))
  assert.ok(active.length > 200, 'the active-turn boundary branch is absent')
  assert.match(active, /stripPhantomYouLine\(node, node\.sessionId, text\)/,
    'the refused direct send remains in the transcript as though it landed')
  assert.match(active, /queueForSession\(node, text\)/,
    'the person must type again after the host reports the turn is still active')
  assert.match(active, /typeof queued === 'function'/,
    'the component cannot distinguish a queued boundary race from a failed send')
  assert.doesNotMatch(active, /startRefusalSentence\(\{ ok: false, code \}\)[\s\S]*return/,
    'the active-turn branch still surfaces the generic nothing-started refusal')

  const drain = view.slice(view.indexOf('async function drainOutboxMessage'), view.indexOf('THE TREE\'S OWN EAR'))
  assert.match(drain, /broadcastOwnerMessage\(sessionId, entry\.text/,
    'an accepted queued turn still remains invisible in already-open chat surfaces')
})

/* THE WAY OUT HAS TO HAND THE WORDS BACK. Unqueue used to remove the row and
   leave the box empty, and the up-arrow recall walk only reaches entries still
   IN the queue -- so a message typed while the agent was busy was gone for
   good, for pressing the one door that offers to take it back. Measured
   natively on both surfaces before this was fixed.

   THE RULE, IN ONE SENTENCE: Unqueue fills the box with the waiting message
   when the box is empty, and when the box already holds a draft it keeps that
   draft byte for byte and says the unqueued words in the transcript instead,
   so neither text is ever lost.

   The two tests below are not two catches. The empty-box one is the real
   discriminator and fails on the unfixed base; the draft-in-box one passes
   there trivially, because the base never writes to the box at all, and is
   kept as a guard against this fix regressing into an overwrite. */
test('Unqueue returns the words to an empty box, and still sends nothing', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['words I want back'])
  const row = rows(fixture.root)[0]
  row.querySelector('.chat-queue-cancel').dispatch('click')

  assert.equal(fixture.input.value, 'words I want back',
    "Unqueue discarded the person's typed message instead of returning it")
  assert.deepEqual(rows(fixture.root).map(r => r.querySelector('.chat-queue-text').textContent), [],
    'the row is still removed')
  assert.deepEqual(fixture.state.sent, [], 'Unqueue sent the message it was asked to take back')
  fixture.root.dispose()
})

/* GUARD, not a discriminator (see the rule above): a draft already in the box
   belongs to the person too, and this file's own recall walk stashes a draft
   byte for byte rather than overwrite it, so trading one lost text for another
   would be the same defect wearing the other hat. */
test('Unqueue does not overwrite a draft the person already has in the box', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['words I want back'])
  fixture.input.value = 'a different draft'
  fixture.input.dispatch('input')
  rows(fixture.root)[0].querySelector('.chat-queue-cancel').dispatch('click')

  assert.equal(fixture.input.value, 'a different draft', "the person's draft was overwritten")
  assert.deepEqual(rows(fixture.root).map(r => r.querySelector('.chat-queue-text').textContent), [],
    'the row is still removed')
  assert.deepEqual(fixture.state.sent, [], 'Unqueue sent something')
  fixture.root.dispose()
})

/* ---- SEND NEXT SAYS THE REAL STATE (lane B item 3, 2026-09-19) ----
 *
 * A queued row is drawn at an IDLE agent too -- a refused resume, an ended
 * session -- and there "it goes the moment this turn finishes" named a turn
 * that did not exist. The label and the answer now come from the composer's
 * own busy reading. Asserted by value, both directions. */
const { sendNextLabel } = await import('../../src/chat-copy.js')
const { movedFrontSentence } = await import('../../src/fleet-tree-copy.js')

test('Send next names a running turn only while one runs, and "when the agent is back" otherwise', () => {
  assert.equal(sendNextLabel({ turnRunning: true }), QUEUE_SEND_NEXT_LABEL)
  assert.match(sendNextLabel({ turnRunning: true }), /this turn finishes/)
  assert.doesNotMatch(sendNextLabel({ turnRunning: false }), /this turn/)
  assert.doesNotMatch(sendNextLabel({}), /this turn/, 'an absent reading is not a running turn')
  assert.equal(movedFrontSentence({ turnRunning: true }), QUEUE_PANEL.movedFront)
  assert.doesNotMatch(movedFrontSentence({ turnRunning: false }), /this turn/)
  assert.doesNotMatch(movedFrontSentence({}), /this turn/)
})

test('the Send next door on a row at an idle agent does not promise a turn that is not running', () => {
  const fixture = mount({ busy: true })
  queueWhileBusy(fixture, ['alpha'])
  fixture.state.completeStop()
  const next = rows(fixture.root)[0].querySelector('.chat-queue-next')
  assert.ok(next, 'the row keeps its reorder door at an idle agent')
  assert.equal(next.getAttribute('aria-label'), sendNextLabel({ turnRunning: false }))
  assert.doesNotMatch(next.getAttribute('aria-label'), /this turn/)
})

// T1406: the message-box door painted the new message and then 'Interrupted.'
// under it, so the new message read as the one that was interrupted. Both
// doors now read the same way: the stop note, then the message that went.
test('Send now from the message box puts the stop note above the new message, as the queued row does', async () => {
  const turns = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
  for (const door of ['message box', 'queued row']) {
    const fixture = mount({ busy: true, holdStop: true, withHold: true })
    if (door === 'queued row') {
      queueWhileBusy(fixture, ['look at this picture'])
      rows(fixture.root)[0].querySelector('.chat-queue-now').dispatch('click')
    } else {
      fixture.input.value = 'look at this picture'
      fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
    }
    await turns()
    fixture.state.releaseStop()
    await turns()
    assert.deepEqual(fixture.state.sent, ['look at this picture'], `${door}: the message went`)
    const lines = fixture.root.querySelectorAll('.msg')
    const note = lines.findIndex(node => /\bnote\b/.test(node.className) && node.textContent.includes('stopped'))
    const mine = lines.findIndex(node => /\bme\b/.test(node.className) && node.textContent.includes('look at this picture'))
    assert.ok(note >= 0 && mine >= 0, `${door}: both the stop note and the message are shown`)
    assert.ok(note < mine, `${door}: the stop note sits above the message that was sent`)
    fixture.root.dispose()
  }
})

// T1426: Send now on a queued row was refused whenever the message box held a
// picture, with a note about "this message" that described the draft.
test('Send now on a queued row goes while the message box holds an unrelated picture draft, which stays', async () => {
  const attachment = { ok: true, path: 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp/draft-picture.png', size: 100 }
  const fixture = mount({ busy: true, holdStop: true, withHold: true, attachment })
  queueWhileBusy(fixture, ['older queued A', 'urgent B'])
  fixture.root.querySelector('[data-chat-attach]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.input.value = 'something else I am writing'
  const urgent = rows(fixture.root).find(row => row.textContent.includes('urgent B'))
  urgent.querySelector('.chat-queue-now').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fixture.state.stopped, 1, 'the row interrupts the running turn')
  fixture.state.releaseStop()
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(fixture.state.sent, ['urgent B'], 'the pressed row went now')
  assert.deepEqual(fixture.state.sentAttachments[0], [], 'the draft picture did not ride the row')
  assert.equal(fixture.input.value, 'something else I am writing', 'the draft stays in the box')
  assert.equal(fixture.root.querySelectorAll('.chat-attachment-chip').length, 1, 'the draft picture stays in the box')
  assert.deepEqual(fixture.words(), ['older queued A'], 'the other row is still waiting')
  assert.ok(!fixture.root.querySelectorAll('.msg').some(node => node.textContent.includes(QUEUE_PANEL.heldAttachment)), 'no refusal about the draft')
  fixture.root.dispose()
})

// T1419: closing the chat while Send now was stopping the agent exported an
// empty draft, put the words back in the queue as text only, and the picture
// was in neither place; the words later went without it.
test('closing a chat during Send now with a picture hands the words and the picture back together', async () => {
  const attachment = { ok: true, path: 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp/this-screenshot.png', size: 100 }
  const fixture = mount({ busy: true, holdStop: true, withHold: true, attachment })
  queueWhileBusy(fixture, ['first'])
  fixture.root.querySelector('[data-chat-attach]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  fixture.input.value = 'please look at THIS screenshot'
  fixture.input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fixture.state.stopped, 1, 'the stop is in flight')
  // What the Home and Full view windows do when they close: hand the draft on, then dispose.
  const handed = fixture.root.exportDraft({ handoff: true })
  fixture.root.dispose()
  fixture.state.releaseStop()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(handed.text, 'please look at THIS screenshot', 'the words are handed on')
  assert.deepEqual(handed.attachments.map(item => item.path), [attachment.path], 'with the picture')
  assert.deepEqual(fixture.words(), ['first'], 'the words are not left in the queue to go without the picture')
  assert.deepEqual(fixture.state.sent, [], 'nothing was sent')
  // The next chat opens with the whole message in the box.
  const next = mount({ busy: true })
  next.root.importDraft(handed)
  assert.equal(next.input.value, 'please look at THIS screenshot')
  assert.equal(next.root.querySelectorAll('.chat-attachment-chip').length, 1)
  next.root.dispose()
})
