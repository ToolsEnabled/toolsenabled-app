import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { treeSessionEventSource } from './lib/tree-session-event-source.mjs'
import { queuedMessageEditRefusal } from '../../src/slash-commands.js'

import {
  cancel,
  clearSession,
  confirmDelivered,
  enqueue,
  holdForSend,
  list,
  moveSession,
  replace,
  requeueFront,
  takeNext,
} from '../../src/session-outbox.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { PALETTE_PANEL, startRefusalSentence, sendFailureIsUnconfirmed } from '../../src/fleet-tree-copy.js'

/* The owner's queue: messages written while the agent is busy. The store is
   renderer memory modeled on write-outcomes.js; these pin its contract, and
   the last test pins the WIRING — one message drained per completed turn,
   refusals back at the front — because a store nothing drains is a text box
   that eats words. */

const SID = 'session-test-outbox'
function agentListenerBody(view) {
  return treeSessionEventSource(view).dispatcher
}
const previousStorage = globalThis.localStorage
const savedQueue = new Map()
globalThis.localStorage = {
  getItem: key => savedQueue.get(key) ?? null,
  setItem: (key, value) => savedQueue.set(key, String(value)),
  removeItem: key => savedQueue.delete(key),
}
test.after(() => {
  if (previousStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previousStorage
})

test('lossless session move refuses overflow without changing either queue or held delivery', () => {
  const from = 'lossless-source', to = 'lossless-destination'
  const held = holdForSend(from, { text: 'Source held words.' })
  for (let n = 0; n < 12; n++) assert.equal(enqueue(to, 'Destination ' + n).ok, true)
  const source = list(from), destination = list(to), saved = new Map(savedQueue)
  assert.throws(() => moveSession(from, to, { preserveAll: true }))
  assert.deepEqual(list(from), source)
  assert.deepEqual(list(to), destination)
  assert.deepEqual(savedQueue, saved, 'refusal must not persist a partial move')
  assert.equal(takeNext(from), null, 'the original Send now hold still owns its row')
  assert.equal(cancel(to, destination[0].id), true)
  assert.equal(moveSession(from, to, { preserveAll: true }), 1)
  assert.equal(held.take()?.id, held.entry.id)
  assert.equal(held.confirm(), true)
  assert.deepEqual(list(from), [])
  clearSession(to)
})

test('lossless session move counts outstanding seats and redirects only after a successful transfer', () => {
  const from = 'lossless-inflight-source', to = 'lossless-inflight-destination'
  assert.equal(enqueue(from, 'Unacknowledged source words.').ok, true)
  const taken = takeNext(from)
  for (let n = 0; n < 12; n++) assert.equal(enqueue(to, 'Destination ' + n).ok, true)
  const destination = list(to)
  assert.throws(() => moveSession(from, to, { preserveAll: true }))
  assert.deepEqual(list(to), destination)
  assert.equal(requeueFront(from, { ...taken, deliveryUnconfirmed: true }), true)
  assert.equal(list(from)[0].id, taken.id, 'failed transfer leaves the ticket at its source')
  assert.equal(cancel(to, destination[0].id), true)
  assert.equal(moveSession(from, to, { preserveAll: true }), 1)
  assert.equal(list(to).at(-1).id, taken.id)
  for (let n = 1; n < 12; n++) {
    const delivered = takeNext(to)
    assert.equal(delivered.id, destination[n].id)
    confirmDelivered(to, delivered)
  }
  assert.equal(takeNext(to), null, 'unknown delivery stays held after transfer')
  assert.equal(list(to)[0].id, taken.id)
  clearSession(to)
})

test('a Send now hold follows a resumed session and consumes the latest edit only once', () => {
  const from = 'outbox-hold-before-resume'
  const to = 'outbox-hold-after-resume'
  const held = holdForSend(from, { text: 'original text' })
  assert.equal(held.ok, true)
  assert.equal(takeNext(from), null)
  assert.equal(moveSession(from, to), 1)
  assert.equal(replace(to, held.entry.id, 'corrected text').ok, true)
  assert.equal(takeNext(to), null, 'the pending hold must move with the session')
  assert.equal(held.take()?.text, 'corrected text')
  assert.equal(held.take(), null, 'a second completion must not send the message again')
  assert.deepEqual(list(from), [])
  assert.equal(list(to)[0]?.deliveryUnconfirmed, true, 'taking a manual send keeps the words saved until acknowledgement')
  assert.equal(held.confirm(), true)
  assert.deepEqual(list(to), [])
})

test('a held Send now reserves its existing queue seat and excludes a second claimant', () => {
  const sid = 'outbox-hold-cap'
  for (let i = 0; i < 12; i += 1) enqueue(sid, `message ${i}`)
  const held = holdForSend(sid, { entryId: list(sid)[11].id })
  assert.equal(held.ok, true, 'promoting an existing message does not need another seat')
  assert.equal(enqueue(sid, 'overflow').ok, false)
  assert.equal(holdForSend(sid, { entryId: held.entry.id }).ok, false)
  assert.equal(holdForSend(sid, { entryId: list(sid)[1].id }).ok, false)
  held.release()
  const next = takeNext(sid)
  assert.equal(next?.text, 'message 11')
  confirmDelivered(sid, next)
  clearSession(sid)
})

test('Stop invalidates a pending hold without reviving its words when the interrupt settles', () => {
  const sid = 'outbox-hold-stop'
  const held = holdForSend(sid, { text: 'cancel with Stop' })
  assert.equal(clearSession(sid), 1)
  enqueue(sid, 'written after Stop')
  held.release()
  assert.equal(held.take(), null)
  const next = takeNext(sid)
  assert.equal(next?.text, 'written after Stop')
  confirmDelivered(sid, next)
})

test('a Send now hold refuses when its whole saved queue would overflow', () => {
  const sid = 'outbox-hold-envelope'
  const first = 'a'.repeat(20_000)
  enqueue(sid, first)
  const held = holdForSend(sid, { text: 'b'.repeat(45_000) })
  assert.equal(held.ok, false, 'fitting one message alone is not enough to promise the queued words are saved')
  assert.match(held.sentence, /cannot fit in the saved queue/)
  assert.deepEqual(list(sid).map(entry => entry.text), [first])
  clearSession(sid)
})

test('editing a pending hold cannot expand it beyond what can be saved', () => {
  const sid = 'outbox-hold-edit-envelope'
  const text = 'x'.repeat(5000) + 'END'
  const held = holdForSend(sid, { text })
  assert.equal(held.ok, true)
  const edited = replace(sid, held.entry.id, '"'.repeat(31_000))
  assert.equal(edited.ok, false)
  assert.equal(list(sid)[0].text, text)
  assert.equal(held.take()?.text, text)
  held.confirm()
})

test('a queue holds what was written, in order, and gives it back one at a time', () => {
  clearSession(SID)
  assert.equal(enqueue(SID, 'first').ok, true)
  assert.equal(enqueue(SID, '  second  ').ok, true)
  const held = list(SID)
  assert.equal(held.length, 2)
  assert.equal(held[1].text, 'second', 'text is trimmed, not rewritten')
  assert.ok(Object.isFrozen(held), 'the listing is frozen')
  assert.equal(takeNext(SID).text, 'first', 'oldest first — the order the person said it')
  assert.equal(takeNext(SID).text, 'second')
  assert.equal(takeNext(SID), null, 'an empty queue hands over nothing')
  /* Both taken entries are resolved before this test ends -- exactly as the
     real caller always does (drainOutboxMessage settles every take through
     requeueFront or confirmDelivered) -- so nothing is left checked out for
     the shared SID to hand a later test a stale reservation. Left unresolved,
     clearSession() at the top of the NEXT test sees a real-looking count and
     (correctly, for a genuine one) marks SID's next arriving refusal as
     nowhere to go; two takes this test itself abandoned are not that. */
  confirmDelivered(SID)
  confirmDelivered(SID)
})

test('refusals are sentences, and the bounds are real', () => {
  clearSession(SID)
  assert.equal(enqueue('', 'words').ok, false)
  assert.match(enqueue('', 'words').sentence, /Start it first/)
  assert.equal(enqueue(SID, '   ').ok, false)
  assert.match(enqueue(SID, '').sentence, /Write the message first/)
  const long = 'x'.repeat(5000)
  const bounded = enqueue(SID, long)
  assert.equal(bounded.ok, true)
  assert.equal(bounded.entry.text, long, 'queueing must keep the complete message the host can accept')
  const tooLong = enqueue(SID, 'x'.repeat(200_001))
  assert.equal(tooLong.ok, false, 'text past the host bound must be refused, never shortened')
  assert.match(tooLong.sentence, /longer than the agent can accept/)
  clearSession(SID)
  for (let i = 0; i < 12; i += 1) assert.equal(enqueue(SID, `m${i}`).ok, true)
  const overflow = enqueue(SID, 'one too many')
  assert.equal(overflow.ok, false)
  assert.match(overflow.sentence, /12 messages waiting/)
  clearSession(SID)
})

test('a message out for delivery still holds its seat in the cap — a refused delivery must not push the queue past MAX_PER_SESSION', () => {
  /* takeNext() removes an entry from the array the instant it hands it to a
     caller for delivery, so a queue sitting at the cap reads as one seat
     short of it for as long as that delivery is unresolved. enqueue()'s own
     check only ever read the array, so a message enqueued into that gap was
     admitted honestly (11 < 12) — and then requeueFront() put the original
     back on top of it when the delivery failed, for thirteen. Nothing after
     that point ever refuses again: the store's own stated bound
     ("a session holds a short queue") is not a guess a person can lean on
     once one failed delivery and one enqueue land in the same gap, and nothing
     stops the gap reopening on every later turn. */
  clearSession(SID)
  for (let i = 0; i < 12; i += 1) assert.equal(enqueue(SID, `m${i}`).ok, true)
  const taken = takeNext(SID)
  assert.equal(list(SID).length, 11, 'the array is one seat short of the cap while the eleventh message is out for delivery')
  const snuck = enqueue(SID, 'thirteenth')
  assert.equal(snuck.ok, false,
    'the cap must count the message currently out for delivery, or a refused delivery can carry the queue past its own stated limit')
  assert.equal(requeueFront(SID, taken), true)
  assert.ok(list(SID).length <= 12, `the queue holds ${list(SID).length} messages, past the cap enqueue() itself enforces`)
  clearSession(SID)
})

test('a delivered message releases the seat it held — the cap must not leak shut', () => {
  /* The other way a taken entry settles: it reaches the wire and never comes
     back. Nothing released its seat before confirmDelivered() existed, so
     every message a session ever successfully sent would have cost that
     session one seat of queue capacity forever. */
  clearSession(SID)
  for (let i = 0; i < 12; i += 1) assert.equal(enqueue(SID, `m${i}`).ok, true)
  const taken = takeNext(SID)
  assert.equal(enqueue(SID, 'refused while in flight').ok, false, 'the seat is still held during delivery')
  confirmDelivered(SID)
  const after = enqueue(SID, 'room again once delivered')
  assert.equal(after.ok, true, 'confirmDelivered() must free the seat once the taken entry is truly gone, not leave the cap one short')
  assert.equal(list(SID).length, 12)
  clearSession(SID)
})

test('a resume must not hand its destination back its own reserved seat a second time', () => {
  /* moveSession() is the resume door -- the same words, the same agent, a new
     session id -- and it enforces the cap with its own `.slice(0,
     MAX_PER_SESSION)` on the merged array, written before checkedOut existed
     and never brought up to date with enqueue()'s post-fix rule (array +
     reserved <= MAX_PER_SESSION). If the DESTINATION session already holds a
     reservation -- a delivery out for it, unresolved, at the exact moment a
     resume lands -- the array alone can still read as having room, and the
     merge fills it to the cap on top of the seat already held: reserved
     there, a full queue merged in on top of it, and the outstanding
     delivery's eventual refusal (requeueFront, same as any refused delivery)
     lands the array one past MAX_PER_SESSION. Same shape of bug as the one
     this file's cap-bypass test above pins for enqueue(); this is the sibling
     door the first fix did not reach. */
  const FROM = 'session-move-from'
  const TO = 'session-move-to'
  clearSession(FROM)
  clearSession(TO)
  assert.equal(enqueue(TO, 'already waiting').ok, true)
  const takenAtTo = takeNext(TO)
  assert.equal(list(TO).length, 0, 'the one message TO held is out for delivery, unresolved')
  for (let i = 0; i < 12; i += 1) assert.equal(enqueue(FROM, `from${i}`).ok, true)
  const moved = moveSession(FROM, TO)
  assert.equal(moved, list(TO).length, 'the reported count must match what the array actually holds — never a silent over-claim')
  assert.ok(list(TO).length + 1 <= 12,
    `moveSession left ${list(TO).length} in the array on top of a seat already reserved -- ${list(TO).length + 1} total, past the cap`)
  assert.equal(requeueFront(TO, takenAtTo), true)
  assert.ok(list(TO).length <= 12, `TO holds ${list(TO).length} messages after the outstanding delivery was refused -- past MAX_PER_SESSION`)
  clearSession(FROM)
  clearSession(TO)
})

test('a stopped session leaves no phantom reservation for whatever holds its id next', () => {
  /* clearSession() is Stop and start-over: the words really have nowhere to
     go, and checkedOut.delete() beside the queue wipe is what keeps a
     reservation for an in-flight delivery that will never settle (the
     session is gone; nothing will ever call confirmDelivered() or
     requeueFront() for it again) from sitting in the Map forever. Nothing
     else in this store ever cleans that entry up, so this is the one place a
     take that never resolves stops costing capacity -- proven the same way
     the cap-bypass test above proves enqueue()'s bound: fill the cap back up
     under the same id and check every seat is really open. */
  const SID = 'session-clear-hygiene'
  clearSession(SID)
  assert.equal(enqueue(SID, 'only message').ok, true)
  takeNext(SID)
  clearSession(SID)
  for (let i = 0; i < 12; i += 1) {
    assert.equal(enqueue(SID, `fresh${i}`).ok, true, `message ${i} was refused — a reservation clearSession should have wiped is still held`)
  }
  assert.equal(list(SID).length, 12)
  clearSession(SID)
})

test('a resume carries an in-flight delivery to the new session, even when nothing is left waiting in the array', () => {
  /* takeNext() removes the entry from `queues` the instant it hands it out
     for delivery (see checkedOut) -- so a session with exactly one message
     out for delivery and nothing else waiting has an EMPTY array at the exact
     moment a resume can land on it. moveSession() used to read that empty
     array as "nothing to move" and return without touching the reservation at
     all: the seat stayed held under the OLD id, which every other map in the
     view (sessionNodeIds, the tree node's own sessionId) has by then already
     forgotten. When that delivery was later refused, requeueFront() rebuilt a
     queue from nothing under that abandoned id -- reachable by no list() or
     takeNext() call this store's only caller will ever make again. The words
     the composer promised would "send by itself" instead stopped existing
     anywhere a person or this store could reach them. */
  const FROM = 'session-inflight-move-from'
  const TO = 'session-inflight-move-to'
  clearSession(FROM)
  clearSession(TO)
  assert.equal(enqueue(FROM, 'only message').ok, true)
  const taken = takeNext(FROM)
  assert.equal(list(FROM).length, 0, 'the one message FROM held is out for delivery, unresolved')
  moveSession(FROM, TO)
  assert.equal(requeueFront(FROM, taken), true, 'the delivery, taken under the OLD id, is refused after the resume already landed')
  assert.deepEqual(list(TO).map(entry => entry.text), ['only message'],
    'the words are still addressed to the same agent -- they must show up under the session it resumed into')
  assert.equal(list(FROM).length, 0,
    'the old session id is abandoned; nothing must ever again be queued where no list() or takeNext() call will ever find it')
  clearSession(FROM)
  clearSession(TO)
})

test('a stopped session drops an in-flight delivery instead of resurrecting a queue under its dead id', () => {
  /* clearSession() is Stop: "these words have nowhere to go" is the stated
     reason it drops the array outright. An entry already taken for delivery
     at the moment Stop lands is not IN that array (takeNext() already removed
     it) but it is exactly as addressed to a session that no longer exists --
     so its eventual refusal must find nowhere too, the same as everything
     Stop already dropped, rather than requeueFront() reviving a queue under
     an id this store itself just discarded. */
  const SID = 'session-inflight-stop'
  clearSession(SID)
  assert.equal(enqueue(SID, 'only message').ok, true)
  const taken = takeNext(SID)
  assert.equal(clearSession(SID), 0, 'the array Stop can see is already empty -- the one message is out for delivery')
  assert.equal(requeueFront(SID, taken), false,
    'Stop already said these words have nowhere to go; a later refusal must not quietly reopen an address for them')
  assert.equal(list(SID).length, 0, 'refusing the resurrection must not itself create a queue where nothing reads it')
  clearSession(SID)
})

test('a resume redirects EVERY outstanding delivery under the old id, not just whichever resolves first', () => {
  /* checkedOut is named and typed as a COUNT -- "how many taken entries are
     still out for delivery, unresolved" -- specifically because more than one
     can be outstanding for the same session at once: queueForSession() takes
     and drains a message the instant it lands on an idle node, and nothing in
     this store or its one caller stops a second message from being queued
     (and itself taken, idle-fast) before the first take's bridge.send() round
     trip has resolved. computers.js only flips a node to 'running' inside that
     first call's OWN .then() -- nodeBusy() reads false for the whole span in
     between, so a second queueForSession() landing in that window takes a
     second entry under the exact same session id while the first is still
     unresolved.
     deliveryRedirect carries only ONE hop per old id, and resolveDeliveryTarget()
     deletes that hop the moment ANY call consults it -- the first of the two
     outstanding deliveries to resolve. The second, resolving after it, finds no
     hop left: resolveDeliveryTarget() returns the OLD id unchanged (not the
     resume's destination), and requeueFront() -- reading that as a live
     session, not a drop -- rebuilds a queue under the abandoned id all over
     again. This is the exact defect deliveryRedirect exists to remove,
     reopened by the second-in-line delivery instead of the first. */
  const FROM = 'session-double-take-from'
  const TO = 'session-double-take-to'
  clearSession(FROM)
  clearSession(TO)
  assert.equal(enqueue(FROM, 'first').ok, true)
  assert.equal(enqueue(FROM, 'second').ok, true)
  const takenFirst = takeNext(FROM)
  const takenSecond = takeNext(FROM)
  assert.equal(takenFirst.text, 'first')
  assert.equal(takenSecond.text, 'second')
  assert.equal(list(FROM).length, 0, 'both messages are out for delivery, unresolved, at the moment the resume lands')
  moveSession(FROM, TO)
  /* The FIRST of the two outstanding deliveries settles -- successfully. */
  confirmDelivered(FROM)
  /* The SECOND, taken under the very same FROM id, settles after it -- with a
     refusal, so it must come back to TO exactly as the first would have. */
  requeueFront(FROM, takenSecond)
  assert.deepEqual(list(TO).map(entry => entry.text), ['second'],
    'the second outstanding delivery belongs on TO, same as the first -- not lost, and not readdressed to the abandoned FROM id')
  assert.equal(list(FROM).length, 0,
    'the abandoned FROM id must not grow a phantom queue nothing will ever read, no matter which of two outstanding deliveries resolves last')
  clearSession(FROM)
  clearSession(TO)
})

test('a Stop drops EVERY outstanding delivery under the old id, not just whichever resolves first', () => {
  /* The clearSession() (Stop) half of the same gap: two takes outstanding
     under one session, a Stop lands, and both must find "nowhere to go" --
     not just the first one to ask. */
  const SID = 'session-double-take-stop'
  clearSession(SID)
  assert.equal(enqueue(SID, 'first').ok, true)
  assert.equal(enqueue(SID, 'second').ok, true)
  const takenFirst = takeNext(SID)
  const takenSecond = takeNext(SID)
  assert.equal(clearSession(SID), 0, 'the array Stop can see is already empty -- both messages are out for delivery')
  assert.equal(requeueFront(SID, takenFirst), false, 'the first outstanding delivery has nowhere to go')
  assert.equal(requeueFront(SID, takenSecond), false,
    'the second outstanding delivery has nowhere to go either -- Stop dropped the whole session, not just the first delivery to ask')
  assert.equal(list(SID).length, 0, 'refusing the resurrection must not itself create a queue where nothing reads it')
  clearSession(SID)
})

test('a chain of two resumes before either of two outstanding deliveries settles still lands both on the final id', () => {
  /* A person can resume the same circle twice in a row before a slow delivery
     from before the FIRST resume ever answers -- moveSession() does not wait
     on checkedOut to drain, by design (see deliveryRedirect above). This pins
     the chain the file's own comment claims: A's hop points to B, B's hop
     (once B is itself moved before A's redirected deliveries are resolved)
     points to C, and resolving from A must walk both hops to C -- for BOTH
     of the two outstanding deliveries, in whichever order they settle, not
     just the first. */
  const A = 'session-chain-a'
  const B = 'session-chain-b'
  const C = 'session-chain-c'
  clearSession(A)
  clearSession(B)
  clearSession(C)
  assert.equal(enqueue(A, 'first').ok, true)
  assert.equal(enqueue(A, 'second').ok, true)
  const takenFirst = takeNext(A)
  const takenSecond = takeNext(A)
  moveSession(A, B)
  moveSession(B, C)
  assert.equal(requeueFront(A, takenFirst), true)
  assert.equal(requeueFront(A, takenSecond), true)
  assert.deepEqual(list(C).map(entry => entry.text).sort(), ['first', 'second'],
    'both deliveries, taken under A and redirected through B, must land on C -- the id the session actually resumed to last')
  assert.equal(list(A).length, 0, 'the first abandoned id must not grow a phantom queue')
  assert.equal(list(B).length, 0, 'the intermediate abandoned id must not grow one either')
  clearSession(A)
  clearSession(B)
  clearSession(C)
})

test('unqueue removes exactly the named message; a refused send goes back to the FRONT', () => {
  clearSession(SID)
  const a = enqueue(SID, 'alpha').entry
  enqueue(SID, 'beta')
  assert.equal(cancel(SID, a.id), true)
  assert.equal(list(SID)[0].text, 'beta')
  assert.equal(cancel(SID, 'ob-nope'), false, 'absence is not success')
  const taken = takeNext(SID)
  assert.equal(requeueFront(SID, taken), true)
  assert.equal(list(SID)[0].text, 'beta', 'the refused send is still the next thing the person said')
  assert.equal(clearSession(SID), 1)
  assert.equal(list(SID).length, 0)
})

test('an edit rewrites one waiting message WITHOUT moving it or renaming it', () => {
  /* The up-arrow walk's write (src/composer-queue-recall.js). Position and id
     are the two things it must not change: cancel+enqueue would send a
     corrected FIRST message LAST, and a new id would look to the walk exactly
     like the message having been drained out from under it. */
  clearSession(SID)
  const alpha = enqueue(SID, 'alpha').entry
  enqueue(SID, 'beta')
  enqueue(SID, 'gamma')

  const edited = replace(SID, alpha.id, '  alpha, fixed  ')
  assert.equal(edited.ok, true)
  assert.equal(edited.entry.id, alpha.id, 'the entry keeps its id')
  assert.equal(edited.entry.text, 'alpha, fixed', 'text is trimmed, not rewritten')
  assert.deepEqual(list(SID).map(entry => entry.text), ['alpha, fixed', 'beta', 'gamma'],
    'the edited message stayed where the person put it')
  assert.equal(takeNext(SID).text, 'alpha, fixed', 'and it is still the next one to send')
  /* Resolved before clearSession(), same reason as the first test in this
     file: an unresolved take at clear time is indistinguishable, to
     clearSession(), from a real refusal still on its way back for the
     shared SID -- see that test's own note. */
  confirmDelivered(SID)
  clearSession(SID)
})

test('an edit refuses by name; it is never a second, silent way to delete', () => {
  clearSession(SID)
  const only = enqueue(SID, 'alpha').entry

  assert.equal(replace('', only.id, 'words').ok, false)
  assert.match(replace('', only.id, 'words').sentence, /Start it first/)
  assert.equal(replace(SID, only.id, '   ').ok, false)
  assert.match(replace(SID, only.id, '').sentence, /Write the message first/,
    'an emptied box is a refusal with a sentence -- Unqueue is the one door out, and it says so on a button')
  assert.equal(replace(SID, 'ob-nope', 'words').ok, false)
  assert.match(replace(SID, 'ob-nope', 'words').sentence, /no longer waiting/,
    '"could not find it" and "wrote it" are different answers')
  assert.deepEqual(list(SID).map(entry => entry.text), ['alpha'], 'every refusal left the queue exactly as it was')

  assert.equal(replace(SID, only.id, 'x'.repeat(5000)).entry.text.length, 5000,
    'an edit must keep every character the host can accept')
  assert.equal(replace(SID, only.id, 'x'.repeat(200_001)).ok, false)
  assert.equal(list(SID)[0].text.length, 5000, 'an oversized refused edit keeps the previous text intact')
  clearSession(SID)
})

test("the view's queue.replace parses commands BEFORE it writes, like the other two doors", () => {
  // Execute the real queue.replace closure with the real command parser.
  // Its session reader and write sink are explicit seams, not a second
  // implementation of the edit guard. Source offsets come from the parser,
  // so an earlier, unrelated subscribe property cannot truncate this proof.
  const ROOT = resolve(import.meta.dirname, '..', '..')
  const view = readFileSync(resolve(ROOT, 'src/views/computers.js'), 'utf8')
  const config = declaredFunctionSource(view, 'treeChatConfigFor')
  const edits = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Property' && node.key?.name === 'replace') edits.push(node.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(config))
  assert.equal(edits.length, 1, 'the shared chat config must have one maintained queue edit binding')
  const writes = []
  const edit = new Function('queuedMessageEditRefusal', 'outboxReplace', 'liveSessionId',
    `return (${config.slice(edits[0].start, edits[0].end)})`)(queuedMessageEditRefusal,
    (...args) => { writes.push(args); return { ok: true } }, () => 'current-session')
  for (const command of ['/goal Do work', '/RequestTree Keep this rule', '/interrupt']) {
    assert.equal(edit('queued-id', command).ok, false)
    assert.deepEqual(writes, [], 'a command edit must never reach the write sink')
  }
  assert.deepEqual(edit('queued-id', 'Revised queued words'), { ok: true })
  assert.deepEqual(writes, [['current-session', 'queued-id', 'Revised queued words']])
})

test('the palette holds only real actions, and says what it cannot do in words', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..')
  const view = readFileSync(resolve(ROOT, 'src/views/computers.js'), 'utf8')
  /* The unsupported set lives in ONE footer sentence, never as controls.
     Model switching graduated when the per-turn wire landed; rewind graduated
     when tools/agent-rewind-probe.mjs PROVED the fork semantics live
     (2026-08-14: the fork remembered turns 1-2 and had forgotten turn 3). A
     footer that still called either impossible would now be the lie. */
  /* The palette re-homed into the chat composer's popup (iteration 6, owner:
     actions are "a button on the chat", not a page). chatActionRowsFor is
     the row source, runPaletteAction stays the verb engine, and the honest
     footer rides into the popup as its actionsNote. */
  const palette = view.slice(view.indexOf('function chatActionRowsFor'), view.indexOf('async function resumeNodeSession'))
  assert.ok(palette.length > 200, 'the chat action rows left computers.js')
  assert.match(PALETTE_PANEL.footer, /Not possible yet, so not listed/, 'the honest footer sentence is gone')
  assert.ok(!/changing the model/.test(PALETTE_PANEL.footer), 'the footer still calls model switching impossible — it shipped')
  assert.ok(!/rewinding/.test(PALETTE_PANEL.footer), 'the footer still calls rewind impossible — the probe proved it and the control shipped')
  assert.match(view, /actionsNote: PALETTE_PANEL\.footer/, 'the popup no longer shows the honest footer')
  /* Every action id must keep a handler branch in the verb engine — including
     every row that graduated out of the footer. */
  for (const id of ['interrupt', 'stop', 'child', 'queue', 'move', 'copy-brief', 'copy-reply', 'switch-model', 'attach', 'mention', 'clear', 'rewind']) {
    assert.ok(view.includes(`'${id}'`), `palette action ${id} lost its binding`)
  }
  /* Rewind's binding must be REAL: the popup stage lists the person's own
     turns and performRewind reaches the rewind channel. */
  assert.match(palette, /rewindRows/, 'the rewind stage left the popup')
  assert.match(view, /bridge\.rewind\(\{ sessionId: node\.sessionId, turnId \}\)/, 'the rewind flow no longer reaches the channel')
  /* The graduated rows must be REAL: the model stage writes the override
     every send reads. */
  assert.match(palette, /modelRows/, 'the model stage left the popup')
  assert.match(view, /sessionModelOverride/, 'the model override map is gone — the menu would be decoration')
  assert.match(view, /pickAttachment/, 'the attach action no longer reaches the picker')
  assert.match(view, /pickMention/, 'the mention action no longer reaches the picker')
  const components = readFileSync(resolve(ROOT, 'src/components.js'), 'utf8')
  assert.match(components, /data-chat-actions/, 'the composer lost its actions button — the popup has no door')
})

test('the compact card is real-sourced or absent, never the simulator', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..')
  const graph = readFileSync(resolve(ROOT, 'src/tree-graph.js'), 'utf8')
  const view = readFileSync(resolve(ROOT, 'src/views/computers.js'), 'utf8')
  /* The card exists only when the view vouches for a real onSend — that is
     what makes buildChat's seeded/canned path unreachable. No config → the
     chip routes to the rail. The shelf keeps independent conversations;
     tree-graph.test.mjs drives openChat and checks each card retains its draft. */
  /* SLICED BY STRUCTURE, NOT BY A CHARACTER COUNT. This read
     `graph.slice(start, start + 2200)`, and a comment added inside the branch
     pushed `seed: 0` past 2200 -- so the suite reported "the tree card seeds
     fake history again" about code that does no such thing. A window measured
     in bytes fails on prose. The branch ends where the next method begins. */
  const start = graph.indexOf('if (record.agent.treeNode)')
  const branch = graph.slice(start, graph.indexOf('  _openChatCard(record'))
  /* EITHER a real send path, OR a stated reason it cannot send -- both make
     buildChat's seeded reply unreachable (composerReason refuses `send`
     outright). A config with neither still falls back to the rail. */
  assert.match(branch, /typeof config\.onSend !== 'function' && !config\.composerReason/, 'a card can open without a real send path')
  assert.match(branch, /onOpenControls\?\.\(record\.agent\)/, 'a source-less chip no longer falls back to the rail')
  assert.match(branch, /seed: 0/, 'the tree card seeds fake history again')
  assert.match(branch, /this\._openChatCard\(record,/, 'the honest tree config never reaches its conversation card')
  assert.doesNotMatch(branch, /closeChat\(other\)/, 'opening one conversation must preserve the other open conversations and their drafts')
  /* The turn-completed branch delivers the card reply before draining. */
  const turn = agentListenerBody(view)
  assert.ok(turn.indexOf('deliverTurnReply(sessionId,') < turn.indexOf('outboxTakeNext(sessionId)'),
    'the card reply is delivered after the drain — the queued send would steal the turn')
})


test('T731 compact card registers its reply before a fast send and queues busy messages', async () => {
  const { withResearchTreeBinding } = await import('../../src/research-tree-session.js')
  const source = readFileSync(resolve(import.meta.dirname, '../../src/views/computers.js'), 'utf8')
  const queued = [], wire = [], replies = [], failures = []
  let busy = false, registered = null
  const node = { id: 'card-fixture', sessionId: 'card-session' }
  const values = {
    notePersonSpokeTo() {}, treeStore: { setNodeStatus() {} }, parseSlashCommand: () => null,
    nodeBusy: () => busy, pendingModelChoice: () => null,
    outboxEnqueue: (sessionId, text) => { queued.push({ sessionId, text }); return { ok: true, sentence: 'Queued' } },
    window: { mcAgent: { send: async request => {
      assert.equal(typeof registered, 'function', 'the fast reply must already have its consumer')
      wire.push(request)
      registered('Fast reply')
      return { turnId: 'fast-turn' }
    } } },
    awaitTurnReply: (_sessionId, reply) => { registered = reply },
    transcriptAppend() {}, sessionModelOverride: new Map(), sessionPendingImages: new Map(),
    withResearchTreeBinding, destroyed: false, turnLogAppend() {},
    sessionCompletedTurnIds: new Map(), refreshTree() {}, dropTurnReply() {},
    refusalCode: error => error.code, queuedSendRefusalSentence: () => 'Unexpected send refusal',
    sendFailureIsUnconfirmed: () => true,
  }
  const send = new Function(...Object.keys(values), declaredFunctionSource(source, 'treeCardSend') + '\nreturn treeCardSend')(...Object.values(values))
  const callbacks = { reply: text => replies.push(text), fail: error => failures.push(error) }
  send(node, 'Idle message', callbacks)
  await new Promise(setImmediate)
  assert.deepEqual(wire.map(row => row.text), ['Idle message'])
  assert.deepEqual(replies, ['Fast reply'])
  assert.deepEqual(failures, [])
  busy = true
  send(node, 'Busy message', callbacks)
  await new Promise(setImmediate)
  assert.deepEqual(queued, [{ sessionId: node.sessionId, text: 'Busy message' }])
  assert.equal(wire.length, 1, 'busy text stays queued rather than racing the current turn')
})

test('a send to a session from an earlier run refuses truthfully, not with a retry', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..')
  /* Trees are saved on this computer; sessions die with the app. A card send
     to a node from an earlier run must not say "Try once more" -- retrying a
     dead session is the one move that can never work. That takes two links:
     the shell must throw its CODE as the message (own properties are stripped
     at the IPC boundary), and the tree copy must own a sentence for it. */
  const shell = readFileSync(resolve(ROOT, 'shell/main.cjs'), 'utf8')
  /* The handler bodies -- and the renderer-safe rethrow inside them -- moved to
     shell/agent-command-surface.cjs in the command-surface extraction. The
     wrapper in main.cjs returns the surface's promise untouched, so what the
     surface throws is what crosses the boundary; the pin reads the surface. */
  const surface = readFileSync(resolve(ROOT, 'shell/agent-command-surface.cjs'), 'utf8')
  for (const channel of ['mc-agent:send', 'mc-agent:interrupt', 'mc-agent:close']) {
    const command = channel.replace('mc-', '')
    const wrapper = shell.slice(shell.indexOf(`ipcMain.handle('${channel}'`))
    assert.match(wrapper.slice(0, wrapper.indexOf('\n})') + 3), new RegExp(`return getAgentCommandSurface\\(\\)\\.run\\('${command}'`),
      `${channel} does not return the shared surface's answer untouched`)
    const at = surface.indexOf(`'${command}': async`)
    assert.ok(at >= 0, `${command} left the surface`)
    /* The body ends at the next command key. */
    const rest = surface.slice(at + 1)
    const next = rest.search(/\n    '(agent|org):[a-z-]+': async/)
    const body = next === -1 ? surface.slice(at) : surface.slice(at, at + 1 + next)
    assert.match(body, /rendererSafeAgentError/,
      `${channel} throws raw errors across the IPC boundary -- the code is stripped and the message may name paths`)
  }
  /* The renderer round-trip, run for real: the code survives extraction and
     lands on the sentence that says what actually happened. */
  const code = refusalCode(new Error('MC_AGENT_UNKNOWN_SESSION'))
  assert.equal(code, 'MC_AGENT_UNKNOWN_SESSION', 'the code no longer survives the message-is-the-code channel')
  const sentence = startRefusalSentence({ ok: false, code })
  assert.match(sentence, /Start a new agent/, 'the dead-session refusal lost its next move')
  assert.ok(!/[Tt]ry once more|[Tt]ry again/.test(sentence), 'the dead-session refusal advises a retry that cannot work')
})

test('the view drains one message per completed turn, and requeues on refusal', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..')
  const view = readFileSync(resolve(ROOT, 'src/views/computers.js'), 'utf8')
  const turnBranch = agentListenerBody(view)
  const statusCheck = turnBranch.indexOf('sessionTurnStatus(packet, sessionId)')
  const drain = turnBranch.indexOf('outboxTakeNext(sessionId)')
  assert.ok(statusCheck !== -1 && drain > statusCheck,
    'the drain left the turn-completed branch — the queue has no honest trigger anywhere else')
  assert.equal((turnBranch.match(/outboxTakeNext\(sessionId\)/g) || []).length, 1,
    'exactly one drain site in the listener; a second would race the first')
  const guard = turnBranch.match(/if \(([^\n]+)\) \{\s*const queuedNext = outboxTakeNext\(sessionId\)/)
  assert.ok(guard, 'the one drain must be guarded by turn and custody state')
  const mayDrain = new Function('userStopped', 'isHistoricalReplay', 'nativeReplayIdle', 'succeeded', 'nodeReplacementFlight', 'nodeId', `return (${guard[1]})`)
  for (const stopped of [false, true]) for (const historical of [false, true]) {
    for (const idle of [false, true]) for (const succeeded of [false, true]) for (const replacing of [false, true]) {
      assert.equal(mayDrain(stopped, historical, idle, succeeded, { busy: () => replacing }, 'node'),
        !stopped && !replacing && (!historical || (idle && succeeded)),
        'Stop/replacement always hold the queue; replay drains only a host-confirmed idle successful native turn')
    }
  }
  const replayCapture = turnBranch.indexOf('const isHistoricalReplay = replayingRemoteHistory')
  const firstYield = turnBranch.indexOf('await ')
  assert.ok(replayCapture >= 0 && firstYield > replayCapture,
    'historical provenance must be captured before a pending interrupt yields')
  const drainer = view.slice(view.indexOf('async function drainOutboxMessage'))
  /* BOTH DOORS OUT OF A FAILED DELIVERY PUT THE WORDS BACK AT THE FRONT, AND
     BOTH NOW SAY WHY. The pin used to be the single literal
     `outboxRequeueFront(sessionId, entry)`. The entry carries heldReason (and
     deliveryUnconfirmed when the transport never answered) so the strip can
     name the reason it came back, which changed the spelling but not the
     property. Pinned on both call sites rather than one literal, and on the
     reason as well as the requeue, so this is a tighter pin than it replaces. */
  const head = drainer.slice(0, 2600)
  assert.match(head, /outboxRequeueFront\(sessionId, \{ \.\.\.entry, heldReason: '[A-Z_]+' \}\)/,
    'the no-bridge door no longer returns the words to the front of the queue with a reason')
  assert.match(head, /outboxRequeueFront\(sessionId, \{\s*\.\.\.entry,[\s\S]{0,240}?heldReason: code/,
    'a refused drained send no longer returns to the front of the queue, or no longer records why it came back')
  /* The visible strip lives in the chat composer now (iteration 6: "a little
     preview of it waiting to be sent"): the component renders it, the view
     feeds it through the queue config, and the outbox event finally has its
     subscriber so every surface repaints on every change. */
  const components = readFileSync(resolve(ROOT, 'src/components.js'), 'utf8')
  assert.match(components, /chat-queue-strip/, 'the queue lost its visible strip; a store nobody sees eats words')
  assert.match(view, /window\.addEventListener\(SESSION_OUTBOX_EVENT/, 'nothing subscribes to the outbox event; the strip goes stale')
})

/* A STOP ANSWERS FOR THE DELIVERIES IT STOPPED, AND FOR NO LATER ONE.
   Measured on live 3c5ad80: queue a message, let the view take it, press Stop
   while that delivery is still on the wire, and let the delivery never answer
   (an answer lost to a window reload is the ordinary case on this machine).
   The next message the person wrote was taken, refused, and then DELETED --
   requeueFront returned false and the queue came back empty -- because the
   store recorded the Stop against the session id with a count instead of
   against the deliveries that were actually outstanding. The owner's words
   for it: "i still dont think my que and halt and send now ever got fixed ...
   things get deleted". Each test below takes its own session id, because the
   store is module memory and a queue left dirty by one test is exactly the
   confusion these tests exist to rule out. */
test('a Stop taken while one message is out for delivery does not swallow the next message the person writes', () => {
  const sid = 'session-test-stop-then-write'
  clearSession(sid)
  assert.equal(enqueue(sid, 'before the stop').ok, true)
  const stopped = takeNext(sid)
  assert.equal(stopped.text, 'before the stop')

  /* Stop, with that delivery still unresolved, and it stays unresolved. */
  clearSession(sid)

  assert.equal(enqueue(sid, 'after the stop').ok, true, 'a stopped session still takes new words')
  const written = takeNext(sid)
  assert.equal(written.text, 'after the stop')

  assert.equal(requeueFront(sid, written), true,
    'a refused send written AFTER the Stop is still the next thing the person said')
  assert.deepEqual(list(sid).map(entry => entry.text), ['after the stop'],
    'the message the person wrote after the Stop must not be deleted by the Stop that came before it')
  clearSession(sid)
})

test('a Stop still drops the delivery it stopped, rather than letting it back into a queue that was emptied', () => {
  const sid = 'session-test-stop-drops-its-own'
  clearSession(sid)
  assert.equal(enqueue(sid, 'stopped words').ok, true)
  const stopped = takeNext(sid)

  clearSession(sid)

  assert.equal(requeueFront(sid, stopped), false,
    'Stop means these words have nowhere to go; a refusal must not rebuild a queue the person emptied')
  assert.deepEqual(list(sid).map(entry => entry.text), [],
    'the stopped delivery must not reappear as the next thing to send')
  clearSession(sid)
})

test('a resume carries an outstanding delivery to the new session id, and only the ones it found there', () => {
  const from = 'session-test-resume-from'
  const to = 'session-test-resume-to'
  clearSession(from)
  clearSession(to)
  assert.equal(enqueue(from, 'said before the resume').ok, true)
  const inFlight = takeNext(from)

  moveSession(from, to)

  assert.equal(requeueFront(from, inFlight), true,
    'a refused send taken before a resume belongs to the agent, which now answers under the new id')
  assert.deepEqual(list(to).map(entry => entry.text), ['said before the resume'],
    'the refused send must land on the session the agent actually runs on now')
  assert.deepEqual(list(from).map(entry => entry.text), [],
    'nothing may be rebuilt under the session id the resume left behind')
  clearSession(from)
  clearSession(to)
})

test('a rejected manual send remains paused through a session move and can be explicitly retried', () => {
  const sid = 'outbox-unconfirmed-original'
  const resumed = 'outbox-unconfirmed-resumed'
  const held = holdForSend(sid, { text: 'Do not silently duplicate this' })
  assert.equal(held.take().text, 'Do not silently duplicate this')
  held.release()
  assert.equal(takeNext(sid), null)
  moveSession(sid, resumed)
  assert.equal(held.restore({ unconfirmed: true }), true)
  assert.equal(takeNext(resumed), null)
  const row = list(resumed)[0]
  assert.equal(row.deliveryUnconfirmed, true)
  const retry = holdForSend(resumed, { entryId: row.id })
  assert.equal(retry.take().text, row.text)
  assert.equal(retry.confirm(), true)
  assert.deepEqual(list(resumed), [])
})

/* A SEND NOW WHOSE STOP NEVER REPORTED IDLE comes back through restore() with
   a NAME, so the strip can say which hold the row is in instead of quietly
   drawing "Send now" again. The named row is still an ordinary queued row for
   the drain (it goes at the next boundary, unlike deliveryUnconfirmed), the
   name is this run's and never reaches disk, and the next hold on the same
   row drops it. Asserted by values on the store's own doors. */
test('a hold restored under a named reason paints the reason, stays drainable, and loses it on the next hold', () => {
  const sid = 'outbox-named-hold'
  const held = holdForSend(sid, { text: 'held by name' })
  assert.equal(held.restore({ unconfirmed: false, heldReason: 'SEND_NOW_RELEASE_BUDGET' }), true)
  const [row] = list(sid)
  assert.equal(row.heldReason, 'SEND_NOW_RELEASE_BUDGET', 'the reason must be on the row the strip lists')
  assert.equal(row.deliveryUnconfirmed, undefined, 'a spent release budget is not an unconfirmed delivery: nothing was handed to the transport')
  const second = holdForSend(sid, { text: 'a second send now' })
  assert.equal(second.ok, true, 'a named hold must not refuse the next Send now as "already waiting"')
  assert.equal(list(sid).find(entry => entry.id === row.id)?.heldReason, 'SEND_NOW_RELEASE_BUDGET', 'another row being held must not strip this one\'s name')
  assert.equal(takeNext(sid), null, 'a live hold on any row still owns the boundary')
  assert.equal(second.restore({ unconfirmed: false }), true)
  /* The next hold on the SAME row (Retry send) drops the name: the row is now
     waiting on a new stop, not the old one. */
  const retry = holdForSend(sid, { entryId: row.id })
  assert.equal(retry.ok, true, retry.sentence)
  assert.equal(list(sid).find(entry => entry.id === row.id)?.heldReason, undefined, 'Retry send must clear the old hold\'s name')
  /* A restore with no reason leaves none behind either. */
  assert.equal(retry.restore({ unconfirmed: false }), true)
  assert.equal(list(sid).find(entry => entry.id === row.id)?.heldReason, undefined)
  /* Drainable: with no live hold, a row that carries a name is taken by the
     ordinary boundary drain like any other, front first. */
  const named = holdForSend(sid, { text: 'named and drained' })
  assert.equal(named.restore({ unconfirmed: false, heldReason: 'SEND_NOW_RELEASE_BUDGET' }), true)
  assert.equal(list(sid)[0]?.heldReason, 'SEND_NOW_RELEASE_BUDGET')
  assert.equal(takeNext(sid)?.text, 'named and drained', 'a named row must still go on its own at the boundary')
  clearSession(sid)
})

test('a named hold reason is this run\'s and never reaches the saved queue', () => {
  const sid = 'outbox-named-hold-disk'
  const held = holdForSend(sid, { text: 'named, then reloaded' })
  assert.equal(held.restore({ unconfirmed: false, heldReason: 'SEND_NOW_RELEASE_BUDGET' }), true)
  const saved = JSON.parse(globalThis.localStorage.getItem('mc.session-outbox.v1'))
  const rows = (saved.sessions || saved.queues || []).flatMap(session => session.entries || [])
  const mine = rows.find(entry => entry.text === 'named, then reloaded')
  assert.ok(mine, 'setup: the restored row must be on disk')
  assert.equal('heldReason' in mine, false, 'the reason must not be persisted: after a restart it would describe a wait that is not happening')
  clearSession(sid)
})

/* AN UNCONFIRMED ENTRY BLOCKS ONLY ITSELF, ASSERTED BY DRAINING PAST ONE.
 *
 * takeNext()'s skip -- `entry.deliveryUnconfirmed !== true` -- is the whole
 * difference between "one message the transport never acknowledged is held"
 * and the measured "I cannot message agents": the same condition used to ride
 * in the `some()` above it, so ONE unacknowledged row stopped delivery for the
 * entire session, forever, with nothing to clear it. Nothing covered the
 * release: both tests added beside this one assert the NAMED-HOLD reason
 * (heldReason), which is a different field on a different door -- a row parked
 * by a spent release budget is explicitly still drainable, so passing those
 * two says nothing about whether a fresh entry gets past an UNCONFIRMED one.
 *
 * Driven through the exact pair views/computers.js drainOutboxMessage uses on
 * a refusal whose code leaves delivery uncertain: takeNext() then
 * requeueFront() carrying deliveryUnconfirmed. Values only, so a better
 * implementation of the same behaviour still passes. */
test('a message queued behind an unconfirmed one still drains, and only an explicit retry releases the held row', () => {
  const sid = 'outbox-fresh-past-unconfirmed'
  assert.equal(enqueue(sid, 'never acknowledged').ok, true)
  const taken = takeNext(sid)
  assert.equal(taken?.text, 'never acknowledged', 'setup: the first message was handed out for delivery')
  /* The transport answered with a code that leaves delivery uncertain, so the
     words come back marked -- re-sending them could deliver the person's
     instruction twice. */
  assert.equal(requeueFront(sid, { ...taken, deliveryUnconfirmed: true, heldReason: 'CODEX_PROTOCOL_INVALID' }), true)
  assert.equal(list(sid)[0]?.deliveryUnconfirmed, true, 'setup: the row is held as unconfirmed')
  assert.equal(takeNext(sid), null, 'an unconfirmed row is never re-sent on its own')

  assert.equal(enqueue(sid, 'written afterwards').ok, true)
  assert.equal(enqueue(sid, 'and one more').ok, true)
  assert.equal(takeNext(sid)?.text, 'written afterwards', 'a message queued behind a held one must still go')
  assert.equal(takeNext(sid)?.text, 'and one more', 'and the ones behind it keep their own order')
  assert.equal(takeNext(sid), null, 'with the fresh ones gone there is nothing automatic left')
  assert.deepEqual(list(sid).map(entry => entry.text), ['never acknowledged'],
    'the held row is still waiting, not delivered and not dropped')
  assert.equal(list(sid)[0]?.deliveryUnconfirmed, true, 'and it is still held')
  assert.equal(list(sid)[0]?.heldReason, 'CODEX_PROTOCOL_INVALID', 'still carrying why, so the strip can say it')

  /* The one door that releases it is the person pressing Retry send. */
  const retry = holdForSend(sid, { entryId: list(sid)[0].id })
  assert.equal(retry.ok, true, retry.sentence)
  assert.equal(retry.take()?.text, 'never acknowledged')
  assert.equal(retry.confirm(), true)
  assert.deepEqual(list(sid), [], 'and then the queue is empty')
  clearSession(sid)
})

test('Stop removes an in-flight manual send and a late refusal cannot recreate it', () => {
  const sid = 'outbox-unconfirmed-stop'
  const held = holdForSend(sid, { text: 'Stopped words' })
  held.take()
  clearSession(sid)
  assert.equal(held.restore({ unconfirmed: true }), false)
  assert.equal(held.confirm(), false)
  assert.deepEqual(list(sid), [])
})

/* THE OWNER'S "IT JUST QUEUES FOR AN HOUR" (T382), pinned by behaviour rather
   than by the spelling of the condition that caused it. An entry whose delivery
   the transport never acknowledged must hold ITSELF and nothing else: the words
   may already have reached the agent, so they are never re-sent automatically,
   but every message queued behind them must still go. These call takeNext with
   values, so reinstating the whole-queue refusal fails them whatever it is
   written to look like. */

test('an unconfirmed delivery holds only itself and the messages behind it still go', () => {
  const sid = 'outbox-unconfirmed-blocks-only-itself'
  assert.equal(enqueue(sid, 'first words').ok, true)
  const first = takeNext(sid)
  assert.equal(first?.text, 'first words')
  // The transport took the words and never answered: they go back at the front,
  // held, exactly as drainOutboxMessage puts them back.
  assert.equal(requeueFront(sid, { ...first, deliveryUnconfirmed: true }), true)
  assert.equal(enqueue(sid, 'second words').ok, true)

  const next = takeNext(sid)
  assert.ok(next !== null, 'a single unconfirmed entry must not refuse the whole session')
  assert.equal(next.text, 'second words', 'the held words must not be delivered a second time')

  const remaining = list(sid)
  assert.equal(remaining.length, 1, 'the unconfirmed entry stays queued, it is not dropped')
  assert.equal(remaining[0].text, 'first words')
  assert.equal(remaining[0].deliveryUnconfirmed, true, 'and it stays marked as held')
  assert.equal(takeNext(sid), null, 'with only the held entry left the queue yields nothing')
  clearSession(sid)
})

test('an unconfirmed entry deeper in the queue does not stop the entries ahead of it', () => {
  const sid = 'outbox-unconfirmed-deep-in-queue'
  assert.equal(enqueue(sid, 'held words').ok, true)
  const held = takeNext(sid)
  assert.equal(requeueFront(sid, { ...held, deliveryUnconfirmed: true }), true)
  for (const text of ['one', 'two', 'three', 'four']) assert.equal(enqueue(sid, text).ok, true)

  assert.equal(list(sid).length, 5)
  assert.deepEqual(
    [takeNext(sid)?.text, takeNext(sid)?.text, takeNext(sid)?.text, takeNext(sid)?.text],
    ['one', 'two', 'three', 'four'],
    'every confirmable entry must drain in order past the held one',
  )
  assert.equal(list(sid).map(entry => entry.text).join(), 'held words')
  clearSession(sid)
})

test('a Send now hold still claims the next boundary for the whole queue', () => {
  const sid = 'outbox-sendhold-still-whole-queue'
  assert.equal(enqueue(sid, 'ordinary words').ok, true)
  const held = holdForSend(sid, { text: 'the row the person pressed Send now on' })
  assert.equal(held.ok, true)
  assert.equal(
    takeNext(sid), null,
    'an explicit Send now owns the next boundary, so no other row may take it',
  )
  assert.equal(held.take()?.text, 'the row the person pressed Send now on')
  clearSession(sid)
})


// Exercise the complete shipping drainer with the real outbox. These boundaries
// are intentional: bridge settlement and UI/store publication are controlled.
// The mounted T542 recovery cases additionally drive the real renderer store.
for (const outcome of ['accepted', 'unknown']) for (const changed of ['current', 'session', 'incarnation', 'store', 'bridge', 'routing', 'destroyed']) {
  test(`drain dispatch ownership: ${outcome} after ${changed}`, async () => {
    const sessionId = `drain-owner-${outcome}-${changed}`
    const entry = enqueue(sessionId, 'Exact held owner words.').entry
    const ticket = takeNext(sessionId)
    assert.equal(ticket.id, entry.id)
    const settled = Promise.withResolvers(), publications = [], confirmations = []
    let node = { id: 'node', sessionId, createdAt: 'first-incarnation', status: 'finished' }
    const store = { getNode: () => node, setNodeStatus: (...args) => publications.push(['node-status', ...args]) }
    const endpoint = { send: () => settled.promise }
    const routes = new Map([[sessionId, 'node']])
    const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
    const scope = {
      window: { mcAgent: endpoint }, treeStore: store, sessionNodeIds: routes, destroyed: false,
      sessionModelOverride: new Map(), withResearchTreeBinding: value => value,
      outboxRequeueFront: requeueFront,
      outboxConfirmDelivered: (id, held) => { confirmations.push(held.id); confirmDelivered(id, held) },
      refusalCode, sendFailureIsUnconfirmed, queuedSendRefusalSentence: () => 'unconfirmed',
      QUEUE_PANEL: { notSent: 'not sent', sentNext: 'sent next' },
      transcriptAppend: (...args) => publications.push(['transcript', ...args]),
      broadcastOwnerMessage: (...args) => publications.push(['broadcast', ...args]),
      turnLogAppend: (...args) => publications.push(['turn-log', ...args]),
      setOrgStatus: (...args) => publications.push(['visible-status', ...args]),
      recordUndeliveredWrite: (...args) => publications.push(['global-notice', ...args]),
      WRITE_OUTCOME_KEYS: { SESSION_OUTBOX: 'outbox' }, currentRailTreeNode: null,
      refreshTree: () => publications.push(['refresh']),
    }
    const f = new Function(...Object.keys(scope), `
      ${declaredFunctionSource(view, 'drainOutboxMessage')}
      return { run: drainOutboxMessage, replaceStore(value) { treeStore = value }, destroy() { destroyed = true } }
    `)(...Object.values(scope))
    const sending = f.run(sessionId, 'node', ticket)
    if (changed === 'session') node = { ...node, sessionId: 'new-session' }
    if (changed === 'incarnation') node = { ...node, createdAt: 'second-incarnation' }
    if (changed === 'store') f.replaceStore({ ...store })
    if (changed === 'bridge') scope.window.mcAgent = { ...endpoint }
    if (changed === 'routing') routes.delete(sessionId)
    if (changed === 'destroyed') f.destroy()
    if (outcome === 'accepted') settled.resolve({ ok: true, turnId: 'accepted-turn' })
    else settled.reject(Object.assign(new Error('wire outcome unavailable'), { code: 'PROVIDER_SEND_REFUSED' }))
    await sending
    if (changed === 'current') {
      assert.ok(publications.some(row => row[0] === 'visible-status'), 'a current outcome remains visible')
      assert.equal(publications.some(row => row[0] === 'transcript'), outcome === 'accepted')
    } else assert.deepEqual(publications, [], 'a detached outcome cannot publish into newer ownership')
    if (outcome === 'accepted') {
      assert.deepEqual(confirmations, [entry.id])
      assert.deepEqual(list(sessionId), [], 'accepted words never return for replay')
    } else {
      assert.deepEqual(confirmations, [])
      assert.equal(list(sessionId)[0].id, entry.id)
      assert.equal(list(sessionId)[0].text, entry.text)
      assert.equal(list(sessionId)[0].deliveryUnconfirmed, true)
      assert.equal(takeNext(sessionId), null, 'unknown dispatch cannot automatically replay')
    }
    clearSession(sessionId)
  })
}
