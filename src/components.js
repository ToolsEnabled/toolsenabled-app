// Shared UI pieces: uptime ring, chat window, sparkline, tooltip.

import { uptimeParts } from './runtime-clock.js'
import { crescentSpec } from './crescent-field.js'
import { mountCrescent } from './crescent-mount.js'
import { onNextFrame } from './page-frames.js'
import { currentDataSource } from './data-source.js'
import { markRefusalCode, readerRemedy, refusalCodeOf } from './refusal-copy.js'
import { TERMINAL_SESSION_REFUSAL_CODES } from './saved-session-refusals.js'
import { CHAT, CHAT_CONTEXT_REPLIES, CHAT_REPLIES, ROLES, pick, roleAppearance } from './vocab.js'
import { roleColorCss } from './role-colors.js'
/* THE SAME SAFE MARKDOWN src/views/home.js ALREADY DRAWS ITS CHAT WITH. See
   the note above makeMsg's body render for which messages take it and why. */
import { setChatMessageBody, addChatMessageCopy, chatMessageSource } from './chat-message-body.js'
import { createReadableTextBuffer } from './chat-readable-stream.js'
import { THINKING_TRUNCATED_NOTICE } from '../shell/thinking-transcript.mjs'
/* THE IMPORTS FROM THE COPY MODULE keep this component
   copy-free rather than breaking that rule: the folded run's sentence used
   to be composed inline here ("N tool calls"), which was words living
   outside the plain-language gate's reach, and the approval strip's two
   decision words (Allow once / Refuse) come from the SAME vocabulary
   views/computers.js already uses for the same decision elsewhere in this
   product -- a second "Deny / Approve once" vocabulary next to that one
   would be the defect, not a feature (see src/chat-copy.js's header). */
import { actionRunDisclosureWord, actionRunLine, actionRunTotalText, approvalCardChoices, approvalDecisionWord, formatActionDuration, PALETTE_PANEL, QUEUE_PANEL } from './fleet-tree-copy.js'
/* THE UP-ARROW WALK OVER THE MESSAGES STILL WAITING TO SEND. Its rules are
   decisions about words a person can lose, and this component needs a DOM to
   run, so the walk itself lives in a module a test can call with values. See
   that module's header for the one rule the rest follow from. */
import { createQueueRecall } from './composer-queue-recall.js'
import { commonCommandIcon } from './common-command-icons.js'
import { mountChatSessionChanges } from './chat-session-changes.js'
import { boundedChangeEdits, boundedChangeOriginals, boundedChangePatches } from './session-change-patches.js'
import { createCompareFilesDoor } from './diff-editor.js'
/* THE COMPONENT'S OWN WORDS, moved out so tools/check-plain-language.mjs can
   scan them -- see src/chat-copy.js's header for why they left this file. */
import {
  ACTIONS_LABEL, ACTIONS_TITLE, ACTIONS_FILTER_PLACEHOLDER, ACTIONS_FILTER_LABEL, ACTIONS_BACK, ACTIONS_NO_MATCH, ACTION_RUN_FAILED,
  ACTIONS_TYPED_RUN, ACTIONS_TYPED_HINT, ACTIONS_TYPED_EMPTY,
  ACTIONS_BUILD_FAILED, actionsBuildFailedWhy,
  ATTACH_LABEL, ATTACH_TITLE, ATTACHMENT_REMOVE_TEXT, attachmentFilenameText, attachmentRemoveLabel, attachmentSizeText,
  CANNOT_SEND_PLACEHOLDER,
  CHAT_CONTEXT_FALLBACK,
  CHAT_DIFF_OPEN_TEXT, chatDiffAddedText, chatDiffOpenLabel, chatDiffPathText, chatDiffPositionText, chatDiffRemovedText, chatDiffStatusText,
  chatHeaderBranchCopy, chatHeaderContextCopy, chatHeaderPathCopy, chatHeaderStatusCopy, chatWorkspaceLabel,
  chatMessageTimeCopy,
  chatWorkingCountersLabel, chatWorkingCountersText,
  imageMessageStatusCopy, imageMessageActionFailureCopy, imageDeliveryNotice,
  CHIP_EFFORT_LABEL, CHIP_HALT_LABEL, CHIP_HALT_DISABLED_HINT,
  COLLAPSE_LABEL,
  COMPOSER_PLACEHOLDER,
  EMPTY_LOG_NOTE, EXPAND_LABEL, STREAM_HELD_NOTE, STREAM_PENDING_NOTE,
  MENTION_LABEL, MENTION_TITLE, mentionInsertText,
  messageAriaLabel, messagePlaceholder,
  newBelowCountLabel, NEW_BELOW_FALLBACK, NO_SENDER_WIRED,
  QUEUE_FAILED, QUEUE_HOLD_FAILED, QUEUE_PROMOTE_FAILED, QUEUE_SEND_NEXT, sendNextLabel, QUEUE_SEND_NOW, QUEUE_SEND_NOW_LABEL, QUEUE_UNQUEUE, QUEUE_UNQUEUE_LABEL,
  RECALL_EDIT_ALREADY_SENT,
  resumedAtLabel,
  SEARCH_BUTTON_TEXT, SEARCH_INPUT_LABEL, SEARCH_INPUT_PLACEHOLDER, SEARCH_TOGGLE_LABEL,
  SEND_FAILED, SEND_LABEL,
  STOP_FAILED, STOP_LABEL, STOP_TITLE, DISCARDED_REPLY,
  typingLabel,
  UPTIME_CAPTION, UPTIME_UNITS,
  WORKING_CANCEL, CHAT_THINKING, CHAT_RESPONDING, CHAT_WAITING, chatUsingToolText, COMPOSER_SEND_HINT,
  APPROVAL_STRIP_LABEL, APPROVAL_RETRY_HINT,
} from './chat-copy.js'

const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

export const CHAT_HEADER_META_SEAM = true
export const CHAT_MESSAGE_TIME_SEAM = true
export const CHAT_ACTIVITY_DURATION_SEAM = true
export const CHAT_DIFF_CARD_SEAM = true
export const CHAT_WORKING_METRICS_SEAM = true

// Chat selection opens the existing editor with that file. Native reads and
// saves still pass through the compare window's workspace fence.
export function createChatDiffOpenHandler(door) {
  if (!door || typeof door !== 'object' || typeof door.open !== 'function') {
    throw new TypeError('createChatDiffOpenHandler requires a door with open()')
  }
  return selection => door.open(selection)
}

const CHAT_DIFF_SOURCE = 'session-file-change'
const CHAT_DIFF_FILE_KEYS = Object.freeze(['path', 'status', 'added', 'removed'])
const CHAT_DIFF_STATUSES = Object.freeze({
  c: 'C', changed: 'C',
  a: 'A', add: 'A', added: 'A', create: 'A', created: 'A',
  m: 'M', modify: 'M', modified: 'M', update: 'M', updated: 'M',
  d: 'D', delete: 'D', deleted: 'D', remove: 'D', removed: 'D',
  r: 'R', rename: 'R', renamed: 'R', move: 'R', moved: 'R',
})

function normalizedChatDiffFile(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  let keys = null
  let path
  let status
  let added
  let removed
  try {
    keys = Reflect.ownKeys(candidate)
    if (keys.length !== CHAT_DIFF_FILE_KEYS.length
        || !CHAT_DIFF_FILE_KEYS.every(key => keys.includes(key))) return null
    path = candidate.path
    status = candidate.status
    added = candidate.added
    removed = candidate.removed
  } catch {
    return null
  }
  if (typeof path !== 'string' || path.length > 4096 || path.trim() === '') return null
  if (typeof status !== 'string') return null
  const statusKey = status.trim().toLowerCase()
  const canonicalStatus = Object.hasOwn(CHAT_DIFF_STATUSES, statusKey) ? CHAT_DIFF_STATUSES[statusKey] : ''
  if (!canonicalStatus) return null
  if (canonicalStatus === 'C') return added === null && removed === null ? { path, status: 'C', added: null, removed: null } : null
  if (!Number.isFinite(added) || !Number.isInteger(added) || added < 0) return null
  if (!Number.isFinite(removed) || !Number.isInteger(removed) || removed < 0) return null
  return { path, status: canonicalStatus, added, removed }
}

/* root.addDiff is a public boundary even when its caller already used
 * sessionActivityEvent. Validate again and clone again: restored storage and a
 * live adapter enter through the same door, and neither is allowed to retain a
 * reference that can rewrite a card after it was accepted. */
function normalizedChatDiffBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null
  let source
  let candidates
  let activeIndexSupplied
  let activeIndex
  let id
  let at
  try {
    source = batch.source
    candidates = batch.files
    activeIndexSupplied = Object.hasOwn(batch, 'activeIndex')
    activeIndex = batch.activeIndex
    id = batch.id
    at = batch.at
  } catch {
    return null
  }
  if (source !== CHAT_DIFF_SOURCE || !Array.isArray(candidates)) return null
  let length = 0
  try { length = candidates.length } catch { return null }
  if (length === 0) return null
  const files = []
  for (let index = 0; index < Math.min(length, 100); index += 1) {
    let candidate = null
    try { candidate = candidates[index] } catch { continue }
    const file = normalizedChatDiffFile(candidate)
    if (file) files.push(file)
  }
  if (files.length === 0) return null
  const selectedIndex = activeIndexSupplied ? activeIndex : 0
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= files.length) return null
  const normalized = { source: CHAT_DIFF_SOURCE, files, activeIndex: selectedIndex }
  if (batch.limited === true || length > 100) normalized.limited = true
  const patches = boundedChangePatches(batch.patches, files)
  if (patches.length) normalized.patches = patches
  /* THE OTHER TWO CHANNELS TRAVEL WITH THE PATCHES, and leaving them out here
     silently emptied both. This function is the only way a change reaches the
     Changes panel's store, and the store reads batch.edits and batch.originals
     off what this returns -- so a dropped field did not degrade the left pane,
     it removed it: every unmeasured edit found no matching entry and marked its
     file unreversible, for every file and every session. Bounded here for the
     same reason the patches are: this is the boundary the store trusts. */
  let edits = []
  let originals = []
  try { edits = boundedChangeEdits(batch.edits, files) } catch { edits = [] }
  try { originals = boundedChangeOriginals(batch.originals, files) } catch { originals = [] }
  if (edits.length) normalized.edits = edits
  if (originals.length) normalized.originals = originals
  if (typeof id === 'string' && id.trim() !== '') normalized.id = id
  if (Number.isFinite(at)) normalized.at = at
  return normalized
}

function synchronousHeaderMetaRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  let then = null
  try { then = value.then } catch { return false }
  if (typeof then !== 'function') return true
  /* A provider is synchronous. Consume a rejected promise so an invalid read
     cannot become an unhandled process error after the UI has ignored it. */
  try { Promise.resolve(value).catch(() => {}) } catch { /* absence is the result */ }
  return false
}

export const el = (html) => {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

/* THE COMPOSER'S OWN SELECTORS, EXPORTED SO NOTHING ELSE HAS TO GUESS THEM.
 *
 * B-pool-6's research found four independent phrasings for this one input
 * across nine end-to-end drivers (`.chat-input input`,
 * `[data-rail-chat-host] .chat-input input`, a template-interpolated
 * equivalent, and `.chat input[type="text"]`), plus two class-only
 * approval buttons a driver could only ever find by their CSS dress. This
 * component already treats the composer's selector as a real concern it
 * owns, not an afterthought -- see the fallback at buildChat's own
 * `const input = root.querySelector(CHAT_COMPOSER_INPUT_SELECTOR) ||
 * root.querySelector('input')` a few hundred lines down, kept for the
 * deliberately tiny DOM stand-ins several unit tests still mount. A driver
 * (or a test) composes its own scoping prefix AROUND these constants
 * rather than retyping the suffix, so the day this markup changes there is
 * exactly one place that has to know. */
export const CHAT_COMPOSER_INPUT_SELECTOR = '.chat-input input'
export const CHAT_APPROVAL_SELECTOR = Object.freeze({
  accept: '[data-chat-approval="accept"]',
  decline: '[data-chat-approval="decline"]',
})

/**
 * The one render-time contract for a control that may refuse.
 *
 * `why` is required even when the control is enabled (use `null`). That small
 * bit of ceremony is deliberate: a caller cannot pass the fact that decides
 * `enabled` and forget to decide what the same render will say when it is
 * false. A disabled control without a non-empty reason is rejected outright.
 */
export function controlState(options) {
  if (!options || typeof options !== 'object'
      || !Object.hasOwn(options, 'enabled') || !Object.hasOwn(options, 'why')) {
    throw new TypeError('controlState requires { enabled, why }')
  }
  if (typeof options.enabled !== 'boolean') {
    throw new TypeError('controlState enabled must be a boolean')
  }
  const why = typeof options.why === 'string' ? options.why.trim() : ''
  if (!options.enabled && !why) {
    throw new TypeError('controlState requires a reason when disabled')
  }
  return Object.freeze({ enabled: options.enabled, disabled: !options.enabled, why })
}

let gradSeq = 0

/**
 * FNV-1a — a small, stable string hash. Used where a value has to be
 * *arbitrary but the same every time* (see buildChat's seeded history):
 * Math.random() there produced a different past for the same conversation
 * on every open, which reads as data being invented in front of the user.
 */
function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Big glowing uptime ring. Returns { el, update, destroy }.
 * update() re-renders digits + arc from the epoch.
 */
export function uptimeRing({ size = 460, epoch, colors = ['#35eab7', '#45d6ff'], caption = UPTIME_CAPTION, sub = '', showDays = true, crescent = false, corona = true }) {
  const stroke = Math.max(7, size * 0.02)
  const r = (size - stroke * 2 - 14) / 2
  const cx = size / 2
  const gid = `uring-grad-${++gradSeq}`
  const circ = 2 * Math.PI * r

  // The sketch's hero: a plain circle with a crescent of light hugging its
  // OUTSIDE-LEFT edge — an offset shadow made of light rather than a progress
  // sweep. Its colour is the fleet's load: green idle, orange climbing, red
  // full throttle. Three layers — a broad outer haze, a mid halo and a tight
  // bright core — give the falloff, each wider, softer and fainter than the one
  // inside it, and all nudged left so the light reads as coming from beside the
  // circle rather than from the stroke itself.
  //
  // The DESIGN is unchanged. What changed is that it is no longer approximated.
  // These three layers used to be stroked arcs handed to feGaussianBlur, which
  // cost the render four defects that were measured, not guessed: the barely
  // blurred core ended in two blunt linecap tips; the blur radii stepped 5.5x
  // then 2.27x and left a shoulder in the falloff; the haze's filter region
  // cleared its own blur by 0.85px at every size; and stacked 8-bit translucent
  // layers band. src/crescent-field.js evaluates the same light in closed form
  // instead — see its header. The arcs' apertures, widths, blur radii, offset
  // and opacities are all still the numbers below, read from crescentSpec().
  const svgBody = crescent
    ? `<circle class="uring-rim" cx="${cx}" cy="${cx}" r="${crescentSpec(size).r}" fill="none" stroke-width="2"/>`
    : `
        <defs>
          <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${colors[0]}"/>
            <stop offset="100%" stop-color="${colors[1]}"/>
          </linearGradient>
        </defs>
        <circle class="track" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="${stroke * 0.55}"/>
        <g transform="rotate(-90 ${cx} ${cx})">
          <circle class="arc-glow" cx="${cx}" cy="${cx}" r="${r}" fill="none"
            stroke="url(#${gid})" stroke-width="${stroke * 1.5}" stroke-linecap="round"
            stroke-dasharray="0 ${circ}"/>
          <circle class="arc" cx="${cx}" cy="${cx}" r="${r}" fill="none"
            stroke="url(#${gid})" stroke-width="${stroke}" stroke-linecap="round"
            stroke-dasharray="0 ${circ}"/>
        </g>`

  const root = el(`
    <div class="uring ${size < 240 ? 'compact' : ''} ${crescent ? 'crescent' : ''}" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${svgBody}
      </svg>
      <div class="uring-center">
        <div class="uring-inner">
          <div class="uring-digits"></div>
          <div class="uring-caption">${caption}</div>
          ${sub ? `<div class="uring-sub">${sub}</div>` : ''}
        </div>
      </div>
    </div>
  `)

  /* The crescent mounts itself: a GPU corona when WebGL2 is there, the CPU
     masked layers when it is not. Either way it inserts ahead of the SVG so the
     rim stays the topmost drawn line. */
  const crescentMount = crescent && corona ? mountCrescent(root, size) : null
  if (crescentMount) {
    root.crescentMode = crescentMount.mode
    root.redrawCrescent = crescentMount.redraw
    root.destroyCrescent = crescentMount.destroy
  }

  const digitsEl = root.querySelector('.uring-digits')
  const arcs = root.querySelectorAll('.arc, .arc-glow')

  /** Load state drives the crescent's colour. 0..1 → idle | busy | peak. */
  let lastState = ''
  root.setLoad = (v) => {
    const state = v >= 0.72 ? 'peak' : v >= 0.38 ? 'busy' : 'idle'
    if (state !== lastState) { lastState = state; root.dataset.load = state }
  }
  if (crescent) root.setLoad(0)

  const seg = (n, u) => `<span class="seg"><span class="n">${n}</span><span class="u">${u}</span></span>`
  const colon = `<span class="colon">:</span>`

  let lastKey = ''
  function update() {
    const p = uptimeParts(epoch)
    const key = `${p.d}:${p.h}:${p.m}:${p.s}`
    if (key !== lastKey) {
      lastKey = key
      digitsEl.innerHTML = showDays
        ? seg(p.d, UPTIME_UNITS.days) + colon + seg(p.h, UPTIME_UNITS.hours) + colon + seg(p.m, UPTIME_UNITS.minutes) + colon + seg(p.s, UPTIME_UNITS.seconds)
        : seg(p.h, UPTIME_UNITS.hours) + colon + seg(p.m, UPTIME_UNITS.minutes) + colon + seg(p.s, UPTIME_UNITS.seconds)
    }
    if (!crescent) {
      const sweep = circ * p.frac
      arcs.forEach(a => a.setAttribute('stroke-dasharray', `${sweep} ${circ - sweep}`))
    }
  }
  update()

  return { el: root, update }
}

const CHAT_MINUTE = 60 * 1000
const CHAT_CLUSTER_GAP = 8 * CHAT_MINUTE
const CHAT_CLOCK_ORIGIN = Date.now()
const COORDINATING_CHAT_ROLES = new Set(['coordinator', 'helper', 'shadow', 'manager'])

const liveChats = new Set()
let chatLifecycleObserver = null

const chatDebug = import.meta.env?.DEV && typeof window !== 'undefined'
  ? (window.__chatDebug = {
      activeChats: 0,
      pendingTimers: 0,
      typingIndicators: 0,
      streams: 0,
      queuedTurns: 0,
      completedReplies: 0,
      disposedChats: 0,
    })
  : null

function bumpChatDebug(key, amount) {
  if (!chatDebug) return
  chatDebug[key] = Math.max(0, (chatDebug[key] || 0) + amount)
}

function sweepChatLifecycles() {
  for (const entry of [...liveChats]) {
    if (entry.root.isConnected) {
      entry.seenConnected = true
      entry.morphHost ||= entry.root.closest('.as-chat')
      // Chip and comms chats remain mounted for their closing morph. Their
      // host dropping .as-chat is the actual close signal, so reply work is
      // stopped before that half-second shell animation removes the DOM.
      if (entry.morphHost && !entry.morphHost.classList.contains('as-chat')) entry.dispose()
    } else if (entry.seenConnected && !entry.retainOnDetach) {
      // Full-page and rail chats have no close button. Disconnection is their
      // view/rail teardown, including innerHTML swaps on the computers rail.
      entry.dispose()
    }
  }
  if (!liveChats.size && chatLifecycleObserver) {
    chatLifecycleObserver.disconnect()
    chatLifecycleObserver = null
  }
}

function registerChatLifecycle(entry) {
  liveChats.add(entry)
  if (!chatLifecycleObserver && typeof MutationObserver !== 'undefined') {
    chatLifecycleObserver = new MutationObserver(sweepChatLifecycles)
    chatLifecycleObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  }
  queueMicrotask(sweepChatLifecycles)
  return () => {
    liveChats.delete(entry)
    if (!liveChats.size && chatLifecycleObserver) {
      chatLifecycleObserver.disconnect()
      chatLifecycleObserver = null
    }
  }
}

function chatReducedMotion() {
  return document.body.classList.contains('reduce-motion')
    || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function liveChatTiming(at) {
  const suppliedCopy = chatMessageTimeCopy(at)
  if (suppliedCopy) return { sequenceAt: at, semanticAt: at, copy: suppliedCopy }
  const sequenceAt = Date.now()
  const copy = chatMessageTimeCopy(sequenceAt)
  return { sequenceAt, semanticAt: copy ? sequenceAt : null, copy }
}

function restoredChatTiming(at) {
  const copy = chatMessageTimeCopy(at)
  if (copy) return { sequenceAt: at, semanticAt: at, copy }
  return { sequenceAt: Date.now(), semanticAt: null, copy: null }
}

function normalizeChatContext(value) {
  const parts = []
  const add = (candidate) => {
    if (Array.isArray(candidate)) { candidate.forEach(add); return }
    if (typeof candidate !== 'string' && typeof candidate !== 'number') return
    const text = String(candidate).replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const preferred = ['activity', 'activities', 'task', 'status', 'progress', 'current']
      .filter(key => Object.hasOwn(value, key))
    ;(preferred.length ? preferred.map(key => value[key]) : Object.values(value)).forEach(add)
  } else add(value)

  let text = parts.join(' · ').replace(/[\s,;:.!?—–-]+$/u, '')
  if (text.length > 190) text = `${text.slice(0, 187).trimEnd()}…`
  return text
}

/* THE OLD LOCAL-SIDECAR NAME IS GONE FROM HERE, AND IT WAS THE WORST OF ITS NINE
   PLACES. It mapped an internal subsystem's name to a role, so the literal word
   was styled as an agent in REAL conversations, not only in the example fleet.
   The owner's ruling: the name was never meant to ship. terra-02, which replaces
   it in the example, is deliberately NOT added here -- terra-NN and luna-NN have
   always been absent from this map and take the default role, and the pattern
   below already matches them. */
const INLINE_AGENT_ROLES = Object.freeze({
  codex: 'coordinator',
  claude: 'helper',
  'shadow-mgr': 'shadow',
})

const escapeInlineHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const escapeInlineRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* THE TOKEN PATTERN IS BUILT ONCE PER ROSTER, NOT ONCE PER REPAINT.
 *
 * formatInlineText runs on every assistant text frame and on every activity
 * row, and it was compiling this four-branch pattern -- three lookbehinds, the
 * unicode flag, and the whole agent roster spliced in -- on every one of those
 * calls. Compiling a regex of this shape is not free, and the compile was
 * repeated for a pattern that is a pure function of the roster.
 *
 * KEYED ON THE ROSTER PATTERN STRING, which is exactly what the regex is built
 * from: same agentPattern, same regex, by construction. Nothing else in the
 * expression varies.
 *
 * REUSE IS SAFE DESPITE THE `g` FLAG. This regex is only ever handed to
 * String.prototype.replace, and a global regex passed to replace has its
 * lastIndex set to 0 before the pass begins and reset after -- so a cached
 * instance cannot carry position state from one call into the next. It must
 * never be used with .test() or .exec() for that reason.
 *
 * BOUNDED, because a roster is per-conversation and a long session can meet
 * many. The cap is small and eviction is oldest-first; a miss costs exactly
 * what every call used to cost. */
const INLINE_PATTERN_CACHE = new Map()
const INLINE_PATTERN_CACHE_MAX = 16

function inlineTokenPattern(agentPattern) {
  const cached = INLINE_PATTERN_CACHE.get(agentPattern)
  if (cached) return cached
  const pattern = new RegExp(
    `(?<path>(?:[a-z]:[\\\\/])?(?:[a-z0-9_.-]+[\\\\/])+[a-z0-9_.-]*[a-z0-9_-])`
      + `|(?<request>\\b[qr]\\d+(?:\\.\\d+)*\\b)`
      + `|(?<agent>(?<![\\w-])(?:${agentPattern})(?![\\w-]))`
      + '|(?<number>(?<![\\w.#])\\d+(?:\\.\\d+)?(?:\\s+(?:seconds?|minutes?|hours?|days?|tasks?|checks?|tokens?|of\\s+\\d+)|\\s*(?:%|ms|s|m|h)(?!\\w))?(?![\\w.]))',
    'giu',
  )
  if (INLINE_PATTERN_CACHE.size >= INLINE_PATTERN_CACHE_MAX) {
    INLINE_PATTERN_CACHE.delete(INLINE_PATTERN_CACHE.keys().next().value)
  }
  INLINE_PATTERN_CACHE.set(agentPattern, pattern)
  return pattern
}

/**
 * Escape-safe quiet emphasis for operational prose. The source string is
 * escaped in full before the one combined token pass adds the only markup
 * this function can emit; callers can therefore assign the result to
 * innerHTML without making activity/context text an HTML surface.
 */
export function formatInlineText(value, { agents = [], roleKey = 'default' } = {}) {
  const escaped = escapeInlineHtml(value)
  if (!escaped) return ''

  const roster = []
  const seen = new Set()
  const addAgent = (agent) => {
    if (!agent?.name) return
    const key = String(agent.name).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roster.push(agent)
  }
  /* The roster comes from the CALLER's agents, full stop. This used to also
     walk sim.computers, which meant every live chat's @-mention highlighting
     was built partly from the demonstration engine's invented fleet -- live
     text lit up for agents that never existed on this machine. The literal
     fallback patterns below still cover the example world's names, so the
     example loses nothing. */
  for (const agent of agents || []) addAgent(agent)

  const literalNames = roster
    .map(agent => escapeInlineRegex(escapeInlineHtml(agent.name)))
    .sort((a, b) => b.length - a.length)
  const agentPattern = [
    ...literalNames,
    'gem-lane-[a-z0-9_-]+',
    'sandbox-w\\d+',
    'luna-\\d+',
    'terra-\\d+',
    'shadow-mgr',
    'codex',
    'claude',
  ].join('|')
  const tokenPattern = inlineTokenPattern(agentPattern)

  return escaped.replace(tokenPattern, (token, ...args) => {
    const groups = args.at(-1) || {}
    if (groups.path || groups.request) return `<span class="inline-register">${token}</span>`
    if (groups.number) return `<span class="inline-number">${token}</span>`
    if (groups.agent) {
      const folded = token.toLowerCase()
      const match = roster.find(agent => escapeInlineHtml(agent.name).toLowerCase() === folded)
      const fallback = folded.startsWith('sandbox-') ? 'spawned'
        : folded.startsWith('shadow-') ? 'shadow'
          : INLINE_AGENT_ROLES[folded] || roleKey
      const resolved = match?.declaredRole || match?.role || fallback
      const role = Object.hasOwn(ROLES, resolved) ? resolved : 'default'
      return `<span class="inline-agent role-${role}" style="--rc:${roleColorCss(resolved)};--role-ink:${roleColorCss(resolved, 'text')}">${token}</span>`
    }
    return token
  })
}

/** Build a chat window element (used inside chips, home feed, agent page). */
/* Text, never markup a browser parses. Each view in this app carries its own
   copy of this rather than importing a shared one; following that convention
   rather than introducing a shared module mid-sprint. */
const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
))

/* `title` USED to be product-controlled -- sim agents and fleet-record labels --
   which is why it reached innerHTML raw for so long without anyone being wrong.
   A tree node is now named from the first line of the person's own brief, so
   `run <the migration>` breaks the chat head and a single `"` escapes the
   placeholder attribute on the line below. The label stays verbatim on purpose
   (mangling somebody's words in the one place they compare them against what
   they typed is worse), so every sink escapes instead. */

/* WHICH FOLDS A PERSON HAS OPENED, REMEMBERED PER KEY.
 *
 * Extracted from addContext below, byte-for-byte in behaviour, because the home
 * screen's run rows now fold the same way the chat's context block does and
 * the owner asked for exactly that: "collapse the context and such as it goes
 * like we do in chat." One memory with two prefixes is one rule; a second copy
 * inside home.js would be the version that drifts.
 *
 * `recall` answers 'open' | 'closed' | null, where null is "nobody has said"
 * and the caller picks its own default -- a row that should open because it
 * is the newest, say. `remember` writes the choice. Both swallow a storage
 * that refuses (private mode, a shim that throws): a fold that cannot be
 * remembered is still a fold that opens for this sitting. No key means no
 * memory rather than a shared one, the same rule addContext always had. */
export function openMemory(prefix) {
  const base = typeof prefix === 'string' ? prefix : ''
  return {
    recall(key) {
      if (!key) return null
      try {
        const value = localStorage.getItem(base + key)
        return value === 'open' || value === 'closed' ? value : null
      } catch { return null }
    },
    remember(key, open) {
      if (!key) return
      try { localStorage.setItem(base + key, open ? 'open' : 'closed') } catch { /* session-only is still a real change */ }
    },
  }
}

/* THE OWNED DISCLOSURE GESTURE, for a <details> whose whole row should open.
 *
 * MEASURED on a staged packaged build (the reasoning is at makeAction below):
 * document.elementFromPoint over any part of a collapsed row answers the
 * DETAILS element rather than the SUMMARY inside it, so a press beside the
 * triangle is not a press on the disclosure and nothing opens. The row looked
 * pressable and was not. So the native toggle is cancelled and redone by hand,
 * which also stops a press on the summary toggling twice.
 *
 * THE ONE NARROWING, which is why the home rows cannot simply reuse addContext's
 * handler: a run row's open body holds text a person selects and a link they
 * follow, and a gesture that folds the row on every press inside it would take
 * both away. `within` is the element whose presses toggle (the summary); a
 * press whose target is the details itself -- the elementFromPoint case on a
 * collapsed row -- still toggles, and a press inside the open body is left
 * alone. Keyboard needs nothing extra: the summary is natively focusable and
 * Enter or Space fire a click on it. With no `within`, every press toggles,
 * which is the behaviour addContext has always had. */
export function ownDisclosure(details, { within = null, onToggle = null } = {}) {
  details.addEventListener('click', (event) => {
    if (within && event.target !== details && !within.contains(event.target)) return
    event.preventDefault()
    details.open = !details.open
    if (typeof onToggle === 'function') onToggle(details.open)
  })
}

/* Four OPTIONAL powers a live-agent caller may hand this composer (every
   existing caller compiles unchanged; the component stays outbox- and
   fleet-agnostic — the closures own the mechanisms):
     status  — { busy(), subscribe(onChange) → unsubscribe }: whether the
               agent is mid-turn. Drives the send↔stop morph.
     queue   — { list(), add(text) → {ok, sentence?}, cancel(id),
               subscribe(onChange) → unsubscribe, replace(id, text) →
               {ok, sentence?} }: messages waiting to send.
               While busy, a typed send QUEUES — no "me" bubble, because the
               strip above the composer is the preview and a bubble would
               claim the words were sent.
               `replace` is OPTIONAL and is what ↑ needs to be more than a
               read-only look at the queue: it rewrites ONE waiting message
               in place, keeping its position and its id (see
               src/session-outbox.js — an edit that reordered the queue would
               send a corrected first message last). A queue without it still
               gets the walk, and the composer says once that the edit was
               not kept rather than swallowing it.
               `hold({entryId}|{text})` optionally keeps Send now saved while
               an interrupt is pending. Its {ok, entry, take(), release()}
               result consumes only on take; release leaves the words queued.
               {ok:true, direct:true} routes a console command without a halt.
     actions — () → rows of { id, label, hint, enabled, run(ctx) }: the
               popup's content, built FRESH at every open. run's ctx has
               say(sentence), close(), and show(rows, {title}) for two-stage
               quick-picks (effort, model, rewind) inside one popup.
     onStop  — () → Promise<sentence|void|{ok, sentence, settled?}>: pressed as the STOP face of the
               send button (busy + empty input). The sentence lands as an
               agent bubble.
     composerReason
             — a sentence, when this conversation CANNOT be spoken to. The
               log stays real and readable; the message box and the send
               button are disabled and the sentence sits above them saying
               why. It is how a chat opens over an agent that never started
               without becoming a text box that swallows what a person types
               (the defect src/node-chatbox.js's header names). It also makes
               the seeded simulator below structurally unreachable for such a
               caller: `send` is refused before it can reach the fake path,
               so an honest read-only chat can never answer itself. */
/* A pasted image arrives as an ArrayBuffer; the IPC boundary carries it as a
   base64 string (agent-command-surface.cjs's parseAgentPasteAttachment reuses
   the same boundedAgentString length check every other text-shaped field
   already gets). Chunked so a several-megabyte image does not blow the
   engine's own argument-count ceiling for String.fromCharCode(...spread). */
/* THE FOUR KINDS A PASTED PICTURE MAY BE, keyed by the extension on the file's
   own name. Deliberately the same four the main process already allows for a
   pasted image (PASTE_IMAGE_MIME_EXTENSIONS in shell/main.cjs, itself the same
   set the attach dialog filters on): a picture copied in Explorer and one
   picked through the button land in the same reviewed set. `.jpeg` and `.jpg`
   are one kind under two names, which is why this is its own table rather than
   the boundary's inverted.

   Frozen, and consulted only with a value read off a File the browser handed
   us; the caller never chooses the string, and the extension written to disk is
   still chosen at the boundary from the mime, never from this name. */
const PASTED_IMAGE_FILE_MIMES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
})

/* THE KINDS THIS WINDOW WILL BUILD A data: URL FROM, and it is deliberately the
   set above and nothing wider. A pasted clipboard item carries whatever media
   type its source claimed, and that string would otherwise go straight into the
   src of an element this file creates. Closing the set here means an unexpected
   kind draws nothing rather than being trusted -- image/svg+xml in particular
   is a document, not a bitmap, and has no business in a chat bubble. */
const PICTURE_MIMES = new Set(Object.values(PASTED_IMAGE_FILE_MIMES))

const attachmentIdentity = path => {
  const text = String(path).replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(text) || text.startsWith('//') ? text.toLowerCase() : text
}

const hostDraftAttachment = item => item?.kind === 'host-draft-image'
  && typeof item.imageId === 'string' && item.imageId.length > 0 && !Object.hasOwn(item, 'path')
  && typeof item.hostDraft?.draftId === 'string' && item.hostDraft.draftId.length > 0
  && typeof item.hostDraft.sessionId === 'string' && item.hostDraft.sessionId.length > 0
  && typeof item.hostDraft.computerId === 'string' && item.hostDraft.computerId.length > 0
  && typeof item.hostDraft.conversationId === 'string' && item.hostDraft.conversationId.length > 0
  && typeof item.hostDraft.ownerContext?.ownerId === 'string'
  && typeof item.hostDraft.ownerContext?.currentEpoch === 'string'
const hostGrantFields = grant => ({ draftId: grant.draftId, sessionId: grant.sessionId,
  computerId: grant.computerId, conversationId: grant.conversationId, ownerContext: grant.ownerContext })
const composerAttachmentKey = item => hostDraftAttachment(item)
  ? JSON.stringify(['host-draft-image', hostGrantFields(item.hostDraft), item.imageId])
  : attachmentIdentity(item.path)
const composerAttachmentName = item => hostDraftAttachment(item)
  ? (typeof item.name === 'string' && item.name ? item.name : 'Pasted image')
  : attachmentFilenameText(item.path)
/* A PASTED PICTURE HAS NO NAME A PERSON CAN USE. The host saves it under
   paste-attachments/ with a random file name ('0566bb63-afe7-...png'), so two
   pasted screenshots could not be told apart in the box and Remove named a
   random id (T1482). Such pictures, and host-draft images without a name,
   read 'Pasted image', numbered in the order they sit in the box when there
   is more than one. A file the person picked keeps its own name. */
const PASTED_PICTURE_FILE = /[\\/]paste-attachments[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i
const unnamedPastedPicture = item => hostDraftAttachment(item)
  ? !(typeof item.name === 'string' && item.name)
  : typeof item?.path === 'string' && PASTED_PICTURE_FILE.test(item.path)
const composerAttachmentLabels = attachments => {
  const pasted = attachments.filter(unnamedPastedPicture).length
  let seen = 0
  return attachments.map(item => unnamedPastedPicture(item)
    ? (pasted > 1 ? `Pasted image ${++seen}` : 'Pasted image')
    : composerAttachmentName(item))
}
const hostDraftForAttachments = attachments => {
  if (!attachments.length || !attachments.every(hostDraftAttachment)) return null
  const grant = hostGrantFields(attachments[0].hostDraft), key = JSON.stringify(grant)
  if (attachments.some(item => JSON.stringify(hostGrantFields(item.hostDraft)) !== key)
    || new Set(attachments.map(item => item.imageId)).size !== attachments.length) return null
  return { ...grant, imageIds: attachments.map(item => item.imageId) }
}

/* WHAT A PASTED PICTURE LOOKS LIKE, KEPT WHERE IT IS ALREADY IN HAND.
   The paste handler reads the clipboard into base64 to send it to the main
   process, and then threw that string away; the only thing left was a file
   path, and nothing in this window can read a file. So the person saw their
   own message with the words and no picture.

   SEPARATE FROM THE ATTACHMENT, DELIBERATELY, AND THAT RULE IS LOAD-BEARING.
   The attachment object is what onSend receives and what crosses the window
   boundary; the file is already written and the provider is sent the path, so
   putting megabytes of base64 back on that object would make the person pay
   for the same picture twice. tools/test/pasted-picture-shows-in-your-own-bubble
   holds exactly that and it caught me: my first attempt at T332 handed the
   bytes out on send, and the test was right to refuse them.

   MODULE-SCOPED, NOT PER-COMPOSER (T332). This used to live inside buildChat,
   so the bytes died with the chat instance that read them -- and a
   conversation that is reopened, remounted, or mirrored into a second open
   surface builds a NEW buildChat, which found nothing. That is why the picture
   vanished from the sent message. One cache, keyed by the same path the entry
   records, lets every surface draw the same picture without it ever crossing
   the boundary again.

   BOUNDED, and a dropped one simply does not draw -- it is a preview, never
   the record. Making it a record is T290(b): the bytes beside the transcript,
   in the app own state. */
const PASTED_PICTURE_MEMORY = 32
const pastedPictures = new Map()
const rememberPastedPicture = (path, base64, mime) => {
  if (!PICTURE_MIMES.has(mime) || typeof base64 !== 'string' || !base64) return
  const identity = attachmentIdentity(path)
  pastedPictures.delete(identity)
  pastedPictures.set(identity, { mime, base64, name: attachmentFilenameText(path), path })
  while (pastedPictures.size > PASTED_PICTURE_MEMORY) pastedPictures.delete(pastedPictures.keys().next().value)
}
const picturesRiding = attachments => attachments
  .map(item => pastedPictures.get(composerAttachmentKey(item)))
  .filter(Boolean)
/* WHAT AN ENTRY RECORDS: WHICH picture, never the picture itself. A reference
   costs a path and a name; the bytes stay in the cache above and on disk. That
   is what lets a stored message survive a repaint without the send, the
   transcript or the outbox ever carrying an image. */
const pictureRefsRiding = attachments => picturesRiding(attachments)
  .map(picture => ({ path: picture.path, mime: picture.mime, name: picture.name }))
/* Resolve a recorded reference back to something drawable. An entry carrying
   its own bytes -- a durable record, once T290(b) writes one -- wins; else the
   shared cache answers; and a picture nobody can resolve draws nothing rather
   than drawing a broken image. */
const drawablePicture = picture => {
  if (!picture) return null
  if (typeof picture.base64 === 'string' && picture.base64) return picture
  const held = picture.path ? pastedPictures.get(attachmentIdentity(picture.path)) : null
  return held ? { ...held, name: picture.name || held.name } : null
}

/* THE ONE READING OF A CLIPBOARD, exported so every surface that accepts a
   pasted picture agrees on what one is. The composer uses it below; the agent
   session surface (src/agent-session.js) uses it for its Prompt box, which has
   no composer at all. Two readings would mean two answers to "is this an
   image", and the surface with the older answer would be the one nobody
   watches.

   Returns { file, mime } or null. A bitmap item wins over a file item in the
   same clipboard: Windows offers several representations at once, and the
   bitmap's own declared type is better evidence than a filename. */
export function pastedImageFromClipboard(clipboardData) {
  const items = clipboardData && clipboardData.items ? Array.from(clipboardData.items) : []
  const imageItem = items.find(item => typeof item.type === 'string' && item.type.startsWith('image/'))
  if (imageItem) {
    const file = typeof imageItem.getAsFile === 'function' ? imageItem.getAsFile() : null
    /* `claimed` even with no file: the person pasted a picture, so the event is
       ours whether or not we could read it. Returning null here would let the
       bytes fall through into the text box as a blob of characters. */
    return { file, mime: imageItem.type, claimed: true }
  }
  for (const item of items) {
    if (item.kind !== 'file' || typeof item.getAsFile !== 'function') continue
    const candidate = item.getAsFile()
    const mime = candidate ? pastedImageFileMime(candidate.name) : null
    if (!mime) continue
    return { file: candidate, mime, claimed: true }
  }
  return null
}

/* The kind of picture a filename claims to be, or null for "not a picture" --
   which includes a name with no extension at all. Never guesses: an unknown
   name is left for the browser's ordinary paste. */
function pastedImageFileMime(name) {
  const text = typeof name === 'string' ? name : ''
  const dot = text.lastIndexOf('.')
  if (dot < 0 || dot === text.length - 1) return null
  return PASTED_IMAGE_FILE_MIMES[text.slice(dot + 1).toLowerCase()] || null
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/* WHAT A CAUGHT THROW IS WORTH TO A LATER READER.
 *
 * Four composer doors can fail: the send catch, and the queue's Send now, its
 * Send-now hold, and enqueue. Each of them was written `catch { x = null }`,
 * which does not bind the throw at all and so destroys the one thing that tells
 * a support conversation or a probe WHICH failure happened.
 *
 * refusalCodeOf accepts a value only when it is shaped like one of this
 * product's identifiers. On this channel a rejected call's `message` IS that
 * identifier (shell/main.cjs replaces a rejected call's error with one whose
 * message is its identifier), so the message is the fallback. Anything else --
 * a thrown string, a DOMException with an English message, nothing at all --
 * answers null, and markRefusalCode then REMOVES the attribute rather than
 * writing an empty one, so "there is no code" and "the code is blank" stay
 * different answers.
 *
 * This never puts the value on the glass. That decision belongs to
 * src/refusal-copy.js and is unchanged. */
function refusalCodeFromThrown(thrown) {
  return refusalCodeOf(thrown) || (thrown && typeof thrown.message === 'string' ? thrown.message : null)
}
/* WHAT A LIVE ROW IS, WHILE IT IS STILL BECOMING IT.
 *
 * A stream opens before anything about the turn has been classified: the
 * engine names a turn on its first event, but that event can be seconds
 * away, and until it lands the row cannot honestly claim to be the agent's
 * answer. So a row starts `pending` -- visibly temporary -- and converts to
 * a real category when classified content actually arrives.
 *
 * A CATEGORY IS DECIDED ONCE AND IS NEVER REVISED. That is the rule the rest
 * of this pipeline already keeps: src/agent-session-events.js splits the
 * stream into fixed readers by event type and says so in its own words ("a
 * type belongs to exactly one reader"). This function keeps the same rule at
 * the painting end -- once a row is `agent` it stays `agent`, so a later
 * empty repaint cannot demote a message a person has already read back into
 * a "working" placeholder, and no painted row is ever re-homed.
 *
 * Only text promotes. An empty push is a repaint of a turn that has not said
 * anything yet, not evidence of what the turn will turn out to be. */
export function streamCategoryAfter(current, hasText) {
  if (current !== 'pending') return current
  return hasText ? 'agent' : 'pending'
}

// Only explicit captures can cross a mounted-composer replacement. A plain
// import is always a new intent, even when all displayed bytes happen to match.
const composerCaptures = new WeakMap()
const freezeComposerValue = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeComposerValue); Object.freeze(value) }
  return value
}

export function buildChat({ title, subtitle = '', headerMeta = null, roleKey = 'coordinator', accentId = null, seed = 3, onClose = null, onExpand = null, tall = false, context = null, onSend = null, onImageIntent = null, imageOutbox = null, history = null, onAttach = null, onPasteAttachment = null, onMention = null, status = null, queue = null, actions = null, actionsNote = null, onStop = null, onReserveHold = null, onReleaseHold = null, composerReason = null, onReady = null, sampleConversation = false, chips = null, onApprovalDecision = null, onOpenDiff = null, commonActions = null, retainOnDetach = false }) {
  /* SELF-ANSWERING IS OPT-IN NOW. Without `onSend` this composer used to push
     the turn onto replyQueue and stream a canned reply back -- right for the
     one labelled demonstration surface that exists to show what a conversation
     looks like, and a lie everywhere else: the comms watch-boards reached it on
     LIVE sources, and the agent page's box answered itself under a caption
     reading "typing in it still reaches nothing". Found independently by two
     lanes during the one-render cutover. A caller that wants the demonstration
     says `sampleConversation: true`; a caller with a real sender passes
     `onSend`; anyone with neither gets a switched-off composer that says why,
     through the same composerReason mechanism refusals already use. */
  if (typeof onSend !== 'function' && sampleConversation !== true
      && !(typeof composerReason === 'string' && composerReason.trim().length > 0)) {
    composerReason = NO_SENDER_WIRED
  }
  const composer = controlState({
    enabled: !(typeof composerReason === 'string' && composerReason.trim().length > 0),
    why: composerReason,
  })
  const cannotSend = composer.disabled
  const role = roleAppearance(roleKey || 'coordinator')
  // A tree node's chat wears the node's own accent, the same as its circle.
  const roleColor = accentId ? roleColorCss(roleKey || 'coordinator', 'accent', accentId) : role.color
  const root = el(`
    <div class="chat${cannotSend ? ' chat-cannot-send' : ''}" data-chat-panel style="${tall ? 'min-height:0;' : ''}--chat-role:${roleColor}">
      <div class="chat-head">
        <span class="role-dot" style="background:${roleColor}"></span>
        <div>
          <div class="t">${escapeMarkup(title)}</div>
          ${subtitle ? `<div class="s" data-chat-subtitle>${escapeMarkup(subtitle)}</div>` : ''}
        </div>
        <span class="spacer"></span>
        <button class="chat-search-toggle" type="button" aria-label="${SEARCH_TOGGLE_LABEL}" aria-expanded="false">${SEARCH_BUTTON_TEXT}</button>
        ${onExpand ? `<button class="chat-expand" aria-label="${EXPAND_LABEL}" aria-pressed="false">
          <svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>` : ''}
        ${onClose ? `<button class="chat-close" aria-label="${COLLAPSE_LABEL}">
          <svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>` : ''}
      </div>
      <div class="chat-search" hidden><input type="search" aria-label="${SEARCH_INPUT_LABEL}" placeholder="${SEARCH_INPUT_PLACEHOLDER}"></div>
      <div class="chat-log"></div>
      <button class="chat-new-below" type="button" hidden>${NEW_BELOW_FALLBACK}</button>
      <div class="chat-composer-dock">
      <div class="working-step" role="status" hidden>
        <span data-chat-working-step></span>
        <span class="chat-activity-orbit" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none"><circle class="chat-orbit-track" cx="20" cy="20" r="16"/><circle class="chat-orbit-outer" cx="20" cy="20" r="16"/><circle class="chat-orbit-inner" cx="20" cy="20" r="10"/><path class="chat-orbit-core" d="M20 14 22 18 26 20 22 22 20 26 18 22 14 20 18 18Z"/><path class="chat-orbit-pause" d="M16 14v12m8-12v12"/><g class="chat-orbit-writing"><path d="M14 17v6"/><path d="M20 14v12"/><path d="M26 17v6"/></g></svg>
        </span>
        ${onStop ? `<button type="button">${WORKING_CANCEL}</button>` : ''}
      </div>
      ${queue ? '<div class="chat-queue-strip" hidden></div>' : ''}
      ${imageOutbox ? '<div class="chat-image-queue-strip" hidden></div>' : ''}
      ${cannotSend ? `<div class="chat-nosend">${escapeMarkup(composerReason)}</div>` : ''}
      <div class="chat-compose-surface">
      <div class="chat-attach-strip" hidden></div>
      ${commonActions ? `<div class="chat-common-actions" role="group" aria-label="${PALETTE_PANEL.groupCommon}"></div>` : ''}
      <div class="chat-input">
        ${onAttach ? `<button class="chat-composer-control" data-chat-attach aria-label="${ATTACH_LABEL}" title="${ATTACH_TITLE}">
          <svg viewBox="0 0 24 24"><path d="M8 12.5 15.2 5.3a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a5.4 5.4 0 0 1-7.6-7.6L11 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>` : ''}
        ${onMention ? `<button class="chat-composer-control" data-chat-mention aria-label="${MENTION_LABEL}" title="${MENTION_TITLE}">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16.2 12v1.8a2.4 2.4 0 0 0 4.8 0V12a9 9 0 1 0-3.5 7.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>` : ''}
        ${actions ? `<button class="chat-composer-control" data-chat-actions aria-haspopup="true" aria-expanded="false" aria-label="${ACTIONS_LABEL}" title="${ACTIONS_TITLE}">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.2" cy="7" r="2.1" fill="var(--sheet, #fff)" stroke="currentColor" stroke-width="1.8"/><circle cx="15" cy="12" r="2.1" fill="var(--sheet, #fff)" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="17" r="2.1" fill="var(--sheet, #fff)" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>` : ''}
        <input type="text" ${cannotSend
          /* "NOT NOW" WAS NOT A LEAKED LABEL (owner: "why is it saying not
             now?"). It was typed here, and it is the whole of what a disabled
             box says for itself: two words that read like a button, sitting
             under a sentence that has already explained the situation
             properly. The identical words in src/fleet-tree-copy.js are the
             compose panel's cancel button and are a coincidence; nothing joins
             the two.
             The input carries no label of any kind, so this placeholder is
             also its entire accessible name -- which is why the switched-off
             state gets the REASON as an aria-label rather than nothing. */
          ? `placeholder="${CANNOT_SEND_PLACEHOLDER}" aria-label="${escapeMarkup(composerReason)}" disabled`
          : `placeholder="${escapeMarkup(messagePlaceholder(title))}" aria-label="${escapeMarkup(messageAriaLabel(title))}"`} />
        <button class="chat-send" aria-label="${SEND_LABEL}"${cannotSend ? ' disabled' : ''}>
          <svg class="chat-send-go" viewBox="0 0 24 24"><path d="M5 12h13M13 6.5 18.8 12 13 17.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <svg class="chat-send-halt" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor"/></svg>
        </button>
      </div>
      ${chips ? `<div class="chat-chips">
        <div class="chat-chips-left">
          <span class="chat-compose-hint">${COMPOSER_SEND_HINT}</span>
          ${typeof chips.tier === 'function'
            ? (typeof chips.onOpenTier === 'function'
              ? '<button type="button" class="chat-chip chat-chip-tier" data-chat-chip="tier" hidden></button>'
              : '<span class="chat-chip chat-chip-tier chat-chip-static" data-chat-chip="tier" hidden></span>')
            : ''}
          ${typeof chips.onOpenMode === 'function' ? '<button type="button" class="chat-chip chat-chip-mode" data-chat-chip="mode">Provider mode</button>' : ''}
          ${typeof chips.onOpenEffort === 'function'
            ? `<button type="button" class="chat-chip chat-chip-effort" data-chat-chip="effort">${CHIP_EFFORT_LABEL}</button>`
            : ''}
          ${typeof chips.model === 'function'
            ? (typeof chips.onOpenModel === 'function'
              ? '<button type="button" class="chat-chip chat-chip-model" data-chat-chip="model" hidden></button>'
              : '<span class="chat-chip chat-chip-model chat-chip-static" data-chat-chip="model" hidden></span>')
            : ''}
          ${typeof chips.accountRetry === 'function'
            ? `<select class="chat-chip chat-chip-account-retry" data-chat-chip="account-retry" aria-label="Account retry policy">
              <option value="off">Retries off</option>
              <option value="keep">Retry accounts</option>
              <option value="wait">Wait for resets</option>
            </select>
            <button type="button" class="chat-chip chat-chip-account-retry-now" data-chat-chip="account-retry-now" hidden>Try accounts now</button>`
            : ''}
        </div>
        <div class="chat-chips-right">
          ${onStop ? `<button type="button" class="chat-chip chat-chip-halt" data-chat-chip="halt" hidden>${CHIP_HALT_LABEL}</button>` : ''}
          <!-- ONE DOOR UNDER THE ARROW, AND IT IS THE ONE THE ARROW CANNOT BE.
               The owner, W18c: "under the arrow is a send and a que button. The
               arrow should send, the button below should be for send now."
               They are right that the old pair was redundant: the SEND chip
               called the same send() the arrow calls, and the QUEUE chip called
               send() too, because send()'s busy branch IS the queue. Three
               controls, two verbs, one of them already spoken by the arrow.
               What no control under the arrow could do was interrupt, which is
               the act R17 asked for. So the pair becomes one Send now. -->
          <button type="button" class="chat-chip chat-chip-sendnow" data-chat-chip="sendnow" aria-label="${QUEUE_SEND_NOW_LABEL}"${cannotSend ? ' disabled' : ''}>${QUEUE_SEND_NOW}</button>
        </div>
        ${typeof chips.accountRetry === 'function'
          ? '<output class="chat-chip-account-retry-status" data-chat-chip="account-retry-status" role="status" aria-live="polite"></output>'
          : ''}
      </div>` : ''}
      </div>
      </div>
    </div>
  `)

  const log = root.querySelector('.chat-log')
  /* The fallback keeps the deliberately tiny DOM stand-ins used by the
     component contract tests useful; browsers take the scoped selector. */
  const input = root.querySelector(CHAT_COMPOSER_INPUT_SELECTOR) || root.querySelector('input')
  const sendButton = root.querySelector('.chat-send')
  let disposed = false
  const liveStreams = new Set()
  const actionRows = new Map()
  const approvalRows = new Map()
  let sampleActivity = ''
  let statusMetricsActive = false
  let headerMetaWrapper = null
  let headerMetaDisposer = null
  let headerMetaProviderActive = false
  const headerIdentity = root.querySelector('.chat-head')?.querySelector('.t')?.parentNode || null
  const removeHeaderMeta = () => {
    headerMetaWrapper?.remove()
    headerMetaWrapper = null
  }
  const paintHeaderMeta = snapshot => {
    if (disposed) return
    const workspaceOpen = headerMetaWrapper?.querySelector('.chat-workspace')?.open === true
    removeHeaderMeta()
    if (!headerIdentity || !synchronousHeaderMetaRecord(snapshot)) return
    let facts = null
    try {
      facts = [
        ['data-chat-header-path', chatHeaderPathCopy(snapshot.path)],
        ['data-chat-header-status', chatHeaderStatusCopy(snapshot.status)],
        ['data-chat-header-branch', chatHeaderBranchCopy(snapshot.branch)],
        ['data-chat-header-context', chatHeaderContextCopy(snapshot.context)],
      ].filter(([, copy]) => copy !== null)
    } catch {
      return
    }
    if (facts.length === 0) return
    const wrapper = document.createElement('div')
    wrapper.className = 'chat-header-meta'
    for (const [hook, copy] of facts) {
      const fact = document.createElement('span')
      fact.setAttribute(hook, '')
      fact.textContent = copy.text
      fact.setAttribute('aria-label', copy.ariaLabel)
      if (hook === 'data-chat-header-path') {
        const details = document.createElement('details')
        details.className = 'chat-workspace'
        details.open = workspaceOpen
        const summary = document.createElement('summary')
        summary.textContent = chatWorkspaceLabel(copy.text)
        summary.title = copy.text
        details.append(summary, fact)
        wrapper.appendChild(details)
      } else wrapper.appendChild(fact)
    }
    if (disposed) return
    headerIdentity.appendChild(wrapper)
    headerMetaWrapper = wrapper
  }
  const readHeaderMeta = (provider, read) => {
    if (disposed || !headerMetaProviderActive) return
    let snapshot = null
    try { snapshot = read.call(provider) } catch { snapshot = null }
    if (!disposed && headerMetaProviderActive) paintHeaderMeta(snapshot)
  }
  const mountHeaderMeta = () => {
    if (!synchronousHeaderMetaRecord(headerMeta)) return
    let providerShape = false
    let read = null
    let subscribe = null
    try {
      providerShape = 'read' in headerMeta || 'subscribe' in headerMeta
      read = headerMeta.read
      subscribe = headerMeta.subscribe
    } catch {
      paintHeaderMeta(null)
      return
    }
    if (!providerShape) {
      paintHeaderMeta(headerMeta)
      return
    }
    if (typeof read !== 'function' || typeof subscribe !== 'function') {
      paintHeaderMeta(null)
      return
    }
    headerMetaProviderActive = true
    readHeaderMeta(headerMeta, read)
    let disposer = null
    try {
      disposer = subscribe.call(headerMeta, () => readHeaderMeta(headerMeta, read))
    } catch {
      headerMetaProviderActive = false
      paintHeaderMeta(null)
      return
    }
    if (typeof disposer !== 'function') {
      headerMetaProviderActive = false
      paintHeaderMeta(null)
      return
    }
    headerMetaDisposer = disposer
  }
  mountHeaderMeta()
  let lastTurnAt = null
  let lastSemanticTurnAt = null
  let pinned = true
  let newBelowCount = 0
  const newBelow = root.querySelector('.chat-new-below')
  // Incoming content follows only while the reader stays at the bottom.
  // Define this before history is painted so restored and live rows use the
  // same rule. Explicit sends and the jump button re-pin deliberately.
  const pinToBottom = () => {
    if (!disposed && pinned && log.scrollHeight) log.scrollTop = log.scrollHeight
  }

  /* THE COMPOSER CHIPS (design/chat/picked-card.png). Element refs only,
     here beside the other query-and-hold constants -- the paint function and
     its wiring sit further down, alongside status/queue's own subscriptions,
     because both reach into isBusy/runStop/send and must not run before
     those exist (see the note at that wiring). */
  const chipTier = root.querySelector('[data-chat-chip="tier"]')
  const chipEffort = root.querySelector('[data-chat-chip="effort"]')
  const chipModel = root.querySelector('[data-chat-chip="model"]')
  const chipMode = root.querySelector('[data-chat-chip="mode"]')
  const chipAccountRetry = root.querySelector('[data-chat-chip="account-retry"]')
  const chipAccountRetryNow = root.querySelector('[data-chat-chip="account-retry-now"]')
  const chipAccountRetryStatus = root.querySelector('[data-chat-chip="account-retry-status"]')
  const chipHalt = root.querySelector('[data-chat-chip="halt"]')
  const chipSendNow = root.querySelector('[data-chat-chip="sendnow"]')
  /* Reassigned once isBusy/runStop/send exist, below -- the forward-reference
     shape src/components.js already uses for pumpReplies. syncComposer calls
     this on every one of its own triggers, so a caller never has to remember
     a fourth repaint hook beside status/queue/typing. */
  let paintChips = () => {}

  /* Search is a lens over the nodes already in the transcript. It never
     copies a message into a results list (and non-element stand-ins are
     deliberately tolerated). Closing the lens restores every row. */
  const searchToggle = root.querySelector('.chat-search-toggle')
  const searchPanel = root.querySelector('.chat-search')
  const searchInput = searchPanel?.querySelector('input')
  const paintSearch = () => {
    const wanted = String(searchInput?.value || '').trim().toLowerCase()
    for (const row of Array.from(log.children || [])) {
      if (!row || typeof row !== 'object' || !('hidden' in row)) continue
      if (row.dataset?.chatKeepInSearch !== undefined) { row.hidden = false; continue }
      row.hidden = Boolean(wanted) && !String(row.textContent || '').toLowerCase().includes(wanted)
    }
  }
  const closeSearch = () => {
    if (!searchPanel) return
    searchPanel.hidden = true
    searchToggle?.setAttribute('aria-expanded', 'false')
    if (searchInput) searchInput.value = ''
    paintSearch()
  }
  searchToggle?.addEventListener('click', () => {
    searchPanel.hidden = !searchPanel.hidden
    searchToggle.setAttribute('aria-expanded', searchPanel.hidden ? 'false' : 'true')
    if (searchPanel.hidden) closeSearch()
    else searchInput?.focus()
  })
  searchInput?.addEventListener('input', paintSearch)
  searchInput?.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Escape') return
    // This press closes only search. The tree's outer Escape handler closes
    // the conversation, so it must wait for a separate press from the visible
    // control rather than also consuming this one from the hidden input.
    event.preventDefault()
    event.stopPropagation()
    closeSearch()
    searchToggle?.focus()
  })

  const revealNewBelow = () => {
    if (pinned || !newBelow) return
    newBelowCount += 1
    newBelow.textContent = newBelowCountLabel(newBelowCount)
    newBelow.hidden = false
  }
  const clearNewBelow = () => {
    newBelowCount = 0
    if (newBelow) newBelow.hidden = true
  }
  /* A turn that GROWS is not a new message, so it must not inflate the count --
     a streaming reply would have counted every word. But a reader parked above
     it still needs the way down, which is why this offers the pill under its
     countless label instead of staying silent. Until this existed, live
     thinking arriving while the reader was scrolled up produced no follow AND
     no pill: the owner's "why cant i ever see the thinking". */
  const offerNewBelow = () => {
    if (pinned || !newBelow) return
    if (!newBelowCount) newBelow.textContent = NEW_BELOW_FALLBACK
    newBelow.hidden = false
  }
  /* The one rule for incoming content, in one place: at the bottom, follow it;
     scrolled away on purpose, stay put and offer the way down. */
  const followOrOffer = () => {
    if (pinned) pinToBottom()
    else offerNewBelow()
  }
  newBelow?.addEventListener('click', () => {
    pinned = true
    log.scrollTop = log.scrollHeight
    clearNewBelow()
  })

  /* The picker buttons: the handlers own the mechanism (and any state); this
     component only shows what they answered. An attach names its file in the
     strip above the input; a mention writes the path INTO the input, which is
     the whole point of a mention. */
  const attachStrip = root.querySelector('.chat-attach-strip')
  let pendingAttachments = []
  // Content equality does not identify a draft: an edit-away-and-back is a
  // new intent even when its bytes equal a pending admission's original input.
  let composerRevision = 0
  let draftId = crypto.randomUUID(), draftRevision = 0
  let retainedDraft = null, draftAuthorityRefusal = null
  const draftMutated = () => { composerRevision += 1; draftRevision += 1 }
  let observedComposerText = input.value
  const observeComposerText = () => {
    if (observedComposerText === input.value) return
    observedComposerText = input.value
    draftMutated()
  }
  const setComposerText = text => {
    input.value = text
    observeComposerText()
  }
  const setComposerAttachments = attachments => {
    if (JSON.stringify(pendingAttachments) !== JSON.stringify(attachments)) draftMutated()
    pendingAttachments = attachments
  }
  const paintAttachments = () => {
    if (!attachStrip) return
    attachStrip.replaceChildren()
    const labels = composerAttachmentLabels(pendingAttachments)
    for (const [index, attachment] of pendingAttachments.entries()) {
      const filename = labels[index]
      const chip = document.createElement('div')
      chip.className = 'chat-attachment-chip'
      const name = document.createElement('span')
      name.className = 'chat-attachment-name'
      name.textContent = filename
      chip.appendChild(name)
      const sizeText = attachmentSizeText(attachment.size)
      if (sizeText) {
        const size = document.createElement('span')
        size.className = 'chat-attachment-size'
        size.textContent = sizeText
        chip.appendChild(size)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'chat-attachment-remove'
      remove.textContent = ATTACHMENT_REMOVE_TEXT
      remove.setAttribute('aria-label', attachmentRemoveLabel(filename))
      remove.addEventListener('click', () => {
        setComposerAttachments(pendingAttachments.filter(item => composerAttachmentKey(item) !== composerAttachmentKey(attachment)))
        /* Taking the file off the message takes its picture with it. A send is
           NOT a removal: a refused send puts the attachment back, so its
           preview has to still be there when the person tries again. */
        pastedPictures.delete(composerAttachmentKey(attachment))
        paintAttachments()
      })
      chip.appendChild(remove)
      attachStrip.appendChild(chip)
    }
    attachStrip.hidden = pendingAttachments.length === 0
    syncComposer()
  }
  const chooseAttachment = async () => {
    if (disposed || typeof onAttach !== 'function') return false
    const picked = await Promise.resolve(onAttach()).catch(() => null)
    if (disposed) return false
    /* A REFUSED PICK SAYS WHY. This returned false and painted nothing, so a
       picture the boundary refused -- today, one too large for the delivery
       path to carry -- looked exactly like pressing Cancel: the dialog closed
       and the composer was empty. Cancel still says nothing, because nothing
       happened; a refusal with a sentence says the sentence. */
    if (picked && picked.ok === false && typeof picked.sentence === 'string' && picked.sentence) {
      addMsg('note', picked.sentence)
      return false
    }
    if (!picked || picked.ok !== true || typeof picked.path !== 'string' || !picked.path) return false
    const identity = attachmentIdentity(picked.path)
    setComposerAttachments(pendingAttachments.filter(item => attachmentIdentity(item.path) !== identity))
    setComposerAttachments([...pendingAttachments, picked])
    paintAttachments()
    return true
  }
  root.querySelector('[data-chat-attach]')?.addEventListener('click', chooseAttachment)
  /* CTRL+V, IMAGE TO THE AGENT (owner R10, verbatim: "I still cant control V
     and image to you please get that fixed"). Bound to the composer's own
     input -- the attachment area -- and NOT to `document`: a person pastes
     an image while their cursor is where they are writing the message it
     rides with, and binding wider would catch a paste meant for some other
     part of the page (the search box, a filter field) that has nothing to do
     with attachments. An ordinary text paste (no image item present) is left
     alone entirely -- this listener never calls preventDefault() for one, so
     the browser's own paste into the box is untouched. */
  if (typeof onPasteAttachment === 'function') {
    /* Everything after "we have a picture and its kind", shared by the two ways
       a picture arrives on the clipboard. */
    const attachPastedImage = async (file, mime) => {
      observeComposerText()
      const capturedId = draftId, capturedRevision = composerRevision
      const pasteCurrent = () => {
        observeComposerText()
        return !disposed && !draftAuthorityRefusal && draftId === capturedId && composerRevision === capturedRevision
      }
      const pasteContext = Object.freeze({ draftId, revision: draftRevision, isCurrent: pasteCurrent })
      let base64
      try { base64 = arrayBufferToBase64(await file.arrayBuffer()) } catch { base64 = null }
      if (!pasteCurrent()) return
      if (!base64) { addMsg('note', PALETTE_PANEL.pasteFailed); return }
      let result = null
      try { result = await onPasteAttachment(base64, mime, pasteContext) } catch { result = null }
      if (!pasteCurrent()) return
      const opaque = result?.attachment
      if (hostDraftAttachment(opaque)) {
        if (result.ok !== true || typeof result.isCurrent !== 'function' || result.isCurrent() !== true) {
          markRefusalCode(addMsg('note', 'The draft changed. Paste the image again into the current draft.'), { code: 'IMAGE_OWNER_CHANGED' }); return
        }
        const attachment = freezeComposerValue(structuredClone(opaque))
        const identity = composerAttachmentKey(attachment)
        setComposerAttachments([...pendingAttachments.filter(item => composerAttachmentKey(item) !== identity), attachment])
        pastedPictures.set(identity, { mime, base64, name: composerAttachmentName(attachment) })
        while (pastedPictures.size > PASTED_PICTURE_MEMORY) pastedPictures.delete(pastedPictures.keys().next().value)
        paintAttachments()
        return
      }
      if (!result || result.ok !== true || typeof result.path !== 'string' || !result.path) {
        addMsg('note', (result && typeof result.sentence === 'string' && result.sentence) || PALETTE_PANEL.pasteFailed)
        return
      }
      const identity = attachmentIdentity(result.path)
      setComposerAttachments(pendingAttachments.filter(item => composerAttachmentKey(item) !== identity))
      setComposerAttachments([...pendingAttachments, result])
      rememberPastedPicture(result.path, base64, mime)
      paintAttachments()
    }
    input.addEventListener('paste', async (event) => {
      if (disposed) return
      /* One reading of the clipboard, shared with the session surface: a
         bitmap (a screenshot) or an image FILE copied in Explorer, whose
         clipboard item is kind 'file' with a type that is not image/... and
         whose kind comes from its own name. A name that maps to none of the
         four allowed kinds is not a picture at all, and the event is left
         unclaimed so ordinary pasting into the message box still works, which
         is what this box is mostly for. */
      const pasted = pastedImageFromClipboard(event.clipboardData)
      if (!pasted) return
      /* An image clipboard item has no useful text form for this box, so
         claiming the event here loses nothing a plain paste would have kept. */
      event.preventDefault()
      if (!pasted.file) return
      await attachPastedImage(pasted.file, pasted.mime)
    })
  }
  const chooseMention = async () => {
    if (disposed || typeof onMention !== 'function') return false
    let picked = null
    try { picked = await onMention() } catch { /* shown as a refusal below */ }
    if (disposed) return false
    if (!picked || picked.ok === false) {
      addMsg('note', (picked && typeof picked.sentence === 'string' && picked.sentence) || PALETTE_PANEL.mentionFailed)
      return false
    }
    const path = typeof picked === 'string' ? picked : picked.path
    if (!path) return false
    setComposerText(input.value ? `${input.value} ${path}` : mentionInsertText(path))
    input.focus()
    syncComposer()
    return true
  }
  root.querySelector('[data-chat-mention]')?.addEventListener('click', chooseMention)

  /* ---- the live composer state machine (status/queue/onStop callers) ----
     One repaint function decides the trailing button's face and the queue
     strip's contents. The rules, exactly as the owner spoke them: stop
     replaces send while the agent is replying; the moment the person types,
     it turns back into send; a send while busy queues, and the waiting words
     are PREVIEWED in the strip rather than claimed as sent. */
  const queueStrip = root.querySelector('.chat-queue-strip')
  const actionsButton = root.querySelector('[data-chat-actions]')
  let paintCommonActions = () => {}
  let paintOpenActions = () => {}
  const isBusy = () => {
    try { return Boolean(status && typeof status.busy === 'function' && status.busy() === true) }
    catch { return false }
  }
  const queueRequired = () => {
    try { return typeof status?.queueRequired === 'function' && status.queueRequired() === true }
    catch { return true }
  }
  // The up-arrow walk (created below); the strip reads it on every repaint.
  let recallWalk = null
  const paintQueueStrip = () => {
    if (!queueStrip || !queue) return
    let entries = []
    try { entries = queue.list() || [] } catch { entries = [] }
    // The message being edited from the box went out unchanged: say so once.
    if (recallWalk?.anchorGone()) addMsg('note', RECALL_EDIT_ALREADY_SENT)
    queueStrip.hidden = entries.length === 0
    queueStrip.textContent = ''
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'chat-queue-row'
      const text = document.createElement('span')
      text.className = 'chat-queue-text'
      /* The person's own words: textContent, never markup. */
      text.textContent = entry.text
      /* A ROW IN A NAMED HOLD SAYS SO ON THE ROW. Two shapes: a delivery the
         transport never acknowledged (deliveryUnconfirmed, pauses the drain),
         and a Send now whose stop never reported idle inside the release
         budget (heldReason, still drains on its own). Only a reason the copy
         table knows is painted; an unknown code paints nothing rather than
         a bare identifier, the same rule refusal-copy.js keeps. */
      const heldSentence = !entry.deliveryUnconfirmed && typeof entry.heldReason === 'string'
        ? QUEUE_PANEL.heldReasons?.[entry.heldReason] || '' : ''
      if (entry.deliveryUnconfirmed || heldSentence) {
        const state = document.createElement('span')
        state.className = 'chat-queue-state'
        state.textContent = ` — ${entry.deliveryUnconfirmed ? QUEUE_PANEL.unconfirmed : heldSentence}`
        if (!entry.deliveryUnconfirmed) state.dataset.heldReason = entry.heldReason
        text.appendChild(state)
      }
      /* Both held shapes read "Retry send" on the door that re-asks for the
         send, because in both the person already pressed it once. */
      const retryLabelled = entry.deliveryUnconfirmed === true || Boolean(heldSentence)
      text.title = entry.text
      /* TWO DOORS AND AN UNQUEUE, EACH ITS OWN ACT.

         THE SEND DOOR IS GONE, and it is the owner who removed it, W18c: "in
         the qued items, no need for an additional send button it is already
         sent at that point." They are describing what the row IS: a message
         the person has already committed to send, waiting only for a turn
         boundary that the ordinary drain (views/computers.js outboxTakeNext
         plus drainOutboxMessage, three call sites on turn completion) reaches
         on its own. The old door only ever did early what the drain was going
         to do anyway, and it was disabled while busy, which is exactly when a
         row exists to look at -- so its whole visible life was as a greyed
         button next to two live ones. What a person actually wants from a
         waiting row is to move it (Send next), to jump the running turn with
         it (Send now), or to take it back (Unqueue). Those stay.

         SEND NEXT moves the row to the head of the queue -- unchanged from
         the old busy face. The engine refuses an overlapping send by design
         (AGENT_TURN_ACTIVE, shell/agent-host.cjs sendTurn), so the only
         honest "first" while something runs is the head of the queue; the
         caller's queue.sendNow does the move and answers with the sentence
         that says what happened. A caller with no sendNow gets no door here
         rather than one that silently does nothing. */
      const next = document.createElement('button')
      next.type = 'button'
      next.className = 'chat-queue-next'
      next.textContent = QUEUE_SEND_NEXT
      /* The label says the real state: "the moment this turn finishes" only
         while a turn is running; at an idle agent (a refused resume, an ended
         session) the row goes when the agent is back. */
      next.setAttribute('aria-label', sendNextLabel({ turnRunning: isBusy() }))
      next.disabled = stopping || cannotSend || entry.deliveryUnconfirmed === true || typeof queue.sendNow !== 'function'
      next.addEventListener('click', () => {
        if (stopping || cannotSend || typeof queue.sendNow !== 'function') return
        let outcome = null
        let thrown = null
        try { outcome = queue.sendNow(entry.id) } catch (error) { outcome = null; thrown = error }
        syncComposer()
        const said = outcome && typeof outcome.sentence === 'string' ? outcome.sentence : ''
        markRefusalCode(addMsg('note', said || QUEUE_PROMOTE_FAILED), { code: refusalCodeFromThrown(thrown) })
      })
      /* SEND NOW (owner R17, verbatim: "the user needs to be able to send a
         send now that actually interrrupts the agent") is the one door that
         may stop a running turn to deliver its own row. Never disabled by
         isBusy() -- that is the entire point of the button -- only by
         `stopping` (a halt already in flight, the same guard every other
         door here already holds) and `cannotSend`.

         Page 2 holds the row in its durable queue while the halt is pending.
         The hold excludes it from automatic delivery, and closing this chat
         releases the hold without deleting the words. Callers without holds
         retain the cancel-before-send contract. */
      const now = document.createElement('button')
      now.type = 'button'
      now.className = 'chat-queue-now'
      now.textContent = retryLabelled ? QUEUE_PANEL.retryUnconfirmed : QUEUE_SEND_NOW
      now.setAttribute('aria-label', retryLabelled ? QUEUE_PANEL.retryUnconfirmed : QUEUE_SEND_NOW_LABEL)
      now.disabled = stopping || cannotSend
      now.addEventListener('click', async () => {
        if (disposed || stopping || cannotSend) return
        if (queueRequired() && !isBusy()) {
          // Promotion keeps this exact row in the caller's readiness-gated queue.
          // No cancellation, transport hold, direct onSend, or Stop is authorized.
          let outcome = null, thrown = null
          try { outcome = queue.sendNow?.(entry.id) } catch (error) { thrown = error }
          syncComposer()
          markRefusalCode(addMsg('note', outcome?.sentence || QUEUE_PROMOTE_FAILED), { code: refusalCodeFromThrown(thrown) })
          return
        }
        const stopFirst = isBusy() && typeof onStop === 'function'
        let held = null
        if (typeof queue.hold === 'function') {
          /* A picture in the message box belongs to that draft, not to this
             row, so it no longer blocks the row: the row goes by itself and the
             draft stays as it is (T1426). */
          held = holdSendNow({ entryId: entry.id })
          if (!held) return
        } else {
          let cancelled = false
          try { cancelled = queue.cancel(entry.id) === true } catch { cancelled = false }
          paintQueueStrip()
          if (!cancelled) {
            addMsg('note', QUEUE_PANEL.moveGone)
            syncComposer()
            return
          }
        }
        /* Asked live, not from a closed-over snapshot: isBusy() can flip in
           the span between paint and press the ordinary way a queue does.
           runStop() is the SAME function the HALT chip and the morphing
           send/stop face already call -- never a second stop implementation
           -- and it already refuses to run twice (`if (stopping ...) return`
           at its own first line), so it, not a flag of this door's own, is
           what a second press during the halt is refused by. */
        /* SEND NOW RESERVES THE PERSON-WAITING BOUNDARY BEFORE THE INTERRUPT
           (T785). Only when a real interrupt will follow (stopFirst) and this
           is a held Send now -- a generic Halt has no `held` and reserves
           nothing. The host reservation is released on every path where the
           words do NOT go out (a refused/failed stop, a parked hold, disposal,
           a vanished row); on the delivery path it is left in place, because
           the host clears personWaitingSince when the person's words land, and
           releasing merely because held.take() returned words would re-open
           the race the reservation exists to close. Reserving is best effort:
           a failure returns null and the interrupt still proceeds, with the
           courier's own per-boundary window as the backstop. */
        /* SEND NOW RESERVES THE PERSON-WAITING BOUNDARY BEFORE THE INTERRUPT
           and releases it TIED TO THE ACTUAL DELIVERY OUTCOME (T785). The
           reservation is released in the finally on every outcome where the
           words did NOT reach the host -- a refused/failed stop, a parked hold,
           disposal, a vanished row -- and NOT once they were handed to delivery,
           because the host clears personWaitingSince when they land and
           restamps its identity when it refuses them; releasing on the delivery
           path would race that send or no-op. `delivered` is set only when the
           words are handed to deliverTurn, never merely because held.take()
           returned them. Reserving is best effort: a failure returns null and
           the interrupt still proceeds, the boundary window as backstop. */
        const reservationToken = (stopFirst && held && typeof onReserveHold === 'function')
          ? await onReserveHold() : null
        let reservationReleased = false
        const releaseReservation = () => {
          if (reservationToken != null && !reservationReleased) { reservationReleased = true; onReleaseHold?.(reservationToken) }
        }
        let handedToDelivery = false
        try {
          if (disposed) return
          const stopped = stopFirst ? await runStop({ waitForIdle: Boolean(held) }) : true
          if (stopped === false) return
          /* Idle never came inside the release budget. The row is parked under
             its named hold -- still queued, still going at the next boundary,
             Retry send and Unqueue still on it -- and nothing is sent into a
             turn this window cannot see the end of. */
          if (stopped?.held === true) { parkSendNow(held, stopped); syncComposer(); return }
          if (disposed) return
          const ready = held ? held.take() : entry
          if (!ready) { addMsg('note', QUEUE_PANEL.moveGone); return }
          /* Release only when the words do NOT reach the host: deliverTurn
             reports the real send outcome -- accepted/queued keep the
             reservation for the host to clear on land, a fail or a throw
             releases it -- and it is preserved while delivery is pending, never
             released merely because held.take() returned words. */
          deliverTurn(ready.text, { promoteIfQueued: true, delivery: held, withComposerAttachments: false, onSendOutcome: reachedHost => { if (!reachedHost) releaseReservation() } })
          handedToDelivery = true
        } finally {
          if (!handedToDelivery) releaseReservation()
          releaseSendNow(held)
          syncComposer()
        }
      })
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'chat-queue-cancel'
      cancel.textContent = QUEUE_UNQUEUE
      cancel.setAttribute('aria-label', QUEUE_UNQUEUE_LABEL)
      cancel.disabled = stopping
      /* UNQUEUE PUTS THE WORDS BACK. It used to only remove the row, and the
         person's typed message was gone: the box was not refilled and the
         up-arrow recall walk only reaches entries still IN the queue, so there
         was no way back to it at all. Measured on both surfaces. Someone who
         wrote a long message while the agent was busy and changed their mind
         lost it for pressing the door that offers to take it back.

         The box is filled ONLY when it is empty. A draft already in the box is
         the person's too, and this file's own recall walk stashes a draft byte
         for byte rather than overwrite it -- so trading one lost text for
         another would be the same defect wearing the other hat. In that case
         the row still goes and the words are said in the transcript instead,
         which loses neither. */
      cancel.addEventListener('click', () => {
        if (stopping) return
        if (recallWalk?.anchorId === entry.id) recallWalk.leave()
        const words = typeof entry.text === 'string' ? entry.text : ''
        const boxHasDraft = Boolean(input && String(input.value || '').trim())
        let cancelled = false
        try { cancelled = queue.cancel(entry.id) !== false } catch { /* an already-sent entry is the goal state */ }
        if (cancelled && words) {
          if (!boxHasDraft) {
            if (input) {
              setComposerText(words)
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.focus()
            }
          } else {
            addMsg('note', `${QUEUE_PANEL.unqueuedIntoNote} ${words}`)
          }
        }
        paintQueueStrip()
        syncComposer()
      })
      row.append(text, next, now, cancel)
      queueStrip.appendChild(row)
    }
  }
  /* THE UP-ARROW WALK, wired to this composer's own queue and to nothing else.
     A caller with no queue (the sample surfaces, the agent page) gets a walk
     with nothing to list, and every key it is offered comes back unhandled --
     so those composers keep the browser's own arrow behaviour exactly as they
     have it today, with no branch of their own to maintain. */
  const recall = createQueueRecall({
    list: () => (queue && typeof queue.list === 'function' ? queue.list() : []),
    replace: queue && typeof queue.replace === 'function'
      ? (id, next) => queue.replace(id, next)
      : null,
  })
  recallWalk = recall
  /* The one place a walk's answer reaches the box. Both key doors and the send
     button go through here, so "the box holds what the walk landed on" cannot
     be true on one path and false on another. */
  const applyRecall = (answer) => {
    if (!answer || answer.handled !== true) return false
    if (typeof answer.text === 'string') setComposerText(answer.text)
    if (answer.note) addMsg('note', answer.note)
    syncComposer()
    return true
  }
  const removeWorkingCounters = (working) => {
    working?.querySelector('[data-chat-working-counters]')?.remove()
  }
  const paintWorkingCounters = (working, rowPresent) => {
    if (!working || !rowPresent || !statusMetricsActive) {
      removeWorkingCounters(working)
      return
    }
    let snapshot = null
    try {
      if (!status || typeof status.metrics !== 'function') {
        removeWorkingCounters(working)
        return
      }
      snapshot = status.metrics()
    } catch {
      removeWorkingCounters(working)
      return
    }
    let numeric = null
    let positive = false
    try {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        removeWorkingCounters(working)
        return
      }
      numeric = {}
      for (const key of ['tools', 'files', 'added', 'removed']) {
        if (!Object.hasOwn(snapshot, key)) continue
        const value = snapshot[key]
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) continue
        numeric[key] = value
        if (value > 0) positive = true
      }
    } catch {
      removeWorkingCounters(working)
      return
    }
    if (!positive) {
      removeWorkingCounters(working)
      return
    }
    const text = chatWorkingCountersText(numeric)
    const label = chatWorkingCountersLabel(numeric)
    if (!text || !label) {
      removeWorkingCounters(working)
      return
    }
    let counters = working.querySelector('[data-chat-working-counters]')
    if (!counters) {
      counters = document.createElement('span')
      counters.setAttribute('data-chat-working-counters', '')
      working.insertBefore(counters, working.querySelector('button'))
    }
    counters.textContent = text
    counters.setAttribute('aria-label', label)
  }
  let stopping = false
  let pendingSendNow = null
  // Only known not-dispatched deliveries may be cancelled on teardown.
  const pendingSendCancellations = new Set()
  const pendingRides = new Set()
  let cancelStopWait = null
  const holdSendNow = request => {
    let held = null
    let thrown = null
    try { held = queue.hold(request) } catch (error) { held = null; thrown = error }
    if (!held?.ok) {
      markRefusalCode(addMsg('note', held?.sentence || QUEUE_HOLD_FAILED), { code: refusalCodeFromThrown(thrown) })
      syncComposer()
      return null
    }
    if (!held.direct) pendingSendNow = held
    return held
  }
  const releaseSendNow = held => {
    held?.release?.()
    if (pendingSendNow === held) pendingSendNow = null
  }
  /* THE STOP DID NOT RELEASE IN TIME, AND THIS IS WHAT THE PERSON SEES INSTEAD
     OF NOTHING. The hold is given back to the store under a NAMED reason: the
     row stays in the strip, says it is held and why, and keeps Retry send and
     Unqueue. No note is painted -- a refusal on the glass is the thing the
     whole Send now design exists to keep off it -- and nothing is stalled: the
     hold and the stop doors are released, so the next Send now is not refused
     with "already waiting" by a reservation whose wait already ended. The
     words themselves still go on their own at the next turn boundary. */
  const parkSendNow = (held, outcome) => {
    if (held && typeof held.restore === 'function') {
      try { held.restore({ unconfirmed: false, heldReason: outcome?.reason || SEND_NOW_RELEASE_HOLD.reason }) } catch { /* the row keeps whatever state the store could give it */ }
    }
    if (pendingSendNow === held) pendingSendNow = null
  }
  /* The stop-send button is the only thing that changes as the person types,
     so it is split out and run alone on the typing path. Everything below it
     (queue strip, working step, chips, action palettes) does not change per
     character, and onInputTyped coalesces it to one animation frame -- so
     typing no longer runs the whole repaint batch on every keystroke (T382). */
  const syncSendButton = () => {
    if (disposed) return
    const stopMode = isBusy() && !input.value.trim() && pendingAttachments.length === 0 && typeof onStop === 'function'
    sendButton.classList.toggle('is-stop', stopMode)
    sendButton.setAttribute('aria-label', stopMode ? STOP_LABEL : SEND_LABEL)
    sendButton.title = stopMode ? STOP_TITLE : ''
    /* All three stop doors share runStop's one in-flight request. Keep their
       glass in the same state as that request so a press never appears to do
       nothing merely because another door got there first. */
    sendButton.disabled = cannotSend || stopping
  }
  const syncComposer = () => {
    if (disposed) return
    syncSendButton()
    paintQueueStrip()
    const working = root.querySelector('.working-step')
    if (working) {
      let step = ''
      const busy = isBusy()
      const responding = sampleActivity === 'responding' || [...liveStreams].some(stream => stream.hasText)
      try { step = busy && typeof status?.step === 'function' ? String(status.step() || '').trim() : '' } catch { step = '' }
      const active = busy || liveStreams.size > 0 || Boolean(sampleActivity)
      const waiting = approvalRows.size > 0 || (active && [...actionRows.values()].some(row => row.wrap.dataset.actionState === 'waiting'))
      const usingTool = active && [...actionRows.values()].find(row => row.wrap.dataset.actionState === 'working')
      const phase = waiting ? 'waiting' : usingTool ? 'working' : responding ? 'responding' : step ? 'working' : 'thinking'
      if (waiting) step = CHAT_WAITING
      if (!step && active) step = usingTool ? chatUsingToolText(usingTool.tool.textContent) : responding ? CHAT_RESPONDING : CHAT_THINKING
      working.hidden = !step
      working.setAttribute('data-activity-phase', phase)
      root.setAttribute('data-chat-activity', step ? phase : 'idle')
      const words = working.querySelector('[data-chat-working-step]')
      if (words) words.textContent = step
      paintWorkingCounters(working, Boolean(step))
      const cancel = working.querySelector('button')
      if (cancel) cancel.disabled = stopping || (queueRequired() && !isBusy())
    }
    paintChips()
    paintCommonActions()
    paintOpenActions()
    // A read-only chat may be waiting for a real session. Refresh its reason
    // without remounting the transcript or actions palette; this feed can never
    // enable sending or fabricate a sender when the session does not exist.
    if (cannotSend && typeof status?.composerReason === 'function') {
      let reason = composerReason
      try {
        const current = status.composerReason()
        if (typeof current === 'string' && current.trim()) reason = current
      } catch { /* retain the static refusal if the source cannot answer */ }
      const notice = root.querySelector('.chat-nosend')
      if (notice) notice.textContent = reason
      input.setAttribute('aria-label', reason)
    }
  }
  /* THE RELEASE BUDGET. HANDOFF-M13-BEFORE-INSTALL-20260918.md, the ratified
   * A/B split: "150-250ms release budget on the user path". This is the wait
   * between the host answering the interrupt and this window's own status
   * reading idle -- a wait that had no bound at all. Unbounded, a completion
   * that never arrives (the host's own release wait timed out, a provider that
   * emits nothing for an abandoned turn) left `stopping` true, every stop door
   * locked, the durable hold in place and the next Send now refused with "A
   * Send now is already waiting for this agent to stop" until someone unqueued
   * the row by hand. That refusal was the residue this bound exists to end.
   *
   * 250 is the top of the ratified range, chosen not the bottom, because the
   * ordinary path here is ~0 ms -- the host resolves the interrupt only after
   * the turn's completion has already crossed to this window -- so the budget
   * only ever runs on a box that is late delivering a status flip, and on a
   * loaded box the IPC dispatch jitter is what it has to absorb. What spending
   * it means is decided by the callers: a NAMED hold on the row (parkSendNow),
   * never a hard kill (bridge.close() destroys the agent) and never a note.
   *
   * The total the person can wait with the doors locked is this PLUS the
   * host's own TURN_RELEASE_TIMEOUT_MS (shell/agent-host.cjs, 2500 ms), which
   * runs inside onStop() and is not this window's to bound. Stated, not
   * hidden. */
  const SEND_NOW_RELEASE_BUDGET_MS = 250
  /* runStop's third answer, beside true (released) and false (refused): the
     stop was accepted and idle did not arrive inside the budget. An object,
     not a string, so `=== false` checks at the doors keep meaning "refused"
     and a caller that wants the reason has it by name. */
  const SEND_NOW_RELEASE_HOLD = Object.freeze({ held: true, reason: 'SEND_NOW_RELEASE_BUDGET' })
  const waitForIdle = ({ budgetMs = SEND_NOW_RELEASE_BUDGET_MS } = {}) => {
    if (disposed || !isBusy()) return Promise.resolve(!disposed)
    if (typeof status?.subscribe !== 'function') return Promise.resolve(false)
    return new Promise(resolve => {
      let unsubscribe = null
      let settled = false
      let budget = null
      const finish = ok => {
        if (settled) return
        settled = true
        if (budget) clearTimeout(budget)
        unsubscribe?.()
        cancelStopWait = null
        resolve(ok)
      }
      const check = () => { if (disposed || !isBusy()) finish(!disposed) }
      cancelStopWait = () => finish(false)
      /* Only a finite, non-negative budget bounds the wait; anything else is a
         caller asking for the old unbounded behaviour by name, not by typo. */
      if (Number.isFinite(budgetMs) && budgetMs >= 0) {
        budget = setTimeout(() => { if (!disposed && isBusy()) finish(SEND_NOW_RELEASE_HOLD); else check() }, budgetMs)
      }
      try {
        unsubscribe = status.subscribe(check)
        if (settled) unsubscribe?.()
        else check()
      } catch { finish(false) }
    })
  }
  /* THE PRESS'S OWN WORK, and all of it is local.
   *
   * Every stop door calls this FIRST and synchronously, before anything is
   * awaited: the half-written answer leaves the screen at the press, not when
   * the engine gets round to admitting it stopped. See the openStream
   * abandon() note for the measured before-numbers.
   *
   * Returns how many streams it threw away, so a caller can tell "there was
   * nothing running" from "the partial is gone now" without asking the DOM. */
  const abandonLiveStreams = () => {
    let thrown = 0
    for (const stream of [...liveStreams]) {
      if (typeof stream.abandon === 'function' && stream.abandon() === true) thrown += 1
    }
    return thrown
  }
  const runStop = async ({ waitForIdle: awaitIdle = false, noteBefore = null } = {}) => {
    if (stopping || typeof onStop !== 'function' || (queueRequired() && !isBusy())) return false
    stopping = true
    /* Before the first await, so the discard is in the same frame as the press
       rather than one IPC round trip later. */
    abandonLiveStreams()
    syncComposer()
    try {
      const said = await onStop()
      const sentence = said && typeof said === 'object' ? said.sentence : said
      if (!disposed && sentence) {
        addMsg('note', String(sentence), undefined, liveChatTiming(), null,
          noteBefore?.parentNode === log ? { before: noteBefore } : {})
      }
      if (said?.ok === false) return false
      // Interrupt acknowledgement does not free the turn. A held Send now
      // waits for the status driven by the actual completion event, keeping
      // its saved reservation and all stop doors locked through that span --
      // for at most the release budget. Past it this resolves to
      // SEND_NOW_RELEASE_HOLD (truthy, `.held === true`), and the finally
      // below still unlocks the doors: a wait that ended is not a stop that
      // is still running.
      if (awaitIdle && said?.settled !== true) return await waitForIdle()
      return !disposed
    } catch {
      if (!disposed) addMsg('note', STOP_FAILED)
      return false
    } finally {
      stopping = false
      syncComposer()
    }
  }
  root.querySelector('.working-step button')?.addEventListener('click', () => { void runStop() })

  const makeTimeDivider = (timing) => {
    if (!timing.copy) return null
    const divider = document.createElement('time')
    divider.className = 'chat-time-divider'
    divider.dateTime = timing.copy.dateTime
    divider.textContent = timing.copy.text
    divider.setAttribute('aria-label', resumedAtLabel(timing.copy.text))
    return divider
  }

  const addTimeDivider = (timing) => {
    const divider = makeTimeDivider(timing)
    if (divider) log.appendChild(divider)
    return divider
  }

  /* A PICTURE IS PART OF THE MESSAGE, NOT A FOOTNOTE ABOUT IT, so it is drawn
     inside the bubble between the words and the footer, the way the person
     composed it. Nothing here reads a file: `pictures` are previews already in
     hand, and a bubble given none looks exactly as it always did. */
  const drawPictures = (m, pictures) => {
    const drawable = (pictures || []).map(drawablePicture)
      .filter(picture => picture && PICTURE_MIMES.has(picture.mime) && picture.base64)
    if (!drawable.length) return
    const strip = document.createElement('div')
    strip.className = 'chat-msg-pictures'
    for (const picture of drawable) {
      const image = document.createElement('img')
      image.className = 'chat-msg-picture'
      /* setAttribute, not .src: the property would resolve the value against
         the page's own URL on read, and these are compared as written. */
      image.setAttribute('src', `data:${picture.mime};base64,${picture.base64}`)
      /* The file's own name, so somebody reading this with a screen reader is
         told which picture they sent rather than that there is one. */
      image.setAttribute('alt', picture.name || '')
      strip.appendChild(image)
    }
    m.appendChild(strip)
  }
  const makeMsg = (from, text, who, timing, turnStamp = null, pictures = null) => {
    const m = document.createElement(from === 'thinking' ? 'details' : 'div')
    m.className = `msg ${from}`
    if (timing.copy) m.title = timing.copy.text
    if (who) {
      const sender = document.createElement(from === 'thinking' ? 'summary' : 'span')
      sender.className = 'who'
      sender.textContent = who
      m.appendChild(sender)
      if (from === 'thinking') ownDisclosure(m, { within: sender })
    }
    const body = document.createElement('div')
    body.className = 'chat-msg-text'
    setChatMessageBody(body, text, { plain: !['them', 'thinking'].includes(from) })
    m.appendChild(body)
    drawPictures(m, pictures)
    /* The clock and source stamp are evidence ABOUT a message, not words in
       its final sentence. Keeping them in a quiet footer makes long prose,
       lists and code blocks end cleanly on every shared chat surface. */
    const footer = document.createElement('div')
    footer.className = 'chat-msg-footer'
    let footerItems = 0
    if ((from === 'me' || from === 'them') && timing.copy) {
      const time = document.createElement('time')
      time.className = 'chat-message-time'
      time.setAttribute('data-chat-message-time', '')
      time.textContent = timing.copy.text
      time.dateTime = timing.copy.dateTime
      time.setAttribute('aria-label', timing.copy.ariaLabel)
      footer.appendChild(time)
      footerItems += 1
    }
    /* A stamp is evidence supplied by the transcript source. No supplied
       stamp means no badge: timestamps and array positions are not proof of
       a turn identity. */
    if (typeof turnStamp === 'string' && turnStamp.trim()) {
      const stamp = document.createElement('span')
      stamp.className = 'turn-stamp'
      stamp.textContent = turnStamp
      footer.appendChild(stamp)
      footerItems += 1
    }
    if (['me', 'them', 'thinking'].includes(from)) { addChatMessageCopy(m, body, footer); footerItems += 1 }
    if (footerItems) m.appendChild(footer)
    return { m, body }
  }

  /* AN EMPTY LOG SAYS SO, IN WORDS. A live agent page over a declared seat
     that has never run seeds nothing and has no history, so the log rendered
     as a bare box -- roughly 600x125px of nothing, over a composer whose
     reason line explains only the COMPOSER. tools/window-size-sweep-qa.mjs
     flags exactly that shape ("no empty region where content should be --
     div.chat-log") at every width, and it is right: a hole reads as broken,
     a sentence reads as a fact. The note is styled inline (muted ink, own
     margins) rather than in styles.css, and it leaves the moment the first
     real message lands. */
  const emptyNote = document.createElement('div')
  emptyNote.className = 'chat-log-empty'
  emptyNote.textContent = EMPTY_LOG_NOTE
  emptyNote.style.cssText = 'margin:auto;padding:var(--s3) 0;color:var(--ink-25);font-size:12.5px;text-align:center;'

  /* WHO IS SPEAKING, AND WHEN THE LOG SAYS SO.
   *
   * THE DEFECT (owner, items 2 and 4: the messages "pile"). Live messages
   * passed no label at all while restored history passed one for every entry,
   * so the same conversation carried names on its past and none on its
   * present, and a person reading it could not tell whose words were whose.
   * MEASURED on a staged packaged build: hasWho false on the live row, true on
   * the restored row directly above it.
   *
   * So the rule lives HERE rather than at each call site: a label whenever the
   * speaker changes, whichever path appended the row. A caller may still force
   * one (pass a name) or forbid one (pass null); `undefined` means "you
   * decide", which is what every real path now says. */
  let lastLabelled = null
  const labelFor = (from) => {
    if (from === 'me') return 'you'
    /* The product's own notes are not a speaker, so they are not named. */
    if (from === 'note') return null
    return title
  }
  /* The two paths that build their own bubble rather than going through
     addMsg -- the live stream and the simulated reply -- still take the shared
     rule, so a turn being written and a turn already written are the same
     bubble with the same label. */
  const dividedFor = (timing) => timing.semanticAt !== null
    && lastSemanticTurnAt !== null
    && lastTurnAt !== null
    && timing.sequenceAt - lastTurnAt > CHAT_CLUSTER_GAP
  const rememberTiming = (timing) => {
    lastTurnAt = timing.sequenceAt
    lastSemanticTurnAt = timing.semanticAt
  }
  const streamLabel = (timing) => {
    const divided = dividedFor(timing)
    const label = (lastLabelled === 'them' && !divided) ? null : labelFor('them')
    lastLabelled = 'them'
    return { label, divided }
  }
  // A stopped provider can finish a reply already present in restored
  // history. Only an explicitly named, unique agent entry may be reused.
  const resumableHistoryRows = new Map()
  /* The first row already painted for a turn, matched only by the supplied
     stamp: timestamps and array positions are not proof of a turn identity.
     The person's own rows are skipped, so a repeated line for one turn lands
     after the line already there rather than above it. */
  const firstRowOfTurn = (turnStamp, { liveActionRuns = true } = {}) => {
    if (typeof turnStamp !== 'string' || !turnStamp.trim()) return null
    const rows = [...log.children]
    for (let at = 0; at < rows.length; at++) {
      const node = rows[at]
      if (!node.classList?.contains('msg') || node.classList.contains('me')) continue
      if (node.querySelector?.('.turn-stamp')?.textContent !== turnStamp) continue
      /* Live, a turn's tool calls are painted before its first words and carry
         no stamp, so climb the action rows directly above it: a settled run
         belongs to the turn whose words follow it. A saved action row names no
         turn at all, so a replay leaves it where the record put it. */
      let seat = at
      while (liveActionRuns && seat > 0 && rows[seat - 1].classList?.contains('chat-action')) seat--
      return rows[seat]
    }
    return null
  }
  const addMsg = (from, text, who, timing = liveChatTiming(), turnStamp = null, { before = null, pictures = null } = {}) => {
    if (emptyNote.parentNode) emptyNote.remove()
    /* Words end the work: any spoken entry folds the live run above it, so the
       transcript reads as the agent's text with its doing gathered beneath. */
    settleActionRuns()
    const divided = dividedFor(timing)
    if (divided) addTimeDivider(timing)
    rememberTiming(timing)
    /* A time divider is a fresh start, so the speaker is named again beneath
       one even when it is the same speaker. */
    const decided = who === undefined
      ? ((lastLabelled === from && !divided) ? null : labelFor(from))
      : who
    const { m } = makeMsg(from, text, decided, timing, turnStamp, pictures)
    /* Append is the ordinary case; `before` seats a late owner line at the head
       of its own turn. Only the row left at the tail may own lastLabelled, or
       the next speaker is named again above its own group. */
    if (before && before.parentNode === log) log.insertBefore(m, before)
    else { log.appendChild(m); lastLabelled = from }
    revealNewBelow()
    pinToBottom()
    return m
  }
  /* ONE OWNER-BUBBLE PATH FOR BOTH DELIVERY EDGES. An ordinary send paints
     optimistically; a queued send calls this only after the host accepts it.
     Keeping the construction here means those two doors cannot drift in
     identity, timing, labels or turn stamps. */
  const addOwnerMessage = (text, { at, turnStamp = null, pictures = null, attachmentCount = 0 } = {}) => {
    const body = typeof text === 'string' ? text : ''
    if (disposed || (!body.trim() && !pictures?.length && !(attachmentCount > 0))) return null
    /* A fast turn can paint its reply before the send is acknowledged, so seat
       this line at the head of its own turn instead of under the answer. On the
       ordinary path there is no such row and this appends as it always did. */
    return addMsg('me', body, undefined, liveChatTiming(at), turnStamp,
      { before: firstRowOfTurn(turnStamp), pictures })
  }
  /* A receipt belongs to the exact owner row, including one restored after an
     earlier-history repaint. Never find a row by matching its words. */
  const confirmOwnerMessage = (message, receipt) => {
    const turnId = receipt?.turnId
    if (disposed || message?.parentNode !== log || !message.classList?.contains('me')
      || typeof turnId !== 'string' || !turnId.trim() || turnId.length > 512
      || message.querySelector('.turn-stamp')) return
    const footer = message.querySelector('.chat-msg-footer')
    if (!footer) return
    const stamp = document.createElement('span')
    stamp.className = 'turn-stamp'
    stamp.textContent = turnId
    footer.insertBefore(stamp, footer.querySelector('.chat-message-copy'))
  }
  /* THE TREE'S OWN WORDS, FOLDED AWAY BUT NEVER CUT.
   *
   * THE DEFECT. The address block rides with every tree start as its own
   * transcript entry, and giving it a quiet dress was only half the fix:
   * MEASURED on a staged packaged build, it still drew 298px in a 371px log,
   * so the first thing a first-timer saw of their first conversation was a
   * screen and a half of internal plumbing. Quiet plumbing is still plumbing.
   *
   * A DISCLOSURE, NOT A TRUNCATION, and the distinction is the whole design.
   * Nothing is removed, shortened or summarised away: the entry stays whole
   * inside, one press away, and the press is the one a person has already
   * learned from the action rows two inches down the same panel.
   *
   * THE CLOSED LINE HAS TO EARN THE PRESS. A fold labelled with plumbing is
   * how you get somebody who never opens it, so the caller supplies a sentence
   * in the person's own words AND the size -- this component stays copy-free,
   * so both ride on the entry.
   *
   * REMEMBERED PER CONVERSATION. Somebody who opens this wants it open for the
   * thread they are reading, not for every thread they ever open, so the key
   * is the caller's (`openKey`, the session). No key means no memory rather
   * than a shared one -- a global default is the thing being avoided. */
  const contextOpen = openMemory('mc.chat.context-open:')

  const addContext = (entry, { before = null } = {}) => {
    if (emptyNote.parentNode) emptyNote.remove()
    /* Same rule as addMsg: a context entry is not a call, so it ends the run. */
    settleActionRuns()
    const timing = restoredChatTiming(entry.at)
    const key = typeof entry.openKey === 'string' ? entry.openKey : ''
    const wrap = document.createElement('details')
    wrap.className = 'msg context chat-context'
    if (timing.copy) wrap.title = timing.copy.text
    wrap.open = contextOpen.recall(key) === 'open'
    const head = document.createElement('summary')
    head.className = 'chat-context-head'
    const mark = document.createElement('span')
    mark.className = 'chat-action-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = '<svg viewBox="0 0 8 8"><path d="M2.6 1.4 5.4 4 2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    const words = document.createElement('span')
    words.className = 'chat-context-line'
    /* The heading names WHO, the sentence says WHAT and HOW MUCH. Both are the
       caller's words. */
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = typeof entry.label === 'string' ? entry.label : ''
    const say = document.createElement('span')
    say.className = 'chat-context-say'
    say.textContent = typeof entry.summary === 'string' ? entry.summary : ''
    words.append(who, say)
    head.append(mark, words)
    const body = document.createElement('div')
    body.className = 'chat-context-body'
    body.innerHTML = formatInlineText(entry.text, { agents: [{ name: title, role: roleKey }], roleKey })
    wrap.append(head, body)
    /* The gesture is owned here for the reason makeAction documents at length:
       elementFromPoint over a collapsed row answers the DETAILS, so a press
       beside the disclosure triangle is not a press on it and nothing opens. */
    ownDisclosure(wrap, { within: head, onToggle: () => contextOpen.remember(key, wrap.open) })
    rememberTiming(timing)
    /* Sent with the person's line and stamped with the same turn, so it is
       seated with that line rather than left under the answer. */
    if (before && before.parentNode === log) log.insertBefore(wrap, before)
    else log.appendChild(wrap)
    revealNewBelow()
    pinToBottom()
    return wrap
  }

  /* THE MODEL'S OWN WORKING, SHOWN -- AND NEVER MISTAKEN FOR THE ANSWER.
   *
   * The owner wants thinking shown. What must not happen while it is: engine
   * claude-cli-adapter.js forwards a `thinking` content block as its own
   * event type instead of assistant speech, for exactly one reason stated in
   * its own header -- forwarding it as assistant text "would still put the
   * model's private working into the transcript as though the agent had said
   * it." Whatever door this component opens for thinking has to keep that
   * same distinction, or showing it is worse than the drop it replaced.
   *
   * So it is its OWN painted entry, never a prefix or a paragraph folded into
   * the answer bubble: `addMsg('thinking', ...)` gives it its own class
   * (`msg thinking`, styled in styles.css as the same quiet aside family as
   * `.msg.context` and `.msg.note` -- dashed border, muted ink, italic, no
   * tail) and its own fixed label, "Thinking" -- never the agent's name, so
   * it cannot be read as something the agent said to the person. Appended
   * ahead of the words it preceded, so reading order alone keeps the two
   * apart even before a reader notices the dress is different.
   *
   * ONE SHOT, NOT A STREAM -- the caller assembles the whole thinking text for
   * a turn first (the composer that calls this already does exactly that with
   * the turn's real words, into chatTurnText, before handing them to addMsg)
   * and hands it over once. Blank input paints nothing: a turn that thought
   * nothing leaves no empty aside behind. */
  const addThinking = (text, { at } = {}) => {
    const body = typeof text === 'string' ? text.trim() : ''
    if (disposed || !body) return null
    return addMsg('thinking', body, 'Thinking', liveChatTiming(at))
  }
  Object.defineProperty(root, 'addThinking', { value: addThinking })

  /* ---- THE SECOND DOOR: WHAT THE AGENT DID, BESIDE WHAT IT SAID. ----
   *
   * THE DEFECT THIS CLOSES (owner, item 1, and his biggest ask). The engine
   * narrates every turn -- tool_call, tool_result, approval_request, each
   * carrying the command or the path and the name that pairs a result with its
   * call -- and every one of those packets already reached this window. They
   * went to a ONE-LINE status string that the next event overwrote, and were
   * deleted when the turn ended. So a turn that spent five minutes running
   * commands put ZERO rows in the chat, by construction, and the product looked
   * hung while it worked.
   *
   * openStream is the door for what the agent SAYS; this is the door for what
   * it DOES, and they append into the SAME log so the two interleave in arrival
   * order the way an editor interleaves its tool calls with its prose.
   *
   * A ROW IS COLLAPSED AND PRESSABLE. `details`/`summary` rather than a button
   * and a class toggle: the open/closed state, the keyboard, and the screen
   * reader all come from the element, and nothing here has to reimplement them.
   *
   * A RESULT UPDATES ITS CALL'S ROW. The id is the caller's join key (both
   * engines put one on the event), so a command that finishes repaints the row
   * it started rather than adding a second one beneath it.
   *
   * APPENDS ARE BATCHED PER FRAME, and that is not a micro-optimisation. This
   * log is pinned to its bottom by a ResizeObserver AND a MutationObserver, both
   * of which fire on every appended child; a busy turn would re-pin thousands of
   * times on the main thread. onNextFrame rather than requestAnimationFrame for
   * the reason src/page-frames.js exists: on a window the machine has covered
   * there is no next frame, so the callback -- and this whole chat with it --
   * would be retained for ever.
   *
   * THE WORDS ARE THE CALLER'S. This component is used by three pages and must
   * stay copy-free; the tool names and outcome words live in
   * src/fleet-tree-copy.js, where the plain-language gate can hold them. */
  let pendingActions = []
  let actionFrame = 0

  // The state word remains the accessible source of truth; this mark adds a
  // distinct silhouette for motion, completion, attention, and an unknown result.
  const actionStateMark = () => {
    const mark = document.createElement('span')
    mark.className = 'chat-action-status-icon'
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><circle class="action-icon-track" cx="10" cy="10" r="7"/><path class="action-icon-spin" d="M10 3a7 7 0 0 1 7 7"/><path class="action-icon-done" d="m5.5 10 3 3 6-6"/><path class="action-icon-pause" d="M7.5 6.5v7m5-7v7"/><path class="action-icon-alert" d="M10 5.5v5m0 3v.2"/><path class="action-icon-unknown" d="M7.5 7.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 3.5m0 2.5v.2"/></svg>'
    return mark
  }

  const measuredActionDuration = (row) => (
    row && Object.hasOwn(row, 'durationMs') && Number.isFinite(row.durationMs) && row.durationMs >= 0
      ? row.durationMs
      : null
  )

  /* Consecutive calls are one piece of work, not a stack of transcript turns.
     Keep every call (and its independently expandable output), but put the run
     behind a single transcript line. The DOM adjacency check in paintAction
     ends a run naturally whenever prose, a note, or a context entry lands in
     the log between calls. */
  const makeActionRun = () => {
    const wrap = document.createElement('details')
    wrap.className = 'chat-action chat-action-run'
    const head = document.createElement('summary')
    head.className = 'chat-action-head'
    const mark = document.createElement('span')
    mark.className = 'chat-action-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = '<svg viewBox="0 0 8 8"><path d="M2.6 1.4 5.4 4 2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    const line = document.createElement('span')
    line.className = 'chat-action-detail'
    const disclosure = document.createElement('span')
    disclosure.setAttribute('data-chat-action-run-disclosure', '')
    const body = document.createElement('div')
    body.className = 'chat-action-run-body'
    head.append(mark, actionStateMark(), line, disclosure)
    wrap.append(head, body)
    /* TEMPORARILY VISIBLE, THEN COLLAPSED (owner, 2026-08-24: "we want more of
       the agent's text… we want to see those too just temporarily and then let
       them collapse"). A run is OPEN while it is the live edge of the log, so
       the calls stream past as they happen — and the moment the agent speaks
       again, settleActionRuns() folds it to its one line. A run the person
       opened or closed BY HAND is theirs: the flag below takes it out of the
       auto-fold for good, because a choice outranks a policy. */
    /* A completed multi-call run now folds before prose arrives; see
       refreshRunLine. It still starts open so a live call is visible. */
    const run = { wrap, head, line, total: null, disclosure, body, rows: [], count: 0 }
    wrap.open = true
    refreshRunDisclosure(run)
    wrap.addEventListener('click', (event) => {
      /* A nested call owns presses on its own summary and output. Without this
         guard that bubbling press would also close the containing run. */
      if (event.target.closest('.chat-action') !== wrap) return
      if (event.target !== wrap && !head.contains(event.target)) return
      event.preventDefault()
      wrap.__runUserToggled = true
      wrap.open = !wrap.open
      refreshRunDisclosure(run)
    })
    return run
  }

  const refreshRunDisclosure = (run) => {
    if (!run) return
    run.disclosure.textContent = actionRunDisclosureWord(run.wrap.open)
  }

  /* The folded line is recomputed, never accumulated: a result that repaints a
     row into `undone` or `refused` has to reach the sentence above it, and the
     two never-fold states are the reason the line exists at all — a fold that
     could hide a refusal would be the silent-control defect wearing a tidier
     coat. */
  const refreshRunLine = (run) => {
    if (!run) return
    const rows = [...run.body.querySelectorAll('.chat-action')]
    const tools = rows.filter(row => row.dataset.actionKind !== 'thinking')
    run.count = tools.length
    /* A RUN HOLDING EXACTLY ONE CALL IS NOT A CLUSTER TO FOLD -- owner,
     * 2026-09-03: "Tools need to condense more." Every call is wrapped in a
     * run, even a lone one (addToActionRun below has no other door), so a
     * turn that ran ONE tool cost a person two presses to read it: open the
     * run's own "1 tool call" line to reach the row that sentence stood in
     * for, then open THAT row to reach its output. Two collapsed lines for
     * one fact, both wearing the SAME .chat-action card chrome (border,
     * left border, background) -- a single call painted as two stacked
     * boxes, which is exactly "a sprawl that buries the answer" on the
     * smallest possible run.
     *
     * is-solo (styles.css) hides the run's own head and strips its box the
     * moment it holds one row, so the row's OWN line -- tool, detail,
     * state, its own duration -- is what a person sees, openable once for
     * the output like any other action row. Nothing about the run's
     * identity changes: a second call arriving before the reply still
     * lands in this SAME run (addToActionRun matches by DOM adjacency,
     * not by count), `run.count` becomes 2 on that call's own
     * refreshRunLine, is-solo comes off, and the ordinary fold reappears
     * with both calls under it -- unchanged from before this. */
    const solo = rows.length === 1
    run.wrap.classList.toggle('is-solo', solo)
    /* Forced open, not merely left alone. With its own head hidden there is
       no surface left on the run for a press to land on, so if `open` were
       ever false the row inside would be unreachable by plain <details>
       semantics -- not a tidier transcript, a call nobody can get back.
       settleActionRuns() below is the one other place `open` changes, and
       it is told to leave a solo run alone for the same reason; this line
       makes the invariant hold even if a future caller forgets that. */
    if (solo) run.wrap.open = true
    const states = rows.map(row => row.dataset.actionState || 'unknown')
    run.wrap.dataset.actionState = ['waiting', 'working', 'undone', 'refused', 'unknown'].find(state => states.includes(state)) || 'done'
    // A later call can start in an automatically folded run before prose
    // arrives. Surface that live work again, while preserving a reader's fold.
    if (!run.wrap.__runUserToggled && states.some(state => ['working', 'waiting'].includes(state))) run.wrap.open = true
    const allSettled = rows.length > 1 && rows.every(row => (
      row.dataset && typeof row.dataset.actionState === 'string' && !['working', 'waiting', ''].includes(row.dataset.actionState)
    ))
    /* COMPLETION IS THE EARLIEST HONEST FOLD. The earlier policy waited for
       prose, leaving a completed wall of calls expanded throughout a long
       thinking gap. Missing state is treated as live because addToActionRun
       attaches a new row just before paintAction stamps its state. */
    if (allSettled && !run.wrap.__runUserToggled) run.wrap.open = false
    run.line.textContent = run.count ? actionRunLine(run.count, {
      undone: tools.filter(row => row.dataset.actionState === 'undone').length,
      refused: tools.filter(row => row.dataset.actionState === 'refused').length,
      unknown: tools.filter(row => row.dataset.actionState === 'unknown').length,
    }) : 'Thinking'
    let totalMs = 0
    let measuredCount = 0
    for (const held of run.rows) {
      if (!Number.isFinite(held.durationMs) || held.durationMs < 0) continue
      totalMs += held.durationMs
      measuredCount += 1
    }
    const totalText = actionRunTotalText(totalMs, measuredCount)
    if (measuredCount > 0) {
      if (!run.total) {
        run.total = document.createElement('span')
        run.total.setAttribute('data-chat-action-run-total', '')
        run.head.insertBefore(run.total, run.disclosure)
      }
      run.total.textContent = totalText
    } else if (run.total) {
      run.total.remove()
      run.total = null
    }
    refreshRunDisclosure(run)
  }

  /* Prose lands, the work folds. Only auto-opened runs settle — see the
     hand-toggle flag in makeActionRun. */
  const settleActionRuns = () => {
    for (const el of log.querySelectorAll('.chat-action-run[open]')) {
      /* A solo run has no fold to settle into -- its own head is hidden
         (is-solo, refreshRunLine above) and the row inside is the only
         thing left to read, so closing the run would take that row down
         with it under plain <details> semantics: not condensed, gone. */
      if (!el.__runUserToggled && !el.classList.contains('is-solo')) el.open = false
      refreshRunDisclosure(el.__chatActionRun)
    }
  }

  const addToActionRun = (held) => {
    let run = log.lastElementChild?.classList.contains('chat-action-run')
      ? log.lastElementChild.__chatActionRun
      : null
    if (!run) {
      run = makeActionRun()
      run.wrap.__chatActionRun = run
      log.appendChild(run.wrap)
    }
    run.rows.push(held)
    run.body.appendChild(held.wrap)
    refreshRunLine(run)
  }

  const makeAction = (row) => {
    const wrap = document.createElement('details')
    wrap.className = 'chat-action'
    const thinking = row.kind === 'thinking' || (!row.kind && row.tool === 'Thinking')
    wrap.dataset.actionKind = thinking ? 'thinking' : String(row.kind || 'call')
    const head = document.createElement('summary')
    head.className = 'chat-action-head'
    const tool = document.createElement('span')
    tool.className = 'chat-action-tool'
    const detail = document.createElement('span')
    detail.className = 'chat-action-detail'
    const state = document.createElement('span')
    state.className = 'chat-action-state'
    /* THE ROW SAYS WHETHER IT OPENS. Expandable rows and bare rows (a
       conversation restored from the excerpt keeps the command, not its
       output) drew identically, so a person pressing a bare row got nothing
       and learned the rows were broken. The disclosure mark is the
       difference: drawn on a row with something to open, blank on one
       without — the mark's SPACE is kept either way so the columns align.
       Decorative only (the details element already announces its state), so
       it is hidden from the accessibility tree. */
    const mark = document.createElement('span')
    mark.className = 'chat-action-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = '<svg viewBox="0 0 8 8"><path d="M2.6 1.4 5.4 4 2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    head.append(mark, actionStateMark(), tool, detail, state)
    /* A command and its output are machine text: textContent, never markup. */
    const body = document.createElement(thinking ? 'div' : 'pre')
    body.className = thinking ? 'chat-action-body chat-thinking-body' : 'chat-action-body'
    wrap.append(head, body)
    /* THE ROW OPENS ON A PRESS ANYWHERE ON IT, AND THAT IS NOT WHAT `details`
     * GAVE US FOR FREE.
     *
     * MEASURED on a staged packaged build with real mouse events at coordinates
     * taken from the element's own box: document.elementFromPoint over any part
     * of a collapsed row -- the heading, the tool name, the command text --
     * answers the DETAILS element rather than the SUMMARY inside it, and a press
     * that lands on the details' own area is not a press on the disclosure, so
     * nothing opened. The row looked pressable and was not.
     *
     * So the gesture is owned here instead of inherited: the native toggle is
     * cancelled and the row is opened by hand, which makes a press anywhere on
     * the heading work exactly as it looks like it should. `details` is kept for
     * what it is genuinely good at -- the open/closed state, the keyboard, and
     * what a screen reader announces.
     *
     * A ROW WITH NOTHING TO OPEN DOES NOT OPEN. A conversation restored from an
     * excerpt the window no longer holds carries the command and not the output
     * it printed, and expanding onto an empty panel reads as the product having
     * lost something. */
    wrap.addEventListener('click', (event) => {
      if (event.target !== wrap && !head.contains(event.target)) return
      /* ON THE ROW, NOT ON ITS HEADING, and the difference is the whole reason
         the first version of this did nothing. The press lands on the DETAILS
         element -- that is what elementFromPoint answers over every part of a
         collapsed row -- so the click's target IS the details and a handler
         bound to the summary inside it never sees the event. Events travel up,
         never down. */
      if (wrap.classList.contains('is-bare')) { event.preventDefault(); return }
      /* The native toggle is cancelled and redone by hand so that a press on
         the summary and a press beside it behave identically rather than
         toggling twice. */
      event.preventDefault()
      wrap.__actionUserToggled = true
      wrap.open = !wrap.open
    })
    wrap.addEventListener('toggle', () => {
      if (wrap.open && wrap.classList.contains('is-bare')) wrap.open = false
    })
    return { wrap, head, tool, detail, state, body, duration: null, durationMs: null, thinking,
      readable: thinking ? createReadableTextBuffer() : null }
  }

  const paintAction = (row) => {
    let held = actionRows.get(row.id)
    if (!held) {
      if (emptyNote.parentNode) emptyNote.remove()
      held = makeAction(row)
      actionRows.set(row.id, held)
      // Approvals and turn outcomes keep independent visible controls.
      // Thinking belongs to the same work group, without adding a tool count.
      const separate = ['approval', 'turn'].includes(row.kind)
        || (!row.kind && ['Approval', 'Turn'].includes(row.tool))
      if (separate) log.appendChild(held.wrap)
      else addToActionRun(held)
    }
    held.wrap.dataset.actionState = String(row.stateKey || '')
    held.tool.textContent = String(row.tool || '')
    held.detail.textContent = String(row.detail || '')
    held.detail.title = String(row.body || row.detail || '')
    held.state.textContent = String(row.state || '')
    const durationMs = measuredActionDuration(row)
    if (durationMs === null) {
      if (held.duration) held.duration.remove()
      held.duration = null
      held.durationMs = null
    } else {
      if (!held.duration) {
        held.duration = document.createElement('span')
        held.duration.setAttribute('data-chat-action-duration', '')
        held.head.appendChild(held.duration)
      }
      held.duration.textContent = formatActionDuration(durationMs)
      held.durationMs = durationMs
    }
    const source = String(row.body || '')
    const body = held.thinking
      ? (row.stateKey === 'working' ? held.readable.push(source) : held.readable.finish(source))
      : source
    if (held.thinking) {
      setChatMessageBody(held.body, body + (row.truncated ? `\n\n${THINKING_TRUNCATED_NOTICE}` : ''))
      if (!held.wrap.__actionUserToggled) held.wrap.open = row.stateKey === 'working' && body.length > 0
    } else held.body.textContent = body
    /* Nothing to open is said by the row itself rather than by an empty panel. */
    held.wrap.classList.toggle('is-bare', body.length === 0)
    /* A result repainting its call's row can change the run's sentence —
       most importantly into `refused` or `undone`, which the fold must say. */
    refreshRunLine(held.wrap.closest('.chat-action-run')?.__chatActionRun)
  }

  const flushActions = () => {
    actionFrame = 0
    if (disposed || pendingActions.length === 0) return
    const batch = pendingActions
    pendingActions = []
    for (const row of batch) paintAction(row)
    syncComposer()
    pinToBottom()
  }

  Object.defineProperty(root, 'addAction', {
    value: (row) => {
      if (disposed || !row || typeof row !== 'object' || !row.id) return
      pendingActions.push(row)
      if (!actionFrame) actionFrame = onNextFrame(flushActions)
    },
  })

  // Both live changes and restored history populate the session drawer.
  // A chat owns its default editor; callers may supply their page's editor.
  const chatCompareFiles = typeof onOpenDiff === 'function' ? null : createCompareFilesDoor()
  const openSessionDiff = onOpenDiff || createChatDiffOpenHandler(chatCompareFiles)
  const sessionChanges = mountChatSessionChanges(root, { onOpenDiff: openSessionDiff })
  const diffRows = new Map()

  const paintDiff = (held, normalized) => {
    held.batch = normalized
    /* Whole replacement. Clearing the children first guarantees that a
       shorter replacement cannot retain an old file, position or control. */
    held.wrap.textContent = ''
    const active = normalized.files[normalized.activeIndex]
    const head = document.createElement('div')
    head.className = 'chat-diff-head'

    const status = document.createElement('span')
    status.setAttribute('data-chat-diff-status', '')
    status.textContent = chatDiffStatusText(active.status)

    const path = document.createElement('span')
    path.setAttribute('data-chat-diff-path', '')
    path.textContent = chatDiffPathText(active.path)

    const added = document.createElement('span')
    added.setAttribute('data-chat-diff-additions', '')
    if (active.added === null) added.className = 'chat-diff-unmeasured'
    added.textContent = active.added === null ? 'Line counts unavailable, see the diff' : chatDiffAddedText(active.added)

    const removed = document.createElement('span')
    removed.setAttribute('data-chat-diff-deletions', '')
    removed.textContent = chatDiffRemovedText(active.removed)

    const position = document.createElement('span')
    position.setAttribute('data-chat-diff-position', '')
    position.textContent = chatDiffPositionText(normalized.activeIndex, normalized.files.length)

    head.appendChild(status)
    head.appendChild(path)
    head.appendChild(added)
    head.appendChild(removed)
    head.appendChild(position)

    if (typeof onOpenDiff === 'function') {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'chat-diff-open'
      open.setAttribute('data-chat-open-diff', '')
      open.textContent = CHAT_DIFF_OPEN_TEXT
      open.setAttribute('aria-label', chatDiffOpenLabel(active.path))
      open.addEventListener('click', () => {
        if (disposed) return
        const selected = held.batch.files[held.batch.activeIndex]
        sessionChanges.openFile(selected.path)
      })
      head.appendChild(open)
    }

    held.wrap.appendChild(head)
  }

  Object.defineProperty(root, 'addDiff', {
    value: (batch) => {
      if (disposed) return
      const normalized = normalizedChatDiffBatch(batch)
      if (!normalized) return
      sessionChanges.add(normalized)
      let held = normalized.id ? diffRows.get(normalized.id) : null
      if (!held) {
        if (emptyNote.parentNode) emptyNote.remove()
        settleActionRuns()
        const wrap = document.createElement('div')
        wrap.className = 'chat-diff-card'
        wrap.setAttribute('data-chat-diff-card', '')
        held = { wrap, batch: normalized }
        if (normalized.id) diffRows.set(normalized.id, held)
        log.appendChild(wrap)
        revealNewBelow()
      }
      paintDiff(held, normalized)
      pinToBottom()
    },
  })

  /* REAL HISTORY, WHEN THE CALLER HAS ONE. The tree card passes the actual
     conversation (this window's transcript, or the node's stored ask+reply),
     rendered verbatim — the simulated excerpt below never runs for a caller
     that provided real entries, whatever its seed. */
  if (Array.isArray(history) && history.length) {
    // Older ACP processes reused turn stamps. Once a request owns a stamp,
    // another request with that stamp is ambiguous and keeps its saved order.
    // Context captured with a request follows that request's placement.
    const restoredOwnerSeats = new Map()
    for (const entry of history) {
      /* `who` is transport only. Strip it, then enter through the public live
         boundary so restored data earns the same card and the same identity
         rule. No other history discriminator is inspected for file changes. */
      if (entry && entry.who === 'diff') {
        let batch = null
        try {
          batch = { source: entry.source, files: entry.files }
          if (Object.hasOwn(entry, 'id')) batch.id = entry.id
          if (Object.hasOwn(entry, 'at')) batch.at = entry.at
          if (Object.hasOwn(entry, 'activeIndex')) batch.activeIndex = entry.activeIndex
          if (Object.hasOwn(entry, 'patches')) batch.patches = entry.patches
          if (entry.limited === true) batch.limited = true
        } catch { batch = null }
        if (batch) root.addDiff(batch)
        continue
      }
      /* AN ACTION IS PART OF THE HISTORY TOO, and it is painted by the SAME
         function the live stream uses -- so a conversation reopened tomorrow
         shows the commands where they happened, in the same rows, rather than
         showing only the words and pretending the work was instantaneous. */
      if (entry && entry.who === 'action') { paintAction(entry); continue }
      if (!entry || typeof entry.text !== 'string' || !entry.text) continue
      /* The product's own aside inside a restored conversation -- how it came
         to be shorter than the conversation really was. Same kind, same rule,
         same look as one spoken live. */
      if (entry.who === 'note') {
        const note = addMsg('note', entry.text, undefined, restoredChatTiming(entry.at))
        /* A note about what the chat does not hold stays in view while Search
           hides the rows it did not match, so a search that finds nothing
           still says where the rest of the conversation is. */
        if (entry.keepInSearch === true && note?.dataset) note.dataset.chatKeepInSearch = ''
        continue
      }
      /* WORDS THE PRODUCT SENT FROM THE PERSON'S SIDE -- the tree's context
         block. The caller marks it (this component stays copy-free, so the
         label rides on the entry) and it renders on the sent side in the
         aside family's quiet dress, so the person's own words stay the only
         thing wearing their colour. */
      if (entry.who === 'context') {
        addContext(entry, { before: restoredOwnerSeats.has(entry.turnStamp)
          ? restoredOwnerSeats.get(entry.turnStamp)
          : firstRowOfTurn(entry.turnStamp, { liveActionRuns: false }) })
        continue
      }
      /* The label is left to addMsg -- the SAME rule the live path takes, so a
         restored conversation and the turn that continues it cannot disagree
         about whose words are whose. */
      /* The record can hold the person's line BELOW the answer to it: the
         capture seam appends that line only once the send is acknowledged,
         which a fast turn can finish first. Seat it by its own turn stamp, the
         same way the live path does, without rewriting the stored row. */
      const seatBefore = entry.who === 'you' && !restoredOwnerSeats.has(entry.turnStamp)
        ? firstRowOfTurn(entry.turnStamp, { liveActionRuns: false })
        : null
      if (entry.who === 'you' && typeof entry.turnStamp === 'string' && entry.turnStamp.trim()) {
        restoredOwnerSeats.set(entry.turnStamp, seatBefore)
      }
      /* A PICTURE IS PART OF THE MESSAGE WHEN IT IS REPLAYED, NOT ONLY WHEN IT
         IS FIRST PAINTED (T332). The owner's words were: "the images disappear
         from chat right after sending". They disappeared because the picture
         lived in exactly one optimistic DOM node and this loop -- every reopen,
         every remount, every rebuild of a surface -- redrew the conversation
         from stored entries and passed no pictures at all. So an entry that
         carries them was still replayed without them, and fixing the entry
         without fixing this line would have changed nothing a person can see. */
      const message = addMsg(
        entry.who === 'you' ? 'me' : 'them',
        entry.text,
        undefined,
        restoredChatTiming(entry.at),
        entry.turnStamp,
        { before: seatBefore, pictures: entry.pictures },
      )
      if (entry.who === 'agent' && typeof entry.id === 'string' && entry.id.trim()) {
        resumableHistoryRows.set(entry.id, resumableHistoryRows.has(entry.id) ? null
          : { m: message, body: message.querySelector('.chat-msg-text') })
      }
    }
  }
  // The seeded excerpt is the conversation's *past*, so it must not change
  // between opens: the title is the conversation's identity, so the window
  // into CHAT is derived from it rather than re-rolled with Math.random().
  // Re-opening the same agent's chat now replays the same history.
  const titleHash = hashString(String(title ?? ''))
  const span = Math.max(1, CHAT.length - seed)
  const start = titleHash % span
  const seeded = Array.isArray(history) && history.length ? [] : CHAT.slice(start, start + seed)

  // Give the simulated past a stable rhythm: short exchanges grouped around
  // one real pause. A six-turn direct line therefore reads like a thread,
  // while the compact two-turn comms excerpt does not spend a row on chrome.
  const historyTimes = new Array(seeded.length)
  const clusterAt = seeded.length >= 3 ? Math.floor(seeded.length / 2) : -1
  let historyCursor = CHAT_CLOCK_ORIGIN - (2 + titleHash % 4) * CHAT_MINUTE
  for (let i = seeded.length - 1; i >= 0; i--) {
    historyTimes[i] = historyCursor
    const shortGap = 1 + ((titleHash >>> (i % 24)) % 4)
    const gap = i === clusterAt ? 9 + (titleHash % 4) : shortGap
    historyCursor -= gap * CHAT_MINUTE
  }
  seeded.forEach((m, i) => addMsg(
    m.from,
    m.text,
    i === 0 ? (m.from === 'them' ? title : 'you') : null,
    liveChatTiming(historyTimes[i]),
  ))
  /* Only a log that ends this constructor with nothing in it gets the note;
     the first addMsg from any path removes it again. */
  if (log.childElementCount === 0) log.appendChild(emptyNote)
  /* The seeded history above is written while the panel is still DETACHED
     (the agent view assembles its chat before mount), where scrollHeight is 0
     and the per-message snap inside addMsg is a no-op — the pane then sat
     anchored to its OLDEST message, with the newest sliding under the
     composer and reading as clipped text. A one-shot snap on first layout was
     tried and was not enough: the panel keeps resizing after mount (fonts,
     the strip settling), and any growth after the snap unseated it again.
     So the pane keeps the standard chat contract instead: pinned to the
     newest message through every resize until the reader scrolls away, and
     re-pinned the moment they return to the bottom. */
  log.addEventListener('scroll', () => {
    pinned = log.scrollTop >= log.scrollHeight - log.clientHeight - 24
    if (pinned) clearNewBelow()
  }, { passive: true })
  /* A RESIZE is not new content, so this one keeps the pin and must NOT offer
     the pill: showing the pill changes the chat's layout, which resizes the log,
     which re-enters this observer -- measured as two
     "ResizeObserver loop completed with undelivered notifications." console
     errors in chat-readable-stream before this was put back. Only real content
     growth offers the way down (see the MutationObserver below). */
  const anchorRo = new ResizeObserver(() => {
    pinToBottom()
  })
  anchorRo.observe(log)
  /* Content growth (a new message wrapping taller) moves scrollHeight without
     resizing the box — the same rule applies. `subtree` and `characterData`
     because a streaming turn grows the TEXT of a message that is already in
     the log: with childList alone the live thinking and the reply that follows
     it moved the scroll height without this ever being told, so a reader at
     the bottom stopped being followed and a reader above it was never offered
     the pill. */
  const contentObserver = new MutationObserver(() => {
    followOrOffer()
  })
  contentObserver.observe(log, { childList: true, subtree: true, characterData: true })
  // The webfont swap grows text with no mutation and no box resize. `ready`
  // can also settle while this chat is still detached, so doing the write in
  // that promise callback is another zero-measurement no-op. Re-elect the pin
  // after two painted frames, and listen for later font generations too.
  let firstPinFrame = 0
  let settledPinFrame = 0
  const pinAfterMount = () => {
    /* Two frames because the webfont swap grows the text a frame after it
       lands. On a page that gets NO frames both callbacks were pending for
       ever and held this chat's whole tree -- the largest single contributor
       at +3 per lap of the ring, measured. onNextFrame applies the pin at
       once on such a page (off a flushed layout, so the height is the real
       one) and behaves exactly as requestAnimationFrame when the page can
       draw. The handles are still stored, so the existing teardown that
       cancels them keeps working unchanged. */
    firstPinFrame = onNextFrame(() => {
      settledPinFrame = onNextFrame(pinToBottom)
    })
  }
  const onFontsLoaded = () => pinAfterMount()
  document.fonts?.addEventListener?.('loadingdone', onFontsLoaded)
  document.fonts?.ready?.then(pinAfterMount)
  pinAfterMount()

  const pinGrowingReply = () => {
    followOrOffer()
  }

  const timers = new Set()
  const schedule = (fn, ms) => {
    if (disposed) return null
    let timer = null
    timer = setTimeout(() => {
      if (timers.delete(timer)) bumpChatDebug('pendingTimers', -1)
      if (!disposed) fn()
    }, ms)
    timers.add(timer)
    bumpChatDebug('pendingTimers', 1)
    return timer
  }
  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer)
      bumpChatDebug('pendingTimers', -1)
    }
    timers.clear()
  }

  const replyQueue = []
  let replying = false
  let typingEl = null
  let currentStream = null

  const replyTextFor = (prompt) => {
    const kind = COORDINATING_CHAT_ROLES.has(roleKey) ? 'coordinator' : 'lane'
    const pool = CHAT_CONTEXT_REPLIES[kind] || CHAT_REPLIES
    const template = pick(pool)
    let supplied = ''
    try {
      supplied = normalizeChatContext(typeof context === 'function'
        ? context({ title, roleKey, prompt })
        : context)
    } catch {
      // A live activity reader is an enhancement, never a send blocker.
    }
    const fallback = kind === 'coordinator'
      ? CHAT_CONTEXT_FALLBACK.coordinator
      : CHAT_CONTEXT_FALLBACK.lane
    return template
      .replaceAll('{{context}}', supplied || fallback)
      .replaceAll('{{agent}}', String(title || role.label).toLowerCase())
      .replaceAll('{{role}}', role.label.toLowerCase())
  }

  const makeTyping = () => {
    const row = document.createElement('div')
    row.className = 'chat-typing'
    row.setAttribute('role', 'status')
    row.setAttribute('aria-label', typingLabel(title))

    const name = document.createElement('span')
    name.className = 'chat-typing-name'
    name.textContent = title
    const sep = document.createElement('span')
    sep.className = 'chat-typing-sep'
    sep.setAttribute('aria-hidden', 'true')
    sep.textContent = '·'
    const dots = document.createElement('span')
    dots.className = 'chat-typing-dots'
    dots.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('i')
      dot.textContent = '·'
      dots.appendChild(dot)
    }
    row.append(name, sep, dots)
    return row
  }

  const insertAfter = (node, anchor) => {
    if (anchor?.parentNode === log) log.insertBefore(node, anchor.nextSibling)
    else log.appendChild(node)
  }

  const takeTyping = () => {
    const row = typingEl
    if (row) bumpChatDebug('typingIndicators', -1)
    typingEl = null
    return row
  }

  let pumpReplies = () => {}
  const finishReply = () => {
    if (currentStream) {
      currentStream.message.removeAttribute('aria-busy')
      currentStream = null
      bumpChatDebug('streams', -1)
    }
    replying = false
    sampleActivity = ''
    syncComposer()
    log.removeAttribute('aria-busy')
    bumpChatDebug('completedReplies', 1)
    pumpReplies()
  }

  const startReply = (item) => {
    sampleActivity = 'responding'
    syncComposer()
    const fullText = replyTextFor(item.prompt)
    const timing = liveChatTiming()
    const placement = streamLabel(timing)
    const { m, body } = makeMsg('them', '', placement.label, timing)
    m.setAttribute('aria-busy', 'true')
    rememberTiming(timing)

    const marker = takeTyping()
    if (marker?.parentNode) {
      if (placement.divided) {
        const divider = makeTimeDivider(timing)
        marker.replaceWith(divider)
        insertAfter(m, divider)
      } else marker.replaceWith(m)
    } else if (placement.divided) {
      const divider = makeTimeDivider(timing)
      insertAfter(divider, item.message)
      insertAfter(m, divider)
    } else insertAfter(m, item.message)
    pinGrowingReply()

    // Sample replies use the same rendering and update path as live replies.
    if (chatReducedMotion()) {
      setChatMessageBody(body, fullText)
      m.removeAttribute('aria-busy')
      finishReply()
      return
    }

    const words = fullText.match(/\S+\s*/g) || [fullText]
    let index = 0
    let streamedText = ''
    currentStream = { message: m, body, fullText }
    bumpChatDebug('streams', 1)

    const streamWord = () => {
      streamedText += words[index++] || ''
      setChatMessageBody(body, streamedText)
      pinGrowingReply()
      if (index >= words.length) {
        finishReply()
        return
      }
      schedule(streamWord, 30 + Math.random() * 30)
    }
    streamWord()
  }

  pumpReplies = () => {
    if (disposed || replying || !replyQueue.length) return
    replying = true
    sampleActivity = 'thinking'
    syncComposer()
    const item = replyQueue.shift()
    bumpChatDebug('queuedTurns', -1)
    typingEl = makeTyping()
    insertAfter(typingEl, item.message)
    bumpChatDebug('typingIndicators', 1)
    log.setAttribute('aria-busy', 'true')
    pinGrowingReply()
    // The old 0.9–2.1s canned delay read as latency. This shorter beat reads
    // as thought, then hands off to the word stream for the visible work.
    schedule(() => startReply(item), 560 + Math.random() * 360)
  }

  /* ONE DELIVERY PATH, AND IT IS THE IDLE ONE. Everything below the queue
     decision — the "me" bubble, the real sender with its reply/fail seams, the
     sample fallback — is the delivery, and it is written once, so two sends
     cannot drift apart.

     CORRECTED 2026-09-03. This used to say the strip's "Send now" and ⇧⏎ also
     came through here while a turn was RUNNING, "as steering ... and if the
     engine refuses them, `fail` says so". Neither half was true. The engine
     refuses an overlapping send by design and never sees one, because the
     fleet view's onSend enqueues first; so the refusal `fail` was supposed to
     carry never arrived, and the "me" bubble above claimed a send for words
     that had gone back into the queue. Both busy doors now promote inside the
     queue instead and only reach this path when nothing is running — when
     "now" is a thing the product can actually do. */
  /* `promoteIfQueued` exists for ONE caller: Send now. The interrupt itself is
     immediate (runStop calls onStop with no timer between the press and
     bridge.interrupt), but the engine can still answer the send that follows
     with AGENT_TURN_ACTIVE while the interrupted turn settles, and the view
     then puts those words in the durable queue -- at the BACK. That turns the
     person's "now" into "last", which is the opposite of what the door
     promises. The owner's rule, verbatim: "send now should interrupt
     immediately. que should wait for the end of their turn (an idle)". So a
     Send now that loses that race is moved to the FRONT of the queue: it still
     cannot overlap a turn the engine says is running -- nothing may -- but it
     is the next thing to go, not the last. */
  /* `issueAfter` SPLITS THE TWO LATENCIES THE OWNER EXPERIENCES AS ONE.
   *
   * A: his words on screen, the abandoned partial gone, nothing handed back --
   *    ours, local, and it happens on this function's first lines.
   * B: the engine accepting the new turn -- the CLI child's, and it genuinely
   *    cannot be immediate: measured at the interrupt site, a send issued +8ms
   *    after interrupt() is refused AGENT_TURN_ACTIVE and the same send is
   *    accepted at +430ms, because the engine's turn really is still running.
   *
   * So the send WAITS for `issueAfter` (the stop, resolving on the real turn
   * release) while the painting does not. He sees A; B happens behind the row
   * that already says his message went. Clearing activeTurnId to skip the wait
   * was tried before and only moved the refusal down into the provider, which
   * is the "stop that one first" bounce this exists to end. */
  const deliverTurn = (v, { promoteIfQueued = false, delivery = null, issueAfter = null, takeDelivery = false, onDeliverySettled = null, silentHold = false, onSendOutcome = null, withComposerAttachments = true } = {}) => {
    /* `delivery` MAY BE A FUNCTION, and that is what lets his words be painted
       before the durable hold is even written. The hold is a storage write; the
       paint is not, and making the paint wait for it is how "press -> words on
       screen" became 46-201ms on a loaded box. Read it at issue time instead. */
    const deliveryOf = () => (typeof delivery === 'function' ? delivery() : delivery)
    /* THE RESERVATION'S RELEASE IS TIED TO THE ACTUAL SEND RESULT (T785, M12).
       settleSend(true) fires once the words REACH the host -- accepted or
       queued, after which the host clears personWaitingSince on land and
       restamps its generation on a refusal -- and settleSend(false) on every
       terminal where they do NOT go: a refused/parked stop, a vanished row, a
       definitive fail or a throw. A retryable silent hold does NOT settle, so
       the reservation is preserved while the delivery is still pending. Fired
       at most once; the caller releases only on the false outcome. */
    let sendOutcomeFired = false
    let awaitingSendOutcome = false
    let retryTimer = null
    const settleSend = reachedHost => {
      if (sendOutcomeFired) return
      sendOutcomeFired = true
      pendingSendCancellations.delete(cancelPendingSend)
      if (ride) pendingRides.delete(ride)
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
      onSendOutcome?.(reachedHost)
    }
    /* A Send now carrying pictures, still waiting for its stop. If the chat is
       handed off while it waits (exportDraft({ handoff: true }), then
       teardown), the words and pictures go back to the draft together and the
       queued row is removed, so the words never go later without the pictures
       (T1419). */
    let ride = null
    const cancelPendingSend = () => {
      // An invoked sender with no disposition still owns an unknown delivery.
      // Teardown must not make that envelope retryable or issue it again.
      if (sendOutcomeFired || awaitingSendOutcome) return
      settleSend(false)
      // Handed back to the draft: the durable row leaves the queue (confirm()
      // removes the held row), since its words now wait in the next box.
      if (ride?.handedOff && typeof deliveryOf()?.confirm === 'function') deliveryOf().confirm()
      else deliveryOf()?.restore?.({ unconfirmed: false })
      onDeliverySettled?.()
    }
    if (typeof onSendOutcome === 'function') pendingSendCancellations.add(cancelPendingSend)
    if (disposed || cannotSend) {
      /* A delivery this function owns is settled even when it does nothing:
         the caller's `finally` deliberately leaves the hold to this function,
         so returning bare here left a reservation nobody would ever release
         and the next Send now refused by it. The words stay queued, plain. */
      if (takeDelivery) { deliveryOf()?.restore?.({ unconfirmed: false }); onDeliverySettled?.() }
      settleSend(false)
      return
    }
    pinned = true
    const queuedIdsBefore = promoteIfQueued && queue && typeof queue.list === 'function' && typeof queue.sendNow === 'function'
      ? new Set((() => { try { return (queue.list() || []).map(entry => entry && entry.id) } catch { return [] } })())
      : null
    /* A queued row's words are not the message box's draft: the box's
       pictures stay in the box for the message they belong to (T1426). */
    const ridingAttachments = withComposerAttachments ? pendingAttachments : []
    if (withComposerAttachments) setComposerAttachments([])
    if (issueAfter && takeDelivery && ridingAttachments.length && typeof onSendOutcome === 'function') {
      ride = { text: v, attachments: ridingAttachments, handedOff: false, waiting: () => !sendOutcomeFired && !awaitingSendOutcome }
      pendingRides.add(ride)
    }
    if (withComposerAttachments && attachStrip && !attachStrip.hidden) {
      /* The pending attachment rides THIS send (the handler that issued it
         holds it); the strip's promise is kept, so it empties here. */
      attachStrip.hidden = true
      attachStrip.replaceChildren()
    }
    const labelledBeforeSend = lastLabelled
    /* Read ONCE, before the paint, because the same list is owed to two
       places now: the bubble drawn here and the caller that stores the entry. */
    const sentPictures = picturesRiding(ridingAttachments)
    /* References for the caller that stores the entry; bytes only for the paint
       below. Handing the bytes out is what the boundary rule above forbids. */
    const sentPictureRefs = pictureRefsRiding(ridingAttachments)
    const message = addOwnerMessage(v, { pictures: sentPictures, attachmentCount: ridingAttachments.length })

    /* THE OPTIMISTIC BUBBLE IS ONLY TRUE AFTER THE HOST ACCEPTS THE TURN.
       Page 2 can observe an idle node a few milliseconds before the host
       finishes its previous turn. In that window the direct send is refused
       with AGENT_TURN_ACTIVE and the view moves the words into its durable
       queue. Keeping this bubble would say the message had already reached
       the agent while the queue strip correctly said it was still waiting.

       The same rollback restores attachments. The outbox currently carries
       text only, so a refused send must leave a picked file in the composer's
       hands rather than silently detach it from the message. */
    let optimisticRetracted = false
    const retractOptimistic = () => {
      if (optimisticRetracted) return
      optimisticRetracted = true
      const wasTail = log.lastElementChild === message
      message.remove()
      if (wasTail) lastLabelled = labelledBeforeSend
      if (ridingAttachments.length) {
        const present = new Set(pendingAttachments.map(item => attachmentIdentity(item.path)))
        const restored = ridingAttachments.filter(item => !present.has(attachmentIdentity(item.path)))
        setComposerAttachments([...restored, ...pendingAttachments])
        paintAttachments()
      }
    }

    // A REAL SENDER REPLACES THE SIMULATION ENTIRELY.
    //
    // Without `onSend` this composer answers itself: it pushes the turn onto
    // replyQueue and a canned reply streams back. That is right for the sample
    // surfaces that exist to show what the product looks like, and wrong on the
    // agent page, where the same widget made a person believe they had started
    // work. The page's own note admitted it -- "typing in it still reaches
    // nothing" -- which is honest about the wiring and no help at all to
    // somebody trying to start an agent.
    //
    // So a caller that CAN reach a real agent passes onSend, and the fake path
    // is not merely bypassed but unreachable: no queue push, no canned reply, no
    // simulated latency. Anything else would leave two sources of truth about
    // whether a turn was real.
    //
    // onSend owns the reply. It gets `reply` to append the agent's words and
    // `fail` to say why nothing happened -- a sender that throws silently would
    // reproduce the original defect in a new place.
    if (typeof onSend === 'function') {
      bumpChatDebug('sentTurns', 1)
      /* A REJECTED `issueAfter` STILL SENDS. It is a stop that reported a
         problem, not a decision about his message; refusing to deliver here
         would hand his words back for a reason he never asked about.
         An ORDINARY send keeps its original timing exactly -- one microtask,
         no extra hop: composer-send-failure-code reads the refusal note after
         a fixed number of ticks, and an unconditional `.catch()` link pushed
         the note one tick past it. The wait exists only when something is
         actually being waited for. */
      /* HOLD SILENTLY AND LAND -- the rule that keeps a refusal off his glass.
       *
       * THE PATH THIS EXISTS FOR: waitForTurnRelease RESOLVES ON TIMEOUT ("on
       * timeout this behaves exactly as it did before the wait existed"), so a
       * silent engine lets the gate open while its turn is genuinely still
       * running. The send then meets AGENT_TURN_ACTIVE. Before this, that put
       * "this session is already working on a turn; stop that one first" in
       * front of the person who had just pressed the thing that stops it.
       *
       * TWO SHAPES, DELIBERATELY HANDLED DIFFERENTLY, because only one of them
       * can be retried without duplicating his words:
       *   - words alone: the view has ALREADY put them in the durable queue by
       *     the time it calls queued(), so retrying here would send them twice.
       *     The words are held where they are and the note is suppressed; the
       *     drain lands them at the next boundary.
       *   - words WITH a file: that branch queues nothing (the outbox carries
       *     text only) and hands both back with a note. Nothing was stored, so
       *     re-issuing is safe, and it is the only way the file still rides the
       *     message he pressed Send now on.
       * BOUNDED, and it gives up out loud: after the last delay the ordinary
       * refusal path runs, note and all. A silent hold that never lands would
       * be a worse defect than the one being fixed. */
      const TURN_ACTIVE_CODES = new Set(['AGENT_TURN_ACTIVE', 'CLAUDE_CLI_TURN_ACTIVE', 'AGENT_SESSION_NOT_READY'])
      const HOLD_RETRY_DELAYS = [120, 250, 500, 1000]
      let holdAttempt = 0
      const retryQuietly = () => {
        if (disposed || holdAttempt >= HOLD_RETRY_DELAYS.length) return false
        const wait = HOLD_RETRY_DELAYS[holdAttempt]
        holdAttempt += 1
        awaitingSendOutcome = false
        retryTimer = setTimeout(() => {
          retryTimer = null
          const entryId = deliveryOf()?.entry?.id
          let stillQueued = true
          if (entryId && typeof queue?.list === 'function') {
            try { stillQueued = (queue.list() || []).some(entry => entry.id === entryId) }
            catch { stillQueued = false }
          }
          if (disposed || !stillQueued) { cancelPendingSend(); return }
          void Promise.resolve().then(issueSend).catch(sendFailed)
        }, wait)
        return true
      }
      const issueSend = () => {
        if (disposed) { cancelPendingSend(); return null }
        awaitingSendOutcome = true
        return onSend(v, {
          // A definitively rejected Send now can return its original durable
          // row to recovery. The sender must never copy these words into a
          // second queue entry or treat a cancelled hold as a fresh message.
          ...(deliveryOf() ? { keepQueued: () => deliveryOf()?.restore?.({ unconfirmed: false }) === true
            ? deliveryOf()?.entry?.id || null : null } : {}),
          /* Present only when something really rides this send. Callers that
             do not use attachments do not receive a placeholder value. */
          ...(ridingAttachments.length ? { attachments: ridingAttachments.slice() } : {}),
          /* THE PICTURES THEMSELVES, HANDED TO WHOEVER STORES THE MESSAGE
             (T332). This is the one moment in the product where a pasted
             picture's bytes are in the window's hands, and until now they never
             left this module -- so every caller stored an owner entry with no
             picture on it, and every later repaint drew a message that had lost
             its image. Present only when a picture really rides this send. */
          ...(sentPictureRefs.length ? { pictures: sentPictureRefs } : {}),
          /* THE AGENT'S ANSWER PAINTS AS THE AGENT, and until now it painted
             as its ROLE KEY -- `class="msg helper"`, for which no rule exists
             in any stylesheet. Measured on a staged packaged build: background
             rgba(0,0,0,0), border 0px, no shadow, align-self auto (the full
             width of the log, on neither side) and no sender label, directly
             beneath a restored `msg them` bubble carrying all of it. One
             conversation, the same agent, painted two ways.
             A refusal is NOT the agent speaking, so it keeps a kind of its own
             rather than being dressed as words the agent said. */
          accepted: receipt => {
            /* THE HOLD'S OWN confirm() IS THE ONE THAT CLEARS THE ROW: it runs
               cancel(session, entry.id), which removes both the row and the
               hold. take() is what set deliveryUnconfirmed in the first place.
               A confirmDelivered(sessionId, entry) call was added here and
               REMOVED again on Controller's ruling: its body is
               resolveDeliveryTarget + releaseSeat, and a Send-now entry was
               never takeNext-ed, so it has no seat to release -- at best a
               no-op, at worst it releases a DIFFERENT delivery's seat. */
            deliveryOf()?.confirm?.()
            settleSend(true)
            if (!optimisticRetracted) confirmOwnerMessage(message, receipt)
          },
          reply: text => { if (!disposed) addMsg('them', String(text)) },
          // Progress information changes only the display. Unlike accepted,
          // queued and fail, it cannot settle a delivery hold or move a queue.
          note: (text, { retract = false, code = null } = {}) => {
            if (disposed) return
            if (retract) retractOptimistic()
            if (text) markRefusalCode(addMsg('note', String(text)), { code })
            syncComposer()
          },
          /* A send that became queued is not a failure and not agent speech.
             Retract the optimistic YOU bubble; the accepted queued turn is
             painted later through addOwnerMessage, at the actual wire edge. */
          queued: text => {
            deliveryOf()?.confirm?.()
            settleSend(true)
            if (disposed) return
            retractOptimistic()
            /* Under a silent hold the words are in the queue and the strip
               already shows them; saying "this message is next" as well is the
               sentence he reads as "it did not go". */
            if (text && !silentHold) addMsg('note', String(text))
            /* The row the view just wrote is the one id that was not there
               before this send. Identified by difference, never by matching
               the text: two identical messages are a thing a person really
               does, and promoting the wrong one of them would be silent. */
            if (queuedIdsBefore) {
              let landed = null
              try { landed = (queue.list() || []).find(entry => entry && !queuedIdsBefore.has(entry.id)) || null } catch { landed = null }
              if (landed && landed.id) { try { queue.sendNow(landed.id) } catch { /* it stays where it is, visibly */ } }
            }
            syncComposer()
          },
          fail: (text, { retract = false, unconfirmed = true, code = null, restoreDraft = false } = {}) => {
            /* The retryable shape: the turn was still running, nothing was
               stored, and the file (if any) is still in this delivery's hands.
               Nothing is painted and nothing is handed back -- the optimistic
               row stays exactly as it is while the next attempt goes out. */
            // A busy code can also accompany a lost reply after dispatch.
            // Only an explicit not-sent outcome authorizes another attempt.
            if (silentHold && unconfirmed === false && !disposed
              && (TURN_ACTIVE_CODES.has(String(code || '')) || String(text || '') === QUEUE_PANEL.busyAttachment)
              && retryQuietly()) return
            /* Retain the sender's known-refusal or unknown-delivery custody. */
            settleSend(false)
            const retained = deliveryOf()?.restore?.({ unconfirmed }) === true
            if (disposed) return
            if (retained || restoreDraft) {
              retractOptimistic()
              if (!retained && !input.value.trim()) setComposerText(v)
              syncComposer()
            }
            /* Most refusals historically keep the attempted words visible
               beside their product note. The boundary-race attachment case
               opts into rollback because its file remains in the composer
               and the turn was explicitly not sent. */
            if (retract) retractOptimistic()
            const note = addMsg('note', String(text))
            if (code && note) note.dataset.refusalCode = code
          }
        })
      }
      const sendFailed = error => {
        deliveryOf()?.restore?.({ unconfirmed: true })
        settleSend(false)
        if (!disposed) markRefusalCode(addMsg('note', SEND_FAILED), { code: refusalCodeFromThrown(error) })
      }
      ;(issueAfter ? Promise.resolve(issueAfter).catch(() => null) : Promise.resolve(true))
        .then(released => {
          if (disposed) { cancelPendingSend(); return null }
          /* A STOP THAT WAS REFUSED IS NOT A SEND WINDOW. The interrupt did not
             happen, so the turn is still running and a send now would bounce --
             which is the refusal this whole change exists to keep off his
             glass. The words stay exactly where the hold put them, visible in
             the queue strip, and go when the turn ends. Pinned by
             chat-queue-doors "a refused interrupt does not consume or send the
             committed message". */
          if (released === false) {
            retractOptimistic()
            deliveryOf()?.restore?.({ unconfirmed: false })
            onDeliverySettled?.()
            settleSend(false)
            syncComposer()
            return null
          }
          /* THE STOP WAS ACCEPTED AND IDLE NEVER CAME, inside the release
             budget. Not a refusal (nothing is said), not a stall (the hold and
             the doors are released), not a send (the turn may still be
             running, and a send into it is the bounce this design forbids).
             The row leaves the log and stands in the strip under its NAMED
             hold with Retry send and Unqueue; it still goes on its own at the
             next turn boundary. */
          if (released && released.held === true) {
            retractOptimistic()
            parkSendNow(deliveryOf(), released)
            onDeliverySettled?.()
            settleSend(false)
            syncComposer()
            return null
          }
          /* The durable row is consumed HERE, not at the press: a hold taken
             before the stop resolved would be gone on the refused path above. */
          const held = deliveryOf()
          if (takeDelivery && held && typeof held.take === 'function') {
            let ready = null
            try { ready = held.take() } catch { ready = null }
            onDeliverySettled?.()
            if (!ready) {
              retractOptimistic()
              addMsg('note', QUEUE_PANEL.moveGone)
              settleSend(false)
              syncComposer()
              return null
            }
          }
          return issueSend()
        })
        .catch(error => {
          deliveryOf()?.restore?.({ unconfirmed: true })
          settleSend(false)
          if (disposed) return
          /* THE ERROR'S MESSAGE IS NOT SHOWN, and that is not caution -- on this
             product's agent channel the message IS the machine code
             (shell/main.cjs replaces a rejected call's error with one whose
             message is its identifier, so that nothing path-bearing crosses).
             Printing it here put a bare identifier in front of a person, which
             is the one thing src/refusal-copy.js exists to prevent, by the one
             route its scan cannot see. A sender that means to explain a refusal
             says so through `fail`, where the sentence is written. */
          /* THE SENTENCE IS UNCHANGED; THE IDENTIFIER IS NOT THROWN AWAY.
             `fail` above records the code on its note and this door did not, so a
             send that failed here left nothing for a support conversation or a probe
             to name it by. refusalCodeOf accepts a value only when it is shaped like
             one of this product's identifiers, and markRefusalCode writes it to
             data-refusal-code -- where a person does not read it -- or removes the
             attribute entirely when there is no code, rather than leaving an empty
             one that would read as "there is a code and it is blank". */
          markRefusalCode(addMsg('note', SEND_FAILED), { code: refusalCodeFromThrown(error) })
        })
      return
    }

    replyQueue.push({ prompt: v, message })
    bumpChatDebug('queuedTurns', 1)
    pumpReplies()
  }

  /* A QUEUED MESSAGE IN THE BOX IS AN EDIT, NEVER A SECOND COPY.
     While the up-arrow walk holds a waiting message, the words in the composer
     are ALREADY in the queue and will send by themselves. Pushing them through
     the ordinary send would queue the same message twice, or steer the running
     turn with words that then send AGAIN when it ends. So a send press keeps
     the edit where it waits and hands the person's own draft back.
     True when it took the press. Named, and read by BOTH doors -- the send
     button reaches send() directly while ⏎/⇧⏎ come through the key handler,
     and a rule that held for one and not the other is exactly the half-rule
     this composer has been bitten by before. */
  const keepsRecalledEdit = () => applyRecall(recall.submit(input.value))

  let imageAdmission = null
  let imageIntent = null
  const submitImageIntent = async sendNow => {
    if (imageAdmission || typeof onImageIntent !== 'function') return
    if (draftAuthorityRefusal) { markRefusalCode(addMsg('note', 'Images remain attached. Reattach them to the current draft before sending.'), { code: draftAuthorityRefusal }); return }
    const text = input.value
    const attachments = pendingAttachments.slice()
    const hasHostDraft = attachments.some(item => item?.kind === 'host-draft-image')
    const hostDraft = hasHostDraft ? hostDraftForAttachments(attachments) : null
    if (hasHostDraft && !hostDraft) { markRefusalCode(addMsg('note', 'Images remain attached. Reattach them to the current draft before sending.'), { code: 'IMAGE_CUSTODY_SCOPE' }); return }
    observeComposerText()
    const revision = composerRevision
    const portableDraft = { draftId, revision: draftRevision, ...(retainedDraft ? { retainedDraft } : {}) }
    const fingerprint = JSON.stringify([text, attachments])
    if (!imageIntent || imageIntent.revision !== revision || imageIntent.fingerprint !== fingerprint) {
      imageIntent = { revision, fingerprint, operationId: crypto.randomUUID() }
    }
    const operationId = imageIntent.operationId
    let message = null
    let latest = null
    let durableAdmission = null
    const paint = state => {
      latest = state
      if (disposed || !message || state.detached) return
      message.dataset.deliveryState = state.state
      if (state.state === 'accepted') confirmOwnerMessage(message, state.providerReceipt)
      addMsg('note', imageDeliveryNotice(state))
    }
    imageAdmission = Promise.resolve().then(() => onImageIntent({
      operationId, text, images: hostDraft ? [] : attachments, sendNow, ...portableDraft,
      ...(hostDraft ? { hostDraft } : {}),
    }, paint))
    try {
      const result = await imageAdmission
      if (disposed || result?.detached || result?.isCurrent?.() === false) return
      if (!result?.ok) {
        const refusal = imageMessageActionFailureCopy(result, 'retry')
        addMsg('note', ['Images remain attached.', refusal].filter(Boolean).join(' '))
        return
      }
      durableAdmission = result
      message = addOwnerMessage(text, { pictures: picturesRiding(attachments), attachmentCount: attachments.length })
      message.dataset.deliveryState = 'queued'
      const imageSummary = document.createElement('span')
      imageSummary.className = 'chat-image-intent-summary'
      imageSummary.textContent = attachments.length + ' image(s): ' + composerAttachmentLabels(attachments).join(', ')
      message.appendChild(imageSummary)
      addMsg('note', result.state === 'held' ? 'Images saved but held: ' + result.code
        : 'Queued with ' + attachments.length + ' image(s).')
      observeComposerText()
      if (!disposed && result.isCurrent?.() !== false && composerRevision === revision
        && JSON.stringify([input.value, pendingAttachments]) === fingerprint) {
        setComposerText('')
        setComposerAttachments([])
        retainedDraft = null
        paintAttachments()
        syncComposer()
      }
      if (latest) paint(latest)
      if (imageIntent?.operationId === operationId) imageIntent = null
    } catch (error) {
      if (!disposed) {
        try { addMsg('note', durableAdmission
          ? 'Images were saved. Their display could not update; do not submit them again.'
          : 'Images remain attached: ' + (error?.code || 'admission unconfirmed')) } catch { /* Durable admission is retained independently of rendering. */ }
      }
    } finally { imageAdmission = null }
  }

  const send = () => {
    if (disposed) return
    /* THE FIRST LINE, so that no later branch can be reached by a caller that
       said it cannot send. Without it a disabled input is only a suggestion:
       Enter on a disabled field does nothing today, but the seeded simulator
       is one refactor away from being reachable again, and the whole point of
       composerReason is that this chat can never answer itself. */
    if (cannotSend) return
    if (stopping) return
    if (keepsRecalledEdit()) return
    const v = input.value
    /* Empty input while the agent writes: this press IS the stop button —
       the same physical button, wearing its stop face. */
    if (!v.trim() && pendingAttachments.length === 0) {
      if (isBusy() && typeof onStop === 'function') void runStop()
      return
    }
    /* Typed words while the agent writes: they QUEUE, visibly. No "me"
       bubble — the strip above the composer is the preview, and a bubble
       here would claim the words already reached the agent. A caller
       without a queue (the sample surfaces, the agent page) keeps its
       old behavior below. ⇧⏎ and the strip's own promote button are the
       doors past this branch, chosen on purpose per press: they do not skip
       the queue — nothing can, while a turn holds the session — they move
       the words to the FRONT of it, so the deliberate act is "this one
       first" rather than "this one instead". */
    if (pendingAttachments.some(item => item?.kind === 'host-draft-image') && typeof onImageIntent !== 'function') { markRefusalCode(addMsg('note', 'Images remain attached. Open a complete ToolsEnabled build to send them.'), { code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' }); return }
    if (pendingAttachments.length && typeof onImageIntent === 'function') { void submitImageIntent(false); return }
    if ((isBusy() || queueRequired()) && queue) {
      /* A FILE CANNOT RIDE THE DURABLE QUEUE, SO THE COMBINATION IS REFUSED
         RATHER THAN HALF-SENT (T361).
       *
       * Measured on the + surface: paste a picture while the agent is busy,
       * type, press Send. The words queued and went; the picture did not; the
       * drained send carried no images at all; and NOTHING was said, at any
       * step. The attachment chip stayed in the composer the whole time, so the
       * screen showed a picture still attached to a message that had already
       * gone without it. Silent in both directions -- the agent answers about a
       * picture it was never given, and the person believes they sent one.
       *
       * The outbox carries TEXT ONLY, by design; making it carry attachments is
       * a separate data-layer change and is deliberately not attempted here. So
       * this refuses the COMBINATION, not the queue: queueing text, Send next,
       * Unqueue, order and the drain all still work exactly as before. Only a
       * send that would silently shed its file is stopped.
       *
       * The sentence already existed and nothing called it. Somebody wrote
       * QUEUE_PANEL.busyAttachment for precisely this situation -- "The file is
       * still attached; send again when this turn finishes" -- and no path
       * reached it. The words and the file both stay in the composer, so the
       * person loses nothing and the instruction is one they can act on.
       *
       * ONE PLACE, BOTH SURFACES. This is buildChat's own send, so the tree
       * conversation and the + chat are covered by the same lines; the silent
       * loss was reachable on the tree surface long before the + surface had a
       * queue at all. */
      if (pendingAttachments.length) { addMsg('note', QUEUE_PANEL.busyAttachment); return }
      let queued = null
      let thrown = null
      try { queued = queue.add(v) } catch (error) { queued = null; thrown = error }
      if (queued && queued.ok) {
        setComposerText('')
        syncComposer()
      } else {
        markRefusalCode(addMsg('note', (queued && queued.sentence) || QUEUE_FAILED), { code: refusalCodeFromThrown(thrown) })
      }
      return
    }
    if (queueRequired()) { addMsg('note', 'The session is not ready. Your message remains here.'); return }
    setComposerText('')
    deliverTurn(v)
  }

  const sendNowFromInput = async () => {
    if (disposed || cannotSend) return
    /* THE SAME LINE send() CARRIES, for the same box. ⇧⏎ was the one send door
       in this composer with no `stopping` check, so while a halt was in flight
       ⏎ answered "not now" and ⇧⏎ queued and promoted a message -- one box
       giving two different answers to two spellings of the same key, which is
       precisely the trap the ⇧⏎ door's own note (onInputKeydown) says a chord
       must never be. */
    if (stopping) return
    if (keepsRecalledEdit()) return
    const v = input.value
    if (!v.trim() && pendingAttachments.length === 0) return
    if (queueRequired() && !isBusy()) { send(); return }
    if (pendingAttachments.some(item => item?.kind === 'host-draft-image') && typeof onImageIntent !== 'function') { markRefusalCode(addMsg('note', 'Images remain attached. Open a complete ToolsEnabled build to send them.'), { code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' }); return }
    if (pendingAttachments.length && typeof onImageIntent === 'function') { await submitImageIntent(true); return }
    /* ⇧⏎ AND THE CHIP UNDER THE ARROW ARE "SEND NOW", AND SEND NOW INTERRUPTS.
       The owner, W18c: "The arrow should send, the button below should be for
       send now. Send should be the default send now should be sahift enter",
       on top of R17: "the user needs to be able to send a send now that
       actually interrrupts the agent".

       WHAT THIS USED TO DO, and why that is no longer the right answer. It
       queued the words and promoted them to the FRONT (queue.add then
       queue.sendNow) -- "next", not "now". That was honest while nothing in
       the product could stop a turn, but W18b built the door that can
       (`.chat-queue-now` in paintQueueStrip), so a chord named "now" that
       quietly means "next" is now a trap rather than the best available act.
       Send next still exists, on the queued row, where a person can see the
       row they are moving.

       THE ORDER IS THE STRIP'S ORDER, deliberately identical, because this is
       the same act from a different surface: hold the committed words in the
       queue, clear the box so a second press cannot send them twice, then
       halt through runStop() -- the
       SAME function the HALT chip and the morphing face already call, never a
       second stop implementation, and it refuses to run twice on its own first
       line -- and only then deliver. With a durable hold, runStop waits for
       the completion-driven idle status as well as the interrupt acceptance.
       Idle, there is nothing to stop and this is exactly an ordinary send. */
    let stopFirst = isBusy() && typeof onStop === 'function'
    let held = null
    if (stopFirst && typeof queue?.hold === 'function') {
      /* THE FILE RIDES THE SEND. IT DOES NOT BLOCK IT.
       *
       * This door used to refuse outright whenever a file was attached:
       * `if (pendingAttachments.length) { addMsg('note', QUEUE_PANEL.heldAttachment); return }`.
       * That note says "Send this message when the current turn finishes",
       * which made Send now mean "wait for the turn to end" for exactly the
       * messages a person is most likely to press it for -- the reported T335
       * symptom, and here it was an explicit early return rather than a
       * downstream link failing. Nothing was interrupted and nothing was sent.
       *
       * The premise was true but the conclusion did not follow. The durable
       * outbox really does carry text only -- holdForSend() in
       * src/session-outbox.js takes `{ entryId, text }` and stores an entry
       * with a `text` field and no other payload -- but the attachment never
       * needed to travel through it. The hold is a crash-safety reservation
       * for the WORDS; the file stays where it already is, in this composer's
       * own `pendingAttachments`, and deliverTurn picks it up from there on
       * its first line (`const ridingAttachments = pendingAttachments`). So
       * the message is delivered whole by the path that was already carrying
       * files for every ordinary send.
       *
       * `pendingAttachments` is deliberately NOT cleared before the await
       * below, the way `input.value` is: deliverTurn is what takes and clears
       * it, and it is also what hands the file back to the composer if the
       * send is refused (retractOptimistic). Clearing it early would drop the
       * file on exactly the refusal path that exists to preserve it.
       *
       * WHAT IS GIVEN UP, deliberately: if the app dies between the hold and
       * the delivery, the recovered durable row carries the words without the
       * file. That is a strictly smaller loss than refusing to send at all,
       * which is what happened before. The outbox carrying attachments is
       * T344, a post-cut data-layer change, and is not attempted here. */
      held = holdSendNow({ text: v })
      if (!held) return
      if (held.direct) { held = null; stopFirst = false }
    }
    setComposerText('')
    // Declared out here because the `finally` below reads it.
    let deliveryOwnsHold = false
    let reservationToken = null
    let reservationReleased = false
    /* deliverTurn owns the release, keyed on the real send outcome; this fires
       it once, only when the words did not reach the host. */
    const releaseReservation = () => {
      if (reservationToken != null && !reservationReleased) { reservationReleased = true; onReleaseHold?.(reservationToken) }
    }
    try {
      /* THE PRESS'S OWN FRAME, IN ORDER, AND NOTHING ASYNCHRONOUS IN IT.
       *
       * 1. the abandoned answer leaves the screen
       * 2. his words are painted as sent
       * 3. only then is the stop started, and only after IT resolves does the
       *    engine send go out.
       *
       * The order is the point. runStop() also abandons -- the Halt chip needs
       * it -- but calling it first would put runStop's own syncComposer() and
       * the interrupt IPC dispatch ahead of the paint, which is how "press ->
       * words on screen" measured 46-201ms on a loaded box. Nothing between the
       * press and the paint now touches storage, the host, or a full repaint. */
      abandonLiveStreams()
      if (disposed) return
      /* The hold is NOT taken here any more. deliverTurn takes it at the moment
         it actually issues the send, so a refused stop leaves the durable row
         whole instead of consuming words that were never sent. */
      /* THE HOLD IS THE DELIVERY'S NOW. Releasing it in the `finally` below
         would beat deliverTurn's own take() by a microtask -- the await here
         resolves one tick before the gate's `.then` -- and the send would find
         nothing left to take. deliverTurn settles the durable row on every one
         of its paths (take, refused stop, accepted, failed) and reports back
         through onDeliverySettled so a second Send now is not refused forever
         by a reservation nobody holds. Teardown still releases it: this leaves
         `pendingSendNow` set until the delivery really settles. */
      deliveryOwnsHold = Boolean(held)
      /* The gate the engine send waits on. It is resolved with the stop's own
         answer below: `false` means the interrupt was refused, and deliverTurn
         then leaves the words in the queue rather than sending into a turn
         that is demonstrably still running. */
      /* SEND NOW RESERVES THE PERSON-WAITING BOUNDARY BEFORE THE INTERRUPT
         (T785, composer path). Only for a held Send now that will interrupt --
         a generic Halt has no `held` and reserves nothing. `delivered` starts
         true when no interrupt is needed and is set from the stop's own answer
         below; the reservation is released in the finally on every NON-delivery
         outcome, and left for the host to clear on land / restamp on refusal
         when the words go. */
      reservationToken = (stopFirst && held && typeof onReserveHold === 'function')
        ? await onReserveHold() : null
      if (disposed) { releaseReservation(); deliveryOwnsHold = false; return }
      let openGate = null
      const gate = stopFirst ? new Promise(resolve => { openGate = resolve }) : null
      /* deliverTurn owns the reservation from here: onSendOutcome releases it
         ONLY when the words do not reach the host (a refused/parked stop, a
         definitive fail, a throw) and keeps it while delivery is pending --
         never merely because the stop was accepted. The host clears
         personWaitingSince on land and restamps its generation on a refusal. */
      /* The words are painted before the stop starts (above), so the stop's
         own note is seated above them: read top to bottom, the running turn
         was interrupted and then this message went, as the queued row's Send
         now already reads. Appended below, the new message read as the one
         that was interrupted (T1406). */
      const shownBefore = new Set(log.children)
      deliverTurn(v, {
        promoteIfQueued: true,
        delivery: held,
        issueAfter: gate,
        takeDelivery: Boolean(held),
        onDeliverySettled: () => { if (pendingSendNow === held) pendingSendNow = null },
        onSendOutcome: reachedHost => { if (!reachedHost) releaseReservation() },
        silentHold: true,
      })
      if (stopFirst) {
        syncComposer()
        let stopped = false
        /* The gate MUST resolve on every path so deliverTurn's outcome always
           fires; a stop that somehow threw would otherwise strand the
           reservation. runStop already catches its own throws, so this is a
           belt-and-braces guarantee. */
        const painted = [...log.children].find(node => !shownBefore.has(node) && node.classList?.contains('me')) || null
        try { stopped = await runStop({ waitForIdle: Boolean(held), noteBefore: painted }) }
        finally { openGate?.(stopped) }
      }
    } finally {
      if (!deliveryOwnsHold) releaseSendNow(held)
      syncComposer()
    }
  }

  const onInputKeydown = (e) => {
    // Candidate selection and confirmation belong to the input method.
    // Its final key can arrive after compositionend with only keyCode 229.
    if (e.isComposing || e.keyCode === 229) return
    /* Slash is a door only from a genuinely empty composer. It opens the same
       palette as the toolbar button; it does not create a second command UI,
       and a slash typed after whitespace or words remains ordinary text. */
    if (e.key === '/' && input.value === '' && typeof actions === 'function') {
      e.preventDefault()
      /* The slash the person typed lands in the palette's filter, so what they
         go on typing -- "Request keep it short" -- reads back as the command
         line they meant, and Enter runs it (see the typed-command row in
         renderPopStage). Before this the slash was swallowed and a typed
         /Request had no way in from an empty box. */
      openActions(null, { prefill: '/' })
      return
    }
    /* ⇧⇥ (Shift+Tab), COMPOSER-FOCUSED ONLY -- a listener on the input
       itself, never a global/document handler, so it can never fire while
       focus is anywhere else on the page. Cycles the AGENT chip's tier. No
       chips.onCycleTier means this falls through UNTOUCHED (no
       preventDefault), so the browser's native Shift+Tab focus-reverse
       keeps working -- a control that does nothing must not also swallow
       the key that would otherwise move focus backward. */
    if (e.key === 'Tab' && e.shiftKey && chips && typeof chips.onCycleTier === 'function') {
      e.preventDefault()
      chips.onCycleTier()
      return
    }
    /* ↑ ↓ ESC — THE QUEUED-MESSAGE WALK (owner: "i like how in cmd you can
       press the up button and edit your qued messages ... let userrs press up
       from the chat to get to their qued messages and edit them").
       Composer-focused, on this input's own keydown, never on document or
       window: the same discipline the slash door and ⇧⏎ keep, so these keys
       can never fire while a person is reading a different agent's transcript.
       preventDefault ONLY when the walk says it handled the key -- with no
       queue, an empty queue, or words already typed, every answer is
       unhandled and the browser's native caret move and Escape are left
       exactly as they would be with nothing bound here at all. */
    if (e.key === 'ArrowUp') { if (applyRecall(recall.up(input.value))) e.preventDefault(); return }
    if (e.key === 'ArrowDown') { if (applyRecall(recall.down(input.value))) e.preventDefault(); return }
    /* ONE LAYER PER PRESS, the rule the actions popup's own Escape already
       keeps (onPopKeydown, further down this file, after a measured
       press-through closed the popup AND the sheet behind it in one key).
       An Escape that ended a walk must not ALSO close the card or the sheet
       the composer sits in; the next Escape reaches that layer. Nothing is
       stopped when the walk declined the key, so a composer with no walk up
       leaves Escape exactly where it was. */
    if (e.key === 'Escape') {
      if (applyRecall(recall.escape(input.value))) { e.preventDefault(); e.stopPropagation() }
      return
    }
    if (e.key !== 'Enter') return
    // One held key is one gesture, even after Send clears the box to Stop.
    if (e.repeat) { e.preventDefault(); return }
    /* AHEAD OF THE ⇧⏎ DOOR ON PURPOSE: that door delivers the box into the
       RUNNING turn, and while the walk is up those words are already waiting
       in the queue -- it would send them once now and once again when the turn
       ends. send() carries the same check for the button; this line is what
       puts ⇧⏎ under it too. */
    if (keepsRecalledEdit()) return
    /* ⏎ IS SEND, ⇧⏎ IS SEND NOW -- the owner's own division, W18c: "Send
       should be the default send now should be sahift enter". ⏎ keeps
       send()'s behaviour exactly, including queueing when the agent is busy,
       which is what the arrow does and what the owner means by the arrow
       sending. ⇧⏎ is the interrupting send, the same act as the one chip
       under the arrow, through the same function.

       NO NEWLINE IS BEING TAKEN AWAY, measured rather than assumed: this
       composer is `<input type="text">` (see the template above), a
       single-line control, so neither ⏎ nor ⇧⏎ has ever inserted a newline
       here. There is no newline key to relocate.

       The chord is now meaningful whether or not a turn is running, and it
       does not need a queue to exist: idle, "send now" and "send" are the
       same act, and sendNowFromInput takes that branch itself rather than
       falling through to a different function. */
    if (e.shiftKey) { void sendNowFromInput(); return }
    send()
  }
  const onCloseClick = (e) => {
    e.stopPropagation()
    dispose()
    onClose()
  }

  /* This ONE element changes from Send to Stop as the first click clears the
     box. The second click of the same double-click must not execute that new
     meaning: otherwise one gesture queues the words and immediately halts the
     reply they were meant to follow. A later deliberate click has detail 1
     again and reaches the visible Stop face normally. */
  sendButton.addEventListener('click', event => {
    if (Number(event?.detail) > 1 && !input.value.trim() && pendingAttachments.length === 0) return
    send()
  })
  input.addEventListener('keydown', onInputKeydown)
  if (onClose) root.querySelector('.chat-close').addEventListener('click', onCloseClick)
  /* The expand control belongs to whoever owns the geometry -- the tree
     placer, not this component. buildChat only renders the button and
     forwards the press; the caller flips the size and updates aria-pressed
     through the returned root, the same division of labour onClose uses. */
  if (onExpand) root.querySelector('.chat-expand').addEventListener('click', (event) => { event.stopPropagation(); onExpand() })

  /* The composer repaints when the person types (stop⇄send), when the
     caller's status changes (turn started or ended), and when the queue
     changes from ANY surface — all three feeds land on one function. */
  let typedRepaintFrame = 0
  const onInputTyped = () => {
    if (disposed) return
    observeComposerText()
    /* The button state must feel instant, so it updates on every keystroke.
       The heavy repaints do not change per character; coalescing them to one
       animation frame stops fast typing from running the whole batch N times,
       which is what removes the per-keystroke lag (T382). */
    syncSendButton()
    if (typedRepaintFrame) return
    typedRepaintFrame = requestAnimationFrame(() => { typedRepaintFrame = 0; syncComposer() })
  }
  input.addEventListener('input', onInputTyped)
  input.addEventListener('compositionend', onInputTyped)
  // A status source may publish immediately from subscribe(). The palette
  // does not exist yet, but its refresh guard must already be initialized.
  let popEl = null
  const popCloseListeners = new Set()

  let imageOutboxUnsub = null
  if (imageOutbox && typeof imageOutbox.subscribe === 'function') {
    const strip = root.querySelector('.chat-image-queue-strip')
    const renderImages = view => {
      if (disposed || !strip) return
      strip.textContent = ''
      const entries = (view.entries || []).filter(row => !['accepted', 'cancelled'].includes(row.state))
      /* NO SESSION IS NOT A PAUSED QUEUE. Before a session exists the outbox
         answers held + AGENT_SESSION_NOT_READY with no rows (agent-session.js,
         views/agent.js). Drawn, that put "Image messages · Sending is paused" and
         a Refresh that reads nothing above every brand-new chat. With no row to
         keep there is nothing to say; every other held code, and any held view
         that still has rows, keeps the notice.
         THE SAME IS TRUE AFTER A SESSION IS GONE (T1371). A finished or stopped
         agent reopened after a restart answers held with the host's terminal
         session refusal (MC_AGENT_UNKNOWN_SESSION or MC_AGENT_SESSION_ENDED),
         and with no rows the panel told the person something of theirs was
         stuck when nothing had ever been queued. */
      strip.hidden = entries.length === 0
        && (view.state === 'ready' || view.code === 'AGENT_SESSION_NOT_READY'
          || TERMINAL_SESSION_REFUSAL_CODES.includes(view.code))
      const header = document.createElement('div')
      header.className = 'chat-image-queue-head'
      const heading = document.createElement('span')
      heading.textContent = entries.length ? `Image messages · ${entries.length}` : 'Image messages'
      header.appendChild(heading)
      const refresh = document.createElement('button')
      refresh.type = 'button'; refresh.textContent = 'Refresh'; refresh.className = 'chat-image-queue-refresh'
      refresh.setAttribute('aria-label', 'Refresh saved image message status')
      refresh.addEventListener('click', () => { if (!disposed) void imageOutbox.refresh() })
      header.appendChild(refresh)
      strip.appendChild(header)
      if (view.state !== 'ready') {
        const notice = document.createElement('p')
        notice.className = 'chat-image-queue-notice'
        notice.textContent = view.state === 'loading' ? 'Reading saved image messages…'
          : 'Sending is paused. Saved messages are kept; refresh to check their status.'
        notice.setAttribute('role', 'status')
        if (view.code) notice.dataset.refusalCode = view.code
        strip.appendChild(notice)
      }
      for (const entry of entries) {
        const row = document.createElement('div')
        row.className = 'chat-image-queue-row'
        row.dataset.envelopeId = entry.envelopeId
        row.dataset.deliveryState = entry.state
        const text = document.createElement('div')
        text.className = 'chat-image-queue-text'
        text.textContent = entry.text || 'Image message'
        row.appendChild(text)
        const meta = document.createElement('div')
        meta.className = 'chat-image-queue-meta'
        const count = (entry.imageReceipts || []).reduce((total, ref) => total + ref.imageCount, 0)
        const images = document.createElement('span')
        images.textContent = count + (count === 1 ? ' image' : ' images')
        meta.appendChild(images)
        /* The durable queue carries custody receipts, not source paths. Render
           only the bounded data URL validated by image-conversation's preview
           operation; this presentation layer never reads a provider file or
           invents a thumbnail placeholder. */
        const thumb = document.createElement('span')
        thumb.className = 'chat-image-queue-thumb'
        thumb.setAttribute('role', 'img')
        thumb.setAttribute('aria-label', count + (count === 1 ? ' retained image' : ' retained images'))
        // Native custody permits an 8 MiB source; this 12 MiB data-url bound
        // matches image-conversation's renderer/cache contract.
        const previewThumbnailMaxDataUrlBytes = 12 * 1024 * 1024
        const thumbnail = [entry.thumbnail, entry.imageThumbnail].find(value =>
          typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)
            && value.length <= previewThumbnailMaxDataUrlBytes)
        if (thumbnail) {
          const image = document.createElement('img')
          image.className = 'chat-image-queue-thumbnail'
          image.width = 48; image.height = 48; image.style.objectFit = 'contain'
          image.alt = ''
          image.src = thumbnail
          thumb.appendChild(image)
        } else {
          thumb.textContent = 'No image preview'
          thumb.dataset.previewState = 'unavailable'
        }
        meta.appendChild(thumb)
        const state = document.createElement('span')
        state.className = 'chat-image-queue-state'
        state.setAttribute('role', 'status')
        const deliveryCopy = imageMessageStatusCopy(entry, view)
        state.textContent = deliveryCopy.label
        meta.appendChild(state)
        const cleanupRepairHeld = view.state === 'held' && view.code === 'IMAGE_OUTBOX_CLEANUP_REQUIRED'
        const selectionChanged = entry.state === 'not-sent'
          && (entry.failure?.code || entry.code) === 'IMAGE_QUEUE_SELECTION_CHANGED'
        if (entry.state === 'not-sent' && (view.state === 'ready' || cleanupRepairHeld)) {
          const retry = document.createElement('button')
          retry.type = 'button'; retry.className = 'chat-image-queue-retry'
          retry.textContent = selectionChanged ? 'Send with current settings' : 'Send again'
          retry.setAttribute('aria-label', selectionChanged
            ? 'Send this saved image message with current settings'
            : 'Send this saved image message again')
          retry.addEventListener('click', async () => {
            if (disposed || retry.disabled) return
            retry.disabled = true
            const result = selectionChanged
              ? await imageOutbox.resendWithCurrentSettings?.(entry.envelopeId, view)
              : await imageOutbox.retry?.(entry.envelopeId, view)
            if (!disposed && !result?.detached && result?.state !== 'accepted' && result?.ok !== true) {
              addMsg('note', imageMessageActionFailureCopy(result, 'retry'))
            }
          })
          meta.appendChild(retry)
          const cancel = document.createElement('button')
          cancel.type = 'button'; cancel.className = 'chat-image-queue-cancel'; cancel.textContent = 'Remove'
          cancel.setAttribute('aria-label', 'Remove this saved image message')
          cancel.addEventListener('click', async () => {
            if (disposed || cancel.disabled) return
            cancel.disabled = true
            const result = await imageOutbox.cancel(entry.envelopeId, view)
            if (!disposed && !result?.detached && result?.ok !== true) addMsg('note', imageMessageActionFailureCopy(result, 'remove'))
          })
          meta.appendChild(cancel)
        }
        row.appendChild(meta)
        if (deliveryCopy.detail) {
          const notice = document.createElement('p')
          notice.className = 'chat-image-queue-notice'
          notice.textContent = deliveryCopy.detail
          row.appendChild(notice)
        }
        strip.appendChild(row)
      }
    }
    try { imageOutboxUnsub = imageOutbox.subscribe(renderImages) } catch { /* A missing bridge leaves the composer intact. */ }
  }

  let statusUnsub = null
  let queueUnsub = null
  if (status) {
    try {
      if (typeof status.subscribe === 'function') {
        const candidate = status.subscribe(() => {
          if (typeof status.subtitle === 'function') {
            const subtitleHost = root.querySelector('[data-chat-subtitle]')
            if (subtitleHost) subtitleHost.textContent = String(status.subtitle() || '')
          }
          syncComposer()
        })
        if (typeof candidate === 'function') {
          statusUnsub = candidate
          statusMetricsActive = true
        }
      }
    } catch {
      statusUnsub = null
      statusMetricsActive = false
    }
  }
  if (queue && typeof queue.subscribe === 'function') {
    try { queueUnsub = queue.subscribe(() => syncComposer()) } catch { queueUnsub = null }
  }

  /* THE COMPOSER CHIPS, REAL BODY. Reassigns the no-op declared beside the
     element refs -- isBusy/runStop/send all exist by this point, which is
     the whole reason this was deferred rather than written inline there
     (see that declaration's note). tier/model are called fresh here, the
     same contract status.busy()/queue.list() already keep. */
  paintChips = () => {
    if (!chips) return
    if (chipTier) {
      let value = null
      try { value = typeof chips.tier === 'function' ? chips.tier() : null } catch { value = null }
      const label = value && typeof value.label === 'string' ? value.label : ''
      chipTier.hidden = !label
      if (label) chipTier.textContent = label
    }
    if (chipModel) {
      let value = null
      try { value = typeof chips.model === 'function' ? chips.model() : null } catch { value = null }
      const label = value && typeof value.label === 'string' ? value.label : ''
      chipModel.hidden = !label
      if (label) chipModel.textContent = label
    }
    if (chipAccountRetry) {
      let value = null
      try { value = typeof chips.accountRetry === 'function' ? chips.accountRetry() : null } catch { value = null }
      chipAccountRetry.value = ['off', 'keep', 'wait'].includes(value?.value) ? value.value : 'off'
      chipAccountRetry.disabled = value?.disabled === true
      if (chipAccountRetryNow) {
        chipAccountRetryNow.hidden = value?.showAction !== true
        chipAccountRetryNow.disabled = value?.actionDisabled === true
      }
      if (chipAccountRetryStatus) chipAccountRetryStatus.textContent = typeof value?.status === 'string' ? value.status : ''
    }
    if (chipHalt) {
      const stoppable = isBusy() && typeof onStop === 'function'
      chipHalt.hidden = !stoppable
      chipHalt.disabled = !stoppable || stopping
    }
    /* THE ONE CHIP UNDER THE ARROW SAYS "Send now" AND ONLY EVER DOES THAT.
       It is never disabled by isBusy() -- interrupting a running turn is the
       whole of what it is for (R17) -- only by the three conditions that make
       the act impossible: no sender wired, a halt already in flight, or an
       empty box. The empty-box rule is inherited from the chip it replaces and
       for the same measured reason: send() with an empty box is deliberately
       the STOP action, so an enabled chip over an empty box would be a second
       Halt wearing the wrong word. */
    if (chipSendNow) chipSendNow.disabled = cannotSend || stopping || (!input.value.trim() && pendingAttachments.length === 0)
  }
  chipTier?.addEventListener('click', () => { if (!disposed) chips?.onOpenTier?.() })
  chipEffort?.addEventListener('click', () => { if (!disposed) chips?.onOpenEffort?.(root) })
  chipMode?.addEventListener('click', () => { if (!disposed) chips?.onOpenMode?.(root) })
  chipModel?.addEventListener('click', () => { if (!disposed) chips?.onOpenModel?.(root) })
  chipAccountRetry?.addEventListener('change', () => {
    if (!disposed) void chips?.onAccountRetryChange?.(chipAccountRetry.value, root)
  })
  chipAccountRetryNow?.addEventListener('click', () => {
    if (!disposed && !chipAccountRetryNow.disabled) void chips?.onAccountRetryNow?.(root)
  })
  chipHalt?.addEventListener('click', () => { if (!disposed && !chipHalt.disabled) void runStop() })
  /* The chip and ⇧⏎ are two spellings of ONE act, so they call one function.
     A second implementation here is exactly how the queue strip's own doors
     drifted apart before W18b. */
  chipSendNow?.addEventListener('click', () => { if (!disposed && !chipSendNow.disabled) void sendNowFromInput() })
  let chipsUnsub = null
  if (chips && typeof chips.subscribe === 'function') {
    try { chipsUnsub = chips.subscribe(() => paintChips()) } catch { chipsUnsub = null }
  }

  syncComposer()

  let unregisterLifecycle = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    liveStreams.clear()
    closeActionsPop()
    clearTimers()
    if (replyQueue.length) bumpChatDebug('queuedTurns', -replyQueue.length)
    replyQueue.length = 0
    const marker = takeTyping()
    marker?.remove()
    if (currentStream) {
      currentStream.message.removeAttribute('aria-busy')
      currentStream = null
      bumpChatDebug('streams', -1)
    }
    replying = false
    log.removeAttribute('aria-busy')
    anchorRo.disconnect()
    contentObserver.disconnect()
    cancelAnimationFrame(firstPinFrame)
    cancelAnimationFrame(settledPinFrame)
    /* A batch waiting on a frame outlives the log it would draw into. */
    if (actionFrame) { cancelAnimationFrame(actionFrame); actionFrame = 0 }
    pendingActions = []
    actionRows.clear()
    resumableHistoryRows.clear()
    diffRows.clear()
    sessionChanges.dispose()
    chatCompareFiles?.close()
    approvalRows.clear()
    document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded)
    sendButton.removeEventListener('click', send)
    input.removeEventListener('keydown', onInputKeydown)
    input.removeEventListener('input', onInputTyped)
    input.removeEventListener('compositionend', onInputTyped)
    headerMetaProviderActive = false
    const disposeHeaderMeta = headerMetaDisposer
    headerMetaDisposer = null
    try { disposeHeaderMeta?.() } catch { /* the remaining chat cleanup still runs */ }
    try { statusUnsub?.() } catch { /* a dead subscription is the goal state */ }
    try { imageOutboxUnsub?.() } catch { /* detached durable projection */ }
    try { queueUnsub?.() } catch { /* likewise */ }
    try { chipsUnsub?.() } catch { /* likewise */ }
    cancelStopWait?.()
    for (const cancel of [...pendingSendCancellations]) cancel()
    releaseSendNow(pendingSendNow)
    /* The up-arrow walk holds a queue entry's id and the person's stashed
       draft. Dropped, never committed: there is no box left to read a final
       edit out of, and committing at teardown would write whatever the input
       happened to hold, which is nobody's decision. Placed after the
       subscriptions so the teardown windows the composer pins measure
       (tools/test/chat-composer.test.mjs, chat-composer-chips.test.mjs) still
       reach statusUnsub/queueUnsub/chipsUnsub without being widened. */
    recall.leave()
    if (onClose) root.querySelector('.chat-close')?.removeEventListener('click', onCloseClick)
    unregisterLifecycle()
    bumpChatDebug('activeChats', -1)
    bumpChatDebug('disposedChats', 1)
  }

  bumpChatDebug('activeChats', 1)
  // A retained conversation has an explicit owner that calls dispose on close.
  // Navigation temporarily detaches it while its session keeps receiving events.
  unregisterLifecycle = registerChatLifecycle({ root, dispose, seenConnected: false, morphHost: null, retainOnDetach: retainOnDetach === true })
  Object.defineProperty(root, 'dispose', { value: dispose })
  // A view may reconnect this same conversation to a replacement session.
  // Drafts stay local to the mounted view; queue edits are never copied as sends.
  Object.defineProperty(root, 'exportDraft', { value: ({ handoff = false } = {}) => {
    if (recall.anchorId) return null
    /* A chat closed while its Send now waits for the stop: the message and its
       pictures leave together in the draft (see `ride` in deliverTurn). */
    const ride = handoff && !input.value.trim() && pendingAttachments.length === 0
      ? [...pendingRides].find(item => item.waiting()) : null
    if (ride) {
      ride.handedOff = true
      return { text: ride.text, attachments: ride.attachments.slice(), start: ride.text.length, end: ride.text.length }
    }
    return { text: input.value, attachments: pendingAttachments.slice(), start: input.selectionStart, end: input.selectionEnd }
  } })
  const captureMatches = capture => {
    observeComposerText()
    const origin = composerCaptures.get(capture)
    return origin?.root === root && origin.unchanged()
  }
  const tokenMatches = (capture, token) => !token || (token.version === 1
    && token.draftId === capture.draftId && token.revision === capture.revision
    && token.text === capture.text && JSON.stringify(token.images) === JSON.stringify(capture.attachments.map(image => ({ path: image.path }))))
  Object.defineProperty(root, 'captureDraft', { value: () => {
    if (disposed || recall.anchorId || imageAdmission) return null
    observeComposerText()
    const localRevision = composerRevision
    const capture = freezeComposerValue(structuredClone({
      draftId, revision: draftRevision, text: input.value, attachments: pendingAttachments,
      start: input.selectionStart, end: input.selectionEnd,
      ...(retainedDraft ? { retainedDraft } : {}),
    }))
    composerCaptures.set(capture, { root, unchanged: () => {
      observeComposerText()
      return !draftAuthorityRefusal && composerRevision === localRevision && draftId === capture.draftId
        && draftRevision === capture.revision && input.value === capture.text
        && JSON.stringify(pendingAttachments) === JSON.stringify(capture.attachments)
    } })
    return capture
  } })
  Object.defineProperty(root, 'attachRetainedDraft', { value: (capture, token) => {
    if (disposed || !captureMatches(capture) || !token || !tokenMatches(capture, token)) return false
    retainedDraft = freezeComposerValue(structuredClone(token))
    return true
  } })
  Object.defineProperty(root, 'restoreCapturedDraft', { value: (capture, token = capture?.retainedDraft) => {
    const origin = composerCaptures.get(capture)
    if (disposed || composerRevision !== 0 || input.value || pendingAttachments.length
      || !origin?.unchanged() || !tokenMatches(capture, token)) return false
    // Local lifetime advances, while the explicitly captured portable identity survives.
    composerRevision += 1
    input.value = capture.text
    observedComposerText = input.value
    pendingAttachments = structuredClone(capture.attachments)
    draftId = capture.draftId
    draftRevision = capture.revision
    retainedDraft = token ? freezeComposerValue(structuredClone(token)) : null
    paintAttachments()
    syncComposer()
    input.setSelectionRange?.(capture.start, capture.end)
    return true
  } })
  Object.defineProperty(root, 'invalidateDraftAuthority', { value: (code = 'IMAGE_OWNER_CHANGED') => {
    // Keep the exact draft and custody diagnostics; a new owner cannot send them.
    draftAuthorityRefusal = code
    if (!disposed && pendingAttachments.length) addMsg('note', 'Images remain attached: ' + code)
  } })
  Object.defineProperty(root, 'importDraft', { value: draft => {
    if (disposed || !draft) return
    // Ordinary import is a new intent, not permission to reuse a capture identity.
    composerRevision += 1
    draftId = crypto.randomUUID()
    draftRevision = 0
    setComposerText(String(draft.text || ''))
    setComposerAttachments(Array.isArray(draft.attachments) ? draft.attachments.slice() : [])
    paintAttachments()
    syncComposer()
    input.setSelectionRange?.(draft.start, draft.end)
  } })

  /* WHO TO TELL WHEN SOMETHING HAPPENS IN THIS CONVERSATION. A caller that
     streams a live turn into a chat has to be able to find that chat again --
     and the two surfaces this product mounts (the rail's Chat tab and the
     compact card on the canvas) are built from ONE shared config, spread by
     both, so a hand-off written on either mount would have to be written twice
     and would drift. It goes on the config instead, and both get it for free.
     A caller that throws here is a caller defect and must not cost the chat. */
  if (typeof onReady === 'function') {
    try { onReady(root) } catch { /* a broken handler never costs the chat */ }
  }

  /* A LIVE TURN, STREAMED INTO THE LOG BY THE CALLER. The simulated
     word-stream above answers PROMPTS this component invented; openStream is
     the real thing's door: the caller opens one bubble when the engine starts
     speaking, pushes the accumulated turn text as deltas arrive, and closes
     it with the final words. push REPLACES the bubble's text (the caller owns
     accumulation — the engine's delta events are already summed by the view),
     so a missed frame can never double words. One stream at a time is the
     caller's contract, same as cardReplies being single-slot per session. */
  Object.defineProperty(root, 'openStream', {
    value: ({ at, turnStamp = null, entryId = null } = {}) => {
      const activity = { hasText: false }
      liveStreams.add(activity)
      syncComposer()
      if (emptyNote.parentNode) emptyNote.remove()
      const restored = typeof entryId === 'string' ? resumableHistoryRows.get(entryId) : null
      if (entryId) resumableHistoryRows.delete(entryId)
      let message = restored
      let pendingNote = null
      if (!message) {
        const timing = liveChatTiming(at)
        const placement = streamLabel(timing)
        if (placement.divided) addTimeDivider(timing)
        message = makeMsg('them', '', placement.label, timing, turnStamp)
        message.m.setAttribute('aria-busy', 'true')
        /* TEMPORARY UNTIL SOMETHING CLASSIFIED ARRIVES. Before this, an
           opened stream with no words yet was hidden outright (the
           :has(.chat-msg-text:empty) rule), so between accepting a turn and
           its first packet the person was shown nothing at all and had no
           way to tell a slow start from a dead one. The row is now visible
           and says which it is; streamCategoryAfter converts it on the first
           real text. A row restored from history is NOT marked -- it already
           has a category, and re-opening it must not undo that. */
        message.m.dataset.chatStream = 'pending'
        pendingNote = document.createElement('div')
        pendingNote.className = 'chat-stream-pending'
        pendingNote.textContent = STREAM_PENDING_NOTE
        message.m.insertBefore(pendingNote, message.body)
        rememberTiming(timing)
        log.appendChild(message.m)
        revealNewBelow()
      }
      // Reusing history retains its original position, evidence and settled
      // appearance. The provider's late words still use the same renderer.
      const { m, body } = message
      const readable = createReadableTextBuffer(chatMessageSource(body))
      pinToBottom()
      let closed = false
      /* STOP MEANS THE HALF-WRITTEN ANSWER IS GONE, AT THE PRESS.
       *
       * The owner, T335: his input goes in first and the agent's partial work
       * is DISCARDED -- no grace period. Everything that makes that true on
       * screen has to be local and synchronous, because the engine cannot stop
       * in single-digit milliseconds and he is not waiting for it.
       *
       * MEASURED on the sealed 3b9c32ac candidate, three chip-door presses
       * (t0 taken in the same event-loop turn as the press): the abandoned turn
       * went on painting for 139ms, 364ms and 271ms after the press, and its
       * partial was still on screen at the end of every run -- the discard
       * never happened at all, at any latency.
       *
       * abandon() is deliberately NOT close(): close() settles a finished turn,
       * keeps its words and folds its runs. This throws the words away. It sets
       * the same `closed` flag, so a late push() or close() from the engine's
       * own completion is a no-op rather than a resurrection -- the packets
       * that were already in flight when he pressed must not repaint a row he
       * has been told is gone. */
      const abandon = () => {
        if (closed) return false
        closed = true
        liveStreams.delete(activity)
        pendingNote?.remove()
        pendingNote = null
        delete m.dataset.chatStream
        m.style.minHeight = ''
        m.removeAttribute('aria-busy')
        showHeld(0)
        if (typeof turnStamp === 'string' && turnStamp.trim()) {
          // Discard the words immediately, but keep the accepted turn's
          // receipt. This records the local discard without claiming that the
          // provider has already acknowledged the interruption.
          setChatMessageBody(body, DISCARDED_REPLY)
        } else {
          m.remove()
          lastLabelled = null
          if (!log.childElementCount) log.appendChild(emptyNote)
        }
        syncComposer()
        return true
      }
      activity.abandon = abandon
      let heldNote = null
      // Formatting can briefly reduce a growing answer's height. Hold its
      // tallest height until close() so the transcript does not jump upward.
      let heldHeight = 0
      /* T404: THE HOLD IS NAMED WHILE IT IS IN FORCE, NOT ONLY WHEN IT ENDS.
         readable.push withholds an unfinished table, link or code span at the
         tail (src/chat-readable-stream.js). Nothing revealed it until the turn
         completed, so when a session stalled or a reply was cut off, text that
         had ARRIVED sat invisible behind a row that still claimed to be
         working -- which is why a stalled reply and a reply that simply ended
         mid-sentence looked identical. The row carries the fact from the frame
         the hold starts; chat-presentation.css delays the note so an ordinary
         sub-frame hold is never drawn, and close() below clears it. */
      const showHeld = held => {
        if (held > 0) m.dataset.chatHeld = String(held)
        else delete m.dataset.chatHeld
        if (held > 0 && !heldNote) {
          heldNote = document.createElement('div')
          heldNote.className = 'chat-stream-held'
          heldNote.textContent = STREAM_HELD_NOTE
          m.appendChild(heldNote)
        } else if (held === 0 && heldNote) { heldNote.remove(); heldNote = null }
      }
      const paint = (source, complete = false) => {
        const text = complete ? readable.finish(source) : readable.push(source)
        showHeld(complete ? 0 : readable.heldChars)
        const hasText = Boolean(String(text ?? '').trim())
        if (activity.hasText !== hasText) {
          activity.hasText = hasText
          syncComposer()
        }
        setChatMessageBody(body, text)
        /* THE CONVERSION. The row stops being temporary the moment it holds
           classified content, and never goes back -- see streamCategoryAfter. */
        const category = streamCategoryAfter(m.dataset.chatStream, hasText)
        if (category !== m.dataset.chatStream) {
          m.dataset.chatStream = category
          pendingNote?.remove()
          pendingNote = null
        }
        // The transcript owns scrolling; every line remains accessible while live.
        if (m.offsetHeight > heldHeight) {
          heldHeight = m.offsetHeight
          m.style.minHeight = `${heldHeight}px`
        }
        pinToBottom()
      }
      return {
        /* WORDS END THE WORK, EVEN MID-STREAM -- addMsg's own rule
           ("any spoken entry folds the live run above it"), which this path
           never applied.
           MEASURED (a driven run through this exact function: nine tool
           calls, then the agent's own closing line, exactly as
           src/agent-session.js sequences a real turn -- openStream() first,
           so the reply's bubble is already in the log before the first tool
           call, then addAction() nine times, then push()+close() with the
           final words): the run's `open` attribute was still `true` after
           the reply had fully arrived. addMsg/addContext/addDiff are the
           only three places that ever called settleActionRuns(), and a
           caller streaming the actual live answer through openStream never
           touches any of them -- so on the ordinary shape of a working turn
           (tool calls, then the answer), the fold this component exists to
           provide never fired at the one moment a person is reading: the log
           keeps auto-scrolling to the bottom of a run that never closes,
           past the answer already sitting above it. */
        push: (text) => {
          if (disposed || closed) return
          paint(text)
          // An unfinished sentence is still withheld by the presentation
          // buffer. Keep supplied thinking visible until speech is visible too.
          if (activity.hasText) settleActionRuns()
        },
        flush: () => { if (!disposed && !closed) pinToBottom() },
        close: (finalText, { provisional = false } = {}) => {
          if (closed) return
          closed = !provisional
          if (!disposed) paint(finalText ?? readable.text, true)
          liveStreams.delete(activity)
          syncComposer()
          m.style.minHeight = ''
          m.removeAttribute('aria-busy')
          /* A settled row carries no live state. The turn is over, so a row
             still waiting on its first packet is not waiting any more: the
             placeholder goes whether or not anything ever arrived. */
          pendingNote?.remove()
          pendingNote = null
          // The turn is over and finish() has painted everything that arrived:
          // there is nothing held any more, so the row must stop saying so.
          showHeld(0)
          delete m.dataset.chatStream
          // A supplied turn receipt remains visible even when no prose arrives.
          if (!activity.hasText && !(typeof turnStamp === 'string' && turnStamp.trim())) {
            m.remove(); lastLabelled = null
            if (!log.childElementCount) log.appendChild(emptyNote)
          }
          /* The turn's spoken part is over even when it said nothing (a
             turn that was pure tool calls): fold whatever run is still open
             now, rather than leaving it to merge with the NEXT turn's first
             tool call -- otherwise the next turn's addAction() calls would
             be the only thing that could ever have closed it. */
          settleActionRuns()
        },
      }
    },
  })

  /* A PERSON'S QUEUED MESSAGE PAINTS WHEN IT REALLY REACHES THE WIRE.
     Ordinary sends already own an optimistic bubble above. A queued send has
     no bubble while it waits; the fleet view calls this only after bridge.send
     accepts the next turn, so both mounted Page 2 chat surfaces gain the same
     honest transcript line at that moment. */
  Object.defineProperty(root, 'addOwnerMessage', {
    value: addOwnerMessage,
  })
  Object.defineProperty(root, 'confirmOwnerMessage', {
    value: confirmOwnerMessage,
  })

  /* THE PRODUCT'S OWN LINE, LIVE. A restored conversation already paints
     `who: 'note'` entries (see the history loop); this is the same row for a
     caller that learns the fact while the chat is open -- the example fleet's
     usage limits, retries and handoffs (src/sample-simulation.js). */
  Object.defineProperty(root, 'addNote', {
    value: (text, { at } = {}) => {
      const body = typeof text === 'string' ? text.trim() : ''
      if (disposed || !body) return null
      return addMsg('note', body, undefined, liveChatTiming(at))
    },
  })

  /* Both approval surfaces carry the provider's offered decision ids and
     scopes. A pending row stays until the host confirms the answer. Repaint
     does not unlock an in-flight press, and detached buttons cannot answer. */
  Object.defineProperty(root, 'showApproval', {
    value: (approval) => {
      if (disposed || !approval || typeof approval !== 'object' || !approval.id) return
      const id = String(approval.id)
      let row = approvalRows.get(id)
      if (!row) {
        if (emptyNote.parentNode) emptyNote.remove()
        settleActionRuns()
        const wrap = document.createElement('div')
        wrap.className = 'chat-approval'
        const label = document.createElement('div')
        label.className = 'chat-approval-label'
        label.textContent = APPROVAL_STRIP_LABEL
        const badgesEl = document.createElement('div')
        badgesEl.className = 'chat-approval-badges'
        const summaryEl = document.createElement('div')
        summaryEl.className = 'chat-approval-summary'
        const actionsEl = document.createElement('div')
        actionsEl.className = 'chat-approval-actions'
        wrap.append(label, badgesEl, summaryEl, actionsEl)
        log.appendChild(wrap)
        revealNewBelow()
        row = { wrap, badgesEl, summary: summaryEl, actionsEl, buttons: [], deciding: false }
        approvalRows.set(id, row)
        row.decide = (decision) => {
          if (disposed || approvalRows.get(id) !== row || row.deciding || row.externalAnswering || typeof onApprovalDecision !== 'function') return
          row.deciding = true
          for (const button of row.buttons) button.disabled = true
          Promise.resolve()
            .then(() => onApprovalDecision(id, decision))
            .then(said => { if (!disposed && said) addMsg('note', String(said)) })
            .catch(() => {
              if (disposed || approvalRows.get(id) !== row) return
              row.deciding = false
              for (const button of row.buttons) button.disabled = row.externalAnswering
              addMsg('note', APPROVAL_RETRY_HINT)
            })
        }
      }
      row.externalAnswering = approval.answering === true
      if (!row.deciding) {
        const choices = approvalCardChoices(approval.decisions, approval.decisionKinds)
        row.actionsEl.textContent = ''
        row.buttons = []
        for (const decision of choices.decisions) {
          const button = document.createElement('button')
          button.type = 'button'
          const kind = approval.decisionKinds?.[decision]
          button.className = kind === 'allow_always' ? 'chat-approval-remember'
            : decision === 'decline' || kind === 'reject_once' || kind === 'reject_always'
              ? 'chat-approval-decline' : 'chat-approval-accept'
          button.setAttribute('data-chat-approval', decision)
          button.textContent = approvalDecisionWord(decision, approval.decisionKinds)
          button.disabled = row.externalAnswering || typeof onApprovalDecision !== 'function'
          button.addEventListener('click', () => { if (row.buttons.includes(button)) row.decide(decision) })
          row.buttons.push(button)
          row.actionsEl.appendChild(button)
        }
        if (choices.note) row.actionsEl.textContent = choices.note
      }
      row.summary.textContent = typeof approval.summary === 'string' ? approval.summary : ''
      row.badgesEl.textContent = ''
      for (const badge of Array.isArray(approval.badges) ? approval.badges : []) {
        const b = document.createElement('span')
        b.className = 'chat-approval-badge'
        b.textContent = String(badge)
        row.badgesEl.appendChild(b)
      }
      syncComposer()
      pinToBottom()
    },
  })
  Object.defineProperty(root, 'resolveApproval', {
    value: (id) => {
      const row = approvalRows.get(String(id))
      if (!row) return
      row.wrap.remove()
      approvalRows.delete(String(id))
      syncComposer()
    },
  })

  /* ---- THE ACTIONS POPUP: a quick-pick anchored over the composer. ----
     Rows come from the caller's actions() -- built FRESH at every open, so
     enabled states are never stale. A row's run(ctx) may repaint the popup
     in place with ctx.show(rows, {title}) -- that is how thinking depth,
     model and rewind are two-stage picks inside ONE panel -- and may speak
     an outcome through ctx.say, which lands on the status line at the
     bottom. Escape and any press outside close it; so does dispose.

     KEYBOARD-FIRST, WHICH IS THE SUBSTANCE OF "MORE LIKE VSCODE". The
     owner's report on this menu was that it should be more like VS Code and
     more intuitive. What VS Code's quick pick has that this did not is not
     a look: it is that the whole thing is driven from the filter box. Type
     to narrow, Up and Down to move, Enter to run, Escape to leave, and the
     row under the cursor announced to assistive tech as you move. This
     popup's entire keyboard handler was one line for Escape; the rows were
     plain buttons reachable only by Tab or mouse; the filter carried no
     aria-controls, no aria-activedescendant, no arrow keys.

     So the filter is now a combobox over a listbox: focus stays in the
     input, aria-activedescendant names the active row, and every row is an
     option with a stable id for this opening. A sub-stage keeps the same
     model with the list itself as the focus target, since its filter is
     hidden.

     ROWS ARE GROUPED, and the group that ends or forgets something is last.
     A row's `group` is a heading; consecutive rows sharing one sit under it.
     Arrow keys walk the row array, never the DOM, so headings are skipped by
     construction.

     A DISABLED ROW SAYS WHY. A row carrying `disabledHint` shows that
     sentence in place of its hint when it is switched off, and Enter on it
     speaks the same sentence, so a keyboard user gets a reason where they
     used to get silence. */
  let popStack = []
  let popTopRows = []
  /* WHY THE BUILDER'S FAILURE IS KEPT RATHER THAN DROPPED. `actions()` is the
     caller's own function and it can throw; the catch below used to write an
     empty list and nothing else, which is the one answer this popup must never
     give -- "there are no actions here" is a fact about the agent, and a throw
     is a fact about this build. MEASURED 2026-09-03 over the outside-control
     port: every tree circle answered `rows: []`, and the driver reading it
     reported a missing Resume row on a product that has one. The message is
     held here so renderPopStage can put it on a row nothing filters away. */
  let popBuildFailure = null
  /* Whether the builder threw, kept apart from WHAT it threw: the row must
     appear for every failure, including the ones with nothing quotable. */
  let popBuildFailed = false
  /* The rows on the glass right now, in walk order, and which is active.
     Rebuilt by renderPopStage; the index survives a repaint so the cursor
     does not jump while a person types. */
  let popRendered = []
  let popActive = -1
  /* One id family per OPENING, so the ids are stable for as long as the
     popup is up and cannot collide with a second chat's popup. */
  let popSerial = 0
  const onDocPointer = (event) => {
    if (!popEl) return
    if (popEl.contains(event.target)) return
    if (actionsButton && (event.target === actionsButton || actionsButton.contains(event.target))) return
    closeActionsPop()
  }
  /* Kept at the document, in capture, so Escape closes the popup from
     wherever focus has wandered -- the row model below is a superset of
     this, not a replacement for it. */
  const onPopKeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Escape') return
    /* ONE LAYER PER PRESS. This capture handler closes the popup and STOPS the
       event: without the stop, the same press fell through to whatever layer
       stands behind the popup — measured on the phone press-through
       (2026-08-27): Escape over the actions popup closed the popup AND the
       whole details sheet in one key. The next Escape reaches the next layer,
       which is the rule every other Escape here follows (tree-graph's
       chat-card handler says it in words: "ONE STEP AT A TIME"). */
    event.stopPropagation()
    closeActionsPop()
  }
  /* Focus left the popup for somewhere that is not the popup and not the
     button that opens it. VS Code's quick pick closes on exactly this, and
     it is what lets a row that hands focus to the composer (Mention a file)
     get out of the way. Deferred a tick because hiding the filter on a
     sub-stage blurs it with no relatedTarget BEFORE the list is focused. */
  const onPopFocusOut = () => {
    setTimeout(() => {
      if (!popEl) return
      const active = document.activeElement
      if (popEl.contains(active)) return
      if (actionsButton && (active === actionsButton || actionsButton.contains(active))) return
      closeActionsPop()
    }, 0)
  }
  function closeActionsPop() {
    if (!popEl) return
    /* Remember this before remove(): a removed focused descendant remains the
       DOM stand-in's activeElement and browsers otherwise have no useful
       place to return a keyboard user. If a row deliberately moved focus
       elsewhere (for example to the composer), preserve that destination. */
    const heldFocus = popEl.contains(document.activeElement)
    popEl.remove()
    popEl = null
    for (const listener of [...popCloseListeners]) { try { listener() } catch {} }
    popCloseListeners.clear()
    popStack = []
    popTopRows = []
    popBuildFailure = null
    popBuildFailed = false
    popRendered = []
    popActive = -1
    actionsButton?.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onPopKeydown, true)
    if (heldFocus) actionsButton?.focus()
  }
  const popCtx = () => {
    const out = popEl?.querySelector('.chat-actions-out')
    return {
      say: sentence => { if (out && popEl) out.textContent = String(sentence ?? '') },
      refresh: () => { if (out && out === popEl?.querySelector('.chat-actions-out')) paintOpenActions() },
      close: closeActionsPop,
      onClose: listener => { if (typeof listener === 'function') popCloseListeners.add(listener) },
      // Actions belong to the composer that opened them. Keeping these doors
      // here preserves its draft and removable attachments on both the rail
      // and floating card, including an asynchronous native picker.
      composer: {
        focus: () => { if (!disposed) input.focus() },
        attach: chooseAttachment,
        mention: chooseMention,
      },
      compose: (prefix, hint, { rewrite, queueEditHint = PALETTE_PANEL.goalQueueEdit } = {}) => {
        if (cannotSend) { if (out) out.textContent = composerReason; return }
        if (recall.anchorId !== null) { if (out) out.textContent = queueEditHint; return }
        // Keep the person's draft and leave the caret where the request ID goes.
        const draft = input.value.trimStart()
        const command = prefix.trim().toLowerCase()
        if (typeof rewrite === 'function') setComposerText(rewrite(input.value))
        else if (draft.toLowerCase() === command) setComposerText(prefix)
        else if (!draft.toLowerCase().startsWith(command + ' ')) {
          setComposerText(prefix + input.value)
        }
        closeActionsPop()
        input.focus()
        input.setSelectionRange?.(prefix.length, prefix.length)
        if (hint) addMsg('note', hint)
        syncComposer()
      },
      show: (nextRows, { title: stageTitle = null } = {}) => {
        popStack.push({ rows: typeof nextRows === 'function' || Array.isArray(nextRows) ? nextRows : [], title: stageTitle })
        popActive = -1
        renderPopStage()
      },
    }
  }
  const runPopRow = (entry) => {
    if (!entry || !popEl) return
    const out = popEl.querySelector('.chat-actions-out')
    if (entry.enabled === false) {
      /* Enter on a row that cannot be pressed: the reason, on the status
         line, rather than nothing. */
      if (out && entry.disabledHint) out.textContent = entry.disabledHint
      return
    }
    if (typeof entry.run !== 'function') return
    Promise.resolve()
      .then(() => entry.run(popCtx()))
      .then(said => { if (said && out && popEl) out.textContent = String(said) })
      .catch(() => { if (out && popEl) out.textContent = ACTION_RUN_FAILED })
      .finally(() => paintOpenActions())
  }
  /* Move the cursor and say so: the class for the eye, aria-selected and
     aria-activedescendant for the ear, and the row scrolled into the list's
     box so the cursor never leaves the visible rows. */
  const paintPopActive = () => {
    if (!popEl) return
    const filter = popEl.querySelector('.chat-actions-filter')
    const list = popEl.querySelector('.chat-actions-list')
    if (popActive >= popRendered.length) popActive = popRendered.length - 1
    let activeId = ''
    popRendered.forEach((entry, index) => {
      const on = index === popActive
      entry.button.classList.toggle('is-active', on)
      entry.button.setAttribute('aria-selected', on ? 'true' : 'false')
      if (on) {
        activeId = entry.button.id
        entry.button.scrollIntoView?.({ block: 'nearest' })
      }
    })
    for (const owner of [filter, list]) {
      if (!owner) continue
      if (activeId) owner.setAttribute('aria-activedescendant', activeId)
      else owner.removeAttribute('aria-activedescendant')
    }
  }
  const movePopActive = (delta) => {
    if (!popRendered.length) return
    if (popActive < 0) popActive = delta > 0 ? 0 : popRendered.length - 1
    else popActive = (popActive + delta + popRendered.length) % popRendered.length
    paintPopActive()
  }
  const firstEnabledPopRow = () => {
    const index = popRendered.findIndex(entry => entry.enabled !== false)
    return index === -1 ? (popRendered.length ? 0 : -1) : index
  }
  /* The keyboard model, bound to the popup so it hears the filter and, on a
     sub-stage, the list. Escape is left to the document handler above. */
  const onPopKeys = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (!popEl) return
    if (event.key === 'ArrowDown') { event.preventDefault(); movePopActive(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); movePopActive(-1); return }
    if (event.key === 'Home') { event.preventDefault(); popActive = popRendered.length ? 0 : -1; paintPopActive(); return }
    if (event.key === 'End') { event.preventDefault(); popActive = popRendered.length - 1; paintPopActive(); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      const entry = popActive >= 0 ? popRendered[popActive] : popRendered[firstEnabledPopRow()]
      runPopRow(entry)
    }
  }
  const renderPopStage = () => {
    if (!popEl) return
    const list = popEl.querySelector('.chat-actions-list')
    const filter = popEl.querySelector('.chat-actions-filter')
    const titleLine = popEl.querySelector('.chat-actions-title')
    const stage = popStack.length ? popStack[popStack.length - 1] : null
    let stageRows = [], stageFailure = null
    if (stage) {
      try {
        stageRows = typeof stage.rows === 'function' ? stage.rows() : stage.rows
        if (!Array.isArray(stageRows)) throw new Error('Invalid Actions choices')
      } catch (error) { stageFailure = error }
    }
    /* READ WHERE FOCUS IS BEFORE THIS RE-RENDER MOVES IT. Hiding the filter
       or removing the focused row makes the browser move focus to
       document.body on the spot (Chromium's focus fixup), so a read taken
       after the render sees body, decides nothing of the popup is focused,
       and onPopFocusOut closes the popup a tick later. Measured 2026-09-16
       on the cut-2 tip through the real window: "Switch model" and "How hard
       it thinks" closed the menu instead of opening their choices, by mouse
       and by keyboard. The decision at the end of this function uses the
       reading taken here. */
    const focusedBefore = document.activeElement
    const focusedInsideBefore = Boolean(focusedBefore) && popEl.contains(focusedBefore)
    /* The filter belongs to the top stage; a sub-stage is a short pick
       list with a Back row instead. */
    filter.hidden = Boolean(stage)
    titleLine.hidden = !stage?.title
    if (stage?.title) titleLine.textContent = stage.title
    list.textContent = ''
    popRendered = []
    /* A LEADING SLASH IS A COMMAND LINE, NOT A FILTER. "/Request keep it
       short" becomes the first row, which Enter runs exactly as a line sent
       from the box; the word after the slash still narrows the list below
       it, so "/inter" also finds Interrupt. */
    const typedLine = stage ? '' : filter.value.trim()
    const typedCommand = typedLine.startsWith('/') ? typedLine : ''
    const wanted = stage ? '' : (typedCommand ? typedCommand.slice(1).split(/\s+/)[0] : typedLine).trim().toLowerCase()
    /* THE BUILDER THREW, AND THAT IS A ROW, NOT AN ABSENCE. It stands in place
       of the whole list and IGNORES the filter: a refusal a filter can hide is
       a refusal that comes back as `rows: []`, which is the exact reading this
       popup handed the outside driver on 2026-09-03. */
    const stageFailureCode = typeof stageFailure?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(stageFailure.code) ? stageFailure.code : null
    const buildFailureRow = stageFailure || (!stage && popBuildFailed)
      ? { id: 'actions-not-built', label: ACTIONS_BUILD_FAILED, enabled: false, disabledHint: readerSentence(actionsBuildFailedWhy(stageFailure ? stageFailureCode : popBuildFailure)) }
      : null
    const typedRow = typedCommand && !buildFailureRow ? {
      id: 'typed-command',
      label: typedCommand.length > 1 ? ACTIONS_TYPED_RUN(typedCommand) : ACTIONS_TYPED_EMPTY,
      hint: typedCommand.length > 1 ? ACTIONS_TYPED_HINT : null,
      enabled: typedCommand.length > 1 && !cannotSend && !disposed,
      disabledHint: cannotSend ? composerReason : (typedCommand.length > 1 ? null : ACTIONS_TYPED_EMPTY),
      run: ctx => {
        ctx.close()
        if (disposed || cannotSend) return
        setComposerText(typedCommand)
        syncComposer()
        send()
      },
    } : null
    const offeredRows = buildFailureRow ? [buildFailureRow] : (stage ? stageRows : [...(typedRow ? [typedRow] : []), ...popTopRows.filter(row =>
      !wanted || row.label.toLowerCase().includes(wanted) || String(row.hint || '').toLowerCase().includes(wanted))])
    /* This is the palette's construction choke point: every row, including a
       caller's sub-stage, must arrive with the render decision paired to the
       sentence for its false branch. A disabled row with no answer is a build
       error, not a button that waits to fail silently. */
    const rows = offeredRows.map(row => {
      const state = controlState({ enabled: row.enabled !== false, why: row.disabledHint ?? null })
      return { ...row, enabled: state.enabled, disabledHint: state.why }
    })
    const optionId = index => `chat-actions-opt-${popSerial}-${index}`
    const addOption = (entry) => {
      const index = popRendered.length
      entry.button.id = optionId(index)
      entry.button.setAttribute('role', 'option')
      entry.button.setAttribute('aria-selected', 'false')
      /* Hovering moves the cursor, as it does in VS Code, so mouse and
         keyboard never disagree about which row Enter would run. */
      entry.button.addEventListener('mousemove', () => {
        if (popActive === index) return
        popActive = index
        paintPopActive()
      })
      popRendered.push(entry)
      list.appendChild(entry.button)
    }
    if (stage) {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'chat-actions-row chat-actions-back'
      back.textContent = ACTIONS_BACK
      const leave = () => {
        // Back removes its own focused row. Keep focus on the retained list
        // so the parent stage can hand it to its filter before focusout runs.
        list.focus({ preventScroll: true })
        popStack.pop(); popActive = -1; renderPopStage()
      }
      back.addEventListener('click', leave)
      addOption({ button: back, enabled: true, run: leave })
    }
    if (!rows.length && !stage) {
      const none = document.createElement('p')
      none.className = 'chat-actions-hint'
      none.textContent = ACTIONS_NO_MATCH
      list.appendChild(none)
    }
    let lastGroup = null
    for (const row of rows) {
      /* A heading when the group changes. role="presentation" so the listbox
         still counts only options; the eye gets the heading, the ear gets the
         option that follows it. */
      const group = typeof row.group === 'string' && row.group ? row.group : null
      if (group && group !== lastGroup) {
        const heading = document.createElement('div')
        heading.className = 'chat-actions-group'
        heading.setAttribute('role', 'presentation')
        heading.textContent = group
        list.appendChild(heading)
      }
      lastGroup = group
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'chat-actions-row'
      const disabled = row.enabled === false
      button.disabled = disabled
      if (disabled) button.setAttribute('aria-disabled', 'true')
      const label = document.createElement('div')
      label.textContent = row.label
      button.appendChild(label)
      if (row.icon === 'goal' || row.icon === 'loop') {
        button.classList.add('has-command-icon')
        button.appendChild(el(commonCommandIcon(row.icon, row.minutes)))
      }
      /* The hint, or the reason it cannot be pressed. Never both, and the
         reason gets its own class so the eye can tell them apart too. */
      const why = disabled && typeof row.disabledHint === 'string' ? row.disabledHint : ''
      if (row.icon === 'loop') button.setAttribute('aria-label', `${row.label} · ${row.minutes} min. ${why || row.hint || ''}`)
      if (why || row.hint) {
        const hint = document.createElement('div')
        hint.className = why ? 'chat-actions-hint chat-actions-why' : 'chat-actions-hint'
        hint.textContent = why || row.hint
        button.appendChild(hint)
      }
      if (row.current) button.classList.add('is-current')
      const entry = { id: row.id, button, enabled: !disabled, disabledHint: why, run: row.run }
      button.addEventListener('click', () => runPopRow(entry))
      addOption(entry)
    }
    if (popActive < 0 || popActive >= popRendered.length) {
      /* First press of Enter runs the obvious thing: the first row that can
         be pressed, or Back's neighbour on a sub-stage. */
      popActive = stage ? Math.min(1, popRendered.length - 1) : firstEnabledPopRow()
    }
    /* SAID AS WELL AS SHOWN. The row carries the reason for the eye; the
       role="status" line is what a screen reader hears without walking to it,
       and it is the same sentence rather than a second wording of it. */
    if (buildFailureRow) {
      const out = popEl.querySelector('.chat-actions-out')
      if (out) out.textContent = buildFailureRow.disabledHint
    }
    paintPopActive()
    /* Where the keys go. The top stage types into the filter; a sub-stage
       has no filter, so its list takes focus. Only moved when focus is
       inside the popup and on the wrong half of it, so a person mid-word in
       the filter is never interrupted. */
    const focused = document.activeElement
    /* "Inside" is judged on the reading taken before the render as well as
       now: a filter just hidden or a row just removed was inside the popup
       a moment ago, and the browser has already parked focus on body. */
    const inside = focusedInsideBefore || Boolean(focused && popEl.contains(focused))
    if (stage) {
      if (focused !== list && inside) list.focus({ preventScroll: true })
    } else if (focused === list || focusedBefore === list
      || (inside && focused !== filter && !(focused && focused.tagName === 'BUTTON' && popEl.contains(focused)))) {
      filter.focus({ preventScroll: true })
    }
  }
  const readPopRows = () => {
    try { popTopRows = actions() || []; popBuildFailure = null; popBuildFailed = false }
    catch (error) {
      popTopRows = []
      /* THE FAILURE IS ALWAYS SHOWN. THE MACHINE'S OWN WORDS ARE NOT.
       *
       * Two separate things were tangled here. A palette that could not be
       * built MUST still say so -- a refusal a filter can hide is a refusal
       * that comes back as an empty menu, which is the failure
       * tools/test/chat-actions-palette-refusal.test.mjs exists to prevent.
       * But what reached the person as "this is what stopped it: ..." was the
       * raw Error message, and a renderer fault throws a JavaScript sentence
       * ("Cannot read properties of undefined") that names nothing anybody can
       * act on.
       *
       * So the row is raised on `popBuildFailed`, which is true whenever the
       * builder threw, and the DETAIL is a bounded code or nothing. The rule
       * for the detail is the one shell/agent-facade.cjs already states: "An
       * error code as this product writes them: a bounded identifier from a
       * closed vocabulary. Anything that does not match is internal prose and
       * stays on this machine."
       *
       * When there is no code the sentence says it gave no reason, which is
       * true, and the remedy above it -- close the menu and open it again --
       * is what the person needs either way and is unchanged. */
      popBuildFailed = true
      const failureCode = error && typeof error.code === 'string' ? error.code : ''
      popBuildFailure = /^[A-Z][A-Z0-9_]{1,127}$/.test(failureCode) ? failureCode : null
    }
  }
  const popRowState = rows => JSON.stringify(rows.map(row => [row.id, row.label, row.hint,
    row.enabled !== false, row.disabledHint, row.current, row.group, row.icon, row.minutes]))
  // Re-read open actions from the same status feed as the composer. Keep the
  // popup, filter and keyboard selection mounted while a turn starts or ends.
  paintOpenActions = () => {
    if (!popEl || disposed || typeof actions !== 'function') return
    const before = popRowState(popTopRows)
    const failed = popBuildFailure
    const wasFailed = popBuildFailed
    readPopRows()
    const stage = popStack.length ? popStack[popStack.length - 1] : null
    if (stage && typeof stage.rows !== 'function') return
    if (!stage && before === popRowState(popTopRows) && failed === popBuildFailure && wasFailed === popBuildFailed) {
      for (const entry of popRendered) {
        const current = popTopRows.find(row => row.id === entry.id)
        if (current) entry.run = current.run
      }
      return
    }
    const filter = popEl.querySelector('.chat-actions-filter')
    const list = popEl.querySelector('.chat-actions-list')
    const previousFocus = document.activeElement
    const focusWasInside = Boolean(previousFocus && popEl.contains(previousFocus))
    const focusFilter = previousFocus === filter
    const focusedRow = popRendered.find(entry => entry.button === previousFocus)
    const selectedId = popRendered[popActive]?.id
    // A row being replaced must not leave focus on a detached node while the
    // popup's focusout handler decides whether to close the whole menu.
    if (focusedRow) list.focus({ preventScroll: true })
    popActive = -1
    renderPopStage()
    const selectedIndex = popRendered.findIndex(entry => entry.id === selectedId)
    if (selectedIndex >= 0) { popActive = selectedIndex; paintPopActive() }
    const fallbackFocus = () => (filter.hidden ? list : filter).focus({ preventScroll: true })
    if (focusFilter) fallbackFocus()
    else if (focusedRow?.id) {
      const button = popRendered.find(entry => entry.id === focusedRow.id)?.button
      if (button && !button.disabled) button.focus({ preventScroll: true })
      else fallbackFocus()
    } else if (focusWasInside && !popEl.contains(document.activeElement)) fallbackFocus()
  }
  const openActions = (sectionId = null, { prefill = '' } = {}) => {
    if (typeof actions !== 'function' || disposed) return
    closeActionsPop()
    popSerial += 1
    const listId = `chat-actions-list-${popSerial}`
    popEl = el(`
      <div class="chat-actions-pop" aria-label="${ACTIONS_LABEL}">
        <div class="chat-actions-title" hidden></div>
        <input type="text" class="chat-actions-filter" placeholder="${ACTIONS_FILTER_PLACEHOLDER}" aria-label="${ACTIONS_FILTER_LABEL}"
          role="combobox" aria-expanded="true" aria-autocomplete="list" aria-haspopup="listbox" aria-controls="${listId}" autocomplete="off">
        <div class="chat-actions-list" id="${listId}" role="listbox" aria-label="${ACTIONS_LABEL}" tabindex="-1"></div>
        ${actionsNote ? `<p class="chat-actions-hint chat-actions-note">${escapeMarkup(actionsNote)}</p>` : ''}
        <output class="chat-actions-out" role="status"></output>
      </div>`)
    root.appendChild(popEl)
    actionsButton?.setAttribute('aria-expanded', 'true')
    readPopRows()
    popStack = []
    popActive = -1
    renderPopStage()
    const filter = popEl.querySelector('.chat-actions-filter')
    filter.addEventListener('input', () => { popActive = -1; renderPopStage() })
    popEl.addEventListener('keydown', onPopKeys)
    popEl.addEventListener('focusout', onPopFocusOut)
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onPopKeydown, true)
    filter.focus()
    if (prefill) {
      filter.value = prefill
      filter.setSelectionRange?.(prefill.length, prefill.length)
      popActive = -1
      renderPopStage()
    }
    if (sectionId) {
      const target = popTopRows.find(row => row.id === sectionId && row.enabled !== false && typeof row.run === 'function')
      if (target) {
        void Promise.resolve().then(() => target.run(popCtx())).catch(() => {})
        return
      }
    }
  }
  actionsButton?.addEventListener('click', () => { popEl ? closeActionsPop() : openActions() })
  Object.defineProperty(root, 'openActions', { value: openActions })

  // These shortcuts use the same current rows and handlers as the full menu.
  // Keep each button mounted when status changes so keyboard focus survives.
  const commonHost = root.querySelector('.chat-common-actions')
  const commonMarkup = new Map()
  if (commonHost && typeof commonActions === 'function') {
    paintCommonActions = () => {
      let rows
      try { rows = commonActions() || [] } catch { return }
      for (const row of rows) {
        if (row.icon !== 'goal' && row.icon !== 'loop') continue
        let button = commonHost.querySelector(`[data-common-command="${row.icon}"]`)
        if (!button) {
          button = document.createElement('button')
          button.type = 'button'
          button.className = 'chat-common-action'
          button.setAttribute('data-common-command', row.icon)
          button.addEventListener('click', () => openActions(row.id))
          commonHost.appendChild(button)
        }
        const description = row.enabled === false ? row.disabledHint : row.hint
        const label = row.icon === 'loop' ? `${row.label} · ${row.minutes} min` : row.label
        button.disabled = row.enabled === false
        button.title = `${label} — ${description || ''}`
        button.setAttribute('aria-label', button.title)
        const markup = `${commonCommandIcon(row.icon, row.minutes)}<span class="chat-common-action-label">${escapeMarkup(row.label)}</span>`
        if (commonMarkup.get(row.id) !== markup) {
          button.innerHTML = markup
          commonMarkup.set(row.id, markup)
        }
      }
    }
    paintCommonActions()
  }

  return root
}

/** Tiny sparkline (single series, de-emphasis hue, accent on last point). */
export function sparkline({ points, w = 150, h = 34, color = '#00a9d8', scaleMax = null }) {
  // scaleMax lets a set of sparklines share one ceiling. Without it every
  // spark normalises to its own extremes, so a flat series and a volatile
  // one render identical amplitude — shape without magnitude.
  const DOT_R = 4, DOT_RING = 2                    // end marker radius + its ring
  const series = (Array.isArray(points) ? points : [])
    .map(v => (Number.isFinite(v) ? v : 0))
  if (!series.length) series.push(0)
  const min = scaleMax != null ? 0 : Math.min(...series)
  const max = scaleMax != null ? scaleMax : Math.max(...series)
  const spread = (max - min) || 1
  // Vertical padding is the end marker's own footprint, not a magic 5. On a
  // shared ceiling a quiet series sits on the baseline (t≈0) and its marker
  // used to reach exactly h — the outer half of the ring fell off the bottom
  // of the viewBox (SVG clips by default), so the flattest agent in the table
  // looked like a shaved dot rather than a low line. Same at the top for the
  // series that defines the ceiling.
  const padY = Math.min(h / 2, DOT_R + DOT_RING / 2 + 0.5)
  const nx = (i) => (series.length > 1 ? (i / (series.length - 1)) * (w - 8) : (w - 8) / 2) + 4
  const ny = (v) => {
    // clamp so a point above scaleMax (or below a zero floor) bends to the
    // edge of the box instead of drawing outside it and being cut off
    const t = Math.min(1, Math.max(0, (v - min) / spread))
    return h - padY - t * (h - padY * 2)
  }
  const d = series.map((v, i) => `${i ? 'L' : 'M'}${nx(i).toFixed(1)} ${ny(v).toFixed(1)}`).join(' ')
  const lx = nx(series.length - 1), ly = ny(series[series.length - 1])
  return el(`
    <svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <path d="${d}" fill="none" stroke="var(--chart-spark)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lx}" cy="${ly}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
    </svg>
  `)
}

/** Shared tooltip per container. */
export function makeTooltip(container) {
  const tip = el(`<div class="tooltip"></div>`)
  container.appendChild(tip)
  return {
    show(html, x, y) {
      tip.innerHTML = html
      tip.classList.add('show')
      const r = container.getBoundingClientRect()
      const tw = tip.offsetWidth, th = tip.offsetHeight
      let lx = x - r.left + 14, ly = y - r.top - th - 10
      if (lx + tw > r.width - 8) lx = x - r.left - tw - 14
      if (ly < 4) ly = y - r.top + 16
      tip.style.left = `${lx}px`; tip.style.top = `${ly}px`
    },
    hide() { tip.classList.remove('show') },
  }
}

/* Segmented-control indicator. Idempotent; call once per .seg after mount.
   Uses offsetLeft/offsetWidth (layout values, immune to the view-enter
   transform that forced metrics' old getBoundingClientRect inverse math).
   Returns a detach() for the view's cleanup list. */
export function attachSeg(group) {
  let ind = group.querySelector(':scope > .seg-ind')
  if (!ind) {
    ind = document.createElement('span')
    ind.className = 'seg-ind'
    ind.setAttribute('aria-hidden', 'true')
    group.prepend(ind)
  }
  /* The 'ready' writes are guarded because the indicator itself sits inside
     the observed subtree and a same-value classList.add/remove still queues a
     mutation record (measured in Chromium), so an unguarded write here is a
     MutationObserver feeding itself — an infinite microtask loop that hangs
     the page. Written only on actual change, the observer goes quiet once
     the indicator is settled. (style.width/transform are exempt: the
     observer filters on 'class' alone.) */
  const sync = () => {
    if (!group.offsetWidth) return       // hidden (comms size-seg in channels
                                         // mode): re-syncs via RO on show
    const on = group.querySelector(':scope > button.on')
    if (!on) {
      if (ind.classList.contains('ready')) ind.classList.remove('ready')
      return
    }
    /* offsetLeft, with NO clientLeft correction: measured in Chromium, a
       button 4px from the group's border edge (1px border + 3px padding)
       reports offsetLeft 3 — i.e. the value is already relative to the
       padding edge, which is exactly where the absolutely-positioned
       indicator's left:0 sits. Subtracting the border again shifted every
       indicator 1px left of its button. */
    ind.style.width = `${on.offsetWidth}px`
    ind.style.transform = `translateX(${on.offsetLeft}px)`
    if (!ind.classList.contains('ready')) ind.classList.add('ready')
  }
  const mo = new MutationObserver(sync)
  mo.observe(group, { attributes: true, attributeFilter: ['class'], subtree: true })
  const ro = new ResizeObserver(sync)
  ro.observe(group)
  document.fonts?.ready?.then(sync)
  sync()
  return () => { mo.disconnect(); ro.disconnect() }
}

/**
 * Count a readout from one number to another, in place (no layout jump).
 * Used by every morph that swaps a live figure — rail hero, metric tiles.
 * Returns a cancel function; honours body.reduce-motion by snapping.
 */
export function countUp(el, from, to, ms = 700) {
  if (!el) return () => {}
  const a = Number(from), b = Number(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return () => {}
  const decimals = Math.max(decimalsOf(a), decimalsOf(b))
  const fmt = (v) => decimals ? v.toFixed(decimals) : String(Math.round(v))
  if (a === b || !(ms > 0) || document.body.classList.contains('reduce-motion')) {
    el.textContent = fmt(b)
    return () => {}
  }
  let raf = 0
  const t0 = performance.now()
  const ease = (t) => 1 - Math.pow(1 - t, 3)          // out-cubic, settles quietly
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms)
    el.textContent = fmt(a + (b - a) * ease(t))
    if (t < 1) raf = requestAnimationFrame(step)
    else el.textContent = fmt(b)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}

function decimalsOf(n) {
  const s = String(n)
  const i = s.indexOf('.')
  return i < 0 ? 0 : Math.min(3, s.length - i - 1)
}

/**
 * One-shot channel for shared-element view transitions: a view announces the
 * screen point the next navigation should morph from, the shell consumes it.
 * Nothing here changes a route — the hash router stays exactly as it was.
 */
let pendingViewMorph = null
export function setViewMorph(morph) {
  pendingViewMorph = morph ? { ...morph, at: performance.now() } : null
}
export function takeViewMorph() {
  const m = pendingViewMorph
  pendingViewMorph = null
  return m
}

/** Runtime text updater registry — one central clock drives all timers.
 *  Implemented in ./runtime-clock.js (dependency-free so it can be tested
 *  without importing sim.js, which schedules timers at import time) and
 *  re-exported here so every existing call site is unchanged. */
export { bindRuntime, tickRuntimes } from './runtime-clock.js'
