/* THE PANEL UNDER A BOX (1.0.49 video box, phase 1).
 *
 * A 16:9 panel as wide as the box, 8px under it, showing the window the person
 * picked for that agent. Only Boxes view draws one, never in edit mode and
 * never on a group box; src/tree-graph.js decides when, this file draws it.
 * The stream itself lives in src/video-box-broker.js, so a panel can be torn
 * down and built again with the box and the same stream comes back.
 *
 * WHAT A PERSON SEES, by the broker's state for the agent:
 *   live      the video, with the window's title as its one caption line;
 *             after a few seconds with no new frame, a note that the window is
 *             minimized or hidden (the last frame stays)
 *   starting  "Starting the video…"
 *   ended     "Window closed" (the source window went away) until video is
 *             turned off
 *   paused    not shown anywhere for 10 minutes: "Click to resume"; after a
 *             resume that could not find the window (its note says why),
 *             "Pick the window again", which asks the Video section for its list
 *   none      the Video section still marks this agent (a choice saved before
 *             a restart): "Video was on for this agent." and one press that
 *             asks the Video section to open its list of windows
 *
 * THE PANEL IS NOT PART OF THE BOX'S GESTURES. A press, a double-click, a drag
 * or Enter/Space inside it never selects the box, opens a chat or pans the
 * canvas, exactly like the box's own buttons. It carries
 * data-video-box-controls, so agent app control (shell/accessibility-app.cjs)
 * refuses to press it: resuming starts a capture, and an agent that could
 * press it and screenshot the app could watch the window.
 *
 * FRAME RATE. One IntersectionObserver per graph, rooted at the graph's zoom
 * host, tells the broker what each panel needs: 10 for the selected or hovered
 * box, 5 for another visible panel, 1 for a panel that is not drawn.
 *
 * Window titles are text a program on this computer chose; they are only ever
 * set with textContent.
 */
import { VIDEO_BOX_PICK_EVENT, VIDEO_BOX_RATES } from './video-box-broker.js'

// No new frame for this long while the panel is on screen: say why.
export const BOX_VIDEO_STALL_MS = 3000
const STALL_CHECK_MS = 1000

export const BOX_VIDEO_WORDS = Object.freeze({
  starting: 'Starting the video…',
  ended: 'Window closed',
  paused: 'Click to resume',
  stalled: 'The window is minimized or hidden. Restore it to see the video.',
  saved: 'Video was on for this agent.',
  savedAction: 'Pick the window again',
})

// panel element -> its drawing state. Kept off the element on purpose.
const panels = new WeakMap()

function stopEvent(event) { event.stopPropagation() }
function isolate(panel) {
  for (const name of ['pointerdown', 'click', 'dblclick']) panel.addEventListener(name, stopEvent)
  // A drag that starts on the video must not pick the box up.
  panel.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  panel.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() })
}

/** Build the panel inside the box and draw what the broker holds for it. */
export function mountBoxVideo(record, { broker, now = () => Date.now() } = {}) {
  if (record.videoPanel) { renderBoxVideo(record); return record.videoPanel }
  const doc = record.el.ownerDocument || globalThis.document
  const panel = doc.createElement('div')
  panel.className = 'tree-box-video'
  panel.setAttribute('data-video-box-controls', '')
  panel.setAttribute('role', 'group')
  panel.draggable = false
  const video = doc.createElement('video')
  video.className = 'tree-box-video-frame'
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.disablePictureInPicture = true
  for (const name of ['muted', 'autoplay', 'playsinline', 'disablepictureinpicture']) video.setAttribute(name, '')
  video.setAttribute('aria-hidden', 'true')
  const caption = doc.createElement('div')
  caption.className = 'tree-box-video-caption'
  const text = doc.createElement('span')
  text.className = 'tree-box-video-text'
  const action = doc.createElement('button')
  action.type = 'button'
  action.className = 'tree-box-video-action'
  action.hidden = true
  caption.append(text, action)
  panel.append(video, caption)
  isolate(panel)
  const state = { record, broker, now, video, text, action, stream: null, lastFrameAt: 0, frameHandle: 0,
    stalled: false, visible: true }
  panels.set(panel, state)
  action.addEventListener('click', event => {
    event.stopPropagation()
    const nodeId = state.record.id
    const current = state.broker.get(nodeId)
    // Inside the person's click: the broker's resume needs that activation.
    if (current?.state === 'paused' && !current.note) { void state.broker.resume(nodeId); return }
    // A saved choice after a restart, or a resume that could not find the window: pick again.
    if (!current || current.state === 'paused') {
      const win = globalThis.window
      const Event = win?.CustomEvent || globalThis.CustomEvent
      // The name lets the Video section say whose window it is listing.
      const detail = Object.freeze({ nodeId, name: typeof state.record.agent?.name === 'string' ? state.record.agent.name : '' })
      win?.dispatchEvent?.(typeof Event === 'function' ? new Event(VIDEO_BOX_PICK_EVENT, { detail }) : { type: VIDEO_BOX_PICK_EVENT, detail })
    }
  })
  record.videoPanel = panel
  record.el.appendChild(panel)
  renderBoxVideo(record)
  return panel
}

function attach(state, stream) {
  if (state.stream === stream) return
  if (state.frameHandle && typeof state.video.cancelVideoFrameCallback === 'function') state.video.cancelVideoFrameCallback(state.frameHandle)
  state.frameHandle = 0
  state.stream = stream
  state.video.srcObject = stream
  state.lastFrameAt = state.now()
  state.stalled = false
  if (!stream) return
  try { void Promise.resolve(state.video.play?.()).catch(() => {}) } catch { /* autoplay covers it */ }
  if (typeof state.video.requestVideoFrameCallback !== 'function') return
  const tick = () => {
    if (state.stream !== stream) return
    state.lastFrameAt = state.now()
    state.frameHandle = state.video.requestVideoFrameCallback(tick)
  }
  state.frameHandle = state.video.requestVideoFrameCallback(tick)
}

/** Draw the panel from the broker's current view of this agent. */
export function renderBoxVideo(record) {
  const panel = record?.videoPanel
  const state = panel && panels.get(panel)
  if (!state) return
  state.record = record
  const view = state.broker.get(record.id)
  const status = view?.state || 'saved'
  // An ended track keeps its last frame on screen under "Window closed".
  attach(state, status === 'live' || status === 'ended' ? view.stream || null : null)
  if (status !== 'live') state.stalled = false
  panel.dataset.videoState = status
  panel.dataset.videoStalled = String(state.stalled)
  let words = BOX_VIDEO_WORDS[status] || '', actionWords = ''
  if (status === 'live') words = state.stalled ? BOX_VIDEO_WORDS.stalled : view.label || ''
  // A failed resume says why above the same button.
  else if (status === 'paused') { words = view.note || ''; actionWords = view.note ? BOX_VIDEO_WORDS.savedAction : BOX_VIDEO_WORDS.paused }
  else if (status === 'saved') actionWords = BOX_VIDEO_WORDS.savedAction
  if (state.text.textContent !== words) state.text.textContent = words
  state.text.hidden = !words
  state.action.hidden = !actionWords
  if (state.action.textContent !== actionWords) state.action.textContent = actionWords
  const name = record.agent?.name || 'this agent'
  const label = status === 'live' && view.label ? `Video of ${view.label}, for ${name}` : `Video for ${name}`
  if (panel.getAttribute('aria-label') !== label) panel.setAttribute('aria-label', label)
}

/** Take the panel out of the box. The stream stays with the broker. */
export function unmountBoxVideo(record) {
  const panel = record?.videoPanel
  if (!panel) return
  const state = panels.get(panel)
  if (state) {
    if (state.frameHandle && typeof state.video.cancelVideoFrameCallback === 'function') state.video.cancelVideoFrameCallback(state.frameHandle)
    state.frameHandle = 0
    state.stream = null
    state.video.srcObject = null
    panels.delete(panel)
  }
  panel.remove()
  delete record.videoPanel
}

/* ONE OBSERVER PER GRAPH. It reports each panel's rate to the broker and
   watches for a stalled source while a panel is on screen. */
export function createBoxVideoWatcher({ root, broker, isFocused = () => false, now = () => Date.now(),
  setTicker = (callback, ms) => setInterval(callback, ms), clearTicker = id => clearInterval(id) } = {}) {
  const observed = new Map() // panel -> record
  let ticker = 0
  const Observer = globalThis.IntersectionObserver
  const observer = typeof Observer === 'function' ? new Observer(entries => {
    for (const entry of entries) {
      const state = panels.get(entry.target)
      if (!state || !observed.has(entry.target)) continue
      const visible = entry.isIntersecting === true
      if (visible && !state.visible) state.lastFrameAt = now()
      state.visible = visible
      report(entry.target)
    }
  }, { root: root || null, threshold: 0 }) : null

  function rateOf(panel) {
    const state = panels.get(panel)
    if (!state || !state.visible || panel.closest?.('[hidden]')) return VIDEO_BOX_RATES.hidden
    return isFocused(observed.get(panel)?.id) ? VIDEO_BOX_RATES.focused : VIDEO_BOX_RATES.shown
  }
  function report(panel) {
    const record = observed.get(panel)
    if (record) broker.watch(record.id, panel, rateOf(panel))
  }
  function checkStalls() {
    const at = now()
    for (const [panel, record] of observed) {
      const state = panels.get(panel)
      if (!state) continue
      const live = broker.get(record.id)?.state === 'live'
      const stalled = live && state.visible && at - state.lastFrameAt >= BOX_VIDEO_STALL_MS
      if (stalled !== state.stalled) { state.stalled = stalled; renderBoxVideo(record) }
    }
  }
  function observe(record) {
    const panel = record?.videoPanel
    if (!panel || observed.get(panel) === record) return
    observed.set(panel, record)
    const state = panels.get(panel)
    // Without an observer (never in the app itself), a mounted panel counts as shown.
    if (state && observer) state.visible = false
    // A panel just put on screen gets the full wait before it says "minimized".
    if (state) state.lastFrameAt = now()
    observer?.observe(panel)
    report(panel)
    if (!ticker) ticker = setTicker(checkStalls, STALL_CHECK_MS)
  }
  function unobserve(record) {
    for (const [panel, owner] of observed) {
      if (owner !== record && panel !== record?.videoPanel) continue
      observed.delete(panel)
      observer?.unobserve(panel)
      broker.unwatch(owner.id, panel)
    }
    if (!observed.size && ticker) { clearTicker(ticker); ticker = 0 }
  }
  /** Selection or hover moved, or a box was hidden: report every rate again. */
  function refresh() {
    for (const panel of observed.keys()) report(panel)
  }
  function destroy() {
    for (const [panel, record] of observed) broker.unwatch(record.id, panel)
    observed.clear()
    observer?.disconnect()
    if (ticker) { clearTicker(ticker); ticker = 0 }
  }
  return { observe, unobserve, refresh, destroy, checkStalls, rateOf }
}
