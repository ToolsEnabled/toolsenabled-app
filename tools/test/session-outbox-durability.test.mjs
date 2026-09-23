import assert from 'node:assert/strict'
import test from 'node:test'

/* DOES A MESSAGE THE PERSON QUEUED SURVIVE CLOSING THE APP -- AND WHEN IT
   CANNOT, DOES THE PRODUCT SAY SO?
 *
 * src/session-outbox.js used to answer "no" in a comment and nothing on the
 * screen: the composer promised "sends by itself when this turn finishes" and a
 * restart threw the words away without a word. These tests hold both halves.
 *
 * A RESTART IS A FRESH MODULE INSTANCE. The store is module-level renderer
 * memory, so a second import under a different specifier is exactly what a
 * relaunched window gets: no memory at all, and whatever is on disk. That is
 * why every import here is dynamic and cache-busted -- it is the restart, not a
 * hook the production code carries for the tests' benefit. */

let run = 0
const restart = () => import(`../../src/session-outbox.js?restart=${++run}`)

function fakeStorage(seed = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: key => { values.delete(key) },
  }
}

function withStorage(store) {
  if (store === null) delete globalThis.localStorage
  else globalThis.localStorage = store
}

test('Send now words survive a restart while their interrupt is still pending', async () => {
  withStorage(fakeStorage())
  const before = await restart()
  before.enqueue('pending-interrupt', 'later')
  const held = before.holdForSend('pending-interrupt', { text: 'send this now' })
  assert.equal(held.ok, true)
  assert.equal(before.takeNext('pending-interrupt'), null)
  assert.equal(before.persistence().durable, true)

  const after = await restart()
  assert.deepEqual(after.list('pending-interrupt').map(entry => entry.text), ['send this now', 'later'])
  const next = after.takeNext('pending-interrupt')
  assert.equal(next?.text, 'send this now', 'a restored message must not inherit an abandoned interrupt hold')
  after.confirmDelivered('pending-interrupt', next)
  held.release()
})

test('long Send now text stays exact through editing, session replacement, and restart', async () => {
  withStorage(fakeStorage())
  const before = await restart()
  const text = 'x'.repeat(5000) + 'END'
  const edited = text + ' — corrected'
  const held = before.holdForSend('long-pending-interrupt', { text })
  assert.equal(held.ok, true)
  assert.equal(held.entry.text, text)
  assert.equal(before.replace('long-pending-interrupt', held.entry.id, edited).ok, true)
  assert.equal(before.moveSession('long-pending-interrupt', 'long-resumed'), 1)

  const after = await restart()
  const [restored] = after.list('long-resumed')
  assert.equal(restored?.text, edited, 'restore must never reapply the old queue truncation')
  assert.equal(after.replace('long-resumed', restored.id, edited + '!').ok, true)
  const again = await restart()
  assert.equal(again.takeNext('long-resumed')?.text, edited + '!')
  held.release()
})

test('later queue activity cannot evict a pending Send now from its saved reservation', async () => {
  withStorage(fakeStorage())
  const before = await restart()
  const text = 'x'.repeat(5000) + 'END'
  const held = before.holdForSend('reserved-send-now', { text })
  assert.equal(held.ok, true)
  for (let i = 0; i < 13; i += 1) before.enqueue(`other-session-${i}`, 'other'.repeat(1500))
  assert.equal(before.persistence().state, 'partial', 'the fixture must pressure the saved queue budget')
  assert.equal(before.takeNext('reserved-send-now'), null)

  const after = await restart()
  assert.equal(after.list('reserved-send-now')[0]?.text, text, 'later traffic must not evict the pending reservation')
  held.release()
})

test('queued words come back after a restart, in the order they were typed', async () => {
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  assert.equal(before.enqueue('session-a', 'first thing').ok, true)
  assert.equal(before.enqueue('session-a', 'second thing').ok, true)
  assert.equal(before.enqueue('session-b', 'a different circle').ok, true)

  /* The window closes here. Nothing is carried across but the storage. */
  const after = await restart()
  assert.deepEqual(after.list('session-a').map(entry => entry.text), ['first thing', 'second thing'],
    'the queue did not survive the restart, or came back out of order')
  assert.deepEqual(after.list('session-b').map(entry => entry.text), ['a different circle'],
    'a second session\'s queue was lost')
  assert.equal(after.persistence().restored, 3, 'the store must say how many messages it brought back')
  assert.equal(after.persistence().durable, true)
  assert.equal(after.takeNext('session-a').text, 'first thing', 'a restored message must be takeable, not just visible')
})

test('unqueue, drain and Stop all reach the saved copy, not only memory', async () => {
  const disk = fakeStorage()
  withStorage(disk)
  const first = await restart()
  const doomed = first.enqueue('session-c', 'unqueue me').entry
  first.enqueue('session-c', 'keep me')
  first.enqueue('session-d', 'stop clears this')
  assert.equal(first.cancel('session-c', doomed.id), true)
  assert.equal(first.clearSession('session-d'), 1)

  const second = await restart()
  assert.deepEqual(second.list('session-c').map(entry => entry.text), ['keep me'],
    'an unqueued message came back from disk — the person removed it and it returned')
  assert.deepEqual(second.list('session-d'), [],
    'Stop dropped the words in memory and left them on disk')

  assert.equal(second.takeNext('session-c').text, 'keep me')
  const third = await restart()
  assert.deepEqual(third.list('session-c'), [],
    'a message that was drained and sent came back to be sent a second time')
})

test('a resume carries a restored queue onto the session that replaced it', async () => {
  /* The one door a restored message reaches an agent through: the person
     reopening that circle. resumeNodeSession() calls moveSession, and only then
     does anything drain, so nothing is ever sent because the app started. */
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  before.enqueue('dead-session', 'still the next thing I want to say')

  const after = await restart()
  assert.equal(after.moveSession('dead-session', 'resumed-session'), 1,
    'the restored words did not follow the circle onto its new session')
  assert.deepEqual(after.list('resumed-session').map(entry => entry.text), ['still the next thing I want to say'])

  const third = await restart()
  assert.deepEqual(third.list('dead-session'), [], 'the old address kept a copy on disk')
  assert.deepEqual(third.list('resumed-session').map(entry => entry.text), ['still the next thing I want to say'],
    'the move was not saved, so a second restart loses the words the first one rescued')
})

test('Unqueue removes the message the person pointed at, restored or freshly typed', async () => {
  /* The id is a handle inside one window. A restored one carried back from disk
     would start again at ob-1 in a fresh module and collide with the first
     message typed in this run, and cancel() finds an entry BY id -- so Unqueue
     on one row would remove the other. */
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  before.enqueue('session-i', 'said before the restart')

  const after = await restart()
  const typedNow = after.enqueue('session-i', 'said after the restart').entry
  const restored = after.list('session-i')[0]
  assert.notEqual(restored.id, typedNow.id, 'a restored message shares an id with a newly typed one')
  assert.equal(after.cancel('session-i', typedNow.id), true)
  assert.deepEqual(after.list('session-i').map(entry => entry.text), ['said before the restart'],
    'Unqueue removed the wrong message')
})

test('a computer that will not save says so before anything has been queued', async () => {
  withStorage(null)
  const store = await restart()
  const state = store.persistence()
  assert.equal(state.durable, false,
    'a store with nowhere to write answered "saved" to a question asked before the first write')
  assert.equal(state.code, 'SESSION_OUTBOX_STORAGE_UNAVAILABLE')
})

test('a damaged restore is still said after saving starts working again', async () => {
  withStorage(fakeStorage({ 'mc.session-outbox.v1': '{not json' }))
  const store = await restart()
  assert.equal(store.enqueue('session-j', 'a new message that saves fine').ok, true)
  const state = store.persistence()
  assert.equal(state.durable, true, 'writes are landing, so the store must not claim they are not')
  assert.equal(state.state, 'damaged',
    'the queue that was lost at startup stopped being mentioned the moment one write succeeded')
  assert.match(state.sentence, /could not be read/)
  assert.match(state.sentence, /being saved again/,
    'the person is told their data is damaged without being told the app is working now')
})

test('a computer that will not save says so, in a sentence, and still queues', async () => {
  withStorage(null)
  const store = await restart()
  const queued = store.enqueue('session-e', 'nowhere to save this')
  assert.equal(queued.ok, true, 'a storage failure must never refuse a person\'s message')
  assert.deepEqual(store.list('session-e').map(entry => entry.text), ['nowhere to save this'],
    'the queue must work in full for as long as the window is open')

  const state = store.persistence()
  assert.equal(state.durable, false)
  assert.equal(state.state, 'unavailable')
  assert.equal(state.code, 'SESSION_OUTBOX_STORAGE_UNAVAILABLE', 'a refusal must name itself')
  assert.match(state.sentence, /only while this window is open/,
    'the person is not told that these words will not survive closing the app')
  assert.equal(queued.sentence, state.sentence,
    'the sentence handed back with the entry must be the one that matches the real state')
})

test('a storage that throws on write is reported as a refusal, not as a save', async () => {
  const angry = fakeStorage()
  angry.setItem = () => { throw new Error('a settings value may not exceed 65536 characters') }
  withStorage(angry)
  const store = await restart()
  assert.equal(store.enqueue('session-f', 'the write will be refused').ok, true)
  const state = store.persistence()
  assert.equal(state.durable, false)
  assert.equal(state.code, 'SESSION_OUTBOX_WRITE_REFUSED')
  assert.equal(state.notSaved, 1, 'a refused write must say how many messages are in memory only')
  assert.match(state.sentence, /only while this window is open/)
})

test('"could not read" and "there was nothing" are different answers', async () => {
  withStorage(fakeStorage())
  const empty = await restart()
  assert.equal(empty.persistence().state, 'ok', 'an empty store must read as nothing waiting, not as damage')
  assert.equal(empty.persistence().restored, 0)
  assert.equal(empty.persistence().code, null)

  withStorage(fakeStorage({ 'mc.session-outbox.v1': '{not json' }))
  const damaged = await restart()
  assert.equal(damaged.persistence().state, 'damaged')
  assert.equal(damaged.persistence().code, 'SESSION_OUTBOX_NOT_JSON')
  assert.match(damaged.persistence().sentence, /could not be read/,
    'damage must be said out loud; a person whose queue vanished is owed the reason')

  withStorage(fakeStorage({ 'mc.session-outbox.v1': JSON.stringify({ v: 99, sessions: [] }) }))
  const stranger = await restart()
  assert.equal(stranger.persistence().code, 'SESSION_OUTBOX_WRONG_SHAPE',
    'a record from another version must be refused by name rather than half-read')

  /* And a damaged file must not take the store down with it. */
  const recovering = await restart()
  assert.equal(recovering.enqueue('session-g', 'after the damage').ok, true)
})

test('a message older than a day is left behind, and the store counts what it left', async () => {
  const old = Date.now() - (25 * 60 * 60 * 1000)
  const fresh = Date.now() - 60_000
  withStorage(fakeStorage({
    'mc.session-outbox.v1': JSON.stringify({
      v: 1,
      sessions: [{
        sessionId: 'session-h',
        entries: [
          { id: 'ob-1', text: 'typed yesterday', atMs: old },
          { id: 'ob-2', text: 'typed a minute ago', atMs: fresh },
        ],
      }],
    }),
  }))
  const store = await restart()
  assert.deepEqual(store.list('session-h').map(entry => entry.text), ['typed a minute ago'],
    'a day-old draft was fired at an agent the person has not looked at since')
  assert.equal(store.persistence().droppedStale, 1,
    'the store dropped a message and did not say so — a silent skip')
  assert.equal(store.persistence().restored, 1)
})

test('more waiting than the storage will hold is saved oldest-last and reported, never lost from memory', async () => {
  const disk = fakeStorage()
  withStorage(disk)
  const store = await restart()
  /* Twelve sessions at the store's own per-session and per-message caps is far
     past shell/renderer-prefs.cjs's 65,536-character per-value refusal, so the
     envelope budget has to bind here. */
  const long = 'x'.repeat(4000)
  for (let session = 0; session < 12; session += 1) {
    for (let index = 0; index < 12; index += 1) {
      assert.equal(store.enqueue(`bulk-${session}`, `${long}${session}-${index}`).ok, true)
    }
  }
  const state = store.persistence()
  assert.equal(state.state, 'partial', 'the budget did not bind, so this test proves nothing about it')
  assert.equal(state.code, 'SESSION_OUTBOX_BUDGET_BOUND')
  assert.ok(state.notSaved > 0, 'a partial save must say how much of it is memory-only')
  assert.match(state.sentence, /only while this window is open/,
    'the person is told everything is saved when some of it is not')
  assert.ok(disk.values.get('mc.session-outbox.v1').length <= 60_000,
    'the saved value is over the budget, so the shipped storage would refuse it outright')

  /* NOTHING IS LOST FROM MEMORY. The budget trims the copy on disk only. */
  assert.equal(store.list('bulk-11').length, 12, 'a full save budget cost the person words in the live window')

  /* The NEWEST conversation is the one that survives the restart. */
  const after = await restart()
  assert.ok(after.list('bulk-11').length > 0, 'the newest queue was the one dropped')
  assert.equal(after.persistence().restored + state.notSaved >= 144, true,
    'the counts do not add up: something was neither saved nor reported')
})

test('an edit the person made to a waiting message is the version that comes back', async () => {
  /* The composer's up-arrow recall hands a queued message back to be edited
     (src/composer-queue-recall.js commits it through replace). MEASURED
     2026-09-03: the edit reached memory and the strip, and the saved copy kept
     the words it replaced -- so the typo the person had already fixed came back
     after a restart, while persistence() went on answering durable:true because
     the enqueue BEFORE the edit had landed. */
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  const typo = before.enqueue('session-edit', 'teh refactor').entry
  before.enqueue('session-edit', 'second thing')
  assert.equal(before.replace('session-edit', typo.id, 'the refactor').ok, true)
  assert.equal(before.persistence().durable, true,
    'the store claims the edit is saved, so a restart has to be able to produce it')

  const after = await restart()
  assert.deepEqual(after.list('session-edit').map(entry => entry.text), ['the refactor', 'second thing'],
    'the edit was lost across the restart, or it moved the message it edited')
  assert.equal(after.takeNext('session-edit').text, 'the refactor',
    'the words that would actually be SENT are the ones the person replaced')
})

test('Send now still means next out after a restart', async () => {
  /* The strip's promote door. MEASURED 2026-09-03: memory read
     ['charlie','alpha','bravo'] and the saved copy still read
     ['alpha','bravo','charlie'], so a restart undid the one thing the button
     does and charlie went out last again -- the very defect promoteFront was
     written to remove, one restart later. */
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  before.enqueue('session-now', 'alpha')
  before.enqueue('session-now', 'bravo')
  const charlie = before.enqueue('session-now', 'charlie').entry
  assert.equal(before.promoteFront('session-now', charlie.id), true)

  const after = await restart()
  assert.deepEqual(after.list('session-now').map(entry => entry.text), ['charlie', 'alpha', 'bravo'],
    'the order the person chose was not saved, so Send now was undone by the restart')
  assert.equal(after.takeNext('session-now').text, 'charlie',
    'the message the person promoted is not the one that would be sent first')
})

test('a door that changed nothing leaves the saved queue exactly as it was', async () => {
  /* A door that writes has to have READ first: persist() saves whatever
     `queues` holds, so saving from a module that has not hydrated yet would
     replace the previous run's queue with an empty one. These two calls change
     nothing and must cost nothing -- an unknown id is "that message is gone",
     never "so save the nothing I have in memory". */
  const disk = fakeStorage()
  withStorage(disk)
  const before = await restart()
  before.enqueue('session-quiet', 'still waiting')

  const after = await restart()
  assert.equal(after.replace('session-quiet', 'ob-not-a-real-id', 'rewrite').ok, false,
    'an id that is not waiting has to be refused by name, not accepted')
  assert.equal(after.promoteFront('session-quiet', 'ob-not-a-real-id'), false)

  const third = await restart()
  assert.deepEqual(third.list('session-quiet').map(entry => entry.text), ['still waiting'],
    'a refused edit or promote erased the queue that was on disk')
})

test('manual-send words persist as unconfirmed after the transport is invoked and never auto-drain after restart', async () => {
  withStorage(fakeStorage())
  const before = await restart()
  const held = before.holdForSend('pending-acknowledgement', { text: 'Keep the entire attempted message' })
  held.take()
  const after = await restart()
  assert.equal(after.list('pending-acknowledgement')[0]?.text, 'Keep the entire attempted message')
  assert.equal(after.list('pending-acknowledgement')[0]?.deliveryUnconfirmed, true)
  assert.equal(after.takeNext('pending-acknowledgement'), null)
  held.restore({ unconfirmed: true })
})
