/* THE UP-ARROW WALK, DRIVEN THROUGH THE MOUNTED COMPOSER — KEYBOARD ONLY.
 *
 * Owner, verbatim: "i like how in cmd you can press the up button and edit
 * your qued messages ... ca we let userrs press up from the chat to get to
 * their qued messages and edit them".
 *
 * tools/test/composer-queue-recall.test.mjs proves the walk's rules by calling
 * them with values. This proves the WIRING: real key events on the real
 * composer input, over a real session outbox, through the same `queue` closure
 * shape src/views/computers.js passes. Written because the rules and the
 * wiring fail separately -- a walk that is correct and unreachable is the same
 * screen as no walk at all, and the presses below are the only thing that can
 * tell the difference.
 *
 * It also pins the half nobody would notice until it cost them a message: a
 * composer with NO queue must leave ↑ ↓ Escape entirely to the browser, so
 * the sample surfaces and the agent page keep the caret behaviour they have.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn()

const { buildChat } = await import('../../src/components.js')
const {
  clearSession,
  enqueue,
  list: outboxList,
  replace: outboxReplace,
  cancel: outboxCancel,
} = await import('../../src/session-outbox.js')
const { RECALL_EDIT_NOT_KEPT, RECALL_EDIT_ALREADY_SENT } = await import('../../src/chat-copy.js')

const SID = 'session-test-composer-recall'

/* The composer as page 2 mounts it: a BUSY agent (so a typed send queues), the
   session outbox behind the queue closures, and a real sender that records
   anything that actually goes out. */
function mountBusyComposer(messages, { withReplace = true } = {}) {
  clearSession(SID)
  for (const message of messages) enqueue(SID, message)
  const sent = []
  const queueListeners = new Set()
  const chat = buildChat({
    title: 'Lane',
    status: { busy: () => true, step: () => '', subscribe: () => () => {} },
    queue: {
      list: () => outboxList(SID).map(entry => ({ id: entry.id, text: entry.text })),
      add: text => enqueue(SID, text),
      cancel: id => outboxCancel(SID, id),
      subscribe: listener => { queueListeners.add(listener); return () => queueListeners.delete(listener) },
      ...(withReplace ? { replace: (id, text) => outboxReplace(SID, id, text) } : {}),
    },
    onSend: text => { sent.push(text) },
  })
  document.body.appendChild(chat)
  const input = chat.querySelector('.chat-input input')
  const press = (key, extra = {}) => input.dispatch('keydown', { key, ...extra })
  return {
    chat,
    input,
    press,
    sent,
    // What the view does when its queue changes: tell the composer.
    queueChanged: () => { for (const listener of queueListeners) listener() },
    queued: () => outboxList(SID).map(entry => entry.text),
    strip: () => [...(chat.querySelector('.chat-queue-strip')?.children || [])]
      .map(row => row.querySelector('.chat-queue-text')?.textContent),
  }
}

test('↑ from the empty composer puts the most recent waiting message in the box', () => {
  const { input, press, strip } = mountBusyComposer(['first thing', 'second thing'])
  assert.deepEqual(strip(), ['first thing', 'second thing'], 'the strip is showing both before a key is pressed')

  const up = press('ArrowUp')
  assert.equal(up.defaultPrevented, true, 'the walk took the key, so the caret does not also jump')
  assert.equal(input.value, 'second thing')

  press('ArrowUp')
  assert.equal(input.value, 'first thing', 'the second press reaches the older one')
  press('ArrowUp')
  assert.equal(input.value, 'first thing', 'the oldest is the far end; it does not wrap round to the newest')
  clearSession(SID)
})

test('editing in the box and walking on rewrites that message where it waits', () => {
  const { input, press, queued, strip } = mountBusyComposer(['first thing', 'second thing'])
  press('ArrowUp')
  input.value = 'second thing, fixed'
  press('ArrowUp')

  assert.equal(input.value, 'first thing', 'the walk moved on')
  assert.deepEqual(queued(), ['first thing', 'second thing, fixed'],
    'the edit landed on the recalled message and kept its place in the queue')
  assert.deepEqual(strip(), ['first thing', 'second thing, fixed'],
    'and the strip repainted, so the person can see which copy is real')
  clearSession(SID)
})

test('↓ past the newest hands back what was being typed, and ends the walk', () => {
  const { input, press } = mountBusyComposer(['first thing', 'second thing'])
  input.value = '   '
  /* Entering the walk needs an empty box; whitespace is empty enough to walk
     from and is restored byte for byte, which is what proves it was stashed
     rather than assumed. */
  press('ArrowUp')
  assert.equal(input.value, 'second thing')
  press('ArrowUp')
  assert.equal(input.value, 'first thing')
  press('ArrowDown')
  assert.equal(input.value, 'second thing')

  const out = press('ArrowDown')
  assert.equal(out.defaultPrevented, true)
  assert.equal(input.value, '   ', 'the draft came back exactly as it was')

  const past = press('ArrowDown')
  assert.equal(past.defaultPrevented, undefined, 'the walk is over, so ↓ is the browser\'s key again')
  clearSession(SID)
})

test('Escape puts the draft back and keeps the rewrite', () => {
  const { input, press, queued } = mountBusyComposer(['first thing', 'second thing'])
  press('ArrowUp')
  input.value = 'second thing, fixed'
  const escape = press('Escape')
  assert.equal(escape.defaultPrevented, true)
  assert.equal(input.value, '', 'the box is back to the draft it started from')
  assert.deepEqual(queued(), ['first thing', 'second thing, fixed'],
    'Escape restores the draft; it does not throw away what was just rewritten')

  const second = press('Escape')
  assert.equal(second.defaultPrevented, undefined,
    'outside a walk Escape belongs to whatever else on the page uses it')
  clearSession(SID)
})

test('ONE LAYER PER PRESS: an Escape that ends a walk does not also reach the layer behind', () => {
  const { chat, input, press } = mountBusyComposer(['first thing'])
  const heardOutside = []
  /* The card, sheet or page the composer sits in. Escape reaching it in the
     same press is the measured press-through this file's sibling rule
     (onPopKeydown in src/components.js) exists to stop. */
  chat.addEventListener('keydown', event => { if (event.key === 'Escape') heardOutside.push(input.value) })

  press('ArrowUp')
  press('Escape')
  assert.deepEqual(heardOutside, [], 'the Escape that ended the walk went no further')

  press('Escape')
  assert.equal(heardOutside.length, 1, 'the NEXT Escape reaches the layer behind, as it always did')
  clearSession(SID)
})

test('⏎ and ⇧⏎ on a recalled message keep the edit and never queue a second copy', () => {
  const first = mountBusyComposer(['first thing', 'second thing'])
  first.press('ArrowUp')
  first.input.value = 'second thing, fixed'
  first.press('Enter')
  assert.deepEqual(first.queued(), ['first thing', 'second thing, fixed'], 'one copy, edited in place')
  assert.deepEqual(first.sent, [], 'and nothing was delivered into the running turn')
  assert.equal(first.input.value, '', 'the draft came back')
  clearSession(SID)

  /* ⇧⏎ is the door that steers the RUNNING turn. Taken while the box holds a
     message that is already waiting, it would send those words now AND again
     when the turn ends. */
  const second = mountBusyComposer(['first thing', 'second thing'])
  second.press('ArrowUp')
  second.input.value = 'second thing, fixed'
  second.press('Enter', { shiftKey: true })
  assert.deepEqual(second.queued(), ['first thing', 'second thing, fixed'])
  assert.deepEqual(second.sent, [], '⇧⏎ inside the walk must not deliver a message that is still queued')
  clearSession(SID)
})

test('the send BUTTON obeys the same rule as ⏎, because it reaches send() directly', () => {
  const { chat, input, press, queued, sent } = mountBusyComposer(['first thing', 'second thing'])
  press('ArrowUp')
  input.value = 'second thing, fixed'
  chat.querySelector('.chat-send').click()
  assert.deepEqual(queued(), ['first thing', 'second thing, fixed'])
  assert.deepEqual(sent, [], 'the button cannot be the one path that sends a duplicate')
  clearSession(SID)
})

test('a typed message still queues normally once the walk is over', () => {
  const { input, press, queued } = mountBusyComposer(['first thing'])
  press('ArrowUp')
  press('Escape')
  input.value = 'a genuinely new message'
  press('Enter')
  assert.deepEqual(queued(), ['first thing', 'a genuinely new message'],
    'the ordinary busy-send still queues; the walk did not leave the composer stuck')
  clearSession(SID)
})

test('words already in the box are safe: ↑ is declined and nothing is touched', () => {
  const { input, press, queued } = mountBusyComposer(['first thing'])
  input.value = 'half a thought'
  const up = press('ArrowUp')
  assert.equal(up.defaultPrevented, undefined, 'the key was left to the browser')
  assert.equal(input.value, 'half a thought', 'and the words are exactly where they were')
  assert.deepEqual(queued(), ['first thing'])
  clearSession(SID)
})

test('an edit the queue will not take is said out loud, not swallowed', () => {
  const { input, press, chat } = mountBusyComposer(['first thing'], { withReplace: false })
  press('ArrowUp')
  input.value = 'first thing, reworded'
  press('ArrowUp')
  const notes = [...chat.querySelector('.chat-log').children].map(row => row.textContent)
  assert.ok(notes.some(note => note.includes(RECALL_EDIT_NOT_KEPT)),
    'a queue with no replace must say the edit was not kept -- silence reads exactly like a save')
  clearSession(SID)
})

test('a composer with no queue leaves ↑ ↓ Escape entirely to the browser', () => {
  /* The sample surfaces and the agent page pass no queue at all. They must
     keep the caret behaviour they have today, with no branch of their own. */
  const chat = buildChat({ title: 'Lane', onSend: () => {} })
  document.body.appendChild(chat)
  const input = chat.querySelector('.chat-input input')
  input.value = ''
  for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) {
    assert.equal(input.dispatch('keydown', { key }).defaultPrevented, undefined,
      `${key} was swallowed by a composer that has no queue to walk`)
  }
})

// T1543: editing a recalled message while the turn ended sent the old text,
// said nothing, and Enter then sent the edit as a second message.
test('when the message being edited is sent as it was, the chat says so and Enter sends the edit as a new message', () => {
  const composer = mountBusyComposer(['fix the tpyo in README'])
  composer.press('ArrowUp')
  assert.equal(composer.input.value, 'fix the tpyo in README')
  composer.input.value = 'fix the typo in README'
  // The turn ends and the view's drain takes the front message, as it is.
  const [front] = outboxList(SID)
  outboxCancel(SID, front.id)
  composer.queueChanged()
  const notes = () => [...composer.chat.querySelectorAll('.msg')].filter(node => node.className.includes('note')).map(node => node.textContent)
  assert.ok(notes().some(text => text.includes(RECALL_EDIT_ALREADY_SENT)), 'the chat says the message went unchanged')
  assert.equal(composer.input.value, 'fix the typo in README', 'the edit stays in the box')
  composer.press('Enter')
  assert.deepEqual(composer.queued(), ['fix the typo in README'], 'Enter sends the edit as a new message, as the note said')
  assert.equal(notes().filter(text => text.includes(RECALL_EDIT_ALREADY_SENT)).length, 1, 'said once')
  composer.chat.dispose()
})

test('Unqueue on the message being edited is not reported as a send', () => {
  const composer = mountBusyComposer(['only message'])
  composer.press('ArrowUp')
  composer.chat.querySelector('.chat-queue-cancel').dispatch('click')
  composer.queueChanged()
  assert.ok(![...composer.chat.querySelectorAll('.msg')].some(node => node.textContent.includes(RECALL_EDIT_ALREADY_SENT)))
  composer.chat.dispose()
})
