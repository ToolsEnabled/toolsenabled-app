/* THE VIDEO SECTION (1.0.49 video box, phase 1; SPEC-49 delivery C).
 *
 * It sits directly under the Computer control card, in the same right-hand
 * column of "Voice, screen & video" (src/agent-screen-voice-controls.js puts
 * both in one .agent-control-column). It is NOT part of
 * createScreenAccessControls: Settings > App permissions reuses that card, and
 * video has no place there.
 *
 * WHAT A PERSON DOES HERE, for the agent whose mic button opened the panel:
 *   Turn on video…        opens a grid of this computer's windows (main never
 *                         lists ToolsEnabled's own windows or DevTools); one
 *                         press on a window starts it, inside that click.
 *   Change window…        the same list while a video is on.
 *   Turn off video        ends this agent's video and forgets its choice.
 *   Turn off all video    ends every video and forgets every choice.
 *   Pick the window again after a restart: the choice was saved by title, so
 *                         one press opens the list with the best title match
 *                         first and focused. Nothing streams until the person
 *                         presses a window: a saved title is a hint, never a
 *                         permission.
 *   Resume                a video out of sight for 10 minutes stopped; this
 *                         (or the panel's "Click to resume") starts it again.
 *                         A resume that could not find the window (renamed,
 *                         closed, or two with that name) turns the button into
 *                         "Pick the window again", which opens the list.
 *
 * WHO HOLDS WHAT. The streams live in the page's one broker
 * (src/video-box-broker.js); the panel under each box is src/tree-box-video.js.
 * This section only asks: it lists, it starts inside the person's click, it
 * stops. getNodeIds() is the set of agents whose box shows a panel -- a stream
 * the broker holds, or a choice main saved before a restart -- and the Voice,
 * screen & video panel hands it to the tree as videoNodeIds.
 *
 * AGENT APP CONTROL CANNOT PRESS ANY OF IT. The section carries
 * data-video-box-controls, and shell/accessibility-app.cjs refuses every
 * control inside such an element: app control clicks with a real gesture, so
 * without this an agent that can screenshot the app could open any window on
 * this computer and watch it.
 *
 * Window titles are text a program on this computer chose. They are only ever
 * set with textContent, and never logged.
 */
import './agent-video-controls.css'
import { videoBoxBroker, VIDEO_BOX_CHANGE_EVENT, VIDEO_BOX_PICK_EVENT, VIDEO_BOX_LIMIT } from './video-box-broker.js'
import { readTreeStyle, TREE_VIEW_CHANGE_EVENT } from './tree-box-layout.js'
import { THIS_COMPUTER_ID } from './declared-fleet.js'

const camera = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h10A1.5 1.5 0 0 1 16 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 16.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m16 10.5 5-3v9l-5-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'

export const VIDEO_SECTION_WORDS = Object.freeze({
  noAgent: 'Press an agent’s mic button in the tree to choose it.',
  off: 'Video is off for this agent.',
  starting: 'Starting the video…',
  ended: 'Window closed. Pick another window, or turn off video.',
  paused: 'This video stopped after 10 minutes out of sight. Press Resume to watch it again.',
  saved: 'Video was on for this agent. Pick the window again.',
  limit: `Up to ${VIDEO_BOX_LIMIT} videos can play at once. Turn one off, then try again.`,
  desktopOnly: 'Video is not available here. Open the ToolsEnabled desktop app on this computer to use it.',
  unsupported: 'Video is not available on this desktop. Sign in to Windows or a Linux desktop that uses X11 to use it.',
  otherComputer: 'Video works for agents on this computer only. Pick an agent from this computer’s tree.',
  group: 'A group box has no video. Open the group and pick one agent.',
  standalone: 'A New agent tab has no box on the tree, so it cannot show video. Pick an agent on the tree.',
  notSaved: 'Only agents saved on this computer’s tree can have video. Pick an agent from a saved tree.',
  sample: 'The example tree has no video. Pick an agent on your own tree.',
  boxesOnly: 'Switch the tree to Boxes to see this video.',
  editMode: 'Press Done to leave edit mode and see this video.',
  editModeCircles: 'Press Done to leave edit mode, then switch the tree to Boxes to see this video.',
  listEmpty: 'No windows to show. Open the window you want, then press Refresh list.',
  listing: 'Reading the list of windows…',
  allOff: 'Every video is off, and no choice is saved.',
  startFailed: 'The video did not start. Open the list of windows and pick the window again.',
  listFailed: 'The list of windows could not be read. Try again in a moment.',
  listRenewed: 'The list of windows was out of date, so it was read again. Press your window again.',
  windowGone: 'The list of windows was read again, and the window you pressed is not in it. It closed, changed its name or is minimized. Restore it if needed, then press Refresh list.',
})
const BADGE = Object.freeze({ off: 'Off', saved: 'Saved', starting: 'Starting', live: 'On', ended: 'Closed', paused: 'Paused' })
const PRIMARY = Object.freeze({ off: 'Turn on video…', saved: 'Pick the window again', starting: 'Turn on video…',
  live: 'Change window…', ended: 'Change window…', paused: 'Resume', repick: 'Pick the window again' })
const MAX_WINDOWS = 40
const MAX_THUMBNAIL = 512 * 1024
const THUMBNAIL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/
const validNodeId = nodeId => typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 200
  && !/[\u0000-\u001f\u007f]/.test(nodeId)
const validToken = token => typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)
const isStandalone = agent => agent?.standalone === true || /^standalone-/.test(String(agent?.id || ''))

/* The tree's look right now. The style is the saved Boxes/Circles choice (the
   graph writes it on every switch); edit mode shows circles whatever the
   choice, and only the graph's container says it is on. */
export function treeViewNow() {
  let editMode = false
  try { editMode = Boolean(globalThis.document?.querySelector?.('.static-tree-graph[data-edit-mode="true"]')) } catch { /* no page */ }
  return { style: readTreeStyle(), editMode }
}

/* WHICH WINDOW IS THE ONE FROM LAST TIME. The same title wins (the first of
   several); then the same title in another case; then the title sharing the
   most words, with one extra point for the same program ("notes.txt -
   Mousepad" -> Mousepad). At half a point or less nothing is suggested: a
   guess the person did not make is worse than no guess. Returns an index or -1. */
const wordsOf = text => new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
const programOf = title => {
  const parts = String(title || '').split(/\s[-–—]\s/)
  return parts.length < 2 ? '' : parts.at(-1).trim().toLowerCase()
}
export function bestTitleMatch(sources, { title = '', app = '' } = {}) {
  const wanted = typeof title === 'string' ? title : ''
  const wantedApp = (typeof app === 'string' && app ? app : programOf(wanted)).toLowerCase()
  if (!Array.isArray(sources) || (!wanted && !wantedApp)) return -1
  const wantedWords = wordsOf(wanted)
  let best = -1, bestScore = 0.5
  sources.forEach((source, index) => {
    const name = typeof source?.name === 'string' ? source.name : ''
    let score
    if (wanted && name === wanted) score = 4
    else if (wanted && name.toLowerCase() === wanted.toLowerCase()) score = 3
    else {
      const have = wordsOf(name)
      let shared = 0
      for (const word of wantedWords) if (have.has(word)) shared++
      const union = new Set([...wantedWords, ...have]).size
      score = (union ? shared / union : 0) + (wantedApp && programOf(name) === wantedApp ? 1 : 0)
    }
    if (score > bestScore) { best = index; bestScore = score }
  })
  return best
}

export function createAgentVideoControls({ sample = false, getComputerId = () => null, getTreeView = treeViewNow,
  isSavedTreeAgent = () => true, broker = null, host = null, onChange = () => {}, onReveal = () => {} } = {}) {
  const videos = broker || videoBoxBroker()
  const page = () => host || globalThis.window || null
  const bridge = () => {
    const value = page()?.mcVideoBox
    return value && typeof value.sources === 'function' ? value : null
  }
  const el = document.createElement('section')
  el.className = 'agent-video-controls'
  el.setAttribute('aria-label', 'Video')
  el.setAttribute('data-video-box-controls', '')
  el.innerHTML = `<header class="agent-video-heading"><span class="agent-video-icon">${camera}</span><div><h3>Video</h3><p>Watch a window from this computer under this agent’s box.</p></div><span data-video-badge class="agent-video-badge">Off</span></header>
    <p data-video-agent class="agent-video-agent" hidden></p>
    <p data-video-status class="agent-video-status" role="status" aria-live="polite"></p>
    <p data-video-view class="agent-control-hint" hidden></p>
    <div data-video-picker class="agent-video-picker" hidden>
      <div class="agent-video-picker-head"><strong>Pick a window</strong><span class="agent-control-hint">ToolsEnabled’s own windows are not listed.</span></div>
      <p data-video-last class="agent-control-hint" hidden></p>
      <p data-video-listing class="agent-control-hint" hidden></p>
      <p data-video-more class="agent-control-hint" hidden></p>
      <div data-video-windows class="agent-video-windows" role="group" aria-label="Windows on this computer"></div>
      <div class="agent-video-buttons"><button type="button" data-video-refresh>Refresh list</button><button type="button" data-video-cancel>Cancel</button></div>
    </div>
    <div class="agent-video-buttons"><button type="button" data-video-on class="agent-video-primary">Turn on video…</button><button type="button" data-video-off hidden>Turn off video</button><button type="button" data-video-off-all>Turn off all video</button></div>
    <p class="agent-control-hint">Video shows under the agent’s box in Boxes view. Turn off all video also forgets every saved choice.</p>
    <p data-video-privacy class="agent-control-hint agent-video-privacy">ToolsEnabled does not record this video or send it to the agent. An agent you allow to take screenshots, for example with Computer control, can see the video like anything else on your screen. The window’s title is kept on this computer until you turn video off.</p>`
  const get = name => el.querySelector('[data-video-' + name + ']')
  let agent = null, destroyed = false, supported = null, savedProblem = '', savedOp = 0, pickerOp = 0
  // nodeId -> { title, app }: the choices main saved, read back after a restart.
  let saved = new Map()
  // The one open list: { nodeId, loading, sources, suggest, total }.
  let picker = null
  /* The last thing this section has to say about one agent (or about all,
     nodeId null). It is shown only while that agent's video is in the state it
     was said in, so "Window closed" is never hidden behind an older sentence. */
  let notice = null
  const names = new Map()
  // Each window button's source, off the element: tokens never reach the page's markup.
  const sourceOf = new WeakMap()

  const usable = () => !sample && Boolean(bridge()) && videos.available()
  /* 1.0.50 review video F8: main gives video only to saved tree nodes, so a
     fleet agent that matches none is told so before any window is listed. A
     saved choice or a running video counts (a panel's "Pick the window again"
     names only the id); a rule that throws leaves it to main, which refuses at arm.
     A box panel is drawn only for a saved node's choice or video, so an agent
     opened from one stays eligible after Turn off video or Turn off all video
     clears both (REVIEW-1050 #6). */
  function onSavedTree(value) {
    if (value.fromBoxPanel === true || saved.has(value.id) || videos.get(value.id)) return true
    try { return Boolean(isSavedTreeAgent(value)) } catch { return true }
  }
  function eligibility() {
    if (sample) return { ok: false, text: VIDEO_SECTION_WORDS.sample }
    if (!usable()) return { ok: false, text: VIDEO_SECTION_WORDS.desktopOnly }
    if (supported === false) return { ok: false, text: VIDEO_SECTION_WORDS.unsupported }
    if (!agent) return { ok: false, text: VIDEO_SECTION_WORDS.noAgent }
    const computerId = getComputerId()
    if (computerId && computerId !== THIS_COMPUTER_ID) return { ok: false, text: VIDEO_SECTION_WORDS.otherComputer }
    if (agent.treeScope?.group) return { ok: false, text: VIDEO_SECTION_WORDS.group }
    if (isStandalone(agent)) return { ok: false, text: VIDEO_SECTION_WORDS.standalone }
    if (!onSavedTree(agent)) return { ok: false, text: VIDEO_SECTION_WORDS.notSaved }
    return { ok: true, text: '' }
  }
  const capturing = view => view?.state === 'starting' || view?.state === 'live'
  // A paused video whose resume failed has a note saying why; it is picked again, not resumed.
  const resumable = view => view?.state === 'paused' && !view.note
  // The best match to put first: the saved choice, else the paused video's own title.
  const suggestionFor = nodeId => saved.get(nodeId) || (videos.get(nodeId)?.label ? { title: videos.get(nodeId).label } : null)
  const limitReached = nodeId => videos.list().filter(view => view.nodeId !== nodeId && capturing(view)).length >= VIDEO_BOX_LIMIT
  function stateOf(nodeId) {
    const view = nodeId ? videos.get(nodeId) : null
    if (view) return { status: view.state, view }
    return { status: nodeId && saved.has(nodeId) ? 'saved' : 'off', view: null }
  }
  /* Why no box shows this agent's video right now, as the words to say, or ''
     when Boxes view is showing it. Edit mode shows circles whatever the
     choice, and its way out is Done. */
  function viewNote() {
    let view
    try { view = getTreeView() || {} } catch { return '' }
    if (view.editMode) return view.style === 'boxes' ? VIDEO_SECTION_WORDS.editMode : VIDEO_SECTION_WORDS.editModeCircles
    return view.style === 'boxes' ? '' : VIDEO_SECTION_WORDS.boxesOnly
  }

  function say(nodeId, text) {
    notice = text ? { nodeId, text, status: stateOf(nodeId ?? (agent?.id || null)).status } : null
    render()
  }

  function render() {
    if (destroyed) return
    const allowed = eligibility()
    const nodeId = allowed.ok ? agent.id : null
    const { status, view } = stateOf(nodeId)
    el.dataset.state = status
    get('badge').textContent = BADGE[status] || BADGE.off
    get('agent').hidden = !agent
    get('agent').textContent = agent ? `For ${agent.name || 'this agent'}` : ''
    let text = allowed.text
    const hiddenBecause = allowed.ok ? viewNote() : ''
    if (allowed.ok) {
      const said = notice && (notice.nodeId === null || notice.nodeId === nodeId) && notice.status === status ? notice.text : ''
      const title = view?.label || 'the window'
      text = said || (status === 'live' ? (hiddenBecause ? `Video of “${title}” is on for this agent.` : `Showing “${title}” under this agent’s box.`)
        : status === 'paused' ? view.note || VIDEO_SECTION_WORDS.paused
          : status === 'off' ? savedProblem || VIDEO_SECTION_WORDS.off
            : VIDEO_SECTION_WORDS[status] || VIDEO_SECTION_WORDS.off)
    }
    if (get('status').textContent !== text) get('status').textContent = text
    // Only a video there is to see gets the note; an agent with video off gets none.
    get('view').hidden = !allowed.ok || status === 'off' || !hiddenBecause
    get('view').textContent = get('view').hidden ? '' : hiddenBecause
    const on = get('on')
    on.textContent = status === 'paused' && !resumable(view) ? PRIMARY.repick : PRIMARY[status] || PRIMARY.off
    on.disabled = !allowed.ok || status === 'starting' || Boolean(picker?.loading)
    get('off').hidden = !allowed.ok || status === 'off'
    get('off-all').disabled = !usable()
    // The list belongs to one agent; another agent's list is never shown here.
    const open = Boolean(picker) && allowed.ok && picker.nodeId === nodeId
    get('picker').hidden = !open
    get('listing').hidden = !open || !(picker.loading || !picker.sources.length)
    get('listing').textContent = !open ? '' : picker.loading ? VIDEO_SECTION_WORDS.listing : picker.sources.length ? '' : VIDEO_SECTION_WORDS.listEmpty
    // Main lists at most 40 windows; when there were more, say so (1.0.50 review video F7).
    const cut = open && !picker.loading && picker.total > picker.sources.length
    get('more').hidden = !cut
    get('more').textContent = cut ? `This list shows ${picker.sources.length} of ${picker.total} windows. If yours is missing, close windows you do not need, then press Refresh list.` : ''
    get('refresh').disabled = !open || picker.loading
    const last = open && picker.suggest?.title ? picker.suggest.title : ''
    get('last').hidden = !last
    get('last').textContent = last ? `Last time this agent showed “${last}”.` : ''
  }

  function changed() {
    render()
    try { onChange() } catch { /* the panel's own failure */ }
  }

  async function readSaved() {
    const link = bridge()
    if (sample || !link || typeof link.saved !== 'function') return
    const operation = ++savedOp
    let answer
    try { answer = await link.saved() } catch { answer = null }
    if (destroyed || operation !== savedOp) return
    if (answer?.ok === true && Array.isArray(answer.records)) {
      const before = supported
      if (typeof answer.supported === 'boolean') supported = answer.supported
      const next = new Map()
      for (const record of answer.records) {
        if (validNodeId(record?.nodeId) && typeof record.title === 'string') {
          next.set(record.nodeId, { title: record.title, app: typeof record.app === 'string' ? record.app : '' })
        }
      }
      const moved = before !== supported || next.size !== saved.size || [...next.keys()].some(nodeId => !saved.has(nodeId))
      saved = next
      savedProblem = ''
      if (moved) { changed(); return }
    } else if (answer?.code !== 'VIDEO_SAVED_UNAVAILABLE' && typeof answer?.reason === 'string') {
      // "Could not read" keeps what was read before, and says so.
      savedProblem = answer.reason
    }
    render()
  }
  function forgetLocally(nodeIds) {
    savedOp++ // a read still in flight describes the choices before this one
    let moved = false
    for (const nodeId of nodeIds) moved = saved.delete(nodeId) || moved
    if (!nodeIds.length && saved.size) { saved = new Map(); moved = true }
    return moved
  }

  function closePicker({ focus = false } = {}) {
    pickerOp++
    picker = null
    get('windows').replaceChildren()
    render()
    if (focus && !get('on').disabled) get('on').focus()
  }
  const thumbnailOf = value => typeof value === 'string' && value.length <= MAX_THUMBNAIL && THUMBNAIL.test(value) ? value : ''
  function windowButton(source, tag) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'agent-video-window'
    const image = document.createElement('img')
    image.className = 'agent-video-thumb'
    image.alt = ''
    const picture = thumbnailOf(source.thumbnail)
    if (picture) image.src = picture
    else image.dataset.empty = 'true'
    const name = document.createElement('span')
    name.className = 'agent-video-window-name'
    name.textContent = source.name || 'A window with no title'
    button.append(image, name)
    if (tag) {
      button.dataset.videoSuggested = 'true'
      const mark = document.createElement('span')
      mark.className = 'agent-video-tag'
      mark.textContent = tag
      button.append(mark)
    }
    sourceOf.set(button, source)
    button.addEventListener('click', () => pick(button))
    return button
  }

  async function openPicker({ suggest = null, focusName = null } = {}) {
    if (destroyed || !eligibility().ok) { render(); return false }
    const nodeId = agent.id
    const operation = ++pickerOp
    notice = null
    picker = { nodeId, loading: true, sources: [], suggest }
    get('windows').replaceChildren()
    render()
    let listed
    try { listed = await bridge().sources() } catch { listed = null }
    if (destroyed || operation !== pickerOp) return false
    if (listed?.ok !== true || !Array.isArray(listed.sources)) {
      picker = null
      // This desktop cannot capture a window (Linux Wayland): the section says so.
      if (listed?.code === 'VIDEO_UNAVAILABLE') { supported = false; changed(); return false }
      say(nodeId, typeof listed?.reason === 'string' ? listed.reason : VIDEO_SECTION_WORDS.listFailed)
      return false
    }
    const valid = listed.sources.filter(source => validToken(source?.token) && typeof source.name === 'string')
    const sources = valid.slice(0, MAX_WINDOWS)
    const total = Math.max(valid.length, Number.isSafeInteger(listed.total) ? listed.total : 0)
    const best = suggest ? bestTitleMatch(sources, suggest) : -1
    const ordered = best >= 0 ? [sources[best], ...sources.filter((_, index) => index !== best)] : sources
    picker = { nodeId, loading: false, sources: ordered, suggest, total }
    const exact = best >= 0 && ordered[0].name === suggest?.title
    const buttons = ordered.map((source, index) => windowButton(source,
      index === 0 && best >= 0 ? (exact ? 'Same as last time' : 'Closest to last time') : ''))
    get('windows').replaceChildren(...buttons)
    render()
    // The best match (or the window pressed on an out-of-date list) is only focused:
    // Enter or a press picks it, never this code. When the window pressed on an
    // out-of-date list is not in the new one, Refresh list is focused, never a
    // different window (REVIEW-1050 #16).
    const again = typeof focusName === 'string' ? ordered.findIndex(source => source.name === focusName) : -1
    ;(typeof focusName === 'string' ? buttons[again] || get('refresh') : buttons[0])?.focus()
    return true
  }

  /* INSIDE THE PERSON'S CLICK. start() arms the pick in main and asks for the
     window before anything else awaits: main grants only with this click's
     activation. */
  function pick(button) {
    const source = sourceOf.get(button)
    if (!source || !picker || picker.loading || !agent || picker.nodeId !== agent.id || !eligibility().ok) return
    const nodeId = agent.id
    const suggest = picker.suggest
    const pending = videos.start(nodeId, { token: source.token, label: source.name })
    closePicker()
    // The pressed window button is gone: keep keyboard focus in the section.
    const next = !get('off').hidden ? get('off') : get('on')
    if (!next.disabled) next.focus()
    void pending.then(answer => {
      if (destroyed) return
      /* 1.0.50 review video F4: main's tokens last 60 s, and any newer list
         ends them. Read the list again, still inside this click (main lists
         windows only for the person's click), keep it open on the same
         window and ask for one more press. Nothing streams until then. */
      if (answer?.code === 'VIDEO_PICK_EXPIRED' && !picker && agent?.id === nodeId) {
        void openPicker({ suggest, focusName: source.name }).then(opened => {
          if (!opened || destroyed) return
          const listed = picker?.sources.some(entry => entry.name === source.name) === true
          say(nodeId, listed ? VIDEO_SECTION_WORDS.listRenewed : VIDEO_SECTION_WORDS.windowGone)
        })
        return
      }
      // A video that runs but could not be saved says so; a refusal says why.
      say(nodeId, answer?.ok === true ? (answer.remembered === false ? answer.reason || '' : '')
        : answer?.reason || VIDEO_SECTION_WORDS.startFailed)
      void readSaved()
    })
  }

  get('on').addEventListener('click', () => {
    if (!eligibility().ok) { render(); return }
    const nodeId = agent.id
    const view = videos.get(nodeId)
    if (resumable(view)) {
      // Also inside the click: resume starts a capture.
      const pending = videos.resume(nodeId)
      notice = null
      render()
      // A failed resume leaves its reason on the paused video, which is shown here and on the panel.
      void pending.then(() => { if (!destroyed) render() })
      return
    }
    if (limitReached(nodeId)) { if (picker) closePicker(); say(nodeId, VIDEO_SECTION_WORDS.limit); return }
    void openPicker({ suggest: suggestionFor(nodeId) })
  })
  get('refresh').addEventListener('click', () => { if (picker && !picker.loading) void openPicker({ suggest: picker.suggest }) })
  get('cancel').addEventListener('click', () => closePicker({ focus: true }))
  get('off').addEventListener('click', () => {
    if (!agent) return
    const nodeId = agent.id
    if (picker?.nodeId === nodeId) closePicker()
    notice = null
    const moved = forgetLocally([nodeId])
    const pending = videos.stop(nodeId)
    if (moved) changed(); else render()
    void pending.then(async answer => {
      if (destroyed) return
      await readSaved()
      if (!destroyed && answer?.ok === false) say(nodeId, answer.reason || VIDEO_SECTION_WORDS.startFailed)
    })
  })
  get('off-all').addEventListener('click', () => {
    if (!usable()) return
    closePicker()
    forgetLocally([])
    const pending = videos.stopAll()
    changed()
    say(null, VIDEO_SECTION_WORDS.allOff)
    void pending.then(async answer => {
      if (destroyed) return
      await readSaved()
      if (!destroyed && answer?.ok === false) say(null, answer.reason || VIDEO_SECTION_WORDS.startFailed)
    })
  })

  // A stream started, ended or paused somewhere: say what this agent's is doing.
  // Boxes/Circles or edit mode changed: say whether a box shows it (D2).
  const onVideoChange = () => { if (!destroyed) render() }
  // A panel's "Pick the window again": open this section's list for that agent.
  const onPickRequest = event => {
    const nodeId = event?.detail?.nodeId
    if (destroyed || !validNodeId(nodeId)) return
    const name = typeof event.detail.name === 'string' && event.detail.name ? event.detail.name : names.get(nodeId) || ''
    setAgent({ id: nodeId, name, fromBoxPanel: true })
    try { onReveal() } catch { /* the panel stays where it is */ }
    // The same cap as the section's own button: no list is read that could not start.
    if (limitReached(nodeId)) { if (picker) closePicker(); say(nodeId, VIDEO_SECTION_WORDS.limit); return }
    void openPicker({ suggest: suggestionFor(nodeId) })
  }
  const events = page()
  events?.addEventListener?.(VIDEO_BOX_CHANGE_EVENT, onVideoChange)
  events?.addEventListener?.(VIDEO_BOX_PICK_EVENT, onPickRequest)
  events?.addEventListener?.(TREE_VIEW_CHANGE_EVENT, onVideoChange)

  function setAgent(next) {
    if (destroyed) return
    const value = next && validNodeId(next.id) ? next : null
    if (value?.name) names.set(value.id, String(value.name))
    const same = agent && value && agent.id === value.id
    agent = value ? { ...value, name: value.name || names.get(value.id) || '' } : null
    if (!same) { if (picker) closePicker(); notice = null }
    render()
  }
  async function refresh() {
    render()
    await readSaved()
  }
  render()
  void readSaved()

  return {
    el, setAgent, refresh, openPicker, closePicker: () => { if (picker) closePicker() },
    /** Agents whose box shows a panel: a stream the broker holds, or a choice saved before a restart. */
    getNodeIds() {
      if (!usable() || supported === false) return []
      return [...new Set([...videos.nodeIds(), ...saved.keys()])].sort()
    },
    /** Agents whose video was started in this run. A choice saved before a restart is not one:
        nothing streams until the person picks, so nothing may say "video on" for it. */
    getStartedNodeIds() {
      if (!usable() || supported === false) return []
      return [...videos.nodeIds()].sort()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      pickerOp++
      savedOp++
      events?.removeEventListener?.(VIDEO_BOX_CHANGE_EVENT, onVideoChange)
      events?.removeEventListener?.(VIDEO_BOX_PICK_EVENT, onPickRequest)
      events?.removeEventListener?.(TREE_VIEW_CHANGE_EVENT, onVideoChange)
      get('windows').replaceChildren()
      el.remove()
    },
  }
}
