'use strict'
/* THE VIDEO UNDER AN AGENT'S BOX: WHICH WINDOW, AND WHO MAY START IT (1.0.49).
 *
 * Phase 1 streams a window on this computer that the person picks. This
 * module is the main-process half, and a pure factory: Electron is injected,
 * so the tests drive it with a fake desktopCapturer and fake windows.
 *
 * THE ONE PATH TO A STREAM, every step measured in the Electron 43 spike
 * (video-box/spike/REPORT.md):
 *   1. sources(owner) lists this computer's windows. The app's own windows are
 *      left out: every BrowserWindow's getMediaSourceId(), and any id that is
 *      not "window:<n>:0" (a detached DevTools window is not a BrowserWindow,
 *      and its id ends in a non-zero number). Each window gets an opaque token
 *      bound to this owner for 60 s; the renderer never sees a window id.
 *   2. arm(owner, {token, nodeId}) is the person's pick. It lists the windows
 *      again and requires the same id AND the same name, because X11 reuses
 *      window ids. It holds one pending pick per owner, for 10 s.
 *      All the awaiting happens here.
 *   3. The renderer calls getDisplayMedia inside the same click. Electron asks
 *      the permission handler first ('media' with empty mediaTypes, gated in
 *      voice-permissions.cjs by allowsDisplayCapture), then displayHandler().
 *      allowsDisplayCapture() answers yes ONCE per pick: it moves the pick
 *      from pending to granting.
 *   4. displayHandler() is SYNCHRONOUS and calls back exactly once: a handler
 *      that never answers wedges every later request from that page, and an
 *      answer from a timer froze main in the spike. It takes the granting pick
 *      first (one shot: a refused request still uses it up), then grants only
 *      the owner's own main frame, at the shell origin, with a user gesture,
 *      video without audio.
 *
 * THE OTHER DOOR THROUGH THE SAME GATE (review F1, measured in Electron
 * 43.3.0). Electron sends the permission handler exactly the same request for
 * the old getUserMedia desktop capture ({chromeMediaSource: 'desktop'}) as for
 * getDisplayMedia, and that capture never reaches the display handler. While
 * a pick waited, page script with no click took the whole screen, the app's
 * own window and system audio that way. Three rules close it:
 *   - sources() and arm() need the person's own click, and main reads it
 *     itself, in an isolated world the page cannot reach (ACTIVATION_WORLD).
 *     The page's own copy of navigator.userActivation can be redefined; main's
 *     read cannot. Only a click makes a list of windows or a pick.
 *   - One pick lets exactly one request through the permission gate.
 *   - A grant the display handler has not taken GRANT_CHECK_MS later went to
 *     some other kind of capture: the host forgets the owner's state and
 *     endStrayCapture(owner) reloads the page, which ends every capture it
 *     holds. No page request can call that check off: forget and clear leave
 *     a grant that is out alone; only a reload or a closed window (close,
 *     called by main, never by the page) drops it.
 *
 * WHAT IS REMEMBERED. remember(owner, {nodeId}) saves the title of the window
 * the handler actually granted for that node (never a title the renderer
 * sends), through agent-video-sources.cjs. Nothing streams from a saved
 * choice: after a restart the person picks again.
 *
 * Every refusal is an answer { ok: false, code, reason }, never a throw,
 * because an invoke rejection loses its code on the way to the renderer.
 * No window title is logged, audited or put in a refusal.
 */
const { randomBytes } = require('node:crypto')
const { cleanTitle } = require('./agent-video-sources.cjs')

const TOKEN_TTL_MS = 60_000
const PICK_TTL_MS = 10_000
/* A grant the display handler has not taken by then went to another capture.
   Measured in Electron 43.3.0: the display handler runs 0.1 ms after the
   grant, in the same turn, so half a second is thousands of times that. */
const GRANT_CHECK_MS = 500
// Main's own world for reading the page's click. Not 0 (the page) or 1004 (agent app control).
const ACTIVATION_WORLD = 1049
const ACTIVATION_READ_MS = 2_000
const ACTIVATION_CODE = 'navigator.userActivation?.isActive === true'
const MAX_SOURCES = 40
const MAX_GRANTS = 32
const THUMBNAIL = Object.freeze({ width: 240, height: 135 })
const NO_THUMBNAIL = Object.freeze({ width: 0, height: 0 })
// Foreign windows end in :0. This browser process's own surfaces do not.
const FOREIGN_WINDOW = /^window:\d+:0$/
const TOKEN = /^[0-9a-f]{32}$/

const REASONS = Object.freeze({
  VIDEO_UNAVAILABLE: 'Video is not available on this desktop. It needs Windows or a Linux desktop that uses X11.',
  VIDEO_NEEDS_CLICK: 'Video starts only from your own click. Press the button again.',
  VIDEO_REQUEST_INVALID: 'That video request was not understood. Close the list and try again.',
  VIDEO_LIST_FAILED: 'The list of windows could not be read. Try again in a moment.',
  VIDEO_PAGE_CHANGED: 'The app reloaded while the list was open. Open the list of windows again.',
  VIDEO_PICK_PENDING: 'Another video is starting. Wait a moment, then try again.',
  VIDEO_PICK_EXPIRED: 'This list of windows is out of date. Open the list again and pick the window.',
  VIDEO_WINDOW_GONE: 'That window closed, changed its name or is minimized. Restore it if needed, then pick it again.',
  VIDEO_AGENT_GONE: 'This agent is no longer on this computer’s tree. Pick an agent that is.',
  VIDEO_NOT_STARTED: 'Start the video for this agent first, then it can be remembered.',
  VIDEO_SAVED_UNAVAILABLE: 'Saved video choices can be read once the tree has loaded. Try again in a moment.',
  VIDEO_SAVED_UNREADABLE: 'The saved video choices could not be read. Turn off all video to clear them.',
  VIDEO_SAVED_WRITE_FAILED: 'This video choice could not be saved, so it will not come back after a restart.',
  VIDEO_SAVED_CLOSED: 'Video choices cannot be saved while the app is closing or after its data was erased.',
})
function refusal(code) {
  return { ok: false, code, reason: REASONS[code] || REASONS.VIDEO_REQUEST_INVALID }
}
function storeRefusal(error) {
  return refusal(Object.hasOwn(REASONS, error?.code || '') ? error.code : 'VIDEO_SAVED_WRITE_FAILED')
}

/* The program name, as far as a title tells it: the last part after a spaced
   dash ("notes.txt - Mousepad"). Chromium lists a window by title only, and
   asking the window system would put a child process in main for a hint. The
   re-pick matches on the title first; this only breaks ties. */
function programFromTitle(title) {
  const parts = String(title || '').split(/\s[-–—]\s/)
  if (parts.length < 2) return ''
  const last = cleanTitle(parts.at(-1), 80)
  return last
}

function plainRequest(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const own = Object.keys(value)
  if (own.length !== keys.length || !keys.every(key => own.includes(key))) return null
  return value
}
function nodeIdOf(value) {
  const request = plainRequest(value, ['nodeId'])
  const nodeId = request?.nodeId
  return typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(nodeId) ? nodeId : null
}
// { nodeId } turns the agent's video off; { nodeId, pickOnly: true } only
// withdraws a pick whose start failed, keeping the saved choice for a retry.
function forgetRequest(value) {
  const request = plainRequest(value, ['nodeId']) || plainRequest(value, ['nodeId', 'pickOnly'])
  if (!request || (Object.hasOwn(request, 'pickOnly') && request.pickOnly !== true)) return null
  const nodeId = nodeIdOf({ nodeId: request.nodeId })
  return nodeId ? { nodeId, pickOnly: request.pickOnly === true } : null
}

function createVideoBoxHost({ desktopCapturer, BrowserWindow, webContents, shellOrigin, supported, store, readIdentity,
  now = () => Date.now(), makeToken = () => randomBytes(16).toString('hex'),
  setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id),
  endStrayCapture = owner => owner.reload() }) {
  for (const [name, value] of [['desktopCapturer.getSources', desktopCapturer?.getSources], ['BrowserWindow.getAllWindows', BrowserWindow?.getAllWindows],
    ['webContents.fromFrame', webContents?.fromFrame], ['shellOrigin', shellOrigin], ['supported', supported], ['readIdentity', readIdentity]]) {
    if (typeof value !== 'function') throw new TypeError(`The video box host needs ${name}.`)
  }
  if (!store || ['remember', 'forget', 'clear', 'list'].some(name => typeof store[name] !== 'function')) {
    throw new TypeError('The video box host needs the saved video choice store.')
  }
  // owner (a WebContents) -> this document's state. close() drops it, so an
  // await that resumes after a reload or close finds a different state.
  const owners = new Map()
  function stateOf(owner) {
    let state = owners.get(owner)
    if (!state) owners.set(owner, state = { tokens: new Map(), pending: null, granting: null, arming: false, granted: new Map() })
    return state
  }
  // Still the same document of a live window? A window that closed during an
  // await loses its state here, in case its destroyed hook already ran.
  function current(owner, state) {
    if (owners.get(owner) !== state) return false
    if (!gone(owner)) return true
    owners.delete(owner)
    return false
  }
  function gone(owner) {
    try { return typeof owner?.isDestroyed === 'function' && owner.isDestroyed() } catch { return true }
  }
  const isSupported = () => { try { return supported() === true } catch { return false } }
  function ownSourceIds() {
    const own = new Set()
    for (const window of BrowserWindow.getAllWindows()) {
      try { own.add(window.getMediaSourceId()) } catch { /* a closing window has no source */ }
    }
    return own
  }
  const foreign = (source, own) => typeof source?.id === 'string' && FOREIGN_WINDOW.test(source.id) && !own.has(source.id)
    && typeof source.name === 'string'
  const listWindows = thumbnailSize => desktopCapturer.getSources({ types: ['window'], thumbnailSize, fetchWindowIcons: false })
  function identityOf(nodeId) {
    try { return readIdentity()(nodeId) || null } catch { return null }
  }
  function thumbnailOf(source) {
    try { return source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '' } catch { return '' }
  }
  /* The display handler's one pick: the grant the permission gate let
     through. Any display request also ends a pick still pending, so a
     refused request uses it up too. */
  function takeGrant(state) {
    const pick = state?.granting || null
    if (state) { state.granting = null; state.pending = null }
    if (pick) clearTimer(pick.check)
    return pick && pick.expires > now() ? pick : null
  }
  function dropGrant(state) {
    if (state?.granting) clearTimer(state.granting.check)
    if (state) state.granting = null
  }

  /* Did the person click this page within the last few seconds? Main asks in
     its own isolated world, with no gesture of its own, so page script can
     neither fake the answer nor make one. A read that does not answer is no. */
  function clickedNow(owner) {
    return new Promise(resolve => {
      let timer = null
      let done = false
      const finish = value => { if (done) return; done = true; clearTimer(timer); resolve(value === true) }
      timer = setTimer(() => finish(false), ACTIVATION_READ_MS)
      try {
        Promise.resolve(owner.executeJavaScriptInIsolatedWorld(ACTIVATION_WORLD, [{ code: ACTIVATION_CODE }], false))
          .then(finish, () => finish(false))
      } catch { finish(false) }
    })
  }

  async function sources(owner) {
    if (!isSupported()) return refusal('VIDEO_UNAVAILABLE')
    // A closed window gets nothing, and no state is kept for it.
    if (gone(owner)) return refusal('VIDEO_PAGE_CHANGED')
    const state = stateOf(owner)
    // Thumbnails of every window are private: only the person's click lists them.
    const clicked = await clickedNow(owner)
    if (!current(owner, state)) return refusal('VIDEO_PAGE_CHANGED')
    if (!clicked) return refusal('VIDEO_NEEDS_CLICK')
    let all
    try { all = await listWindows(THUMBNAIL) } catch { return refusal('VIDEO_LIST_FAILED') }
    if (!current(owner, state)) return refusal('VIDEO_PAGE_CHANGED')
    const own = ownSourceIds()
    const at = now()
    const tokens = new Map()
    const others = (Array.isArray(all) ? all : []).filter(source => foreign(source, own))
    const listed = others.slice(0, MAX_SOURCES).map(source => {
      let token
      do { token = makeToken() } while (tokens.has(token))
      tokens.set(token, { id: source.id, name: source.name, expires: at + TOKEN_TTL_MS })
      return { token, name: source.name, thumbnail: thumbnailOf(source) }
    })
    // A new list replaces the old one: its tokens stop working.
    state.tokens = tokens
    // The count before the cut, so the list can say it shows only some (1.0.50 review video F7).
    return { ok: true, sources: listed, total: others.length }
  }

  async function arm(owner, value) {
    if (!isSupported()) return refusal('VIDEO_UNAVAILABLE')
    const request = plainRequest(value, ['token', 'nodeId'])
    const nodeId = request && nodeIdOf({ nodeId: request.nodeId })
    if (!request || typeof request.token !== 'string' || !TOKEN.test(request.token) || !nodeId) return refusal('VIDEO_REQUEST_INVALID')
    if (gone(owner)) return refusal('VIDEO_PAGE_CHANGED')
    const state = stateOf(owner)
    if (state.arming || state.granting || (state.pending && state.pending.expires > now())) return refusal('VIDEO_PICK_PENDING')
    const chosen = state.tokens.get(request.token)
    if (!chosen || chosen.expires <= now()) return refusal('VIDEO_PICK_EXPIRED')
    if (!identityOf(nodeId)) return refusal('VIDEO_AGENT_GONE')
    state.arming = true
    try {
      const clicked = await clickedNow(owner)
      if (!current(owner, state)) return refusal('VIDEO_PAGE_CHANGED')
      if (!clicked) return refusal('VIDEO_NEEDS_CLICK')
      let all
      try { all = await listWindows(NO_THUMBNAIL) } catch { return refusal('VIDEO_LIST_FAILED') }
      if (!current(owner, state)) return refusal('VIDEO_PAGE_CHANGED')
      const own = ownSourceIds()
      // X11 reuses window ids: the same id with another name is another window.
      if (!(Array.isArray(all) ? all : []).some(source => source?.id === chosen.id && source.name === chosen.name && foreign(source, own))) {
        return refusal('VIDEO_WINDOW_GONE')
      }
      state.pending = { id: chosen.id, name: chosen.name, nodeId, expires: now() + PICK_TTL_MS }
      return { ok: true }
    } finally { state.arming = false }
  }

  /* The permission gate's question: is a pick waiting for this owner right
     now? Yes ONCE: the pick moves to granting, and a check starts. If the
     display handler has not taken it GRANT_CHECK_MS later, the permission went
     to another kind of capture, and the page is reloaded to end it. */
  function allowsDisplayCapture(contents) {
    const state = owners.get(contents)
    if (!state || state.granting || gone(contents)) return false
    const pick = state.pending
    state.pending = null
    if (!pick || pick.expires <= now()) return false
    state.granting = pick
    pick.check = setTimer(() => {
      if (owners.get(contents) !== state || state.granting !== pick) return
      close(contents)
      try { endStrayCapture(contents) } catch { /* a closed window holds no capture */ }
    }, GRANT_CHECK_MS)
    return true
  }

  /* SYNCHRONOUS, AND EXACTLY ONE CALLBACK, whatever happens: no await, no
     timer, every check inside try, the answer in finally. */
  function displayHandler(owner) {
    return (request, callback) => {
      let streams = {}
      try {
        const state = owners.get(owner)
        const pick = takeGrant(state)
        const frame = request?.frame || null
        const admitted = Boolean(pick) && Boolean(frame) && !gone(owner)
          && webContents.fromFrame(frame) === owner
          && frame === owner.mainFrame
          // securityOrigin carries a trailing slash; the frame's origin does not.
          && typeof frame.origin === 'string' && frame.origin === shellOrigin()
          && request.userGesture === true
          && request.videoRequested === true && request.audioRequested === false
        if (admitted) {
          streams = { video: { id: pick.id, name: pick.name } }
          state.granted.delete(pick.nodeId)
          state.granted.set(pick.nodeId, { name: pick.name })
          while (state.granted.size > MAX_GRANTS) state.granted.delete(state.granted.keys().next().value)
        }
      } catch {
        streams = {}
      } finally {
        callback(streams)
      }
    }
  }

  function remember(owner, value) {
    const nodeId = nodeIdOf(value)
    if (!nodeId) return refusal('VIDEO_REQUEST_INVALID')
    const state = owners.get(owner)
    const grant = state?.granted.get(nodeId)
    if (!grant) return refusal('VIDEO_NOT_STARTED')
    state.granted.delete(nodeId)
    const identity = identityOf(nodeId)
    if (!identity) return refusal('VIDEO_AGENT_GONE')
    const title = cleanTitle(grant.name)
    try {
      const saved = store.remember({ treeId: identity.treeId, nodeId, nodeCreatedAt: String(identity.nodeCreatedAt),
        title, app: programFromTitle(title) })
      return { ok: true, saved: { nodeId: saved.nodeId, title: saved.title, app: saved.app, savedAt: saved.savedAt } }
    } catch (error) { return storeRefusal(error) }
  }

  /* Turning one agent's video off: its waiting pick, its grant and its saved
     choice. With pickOnly, a start that failed before the handler ran gives
     its pick back at once instead of blocking the next pick for 10 s. */
  function forget(owner, value) {
    const request = forgetRequest(value)
    if (!request) return refusal('VIDEO_REQUEST_INVALID')
    const { nodeId, pickOnly } = request
    const state = owners.get(owner)
    if (state?.pending?.nodeId === nodeId) state.pending = null
    if (pickOnly) return { ok: true }
    state?.granted.delete(nodeId)
    try { store.forget(nodeId); return { ok: true } } catch (error) { return storeRefusal(error) }
  }

  /* "Turn off all video": every waiting pick, grant, token and saved choice.
     A permission grant still out is left to its check (see allowsDisplayCapture). */
  function clear(owner) {
    const state = owners.get(owner)
    if (state) { state.pending = null; state.granted.clear(); state.tokens.clear() }
    try { store.clear(); return { ok: true } } catch (error) { return storeRefusal(error) }
  }

  // The saved choices for agents still on this computer's tree, for the re-pick.
  function saved() {
    let identities
    try { identities = readIdentity() } catch { return refusal('VIDEO_SAVED_UNAVAILABLE') }
    if (typeof identities !== 'function') return refusal('VIDEO_SAVED_UNAVAILABLE')
    try {
      const records = store.list(nodeId => identities(nodeId))
      return { ok: true, supported: isSupported(),
        records: records.map(record => ({ nodeId: record.nodeId, title: record.title, app: record.app, savedAt: record.savedAt })) }
    } catch (error) { return storeRefusal(error) }
  }

  // A reload or a closed window ends every token, pick and grant of that document.
  function close(owner) {
    const state = owners.get(owner)
    if (state) { state.pending = null; dropGrant(state); state.granted.clear(); state.tokens.clear() }
    owners.delete(owner)
  }

  return { supported: isSupported, sources, arm, allowsDisplayCapture, displayHandler, remember, forget, clear, saved, close }
}

module.exports = { createVideoBoxHost, programFromTitle, TOKEN_TTL_MS, PICK_TTL_MS, MAX_SOURCES, GRANT_CHECK_MS, ACTIVATION_WORLD, ACTIVATION_READ_MS }
