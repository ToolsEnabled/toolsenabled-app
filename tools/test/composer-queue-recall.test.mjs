/* UP-ARROW REACHES THE MESSAGES STILL WAITING TO SEND, AND EDITING ONE KEEPS IT.
 *
 * Owner, verbatim: "i like how in cmd you can press the up button and edit
 * your qued messages. it might be a weird feature but ca we let userrs press
 * up from the chat to get to their qued messages and edit them" -- asked after
 * four messages were lost.
 *
 * These drive the real walk with real values against the real store
 * (src/session-outbox.js), not a description of the walk's source. Every
 * assertion below is a sentence a person would say about the keyboard: what Up
 * reaches, what Down goes back to, what an edit does to the queue, what Escape
 * puts back, and what happens at both ends. The two fakes at the bottom exist
 * for the two answers the real store cannot give -- a caller with no `replace`
 * at all, and a `replace` that refuses -- because a swallowed edit is the exact
 * defect this feature was built to end.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createQueueRecall } from '../../src/composer-queue-recall.js'
import { RECALL_EDIT_NOT_KEPT } from '../../src/chat-copy.js'
import {
  cancel as outboxCancel,
  clearSession,
  enqueue,
  list as outboxList,
  replace as outboxReplace,
} from '../../src/session-outbox.js'

const SID = 'session-test-queue-recall'

/* The composer's own wiring, verbatim in shape: buildChat hands the walk
   `queue.list` (id + text, oldest first) and `queue.replace`. */
function walkOverRealQueue(messages) {
  clearSession(SID)
  for (const message of messages) assert.equal(enqueue(SID, message).ok, true, `fixture: ${message} did not queue`)
  const recall = createQueueRecall({
    list: () => outboxList(SID).map(entry => ({ id: entry.id, text: entry.text })),
    replace: (id, text) => outboxReplace(SID, id, text),
  })
  return { recall, queued: () => outboxList(SID).map(entry => entry.text) }
}

test('Up from an empty box walks back, most recent first, and stops at the oldest', () => {
  const { recall } = walkOverRealQueue(['first thing', 'second thing', 'third thing'])

  assert.deepEqual(recall.up(''), { handled: true, text: 'third thing' }, 'the first Up reaches the most recent waiting message')
  assert.equal(recall.up('third thing').text, 'second thing')
  assert.equal(recall.up('second thing').text, 'first thing')

  /* THE FAR END DOES NOT WRAP. Wrapping would put the newest message under the
     key a person has been pressing to walk away from it. */
  const atOldest = recall.up('first thing')
  assert.equal(atOldest.handled, true, 'Up at the oldest is still this walk\'s key, not the browser\'s')
  assert.equal(atOldest.text, 'first thing', 'Up at the oldest stays there instead of wrapping to the newest')
  assert.equal(recall.up('first thing').text, 'first thing', 'and it keeps staying there')
  clearSession(SID)
})

test('Down walks forward, and past the newest it hands back what was being typed', () => {
  const { recall } = walkOverRealQueue(['first thing', 'second thing', 'third thing'])
  /* A draft of spaces, on purpose: it proves the restore hands back the exact
     characters that were in the box and not a hardcoded empty string. */
  recall.up('  ')
  recall.up('third thing')
  assert.equal(recall.up('second thing').text, 'first thing')

  assert.equal(recall.down('first thing').text, 'second thing')
  assert.equal(recall.down('second thing').text, 'third thing')
  const out = recall.down('third thing')
  assert.equal(out.handled, true)
  assert.equal(out.text, '  ', 'past the newest, the draft comes back byte for byte')
  assert.equal(recall.anchorId, null, 'and the walk has ended')

  assert.deepEqual(recall.down('  '), { handled: false }, 'Down outside a walk is not this walk\'s key')
  clearSession(SID)
})

test('editing a recalled message replaces it in the queue, in its own place', () => {
  const { recall, queued } = walkOverRealQueue(['first thing', 'second thing', 'third thing'])
  const idsBefore = outboxList(SID).map(entry => entry.id)

  recall.up('')                       // holds "third thing"
  recall.up('third thing')            // holds "second thing"
  const moved = recall.up('second thing, fixed')
  assert.equal(moved.text, 'first thing', 'the walk still moved on to the older message')
  assert.equal(moved.note, undefined, 'a kept edit says nothing; only a refused one speaks')

  assert.deepEqual(queued(), ['first thing', 'second thing, fixed', 'third thing'],
    'the edit landed on the message that was recalled and did NOT move to the back of the queue')
  assert.deepEqual(outboxList(SID).map(entry => entry.id), idsBefore,
    'the ids are unchanged, so the walk can still find where it is after a repaint')
  clearSession(SID)
})

test('a walk can come back and read its own edit', () => {
  const { recall } = walkOverRealQueue(['alpha', 'omega'])
  recall.up('')                        // holds "omega"
  recall.up('omega, reworded')         // commits, moves to "alpha"
  assert.equal(recall.down('alpha').text, 'omega, reworded',
    'walking back to an edited message shows the edited words, read from the queue')
  clearSession(SID)
})

test('Escape puts the draft back and still keeps the rewrite', () => {
  const { recall, queued } = walkOverRealQueue(['alpha', 'omega'])
  recall.up(' ')
  const escaped = recall.escape('omega, reworded')
  assert.equal(escaped.handled, true)
  assert.equal(escaped.text, ' ', 'Escape restores what was being typed')
  assert.equal(recall.anchorId, null, 'Escape ends the walk')
  assert.deepEqual(queued(), ['alpha', 'omega, reworded'],
    'Escape means "put my draft back", never "throw away what I just rewrote"')

  assert.deepEqual(recall.escape('anything'), { handled: false },
    'outside a walk, Escape belongs to whatever else on the page uses it')
  clearSession(SID)
})

test('Enter keeps the edit and never queues a second copy of the same message', () => {
  const { recall, queued } = walkOverRealQueue(['alpha', 'omega'])
  recall.up('')
  const submitted = recall.submit('omega, fixed')
  assert.equal(submitted.handled, true, 'Enter inside a walk is answered here, so the ordinary send never runs')
  assert.equal(submitted.text, '', 'the draft comes back')
  assert.deepEqual(queued(), ['alpha', 'omega, fixed'],
    'the message is edited where it waits -- one copy, not two')

  assert.deepEqual(recall.submit('a new message'), { handled: false },
    'outside a walk, Enter is the ordinary send')
  clearSession(SID)
})

test('words already in the box are never touched: Up declines and starts nothing', () => {
  const { recall, queued } = walkOverRealQueue(['alpha'])
  assert.deepEqual(recall.up('half a thought'), { handled: false },
    'Up with words in the box is not this walk\'s key, so the box and the caret are the browser\'s')
  assert.equal(recall.anchorId, null, 'and no walk was started behind the person\'s back')
  assert.deepEqual(queued(), ['alpha'], 'nothing was written to the queue either')
  clearSession(SID)
})

test('an empty queue declines the key, so nothing is swallowed for a walk that cannot happen', () => {
  clearSession(SID)
  const recall = createQueueRecall({
    list: () => outboxList(SID).map(entry => ({ id: entry.id, text: entry.text })),
    replace: (id, text) => outboxReplace(SID, id, text),
  })
  assert.deepEqual(recall.up(''), { handled: false })
  assert.deepEqual(recall.down(''), { handled: false })
  assert.deepEqual(recall.escape(''), { handled: false })
  assert.equal(recall.anchorId, null)
})

test('a composer with no queue at all has no walk, and says nothing about it', () => {
  const recall = createQueueRecall()
  assert.deepEqual(recall.up(''), { handled: false })
  assert.deepEqual(recall.down(''), { handled: false })
  assert.deepEqual(recall.escape(''), { handled: false })
  assert.deepEqual(recall.submit('words'), { handled: false })
})

test('emptying the box is not a way to delete a waiting message', () => {
  const { recall, queued } = walkOverRealQueue(['alpha', 'omega'])
  recall.up('')                 // holds "omega"
  const moved = recall.up('')   // walked away having cleared the box
  assert.equal(moved.text, 'alpha')
  assert.deepEqual(queued(), ['alpha', 'omega'],
    'a cleared box leaves the waiting message exactly as it was -- Unqueue is the one door out, and it says so on a button')
  clearSession(SID)
})

test('a message that leaves the queue mid-walk ends the walk and keeps what was typed', () => {
  const { recall, queued } = walkOverRealQueue(['alpha', 'omega'])
  recall.up('')
  const held = outboxList(SID).at(-1)
  assert.equal(outboxCancel(SID, held.id), true, 'the strip\'s Unqueue removed the message being edited')

  const answer = recall.up('omega, and a lot more besides')
  assert.equal(answer.handled, true)
  assert.equal(answer.text, 'omega, and a lot more besides',
    'the box is left exactly as it stands -- it is the only copy of what was just typed')
  assert.equal(recall.anchorId, null, 'and the walk stops rather than retargeting a different message')
  assert.deepEqual(queued(), ['alpha'], 'nothing was written over the message that is still waiting')
  clearSession(SID)
})

test('Enter on a message that has already gone falls through to the ordinary send', () => {
  const { recall } = walkOverRealQueue(['alpha', 'omega'])
  recall.up('')
  const held = outboxList(SID).at(-1)
  outboxCancel(SID, held.id)
  assert.deepEqual(recall.submit('omega, edited'), { handled: false },
    'the words in the box must still be sendable; refusing here would drop them on the floor')
  assert.equal(recall.anchorId, null)
  clearSession(SID)
})

/* ---- the two answers the real store cannot give ---- */

test('a queue with no replace gets the walk and says once that the edit was not kept', () => {
  const rows = [{ id: 'q1', text: 'alpha' }, { id: 'q2', text: 'omega' }]
  const recall = createQueueRecall({ list: () => rows })
  assert.equal(recall.up('').text, 'omega')
  const moved = recall.up('omega, reworded')
  assert.equal(moved.text, 'alpha', 'the walk still works; only the write is missing')
  assert.equal(moved.note, RECALL_EDIT_NOT_KEPT,
    'an edit that could not be written must name itself -- a silent swallow looks exactly like a save')
  assert.equal(rows[1].text, 'omega', 'and nothing was rewritten')
})

test('a refused replace is passed through in the words the refuser chose', () => {
  const refusal = 'A command is not a waiting message. Unqueue this one, then type the command in the box.'
  const rows = [{ id: 'q1', text: 'alpha' }]
  const recall = createQueueRecall({
    list: () => rows,
    replace: () => ({ ok: false, sentence: refusal }),
  })
  recall.up('')
  assert.equal(recall.escape('/interrupt').note, refusal,
    'the refusal reaches the person as written, not as a generic failure')
})

test('a replace that throws is a refusal with a sentence, never a lost edit reported as a save', () => {
  const rows = [{ id: 'q1', text: 'alpha' }]
  const recall = createQueueRecall({
    list: () => rows,
    replace: () => { throw new Error('store is gone') },
  })
  recall.up('')
  assert.equal(recall.escape('alpha, reworded').note, RECALL_EDIT_NOT_KEPT)
})

test('a list that throws leaves the keys to the browser instead of crashing the composer', () => {
  const recall = createQueueRecall({ list: () => { throw new Error('no store') } })
  assert.deepEqual(recall.up(''), { handled: false })
})
