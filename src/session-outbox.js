// THE MESSAGES A PERSON WROTE WHILE THE AGENT WAS STILL ANSWERING.
//
// The engine runs one turn at a time and refuses an overlapping send by
// design (AGENT_TURN_ACTIVE — shell/agent-host.cjs). Before this store the
// product turned that honest refusal into a dead end: there was nowhere to
// PUT the next message, so the person either lost their words or sat watching
// a spinner to earn the right to type. The owner's ask, verbatim: "can we add
// a que/unque for messages."
//
// This is that queue, modeled line for line on src/write-outcomes.js, the
// established renderer store that outlives views:
//
//   - module-level memory keyed by sessionId, surviving navigation and rail
//     rebuilds.
//   - a CustomEvent on every change, so mounted surfaces repaint without
//     polling.
//   - bounded in both directions: a message is capped like the composer that
//     wrote it, and a session holds a short queue — a hundred queued messages
//     is not a plan, it is a spill.
//
// WHO SENDS. This store never touches the bridge. The view's own
// turn-completed listener asks for exactly one message (takeNext) after the
// reply is filed, sends it through the same path a typed message uses, and
// re-queues at the head (requeueFront) if the send is refused. The store
// holds words; the view holds the wire.
//
// -----------------------------------------------------------------------
// IT SURVIVES A RESTART NOW, AND WHEN IT CANNOT IT SAYS SO OUT LOUD.
//
// This store used to say of itself, in this comment, "NOT durable across a
// restart". It was honest in the file and silent on the screen: closing the
// window threw away words the person had written and had been promised would
// send by themselves. That is the same defect the queue was built to remove,
// moved one step later.
//
// The old reason for keeping it in memory was real and is answered rather than
// dropped: a draft outliving the session it was addressed to must not be fired
// at something the person can no longer see. It is not, and it never was this
// store's job to decide that — resumeNodeSession() already carries a queue from
// a dead session to the live one it resumed (moveSession), and only then does
// anything drain. A restored queue reaches an agent by exactly that door: the
// person reopening that circle. Nothing is sent because the app started.
//
// WHAT PERSISTENCE IS ALLOWED TO DO. Save and restore. It may never refuse a
// message, never reorder one, and never delete one from memory: a window whose
// storage is full or unreachable keeps the full queue for as long as it is
// open, exactly as before. Every way it can fall short is reported by
// persistence() as a state with a reason, and the composer says the honest
// sentence beside the words being queued:
//
//   'ok'          saved; these words outlive the window.
//   'unavailable' this computer would not let the app look or write.
//   'damaged'     something was there and it was not this store's data.
//   'partial'     saved, but the store's own budget could not fit all of it.
//
// "could not look" and "not there" are different answers and this file never
// merges them.
//
// EVERY DOOR THAT CHANGES THE QUEUE SAVES; THAT IS THE WHOLE RULE. A door that
// only announced was the leak this store shipped with: replace() (the composer's
// up-arrow edit) and promoteFront() ("Send now" on a waiting row) each rewrote
// memory and repainted the strip while the saved copy kept the words and the
// order the person had just changed. MEASURED 2026-09-03 — the typo they fixed
// came back after a restart, and the message they promoted went out last again.
// Both are person doors, both now go through settle(): persist, then announce.
// The reason announce() alone is never enough is not "we forgot to save": a
// surface repaints on that event and asks persistence() what the state is, so
// announcing first hands it the answer from before the write.
//
// WHOSE WORDS THESE ARE, AND WHOSE ARE DELIBERATELY NOT SAVED. Only a person's.
// Every caller of enqueue() is a composer path in src/views/computers.js — the
// box the person types in, and the /queue command they type into it. Agent and
// tree traffic never enters this store and is deliberately left non-durable:
// agent_comms is offered by the tree pump in the shell on a timer
// (shell/tree-turn-priority.cjs, "the tree pump holds agent_comms traffic and
// offers it on a timer"), where a machine that still wants the session after a
// restart simply asks again, and one that no longer does must not have a
// sentence fired on its behalf into a run it never saw. A person cannot ask
// again — they typed it once, from memory, and closed the window. That
// asymmetry is the reason this store persists at all, so it is the line the
// persistence stops at.
//
// THE BOUNDS ARE THE STORAGE'S, NOT A GUESS. shell/renderer-prefs.cjs backs
// this page's storage in the shipped app and refuses any single value over
// MAX_VALUE_LENGTH = 64 * 1024 characters ("a settings value may not exceed
// 65536 characters"), which src/session-transcript-store.js measured the hard
// way on a staged packaged build. So the envelope is budgeted below that with
// room for the key and the file's framing around the value, and an overflow
// trims the SAVED copy oldest-first while memory keeps everything.

export const SESSION_OUTBOX_EVENT = 'mc:session-outbox'

// Match the host's sendTurn text bound. Queueing must never shorten a send.
const MAX_TEXT = 200_000
const MAX_PER_SESSION = 12
/* How many sessions' queues are kept on disk. A person with a dozen circles
   each holding waiting words is the ceiling this store was already built for
   (MAX_PER_SESSION has the same shape of reason); beyond it the oldest words
   are the ones that stop being saved, and persistence() counts them. */
const MAX_SESSIONS = 12
/* Under shell/renderer-prefs.cjs's 65,536-character per-value refusal, with
   headroom for the key and the settings file's framing around the value. */
const MAX_ENVELOPE_CHARS = 60_000
/* A QUEUED MESSAGE IS THE NEXT THING TO SAY, NOT A LETTER TO THE FUTURE.
   NOT MEASURED — there is no measurement of how long a person means one of
   these to stand, and inventing one would be worse than choosing one in the
   open. This is a chosen bound with a stated reason: a day later the person is
   re-reading the conversation, not waiting for a sentence they wrote before
   they closed the app to arrive on its own. Anything older is left behind at
   restore and COUNTED — persistence().droppedStale — because a silent skip is
   the defect this codebase keeps re-finding. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'mc.session-outbox.v1'
const STORAGE_VERSION = 1

// sessionId -> [{ id, text, atMs }]
const queues = new Map()
let sequence = 0

// A Send now waiting for an interrupt is still unsent and must stay saved.
// Holds coordinate this window. A send already handed to the transport is
// persisted as unconfirmed and stays paused after a restart.
const sendHolds = new Map()
// Voice endpointing blocks automatic drains in every mounted view. A lease is
// transient and scoped to one live contact; explicit user sends stay explicit.
const drainHolds = new Map()
export function holdDrain(sessionId) {
  const token = Symbol('voice-drain')
  const holds = drainHolds.get(sessionId) || new Set()
  holds.add(token); drainHolds.set(sessionId, holds)
  return () => {
    holds.delete(token)
    if (!holds.size && drainHolds.get(sessionId) === holds) drainHolds.delete(sessionId)
  }
}


/* SESSIONID -> HOW MANY TAKEN ENTRIES ARE STILL OUT FOR DELIVERY, UNRESOLVED.
 *
 * takeNext() removes an entry from `queues` the instant it hands it to a
 * caller -- correct, because two callers must never be handed the same
 * entry. But "gone from the array" and "no longer this store's problem" are
 * different facts, and enqueue()'s cap used to read only the array: fill a
 * session to MAX_PER_SESSION, let a turn end so takeNext() removes the front
 * entry for delivery (the array is now one below the cap for as long as that
 * delivery is in flight -- a real span, an IPC round trip to the host),
 * enqueue one more into the seat that looks open, and let the delivery fail.
 * requeueFront() puts the original back on top of a queue that was already
 * back at the cap, for thirteen -- and nothing there ever refuses again,
 * because the array itself never again reads as "at the cap" while this keeps
 * happening. MAX_PER_SESSION stops being a real bound the moment one failed
 * delivery and one enqueue share the gap, and the gap reopens on every turn.
 *
 * So the cap counts what enqueue() could not otherwise see: a taken, unsettled
 * entry holds its seat here exactly as if it were still in the array.
 * requeueFront() releases the seat back to the array it returns the entry to
 * (no net change to what is "held"); confirmDelivered() releases it to
 * nothing, because the entry reached the wire and is gone for good. Never
 * persisted -- "out for delivery" describes this run's own outstanding call
 * and means nothing to a restored window.
 *
 * See outstandingDeliveries below for what a seat held here becomes when the
 * session itself stops being a valid queue address before the delivery it
 * describes ever resolves. */
const checkedOut = new Map()

/* Both ways a taken entry's seat comes free: back in the array (requeueFront)
   or gone for good (confirmDelivered). Floors at zero and drops the key
   rather than ever going negative, so a session nobody reserved for is a
   true no-op, not a debt that forgives a future enqueue it never earned. */
function releaseSeat(session) {
  const reserved = checkedOut.get(session) || 0
  if (reserved <= 1) checkedOut.delete(session)
  else checkedOut.set(session, reserved - 1)
}

/* WHERE AN OUTSTANDING DELIVERY LANDS ONCE ITS OWN SESSION ID STOPS BEING A
 * VALID QUEUE ADDRESS.
 *
 * checkedOut makes a taken, unresolved entry hold its seat in the CAP. It
 * does not make moveSession() or clearSession() wait for that entry to
 * settle before wiping the session's queue -- both run the instant a resume
 * or a Stop happens, which can be WHILE a taken entry's delivery is still on
 * the wire. requeueFront() and confirmDelivered() are called later, whenever
 * that delivery actually settles, with the SAME session id it was taken
 * under -- one that may by then be gone from every other map the view keeps
 * (sessionNodeIds, the tree node's own sessionId, and this store's own
 * `queues` and `checkedOut`). Without this map, requeueFront() rebuilt
 * `queues.get(session)` from nothing and stored the refused entry there
 * anyway: a queue keyed by an id nothing calls list() or takeNext() on ever
 * again, holding words the composer had already promised would "send by
 * itself" -- and persist() serialises `queues` in full, so it rode to disk
 * that way too.
 *
 * A resume and a Stop mean different things for that entry, so this maps to
 * different answers, not one:
 *
 *   moveSession(from, to)  the words are still addressed to the same agent,
 *                          now under its new session id -- from -> to.
 *   clearSession(session)  these words have nowhere to go, exactly like the
 *                          rest of the queue Stop already emptied --
 *                          a drop, not a destination.
 *
 * KEYED BY THE DELIVERY, NOT BY THE SESSION, AND THIS IS THE WHOLE POINT.
 * The first version of this kept one hop per session id carrying a count of
 * how many outstanding deliveries it still owed an answer to. That count
 * cannot tell a delivery taken BEFORE the Stop from one taken AFTER it,
 * because a taken entry had no identity of its own -- and the two are not the
 * same message at all. Measured on live 3c5ad80, 2026-09-04: queue one
 * message, let the view take it, press Stop while that delivery is still on
 * the wire, and let the delivery never answer (an answer lost to a window
 * reload is the ordinary case on this machine). The hop stands, owed one
 * answer. The person then writes a NEW message, the view takes it, the send
 * is refused -- and requeueFront() walks that stale hop to null and DROPS the
 * new message. requeueFront() returned false and list() came back empty:
 * words the person typed after the Stop, deleted without a sentence. The
 * owner's report of it: "i still dont think my que and halt and send now ever
 * got fixed ... things get deleted".
 *
 * So each take gets a ticket, and a resume or a Stop answers for exactly the
 * tickets outstanding at that moment. A delivery started afterwards has a
 * ticket nothing has ruled on and lands where it was taken from. The ticket
 * rides on the object takeNext() hands back under a SYMBOL key, which is the
 * one kind of property JSON.stringify() cannot serialise -- so persist()
 * cannot write it to disk even if the entry goes back into the array, which
 * is what "never persisted" has to mean here rather than a rule someone
 * remembers to keep. requeueFront() strips it anyway.
 *
 * BOUNDED, because a delivery whose call is simply lost never resolves and
 * would otherwise hold a row here for the life of the window. The oldest
 * ticket past the bound is forgotten, and a resolution that arrives for a
 * forgotten ticket falls back to the session id it was taken under, which is
 * this door's behaviour when nothing has moved or stopped. */
const DELIVERY_TICKET = Symbol('mc.session-outbox.delivery')
const MAX_OUTSTANDING_DELIVERIES = 512
let deliveryTickets = 0
const outstandingDeliveries = new Map()

/* The session an outstanding delivery should land on now: the id it was taken
   under, the id a resume moved it to, or null when a Stop dropped it. Reading
   consumes the ticket -- a delivery settles exactly once, either back in the
   array or gone for good -- and an entry that never came from takeNext() (a
   caller putting words back by hand) has no ticket and keeps this door's
   plain answer. */
function resolveDeliveryTarget(session, entry) {
  const ticket = entry ? entry[DELIVERY_TICKET] : undefined
  if (ticket === undefined || !outstandingDeliveries.has(ticket)) return session
  const target = outstandingDeliveries.get(ticket)
  outstandingDeliveries.delete(ticket)
  return target
}

/* Every outstanding delivery taken from `session` now belongs to `target`:
   another session id for a resume, null for a Stop. Called with the tickets
   that exist at that moment, so it can never speak for a delivery that has
   not been taken yet. */
function redirectOutstandingDeliveries(session, target) {
  for (const [ticket, held] of outstandingDeliveries) {
    if (held === session) outstandingDeliveries.set(ticket, target)
  }
}

/* WHAT THE LAST SAVE AND THE ONE RESTORE ACTUALLY DID -- TWO FACTS, KEPT APART.
 *
 * They answer different questions and a single field would make one of them
 * lie. "The saved queue on this computer was unreadable" is about words the
 * person has already lost; "this computer will not let me write" is about words
 * they are queueing now. A store that had been handed damage at startup and
 * then saved perfectly would report 'ok' and never mention the queue that
 * vanished, which is the silent skip this codebase keeps re-finding. Never a
 * boolean, for the same reason: "could not look" and "there was nothing" are
 * different answers. */
const persistState = {
  /* The last write: 'ok' | 'unavailable' | 'partial'. */
  write: 'ok',
  writeCode: null,
  /* The one restore, sticky for the life of the window: 'ok' | 'unavailable' |
     'damaged'. */
  restore: 'ok',
  restoreCode: null,
  restored: 0,
  droppedStale: 0,
  notSaved: 0,
  hydrated: false,
}

/* The backing store, or a named absence. Same posture as src/hidden-rows.js:
   reaching for localStorage is itself allowed to throw (a window with site data
   switched off), and that throw is an answer, not a crash. */
function backing() {
  let store
  try { store = globalThis.localStorage } catch { return null }
  return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null
}

/* The answer restoredEntry gives for a message that is too old to bring back.
   A named sentinel, not a null: "there was an entry here and it was left behind
   on purpose" has to be countable, and null already means "this was not an
   entry at all". */
const TOO_OLD = Symbol('a queued message too old to bring back')

/* One saved entry, re-read defensively: this came off disk and may have been
 * edited, truncated or written by a build that is not this one.
 *
 * THE ID IS MINTED HERE, NEVER RESTORED. It is a handle the Unqueue button
 * holds for as long as the window is open and it means nothing across a
 * restart, so keeping the saved one would buy nothing and cost correctness:
 * `sequence` starts at zero in a fresh module, so a restored 'ob-3' would
 * collide with the third message typed in this run, and cancel() -- which finds
 * an entry BY id -- would unqueue whichever came first. Minting on the way in
 * keeps every id in the window unique by construction. */
function restoredEntry(value, now) {
  if (!value || typeof value !== 'object') return null
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (text.length === 0 || text.length > MAX_TEXT) return null
  const atMs = typeof value.atMs === 'number' && Number.isFinite(value.atMs) && value.atMs >= 0 ? value.atMs : null
  if (atMs === null) return null
  if (now - atMs > MAX_AGE_MS) return TOO_OLD
  return Object.freeze({ id: `ob-${++sequence}`, text, atMs, ...(value.deliveryUnconfirmed === true ? { deliveryUnconfirmed: true } : {}) })
}

/* READ ONCE, ON FIRST USE. Not at import: a module that touches storage while
   it is being loaded takes the whole page down with it on a browser that throws
   from the property itself, and this store is imported by the view that draws
   the tree. */
function hydrate() {
  if (persistState.hydrated) return
  persistState.hydrated = true
  const store = backing()
  if (!store) {
    /* No store to read AND no store to write: this is already the whole answer
       for both, and a caller that asks "will my words be saved" before ever
       queueing one must not be told yes. A read that throws from a store that
       IS there says nothing about writing, so that case below leaves the write
       state alone and lets the first save find out for itself. */
    persistState.restore = 'unavailable'
    persistState.restoreCode = 'SESSION_OUTBOX_STORAGE_UNAVAILABLE'
    persistState.write = 'unavailable'
    persistState.writeCode = 'SESSION_OUTBOX_STORAGE_UNAVAILABLE'
    return
  }
  let raw
  try { raw = store.getItem(STORAGE_KEY) } catch {
    persistState.restore = 'unavailable'
    persistState.restoreCode = 'SESSION_OUTBOX_READ_REFUSED'
    return
  }
  if (raw === null || raw === undefined) return
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    persistState.restore = 'damaged'
    persistState.restoreCode = 'SESSION_OUTBOX_NOT_JSON'
    return
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.sessions)) {
    persistState.restore = 'damaged'
    persistState.restoreCode = 'SESSION_OUTBOX_WRONG_SHAPE'
    return
  }
  const now = Date.now()
  for (const row of parsed.sessions.slice(0, MAX_SESSIONS)) {
    const session = row && typeof row === 'object' ? usableSession(row.sessionId) : null
    if (!session || !Array.isArray(row.entries)) continue
    const entries = []
    for (const value of row.entries.slice(0, MAX_PER_SESSION)) {
      const entry = restoredEntry(value, now)
      if (entry === TOO_OLD) { persistState.droppedStale += 1; continue }
      if (entry) entries.push(entry)
    }
    if (entries.length > 0) {
      queues.set(session, entries)
      persistState.restored += entries.length
    }
  }
}

/* The saved shape, projected out of the accounting rows persist() works in --
   never the rows themselves, whose bookkeeping fields must not reach disk. */
function envelope(rows) {
  return JSON.stringify({
    v: STORAGE_VERSION,
    sessions: rows.map(row => ({ sessionId: row.sessionId, entries: row.entries })),
  })
}

const TEXT_TOO_LONG = 'This message is longer than the agent can accept. Shorten it before sending.'
const HOLD_TOO_LARGE = 'This message cannot fit in the saved queue. Shorten it, remove queued messages, or send it when the agent is idle.'
const HOLD_NOT_SAVED = 'This computer could not save the message while the agent stops. Your words have not been sent; try again or send when the agent is idle.'

// A Send now clears the composer while awaiting an interrupt. Unlike an
// ordinary queue overflow, it must have room to save its entire reservation
// before clearing those words. Measure the actual JSON, including escaping
// and the other queued messages; the storage limit is not a plain-text limit.
function canSaveEntry(sessionId, candidate) {
  const proposed = new Map(queues)
  const entries = [...(proposed.get(sessionId) || [])]
  const index = entries.findIndex(entry => entry.id === candidate.id)
  if (index === -1) entries.push(candidate)
  else entries[index] = candidate
  proposed.set(sessionId, entries)
  const rows = [...proposed.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([sessionId, entries]) => ({
      sessionId,
      entries: entries.map(savedEntry),
    }))
  return rows.length <= MAX_SESSIONS && envelope(rows).length <= MAX_ENVELOPE_CHARS
}

/* WHAT THE TRIM COSTS, MEASURED BEFORE IT WAS WRITTEN THIS WAY.
 *
 * The first version of the trim below asked `envelope(rows).length` once per
 * dropped entry, which serialises the whole store again on every pass.
 * tools/outbox-persist-cost.mjs, on the full case this store can reach (12
 * sessions of 12 messages at the 4,000-character cap, which is far past the
 * storage's own ceiling so the trim runs on every single enqueue), measured on
 * 2026-09-03:
 *
 *   serialise per drop   5,410 ms / 5,104 ms for 144 messages   -> 35-38 ms each
 *   accounted (below)      154 ms /   155 ms for 144 messages   -> about 1 ms each
 *
 * Both write the same 56,554 characters and report the same 130 not saved, so
 * this bought speed and changed no answer. 37 ms of renderer main thread to
 * queue ONE message is a person watching the window stutter as they type, which
 * is the opposite of the reason this lane exists. So the length is accounted
 * for exactly and cheaply instead: each entry is serialised once, and the
 * envelope's own framing is arithmetic. The single full serialisation at the
 * end still checks the answer, and a disagreement falls back to the
 * slow-but-certain loop rather than writing a value the storage would refuse. */
const ENVELOPE_FRAME = envelope([]).length
const rowFrame = sessionId => JSON.stringify({ sessionId, entries: [] }).length
const entryCost = entry => JSON.stringify(entry).length

/* SAVE, AND SAY WHAT DID NOT FIT. Memory is never trimmed here — only the copy
   on disk is — so a budget that binds costs the person nothing until the window
   closes, and persistence() says how many words are in that position. */
function savedEntry(entry) {
  return { text: entry.text, atMs: entry.atMs, ...(entry.deliveryUnconfirmed === true ? { deliveryUnconfirmed: true } : {}) }
}

function persist() {
  const store = backing()
  if (!store) {
    persistState.write = 'unavailable'
    persistState.writeCode = 'SESSION_OUTBOX_STORAGE_UNAVAILABLE'
    persistState.notSaved = [...queues.values()].reduce((total, entries) => total + entries.length, 0)
    return
  }
  /* The saved entry carries only the words and when they were written. Not the
     id: see restoredEntry(), which mints a fresh one on the way back in. */
  const rows = [...queues.entries()]
    .map(([sessionId, entries]) => ({
      sessionId,
      entries: entries.map(savedEntry),
      held: entries.map(e => sendHolds.has(e.id)),
      /* Serialised once, here, and then only subtracted from. */
      costs: entries.map(e => entryCost(savedEntry(e))),
      frame: rowFrame(sessionId),
    }))
    .filter(row => row.entries.length > 0)
  if (rows.length === 0) {
    try { store.removeItem?.(STORAGE_KEY) } catch {
      persistState.write = 'unavailable'
      persistState.writeCode = 'SESSION_OUTBOX_WRITE_REFUSED'
      return
    }
    persistState.write = 'ok'
    persistState.writeCode = null
    persistState.notSaved = 0
    return
  }
  /* Newest conversation first, so when the budget binds it is the oldest words
     that stop being saved rather than whichever the Map happened to hold last. */
  const newest = row => row.entries.reduce((high, entry) => Math.max(high, entry.atMs), 0)
  // Admitted Send now reservations must survive later queue traffic. They
  // were all proven to fit at admission; only ordinary rows may be evicted.
  rows.sort((left, right) => Number(right.held.some(Boolean)) - Number(left.held.some(Boolean)) || newest(right) - newest(left))
  let notSaved = 0
  while (rows.length > MAX_SESSIONS) {
    notSaved += rows.pop().entries.length
  }

  /* Drop exactly one entry per pass — the OLDEST anywhere — so what stops being
     saved is decided by age across the whole store, not by whichever session
     happens to be longest. Returns false when there is nothing left to give. */
  const dropOldest = () => {
    let oldestRow = null
    let oldestIndex = -1
    let oldestAt = Infinity
    for (const row of rows) {
      const index = row.held.findIndex(held => !held)
      const first = row.entries[index]
      if (first && first.atMs < oldestAt) { oldestAt = first.atMs; oldestRow = row; oldestIndex = index }
    }
    if (!oldestRow) return false
    oldestRow.entries.splice(oldestIndex, 1)
    oldestRow.costs.splice(oldestIndex, 1)
    oldestRow.held.splice(oldestIndex, 1)
    notSaved += 1
    if (oldestRow.entries.length === 0) rows.splice(rows.indexOf(oldestRow), 1)
    return true
  }

  const accountedLength = () => rows.reduce(
    (total, row) => total + row.frame + row.costs.reduce((sum, cost) => sum + cost, 0) + Math.max(row.entries.length - 1, 0) + 1,
    ENVELOPE_FRAME - 1,
  )
  while (rows.length > 0 && accountedLength() > MAX_ENVELOPE_CHARS) {
    if (!dropOldest()) break
  }
  /* The one full serialisation, which is also the check on the arithmetic
     above. If they ever disagree the slow loop finishes the job rather than
     handing the storage a value it would refuse. */
  let saved = envelope(rows)
  while (rows.length > 0 && saved.length > MAX_ENVELOPE_CHARS) {
    if (!dropOldest()) break
    saved = envelope(rows)
  }
  try { store.setItem(STORAGE_KEY, saved) } catch {
    persistState.write = 'unavailable'
    persistState.writeCode = 'SESSION_OUTBOX_WRITE_REFUSED'
    /* A refused write leaves NOTHING of this change on disk, so everything in
       memory is memory-only — not just the part the budget trimmed. */
    persistState.notSaved = [...queues.values()].reduce((total, entries) => total + entries.length, 0)
    return
  }
  persistState.notSaved = notSaved
  persistState.write = notSaved > 0 ? 'partial' : 'ok'
  persistState.writeCode = notSaved > 0 ? 'SESSION_OUTBOX_BUDGET_BOUND' : null
}

/* THE SENTENCES. They live here rather than in the copy module because each one
   is the answer to a state only this file can be in, and a caller that had to
   map a code to a sentence would be the second place the states are written
   down. The composer shows one of these the moment a message is queued. */
const PERSISTENCE_SENTENCE = Object.freeze({
  ok: 'Message queued and saved on this computer.',
  unavailable: 'Message queued. This computer would not let the app save it, so it is kept only while this window is open.',
  damaged: 'Message queued. Saved queue data on this computer could not be read, so what was waiting before is not back; new messages are being saved again.',
  partial: 'Message queued. There is more waiting than this computer will save, so the oldest of it is kept only while this window is open.',
})

/** WHETHER THE WORDS OUTLIVE THE WINDOW, and if not, why not. Every field is a
 *  fact about the last save or the one restore, never a guess:
 *    durable      true only when the last write actually landed in full.
 *    state/code   'ok' | 'unavailable' | 'damaged' | 'partial', with the name.
 *    sentence     what to say to the person, ready to show.
 *    restored     how many messages came back from the previous run.
 *    droppedStale how many were left behind for being older than a day.
 *    notSaved     how many are in memory only because the budget bound.
 *
 *  A FAILING WRITE OUTRANKS A DAMAGED RESTORE in the one sentence there is room
 *  for: the words the person is queueing right now are the ones still in their
 *  hands. When writes are landing, a damaged restore is what the sentence
 *  carries — it is the only chance to say that a queue from a previous run is
 *  gone, and its sentence says in the same breath that new messages are saved
 *  again. */
export function persistence() {
  hydrate()
  const state = persistState.write !== 'ok'
    ? persistState.write
    : persistState.restore === 'damaged' ? 'damaged' : 'ok'
  const code = persistState.write !== 'ok'
    ? persistState.writeCode
    : persistState.restore === 'damaged' ? persistState.restoreCode : null
  return Object.freeze({
    durable: persistState.write === 'ok',
    state,
    code,
    sentence: PERSISTENCE_SENTENCE[state] || PERSISTENCE_SENTENCE.unavailable,
    restored: persistState.restored,
    droppedStale: persistState.droppedStale,
    notSaved: persistState.notSaved,
  })
}

function usableSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null
}

function usableText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

/* WHY THE EVENT CARRIES A REASON AND NOT JUST A COUNT.
 *
 * A count says how many messages are waiting. It cannot say whether they are
 * waiting for a turn to finish -- ordinary, over in a minute -- or held because
 * a delivery was refused, which is not over until the person does something. A
 * composer drawing both from the same number has to guess, and the sentence it
 * guesses is the one the person believes. heldReason is the refused case named:
 * the refusal code drainOutboxMessage already had in hand at the only moment it
 * was known, carried out to the surfaces instead of being spent on one org
 * status line and dropped.
 *
 * NOT PERSISTED, deliberately. It describes THIS run's refusal; after a restart
 * the code is stale and the honest state is an unconfirmed entry with no reason
 * attached, which is what restoredEntry() produces. */
function heldReasonOf(sessionId) {
  const held = (queues.get(sessionId) || []).find(entry => entry.heldReason || entry.deliveryUnconfirmed === true)
  if (!held) return null
  return held.heldReason || 'SESSION_OUTBOX_DELIVERY_UNCONFIRMED'
}

function announce(sessionId) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    window.dispatchEvent(new CustomEvent(SESSION_OUTBOX_EVENT, {
      detail: { sessionId, count: (queues.get(sessionId) || []).length, heldReason: heldReasonOf(sessionId) },
    }))
  } catch { /* a window that cannot take an event still has the store */ }
}

/* EVERY CHANGE, WRITTEN DOWN AND THEN ANNOUNCED, IN THAT ORDER. A surface that
   repaints on the event immediately asks persistence() what the state is, and
   answering it with the state from BEFORE the write would be the store telling
   the person its words are saved a moment before finding out they are not. */
function settle(sessionId) {
  persist()
  announce(sessionId)
}

/** Queue a message for a session that is busy. Returns the entry and the
 *  sentence to show beside it — which says whether these words outlive the
 *  window — or a refusal with the sentence the composer should show. */
export function enqueue(sessionId, text) {
  hydrate()
  const session = usableSession(sessionId)
  const clean = usableText(text)
  if (!session) return { ok: false, sentence: 'This agent has no session to queue for yet. Start it first.' }
  if (!clean) return { ok: false, sentence: 'Write the message first, then queue it.' }
  if (clean.length > MAX_TEXT) return { ok: false, sentence: TEXT_TOO_LONG }
  const queue = queues.get(session) || []
  /* THE SEAT A TAKEN, UNSETTLED ENTRY HOLDS COUNTS TOO -- see checkedOut
     above. Without this, a message out for delivery is invisible to this
     check for as long as its send is in flight, and a refused delivery
     returning it through requeueFront() can carry the queue one past the
     cap this very refusal exists to hold. */
  const reserved = checkedOut.get(session) || 0
  if (queue.length + reserved >= MAX_PER_SESSION) {
    return { ok: false, sentence: `This agent already has ${MAX_PER_SESSION} messages waiting. Let it answer some first.` }
  }
  const entry = Object.freeze({ id: `ob-${++sequence}`, text: clean, atMs: Date.now() })
  queue.push(entry)
  queues.set(session, queue)
  settle(session)
  return { ok: true, entry, sentence: persistence().sentence }
}

/** The queue for one session, oldest first, frozen. */
export function list(sessionId) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return Object.freeze([])
  return Object.freeze([...(queues.get(session) || [])])
}

/** REWRITE ONE WAITING MESSAGE WITHOUT MOVING IT.
 *
 * The composer's up-arrow recall (src/composer-queue-recall.js) hands a person
 * a queued message back to edit. Committing that edit as cancel()+enqueue()
 * would be wrong in a way nobody would report as a bug: enqueue() appends, so
 * fixing a typo in the FIRST of three waiting messages would silently send it
 * LAST. Order is the person's own sequencing and this store's stated contract
 * ("oldest first — the order the person said it", tools/test/session-outbox.test.mjs),
 * so an edit keeps both the entry's place and its id.
 *
 * The id is kept because it is the recall's anchor across a repaint: the walk
 * re-reads list() on every keypress and finds where it is by id, so a new id
 * here would make the person's own edit look exactly like the entry having
 * been drained out from under them.
 *
 * Same bounds as enqueue — a message is capped like the composer that wrote
 * it, and empty is a refusal with a sentence, never a deletion. Unqueue is the
 * one door out of this store for words a person wants gone, and it says so on
 * a button; an edit that emptied a box must not become a second, silent one.
 *
 * AN EDIT IS A CHANGE TO THE QUEUE, SO IT IS SAVED LIKE ONE. MEASURED
 * 2026-09-03 on this store as it stood: queue 'teh refactor', edit it to 'the
 * refactor' through this door, then restart the module (a fresh window reads
 * only what is on disk) and the queue comes back
 * ['teh refactor', 'second thing', 'third thing'] — the typo the person had
 * already fixed. This door wrote to memory and announced, and the saved copy
 * still held the words the person replaced. Worse than losing it quietly:
 * persistence() went on answering durable:true, because the last WRITE — the
 * enqueue before the edit — had landed, so the composer's sentence said "it is
 * saved on this computer if you close the window first" about text that was
 * not saved at all. settle() is persist-then-announce for exactly this reason.
 *
 * Returns { ok: true, entry } or { ok: false, sentence }. */
export function replace(sessionId, entryId, text) {
  /* Before settle() can reach the disk, memory has to be the whole truth:
     persist() writes what `queues` holds, so saving from a module that has not
     read the previous run's queue back yet would erase it. */
  hydrate()
  const session = usableSession(sessionId)
  const clean = usableText(text)
  if (!session) return { ok: false, sentence: 'This agent has no session to queue for yet. Start it first.' }
  if (!clean) return { ok: false, sentence: 'Write the message first, then queue it.' }
  if (clean.length > MAX_TEXT) return { ok: false, sentence: TEXT_TOO_LONG }
  const queue = queues.get(session) || []
  const index = queue.findIndex(entry => entry.id === entryId)
  if (index === -1) return { ok: false, sentence: 'That message is no longer waiting; it has already gone or been removed.' }
  /* Nothing changed, so there is nothing to save; the saved copy already says
     this. Announcing here would repaint every mounted strip on every keypress
     of a walk that touched nothing. */
  if (queue[index].text === clean) return { ok: true, entry: queue[index] }
  const entry = Object.freeze({ ...queue[index], text: clean })
  if (sendHolds.has(entryId) && !canSaveEntry(session, entry)) {
    return { ok: false, sentence: HOLD_TOO_LARGE }
  }
  const previous = queue[index]
  queue[index] = entry
  if (sendHolds.has(entryId)) {
    persist()
    if (persistState.write !== 'ok') {
      queue[index] = previous
      persist()
      return { ok: false, sentence: HOLD_NOT_SAVED }
    }
    announce(session)
  } else settle(session)
  return { ok: true, entry }
}

/** Unqueue one message by id. True if something was removed. */
export function cancel(sessionId, entryId) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return false
  const queue = queues.get(session) || []
  const index = queue.findIndex(entry => entry.id === entryId)
  if (index === -1) return false
  sendHolds.delete(entryId)
  queue.splice(index, 1)
  if (queue.length === 0) queues.delete(session)
  settle(session)
  return true
}

/** Keep Send now durable through the interrupt and transport acknowledgement.
 *  take() reserves the current text once; confirm() removes it only after
 *  acceptance. A rejected transport leaves an unconfirmed row for manual retry. */
export function holdForSend(sessionId, { entryId = null, text = '' } = {}) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return { ok: false, sentence: 'This agent has no session to queue for yet. Start it first.' }
  const waiting = queues.get(session) || []
  if (waiting.some(entry => sendHolds.has(entry.id))) {
    return { ok: false, sentence: 'A Send now is already waiting for this agent to stop.' }
  }
  let entry = entryId ? waiting.find(item => item.id === entryId) : null
  if (entryId && !entry) {
    return { ok: false, sentence: 'That message is no longer waiting; it has already gone or been removed.' }
  }
  const clean = entry ? entry.text : usableText(text)
  if (!clean) return { ok: false, sentence: 'Write the message first, then queue it.' }
  if (clean.length > MAX_TEXT) return { ok: false, sentence: TEXT_TOO_LONG }
  if (!canSaveEntry(session, { ...(entry || { text: clean, atMs: Date.now() }), deliveryUnconfirmed: true })) {
    return { ok: false, sentence: HOLD_TOO_LARGE }
  }
  if (!entry && waiting.length + (checkedOut.get(session) || 0) >= MAX_PER_SESSION) {
    return { ok: false, sentence: `This agent already has ${MAX_PER_SESSION} messages waiting. Let it answer some first.` }
  }
  if (!entry) entry = Object.freeze({ id: `ob-${++sequence}`, text: clean, atMs: Date.now() })
  /* A row held again is no longer in the hold it was named for: the person
     pressed Retry send on it, so the strip must stop saying it is waiting on
     a release that this new press is about to ask for. */
  else if (entry.heldReason) {
    const { heldReason: previousReason, ...rest } = entry
    entry = Object.freeze(rest)
  }
  const hold = { session, sending: false }
  sendHolds.set(entry.id, hold)
  // Commit the new order and actual storage write before announcing success.
  // A refused write restores the old queue; the caller still owns its draft.
  queues.set(session, [entry, ...waiting.filter(item => item.id !== entry.id)])
  persist()
  if (persistState.write !== 'ok') {
    sendHolds.delete(entry.id)
    if (waiting.length) queues.set(session, waiting)
    else queues.delete(session)
    persist()
    return { ok: false, sentence: HOLD_NOT_SAVED }
  }
  announce(session)
  return {
    ok: true,
    entry,
    release() {
      if (!hold.sending && sendHolds.get(entry.id) === hold) sendHolds.delete(entry.id)
    },
    take() {
      if (hold.sending || sendHolds.get(entry.id) !== hold) return null
      const waiting = queues.get(hold.session) || []
      const index = waiting.findIndex(item => item.id === entry.id)
      if (index < 0) return null
      // Until the host acknowledges, delivery is uncertain. Keep the exact
      // words on disk and excluded from automatic drains across a restart.
      const current = waiting[index]
      waiting[index] = Object.freeze({ ...current, deliveryUnconfirmed: true })
      hold.sending = true
      settle(hold.session)
      return current
    },
    confirm() {
      if (sendHolds.get(entry.id) !== hold) return false
      return cancel(hold.session, entry.id)
    },
    /* `heldReason` NAMES WHY THE WORDS ARE STILL HERE. A Send now whose stop
       never reported idle inside the composer's release budget comes back
       through this door with a reason; the strip paints that reason on the
       row so the person sees a named hold, not a row that silently went back
       to "Send now". Not persisted (savedEntry), like every other heldReason
       in this store: it describes this run's wait, and after a restart the
       honest state is a plain queued entry. Cleared the moment the entry is
       held again (holdForSend) or restored without one. */
    restore({ unconfirmed = true, heldReason = null } = {}) {
      if (sendHolds.get(entry.id) !== hold) return false
      const waiting = queues.get(hold.session) || []
      const index = waiting.findIndex(item => item.id === entry.id)
      if (index < 0) return false
      const { deliveryUnconfirmed: previous, heldReason: previousReason, ...current } = waiting[index]
      const reason = typeof heldReason === 'string' && heldReason.trim() ? heldReason.trim() : null
      waiting[index] = Object.freeze({
        ...current,
        ...(unconfirmed ? { deliveryUnconfirmed: true } : {}),
        ...(reason ? { heldReason: reason } : {}),
      })
      sendHolds.delete(entry.id)
      settle(hold.session)
      return true
    },
  }
}

/** Hand the view exactly ONE message to send, removing it from the queue.
 *  The turn-completed listener is the only intended caller. */
export function takeNext(sessionId) {
  if (drainHolds.get(sessionId)?.size) return null
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return null
  const queue = queues.get(session) || []
  // The explicit Send now owns the next turn until it sends or releases.
  // A completion racing its interrupt must not drain it or a different row.
  // WHOLE-QUEUE ON PURPOSE: the person pressed Send now on one row and that row
  // has claimed the next boundary wherever it happens to sit, so no other row
  // may take the boundary out from under it.
  if (queue.some(entry => sendHolds.has(entry.id))) return null
  /* AN UNCONFIRMED ENTRY BLOCKS ONLY ITSELF.
   *
   * This condition used to ride in the `some()` above, and that made one entry
   * whose delivery the transport never acknowledged stop delivery for the WHOLE
   * session, with nothing to clear it and nothing to retry it. Not "queues for
   * an hour" -- queues forever. MEASURED 2026-09-18 on a packaged candidate:
   * reach that state, then send a fresh message, let a real turn run to
   * `turn_completed` (22:27:23.870Z), and the queue does not move. The session
   * is idle, the strip still draws Send now on the message behind it, and it
   * never goes. That is the owner's "I cannot message agents".
   *
   * Holding the unconfirmed entry ITSELF is right and stays: the words were
   * handed to the transport and may already have reached the agent, so
   * re-sending them automatically would deliver the person's instruction twice.
   *
   * WHY NO TIMEOUT-THEN-RETRY. A timer that re-sends is a decision to treat
   * silence as failure and risk the duplicate. The tree courier already faced
   * this exact fork and chose the other way -- "Its queued copy is held to
   * avoid delivering it twice; restart this agent to recover its durable
   * inbox." Two couriers in one product resolving the same uncertainty in
   * opposite directions is worse than either rule, and the guess that goes
   * wrong here sends an agent a second copy of an instruction, which can change
   * what it does. A held message the person can see and release in one press is
   * recoverable; a duplicated instruction is not.
   *
   * THE COST, STATED: skipping the held entry delivers the messages queued
   * AFTER it first, so a later Retry send puts it in behind them. That is a
   * reorder, and this store's contract is the order the person said things. It
   * is the lesser loss -- the entry stays drawn in its place with its reason and
   * its Retry send / Unqueue buttons, so the person can see exactly what is out
   * of order and why, whereas the old rule delivered NOTHING and explained
   * nothing. */
  const index = queue.findIndex(entry => entry.deliveryUnconfirmed !== true)
  if (index < 0) return null
  const [entry] = queue.splice(index, 1)
  if (queue.length === 0) queues.delete(session)
  if (!entry) return null
  /* This entry's seat rides with it, off the array and into checkedOut,
     until requeueFront() or confirmDelivered() says which way it landed. */
  checkedOut.set(session, (checkedOut.get(session) || 0) + 1)
  /* AND SO DOES ITS OWN IDENTITY. The ticket is what lets a later Stop or
     resume answer for THIS delivery and not for one taken after it -- see
     outstandingDeliveries above for the message that got deleted without it.
     The oldest is forgotten at the bound rather than held forever for a call
     that will never answer. */
  if (outstandingDeliveries.size >= MAX_OUTSTANDING_DELIVERIES) {
    const oldest = outstandingDeliveries.keys().next()
    if (!oldest.done) outstandingDeliveries.delete(oldest.value)
  }
  const ticket = (deliveryTickets += 1)
  outstandingDeliveries.set(ticket, session)
  settle(session)
  /* A copy, because the entry in the array is frozen and this ticket belongs
     to the delivery rather than to the words. */
  return Object.freeze({ ...entry, [DELIVERY_TICKET]: ticket })
}

/** A send that was taken and then refused goes back to the FRONT — it is
 *  still the next thing the person said, and losing it to a transient refusal
 *  would be the dead end this store exists to remove.
 *
 *  THE SESSION IT GOES BACK TO IS NOT ALWAYS THE ONE IT WAS TAKEN FROM. A
 *  resume between the take and this refusal redirects it to the session that
 *  agent now runs under (deliveryRedirect, set by moveSession()); a Stop in
 *  that same window means there is nowhere left to put it (clearSession()).
 *  Returns false for that second case -- the one time this door refuses a
 *  re-arriving entry instead of taking it back, because the session it was
 *  taken from no longer exists anywhere this store or the view can reach. */
export function requeueFront(sessionId, entry) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session || !entry || typeof entry.text !== 'string') return false
  const target = resolveDeliveryTarget(session, entry)
  if (target === null) return false
  const queue = queues.get(target) || []
  /* The ticket described the delivery, which is over; what goes back in the
     array is the words. Stripped here as well as being unserialisable, so
     nothing downstream ever sees a field that means "in flight" on an entry
     that is sitting still. */
  const restored = { ...entry }
  delete restored[DELIVERY_TICKET]
  queue.unshift(Object.freeze(restored))
  queues.set(target, queue)
  /* The seat checkedOut held for this entry moves back into the array with
     it -- released here, or the next enqueue() would be refused for a
     reservation nothing is holding any more. Released on the TARGET: a
     redirect (above) already moved the reservation there, in moveSession(). */
  releaseSeat(target)
  settle(target)
  return true
}

/** THE OTHER WAY A TAKEN ENTRY SETTLES: it reached the wire and will not
 *  return. Releases the seat checkedOut held open for it while its delivery
 *  was unresolved -- see requeueFront() for the first way, and checkedOut
 *  above for why a seat is held at all. Called once per successful send,
 *  from the one place that ever sends a taken entry (drainOutboxMessage in
 *  src/views/computers.js). A session nobody reserved for is a no-op. */
export function confirmDelivered(sessionId, entry) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return
  /* Same redirect as requeueFront(): a resume between the take and this
     confirmation moved the reservation to the new session id, and the seat
     must close there or it never closes at all. A Stop in that window
     (target === null) already dropped the reservation itself, in
     clearSession() -- nothing left here to release.
     The entry is what names WHICH delivery this is confirming; a caller that
     does not pass it gets the session's own answer, which is right whenever
     nothing has moved or stopped underneath the delivery. */
  const target = resolveDeliveryTarget(session, entry)
  if (target !== null) releaseSeat(target)
}

/** MAKE THIS ONE THE NEXT ONE OUT.
 *
 * The strip's promote door needs this and there was nothing to build it from:
 * cancel-then-enqueue is the only shape the store offered, and enqueue appends,
 * so "send this one first" landed it LAST. MEASURED 2026-09-03 against the real
 * composer (three queued messages alpha/bravo/charlie, the strip's own button
 * pressed on row 1): the queue came back ['bravo','charlie','alpha'].
 *
 * Moves an entry that is ALREADY waiting; it never admits a new one, so the
 * per-session bound cannot be walked around through this door. Returns false
 * for an id that is not waiting -- "it is gone" and "it moved" are different
 * answers and the caller says which.
 *
 * THE ORDER IS SAVED TOO, BECAUSE THE ORDER IS THE ANSWER. MEASURED 2026-09-03
 * on this store as it stood: queue alpha/bravo/charlie, press Send now on
 * charlie, and memory reads ['charlie','alpha','bravo'] while the saved copy
 * still reads ['alpha','bravo','charlie'] -- so a restart undoes the one thing
 * the button exists to do, and charlie goes out LAST again. That is the same
 * defect promoteFront was written to remove (cancel-then-enqueue landed it
 * last), surviving one restart later. Order is this store's stated contract
 * ("oldest first — the order the person said it"), so a change to it is a
 * change to save, not a repaint. */
export function promoteFront(sessionId, entryId) {
  /* See replace(): persist() writes what `queues` holds, so a save from an
     un-hydrated module would erase the previous run's queue instead of it. */
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return false
  const queue = queues.get(session) || []
  const index = queue.findIndex(entry => entry.id === entryId)
  if (index === -1) return false
  /* Already first: true because it IS next out, and no write because nothing
     moved. */
  if (index === 0) return true
  const [entry] = queue.splice(index, 1)
  queue.unshift(entry)
  settle(session)
  return true
}

/** THE SAME WORDS, THE SAME AGENT, A NEW SESSION.
 *
 * A resume closes one session and opens another over the SAME node: the person
 * is still talking to the agent in that circle, and the messages waiting in the
 * queue are still addressed to it. They used to be destroyed at that moment --
 * resumeNodeSession called clearSession on the old id -- so a message the
 * composer had already promised would "send by itself when this turn finishes"
 * vanished without a word, and the only thing that had happened was that the
 * agent came back under a new name.
 *
 * This is deliberately not the same act as clearSession, which stays for the
 * two places where the words really have nowhere to go: Stop (the person ended
 * the conversation, and it says how many were dropped) and "start over".
 *
 * Anything already waiting at the destination keeps its place at the front: it
 * was said first. Returns how many moved. */
export function moveSession(fromSessionId, toSessionId, { preserveAll = false } = {}) {
  hydrate()
  const from = usableSession(fromSessionId)
  const to = usableSession(toSessionId)
  if (!from || !to || from === to) return 0
  const carried = queues.get(from) || []
  const reserved = checkedOut.get(from) || 0
  /* NOT "carried.length === 0" ALONE. A delivery taken from FROM can be out
     on the wire with nothing left in the array -- takeNext() removes it from
     `queues` the instant it hands it out, see checkedOut above -- and that
     delivery is exactly as much "the messages waiting for the old session" as
     anything still sitting in the array. Returning here on the array alone
     used to leave it un-redirected: FROM's reservation stayed put while every
     other map the view keeps had already moved on to TO, and when that
     delivery was later refused, requeueFront() found FROM with nothing to
     return it to and rebuilt a queue there that no list() or takeNext() call
     would ever read again. See outstandingDeliveries above. */
  if (carried.length === 0 && reserved === 0) return 0
  // Recovery cannot retire the source queue if any row or delivery seat would
  // be discarded. Refuse before changing either queue, ticket or Send now hold.
  if (preserveAll && carried.length + reserved + (queues.get(to)?.length || 0)
    + (checkedOut.get(to) || 0) > MAX_PER_SESSION) {
    throw Object.assign(new Error('Session queue has no room for recovery'), { code: 'SESSION_OUTBOX_CAPACITY' })
  }
  queues.delete(from)
  checkedOut.delete(from)
  if (reserved > 0) {
    /* The reservation moves WITH the redirect: FROM's claim on the cap
       becomes TO's, the same as the entry itself would if it were sitting in
       the array instead of out for delivery. Every delivery outstanding on
       FROM right now moves, in whatever order they settle -- and only those,
       because each is named by its own ticket rather than by a count that a
       delivery taken after this move could spend instead. */
    redirectOutstandingDeliveries(from, to)
    checkedOut.set(to, (checkedOut.get(to) || 0) + reserved)
  }
  const waiting = queues.get(to) || []
  /* THE SAME CAP, THE SAME RULE AS enqueue() -- see checkedOut above. A seat
     already reserved at the destination (a delivery already out for it,
     unresolved -- including any just redirected from FROM above) is exactly
     as real a claim on MAX_PER_SESSION as anything sitting in the array, and
     a merge that ignored it could hand the destination its own seat's worth
     of room a second time: reserved 1 there, merge a full 12 in because the
     array alone still read as empty, and a later refused delivery's
     requeueFront() -- the very door this store uses to put a taken entry
     back -- lands the array at 13. Bounding the merge by the room the
     reservation leaves, rather than by MAX_PER_SESSION outright, keeps this
     door honoring the number enqueue() already does. */
  const room = Math.max(0, MAX_PER_SESSION - (checkedOut.get(to) || 0))
  const merged = [...waiting, ...carried].slice(0, room)
  queues.set(to, merged)
  const keptIds = new Set(merged.map(entry => entry.id))
  for (const entry of [...waiting, ...carried]) {
    const hold = sendHolds.get(entry.id)
    if (!hold) continue
    if (keptIds.has(entry.id)) hold.session = to
    else sendHolds.delete(entry.id)
  }
  /* One write for the pair, then both announcements: the move is a single
     change to the store and saving it twice would leave a window in which the
     words are recorded under neither address. */
  persist()
  announce(from)
  announce(to)
  return merged.length - waiting.length
}

/** A closed session's drafts have no address; drop them and say how many. */
export function clearSession(sessionId) {
  hydrate()
  const session = usableSession(sessionId)
  if (!session) return 0
  const queue = queues.get(session) || []
  const reserved = checkedOut.get(session) || 0
  for (const entry of queue) sendHolds.delete(entry.id)
  queues.delete(session)
  checkedOut.delete(session)
  /* A delivery already taken from this session and still out on the wire is
     not in `queue` above -- takeNext() already removed it, see checkedOut --
     but it is exactly as dropped as everything that was: Stop means these
     words have nowhere to go, so its eventual refusal must find nowhere too,
     rather than requeueFront() rebuilding a queue under an id this store has
     just thrown away. See outstandingDeliveries above. Every delivery
     outstanding on this session has nowhere to go, not just whichever asks
     first -- and NOT a delivery taken after this Stop, which is a message the
     person wrote afterwards and has a live queue to go back to. */
  if (reserved > 0) redirectOutstandingDeliveries(session, null)
  /* Saved before announced, and saved even when the queue was already empty:
     Stop and start-over are the two acts that mean these words have nowhere to
     go, so the copy on disk must stop holding them too. Announce only when
     something really went, which is what the old line meant. */
  persist()
  if (queue.length > 0) announce(session)
  return queue.length
}
