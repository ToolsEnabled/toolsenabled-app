/* THE VIDEO UNDER AN AGENT'S BOX: WHO HOLDS THE STREAMS (1.0.49, phase 1).
 *
 * One broker per page. It owns every MediaStream a video panel shows, keyed by
 * the agent's tree node id (phase 1 streams only for this computer's tree), so
 * a panel can be torn down and built again -- a re-layout, a switch between
 * Boxes and Circles, a record rebuilt by the graph -- and the SAME stream comes
 * back without asking the person to pick the window again.
 *
 * INERT WITHOUT THE DESKTOP BRIDGE. window.mcVideoBox exists only in the
 * desktop app's own main window (shell/fleet-profile-preload.cjs). The browser,
 * the phone canvas and the paired window have no bridge, so available() is
 * false there and start() answers with a refusal; nothing else runs.
 *
 * THE ONE PATH TO A STREAM (measured in video-box/spike/REPORT.md):
 *   start() must be called INSIDE the person's click. It arms the pick in main
 *   (mcVideoBox.arm, which re-lists the windows and checks id and name), then
 *   calls getDisplayMedia with the full constraint set. Main answers that
 *   request synchronously, and only with a user gesture: the click's
 *   activation survives the arm round trip. A failed start gives the armed
 *   pick back (forget with pickOnly) so the next pick is not blocked.
 *
 * EVERY CONSTRAINT SET IS THE FULL SET. applyConstraints REPLACES the whole
 * set: {frameRate} alone dropped the size cap and frames went to 1280x720 in
 * the spike. videoBoxConstraints() is the only way this file builds one.
 *
 * FRAME RATE FOLLOWS WHAT IS ON SCREEN. Each drawn panel reports a rate for its
 * node (watch): 10 for the selected or hovered box, 5 for another visible one,
 * 1 for a panel that is not drawn. The stream runs at the highest rate any
 * panel asks for, and at 1 while the window is hidden. A stream no panel has
 * shown for 10 minutes is stopped and waits for "Click to resume": hiding a
 * panel saves the drawing, but only a lower rate or a stop saves the capture.
 *
 * WHAT IS REMEMBERED. A started video asks main to remember the window by
 * title for this agent (mcVideoBox.remember: main saves the title of the window
 * it granted, never one this page sends). stop() is the person turning video
 * off, so it forgets; stopAll() forgets every choice. A reload, retain() and
 * the 10-minute stop end streams but keep the choice.
 *
 * Nothing here records, sends or hands a frame to anyone. No window title is
 * logged.
 */

export const VIDEO_BOX_CHANGE_EVENT = 'mc-video-box-change'
/* A panel asks for the picker for its agent (after a restart, "Pick the window
   again"). The Video section listens and opens its list of windows. */
export const VIDEO_BOX_PICK_EVENT = 'mc-video-box-pick'
export const VIDEO_BOX_LIMIT = 6
export const VIDEO_BOX_RATES = Object.freeze({ focused: 10, shown: 5, hidden: 1 })
export const VIDEO_BOX_IDLE_MS = 10 * 60 * 1000
const RATE_STEPS = Object.freeze([VIDEO_BOX_RATES.hidden, VIDEO_BOX_RATES.shown, VIDEO_BOX_RATES.focused])
const MAX_WIDTH = 854
const MAX_HEIGHT = 480

/** The full constraint set, always: width, height AND frame rate together. */
export function videoBoxConstraints(frameRate = VIDEO_BOX_RATES.focused) {
  const rate = RATE_STEPS.includes(frameRate) ? frameRate : VIDEO_BOX_RATES.focused
  return { width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { max: rate } }
}

const REASONS = Object.freeze({
  VIDEO_UNAVAILABLE: 'Video works only in the ToolsEnabled desktop app, on Windows or a Linux desktop that uses X11.',
  VIDEO_REQUEST_INVALID: 'That video request was not understood. Close the list and try again.',
  VIDEO_LIMIT: `${VIDEO_BOX_LIMIT} videos are already on. Turn one off, then try again.`,
  VIDEO_NEEDS_CLICK: 'Video starts only from your own click. Press the button again.',
  VIDEO_PICK_PENDING: 'Another video is starting. Wait a moment, then try again.',
  VIDEO_START_FAILED: 'The video did not start. Open the list of windows and pick the window again.',
  VIDEO_WINDOW_GONE: 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.',
  VIDEO_WINDOW_AMBIGUOUS: 'More than one window has that name. Open the list of windows and pick the right one.',
  VIDEO_CANCELLED: 'Video for this agent was turned off while it was starting. Turn it on again to watch.',
  VIDEO_NOT_PAUSED: 'This video is not waiting to resume. Open the list of windows to pick one.',
})
function refusal(code, reason = null) {
  return { ok: false, code, reason: reason || REASONS[code] || REASONS.VIDEO_START_FAILED }
}
// Main's own refusals arrive as { ok:false, code, reason } with a plain sentence.
function passOn(answer) {
  if (answer && answer.ok === false && typeof answer.code === 'string' && typeof answer.reason === 'string') {
    return refusal(answer.code, answer.reason)
  }
  return refusal('VIDEO_START_FAILED')
}
// A page never shows err.message: a plain refusal reads "Invalid capture constraints".
function mediaRefusal(error) {
  if (error?.name === 'NotReadableError') return refusal('VIDEO_WINDOW_GONE')
  return refusal('VIDEO_START_FAILED')
}
const validNodeId = nodeId => typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 200
  && !/[\u0000-\u001f\u007f]/.test(nodeId)
const validToken = token => typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)

export function createVideoBoxBroker({
  host = null, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id),
} = {}) {
  const page = () => host || globalThis.window || null
  const bridge = () => {
    const value = page()?.mcVideoBox
    return value && typeof value.arm === 'function' && typeof value.sources === 'function' ? value : null
  }
  const mediaDevices = () => page()?.navigator?.mediaDevices || null
  // nodeId -> { nodeId, label, state, stream, track, rate, idleTimer, note, replacing }
  // replacing: while a new pick starts, the agent's old video keeps running
  // here until the new one is live, and comes back if the new one fails.
  const entries = new Map()
  // nodeId -> Map(viewer -> rate). Kept apart from entries: a panel can be
  // drawn before its stream exists (starting, or "Pick the window again").
  const demand = new Map()
  let listening = null

  function listen() {
    const win = page()
    if (!win || listening === win) return
    unlisten()
    listening = win
    win.addEventListener?.('pagehide', endEverything)
    win.document?.addEventListener?.('visibilitychange', onVisibility)
  }
  function unlisten() {
    if (!listening) return
    listening.removeEventListener?.('pagehide', endEverything)
    listening.document?.removeEventListener?.('visibilitychange', onVisibility)
    listening = null
  }
  const pageHidden = () => page()?.document?.visibilityState === 'hidden'

  function emit(nodeIds) {
    const win = page()
    if (!win?.dispatchEvent) return
    const detail = Object.freeze({ nodeIds: Object.freeze([...nodeIds]) })
    const Event = win.CustomEvent || globalThis.CustomEvent
    try { win.dispatchEvent(typeof Event === 'function' ? new Event(VIDEO_BOX_CHANGE_EVENT, { detail }) : { type: VIDEO_BOX_CHANGE_EVENT, detail }) } catch { /* a listener's failure is its own */ }
  }
  function endTrack(entry) {
    clearTimer(entry.idleTimer)
    entry.idleTimer = null
    for (const track of entry.stream?.getTracks?.() || []) {
      try { track.stop() } catch { /* already ended */ }
    }
    const old = entry.replacing
    entry.replacing = null
    if (old) endTrack(old)
  }
  function view(entry) {
    return Object.freeze({ nodeId: entry.nodeId, state: entry.state, label: entry.label,
      stream: entry.stream, frameRate: entry.rate, note: entry.note })
  }
  const holdsCapture = entry => entry.state === 'starting' || entry.state === 'live'

  /* The rate this node's stream should run at: the highest any panel asks
     for, and 1 while the app's window is hidden. */
  function wantedRate(nodeId) {
    if (pageHidden()) return VIDEO_BOX_RATES.hidden
    let rate = VIDEO_BOX_RATES.hidden
    for (const value of demand.get(nodeId)?.values() || []) rate = Math.max(rate, value)
    return rate
  }
  function settle(entry) {
    if (entries.get(entry.nodeId) !== entry || entry.state !== 'live') return
    const rate = wantedRate(entry.nodeId)
    if (rate !== entry.rate) {
      entry.rate = rate
      try { void Promise.resolve(entry.track.applyConstraints(videoBoxConstraints(rate))).catch(() => {}) } catch { /* the next change tries again */ }
    }
    // Shown somewhere means drawn in a visible window at 5 or 10 frames a second.
    if (rate >= VIDEO_BOX_RATES.shown) {
      clearTimer(entry.idleTimer)
      entry.idleTimer = null
    } else if (!entry.idleTimer) {
      entry.idleTimer = setTimer(() => pause(entry), VIDEO_BOX_IDLE_MS)
    }
  }
  function pause(entry) {
    entry.idleTimer = null
    if (entries.get(entry.nodeId) !== entry || entry.state !== 'live') return
    endTrack(entry)
    Object.assign(entry, { state: 'paused', stream: null, track: null, rate: null, note: null })
    emit([entry.nodeId])
  }
  function onVisibility() {
    for (const entry of entries.values()) settle(entry)
  }
  function endEverything() {
    const ids = [...entries.keys()]
    for (const entry of entries.values()) endTrack(entry)
    entries.clear()
    if (ids.length) emit(ids)
  }

  function available() {
    return Boolean(bridge() && typeof mediaDevices()?.getDisplayMedia === 'function')
  }

  /* CALL THIS INSIDE THE PERSON'S CLICK, before any other await: the click's
     activation is what main's display handler requires. */
  async function start(nodeId, { token, label } = {}) {
    if (!available()) return refusal('VIDEO_UNAVAILABLE')
    if (!validNodeId(nodeId) || !validToken(token)) return refusal('VIDEO_REQUEST_INVALID')
    const activation = page()?.navigator?.userActivation
    if (activation && activation.isActive !== true) return refusal('VIDEO_NEEDS_CLICK')
    const previous = entries.get(nodeId)
    if (previous?.state === 'starting') return refusal('VIDEO_PICK_PENDING')
    if ([...entries.values()].filter(entry => entry.nodeId !== nodeId && holdsCapture(entry)).length >= VIDEO_BOX_LIMIT) {
      return refusal('VIDEO_LIMIT')
    }
    listen()
    if (previous) { clearTimer(previous.idleTimer); previous.idleTimer = null }
    const entry = { nodeId, label: typeof label === 'string' ? label : '', state: 'starting',
      stream: null, track: null, rate: null, idleTimer: null, note: null, replacing: previous || null }
    entries.set(nodeId, entry)
    emit([nodeId])
    const current = () => entries.get(nodeId) === entry
    // A failed pick leaves the agent's earlier video (or its paused panel) as it was.
    // One turned off meanwhile did not fail: the person ended it.
    const fail = answer => {
      if (!current()) return refusal('VIDEO_CANCELLED')
      const old = entry.replacing
      entry.replacing = null
      if (old) { entries.set(nodeId, old); settle(old) } else entries.delete(nodeId)
      emit([nodeId])
      return answer
    }
    let armed
    try { armed = await bridge().arm({ token, nodeId }) } catch { armed = null }
    if (!current()) {
      /* Turned off while main armed the pick: that forget came before the pick
         existed, so give it back now, or every pick waits 10 s behind it. */
      if (armed?.ok === true) { try { await bridge()?.forget?.({ nodeId, pickOnly: true }) } catch { /* it expires in 10 s */ } }
      return refusal('VIDEO_CANCELLED')
    }
    if (armed?.ok !== true) return fail(passOn(armed))
    let stream
    try {
      stream = await mediaDevices().getDisplayMedia({ video: videoBoxConstraints(VIDEO_BOX_RATES.focused), audio: false })
    } catch (error) {
      // The pick is still armed when the permission gate refused first.
      try { await bridge()?.forget?.({ nodeId, pickOnly: true }) } catch { /* it expires in 10 s */ }
      return fail(mediaRefusal(error))
    }
    const track = stream?.getVideoTracks?.()[0] || null
    if (!current() || !track) {
      for (const each of stream?.getTracks?.() || []) { try { each.stop() } catch { /* ended */ } }
      return current() ? fail(refusal('VIDEO_START_FAILED')) : refusal('VIDEO_CANCELLED')
    }
    const old = entry.replacing
    entry.replacing = null
    if (old) endTrack(old)
    Object.assign(entry, { state: 'live', stream, track, rate: VIDEO_BOX_RATES.focused })
    // "ended" fires when the source goes away (the window closed), never on stop().
    track.addEventListener?.('ended', () => {
      if (entry.track !== track || entry.state !== 'live') return
      clearTimer(entry.idleTimer)
      entry.idleTimer = null
      entry.state = 'ended'
      // Also while a new pick is starting: a failed pick brings this back closed.
      if (current()) emit([nodeId])
    })
    settle(entry)
    emit([nodeId])
    let remembered
    try { remembered = await bridge()?.remember?.({ nodeId }) } catch { remembered = null }
    return remembered?.ok === true ? { ok: true, remembered: true }
      : { ok: true, remembered: false, reason: passOn(remembered).reason }
  }

  /* "Click to resume": the same window again, found by its exact name. Two
     windows with that name, or none (closed, renamed, or minimized: on X11 a
     minimized window is not listed), send the person back to the list. */
  async function resume(nodeId) {
    const entry = entries.get(nodeId)
    if (!entry || entry.state !== 'paused') return refusal('VIDEO_NOT_PAUSED')
    if (!available()) return refusal('VIDEO_UNAVAILABLE')
    const activation = page()?.navigator?.userActivation
    if (activation && activation.isActive !== true) return refusal('VIDEO_NEEDS_CLICK')
    let listed
    try { listed = await bridge().sources() } catch { listed = null }
    const note = answer => {
      if (entries.get(nodeId) === entry && entry.state === 'paused') { entry.note = answer.reason; emit([nodeId]) }
      return answer
    }
    if (listed?.ok !== true || !Array.isArray(listed.sources)) return note(passOn(listed))
    const same = listed.sources.filter(source => source?.name === entry.label)
    if (same.length !== 1) return note(refusal(same.length ? 'VIDEO_WINDOW_AMBIGUOUS' : 'VIDEO_WINDOW_GONE'))
    if (entries.get(nodeId) !== entry) return refusal('VIDEO_CANCELLED')
    const answer = await start(nodeId, { token: same[0].token, label: entry.label })
    // A failed start put the paused entry back: say why on its panel.
    return answer.ok ? answer : note(answer)
  }

  /** The person turned this agent's video off: end it and forget the choice. */
  async function stop(nodeId) {
    const entry = entries.get(nodeId)
    if (entry) {
      endTrack(entry)
      entries.delete(nodeId)
      emit([nodeId])
    }
    const link = bridge()
    if (!link || typeof link.forget !== 'function' || !validNodeId(nodeId)) return { ok: true }
    try { return await link.forget({ nodeId }) } catch { return refusal('VIDEO_START_FAILED', 'This video choice could not be cleared. Turn off all video to clear every choice.') }
  }

  /** "Turn off all video": every stream ends and every saved choice goes. */
  async function stopAll() {
    endEverything()
    const link = bridge()
    if (!link || typeof link.clear !== 'function') return { ok: true }
    try { return await link.clear() } catch { return refusal('VIDEO_START_FAILED', 'The saved video choices could not be cleared. Try Turn off all video again.') }
  }

  /** Agents that left the tree lose their streams; saved choices stay with main. */
  function retain(nodeIds) {
    const keep = new Set(nodeIds || [])
    const gone = [...entries.keys()].filter(nodeId => !keep.has(nodeId))
    for (const nodeId of gone) { endTrack(entries.get(nodeId)); entries.delete(nodeId) }
    if (gone.length) emit(gone)
    return gone.length
  }

  function setTier(nodeId, frameRate) {
    const entry = entries.get(nodeId)
    if (!entry || entry.state !== 'live' || !RATE_STEPS.includes(frameRate)) return false
    if (entry.rate === frameRate) return true
    entry.rate = frameRate
    try { void Promise.resolve(entry.track.applyConstraints(videoBoxConstraints(frameRate))).catch(() => {}) } catch { return false }
    return true
  }

  /** A drawn panel reports the rate it needs; unwatch when it goes away. */
  function watch(nodeId, viewer, frameRate) {
    if (!validNodeId(nodeId) || !viewer || !RATE_STEPS.includes(frameRate)) return
    if (!demand.has(nodeId)) demand.set(nodeId, new Map())
    if (demand.get(nodeId).get(viewer) === frameRate) return
    demand.get(nodeId).set(viewer, frameRate)
    const entry = entries.get(nodeId)
    if (entry) settle(entry)
  }
  function unwatch(nodeId, viewer) {
    const viewers = demand.get(nodeId)
    if (!viewers?.delete(viewer)) return
    if (!viewers.size) demand.delete(nodeId)
    const entry = entries.get(nodeId)
    if (entry) settle(entry)
  }

  function get(nodeId) {
    const entry = entries.get(nodeId)
    return entry ? view(entry) : null
  }

  return Object.freeze({
    available, start, resume, stop, stopAll, retain, setTier, watch, unwatch, get,
    list: () => [...entries.values()].map(view),
    nodeIds: () => [...entries.keys()],
    // End every stream and drop every listener, keeping the saved choices.
    dispose() { endEverything(); demand.clear(); unlisten() },
  })
}

let shared = null
/** The page's one broker. The graph and the Video section share it. */
export function videoBoxBroker() {
  shared ||= createVideoBoxBroker()
  return shared
}
