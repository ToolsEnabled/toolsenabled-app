/* A COMPUTER'S OWN CONVERSATIONS, OPENED FROM A SIGNED-IN BROWSER.
 *
 * On a phone or any browser driving a computer through the website, this same
 * app runs with `window.mcDesktopSessions` beside `window.mcAgent`. That global
 * requires three conversation calls:
 *
 *   list()                              the running conversations the computer's
 *                                       own window started, with `openable` and
 *                                       a refusal code for the ones it is not
 *   transcript({ sessionId, limit })    that conversation's saved messages,
 *                                       oldest first; a successful read also
 *                                       starts the computer sending its live
 *                                       events to this browser
 *   send({ sessionId, text })           one person message, text only
 *
 * Optional Stop v1 calls use only native list targets, an idempotent request
 * identity, and explicit status reads. No generic remote-close fallback exists.
 *
 * The computer decides every step. This module only asks, renders what comes
 * back, and turns refusals into sentences (src/desktop-session-copy.js).
 *
 * WHERE THE GLOBAL IS ABSENT NOTHING CHANGES. The desktop app and older
 * websites have no such global, and every entry point here answers null or
 * does nothing for them, so their pages behave exactly as before.
 *
 * NOTHING HERE IS STORED. Rows, messages and drafts live in memory for the life
 * of the page. A context note in a restored conversation carries no open-state
 * key, because that memory is written to browser storage.
 *
 * NO POLLING. The website marks its reads of these routes as background work so
 * an unattended page does not keep the connection to the computer alive. The
 * view asks again when it becomes visible, when its data source changes, or
 * when the person acts; this module never schedules a read by itself. */

import {
  sessionEndedEvent,
  createSessionTextReader,
  sessionEventTurnId,
  sessionPersonTurn,
  sessionTurnStatus,
  sessionTurnSucceeded,
} from './agent-session-events.js'
import { refusalCodeOf } from './refusal-copy.js'
import { DESKTOP_SESSION_COPY, desktopSendSentence, desktopSessionSentence, sendAnswerWasLost } from './desktop-session-copy.js'

export const DESKTOP_HISTORY_LIMIT = 40
const MAX_ROWS = 200

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const word = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null
const CODE_RE = /^[A-Z][A-Z0-9_]{1,127}$/

/** The global, when this page runs where it exists and it has all three calls. */
export function desktopSessionsBridge(win = globalThis.window) {
  const bridge = win?.mcDesktopSessions
  if (!bridge || typeof bridge.list !== 'function' || typeof bridge.transcript !== 'function' || typeof bridge.send !== 'function') return null
  return bridge
}

/** The code on a rejection or a refusal answer, or the fallback when it has none. */
export function desktopRefusalCode(value, fallback) {
  return refusalCodeOf(value) || refusalCodeOf(value?.error) || fallback
}

/**
 * The list answer, copied field by field. A row that cannot name its session is
 * dropped; every other field that is missing or malformed becomes null. The
 * answer's own `openable` and `refusal` are kept together: a row that says it is
 * openable and also carries a refusal is treated as not openable.
 */
export function readDesktopSessionList(answer) {
  if (!isRecord(answer) || answer.ok !== true || !Array.isArray(answer.sessions)) return null
  const seen = new Set()
  const rows = []
  for (const raw of answer.sessions.slice(0, MAX_ROWS)) {
    if (!isRecord(raw)) continue
    const sessionId = word(raw.sessionId, 128)
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    const refusal = typeof raw.refusal === 'string' && CODE_RE.test(raw.refusal) ? raw.refusal : null
    const openable = raw.openable === true && refusal === null
    rows.push(Object.freeze({
      sessionId,
      agentId: word(raw.agentId, 128),
      nodeId: word(raw.nodeId, 128),
      name: word(raw.name, 120),
      provider: word(raw.provider, 64),
      tier: word(raw.tier, 64),
      busy: typeof raw.busy === 'boolean' ? raw.busy : null,
      turnsCompleted: Number.isSafeInteger(raw.turnsCompleted) && raw.turnsCompleted >= 0 ? raw.turnsCompleted : 0,
      lastTurnStatus: word(raw.lastTurnStatus, 64),
      transcript: raw.transcript === true,
      openable,
      refusal: openable ? null : (refusal || 'MC_AGENT_REMOTE_SESSION_REFUSED'),
      ...(answer.desktopStopVersion === 1 && readDesktopStopTarget(raw.stopTarget, raw)
        ? { stopTarget: readDesktopStopTarget(raw.stopTarget, raw) } : {}),
    }))
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    mayWrite: answer.mayWrite === true,
    truncated: answer.truncated === true || answer.sessions.length > MAX_ROWS,
  })
}

/** Stop authority is copied only from the native list, never inferred from busy. */
export function readDesktopStopTarget(value, row = null) {
  if (!isRecord(value) || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.revision || '')) return null
  const treeId = word(value.treeId, 128), nodeId = word(value.nodeId, 128), sessionId = word(value.sessionId, 128)
  if (![treeId, nodeId, sessionId].every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9._:/-]*$/i.test(id)) || (row && (row.sessionId !== sessionId || row.nodeId !== nodeId))) return null
  return Object.freeze({ version: 1, treeId, nodeId, sessionId, revision: value.revision })
}
const stopKey = target => JSON.stringify(target)
export function readDesktopStopReceipt(answer, request) {
  if (!isRecord(answer) || typeof answer.ok !== 'boolean' || answer.requestId !== request.requestId) return null
  const target = readDesktopStopTarget(answer.target)
  if (!target || stopKey(target) !== stopKey(request.target) || typeof answer.closed !== 'boolean') return null
  if (!['pending', 'completed', 'needs-attention', 'refused'].includes(answer.state)
    || !['pending', 'recorded', 'unconfirmed'].includes(answer.savedState)) return null
  if (answer.state === 'completed' && (answer.ok !== true || !answer.closed || answer.savedState !== 'recorded')) return null
  if (answer.state === 'refused' && (answer.ok !== false || answer.outcome !== 'not-sent' || answer.closed)) return null
  if (answer.state === 'pending' && (answer.ok !== true || answer.closed || answer.savedState !== 'pending')) return null
  if (answer.state === 'needs-attention' && (answer.ok !== true || answer.savedState !== (answer.closed ? 'unconfirmed' : 'pending'))) return null
  return Object.freeze({ ok: answer.ok, requestId: answer.requestId, target, state: answer.state,
    closed: answer.closed, savedState: answer.savedState,
    code: typeof answer.code === 'string' && CODE_RE.test(answer.code) ? answer.code : null })
}

// Retain an admitted/uncertain request across chat remounts in this page. A
// bridge generation is a fence, not native authority. Old-generation records
// can never be queried through a newly selected account or computer.
const stopRecords = new WeakMap()
export function desktopStopController({ bridge, row, mayWrite, isCurrent = () => true,
  randomUUID = () => globalThis.crypto.randomUUID(), changed = () => {}, completed = () => {} }) {
  const target = readDesktopStopTarget(row?.stopTarget, row)
  const supported = bridge?.stopVersion === 1 && typeof bridge.stop === 'function'
    && typeof bridge.stopStatus === 'function' && typeof bridge.stopScope === 'function'
  const scope = supported ? bridge.stopScope() : null
  const current = () => isCurrent() && supported && bridge.stopScope() === scope
  let records = supported ? stopRecords.get(bridge) : null
  if (supported && !records) { records = new Map(); stopRecords.set(bridge, records) }
  const key = target ? `${scope}:${stopKey(target)}` : null
  let record = key ? records?.get(key) : null
  if (target && supported && !record) record = { scope, request: null, receipt: null, busy: false, message: '', consumed: false }
  const sentence = () => record?.message || (!mayWrite ? 'This connection can only read.'
    : !target || !supported ? 'This computer does not offer Stop for this conversation.'
      : !record ? 'Too many unresolved Stop requests. Check them on your computer.'
        : 'Stop only this agent on your computer. Its partial reply will be kept.')
  async function run() {
    if (!current() || !mayWrite || !target || !record) return
    record = records.get(key) || record
    if (record.busy || ['completed', 'refused'].includes(record.receipt?.state)) return
    if (!records.has(key)) {
      for (const [key, value] of records) if (value.scope !== scope || ['completed', 'refused'].includes(value.receipt?.state)) records.delete(key)
      if (records.size >= 64) { record.message = 'Too many unresolved Stop requests. Check them on your computer.'; changed(record.message); return }
      records.set(key, record)
    }
    record.busy = true
    const publish = message => { record.message = message; if (current()) changed(message) }
    try {
      if (!record.request) {
        // A stale menu cannot turn an old target into a new operation.
        const list = readDesktopSessionList(await bridge.list())
        if (!current()) return
        const fresh = list?.rows.find(candidate => candidate.sessionId === target.sessionId)
        if (!list?.mayWrite || stopKey(fresh?.stopTarget) !== stopKey(target)) {
          publish('This agent changed or Stop is unavailable. Select it again.'); return
        }
        const requestId = randomUUID()
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw Error('Stop request identity unavailable')
        record.request = Object.freeze({ requestId, target })
        publish('Asking your computer to stop this agent. Its final state is not confirmed yet.')
        const answer = await bridge.stop(record.request)
        if (!current()) return
        record.receipt = readDesktopStopReceipt(answer, record.request)
      } else {
        publish('Checking the existing Stop request. No new Stop request is being sent.')
        const answer = await bridge.stopStatus({ requestId: record.request.requestId })
        if (!current()) return
        record.receipt = readDesktopStopReceipt(answer, record.request)
      }
      const receipt = record.receipt
      if (!receipt) { publish('The Stop result could not be verified. Check its status; do not send another Stop request.'); return }
      if (receipt.state === 'completed') {
        publish('Your computer stopped this agent and saved its partial reply.')
        if (!record.consumed) { record.consumed = true; completed(receipt) }
      } else if (receipt.state === 'refused') publish('Your computer refused this Stop request. Nothing was stopped by this request. Select the agent again to review its current state.')
      else if (receipt.closed) publish('The agent is closed, but its saved state is not confirmed. Check Stop status or review it on your computer.')
      else publish('Stop is not confirmed yet. Check Stop status or review it on your computer.')
    } catch {
      if (current()) publish(record.request ? 'The Stop answer was lost. Check the existing request status; no new Stop request will be sent.' : 'Stop availability could not be checked. Nothing was sent.')
    } finally {
      record.busy = false
      if (!record.request && records.get(key) === record) records.delete(key)
      if (current()) changed(sentence())
    }
  }
  return { run, get message() { return sentence() }, get request() { return record?.request || null },
    get completed() { return record?.receipt?.state === 'completed' },
    get unresolved() { return Boolean(record?.request && !['completed', 'refused'].includes(record.receipt?.state)) },
    get blocksSend() { return Boolean(record?.request && record.receipt?.state !== 'refused') },
    action: () => ({ id: 'desktop-stop', label: record?.request ? 'Check Stop status' : 'Stop this agent',
      hint: sentence(), disabledHint: sentence(), enabled: Boolean(current() && mayWrite && target && record && !record.busy
        && !['completed', 'refused'].includes(record.receipt?.state)), run: context => { context?.close?.(); return run() } }),
  }
}

/**
 * The started-sessions argument for declaredFleetData(): the page's own live
 * record first, then one record per listed row that names its agent. With no
 * such row the live record is returned unchanged, which is exactly the argument
 * the page passed before this module existed. declaredFleetData keeps the first
 * record per agent and draws only declared agents; the rows it does not draw
 * are the ones desktopSessionsOutsideTree() returns.
 */
export function desktopStartedSessions(live, list) {
  const started = (list?.rows || [])
    .filter(row => row.agentId)
    .map(row => ({ agentId: row.agentId, sessionId: row.sessionId, origin: 'user' }))
  return started.length ? [live, ...started] : live
}

/** Which rows decide what the tree draws, as one comparable string. */
export function desktopTreeSignature(list) {
  return (list?.rows || []).filter(row => row.agentId).map(row => `${row.agentId}\n${row.sessionId}`).join('\n\n')
}

/** The listed rows no drawn node carries, in list order. */
export function desktopSessionsOutsideTree(list, drawnSessionIds) {
  const drawn = drawnSessionIds instanceof Set ? drawnSessionIds : new Set(drawnSessionIds || [])
  return (list?.rows || []).filter(row => !drawn.has(row.sessionId))
}

/** A row's name for a person: the tree's name, else a plain description. */
export function desktopSessionName(row) {
  return row?.name || DESKTOP_SESSION_COPY.unnamed
}

/** A row's short state line: what it runs on and whether it is replying. */
export function desktopSessionFacts(row) {
  if (!row) return ''
  const runsOn = [row.provider, row.tier].filter(Boolean).join(' · ')
  const state = !row.openable ? DESKTOP_SESSION_COPY.notOpenable
    : row.busy === true ? DESKTOP_SESSION_COPY.replying
      : row.busy === false ? DESKTOP_SESSION_COPY.waiting : ''
  return [runsOn, state].filter(Boolean).join(' · ')
}

/**
 * Transcript entries in the shape buildChat's `history` paints. Entries are
 * oldest first already and are deduplicated by their stable id. A note the
 * product added to a prompt folds into a closed context row with no open-state
 * key. A clipped entry is followed by a note saying where the full text is.
 */
export function desktopTranscriptHistory(entries) {
  const history = []
  const ids = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry) || typeof entry.text !== 'string' || entry.text === '') continue
    const id = word(entry.id, 512)
    if (id && ids.has(id)) continue
    if (id) ids.add(id)
    const at = Number.isFinite(entry.at) ? entry.at : undefined
    const turnStamp = word(entry.turnId, 512)
    const context = typeof entry.context === 'string' && Object.hasOwn(DESKTOP_SESSION_COPY.contextSummary, entry.context) ? entry.context : null
    if (context) {
      history.push({ who: 'context', label: DESKTOP_SESSION_COPY.contextLabel, summary: DESKTOP_SESSION_COPY.contextSummary[context], text: entry.text, at, id, turnStamp })
    } else if (entry.who === 'you' || entry.who === 'agent') {
      history.push({ who: entry.who, text: entry.text, at, id, turnStamp })
    } else if (entry.who === 'action') {
      history.push({ who: 'note', text: entry.text, at, id })
    } else {
      continue
    }
    if (entry.clipped === true) history.push({ who: 'note', text: DESKTOP_SESSION_COPY.clipped, at })
  }
  return history
}


/**
 * Transcript pages joined into one conversation, oldest first. Pages are given
 * oldest first; an entry keeps the position of its first appearance and the
 * text of its last, because a later read can hold more of a reply that was
 * still being written. Entries without a stable id cannot be joined and are
 * left out.
 */
export function mergeTranscriptEntries(...pages) {
  const order = []
  const byId = new Map()
  for (const page of pages) {
    for (const entry of Array.isArray(page) ? page : []) {
      if (!isRecord(entry)) continue
      const id = word(entry.id, 512)
      if (!id) continue
      if (!byId.has(id)) order.push(id)
      byId.set(id, entry)
    }
  }
  return order.map(id => byId.get(id))
}

const RECONCILE_LIMIT = 20

const defaultFrame = callback => (typeof globalThis.requestAnimationFrame === 'function'
  ? globalThis.requestAnimationFrame(callback) : setTimeout(callback, 16))
const defaultCancel = handle => (typeof globalThis.cancelAnimationFrame === 'function'
  ? globalThis.cancelAnimationFrame(handle) : clearTimeout(handle))

const isTerminal = (packet, sessionId) => Boolean(sessionTurnStatus(packet, sessionId))
  || (packet?.sessionId === sessionId && packet?.event?.type === 'turn_failed')
const pageOf = answer => (isRecord(answer) && answer.ok === true && Array.isArray(answer.entries) ? answer.entries : null)

/**
 * One desktop conversation, live, in `host`.
 *
 * Not openable: a chat whose composer carries the refusal sentence, and no call.
 *
 * Openable: the events for this session are subscribed FIRST and held, then the
 * transcript is read. The computer starts sending events before it takes the
 * snapshot, so a held event can overlap what the snapshot already shows. The
 * computer also saves a reply while it is still being written, so a reply in
 * the snapshot does not mean its turn is over. So:
 *
 *   - a person message is painted once, keyed by its turn id or entry id;
 *   - live words stream into a bubble only for a turn that has no reply on
 *     screen yet, so words the snapshot already shows are never added twice;
 *   - every turn completion or failure, held or live, reads the transcript
 *     again and repaints each reply to the computer's saved text. That read is
 *     where a reply's final words come from.
 *
 * If the first read fails the held events are discarded and the refusal is
 * shown. When the list said this browser may not send, the composer is off and
 * says why; reading and live updates still work.
 *
 * A send whose answer is lost is never reported as not sent. Its message stays
 * on screen as unconfirmed until the transcript, or the computer's own event
 * for it, shows that it arrived.
 *
 * `isCurrent` is the caller's fence: once it is false, every late answer and
 * event is ignored.
 */
export function mountDesktopSessionChat({
  host,
  row,
  mayWrite = true,
  bridge,
  subscribe = null,
  buildChat,
  title,
  subtitle = '',
  roleKey = 'default',
  tall = true,
  draft = null,
  isCurrent = () => true,
  onEnded = null,
  onStopped = null,
  scheduleFrame = defaultFrame,
  cancelFrame = defaultCancel,
  now = () => Date.now(),
  document: doc = globalThis.document,
}) {
  const sessionId = row.sessionId
  let disposed = false
  let root = null
  let unsubscribe = null
  let painted = false
  let ended = false
  let bound = true
  const held = []
  /* Everything read from the computer so far, oldest first. */
  let known = []
  let olderCursor = null
  let earlierButton = null
  let loadingEarlier = false
  /* Entry ids on screen, and the turn ids of person lines on screen. */
  const shownIds = new Set()
  const personTurns = new Set()
  /* Reply bubbles on screen, by turn id (or entry id when a reply has no turn):
     { handle, entryId, text }. `handle` is null for a restored row that has not
     been repainted; openStream({ entryId }) reuses that row in place. */
  const replies = new Map()
  /* Each pending send owns its receipt callback and replaceable status note.
     Neither is found by text: identical messages may be pending together. */
  const pendingSends = new Set()
  let stream = null
  let streamKey = null
  let streamText = ''
  const sessionTextReader = createSessionTextReader()
  let frame = null
  let reconciling = null
  let reconcileAgain = false

  const alive = () => !disposed && isCurrent()
  let stopNotice = null
  const stop = desktopStopController({ bridge, row, mayWrite, isCurrent: alive,
    changed: message => {
      if (!root || !alive()) return
      if (!stopNotice) { stopNotice = doc.createElement('p'); stopNotice.className = 'rail-prose'; stopNotice.setAttribute('role', 'status'); stopNotice.setAttribute('data-desktop-stop-status', ''); host.appendChild(stopNotice) }
      stopNotice.textContent = message
    }, completed: receipt => { if (alive()) onStopped?.(receipt) },
  })

  const handle = {
    sessionId,
    host,
    ready: null,
    get root() { return root },
    get stopRequestPending() { return stop.unresolved },
    get stopRequestRetained() { return Boolean(stop.request) },
    get stopCompleted() { return stop.completed },
    get reconciled() { return reconciling || Promise.resolve() },
    /* Events may have been lost (the browser's event ring wrapped): keep the
       chat and its draft, and read the transcript again to catch up. */
    resync: () => { if (painted && alive() && root && !ended) void reconcile() },
    exportDraft: () => (root && typeof root.exportDraft === 'function' ? root.exportDraft() : null),
    dispose,
  }

  function mount(config, keptDraft) {
    root?.dispose?.()
    host.replaceChildren()
    stopNotice = null
    root = buildChat({ title, subtitle, roleKey, tall, seed: 0, actions: () => [stop.action()], ...config })
    root.setAttribute?.('data-desktop-chat', '')
    host.appendChild(root)
    if (stop.request) { stopNotice = doc.createElement('p'); stopNotice.className = 'rail-prose'; stopNotice.setAttribute('role', 'status'); stopNotice.setAttribute('data-desktop-stop-status', ''); stopNotice.textContent = stop.message; host.appendChild(stopNotice) }
    if (keptDraft) root.importDraft?.(keptDraft)
    return root
  }

  function refuseOpen(code) {
    host.dataset.refusalCode = code
    mount({ composerReason: desktopSessionSentence(code) }, draft)
  }

  if (!row.openable) {
    refuseOpen(row.refusal || 'MC_AGENT_REMOTE_SESSION_REFUSED')
    handle.ready = Promise.resolve()
    return handle
  }

  const opening = doc.createElement('p')
  opening.className = 'rail-prose is-dim'
  opening.setAttribute('role', 'status')
  opening.setAttribute('data-desktop-chat-opening', '')
  opening.textContent = DESKTOP_SESSION_COPY.opening
  host.replaceChildren(opening)

  if (typeof subscribe === 'function') {
    unsubscribe = subscribe(packet => {
      if (!alive() || !packet || packet.sessionId !== sessionId) return
      if (!painted) { held.push(packet); return }
      applyPacket(packet)
    })
  }

  handle.ready = (async () => {
    let answer = null
    let code = null
    try {
      answer = await bridge.transcript({ sessionId, limit: DESKTOP_HISTORY_LIMIT })
    } catch (error) {
      code = desktopRefusalCode(error, 'BRIDGE_UNREACHABLE')
    }
    if (!alive()) return
    if (!code && (!pageOf(answer) || answer.sessionId !== sessionId)) code = desktopRefusalCode(answer, 'MC_AGENT_TRANSCRIPT_UNAVAILABLE')
    if (code) {
      held.length = 0
      unsubscribe?.()
      unsubscribe = null
      refuseOpen(code)
      return
    }
    bound = answer.bound !== false
    olderCursor = typeof answer.before === 'string' && answer.before ? answer.before : null
    known = mergeTranscriptEntries(answer.entries)
    paintConversation(draft)
    painted = true
    for (const packet of held.splice(0)) {
      if (!alive()) return
      applyPacket(packet)
    }
  })()

  /* The whole conversation from `known`, in a fresh chat. Used for the first
     paint and after earlier messages are loaded; the person's draft is kept. */
  function paintConversation(keptDraft) {
    if (frame !== null) { cancelFrame(frame); frame = null }
    stream = null
    streamKey = null
    streamText = ''
    shownIds.clear()
    personTurns.clear()
    replies.clear()
    const history = desktopTranscriptHistory(known)
    for (const entry of history) {
      if (entry.id) shownIds.add(entry.id)
      if (entry.who === 'you' && entry.turnStamp) personTurns.add(entry.turnStamp)
      if (entry.who === 'agent') replies.set(entry.turnStamp || entry.id, { handle: null, entryId: entry.id, text: entry.text })
    }
    mount(mayWrite ? { history, onSend: send } : { history, composerReason: DESKTOP_SESSION_COPY.readOnly }, keptDraft)
    if (!bound) root.addNote?.(DESKTOP_SESSION_COPY.noSavedConversation)
    /* Pending person lines absent from the record survive an earlier-history
       repaint. Lost answers also retain their latest unresolved status. */
    for (const pending of pendingSends) {
      if (pending.matched) continue
      const currentRoot = root
      const message = currentRoot.addOwnerMessage?.(pending.text)
      pending.confirm = receipt => currentRoot.confirmOwnerMessage?.(message, receipt)
      if (pending.lost) showPendingStatus(pending, pending.status || DESKTOP_SESSION_COPY.sendUnconfirmed)
    }
    paintEarlierButton()
  }

  function paintEarlierButton() {
    if (!olderCursor) { earlierButton?.remove(); earlierButton = null; return }
    if (!earlierButton) {
      earlierButton = doc.createElement('button')
      earlierButton.type = 'button'
      earlierButton.className = 'ctl-btn'
      earlierButton.setAttribute('data-desktop-chat-earlier', '')
      earlierButton.addEventListener('click', () => { void loadEarlier() })
    }
    earlierButton.disabled = loadingEarlier
    earlierButton.textContent = loadingEarlier ? DESKTOP_SESSION_COPY.earlierLoading : DESKTOP_SESSION_COPY.earlier
    if (earlierButton.parentNode !== host || earlierButton.nextSibling !== root) host.insertBefore(earlierButton, root)
  }

  /* One older page, by the cursor the computer gave, plus the newest page read
     again so nothing that arrived meanwhile is lost; then one repaint. It waits
     for a send in flight, whose words must not be repainted away. */
  async function loadEarlier() {
    if (loadingEarlier || !olderCursor || !alive() || !root) return
    if (sendInFlight()) return
    loadingEarlier = true
    paintEarlierButton()
    let older = null
    let newest = null
    let code = null
    try { older = await bridge.transcript({ sessionId, before: olderCursor, limit: DESKTOP_HISTORY_LIMIT }) } catch (error) { code = desktopRefusalCode(error, 'BRIDGE_UNREACHABLE') }
    if (!alive()) return
    if (!code && !pageOf(older)) code = desktopRefusalCode(older, 'MC_AGENT_TRANSCRIPT_UNAVAILABLE')
    if (!code) {
      try { newest = await bridge.transcript({ sessionId, limit: DESKTOP_HISTORY_LIMIT }) } catch (error) { code = desktopRefusalCode(error, 'BRIDGE_UNREACHABLE') }
      if (!alive()) return
      if (!code && !pageOf(newest)) code = desktopRefusalCode(newest, 'MC_AGENT_TRANSCRIPT_UNAVAILABLE')
    }
    loadingEarlier = false
    if (code) {
      if (code === 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID') olderCursor = null
      root.addNote?.(desktopSessionSentence(code))
      paintEarlierButton()
      return
    }
    known = mergeTranscriptEntries(older.entries, known, newest.entries)
    olderCursor = typeof older.before === 'string' && older.before ? older.before : null
    if (sendInFlight()) { paintEarlierButton(); return }
    settleLostSends(newest.entries)
    paintConversation(root.exportDraft?.() || null)
  }

  function applyPacket(packet) {
    if (ended || !root) return
    const person = sessionPersonTurn(packet, sessionId)
    if (person) { paintPerson(person); return }
    if (sessionEndedEvent(packet, sessionId)) { endSession(); return }
    const turnId = sessionEventTurnId(packet, sessionId)
    const speech = sessionTextReader.read(packet, sessionId)
    if (isTerminal(packet, sessionId)) { completeTurn(turnId, packet); return }
    if (speech?.text) { streamWords(turnId, speech.text, speech.breakBefore); return }
  }

  /* A send whose answer has not come back yet. A send whose answer was lost is
     not in flight: it waits for the record, and must not hold anything else. */
  function sendInFlight() {
    for (const pending of pendingSends) if (pending.awaitingAnswer) return true
    return false
  }

  function showPendingStatus(pending, text) {
    pending.note?.remove()
    pending.status = text
    pending.note = root.addNote?.(text) || null
    if (pending.note && pending.code && !pending.matched) pending.note.dataset.refusalCode = pending.code
  }

  /* A send of these exact words that has not been matched to the computer's
     record yet, and that this message could be. */
  function claimPending(text, { turnId = null, id = null } = {}) {
    for (const pending of pendingSends) {
      if (pending.matched || pending.text !== text) continue
      if (turnId && pending.priorTurns.has(turnId)) continue
      if (id && pending.priorIds.has(id)) continue
      pending.matched = true
      pending.turnId = turnId
      pending.confirm?.({ turnId })
      if (!pending.awaitingAnswer) pendingSends.delete(pending)
      if (pending.lost) {
        showPendingStatus(pending, DESKTOP_SESSION_COPY.sendConfirmed)
      }
      return true
    }
    return false
  }

  function paintPerson({ via, text, turnId, at }) {
    if (turnId && personTurns.has(turnId)) return
    /* This browser's own send, confirmed. Its words are already on screen. */
    const own = via === 'remote' && claimPending(text, { turnId })
    if (turnId) personTurns.add(turnId)
    if (own) return
    settleStream()
    root.addOwnerMessage?.(text, { at: at ?? now(), turnStamp: turnId })
  }

  function paintNow() {
    if (frame !== null) { cancelFrame(frame); frame = null }
    if (stream) stream.push(streamText)
  }

  function schedulePaint() {
    if (frame !== null) return
    frame = scheduleFrame(() => {
      frame = null
      if (!disposed && stream) stream.push(streamText)
    })
  }

  function streamWords(turnId, words, breakBefore = false) {
    const key = turnId || streamKey || `live:${now()}`
    /* A reply for this turn is already on screen, from the snapshot or a read.
       Its words come from the read that the turn's completion triggers. */
    if (replies.has(key) && !(stream && streamKey === key)) return
    if (stream && streamKey !== key) settleStream()
    if (!stream) {
      stream = root.openStream?.({ at: now(), turnStamp: turnId }) ?? null
      if (!stream) return
      streamKey = key
      streamText = ''
    }
    if (breakBefore && streamText) streamText += '\n\n'
    streamText += words
    schedulePaint()
  }

  /* The open bubble stops streaming but stays repaintable, so the next read can
     replace its words with the computer's saved text. */
  function settleStream() {
    if (!stream) return
    paintNow()
    stream.close(streamText, { provisional: true })
    if (streamText) replies.set(streamKey, { handle: stream, entryId: null, text: streamText })
    stream = null
    streamKey = null
    streamText = ''
  }

  /* A failed turn says so once, in one fixed sentence. The text a failure
     event carries comes from the program that ran the turn and can hold paths
     or internal detail, so it is never shown here. */
  function completeTurn(turnId, packet) {
    const status = sessionTurnStatus(packet, sessionId)
    const failed = packet.event?.type === 'turn_failed' || (status !== null && !sessionTurnSucceeded(status))
    if (stream && (!turnId || streamKey === turnId)) settleStream()
    if (failed) root.addNote?.(DESKTOP_SESSION_COPY.turnFailed)
    void reconcile()
  }

  function reconcile() {
    if (reconciling) { reconcileAgain = true; return reconciling }
    reconciling = (async () => {
      do {
        reconcileAgain = false
        let answer = null
        try { answer = await bridge.transcript({ sessionId, limit: RECONCILE_LIMIT }) } catch { answer = null }
        if (!alive() || !root) return
        const page = pageOf(answer)
        if (page) {
          known = mergeTranscriptEntries(known, page)
          applyCanonical(desktopTranscriptHistory(page))
        }
      } while (reconcileAgain && alive())
    })().finally(() => { reconciling = null })
    return reconciling
  }

  function applyCanonical(history) {
    for (const entry of history) {
      if (entry.who === 'you') {
        if (entry.id && shownIds.has(entry.id)) continue
        if (entry.id) shownIds.add(entry.id)
        if (entry.turnStamp && personTurns.has(entry.turnStamp)) continue
        const own = claimPending(entry.text, { turnId: entry.turnStamp, id: entry.id })
        if (entry.turnStamp) personTurns.add(entry.turnStamp)
        if (own) continue
        settleStream()
        root.addOwnerMessage?.(entry.text, { at: entry.at, turnStamp: entry.turnStamp })
        continue
      }
      if (entry.who !== 'agent') continue
      const key = entry.turnStamp || entry.id
      if (entry.id) shownIds.add(entry.id)
      if (stream && streamKey === key) settleStream()
      const shown = replies.get(key)
      if (shown) {
        if (shown.text === entry.text) continue
        const bubble = shown.handle || root.openStream?.({ entryId: shown.entryId }) || null
        if (!bubble) continue
        bubble.close(entry.text, { provisional: true })
        replies.set(key, { handle: bubble, entryId: shown.entryId, text: entry.text })
        continue
      }
      const bubble = root.openStream?.({ at: entry.at, turnStamp: entry.turnStamp }) ?? null
      if (!bubble) continue
      bubble.close(entry.text, { provisional: true })
      replies.set(key, { handle: bubble, entryId: entry.id, text: entry.text })
    }
  }

  function endSession() {
    sessionTextReader.clear()
    settleStream()
    ended = true
    root.addNote?.(DESKTOP_SESSION_COPY.ended)
    unsubscribe?.()
    unsubscribe = null
    try { onEnded?.(sessionId) } catch { /* the chat has already said it ended */ }
  }

  async function send(text, handlers) {
    if (!alive()) return
    if (stop.blocksSend) { handlers.fail(stop.message, { code: 'MC_AGENT_DESKTOP_STOP_PENDING', retract: true, restoreDraft: true }); return }
    if (ended) {
      handlers.fail(desktopSendSentence('MC_AGENT_SESSION_ENDED'), { code: 'MC_AGENT_SESSION_ENDED', retract: true, restoreDraft: true })
      return
    }
    const pending = { text, matched: false, lost: false, awaitingAnswer: true, priorIds: new Set(shownIds), priorTurns: new Set(personTurns), confirm: handlers.accepted }
    pendingSends.add(pending)
    let answer = null
    let code = null
    try {
      answer = await bridge.send({ sessionId, text })
    } catch (error) {
      code = desktopRefusalCode(error, 'BRIDGE_UNREACHABLE')
    }
    if (!alive()) { pendingSends.delete(pending); return }
    pending.awaitingAnswer = false
    if (!code && !isRecord(answer)) code = 'BRIDGE_UNREACHABLE'
    if (!code && answer.ok !== true) code = desktopRefusalCode(answer, 'AGENT_SESSION_FAILED')
    if (code && sendAnswerWasLost(code)) {
      if (pending.matched) { pendingSends.delete(pending); return }
      /* The answer is lost, not the message. It stays on screen, unconfirmed. */
      pending.lost = true
      pending.code = code
      showPendingStatus(pending, DESKTOP_SESSION_COPY.sendUnconfirmed)
      void settleLostSend(pending)
      return
    }
    pendingSends.delete(pending)
    if (code) {
      /* The computer refused it, so nothing was sent and the words go back into the box. */
      handlers.fail(desktopSendSentence(code), { code, retract: true, restoreDraft: true })
      return
    }
    const turnId = word(answer.turnId, 512)
    pending.confirm?.({ turnId: pending.turnId || turnId })
    if (turnId) personTurns.add(turnId)
    else if (!pending.matched) {
      /* Accepted without a turn id: the first matching person event or record
         for these words is this send, not a new message. */
      pendingSends.add({ ...pending, lost: false, matched: false })
    }
  }

  async function settleLostSend(pending) {
    let answer = null
    try { answer = await bridge.transcript({ sessionId, limit: RECONCILE_LIMIT }) } catch { answer = null }
    if (!alive() || !root || !pendingSends.has(pending)) return
    const page = pageOf(answer)
    if (!page) { showPendingStatus(pending, DESKTOP_SESSION_COPY.sendUncheckable); return }
    known = mergeTranscriptEntries(known, page)
    settleLostSends(page)
    if (pendingSends.has(pending)) showPendingStatus(pending, DESKTOP_SESSION_COPY.sendNotShownYet)
  }

  /* Match lost sends against a page of the computer's record. */
  function settleLostSends(entries) {
    for (const entry of desktopTranscriptHistory(entries)) {
      if (entry.who !== 'you') continue
      if (entry.id && shownIds.has(entry.id)) continue
      if (entry.turnStamp && personTurns.has(entry.turnStamp)) continue
      if (!claimPending(entry.text, { turnId: entry.turnStamp, id: entry.id })) continue
      if (entry.id) shownIds.add(entry.id)
      if (entry.turnStamp) personTurns.add(entry.turnStamp)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    sessionTextReader.clear()
    unsubscribe?.()
    unsubscribe = null
    if (frame !== null) { cancelFrame(frame); frame = null }
    held.length = 0
    root?.dispose?.()
  }

  return handle
}
