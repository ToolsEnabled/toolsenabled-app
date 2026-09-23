/* THE HOME PAGE'S COORDINATOR CONVERSATION ON THE SHARED CHAT SURFACE.
 *
 * Owner, verbatim: "the chat in the chat view needs to be the same as every
 * chat surface in the app. look at the newer version to help understand
 * better." The newer version is buildChat (src/components.js), which every
 * other conversation in the app mounts. The home feed had its own transcript
 * painter -- .turn rows in .log-turns, its own fold, chips and scroll pin, no
 * working row, no activity orbit, no composer state machine.
 *
 * WHY THIS IS AN ADAPTER AND NOT A REROUTE. On 2026-08-27 both worlds were
 * pointed at buildChat and expanding page one replaced the working coordinator
 * conversation with an EMPTY, DISABLED surface ("The coordinator cannot be
 * messaged yet"); tools/test/home-chat-takeover.test.mjs pins that revert. The
 * cause: a live coordinator has no data path into the shared surface. Its
 * turns arrive as polled thread SNAPSHOTS (fetchCoordinator -> noteContext),
 * its sender is postBridgeAction('thread-reply') behind the write flag, and
 * the surface's responding phase is driven only by openStream/push or
 * status.step -- which a polled list never produces on its own.
 *
 * So this file feeds the surface three things it cannot get from a snapshot:
 *   HISTORY   the first snapshot, as buildChat history entries;
 *   TURNS     each later snapshot DIFFED against what is painted -- the
 *             person's line through addOwnerMessage, an agent's line through
 *             openStream/push, kept OPEN while the text is still growing
 *             between polls (that is what makes the responding row appear)
 *             and closed once a poll leaves it unchanged;
 *   STATUS    busy while the last painted line is the person's with no answer
 *             yet, or while a stream is open; the surface's own state machine
 *             turns that into the working row and the stop face.
 * and it wraps the audited sender so the surface's optimistic bubble is
 * confirmed by the bridge receipt or retracted with the refusal.
 *
 * Nothing here touches the DOM directly. The surface is whatever object the
 * caller hands in with buildChat's public shape (addOwnerMessage,
 * confirmOwnerMessage, openStream, addNote), so the tests drive it with a
 * recorder and assert BEHAVIOUR: which door was used for which turn.
 */

/* The home thread's speakers. `who` (the sample) or `sender` (the coordinator
   projection) name the speaker; 'you' is the person, 'action' is a recorded
   action line, anything else is an agent. */
export const OWNER_WHO = 'you'
const speakerOf = turn => {
  const who = turn && (turn.who ?? turn.sender)
  return typeof who === 'string' ? who.trim() : ''
}
const textOf = turn => (turn && typeof turn.text === 'string') ? turn.text : ''
const idOf = turn => (turn && (typeof turn.id === 'string' || typeof turn.id === 'number')) ? String(turn.id) : null

/* WHO A TURN IS, as one of three kinds: 'you' (the person), 'action' (a line
   the product wrote), 'agent' (anyone else). The literal ids 'you' and 'action'
   are the run rows' vocabulary; the THREAD speaks the ids of FLEET.speakers
   ('owner', 'codex', ...), and the home view resolves those through its cast
   (turnSpeaker -> cls 'is-owner' / 'is-act'). tools/test/home-chat-structure
   caught exactly this once before -- neither literal ever matched and every
   line went through markdown -- so the caller may pass its own `classify`
   and the literals are only the default. */
export const defaultClassify = turn => {
  const speaker = speakerOf(turn)
  return speaker === OWNER_WHO ? 'you' : speaker === 'action' ? 'action' : 'agent'
}

/* A polled turn as a buildChat history entry. Exported so the mount can paint
   the first snapshot through buildChat's own history door. */
export function historyEntry(turn, classify = defaultClassify) {
  const text = textOf(turn)
  if (!text) return null
  const kind = classify(turn)
  if (kind === 'you') return { who: 'you', text }
  if (kind === 'action') return { who: 'note', text }
  const entry = { who: 'agent', text }
  const id = idOf(turn)
  if (id) entry.id = id
  return entry
}

export function toHistory(turns, classify = defaultClassify) {
  return (Array.isArray(turns) ? turns : []).map(turn => historyEntry(turn, classify)).filter(Boolean)
}

/* Do two turns describe the same line? By id when both carry one, otherwise
   by speaker and text. A growing agent line keeps its id and changes its
   text, which is exactly the case the feed has to treat as "the same line,
   longer" rather than "a new line". */
const sameTurn = (a, b) => {
  if (!a || !b) return false
  if (speakerOf(a) !== speakerOf(b)) return false
  const ia = idOf(a), ib = idOf(b)
  if (ia && ib) return ia === ib
  return textOf(a) === textOf(b)
}

export function createCoordinatorFeed({ chat, initial = [], classify = defaultClassify } = {}) {
  if (!chat) throw new Error('createCoordinatorFeed needs the mounted chat surface')
  const listeners = new Set()
  /* The turns this feed believes are on the screen, in order. The first
     snapshot is painted by the caller through buildChat's history door, so it
     is recorded here as already painted. */
  let painted = (Array.isArray(initial) ? initial : []).map(turn => ({ ...turn }))
  /* The agent line whose stream is still open, if any. */
  let open = null // { index, text, stream }
  /* Ids of lines this feed streamed and has since closed. The surface has no
     door to reopen a closed live row, so if one of these grows again the feed
     reports it and the caller remounts from history rather than painting a
     second row for the same line. */
  const settled = new Set()
  /* The last snapshot identity the caller named. A poll that leaves a growing
     line unchanged settles it; a mere repaint of the same snapshot must not,
     so the caller passes the snapshot's identity and only a NEW one counts. */
  let lastSnapshot = null
  /* Lines the person sent from THIS surface that the poll has not echoed yet.
     The surface painted them optimistically; the echo must not paint twice. */
  const pendingOwner = []
  let disposed = false

  const notify = () => { for (const fn of [...listeners]) { try { fn() } catch { /* a listener never costs the feed */ } } }

  const closeOpen = (finalText) => {
    if (!open) return
    /* Cleared BEFORE close(): the surface repaints its working row from
       status.busy() inside close, and a still-set `open` would paint it busy. */
    const closing = open
    open = null
    if (closing.id) settled.add(closing.id)
    try { closing.stream.close(finalText ?? closing.text) } catch { /* the surface may be gone */ }
  }

  const paintNew = (turn) => {
    const kind = classify(turn), text = textOf(turn)
    if (!text) return
    if (kind === 'you') {
      const at = pendingOwner.indexOf(text)
      if (at !== -1) { pendingOwner.splice(at, 1); return }
      closeOpen()
      chat.addOwnerMessage(text)
      return
    }
    if (kind === 'action') { closeOpen(); chat.addNote?.(text); return }
    closeOpen()
    const stream = chat.openStream({ turnStamp: idOf(turn) })
    stream.push(text)
    open = { index: painted.length, text, stream, id: idOf(turn) }
  }

  /* One polled snapshot. The common case is "the same list, perhaps with a
     longer last line or a few new ones", and that is handled without touching
     any painted row. A snapshot that REWRITES painted history (a line vanished
     or changed above the tail) is reported so the caller can remount; this
     feed never silently repaints over rows a person may be reading. */
  const apply = (turns, { snapshot } = {}) => {
    if (disposed) return { ok: false, reason: 'disposed' }
    const next = Array.isArray(turns) ? turns : []
    const newSnapshot = snapshot !== undefined && snapshot !== lastSnapshot
    if (snapshot !== undefined) lastSnapshot = snapshot
    let common = 0
    while (common < painted.length && common < next.length && sameTurn(painted[common], next[common])) common++
    if (common < painted.length) return { ok: false, reason: 'rewritten', at: common }
    /* A HISTORY ROW THAT GROWS. The last line of the first snapshot was painted
       through buildChat's history door and has no stream; when a poll finds it
       longer under the same id, the surface's own resume door (openStream with
       entryId) binds a stream to that restored row, so it grows in place and
       shows as responding exactly like a line that arrived live. */
    if (!open && painted.length && next.length >= painted.length) {
      const index = painted.length - 1
      const was = painted[index], now = next[index]
      const id = idOf(was)
      if (id && classify(was) === 'agent' && textOf(now) !== textOf(was)) {
        if (settled.has(id)) return { ok: false, reason: 'regrown', at: index }
        const stream = chat.openStream({ entryId: id, turnStamp: id })
        open = { index, text: textOf(was), stream, id }
      }
    }
    // a growing (or settled) open line
    if (open && open.index < next.length) {
      const nowText = textOf(next[open.index])
      if (nowText !== open.text) { open.text = nowText; open.stream.push(nowText) }
      else if (newSnapshot && next.length === painted.length) closeOpen(nowText) // a NEW poll left it unchanged: settled
    }
    for (let i = painted.length; i < next.length; i++) paintNew(next[i])
    painted = next.map(turn => ({ ...turn }))
    if (open && open.index !== painted.length - 1) closeOpen()
    notify()
    return { ok: true, added: next.length - common }
  }

  /* The person's line, sent from this surface: remembered so the poll's echo
     is not painted a second time. */
  const sentByPerson = (text) => { if (typeof text === 'string' && text.trim()) { pendingOwner.push(text.trim()); notify() } }
  const unsent = (text) => { const at = pendingOwner.indexOf(typeof text === 'string' ? text.trim() : ''); if (at !== -1) { pendingOwner.splice(at, 1); notify() } }

  const awaitingReply = () => {
    const last = painted[painted.length - 1]
    return Boolean(last) && classify(last) === 'you'
  }

  /* buildChat's status contract: busy() decides the working row and the stop
     face; subscribe() wakes the surface on change. step() stays empty on
     purpose: the surface names the phase itself -- thinking while it waits,
     responding once the open stream has shown words -- and a step string
     here would be painted as a tool step ("working") over that. */
  const status = {
    busy: () => !disposed && (open !== null || awaitingReply() || pendingOwner.length > 0),
    step: () => '',
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }

  const dispose = () => { disposed = true; closeOpen(); listeners.clear() }

  return { apply, status, sentByPerson, unsent, dispose, get painted() { return painted.slice() }, get streaming() { return open !== null } }
}

/* The sender buildChat is handed: the audited bridge action, with the
   surface's optimistic bubble confirmed by the receipt or retracted with the
   refusal. `post` is postBridgeAction (injected so this is testable);
   `feed` is the coordinator feed above so the poll's echo is deduplicated. */
export function createCoordinatorSender({ post, feed, copy, threadId = 'owner-thread', newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now())) }) {
  if (typeof post !== 'function') throw new Error('createCoordinatorSender needs the bridge action')
  const feedOf = typeof feed === 'function' ? feed : () => feed
  return async (text, doors = {}) => {
    const message = typeof text === 'string' ? text.trim() : ''
    if (!message) return
    const live = feedOf()
    live?.sentByPerson(message)
    let result = null
    try {
      result = await post('thread-reply', { idempotencyKey: newId(), threadId, message })
    } catch (error) {
      result = { ok: false, error }
    }
    if (result && result.ok) {
      doors.accepted?.(result.receipt || null)
      return result
    }
    live?.unsent(message)
    doors.note?.(copy?.replyRefused || 'The message was not sent.', { retract: true })
    return result || { ok: false }
  }
}
