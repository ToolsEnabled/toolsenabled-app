import { fmtRuntime } from './runtime-clock.js'
import { TreePreviewFitter } from './tree-preview-fit.js'
/* rimRole, not a local `ROLES[x] || ROLES.default` — see its header in
   src/vocab.js. It is the rule that keeps `role-<key>` inside the set the
   sheets declare a --rc for, and an undeclared --rc does not fade the ring,
   it deletes it. */
import { ROLES, rimRole, roleAppearance } from './vocab.js'
import { paintRoleColor, roleColorStyle } from './role-colors.js'
import { el, buildChat, bindRuntime, formatInlineText } from './components.js'
/* T293: a card preview shows the conversation, and the conversation is
   markdown. chatPreviewText reads the SAME parser renderChatMarkdown uses, so
   the card and the chat cannot come to disagree about what the markup was. */
import { latestNodeResponse } from './node-card-context.js'
import { dragBand, layoutTree, TREE_ROLE_RADII, TREE_LABEL_STACK, treeNodeRadius, hierarchyParents } from './tree-layout.js'
/* THE WORDS ON AN EMPTY SLOT ARE NOT WRITTEN HERE. src/fleet-tree-copy.js owns
   every sentence in the start-an-agent-from-the-tree flow — the panel, the
   refusals, the tree names and these two — and it says at length why one flow
   rendered by six files needs one voice. A second wording invented in this file
   would be the exact defect that module exists to prevent, and it would be the
   one on the screen every new customer opens. */
import { EMPTY_NODE, SECOND_TREE } from './fleet-tree-copy.js'
import { laneMarksView, readCloudLane } from './lane-marks.js'
import { attachResizeHandle } from './resize-handle.js'
import { textZoom } from './text-size.js'
import { TreeScope, TREE_COLLAPSE_AT, branchSummaryText, countNoun } from './tree-scope.js'
import { TREE_CONTEXT_CARDS_KEY, TREE_CONTEXT_BOX_SIZE_KEY, TREE_CONTEXT_CARDS_EVENT, TREE_CONTEXT_SIZES, agentTreeContextKeys, readTreeContextCards, treeContextProfile, updateTreeContextCards } from './tree-context-cards.js'
import { TREE_CARDS_KEY, TREE_CONTEXT_SIZE_KEY, liveContextSize, treeBoxSize, treeCardSize, layoutBoxTree, boxPort } from './tree-box-layout.js'
import { TreeWorkspace } from './tree-workspace.js'
import { mergeTreeStrokeRoutes } from './tree-stroke-paths.js'
import { chooseTreeProjection } from './tree-readability.js'
import { clearLinkMarkerPoint } from './tree-link-marker.js'

/* Density guides focus and drill-in; it must not withdraw a legal add action. */
const DENSE_AT = TREE_COLLAPSE_AT
const STRUCTURAL_MS = 680
const REMOVE_MS = 150
const SCREEN_CHIP_W = 280
const SCREEN_CHIP_H = 126
/* 420, not 360: the owner's picked chat card ("Dense — light-mode palette")
   sets the Card width at 420px (design/chat/picked-card.png; SIZING LAW,
   design/chat/Sizes.dc.html -- width may never change a padding, type size,
   radius or border, only which of Card 420 / Panel 520 / Full is showing).
   The only other place 360 appeared in this file was as part of an unrelated
   screen-resolution literal in a historical bug note ("1360x700", "360x368
   panel") -- not a derived value -- so this is the one number that needed to
   move. */
const SCREEN_CHAT_W = 420
const SCREEN_EDGE = 8
const SCREEN_TOP = 72
const SCREEN_CHIP_GAP = 5
const ROLE_PRIORITY = { controller: 6, coordinator: 6, helper: 5, shadow: 5, manager: 4, planner: 3, reviewer: 3, builder: 2, default: 2, worker: 1, spawned: 1 }
/* 2.4x, not 1.7x: the owner's ask was to zoom in far enough to READ a card, and
   1.7 stopped short of that on a 1440-wide window. */
const ZOOM_MIN = 0.05
const ZOOM_MAX = 2.4
// Almost three times farther out than Fit: ample space around the whole
// forest, with a definite end before it disappears into an empty canvas.
const ZOOM_OUT_FIT_RATIO = 0.35
const NODE_MIN_SCALE = 0.7
const ZOOM_FIT_MIN = 0.05
const CLICK_CHAT_DELAY = 260
// A collapsed branch is not an agent: it keeps its neutral role color, not an agent's own accent.
const accentIdOf = agent => agent?.treeScope?.group ? null : agent?.id
/* Breathing room around a fitted tree, in host pixels: a circle flush against
   the pane's edge reads as cut off rather than as complete. */
const FIT_PAD = 10
// Separate entry and exit thresholds prevent a wheel reversal from flickering
// between scopes. Each user input can enter or leave at most one level.
const ZOOM_DRILL_AT = 1.6
const ZOOM_DRILL_OUT_AT = 0.85
const DRILL_RADIUS = 96
// Content may be dragged until only this much of it is left on screen; it can
// never be pushed away entirely, and it is never locked in place either.
const PAN_KEEP = 160
/* Edge auto-pan while a node is held (see _dragAutoPan): the band, in
   pane pixels, inside which the view starts moving, and the most it moves
   per frame at the very edge. */
const DRAG_EDGE = 56
const DRAG_PAN_MAX = 18
// How far a context block may sit from its own circle before it stops reading
// as that circle's block. Measured against the card, not guessed: a 260px card
// one card-width away still scans as attached; two away does not.
const CHIP_REACH = 380
const HIERARCHY_TYPES = new Set(['manages', 'delegates_to', 'hierarchy'])

/* ============================================================================
   EMPTY SLOTS — the pressable holes in the tree.

   THE STATE THIS EXISTS FOR. A fresh install has started nothing, so this
   canvas has nothing to draw, and a canvas with nothing on it teaches nobody
   what it is for. The owner's instruction: "we should essentially draw EMPTY
   nodes, and the user just presses them to extend their existing structure."
   So absence is drawn as an offer rather than as blankness — a dashed circle
   hanging where the next agent would go, and one at the top for a tree that
   does not exist yet, because a computer may hold MORE THAN ONE tree.

   WHAT A SLOT IS NOT. It is not an agent, it is not in `this.nodes`, it is not
   in the node count the performance probe publishes, it carries no runtime, no
   role hue, no context card, and it is not a drop target in edit mode. Nothing
   in this file starts anything when one is pressed: the press is reported and
   that is all it does. Two other surfaces own what happens next.

   AND IT IS NOT `.static-tree-node`. That class means "a running agent" to
   nine QA harnesses on this tree — they count it, click the first one to open
   the rail, and assert that every one of them carries a role- token whose hue
   matches its ring (tools/page2-qa.cjs). A slot wearing that class would make
   all nine quietly measure something that is not an agent, and the role-token
   assertion would go red on a circle that correctly has no role. So a slot
   shares no class, no data attribute and no map with an agent node. The only
   thing the two share is the canvas they are positioned on.
   ============================================================================ */

/* The floor src/tree-layout.js already calls readable, which is also the
   SMALLEST a node on this canvas is allowed to be: a slot is subordinate to
   every agent around it by construction, and cannot be shrunk further. */
const EMPTY_SLOT_RADIUS = 34
/* The drop threshold's slack beyond exact circle contact. Must keep the hit
   distance >= the packed non-overlap distance (MIN_AIR in tree-layout.js is
   2), or an annulus reappears where two nodes visually touch and a release
   registers on neither. */
const DROP_SLOP = 8
/* Sorted out of a crowded rank before any agent (see keepReadable), and placed
   after its own siblings inside its family (see orderHint). An offer is the
   first thing a rank should drop and the last thing a family should list. */
const EMPTY_SLOT_CULL_RANK = 9000
const EMPTY_SLOT_ORDER_HINT = 1
const NEW_TREE_SLOT_ID = 'empty:new-tree'
const CHILD_SLOT_PREFIX = 'empty:child:'

/* The DOM event a slot press dispatches on the graph container, bubbling, in
   addition to the onEmptyPress callback. Two ways in because the two consumers
   are different shapes: the view that constructs this graph has the callback,
   and anything upstream that only has the wrap element can listen. */
export const TREE_EMPTY_PRESS_EVENT = 'tree-empty-press'
export const TREE_POSITIONS_READ_FAILED = 'TREE_POSITIONS_READ_FAILED'
export const TREE_CONTEXT_READ_FAILED = 'TREE_CONTEXT_READ_FAILED'

/* A SLOT DRAWS A "+" AND NO TEXT, SO ITS ACCESSIBLE NAME IS ALL IT SAYS.
   A dashed ring with a plus is read by a sighted person in a glance and by a
   screen reader as nothing at all, so the name is not decoration here — it is
   the entire label of a button. Both strings below are src/fleet-tree-copy.js's
   own, used verbatim.

   The two cases are not the same sentence. "Start another tree" is true beside
   a tree that already exists and false on a canvas where nothing has ever run,
   where the honest reading of the one circle on screen is the same offer every
   other slot makes: an empty spot, press it. So the top-rank slot borrows the
   ordinary empty-spot wording until the computer being drawn has a tree to be another one
   of. The tooltip carries the hint, which is what a hint is for. */
const slotWords = (kind, hasTree) => kind === 'new-tree' && hasTree
  ? { name: SECOND_TREE.action, hint: SECOND_TREE.help }
  : { name: EMPTY_NODE.ariaLabel, hint: EMPTY_NODE.hint }

const calm = () => document.body.classList.contains('reduce-motion')
  || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))
/* A NUMBER SOMEBODY MEASURED, OR NOTHING. NEVER ZERO FOR "NOBODY SAID".
 *
 * `Number(null)` is 0 and `Number('')` is 0, and the chip preview used to run
 * both of those through `Number()`. src/declared-fleet.js deliberately omits
 * tasksDone and failRate -- a declared organisation says what is CONFIGURED,
 * not what has run -- and projectedComputer() normalises that absence to null.
 * The coercion then turned it into a measurement, so the one node on the fleet
 * graph of a copy with no agent host read "0 tasks · 0% fail" beside a rail
 * saying "runtime, load, tasks, and messages unavailable · not provided by
 * fleet projection". Measured in the packaged window on a sterile profile
 * (tools/offline-routes-qa.mjs, artifacts/b7/connected-computers.png).
 *
 * A numeric string is still accepted, because a projection is JSON written by
 * something else and "12" is a number somebody wrote down. An empty string is
 * not: it is the same absence with a different spelling. */
const measuredNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}
const overlap = (a, b) => {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}
const center = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
/* Does the segment a→b pass through the disc at c? A leader that crosses a
   third circle on its way to its own card asserts a relationship that is not
   there, which is worse than no leader at all. */
const segmentHitsDisc = (ax, ay, bx, by, cx, cy, radius) => {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared))
    : 0
  return Math.hypot(ax + dx * t - cx, ay + dy * t - cy) < radius
}
/* …and the same question for a label box. A leader ruled through another
   node's NAME misattributes just as badly as one ruled through its circle;
   testing only circles let the 1920 layout fill up with crossing leaders. */
const segmentHitsBox = (ax, ay, bx, by, box) => {
  const inside = (x, y) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
  if (inside(ax, ay) || inside(bx, by)) return true
  const cross = (x1, y1, x2, y2, x3, y3, x4, y4) => {
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if (Math.abs(d) < 1e-9) return false
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    return t >= 0 && t <= 1 && u >= 0 && u <= 1
  }
  const { x, y, w, h } = box
  return cross(ax, ay, bx, by, x, y, x + w, y)
    || cross(ax, ay, bx, by, x + w, y, x + w, y + h)
    || cross(ax, ay, bx, by, x + w, y + h, x, y + h)
    || cross(ax, ay, bx, by, x, y + h, x, y)
}

const cubicBezierEase = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const solveX = (t) => ((ax * t + bx) * t + cx) * t
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx
  return (amount) => {
    if (!(amount > 0)) return 0
    if (amount >= 1) return 1
    let t = amount
    for (let index = 0; index < 6; index += 1) {
      const error = solveX(t) - amount
      if (Math.abs(error) < 1e-5) break
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    return ((ay * t + by) * t + cy) * t
  }
}
const structuralEase = cubicBezierEase(0.42, 0, 0.18, 1)

const monitorBrace = (right = false) => `
  <span class="monitor-brace${right ? ' is-right' : ''}" aria-hidden="true">
    <svg width="12" height="14" viewBox="0 0 12 14"><path d="M11 1.5 H10 C6.4 1.5 4.5 3.4 4.5 7 V14"/></svg>
    <svg class="monitor-brace-arm" viewBox="0 0 12 8" preserveAspectRatio="none"><path d="M4.5 0 V8"/></svg>
    <svg width="12" height="28" viewBox="0 0 12 28"><path d="M4.5 0 V7 C4.5 11 3.4 12.5 1.5 14 C3.4 15.5 4.5 17 4.5 21 V28"/></svg>
    <svg class="monitor-brace-arm" viewBox="0 0 12 8" preserveAspectRatio="none"><path d="M4.5 0 V8"/></svg>
    <svg width="12" height="14" viewBox="0 0 12 14"><path d="M4.5 0 V7 C4.5 10.6 6.4 12.5 10 12.5 H11"/></svg>
  </span>`

let probeOwner = null
let chatZ = 20

export class StaticTreeGraph {
  constructor(container, {
    computer,
    rootId = null,
    onRootChange = null,
    onSelect = null,
    onOpenControls = null,
    onContact = null,
    screenChips = true,
    contextFeed = null,
    edges = null,
    communicationLinks = [],
    onLinkChange = null,
    onReparent = null,
    treeChat = null,
    onMountChatDraft = null,
    onMountChatControls = null,
    onOverridesChange = null,
    emptySlots = true,
    onEmptyPress = null,
    canExtend = null,
    extensionPoints = null,
    canDrag = null,
    canReparent = null,
    onDropRefused = null,
    onDetachToNewTree = null,
    nodeStyle = 'circles',
    circleCards = true,
    cardSize = 'medium',
    standaloneAgent = null,
    onPlaceStandalone = null,
    tabbedWorkspace = false,
    chatOwner = null,
    compactControls = false,
  } = {}) {
    this.container = container
    this.computer = computer
    this.rootId = rootId
    this.nodeStyle = nodeStyle === 'boxes' ? 'boxes' : 'circles'
    this.circleCards = circleCards !== false
    this.cardSize = liveContextSize(cardSize) || 'medium'
    this.standaloneAgent = standaloneAgent
    this.onPlaceStandalone = onPlaceStandalone
    this.tabbedWorkspace = tabbedWorkspace
    this.smartScope = !!(tabbedWorkspace || chatOwner)
    this.chatOwner = chatOwner
    this.compactControls = compactControls
    this.onRootChange = onRootChange
    this.onSelect = onSelect
    this.onContact = typeof onContact === 'function' ? onContact : null
    this.onMountChatDraft = typeof onMountChatDraft === 'function' ? onMountChatDraft : null
    this.onMountChatControls = typeof onMountChatControls === 'function' ? onMountChatControls : null
    this.contactMarks = {}
    this.onOpenControls = typeof onOpenControls === 'function' ? agent => {
      this.workspace?.showTrees({ focus: false })
      this.setWide(false)
      onOpenControls(agent)
    } : null
    this.screenChips = screenChips === true
    this.contextFeed = typeof contextFeed === 'function' ? contextFeed : null
    this.communicationLinks = communicationLinks
    this.onLinkChange = onLinkChange
    this.declaredEdges = Array.isArray(edges) ? edges : null
    this.onReparent = typeof onReparent === 'function' ? onReparent : null
    this.treeChat = typeof treeChat === 'function' ? treeChat : null
    this.onOverridesChange = typeof onOverridesChange === 'function' ? onOverridesChange : null
    this.emptySlotsEnabled = emptySlots !== false
    this.onEmptyPress = typeof onEmptyPress === 'function' ? event => {
      this.workspace?.showTrees({ focus: false })
      this.setWide(false)
      onEmptyPress(event)
    } : null
    /* (agent | null) => boolean — "may a child hang here?", asked of the model
       before a slot is drawn, with null meaning "may a new tree begin?". Absent
       on a mount that has no such rule, in which case every position is drawn.
       See _planEmptySlots for why the rule is injected and not imported. */
    this.canExtend = typeof canExtend === 'function' ? canExtend : null
    // Optional bulk offer reader. Captured once per full reconcile; a streamed
    // preview reads the same render snapshot without consulting the store.
    // These are affordances only. The store still admits each mutation afresh.
    this.extensionPoints = typeof extensionPoints === 'function' ? extensionPoints : null
    /* (agent) => boolean — "may this node be picked up at all?". Injected
       because the graph cannot know the answer: the old inline rule was
       `role !== 'coordinator'`, and TREE roles are free text — a node a
       person happened to NAME "coordinator" was silently undraggable. The
       view owns the data model, so the view supplies the rule; absent, every
       node drags, which is the honest default for a canvas about moving
       things. */
    this.canDrag = typeof canDrag === 'function' ? canDrag : null
    // Read canonical admission for the hover affordance; the store still admits the drop.
    this.canReparent = typeof canReparent === 'function' ? canReparent : null
    /* (sentence) => void — where the drag refusals speak. A drop the model
       refuses says WHY in the page's own status line; a wiggle with no words
       reads as a bug, not a rule. */
    this.onDropRefused = typeof onDropRefused === 'function' ? onDropRefused : null
    /* (nodeId) => boolean — the new-tree slot's drop: detach this branch into
       its own tree. Injected like onReparent, and for the same reason: the
       store is the only author of tree shape. */
    this.onDetachToNewTree = typeof onDetachToNewTree === 'function' ? onDetachToNewTree : null
    /* Deliberately a second map, never merged into `this.nodes`. Everything
       that reads `this.nodes` — the chips, the runtime bindings, the drag and
       reparent path, the selection, the published node count — is written
       against a record that HAS an agent. A slot has no agent, and the way to
       keep that true is for it to be somewhere else. */
    this.emptySlots = new Map()
    this.nodes = new Map()
    this.selectedId = null
    this.layout = 'tree'
    this.editMode = false
    this.unsubs = []
    this._destroyed = false
    this._layoutVisibleIds = new Set()
    this._culled = new Set()
    this._layoutResult = null
    /* A nudge saved or cleared is a geometry change the structure key cannot
       see from the agent list, so the store bumps this counter. */
    this._positionsRevision = 0
    this._layoutKey = null
    /* Density is a fact about the FLEET, so it is measured on a layout of the
       fleet alone — see _layoutNow for the loop this closes. */
    this._realDrillRequired = false
    this._dropRec = null
    this._dropRaw = null
    this._animationRaf = 0
    this._addRafs = new Set()
    this._removeTimers = new Set()
    this._chatTimers = new Set()
    this._transitionRevision = 0
    const cardPolicy = readTreeContextCards(undefined, this.cardSize)
    this._contextPolicy = cardPolicy.record
    this._contextPolicyReadable = cardPolicy.ok
    this._contextPolicyError = cardPolicy.reason || ''
    this._contextRevision = 0
    if (cardPolicy.ok) this.cardSize = cardPolicy.boxSize

    container.classList.add('graph-canvas', 'static-tree-graph', 'zoomable')
    container.dataset.layout = 'tree'
    container.dataset.nodeStyle = this.nodeStyle
    container.dataset.cardSize = this.cardSize
    this._syncCardMetrics()
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.svg.setAttribute('class', 'links static-tree-links')
    this.svg.setAttribute('aria-hidden', 'true')
    container.appendChild(this.svg)

    this.zoomHost = container.parentElement || container
    this.zoomHost.classList.add('graph-zoom-host', 'static-tree-host')
    this.zoom = 1
    this.spacious = true
    this.panX = 0
    this.panY = 0
    this.W = container.clientWidth || 800
    this.H = container.clientHeight || 600

    if (this.screenChips) {
      this._buildChipOverlay()
      if (!this.chatOwner) this._buildConversationShelf()
    }
    this._buildFitControl()
    this._onContextCardsChange = event => {
      if (this._destroyed) return
      if (event?.type === 'storage' && event.key != null && event.key !== TREE_CONTEXT_CARDS_KEY && event.key !== TREE_CONTEXT_BOX_SIZE_KEY && event.key !== TREE_CONTEXT_SIZE_KEY) return
      const read = readTreeContextCards()
      this._contextPolicyReadable = read.ok
      this._contextPolicyError = read.reason || ''
      if (read.ok) this._applyContextCardPolicy(read.record, read.boxSize)
      this._syncContextCardControl()
      if (this.contextCardNotice) this.contextCardNotice.textContent = read.ok ? '' : read.reason
    }
    window.addEventListener(TREE_CONTEXT_CARDS_EVENT, this._onContextCardsChange)
    window.addEventListener('storage', this._onContextCardsChange)
    this._wireHostInteractions()
    this._onDocumentKeydown = (event) => this._escapeTopChat(event)
    document.addEventListener('keydown', this._onDocumentKeydown)

    this._positions = this._readPositions()
    this.previewFitter = new TreePreviewFitter()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    if (this.screenChips && this.zoomHost !== container) this.ro.observe(this.zoomHost)

    this._detailBudget = this._detailLimit()
    this._reconcile({ initial: true })
    this._publishProbe()
  }

  /* THIS PROBE REPORTED PERFORMANCE NUMBERS IT HAD NEVER MEASURED.
   *
   * Three of the four counters were written once, here, to 0, and never updated
   * again by anything -- their only other mention in the tree is the teardown
   * that clears them. So anyone reading __graphFrameMs to find out what the
   * graph costs got 0, which does not read as "unmeasured". It reads as
   * INSTANT: the most flattering answer available, arrived at without timing
   * anything. __graphStress was the same shape, always answering avgGraphMs: 0.
   *
   * That is the defect this codebase polices everywhere else -- an inability to
   * measure must be distinguishable from a measurement that came back fine. It
   * matters more than usual here because these are the only numbers anyone has
   * to judge the tree by, and the tree is the screen the product is built
   * around: a rewrite justified by "the graph is already fast" would be
   * justified by a literal that nothing produced.
   *
   * So: null where nothing measures it, and a stress probe that actually runs.
   * null is deliberate rather than 0 or a missing key -- it is a value a reader
   * can branch on, and it cannot be mistaken for a fast result.
   *
   * WHAT IT MEASURES IS NAMED HONESTLY. layoutTree is pure, so timing it is
   * both easy and real; the repaint that follows -- the DOM writes, the chip
   * placement, the browser's own layout and paint -- is NOT covered. Hence
   * avgLayoutMs, not avgGraphMs. The old name claimed the whole frame. */
  _publishProbe() {
    probeOwner = this
    window.__graphFrameMs = null
    window.__pageFrameMs = null
    window.__graphTickMs = null
    window.__graphNodeCount = this.nodes.size
    window.__graphStress = async (runs = 20) => {
      if (!Number.isFinite(runs) || runs < 1) {
        return { nodes: this.nodes.size, measured: false, why: 'runs must be a positive number' }
      }
      const agents = this._layoutAgents()
      const edges = this.declaredEdges || []
      /* One pass first, unmeasured, so the timed passes are not paying for
         whatever this engine does on a function's first call. */
      layoutTree({ nodes: agents, edges, W: this.W, H: this.H })
      const started = performance.now()
      for (let run = 0; run < runs; run += 1) {
        layoutTree({ nodes: agents, edges, W: this.W, H: this.H })
      }
      const elapsed = performance.now() - started
      return {
        nodes: this.nodes.size,
        laidOut: agents.length,
        runs,
        avgLayoutMs: elapsed / runs,
        measured: true,
        covers: 'layoutTree only; not the DOM writes, chip placement, or browser paint',
      }
    }
  }

  _positionKey() {
    return `mc.tree.pos.${this.computer?.id || 'unknown'}${this.nodeStyle === 'boxes' ? '.boxes' : ''}`
  }

  _boxSize() { return treeBoxSize(this.cardSize) }

  _syncCardMetrics() {
    const size = this._boxSize()
    this.container.dataset.cardSize = this.cardSize
    this.container.style.setProperty('--tree-box-width', `${size.width}px`)
    this.container.style.setProperty('--tree-box-height', `${size.height}px`)
    if (this.screenOverlay) this.screenOverlay.dataset.cardSize = this.cardSize
  }

  setNodeStyle(style) {
    if (this.chatOwner) { this.chatOwner.setNodeStyle(style); return }
    if (this.editMode) return
    const next = style === 'circles' ? 'circles' : 'boxes'
    for (const graph of this.treeWindows?.windows.map(frame => frame.graph) || [this]) {
      if (graph.nodeStyle === next) continue
      graph._setRenderStyle(next)
      graph._viewSteered = false
      graph._reconcile()
      graph.fitCurrentTree()
    }
    try { localStorage.setItem('mc.set.tree_style', next) } catch { /* session choice still applies */ }
    this.treeWindows?.toolbar?.sync()
  }

  _setRenderStyle(next) {
    if (this.nodeStyle === next) return
    this._cancelZoomMotion()
    this.nodeStyle = next
    this.container.dataset.nodeStyle = next
    this._positions = this._readPositions()
    this._positionsRevision++
    if (this.cardsToggle) this.cardsToggle.hidden = next !== 'circles'
    for (const record of [...this.nodes.values()]) {
      this.previewFitter.forget(record)
      record.runtimeUnsub?.()
      record.chipRuntimeUnsub?.()
      clearTimeout(record.clickTimer)
      record.chip?.remove()
      record.chipLeader?.remove()
      record.chipLeaderDot?.remove()
      record.el.remove()
      this._createRecord(record.agent, false, record)
    }
    this._layoutKey = null
  }

  setCardSize(size) {
    if (this.chatOwner) { this.chatOwner.setCardSize(size); return }
    const next = liveContextSize(size) || 'medium'
    const graphs = this.treeWindows?.windows.map(frame => frame.graph) || [this]
    const treeKeys = [...new Set(graphs.flatMap(graph => graph._contextTreeKeys()))]
    // The existing toolbar controls the shared box size and the detached
    // cards in view. A saved override must not silently defeat that choice.
    const result = updateTreeContextCards({ defaultSize: next, ...(treeKeys.length ? { treeKeys, size: next } : {}) })
    if (result.ok) {
      for (const graph of graphs) graph._applyContextCardPolicy(result.record, result.boxSize)
      try { localStorage.setItem(TREE_CONTEXT_SIZE_KEY, next) } catch { /* Canonical policy is already saved. */ }
    }
    if (this.contextCardNotice) this.contextCardNotice.textContent = result.ok ? '' : result.reason
    this._syncContextCardControl()
    this.treeWindows?.toolbar?.sync()
    return result
  }

  _readPositions() {
    try {
      const raw = localStorage.getItem(this._positionKey())
      if (raw == null) return {}
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('saved tree positions are not an object')
      }
      const clean = {}
      for (const [id, value] of Object.entries(parsed)) {
        const dx = Number(value?.dx)
        const dy = Number(value?.dy)
        /* v2 ONLY — an override is a nudge RELATIVE TO a slot, and the slot
           follows the node's parent. A v1 entry {dx,dy} recorded no parent,
           so after any reparent it displaced the node from its NEW slot by a
           vector measured against the OLD one: the saved-drag defect behind
           the stale connector lines (owner defect 2). It cannot be validated
           retroactively — the parent it was measured under is gone — and
           keeping it preserves exactly the displacement being fixed, so v1
           blobs are discarded on read. Costs any hand-arrangement once, said
           plainly in the release note. */
        if (value?.v !== 2) continue
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          clean[id] = { v: 2, dx, dy, parentId: value.parentId ?? null, at: Number(value.at) || 0 }
        }
      }
      return clean
    } catch (cause) {
      /* An unreadable key is not an empty key. In particular, localStorage can
         throw while the browser is short of file descriptors or its backing
         store is busy. Returning {} here used to latch "no saved positions"
         into this graph for its entire lifetime: hasPositionOverrides() then
         hid the caller's Reset button even though no absence was observed. */
      const error = new Error('Saved tree positions could not be read; this is not claiming that no saved positions exist.', { cause })
      error.code = TREE_POSITIONS_READ_FAILED
      throw error
    }
  }

  _writePositions() {
    /* Every save and every clear passes through here, so this is the one
       place the structure key needs to hear about a nudge. */
    this._positionsRevision += 1
    try {
      if (Object.keys(this._positions).length) {
        localStorage.setItem(this._positionKey(), JSON.stringify(this._positions))
      } else {
        localStorage.removeItem(this._positionKey())
      }
    } catch { /* device-local preference storage is best effort */ }
    this.onOverridesChange?.(this.hasPositionOverrides())
  }

  hasPositionOverrides() {
    return Object.keys(this._positions).length > 0
  }

  resetPositions() {
    this._positions = {}
    this._writePositions()
    this._layoutNow()
  }

  _clearPosition(id) {
    if (!Object.hasOwn(this._positions, id)) return
    delete this._positions[id]
    this._writePositions()
  }

  /* _subscribe() lived here: five sim.on(...) wires that animated the old
     demonstration engine's spawn/reap/context drift. Every handler filtered on
     object identity against sim's own computer records, so once the example
     began flowing through mountProjection like real data, they could never
     match again -- live subscriptions for this graph arrive through the
     projection re-render path instead. Deleted with the engine; the example
     fleet is deliberately STATIC now, the same way the example run record is:
     deterministic data that holds still for a screenshot. */


  _detailLimit() {
    const width = this.zoomHost?.clientWidth || this.W
    // Below twenty agents the shape stays literal. Larger forests can reveal
    // fewer branches on a laptop, keeping their circles and names readable.
    return width < 1000 ? Math.max(5, Math.floor(width / 80)) : TREE_COLLAPSE_AT
  }

  _scopeModel() {
    const agents = this.computer?.agents || []
    if (!this._treeScope) this._treeScope = new TreeScope(agents, this.declaredEdges || [])
    else if (this._scopeInput !== agents || this._scopeEdges !== this.declaredEdges) {
      this._treeScope.update(agents, this.declaredEdges || [])
    }
    this._scopeInput = agents
    this._scopeEdges = this.declaredEdges
    return this._treeScope
  }

  _scopeAgentCount() {
    if (this.editMode && this._editRootIds) return new Set(this._editRootIds.flatMap(id => this._scopeModel().branch(id))).size
    if (this.rootId) return this._scopeModel().branch(this.rootId).length
    if (this.windowRootIds) return new Set(this.windowRootIds.flatMap(id => this._scopeModel().branch(id))).size
    return this.computer?.agents?.length || this._layoutVisibleIds?.size || 0
  }

  visibleAgents(rootId = this.rootId) {
    const agents = Array.isArray(this.computer?.agents) ? this.computer.agents : []
    if (this.smartScope && this.editMode) return this._scopeModel().project(null, {
      collapse: false, rootIds: this._editRootIds || this.windowRootIds || null,
    })
    if (this.smartScope && !this.editMode) return this._readableAgents(rootId)
    if (this.windowRootIds && !rootId && !this.editMode) return this._scopeModel().project(null, {
      detailLimit: this._detailLimit(), rootIds: this.windowRootIds,
    })
    if (!this.editMode && (agents.length >= TREE_COLLAPSE_AT || this._treeScope?.groups.has(rootId))) return this._scopeModel().project(rootId, { detailLimit: this._detailLimit() })
    if (!rootId) return [...agents]
    const keep = new Set([rootId])
    let changed = true
    while (changed) {
      changed = false
      for (const agent of agents) {
        if (agent.parentId && keep.has(agent.parentId) && !keep.has(agent.id)) {
          keep.add(agent.id)
          changed = true
        }
      }
    }
    return agents.filter(agent => keep.has(agent.id))
  }

  _readableAgents(rootId = this.rootId) {
    const scope = this._scopeModel()
    const rootIds = this.windowRootIds || null
    if (this._linkMode) {
      const selected = new Set(rootIds || scope.children.get(null) || [])
      return (scope.children.get(null) || []).filter(id => selected.has(id)).map(id => {
        const summary = scope.summary(id)
        return { ...scope.agent(id), parentId: null,
          treeScope: { summary, hidden: summary.total - 1, group: false, expandable: false } }
      })
    }
    const key = JSON.stringify([rootId || null, rootIds, this.nodeStyle, this.cardSize])
    const W = this.zoomHost?.clientWidth || this.W
    const H = this.zoomHost?.clientHeight || this.H
    this._projectionMemory ||= new Map()
    const previous = this._projectionMemory.get(key)
    // Gestures move the camera, not the layout. Only a changed branch,
    // topology, style or settled viewport can choose a different frontier.
    if (previous && previous.revision === this._scopeRevision && previous.scope === scope && previous.input === this._scopeInput && previous.edges === this._scopeEdges &&
      (previous.W === W && previous.H === H || this._panState || this._zoomMotion)) {
      this._projection = previous.result
      return previous.result.agents
    }
    const result = chooseTreeProjection({ scope, rootId, rootIds, nodeStyle: this.nodeStyle,
      W, H, contextSize: this.cardSize, previousFolded: previous?.result.folded })
    this._projectionMemory.set(key, { input: this._scopeInput, edges: this._scopeEdges, revision: this._scopeRevision, scope, W, H, result })
    if (this._projectionMemory.size > 64) this._projectionMemory.delete(this._projectionMemory.keys().next().value)
    this._projection = result
    return result.agents
  }

  ancestryOf(id) {
    if (this.nodeStyle === 'boxes') return this._scopeModel().ancestry(id)
    if (this._treeScope?.groups.has(id)) return this._scopeModel().ancestry(id)
    const byId = new Map((this.computer?.agents || []).map(agent => [agent.id, agent]))
    const chain = []
    let current = byId.get(id)
    const seen = new Set()
    while (current && !seen.has(current.id) && chain.length < 20) {
      seen.add(current.id)
      chain.unshift({ id: current.id, name: current.name })
      current = current.parentId ? byId.get(current.parentId) : null
    }
    return chain
  }

  renderAncestry() {
    this.onRootChange?.(this.rootId, this.rootId ? this.ancestryOf(this.rootId) : [])
  }

  _agentFor(id) {
    return (this.computer?.agents || []).find(agent => agent.id === id) || this._treeScope?.agent(id) || null
  }

  _layoutAgents() {
    const agents = this.visibleAgents()
    if (!this.rootId) return agents
    return agents.map(agent => ({
      ...agent,
      parentId: agent.id === this.rootId ? null : agent.parentId,
      tierRank: undefined,
    }))
  }

  _refreshExtensionPoints() {
    if (this.extensionPoints) {
      let parents
      try {
        const points = this.extensionPoints()
        parents = points === null ? null : new Set(points.map(point => point.parentId))
      } catch { parents = new Set() } // Never retain allowances from a failed read.
      const previous = this._extensionParents
      if (parents?.size !== previous?.size || (parents && [...parents].some(id => !previous?.has(id)))) {
        this._extensionRevision = (this._extensionRevision || 0) + 1
      }
      this._extensionParents = parents
    }
  }

  _reconcile({ initial = false, addIds = new Set() } = {}) {
    this._refreshExtensionPoints()
    const visible = this.visibleAgents()
    const wanted = new Set(visible.map(agent => agent.id))
    const all = new Map((this.computer?.agents || []).map(agent => [agent.id, agent]))
    for (const [id, record] of [...this.nodes]) {
      if (!wanted.has(id) && !(record.chatOpen && all.has(id))) this._removeRecord(record, !initial)
      else if (!wanted.has(id)) {
        record.agent = all.get(id)
        this._refreshChatSession(record)
      }
    }
    for (const agent of visible) {
      const existing = this.nodes.get(agent.id)
      if (existing) {
        existing.el.classList.remove('tree-node-removing')
        existing.agent = agent
        for (const element of [existing.el, existing.chip, existing.chipLeader, existing.chipLeaderDot]) paintRoleColor(element, agent.declaredRole || agent.role, accentIdOf(agent))
        const parentId = agent.parentId || ''
        if (existing.el.dataset.parentId !== parentId) existing.el.dataset.parentId = parentId
        /* THE CIRCLE FOLLOWS THE RECORD IT ALREADY HAS. Measured 2026-08-13 on
           the installed build: this branch swapped `agent` and stopped, so a
           node created as a draft kept "no signal / no runtime" for the life of
           the mount while its real session started, ran and finished -- the
           status transitions only ever appeared after a full remount. The
           renderers below skip work when nothing they draw from has changed. */
        this._renderRuntime(existing)
        this._renderAccessibleName(existing)
        this._renderScope(existing)
        this._renderContactMark(existing)
        this._renderLaneMarks(existing)
        this._renderResearchMark(existing)
        this._renderChipPreview(existing)
        this._refreshChatSession(existing)
        continue
      }
      this._createRecord(agent, !initial || addIds.has(agent.id))
    }
    /* GEOMETRY FOLLOWS STRUCTURE, NOT TICKS (owner, iteration 7: "the tree
       action is a mess like the way it moves and such").
       Every reply, usage reading and status change reached this line, and
       _layoutNow re-runs the packers AND the vertical fitter — which is
       allowed to rescale every radius in the tree. Nodes carry no transition
       on left/top, so each of those re-packs was an instant jump: circles
       moving and changing size while the person watched an agent talk.
       Nothing about a status word can change where a circle belongs, so the
       layout is skipped unless the SHAPE changed. The renderers above have
       already refreshed what those events actually alter — the ring, the
       runtime, the chip preview. */
    this._syncConversationShelf()
    if (this._layoutResult && this._layoutKey === this._structureKey()) {
      this._publishNodeCount()
      return
    }
    this._layoutNow()
    this._publishNodeCount()
  }

  /* What a layout is a function of. Two passes with the same key must produce
     the same geometry, so everything the placement reads is in here — and
     nothing that merely changes what a node SAYS. */
  _structureKey() {
    const shape = this._layoutAgents()
      .map(agent => `${agent.id}|${agent.parentId || ''}|${agent.role || ''}|${agent.name || ''}`)
      .join(';')
    const edges = (this.declaredEdges || [])
      .map(edge => `${edge.from || edge.source || ''}>${edge.to || edge.target || ''}`)
      .join(',')
    return [
      this.rootId || '',
      this.editMode ? 'edit' : 'view',
      this.spacious ? 'spacious' : 'compact',
      this.nodeStyle, this.cardSize,
      Math.round(this.W),
      Math.round(this.H),
      this._positionsRevision,
      this._contextRevision || 0,
      this._extensionRevision || 0,
      edges,
      shape,
    ].join('~')
  }

  /* WHAT A SCREEN READER HEARS FOLLOWS THE NAME ON SCREEN (T1464). A move
     can rename a circle (a per-tree ordinal, or a cross-tree id suffix), and
     the visible name is refreshed from the record while the accessible name
     was written once, when the element was made. Every refresh of a record
     now rewrites the circle's label and its name-bearing chat button too.
     Group cards keep the label _renderRuntime gives them. */
  _renderAccessibleName(record) {
    const agent = record?.agent
    if (!agent || !record.el || agent.treeScope?.group) return
    const role = roleAppearance(agent.declaredRole || agent.role)
    const label = `${agent.name} — ${role.label}; Shift+Enter opens controls`
    if (record.el.getAttribute('aria-label') !== label) record.el.setAttribute('aria-label', label)
    const chat = record.el.querySelector?.('.tree-box-chat')
    const words = `Open ${agent.name} in a chat tab`
    if (chat && chat.getAttribute('aria-label') !== words) chat.setAttribute('aria-label', words)
  }

  _publishNodeCount() {
    if (probeOwner === this) window.__graphNodeCount = this.nodes.size
  }

  _createRecord(agent, fadeIn, existing = null) {
    const role = roleAppearance(agent.declaredRole || agent.role)
    const radius = treeNodeRadius(agent)
    const node = el(`
      <div class="node static-tree-node role-${rimRole(agent.role)}${agent.state === 'spawning' ? ' spawning' : ''}${fadeIn ? ' tree-node-adding' : ''}" style="--d:${radius * 2}px;${roleColorStyle(agent.declaredRole || agent.role, accentIdOf(agent))}">
        <div class="node-glass">
          <div class="node-runtime">
            <div class="rt">0:00:00</div>
            <div class="rl">Runtime</div>
          </div>
        </div>
        <div class="node-labels">
          <span class="node-name" title="${escapeMarkup(agent.name)}"><i></i><span class="nn-t">${escapeMarkup(agent.name)}</span></span>
          <span class="node-role">${escapeMarkup(role.label)}</span>
        </div>
      </div>
    `)
    node.dataset.agentId = agent.id
    node.dataset.parentId = agent.parentId || ''
    node.classList.toggle('selected', this.selectedId === agent.id)
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-label', `${agent.name} — ${role.label}; Shift+Enter opens controls`)
    this.container.appendChild(node)

    const record = existing || {
      id: agent.id,
      agent,
      el: node,
      r: radius,
      x: this.W / 2,
      y: this.H / 2,
      slot: { x: this.W / 2, y: this.H / 2 },
      chip: null,
      chipLeader: null,
      chatOpen: false,
      chatHeight: 0,
      /* A person's own drag, in px -- 0 means "no drag yet, use the default
         SCREEN_CHAT_W/computed-open-height sizing". Reset on close exactly
         like chatHeight, for the same reason: reopening starts as the
         default card, not as whatever size a session left it at minutes
         ago on an agent that has since finished. */
      chatWidth: 0,
      /* Covering the tree is a property of the CARD, not of the graph: the
         tree keeps laying out and animating behind it. Kept per record so
         two cards cannot both claim the window. */
      chatFull: false,
      runtimeUnsub: null,
      chipRuntimeUnsub: null,
      clickTimer: 0,
    }
    if (existing) Object.assign(record, { el: node, r: radius, chip: null, chipLeader: null,
      chipLeaderDot: null, runtimeKey: null, laneMarksKey: null, boxPreviewKey: null,
      chipPreviewKey: null, chipPreviewNode: null })
    this.nodes.set(agent.id, record)

    if (this.nodeStyle === 'boxes') {
      node.classList.add('tree-agent-box')
      node.setAttribute('role', 'group')
      node.innerHTML = `<div class="node-glass">
        <div class="tree-box-heading"><div class="node-labels"><span class="node-name"><i></i><span class="nn-t"></span></span><span class="node-role"></span></div>
          <div class="tree-box-actions"><button type="button" class="tree-box-chat" title="Open a chat tab">+</button><button type="button" class="tree-box-add-agent" title="Add a child agent">↳+</button></div></div>
        <div class="tree-box-status-row"><span class="tree-box-status"></span><div class="node-runtime"></div><span class="tree-box-context-indicators" hidden></span><button type="button" class="tree-box-branch"></button></div>
        <div class="tree-box-latest-action" hidden></div>
        <div class="tree-box-context"><div class="tree-box-thinking" hidden><span class="tree-box-context-label">Thinking</span><span class="tree-box-thinking-text"></span></div><p></p></div>
      </div>`
      node.querySelector('.nn-t').textContent = agent.name
      node.querySelector('.node-role').textContent = role.label
      const chatButton = node.querySelector('.tree-box-chat')
      this._renderAccessibleName(record)
      chatButton.addEventListener('click', event => { event.stopPropagation(); this._cancelPendingNodeClicks(); this.openChat(record) })
      node.querySelector('.tree-box-branch').addEventListener('click', event => { event.stopPropagation(); this.setRoot(record.id) })
      this._bindStandaloneDrop(node.querySelector('.tree-box-add-agent'), { kind: 'child', parentId: record.id })
      node.querySelector('.tree-box-add-agent').addEventListener('click', event => {
        event.stopPropagation()
        this._pressEmptySlot({ id: `${CHILD_SLOT_PREFIX}${record.id}`, kind: 'child', parentId: record.id }, event.detail ? 'pointer' : 'keyboard')
      })
      for (const button of node.querySelectorAll('button')) {
        button.addEventListener('dblclick', event => event.stopPropagation())
        button.addEventListener('pointerdown', event => event.stopPropagation())
        button.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation() })
      }
    }

    this._renderRuntime(record)
    this._renderScope(record)
    this._renderLaneMarks(record)
    this._renderResearchMark(record)

    this._wireNode(record)
    if (this.onContact && !agent.treeScope?.group) {
      node.classList.add('has-contact')
      const contact = document.createElement('button')
      contact.type = 'button'
      contact.className = 'node-contact-icon'
      contact.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'
      for (const name of ['pointerdown', 'dblclick', 'keydown', 'dragstart']) contact.addEventListener(name, event => event.stopPropagation())
      contact.addEventListener('click', event => {
        event.stopPropagation()
        if (!this.editMode && !this._linkMode) this.onContact(record.agent)
      })
      if (this.nodeStyle === 'boxes') {
        node.querySelector('.tree-box-actions').prepend(contact)
      } else node.append(contact)
      this._renderContactMark(record)
    }
    if (this.screenChips) this._makeChip(record)

    if (fadeIn) {
      const raf = requestAnimationFrame(() => {
        this._addRafs.delete(raf)
        if (!this._destroyed) node.classList.remove('tree-node-adding')
      })
      this._addRafs.add(raf)
    }
    return record
  }

  _renderResearchMark(record) {
    const projectId = record.agent.researchProjectId
    let mark = record.el.querySelector('.tree-research-badge')
    if (!projectId || record.agent.treeScope?.group) { mark?.remove(); return }
    if (!mark) {
      mark = document.createElement('span')
      mark.className = 'tree-research-badge'
      mark.textContent = 'R'
      mark.setAttribute('role', 'img')
      const actions = record.el.querySelector('.tree-box-actions')
      if (actions) actions.prepend(mark)
      else record.el.appendChild(mark)
    }
    mark.title = `Research project: ${record.agent.researchProjectName || projectId}`
    mark.setAttribute('aria-label', mark.title)
    mark.dataset.researchProject = projectId
  }

  _removeRecord(record, animate = true) {
    if (this._nodeDrag?.record === record) this._nodeDrag.cancel()
    this.previewFitter.forget(record)
    this._disposeChat(record)
    this.nodes.delete(record.id)
    this._syncConversationShelf()
    record.runtimeUnsub?.()
    record.chipRuntimeUnsub?.()
    clearTimeout(record.clickTimer)
    record.chip?.remove()
    record.chipLeader?.remove()
    record.chipLeaderDot?.remove()
    if (!animate || calm() || record.agent.treeScope?.group) {
      record.el.remove()
      return
    }
    record.el.classList.add('tree-node-removing')
    const timer = setTimeout(() => {
      this._removeTimers.delete(timer)
      record.el.remove()
    }, REMOVE_MS + 24)
    this._removeTimers.add(timer)
  }

  _wireNode(record) {
    const node = record.el
    node.draggable = !!this.smartScope && !record.agent.treeScope?.group
    node.addEventListener('dragstart', event => {
      if (this.editMode || this._linkMode || record.agent.treeScope?.group || !this.windowBoard || this.windowBoard.windows.length < 2) {
        event.preventDefault()
        return
      }
      clearTimeout(record.clickTimer)
      record.dragMoved = true
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('application/x-toolsenabled-tree-agent', JSON.stringify({ id: record.id, computerId: this.computer.id }))
      node.classList.add('tree-view-dragging')
    })
    node.addEventListener('dragend', () => {
      node.classList.remove('tree-view-dragging')
      setTimeout(() => { record.dragMoved = false }, 0)
    })
    node.addEventListener('click', (event) => {
      if (this.editMode || record.dragMoved) {
        record.dragMoved = false
        return
      }
      event.stopPropagation()
      // A new gesture owns the toolbar immediately and supersedes old opens.
      if (!this._linkMode) this.select(record.id)
      else this._cancelPendingNodeClicks()
      if (this._linkMode || record.agent.treeScope?.group || event.detail === 0) {
        this.handleClick(record)
      } else if (event.detail === 1) {
        // Opening side chat or a conversation moves the canvas. Wait briefly so
        // a double-click reaches the original node before either can move it.
        record.clickTimer = setTimeout(() => {
          record.clickTimer = 0
          if (!this._destroyed && !this.editMode && !record.el.hidden) this.handleClick(record)
        }, CLICK_CHAT_DELAY)
      }
    })
    node.addEventListener('dblclick', (event) => {
      if (this._linkMode || (this.editMode && !this.smartScope)) return
      event.preventDefault()
      event.stopPropagation()
      this.select(record.id)
      clearTimeout(record.clickTimer)
      if (this.editMode) { this.select(record.id); this.onOpenControls?.(record.agent); return }
      if (record.agent.treeScope?.group || (!this.workspace && !this.chatOwner)) this.setRoot(record.id)
      else this.openChat(record)
    })
    node.addEventListener('keydown', (event) => {
      if (this.editMode && this.smartScope && event.key === 'Enter' && !event.repeat) {
        event.preventDefault()
        this.select(record.id)
        this.onOpenControls?.(record.agent)
        return
      }
      if (this.editMode || event.repeat) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      // A click used to focus this node may still be waiting for a possible
      // double click. Keyboard activation settles that intent now; allowing
      // the old timer to run later reopens Chat over the Details just chosen.
      this._cancelPendingNodeClicks()
      if (this._linkMode && ['Enter', ' '].includes(event.key)) {
        event.preventDefault()
        void this._chooseLinkNode(record)
        return
      }
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        this.select(record.id)
        if (record.agent.treeScope?.group) this.setRoot(record.id)
        else this.onOpenControls?.(record.agent)
        return
      }
      event.preventDefault()
      if ((this.workspace || this.chatOwner) && !this._linkMode) this.openChat(record)
      else this.handleClick(record)
    })

    let pointerId = null
    let start = null
    let offset = null
    node.addEventListener('pointerdown', (event) => {
      if (!this.editMode || this._destroyed || event.button !== 0 || event.isPrimary === false
        || this._nodeDrag || this._panState || record.agent.treeScope?.group) return
      if (this.canDrag && !this.canDrag(record.agent)) {
        this.onDropRefused?.('notDraggable', { name: record.agent.name || record.id || 'this agent' })
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pointerId = event.pointerId
      start = { x: event.clientX, y: event.clientY, recordX: record.x, recordY: record.y }
      const graphPoint = this._toGraph(event)
      offset = { x: record.x - graphPoint.x, y: record.y - graphPoint.y }
      record.dragMoved = false
      this._nodeDrag = { record, cancel: () => endDrag(null, false) }
      try { node.setPointerCapture(pointerId) }
      catch { endDrag(null, false); return }
      node.classList.add('dragging')
    })
    node.addEventListener('pointermove', (event) => {
      /* Not a drag if nothing is held -- see the pan handler's note. Repairs a
         missed ending on the next event rather than waiting for one that is
         never coming. */
      if (pointerId !== event.pointerId || !start) return
      if (event.buttons === 0) { endDrag(event, false); return }
      if (!record.dragMoved && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
        record.dragMoved = true
      }
      if (!record.dragMoved) return
      this._placeDraggedRecord(record, event, offset)
      /* Near a pane edge the view pans under the held node (see
         _dragAutoPan), so a target beyond the edge comes to the hand. */
      this._dragAutoPan(record, event, offset)
    })
    const endDrag = (event, commit) => {
      if (!start || (event && pointerId !== event.pointerId)) return
      const capturedId = pointerId
      const origin = start
      // Capture release and store callbacks can synchronously dispatch more
      // events. Relinquish the gesture before calling either of them.
      pointerId = null
      start = null
      offset = null
      this._nodeDrag = null
      this._stopDragAutoPan()
      try { node.releasePointerCapture(capturedId) } catch { /* capture may already be gone */ }
      node.classList.remove('dragging')
      if (commit && this.canDrag && !this.canDrag(record.agent)) {
        commit = false
        this.onDropRefused?.('notDraggable', { name: record.agent.name || record.id || 'this agent' })
      }
      if (!commit) {
        this._dropRec?.el.classList.remove('drop-ok')
        this._dropRec = this._dropRaw = null
        record.x = origin.recordX
        record.y = origin.recordY
        if (record.dragMoved) {
          this._positionRecord(record)
          this._renderLinks()
        }
        record.dragMoved = false
      } else if (record.dragMoved) {
        this._updateDropTarget(record, event)
        this._finishEditDrag(record, origin)
      }
    }
    node.addEventListener('pointerup', event => endDrag(event, true))
    // An interrupted gesture is not consent to move a branch or save a nudge.
    node.addEventListener('pointercancel', event => endDrag(event, false))
    node.addEventListener('lostpointercapture', event => endDrag(event, false))
  }

  /* WHERE THE HELD NODE GOES for one pointer position. The LIVE drag obeys
     the same corridor the release applies. The old live clamp knew only the
     canvas, so a drag rode free and then jumped into the corridor on release
     — a snap the hand never asked for. What the person sees while dragging
     is where the node stays. Shared by the pointer's own moves and the
     edge auto-pan, which moves the view under a pointer that has stopped. */
  _placeDraggedRecord(record, event, offset) {
    const point = this._toGraph(event)
    const slotX = record.slot?.x ?? record.x
    record.x = clamp(point.x + offset.x, Math.min(record.r + 12, slotX), this._rightReach(record, slotX))
    record.y = clamp(point.y + offset.y, ...this._dragBand(record))
    this._positionRecord(record)
    this._updateDropTarget(record, event)
    this._renderLinks()
  }

  /* THE VIEW COMES TO THE HAND (owner, 2026-09-15: "sometime on the tree its
     hard to pull a agent far enough right to drop it on another agents
     tree"). A pointer cannot leave the pane, so a drop target past its edge
     was unreachable: the drag stopped at the glass. While a node is held
     within DRAG_EDGE of an edge, the view pans that way a little each frame,
     faster the deeper into the band, and the held node is re-placed under
     the pointer it has not left. The pan stops at the same bounds a hand
     pan stops at (_clampPan), so nothing can be dragged off into nowhere,
     and it stops the moment the pointer leaves the band or lets go. */
  _dragAutoPan(record, event, offset) {
    const rect = this.zoomHost.getBoundingClientRect()
    const ramp = (distance) => distance >= DRAG_EDGE ? 0 : Math.ceil((1 - distance / DRAG_EDGE) * DRAG_PAN_MAX)
    const vx = ramp(event.clientX - rect.left) - ramp(rect.right - event.clientX)
    const vy = ramp(event.clientY - rect.top) - ramp(rect.bottom - event.clientY)
    if (!vx && !vy) { this._stopDragAutoPan(); return }
    const point = { clientX: event.clientX, clientY: event.clientY }
    if (this._dragPan) { Object.assign(this._dragPan, { record, offset, point, vx, vy }); return }
    this._dragPan = { record, offset, point, vx, vy }
    const step = () => {
      const pan = this._dragPan
      if (!pan) return
      const beforeX = this.panX, beforeY = this.panY
      /* Asked BEFORE the step, because the rule is "do not pan PAST the last
         target", not "do not pan while none is showing". A target that is
         still off screen is the whole reason the view is moving, and an
         earlier version of this guard read the state after the step and so
         stopped dead on the first frame of exactly the drag it exists to
         serve. */
      const hadTarget = this._dropTargetInView(pan.record)
      this.panX += pan.vx
      this.panY += pan.vy
      this._viewSteered = true
      this._autoFitted = false
      this._clampPan()
      const moved = this.panX !== beforeX || this.panY !== beforeY
      /* AND IT STOPS WHILE THERE IS STILL SOMEWHERE TO DROP. The pan bound
         alone (_clampPan, PAN_KEEP) lets content run until a strip of it is
         left, which for a held node means every other node can leave the
         view: measured, a 1.6s pause at the edge carried a whole three-node
         tree off-screen and left the hand holding a node with nothing to drop
         on -- the opposite of bringing a target to the hand. So the last
         frame that would empty the view of targets is undone and the pan
         stops there, leaving the furthest target on screen and droppable. */
      if (moved && hadTarget && !this._dropTargetInView(pan.record) && !this._dropTargetAhead(pan.record, pan.vx, pan.vy)) {
        this.panX = beforeX
        this.panY = beforeY
        this._applyZoom()
        this._placeDraggedRecord(pan.record, pan.point, pan.offset)
        this._stopDragAutoPan()
        return
      }
      this._applyZoom()
      this._placeDraggedRecord(pan.record, pan.point, pan.offset)
      if (!moved) { this._stopDragAutoPan(); return }
      pan.frame = requestAnimationFrame(step)
    }
    this._dragPan.frame = requestAnimationFrame(step)
  }

  _stopDragAutoPan() {
    if (!this._dragPan) return
    if (this._dragPan.frame) cancelAnimationFrame(this._dragPan.frame)
    this._dragPan = null
  }

  /* IS THERE ANYWHERE LEFT TO DROP? The same candidates _updateDropTarget
     scans -- every other drawn circle and every offered slot -- asked against
     the pane instead of against the pointer. Auto-pan exists to bring one of
     these to the hand, so once none of them is on screen the pan has stopped
     helping and has started taking the drop away.

     A forest with no candidate at all is not restricted: there is nothing to
     keep in view, so the ordinary pan bound governs and a lone node still
     pans as far as a hand could take it. */
  _dropCandidates(held) {
    const candidates = []
    for (const candidate of this.nodes?.values() || []) {
      if (candidate === held || this._culled?.has(candidate.id) || candidate.el?.hidden) continue
      candidates.push(candidate)
    }
    for (const slot of this.emptySlots?.values() || []) {
      if (!slot.hidden) candidates.push(slot)
    }
    return candidates
  }

  /* One conversion from graph space to the pane's own coordinates, read once
     per question rather than once per candidate. */
  _dropTargetFrame() {
    const rect = this.zoomHost.getBoundingClientRect()
    const uiZoom = textZoom(this.zoomHost.ownerDocument) || 1
    return {
      rect,
      uiZoom,
      originX: rect.left + uiZoom * (this.zoomHost.clientLeft || 0),
      originY: rect.top + uiZoom * (this.zoomHost.clientTop || 0),
    }
  }

  _candidateBox(frame, candidate) {
    const radius = candidate.r || 0
    return {
      lowX: frame.originX + frame.uiZoom * (this.panX + (candidate.x - radius) * this.zoom),
      highX: frame.originX + frame.uiZoom * (this.panX + (candidate.x + radius) * this.zoom),
      lowY: frame.originY + frame.uiZoom * (this.panY + (candidate.y - radius) * this.zoom),
      highY: frame.originY + frame.uiZoom * (this.panY + (candidate.y + radius) * this.zoom),
    }
  }

  _dropTargetInView(held) {
    const frame = this._dropTargetFrame()
    const candidates = this._dropCandidates(held)
    if (!candidates.length) return true
    return candidates.some((candidate) => {
      const box = this._candidateBox(frame, candidate)
      return box.highX > frame.rect.left && box.lowX < frame.rect.right
        && box.highY > frame.rect.top && box.lowY < frame.rect.bottom
    })
  }

  /* IS THERE STILL SOMETHING AHEAD OF US? "In view" is a weaker question than
     the rule above means to ask, and the gap between them switched the feature
     off in exactly the drag it exists for (owner's case, measured: a target
     205px past the right edge, the only other target a few px inside the LEFT
     edge; that one left the view on the first frame, so the stop fired while
     the target being fetched was still off screen, and the view never moved).

     The rule is "do not pan PAST the last target". A target the view has not
     reached yet has not been passed — it is the reason to keep going. So the
     stop now needs BOTH: nothing in view, and nothing still out there in the
     direction of travel. Behind us does not count, which is what keeps the
     forest from being carried away once everything has been passed. */
  _dropTargetAhead(held, vx, vy) {
    const frame = this._dropTargetFrame()
    const candidates = this._dropCandidates(held)
    if (!candidates.length) return false
    const scale = frame.uiZoom || 1
    /* WHEN, IF EVER, WOULD THIS CANDIDATE OVERLAP THE PANE ON THIS AXIS?
       Answered as an interval of future frames rather than a yes/no, because
       "past the right edge" is not the same question as "can get here".

       Asking the axes independently was wrong (Builder 10, 2026-09-15): a
       circle off to the right AND far above the pane counted as ahead of a
       horizontal drag, so the pan ran to its bound chasing something that
       could never arrive -- and carried the one real target off screen on the
       way, which is the very defect the guard exists to prevent.

       A still axis does not move, so it either overlaps for the whole drag or
       never; a moving one overlaps between the frame it enters and the frame
       it leaves. */
    const window = (low, high, min, max, velocity) => {
      const speed = scale * velocity
      if (!speed) return high > min && low < max ? [0, Infinity] : null
      const entering = (min - high) / speed
      const leaving = (max - low) / speed
      return speed > 0 ? [entering, leaving] : [leaving, entering]
    }
    return candidates.some((candidate) => {
      const box = this._candidateBox(frame, candidate)
      const across = window(box.lowX, box.highX, frame.rect.left, frame.rect.right, vx)
      const down = window(box.lowY, box.highY, frame.rect.top, frame.rect.bottom, vy)
      if (!across || !down) return false
      /* Ahead means both axes overlap at the same moment, still to come. The
         floor at 0 is what keeps a target we have already passed from
         counting: its interval ends in the negative. */
      return Math.min(across[1], down[1]) > Math.max(across[0], down[0], 0)
    })
  }

  /* HOW FAR RIGHT A NUDGE MAY GO. The canvas edge used to be a wall, and the
     layout packs each family's "+" offer against it, so an agent could not be
     moved into or past the "+" column (owner, 2026-09-10: "i cant move any
     agents in edit mode they cant be moved right which is where the + are").
     A nudge may travel a further canvas width, or as far as anything drawn
     plus one more width when the forest is wider than that (another agent's
     tree far to the right, owner 2026-09-15); the pan bounds follow the drawn
     content (_contentBox), so a node out there stays reachable. */
  _rightReach(record, slotX) {
    let box = null
    try { box = this.nodes ? this._contentBox(1) : null } catch { box = null }
    const drawn = box && Number.isFinite(box.x) && Number.isFinite(box.w) ? box.x + box.w + this.W : 0
    return Math.max(this.W * 2 - record.r - 12, drawn - record.r - 12, slotX)
  }

  _wouldCycle(child, parent) {
    /* hierarchyParents is the SAME resolver the layout uses, declared edges
       included — the old inline walk only followed parentId, so a cycle
       created through a declared manages/delegates_to edge slipped past this
       check while the layout saw it plainly. One resolver, one answer. */
    const parents = hierarchyParents(this.computer?.agents || [], this.declaredEdges || [])
    let current = String(parent.id)
    const seen = new Set()
    while (current && !seen.has(current)) {
      if (current === String(child.id)) return true
      seen.add(current)
      current = parents.get(current) ?? null
    }
    return false
  }

  /* The vertical band a nudged record may occupy without leaving its rank:
     [low, high] around its own row's y, HALF THE PITCH to each neighbouring
     row — the band boundary is the midline between ranks, so a top circle
     cannot be dragged into its children's band, while a drag INSIDE the
     band stays free. The precise label-collision veto below is what refuses
     genuine overlaps, not this coarse fence: the earlier version also
     subtracted the label stack here and floored at zero, which made tight
     rows refuse every vertical nudge — the snap-back feel the owner called
     a regression (iteration 6: "keep the new version but make it act and
     feel like before"). The outermost rows get a fixed 40px outward since
     no neighbour bounds them.

     THE BAND ALWAYS CONTAINS THE RECORD'S OWN SLOT. The corridor constrains
     nudges, never the layout's resting position — the canvas-edge floor
     (r + 64) disagrees with the layout's own padTop for big circles, and
     letting it move un-nudged nodes pushed the whole top row down into its
     label reservation. That at-rest shift IS the mess the owner
     screenshotted; a node nobody dragged sits exactly where the layout put
     it, always. Falls back to canvas bounds when the layout carries no
     rows (single-rank canvases). */
  _rankCorridor(record, result, slotY = record.slot?.y ?? record.y) {
    const canvasLow = record.r + 64
    const canvasHigh = this.H - record.r - 58
    const rowIndex = result?.rowOf?.get(record.id)
    const rowYs = result?.rowYs
    if (!Number.isFinite(rowIndex) || !Array.isArray(rowYs) || rowYs.length < 2) {
      return [Math.min(canvasLow, slotY), Math.max(canvasHigh, slotY)]
    }
    const rowY = rowYs[rowIndex]
    const up = rowIndex > 0 ? (rowY - rowYs[rowIndex - 1]) / 2 : 40
    const down = rowIndex + 1 < rowYs.length ? (rowYs[rowIndex + 1] - rowY) / 2 : 40
    return [
      Math.min(Math.max(canvasLow, rowY - up), slotY),
      Math.max(Math.min(canvasHigh, rowY + down), slotY),
    ]
  }

  /* One label rectangle for every rule that needs it — the drop hit test and
     the override-overlap veto must agree about where a node's words are, or
     a drop can land where a veto later fires. Geometry mirrors the CSS
     EXACTLY: the stack hangs 7px under the circle, TREE_LABEL_STACK tall,
     and .node-labels is min(var(--d) + 118px, var(--nn-max)) wide, centred —
     half is min(r + 59, labelMax / 2). The first version spanned
     max(r, 35) + 12, half the real width, so the veto measured half the
     words and missed half the collisions. labelMax is recorded at layout
     time beside the --nn-max write. */
  _labelBox(record) {
    if (this.nodeStyle === 'boxes' && record.agent) return {
      left: record.x - this._boxSize().width / 2, right: record.x + this._boxSize().width / 2,
      top: record.y - this._boxSize().height / 2, bottom: record.y + this._boxSize().height / 2,
    }
    const half = Math.min(record.r + 59, (record.labelMax || Infinity) / 2)
    return {
      left: record.x - half,
      right: record.x + half,
      top: record.y + record.r + 7,
      bottom: record.y + record.r + 7 + TREE_LABEL_STACK,
    }
  }

  /* The record nearest a graph-space point, within a bound. Serves the
     zoom-to-focus drill: past the bound the wheel is aimed at empty canvas,
     and the honest answer is "nothing to focus", not the least-far node. */
  _nearestRecordTo(graphX, graphY, within = Infinity) {
    let nearest = null
    let best = within
    for (const record of this.nodes.values()) {
      if (record.el.hidden || this._culled.has(record.id) || (this._layoutVisibleIds && !this._layoutVisibleIds.has(record.id))) continue
      const distance = this.nodeStyle === 'boxes'
        ? Math.hypot(Math.max(0, Math.abs(record.x - graphX) - this._boxSize().width / 2), Math.max(0, Math.abs(record.y - graphY) - this._boxSize().height / 2))
        : Math.hypot(record.x - graphX, record.y - graphY)
      if (distance < best) {
        best = distance
        nearest = record
      }
    }
    return nearest
  }

  /* Whether the dragged record, at its current position, is "on" the
     candidate — the circle, or the LABEL BOX hanging under it. The label is
     part of what a person sees as the node; a drop released over the name
     used to fall into dead space and read as a rejected drop. */
  /* HOW FAR A DRAGGED NODE MAY TRAVEL, AND WHY IT IS NOT THE RANK CORRIDOR.
   *
   * THE OWNER'S DEFECT, verbatim: "edit had been working; drag a node to a new
   * node slot; on the same tree, on a new tree, or on a different tree. On pg2
   * you cant drag and drop the nodes onto the new bubbles anymore."
   *
   * WHAT BROKE IT. c06c44c put the rank corridor on the LIVE drag, for a real
   * reason -- before it, a drag rode free and then jumped into the corridor on
   * release, a snap the hand never asked for. But the corridor is HALF THE
   * PITCH to the neighbouring row, and every empty slot on this canvas sits in
   * a DIFFERENT row from the node you would drag onto it: the new-tree slot is
   * in row 0, a child slot is one row below its parent. So the node stopped
   * half-way and the ring never lit.
   *
   * MEASURED FROM THIS FILE'S OWN NUMBERS rather than guessed. Contact needs
   * `candidate.r + record.r + DROP_SLOP` -- 34 + 35 + 8, about 77px. Row pitch
   * is `(height - 104 - 116) / (rows - 1)` (src/tree-layout.js), which on a
   * 620px canvas is 400px for two rows and 200px for three. Half of either is
   * further than 77px, so a cross-row drop could not register at any realistic
   * window size. All three of the moves he names are cross-row, which is why he
   * reports all three dead while the drop code reads as intact.
   *
   * THE RULE THAT SATISFIES BOTH INTENTS. The band is the rank corridor UNIONED
   * with the reach of every target that is actually on screen. Then:
   *
   *   released inside the corridor   a nudge, exactly where the hand left it --
   *                                  the no-jump property c06c44c bought.
   *   released on a target           a reparent: the node is relaid out into
   *                                  its new slot, which is the whole gesture.
   *   released on a refused target   the refusal branch says which rule refused
   *                                  and returns the node to where it started.
   *
   * There is no fourth case: outside the corridor the node can only be within
   * reach of something, because reach is the only thing that widened the band.
   * The corridor is still consulted here and still bounds a nudge, so the
   * property tools/test/tree-drag-contract.test.mjs pins is unchanged in
   * substance rather than merely in wording.
   */
  _dragBand(record) {
    /* The candidate set is the SAME one _updateDropTarget scans -- visible
       circles and visible slots -- because a band that admitted a target the
       hit test ignores would let the node travel to a place nothing can accept
       it, and a band that omitted one the hit test accepts would put that
       target out of reach. One list, one answer. */
    const candidates = []
    for (const candidate of this.nodes.values()) {
      if (candidate === record || this._culled.has(candidate.id) || candidate.el.hidden) continue
      candidates.push(candidate)
    }
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden) continue
      candidates.push(slot)
    }
    return dragBand({
      corridor: this._rankCorridor(record, this._layoutResult),
      record,
      candidates,
      slop: DROP_SLOP,
      height: this.H,
    })
  }

  _dropHit(candidate, record) {
    const circle = Math.hypot(candidate.x - record.x, candidate.y - record.y)
      - (candidate.r + record.r + DROP_SLOP)
    if (circle < 0) return circle
    const box = this._labelBox(candidate)
    if (record.x >= box.left && record.x <= box.right && record.y >= box.top - candidate.r && record.y <= box.bottom) return -1
    return circle
  }

  _headerNewTreeDropTarget(event) {
    if (!this.editMode || this._destroyed || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return null
    const target = (this.chatOwner || this).workspace?.newTreeDropTarget
    const button = target?.el
    if (!button?.isConnected || button.hidden || button.disabled || button.closest('[inert]')) return null
    const box = button.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0) || event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom) return null
    const document = button.ownerDocument
    if (document?.elementFromPoint && !button.contains(document.elementFromPoint(event.clientX, event.clientY))) return null
    return target
  }

  _updateDropTarget(record, event) {
    /* NEAREST wins, not first-in-insertion-order: with the old first-match
       loop, two nodes standing close meant the drop target was decided by
       Map insertion order, and the ring lit on a circle the pointer was not
       even nearest to. And the threshold is candidate.r + record.r +
       DROP_SLOP — AT LEAST the packed non-overlap distance — so no annulus
       exists where two nodes visually touch yet nothing registers: the old
       `record.r * 0.55` factor left exactly that dead ring, which is what
       made dropping a child on its parent land in nothing (owner defect 3:
       a MISSED drop, not an accepted one). */
    let raw = null
    let best = Infinity
    for (const candidate of this.nodes.values()) {
      if (candidate === record || this._culled.has(candidate.id) || candidate.el.hidden) continue
      const score = this._dropHit(candidate, record)
      if (score < 0 && score < best) {
        best = score
        raw = candidate
      }
    }
    /* SLOTS ARE DROP TARGETS TOO (owner defect 4). A child slot means "join
       this family" — the same move as dropping on the parent circle, said at
       the exact spot the child would land. The new-tree slot is the drag OUT:
       this branch becomes its own tree. Slots compete in the same
       nearest-wins field as circles, so whichever target the node is actually
       closest to lights up. */
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden) continue
      const score = this._dropHit(slot, record)
      if (score < 0 && score < best) {
        best = score
        raw = slot
      }
    }
    // The header is outside the canvas drag corridor. Hit it with the actual
    // pointer position, then apply the same identity and store checks as slots.
    raw = this._headerNewTreeDropTarget(event) || raw
    const draggable = this.canDrag ? this.canDrag(record.agent) : true
    const isSlot = raw && !raw.agent
    const slotValid = isSlot && (
      raw.kind === 'new-tree'
        ? Boolean(record.agent.parentId)
        : raw.parentId !== record.agent.parentId
          && raw.parentId !== record.agent.id
          && !(this.nodes.get(raw.parentId) && this._wouldCycle(record.agent, this.nodes.get(raw.parentId).agent))
    )
    const parentId = isSlot ? raw.parentId : raw?.id
    const parentAllowed = !raw || (isSlot && raw.kind === 'new-tree')
      || !this.canReparent || this.canReparent(record.id, parentId)
    const valid = raw
      && draggable
      && parentAllowed
      && (isSlot
        ? slotValid
        : raw.id !== record.agent.parentId && !this._wouldCycle(record.agent, raw.agent))
      ? raw
      : null
    if (this._dropRec && this._dropRec !== valid) this._dropRec.el.classList.remove('drop-ok')
    if (valid && this._dropRec !== valid) valid.el.classList.add('drop-ok')
    this._dropRec = valid
    this._dropRaw = raw
  }

  _finishEditDrag(record, start) {
    let target = this._dropRec
    let raw = this._dropRaw
    if (target) target.el.classList.remove('drop-ok')
    this._dropRec = null
    this._dropRaw = null
    /* This node's own family "+" (or, for a tree head, the new-tree "+") asks
       for nothing new: dropping there is a move to that spot, not a refused
       re-parent that snaps the node back. Another family's "+" still means
       "make it a child here", and a drop on an agent still re-parents. */
    if (raw && !raw.agent && (raw.kind === 'new-tree' ? !record.agent.parentId : (raw.parentId ?? null) === (record.agent.parentId ?? null))) {
      target = null
      raw = null
    }

    if (target && !target.agent) {
      /* A slot drop. The child slot is the same move as dropping on its
         parent circle; the new-tree slot detaches the branch into its own
         tree. Both go through injected callbacks so the STORE stays the only
         author of tree shape, exactly as onReparent already works. */
      const editRoots = target.kind === 'new-tree' && this.smartScope && this.editMode
        && this.onDetachToNewTree && Array.isArray(this._editRootIds) ? this._editRootIds : null
      // Store notifications can refresh synchronously inside the callback.
      // Keep the emerging head selected before that refresh, so its complete
      // branch stays on the edit canvas. Refused moves keep the old selection.
      if (editRoots && !editRoots.includes(record.id)) this._editRootIds = [...editRoots, record.id]
      let changed = false
      try {
        changed = target.kind === 'new-tree'
          ? this.onDetachToNewTree?.(record.id)
          : this.onReparent?.(record.id, target.parentId)
      } finally {
        if (editRoots && !changed) this._editRootIds = editRoots
      }
      if (changed) {
        this._clearPosition(record.id)
        this._layoutNow()
        return
      }
    } else if (target) {
      /* No onReparent callback means nobody can apply this drop -- the old
         fallback silently rearranged the demonstration engine's records, which
         let a drag LOOK like it took effect on data that nothing owned. A drop
         with no applier is refused like any other, and the refusal path below
         names it. */
      const changed = this.onReparent
        ? this.onReparent(record.id, target.id)
        : false
      if (changed) {
        this._clearPosition(record.id)
        record.el.dataset.parentId = target.id
        if (this.onReparent) this._layoutNow()
        return
      }
    }

    if (raw) {
      /* A refused drop names its rule. The wiggle alone taught nothing —
         "possible to drop a child directly on its parent" (owner defect 3)
         was in fact this branch snapping back wordlessly, which read as an
         accepted drop that mysteriously changed nothing. */
      if (this.onDropRefused) {
        const nameOf = (rec) => rec?.agent?.name || rec?.agent?.id || 'this agent'
        const rawIsSlot = !raw.agent
        const rawParentName = rawIsSlot ? nameOf(this.nodes.get(raw.parentId)) : nameOf(raw)
        /* NO APPLIER IS A RULE TOO, and it was the one rule that said nothing.
           The three below are shape rules -- cycles, non-draggable roots,
           drops that change nothing -- and a drag with no callback to apply it
           matched none of them, so it wiggled and fell silent. That is the
           whole of the example board: mountGraph nulls onReparent there on
           purpose, so EVERY legal-looking drag on it was a silent dead press
           (desktop press-through, 2026-08-27: "no movement, no refusal", with
           the only statement of the rule living in a hover title a dragging
           person never sees). The view answers this rule with the same
           sentence its Edit button and its Reports-to Save state, so the
           board's three doors cannot disagree. */
        const applier = rawIsSlot && raw.kind === 'new-tree' ? this.onDetachToNewTree : this.onReparent
        if (!applier) {
          this.onDropRefused('noApplier', { name: nameOf(record), parent: rawParentName, target: rawParentName })
        } else if (this.canDrag && !this.canDrag(record.agent)) {
          this.onDropRefused('notDraggable', { name: nameOf(record) })
        } else if (rawIsSlot ? raw.parentId === record.agent.parentId : raw.id === record.agent.parentId) {
          this.onDropRefused('alreadyUnder', { name: nameOf(record), parent: rawParentName })
        } else if (rawIsSlot
          ? (this.nodes.get(raw.parentId) && this._wouldCycle(record.agent, this.nodes.get(raw.parentId).agent))
          : this._wouldCycle(record.agent, raw.agent)) {
          this.onDropRefused('wouldCycle', { name: nameOf(record), target: rawParentName })
        } else if (!target && this.canReparent && !(rawIsSlot && raw.kind === 'new-tree')
          && !this.canReparent(record.id, rawIsSlot ? raw.parentId : raw.id)) {
          this.onDropRefused('unavailableParent', { name: nameOf(record), target: rawParentName })
        }
      }
      record.el.classList.add('refuse')
      const timer = setTimeout(() => {
        this._chatTimers.delete(timer)
        record.el.classList.remove('refuse')
      }, 260)
      this._chatTimers.add(timer)
      record.x = start.recordX
      record.y = start.recordY
      this._positionRecord(record)
      this._renderLinks()
      return
    }

    /* v2: the nudge remembers WHICH PARENT'S SLOT it was measured against,
       so a later reparent by any route invalidates it wholesale instead of
       displacing the node from a slot it was never dragged from. */
    this._positions[record.id] = {
      v: 2,
      dx: Math.round((record.x - record.slot.x) * 100) / 100,
      dy: Math.round((record.y - record.slot.y) * 100) / 100,
      parentId: record.agent.parentId ?? null,
      at: Date.now(),
    }
    this._writePositions()
    this._renderLinks()
  }

  /* WHICH SLOTS THIS TREE IS OFFERING RIGHT NOW.
     Derived from the fleet and from a layout of the fleet ALONE, never from a
     layout that already contains slots. That is not fastidiousness, it is the
     one rule that makes this terminate: if the presence of slots could change
     whether slots are offered, adding them would crowd the canvas, the crowding
     would withdraw them, the canvas would relax, and they would come back — a
     graph that flickers forever on a static fleet.

     THE TWO OFFERS.
     1. A NEW TREE. One slot with no parent, so the existing model puts it in
        the top rank beside whatever roots already exist. With no agents at all
        it is the only thing on the canvas and lands dead centre, which is the
        first-run screen: one circle, press it. It is withheld while the view
        is drilled into one branch, because "start a new tree" is not an offer
        that belongs inside somebody else's tree.
     2. A CHILD, under every agent the fleet layout actually placed. A culled
        agent is not on the canvas, so a slot hanging off it would hang off
        nothing.

     AND WHY DENSITY NO LONGER WITHDRAWS THEM: DENSITY MUST NOT ERASE A LEGAL
     ACTION. There used to be a second
     guard here: past DENSE_AT drawn agents, every child offer was dropped
     before the layout was consulted, on the reasoning that a canvas already
     saying "this is too much to read, drill in" should not answer by adding
     one more circle per agent. That reasoning was about legibility, but its
     effect was about capability: the twelfth drawn agent took the last child
     offer off the canvas, so a tree whose every agent still had legal room
     for one lost the only way to extend itself from its own view — while
     the separate "start another tree" offer stayed — so the page did
     not read as crowded, it read as broken. Legibility already has an owner
     one step down: _settleEmptySlots lays the canvas out WITH these offers,
     the rank packer culls empty slots before it culls an agent, and
     _slotsDisplaceAnAgent throws the whole set away if even that cannot keep
     every agent drawn. That is a measurement of this canvas; a count of
     twelve was a guess about it. The drill-in hint keeps DENSE_AT and keeps
     inviting a person to focus one branch — it just no longer takes the
     button away while it does so, including on a tree where many empty slots
     fit cleanly.

     AND WHY A SLOT CAN BE REFUSED BEFORE IT IS DRAWN. The store that accepts
     these presses has limits of its own — a fan-out cap and a depth cap in
     src/fleet-trees.js — so there are positions in a legal tree where a child
     simply cannot go. A dashed circle at one of those positions is a button
     that is guaranteed to fail, and a person only finds out after choosing a
     role and writing out what they wanted done. Drawing an offer that cannot
     be accepted is a rendering defect, and it is this file's defect, so the
     answer is to not draw it.
     The RULE, though, is not this file's to know: fan-out and depth belong to
     whoever owns the model, and hard-wiring an import of it here would put a
     copy of somebody else's cap inside the renderer, where it would go stale
     the first time they changed it. So the caller injects the question as
     `canExtend`, this file only asks it, and a mount that passes nothing keeps
     drawing every slot exactly as before. */
  _canExtend(target) {
    if (this.extensionPoints) return this._extensionParents?.has(target?.id ?? null) ?? true
    if (!this.canExtend) return true
    try {
      return this.canExtend(target) !== false
    } catch {
      /* NOT A SILENT SWALLOW. The predicate belongs to another module and may
         be reading a store that is mid-write; a thrown answer is "I do not
         know", never "no". Withholding a slot on an unknown is how a person
         loses the only way to extend their tree because something unrelated
         glitched, so an unknown falls back to the behaviour of a mount that
         passes no predicate at all: draw it, and let the store refuse the
         submission in its own words if it must. */
      return true
    }
  }

  _planEmptySlots(agents, fleetLayout) {
    /* editMode deliberately NOT in this guard any more — see setEditMode. */
    if (!this.emptySlotsEnabled || this._destroyed) return []
    const plans = []
    const hasTree = agents.length > 0
    const describe = (kind) => slotWords(kind, hasTree)
    // Page 2 has one tree-creation entry in the workspace header. Standalone
    // graphs without that header still need their canvas entry.
    if (!this.tabbedWorkspace && !this.chatOwner && !this.rootId && this._canExtend(null)) {
      plans.push({
        id: NEW_TREE_SLOT_ID,
        kind: 'new-tree',
        parentId: null,
        ...describe('new-tree'),
      })
    }
    const placed = agents.filter(agent =>
      fleetLayout.slots.has(agent.id) && !fleetLayout.culled.has(agent.id))
    for (const agent of placed) {
      if (this.nodeStyle === 'boxes' && !this.editMode) continue
      if (agent.treeScope?.group || !this._canExtend(agent)) continue
      plans.push({
        id: `${CHILD_SLOT_PREFIX}${agent.id}`,
        kind: 'child',
        parentId: agent.id,
        ...describe('child'),
      })
    }
    return plans
  }

  /* A slot, expressed in the only vocabulary src/tree-layout.js speaks. It is
     an ordinary node to that file: an id, a parent, an explicit radius, and the
     two ranking fields that say "drop me first, and list me last". Nothing in
     the layout engine knows what a slot is, which is why none of this needed
     the layout engine to change. */
  _emptyLayoutNode(plan) {
    return {
      id: plan.id,
      name: '',
      role: 'default',
      parentId: plan.parentId,
      r: EMPTY_SLOT_RADIUS,
      cullable: true,
      cullRank: EMPTY_SLOT_CULL_RANK,
      orderHint: EMPTY_SLOT_ORDER_HINT,
    }
  }

  /* A SLOT NEVER COSTS AN AGENT ITS PLACE.
     The rank packer culls to keep what is left readable, and it is told to drop
     slots first — but "first" is not "only". A rank is packed by one of two
     routines (see packGroupedXs and packedXs in src/tree-layout.js), and the
     cull path is entered on a count-based test that slots contribute to: a
     rank of agents that packs without a murmur can, once each agent brings a
     slot, trip the readability test and send the WHOLE rank — agents
     included — through the culler. (Measured as eight agents plus eight slots
     when a parent seated eight. A parent seats four since 2026-09-11, but a
     rank still gathers the children of every parent at that depth, and trees
     saved under the old cap keep their wide ranks, so the rule stands at any
     width.) An agent that was on the canvas a
     moment ago vanishing so that an empty circle can be drawn is the worst
     trade this feature could make, and to a person watching it is
     indistinguishable from an agent having died.
     So the offer is withdrawn wholesale and the fleet is drawn exactly as it
     would have been drawn if this feature did not exist. Fewer places to press
     is a disappointment; a disappeared agent is a lie.
     WHERE THE X VALUES COME FROM NOW. After the rank packer has decided who
     fits, layoutTree measures the surviving forest from the leaves up and
     places it from the roots down (packSubtreeXs in src/tree-layout.js), so a
     parent stands over the room its own children need and a child's connector
     is a straight drop — _elbowRoute already collapses to a vertical line when
     the centres are within 1.5px, so no connector code changed for this. The
     rank packer remains the only thing that culls; the subtree pass moves
     what fits and never removes. The two passes below are unchanged: the slot
     pass spaces parents WIDER than the fleet-only pass, because each parent now
     makes room for the slot hanging under it — that is the point, not a
     drift — and the displacement check above still compares who is present,
     never where they stand. */
  _slotsDisplaceAnAgent(agents, fleetLayout, withSlots) {
    return agents.some(agent =>
      fleetLayout.slots.has(agent.id) && !withSlots.slots.has(agent.id))
  }

  /* THE WHOLE OFFER DECISION, IN ONE PLACE AND WITHOUT A DOM.
     Plan the offers, lay the canvas out again with them present, and keep that
     second layout only if it still holds every agent the fleet-only pass held.
     It reads nothing off the page and writes nothing to it, so the rule this
     file keeps repeating — an empty circle is never worth an agent's place,
     and a tree with legal room is never left with nowhere to press — can be
     asserted directly against the code that enforces it, instead of against a
     copy of it written out again in a test. `_layoutNow` below is the only
     caller; it takes the pair back and gets on with drawing. */
  _settleEmptySlots({ agents, edges, fleetLayout }) {
    const plans = this._planEmptySlots(agents, fleetLayout)
    if (!plans.length) return { plans, layout: fleetLayout }
    if (!this.editMode) {
      const slots = new Map(fleetLayout.slots)
      const radii = new Map(fleetLayout.radii)
      for (const plan of plans) {
        const point = fleetLayout.slots.get(plan.parentId)
        const root = agents.find(agent => !agent.parentId)
        const rootPoint = fleetLayout.slots.get(root?.id)
        slots.set(plan.id, this.nodeStyle === 'boxes' && rootPoint && !point
          ? { x: rootPoint.x - this._boxSize().width / 2 - 34, y: rootPoint.y }
          : point
          ? { x: point.x + (fleetLayout.radii.get(plan.parentId) || 39) + 24, y: point.y }
          : { x: rootPoint ? rootPoint.x - 116 : this.W / 2, y: rootPoint?.y ?? this.H / 2 })
        radii.set(plan.id, agents.length ? 14 : EMPTY_SLOT_RADIUS)
      }
      return { plans, layout: { ...fleetLayout, slots, radii } }
    }
    const withSlots = layoutTree({
      nodes: [...agents, ...plans.map(plan => this._emptyLayoutNode(plan))],
      edges,
      W: this.W,
      H: this.H,
      spacious: !!this.smartScope && this.editMode,
    })
    if (this._slotsDisplaceAnAgent(agents, fleetLayout, withSlots)) {
      return { plans: [], layout: fleetLayout }
    }
    return { plans, layout: withSlots }
  }

  _layoutNow({ preserve = new Set() } = {}) {
    if (this._destroyed) return
    this._nodeDrag?.cancel()
    const agents = this._layoutAgents()
    const edges = this.declaredEdges || []
    /* THE FLEET IS LAID OUT FIRST, AND ON ITS OWN.
       Two things are read from this pass and from nothing else: whether the
       tree is too dense to read (the drill hint), and which agents fit. Both
       are claims about the fleet, and a slot must not be able to make either
       of them true. */
    const fleetLayout = this.nodeStyle === 'boxes'
      ? layoutBoxTree({ nodes: agents, edges, W: this.W, H: this.H, contextSize: this.cardSize })
      : layoutTree({ nodes: agents, edges, W: this.W, H: this.H, spacious: this.spacious && (!this.editMode || this.smartScope) })
    this._syncContextCardControl()
    this._realDrillRequired = fleetLayout.drillRequired

    const { plans, layout: result } = this._settleEmptySlots({ agents, edges, fleetLayout })

    this._layoutResult = result
    this._culled = result.culled
    this._layoutVisibleIds = new Set(agents.map(agent => agent.id))
    /* Stamped by the layout itself, so every route into here — a drag, a
       resize, a drill, a direct call — leaves the skip-check above holding
       the key of the geometry actually on screen. */
    this._layoutKey = this._structureKey()

    /* BELOW THE RADIUS FLOOR, THE ONLY HONEST ANSWER IS MORE HEIGHT.
       The layout says how much (minHeight, from the vertical fitter's own
       arithmetic); the wrap asks for it and the page scrolls -- the same cure
       .comp-body's static min-height already applies in styles.css. The
       subtlety is CLEARING the ask: with the ask applied, this.H is the
       inflated height, so "the tree fits now" cannot be read from the current
       pass -- that misread would clear, shrink, refit, re-ask, forever. The
       natural height is remembered from the last un-asked layout, and the ask
       is dropped only when a probe at THAT height fits. One extra layoutTree
       call, only while an ask is active, DOM-free by contract. */
    const layoutNodes = plans.length && result !== fleetLayout
      ? [...agents, ...plans.map(plan => this._emptyLayoutNode(plan))]
      : agents
    if (!this._heightAsk) this._naturalH = this.H
    if (Number.isFinite(result.minHeight) && result.minHeight > this.H) {
      this._heightAsk = result.minHeight
      this.container.style.minHeight = `${result.minHeight}px`
    } else if (this._heightAsk) {
      const probe = layoutTree({ nodes: layoutNodes, edges, W: this.W, H: this._naturalH })
      if (!Number.isFinite(probe.minHeight)) {
        this._heightAsk = null
        this.container.style.minHeight = ''
      }
    }

    /* The layout is allowed to shrink the circles so the tiers clear each
       other on a short canvas (src/tree-layout.js, vertical fitter). It hands
       back what it decided, and every consumer of the radius has to move with
       it — the drawn diameter (--d), the clamp that keeps a node on the
       canvas below, the leader-line origins and the obstacle boxes in
       _placeChips all read record.r. Recomputed from the role on every
       layout, never from the last shrunk value, so a window that grows gives
       the circles their full size back instead of ratcheting down. */
    for (const record of this.nodes.values()) {
      const radius = result.radii?.get(record.id)
      if (!Number.isFinite(radius) || radius === record.r) continue
      record.r = radius
      record.el.style.setProperty('--d', `${radius * 2}px`)
    }

    for (const record of this.nodes.values()) {
      const slot = result.slots.get(record.id)
      const hidden = !slot || result.culled.has(record.id)
      record.el.hidden = hidden
      record.chip?.classList.toggle('screen-chip-visible', !hidden && !this.editMode)
      record.chipLeader?.classList.toggle('visible', !hidden && !this.editMode)
      record.chipLeaderDot?.classList.toggle('visible', !hidden && !this.editMode)
      if (hidden || preserve.has(record.id)) continue
      record.slot = slot
      /* An override is a nudge against THIS parent's slot. If the record's
         parent has changed since the nudge was saved — reparent by drag, by
         the Move picker, by the store, any route at all — the override is
         meaningless and dies here, without each route having to remember to
         clear it. This is the fix for the stale connector lines (owner
         defect 2): the line was drawn to slot+offset where offset belonged
         to a layout that no longer exists. */
      let offset = this._positions[record.id] || { dx: 0, dy: 0 }
      if (offset.v === 2 && (offset.parentId ?? null) !== (record.agent.parentId ?? null)) {
        this._clearPosition(record.id)
        offset = { dx: 0, dy: 0 }
      }
      /* THE NUDGE IS WHAT GETS CLAMPED, NEVER THE LAYOUT'S OWN POSITION.
         Both bounds contain the slot, so an un-nudged record (dx = dy = 0)
         lands exactly where the layout put it — the old clamps moved big
         circles even at rest, and that push-down was the overlap the owner
         called a regression. Vertically the nudge also stays in its own
         rank corridor (owner, iteration 5: "the top circles should stay at
         the top — not overlap ever"): the midline between rows is the
         fence, and the label-collision veto below is the precise check. */
      record.x = clamp(slot.x + offset.dx, Math.min(record.r + 12, slot.x), this._rightReach(record, slot.x))
      record.y = clamp(slot.y + offset.dy, ...this._rankCorridor(record, result, slot.y))
      const label = result.labels.get(record.id)
      const text = record.el.querySelector('.nn-t')
      if (text && label) text.textContent = label.text
      if (label?.title) record.el.querySelector('.node-name')?.setAttribute('title', label.title)
      if (label?.maxWidth) record.el.style.setProperty('--nn-max', `${label.maxWidth}px`)
      else record.el.style.removeProperty('--nn-max')
      record.labelMax = label?.maxWidth || null
      this._positionRecord(record)
    }
    /* An override may not recreate the overlap the packer just removed: a
       nudged node that would come within MIN_AIR of any other placed record
       or of an offered slot loses its nudge and returns to its own slot.
       Checked after every record has its position, because the collision is
       between FINAL positions, not slots. */
    const rectsMeet = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
    const circleMeetsRect = (cx, cy, r, box) => {
      const px = Math.max(box.left, Math.min(cx, box.right))
      const py = Math.max(box.top, Math.min(cy, box.bottom))
      return Math.hypot(cx - px, cy - py) < r - 2
    }
    const covered = new Set()
    for (const record of this.nodes.values()) {
      if (record.el.hidden || !this._positions[record.id]) continue
      let collides = false
      const recordBox = this._labelBox(record)
      for (const other of this.nodes.values()) {
        if (other === record || other.el.hidden) continue
        /* Circle-vs-circle, and now ALSO the words: a nudge that leaves the
           circles clear but drops this node's label onto a neighbour's label
           or circle is the overlap the owner sees, and it was invisible to
           the old circle-only test. */
        const otherBox = this._labelBox(other)
        if (Math.hypot(other.x - record.x, other.y - record.y) < record.r + other.r + 2
          || rectsMeet(recordBox, otherBox)
          || circleMeetsRect(other.x, other.y, other.r, recordBox)
          || circleMeetsRect(record.x, record.y, record.r, otherBox)) {
          collides = true
          break
        }
      }
      if (!collides) {
        /* An offered "+" under a moved agent gives way instead of the move:
           the person put the agent there (owner, 2026-09-10), and the offer
           comes back when the agent moves off it. */
        for (const plan of plans) {
          const slot = result.slots.get(plan.id)
          if (slot && Math.hypot(slot.x - record.x, slot.y - record.y) < record.r + EMPTY_SLOT_RADIUS + 2) covered.add(plan.id)
        }
      }
      if (collides) {
        this._clearPosition(record.id)
        /* Back to the layout's own position VERBATIM — clamping the return
           trip was the same at-rest shift the apply above just stopped
           doing, and a "reverted" node that lands somewhere the layout
           never chose reads as random. */
        record.x = record.slot.x
        record.y = record.slot.y
        this._positionRecord(record)
      }
    }
    this._syncEmptySlots(covered.size ? plans.filter(plan => !covered.has(plan.id)) : plans, result)
    this._renderLinks()
    this.updateDensity()
    this._placeChips()
    this._publishNodeCount()
    /* WHAT IS ON THE GLASS, ASKED AT THE ONLY MOMENT IT CAN BE. Everything
       above is positioned now, so this is the first point in the pass where
       the drawn extent is knowable. The question is the defect itself -- is
       any of this tree somewhere the reader cannot see and cannot scroll to
       -- and it is deliberately NOT gated on the layout's height ask: the ask
       is set and cleared across several passes as the container's own
       min-height feeds back through the resize observer, and gating on it
       meant the second rotation into landscape kept 1.00x with two of five
       agents off the screen while the first rotation fitted correctly.
       _autoFitToHost's first two lines are cheap and answer "not my business"
       for every steered view. */
    this._autoFitToHost()
  }



  /* Reconcile the drawn slots against the plan, by id, the same way
     _reconcile does for agents. Rebuilding the elements every layout would be
     shorter and would throw away keyboard focus on every resize — a person who
     has tabbed to a slot and then widened the window would find the focus back
     at the top of the page. An id that survives keeps its element. */
  _syncEmptySlots(plans, result) {
    const wanted = new Map(plans.map(plan => [plan.id, plan]))
    for (const [id, slot] of [...this.emptySlots]) {
      if (wanted.has(id)) continue
      slot.el.remove()
      this.emptySlots.delete(id)
    }
    for (const plan of plans) {
      const slot = this.emptySlots.get(plan.id) || this._createEmptySlot(plan)
      slot.kind = plan.kind
      slot.parentId = plan.parentId
      if (slot.el.getAttribute('aria-label') !== plan.name) {
        slot.el.setAttribute('aria-label', plan.name)
        slot.el.setAttribute('title', plan.hint)
      }
      const point = result?.slots.get(plan.id)
      slot.hidden = !point || result.culled.has(plan.id)
      slot.el.hidden = slot.hidden
      if (slot.hidden) continue
      /* The vertical fitter may have shrunk the whole tree; a slot is already
         at the floor, but read the radius back rather than assume it, for the
         same reason the agent records do — the drawn diameter, the leader
         origin and the obstacle box all have to be the same number. */
      const radius = result.radii?.get(plan.id)
      slot.r = Number.isFinite(radius) ? radius : EMPTY_SLOT_RADIUS
      slot.el.classList.toggle('tree-add-compact', slot.r < EMPTY_SLOT_RADIUS)
      slot.el.style.setProperty('--d', `${slot.r * 2}px`)
      /* Layout positions verbatim, same rule as the agent records above: a
         slot nobody can drag has no nudge to clamp, and the old edge clamps
         pulled clipped rows back INTO view on short canvases — parked on
         top of the row above. Clipped below the fold beats overlapped. */
      slot.x = point.x
      slot.y = point.y
      this._positionEmptySlot(slot)
    }
  }

  _emptyGeometry(slot, zoom = this.zoom) {
    const scale = this._nodeScale(zoom)
    let { x, y } = slot
    if (!this.editMode && slot.r < EMPTY_SLOT_RADIUS) {
      const parent = slot.parentId ? this.nodes.get(slot.parentId)
        : [...this.nodes.values()].find(record => !record.agent.parentId && !record.el.hidden
          && this._layoutVisibleIds.has(record.id))
      if (parent) {
        const radius = this.nodeStyle === 'boxes' ? this._boxSize().width / 2 : parent.r
        const distance = (radius + slot.r) * scale + 8 / zoom
        x = parent.x + (slot.parentId ? distance / Math.SQRT2 : -distance)
        y = parent.y - (slot.parentId ? distance / Math.SQRT2 : 0)
      }
    }
    return { x, y, scale, r: slot.r * scale }
  }

  _positionEmptySlot(slot) {
    if (slot.hidden) return
    const point = this._emptyGeometry(slot)
    slot.x = point.x
    slot.y = point.y
    slot.el.style.left = `${slot.x}px`
    slot.el.style.top = `${slot.y}px`
  }

  /* A REAL BUTTON, not a div wearing role="button".
     The node records above are divs with role and tabindex and a hand-written
     keydown branch for Enter and Space, because they carry a second gesture
     (Shift+Enter opens the controls) and a drag. A slot carries one gesture and
     nothing else, so it can be the element the platform already implements:
     focusable in the tab order, announced as a button, activated by Enter AND
     by Space, with no keyboard code in this file to get wrong. */
  _createEmptySlot(plan) {
    const button = el(`
      <button type="button" class="tree-empty-node" data-empty-kind="${escapeMarkup(plan.kind)}">
        <span class="tree-empty-ring" aria-hidden="true"><span class="tree-empty-mark">+</span></span>
      </button>
    `)
    button.dataset.emptySlot = plan.id
    if (plan.parentId) button.dataset.parentId = plan.parentId
    button.style.setProperty('--d', `${EMPTY_SLOT_RADIUS * 2}px`)
    button.setAttribute('aria-label', plan.name)
    button.setAttribute('title', plan.hint)
    const slot = {
      id: plan.id,
      kind: plan.kind,
      parentId: plan.parentId,
      el: button,
      x: this.W / 2,
      y: this.H / 2,
      r: EMPTY_SLOT_RADIUS,
      hidden: true,
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      /* A click synthesised by Enter or Space on a native button reports
         detail 0; a real pointer click reports at least 1. That is the whole
         difference, and it is worth carrying because whoever opens a panel in
         response needs to know whether to move focus into it. */
      this._pressEmptySlot(slot, event.detail === 0 ? 'keyboard' : 'pointer')
    })
    this._bindStandaloneDrop(button, slot)
    this.container.appendChild(button)
    this.emptySlots.set(slot.id, slot)
    return slot
  }

  // Only the owning workspace may resolve the drag token. A tab from another
  // computer/window or a synthetic group never becomes a tree node by inference.
  _bindStandaloneDrop(button, slot) {
    const workspace = () => (this.chatOwner || this).workspace
    const accepts = event => !this._destroyed && !this.editMode && !this._linkMode
      && !button.hidden && !button.disabled
      && !!workspace()?.graph.onPlaceStandalone
      && [...(event.dataTransfer?.types || [])].includes('application/x-toolsenabled-standalone-agent')
      && (slot.kind === 'new-tree' || (this._agentFor(slot.parentId) && !this._agentFor(slot.parentId).treeScope?.group))
    button.addEventListener('dragover', event => {
      if (!accepts(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      button.classList.add('standalone-drop-target')
    })
    button.addEventListener('dragleave', event => {
      if (!button.contains(event.relatedTarget)) button.classList.remove('standalone-drop-target')
    })
    button.addEventListener('drop', event => {
      button.classList.remove('standalone-drop-target')
      if (!accepts(event)) return
      event.preventDefault()
      event.stopPropagation()
      let data
      try { data = JSON.parse(event.dataTransfer.getData('application/x-toolsenabled-standalone-agent')) } catch { return }
      const owner = workspace()
      if (data?.computerId !== this.computer.id || typeof data.id !== 'string' || !owner.standalone.has(data.id)) return
      void owner.placeStandalone(data.id, slot.kind === 'child' ? slot.parentId : null)
    })
  }

  /* REPORT THE PRESS. START NOTHING.
     This file draws a tree; it does not own what an empty slot means. It says
     which slot was pressed, under which parent, in which of the displayed computer's
     trees, and stops. No panel is opened here, no agent is created here, and
     no state on this graph changes — a slot that has been pressed looks exactly
     like a slot that has not, until whoever owns the model changes the model
     and this graph is asked to draw it again. */
  _pressEmptySlot(slot, via) {
    if (this._destroyed) return
    const parent = slot.parentId ? this._agentFor(slot.parentId) : null
    // The parent went away between the draw and the press. Reporting a child
    // of nothing is worse than reporting nothing.
    if (slot.kind === 'child' && !parent) return
    const detail = {
      kind: slot.kind,
      slotId: slot.id,
      parentId: parent ? parent.id : null,
      parent,
      // Which of the displayed computer's trees is being extended: the root the pressed
      // parent hangs from. A new tree has no root yet, so it has no treeId.
      treeId: parent ? (this.ancestryOf(parent.id)[0]?.id ?? parent.id) : null,
      computerId: this.computer?.id ?? null,
      via,
    }
    if (slot.kind === 'new-tree') this.windowBoard?.noteNewTreeRequested?.()
    this.onEmptyPress?.(detail)
    this.container.dispatchEvent(new CustomEvent(TREE_EMPTY_PRESS_EVENT, {
      detail,
      bubbles: true,
    }))
  }

  /* Turn the offer off and on without rebuilding the graph — a mount that has
     no way to act on a press should not draw one. */
  setEmptySlots(on) {
    const next = on !== false
    if (next === this.emptySlotsEnabled) return
    this.emptySlotsEnabled = next
    this._layoutNow()
  }

  /* REDRAW FROM THE MODEL AS IT NOW STANDS.
     The public name for what _reconcile already does, and the answer to "an
     agent was just added, how do I show it": not by rebuilding the graph.
     A rebuild would take the zoom, the pan, the drilled-in root and the
     keyboard focus with it — every one of which the person set on purpose,
     and none of which the new agent is a reason to discard. */
  refresh() {
    if (this._destroyed) return
    this._scopeRevision = (this._scopeRevision || 0) + 1
    if (this._treeScope) {
      this._treeScope.update(this.computer?.agents || [], this.declaredEdges || [])
      if (this.rootId && !this._treeScope.agent(this.rootId)) {
        let parent = this._treeScope.groups.get(this.rootId)?.parentId || null
        while (parent && !this._treeScope.agent(parent)) parent = this._treeScope.groups.get(parent)?.parentId || null
        this._transitionRoot(parent)
      }
    }
    this._reconcile()
    this.treeWindows?.refresh()
  }

  _positionRecord(record) {
    record.el.style.left = `${record.x}px`
    record.el.style.top = `${record.y}px`
    const slot = this.emptySlots?.get(`${CHILD_SLOT_PREFIX}${record.id}`)
    if (slot) this._positionEmptySlot(slot)
  }

  _nodeScale(zoom = this.zoom) {
    if (this.nodeStyle === 'boxes') return 1
    if (!this.spacious || this.editMode) return 1
    const overview = !this._fittingView && this._fitFloor ? Math.min(1, zoom / this._fitFloor) : 1
    const floor = Math.min(NODE_MIN_SCALE, Math.max(0.25, (this.zoomHost.clientHeight - 24) / 200)) * overview
    const scale = Math.max(1, floor / (zoom || 1))
    return (this.computer?.agents?.length || 0) > TREE_COLLAPSE_AT ? Math.min(scale, 1.12 / (zoom || 1)) : scale
  }

  _nodeRadius(record) {
    return record.r * (record.agent ? this._nodeScale() : 1)
  }

  /* Orthogonal parent->child routing. A starburst of straight centre-to-centre
     lines crosses every card on the canvas and reads as an explosion rather
     than a hierarchy -- the owner's "the lines themselves are just absolutely
     nonsense". Siblings dropping to the same row now share one horizontal bus,
     so a tier reads as one bracket. The segments are axis-aligned, which is
     also what lets the context blocks avoid them EXACTLY (see _placeChips)
     instead of approximately. */
  _elbowRoute(from, to, busY) {
    const startX = from.x
    const startY = from.y + this._nodeRadius(from)
    const endX = to.x
    const endY = to.y - this._nodeRadius(to)
    const straight = {
      d: `M ${startX} ${startY} L ${endX} ${endY}`,
      segments: [{ x1: startX, y1: startY, x2: endX, y2: endY }],
    }
    if (!(busY > startY + 2) || !(busY < endY - 2)) return straight
    if (Math.abs(startX - endX) < 1.5) return straight
    const dx = endX - startX
    const sign = dx > 0 ? 1 : -1
    const radius = Math.max(0, Math.min(9, Math.abs(dx) / 2, (busY - startY) / 2, (endY - busY) / 2))
    const d = [
      `M ${startX} ${startY}`,
      `L ${startX} ${busY - radius}`,
      `Q ${startX} ${busY} ${startX + sign * radius} ${busY}`,
      `L ${endX - sign * radius} ${busY}`,
      `Q ${endX} ${busY} ${endX} ${busY + radius}`,
      `L ${endX} ${endY}`,
    ].join(' ')
    return {
      d,
      segments: [
        { x1: startX, y1: startY, x2: startX, y2: busY },
        { x1: startX, y1: busY, x2: endX, y2: busY },
        { x1: endX, y1: busY, x2: endX, y2: endY },
      ],
    }
  }

  _renderLinks() {
    const links = []
    const pairs = new Set()
    const pairKey = (left, right) => `${left}>${right}`
    const paintable = (record) => !!record && !this._culled.has(record.id)
      && this._layoutVisibleIds.has(record.id)
    for (const record of this.nodes.values()) {
      const parent = record.agent.parentId ? this.nodes.get(record.agent.parentId) : null
      if (!paintable(record) || !paintable(parent)) continue
      pairs.add(pairKey(parent.id, record.id))
      pairs.add(pairKey(record.id, parent.id))
      links.push({ from: parent, to: record, soft: false, type: 'hierarchy' })
    }
    for (const edge of this.declaredEdges || []) {
      const fromId = String(edge.from ?? edge.source ?? '')
      const toId = String(edge.to ?? edge.target ?? '')
      /* A declared "escalates_to" is the same relationship the "manages" edge
         already draws, pointing the other way. Drawing both doubled every line
         on the canvas and added no fact: one relationship, one line. */
      if (pairs.has(pairKey(fromId, toId))) continue
      const from = this.nodes.get(fromId)
      const to = this.nodes.get(toId)
      if (!paintable(from) || !paintable(to)) continue
      pairs.add(pairKey(fromId, toId))
      pairs.add(pairKey(toId, fromId))
      links.push({ from, to, soft: true, type: edge.type || 'declared' })
    }
    /* A slot is joined to its parent by the same orthogonal trunk its real
       siblings use, in the same style, in a lighter dashed weight. It has to
       be the same shape of line or the slot stops reading as part of that
       family and starts reading as loose furniture near it; and it has to be
       visibly lighter or it reads as a relationship that exists. Not `soft`:
       soft is the declared-edge whisper, drawn as a straight diagonal, and a
       diagonal here would be the only diagonal on a canvas of elbows. */
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden || !slot.parentId || slot.r < EMPTY_SLOT_RADIUS) continue
      const parent = this.nodes.get(slot.parentId)
      if (!paintable(parent)) continue
      links.push({ from: parent, to: slot, soft: false, empty: true, type: 'empty' })
    }

    const buses = new Map()
    for (const link of links) {
      if (link.soft) continue
      const key = `${link.from.id}@${Math.round(link.to.y)}`
      /* The SAME measure _elbowRoute spans, not the raw radius. _nodeRadius scales a
         circle that has an agent by _nodeScale, which rises above 1 whenever the view is
         zoomed out so circles stay legible. Measuring the bus at `record.r` put the tier's
         shared bracket across a different span than the route draws -- 315.3 against 309.66
         at 2.2x on a 400px drop, growing with both the scale and the gap -- and in the tight
         case it lands outside the drawn span, where _elbowRoute's guard gives up and returns
         a straight diagonal on a canvas whose whole point is that it has none. */
      const top = link.from.y + this._nodeRadius(link.from)
      const bottom = link.to.y - this._nodeRadius(link.to)
      buses.set(key, Math.min(buses.get(key) ?? Infinity, top + (bottom - top) * 0.55))
      link.busKey = key
    }

    this.svg.innerHTML = ''
    const segments = []
    const strokes = new Map()
    const routes = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    routes.setAttribute('class', 'tree-link-routes')
    for (const link of links) {
      const element = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      element.setAttribute('class', 'tree-link-route')
      const route = link.soft
        ? {
            d: `M ${link.from.x} ${link.from.y} L ${link.to.x} ${link.to.y}`,
            segments: [{ x1: link.from.x, y1: link.from.y, x2: link.to.x, y2: link.to.y }],
          }
        : this._elbowRoute(link.from, link.to, buses.get(link.busKey))
      element.setAttribute('d', route.d)
      element.setAttribute('data-from', link.from.id)
      element.setAttribute('data-to', link.to.id)
      element.setAttribute('data-edge-type', link.type)
      routes.appendChild(element)
      const style = link.soft ? 'soft' : link.empty ? 'empty' : 'hierarchy'
      if (!strokes.has(style)) strokes.set(style, [])
      strokes.get(style).push(route.d)
      // Only the orthogonal hierarchy segments become placement obstacles: a
      // diagonal whisper's bounding box would reserve a quarter of the canvas.
      if (!link.soft) segments.push(...route.segments)
    }
    this.svg.appendChild(routes)
    // Stroke each style once. Separate translucent paths repaint every shared
    // trunk, darkening it for each child and accumulating antialiasing fringes.
    // Merge shared geometry before stroking: compound paths alone can still
    // overdraw their duplicate subpaths at fractional non-scaling zoom.
    // Per-edge geometry above stays addressable without painting it again.
    for (const [style, paths] of strokes) {
      const element = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      element.setAttribute('class', `tree-link link-top${style === 'soft' ? ' link-soft' : ''}${style === 'empty' ? ' link-empty' : ''}`)
      element.setAttribute('data-edge-style', style)
      element.setAttribute('data-edge-count', String(paths.length))
      element.setAttribute('d', style === 'hierarchy' ? mergeTreeStrokeRoutes(paths) : paths.join(' '))
      element.setAttribute('vector-effect', 'non-scaling-stroke')
      if (style === 'hierarchy') {
        // Apply translucency after the union is painted. A rounded junction
        // may still cross a straight drop; it must not become darker there.
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        group.setAttribute('class', 'tree-hierarchy-strokes')
        group.appendChild(element)
        this.svg.appendChild(group)
      } else this.svg.appendChild(element)
    }
    this._linkSegments = segments
    this._renderCommunicationLinks(paintable)
    this.windowBoard?.scheduleLinks()
  }

  updateDensity() {
    const active = [...this.nodes.values()].filter(record =>
      this._layoutVisibleIds.has(record.id) && !this._culled.has(record.id))
    /* From the FLEET layout, never from the drawn one. The drawn layout may
       have culled a handful of empty slots to keep a rank readable, which sets
       its drillRequired flag; reading it here would put "this tree is too big
       to read, drill in" on the screen of somebody whose tree fits perfectly
       and who is only being offered fewer places to extend it. */
    const densityRequiresDrill = !!this._realDrillRequired || active.length >= DENSE_AT
      || active.some(record => record.agent.treeScope?.expandable)
    const activeIds = new Set(active.map(record => record.id))
    const byParent = new Map()
    // A hidden child still belongs to its branch. Counting only visible
    // children made a fully culled branch look like a leaf, withdrawing the
    // very drill action that could reveal it in a large fleet.
    for (const record of this.nodes.values()) {
      if (!record.agent.parentId) continue
      if (!byParent.has(record.agent.parentId)) byParent.set(record.agent.parentId, [])
      byParent.get(record.agent.parentId).push(record)
    }
    const depth = (record) => {
      let value = 0
      let current = record
      const seen = new Set()
      while (current?.agent.parentId && !seen.has(current.id)) {
        seen.add(current.id)
        current = this.nodes.get(current.agent.parentId)
        value += 1
      }
      return value
    }
    const candidates = active.filter(record => byParent.has(record.id) && record.id !== this.rootId)
    const deepest = candidates.length ? Math.max(...candidates.map(depth)) : -1
    const focusableIds = new Set(candidates.filter(record =>
      depth(record) === deepest || byParent.get(record.id).some(child => !activeIds.has(child.id)))
      .map(record => record.id))
    for (const record of this.nodes.values()) {
      const focusable = record.agent.treeScope?.expandable || (densityRequiresDrill && focusableIds.has(record.id))
      record.el.classList.toggle('focusable', focusable)
    }
    this.onDensity?.(densityRequiresDrill)
  }

  _cancelPendingNodeClicks() {
    for (const record of this.nodes.values()) {
      clearTimeout(record.clickTimer)
      record.clickTimer = 0
    }
  }

  /* A card (a circle's context card, or a box) opens side chat; double-
     clicking an agent opens its conversation. Owner, 2026-09-10: "double
     clicking the circle should bring up a window and clicking on the card
     should bring up the sidebar". A circle's single click only selects. */
  handleClick(record) {
    this._cancelPendingNodeClicks()
    if (this._linkMode) { void this._chooseLinkNode(record); return }
    if (record.agent.treeScope?.group) { this.setRoot(record.id); return }
    this.select(record.id)
    if (this.workspace || this.chatOwner) {
      if (this.nodeStyle === 'boxes') this._openSideChat(record)
      return
    }
    if (this.screenChips && record.chip) this.openChat(record)
    else this.onOpenControls?.(record.agent)
  }

  // A card press: the side rail when this view has one, else the conversation.
  _openSideChat(record) {
    this.select(record.id)
    if (this.onOpenControls) this.onOpenControls(record.agent)
    else this.openChat(record)
  }

  select(id) {
    // A newer mouse/keyboard selection, or clearing it, supersedes any
    // delayed single click. Its old rail must not reopen afterwards.
    this._cancelPendingNodeClicks()
    this.selectedId = id
    for (const record of this.nodes.values()) record.el.classList.toggle('selected', record.id === id)
    const record = this.nodes.get(id)
    if (record) this.onSelect?.(record.agent)
  }

  _rememberScopeRoot(id) {
    if (!this.smartScope) { this._scopeHistory = []; return }
    if (id === this.rootId) return
    this._scopeHistory ||= []
    const previous = this._scopeHistory.findLastIndex(entry => entry.rootId === id)
    if (previous >= 0) this._scopeHistory.splice(previous)
    else this._scopeHistory.push({ rootId: this.rootId || null, exitZoom: this._scopeExitZoom })
  }

  setRoot(id, { fit = true } = {}) {
    if (this._linkMode) return
    if (!this._agentFor(id)) return
    const treeRoot = this.ancestryOf(id)[0]?.id
    if (this.windowRootIds && this.windowBoard) {
      if (!this.windowRootIds.includes(treeRoot) && this._scopeModel().byId.has(treeRoot)) {
        const frame = this.windowBoard.windows.find(frame => frame.graph === this)
        if (frame && treeRoot) this.windowBoard.choose(frame, [...this.windowRootIds, treeRoot])
      }
      this._cancelZoomMotion()
      this._rememberScopeRoot(id)
      this._spreadRequested = false
      this._viewSteered = true
      if (id !== this.rootId) this._transitionRoot(id)
      if (fit) { this._viewSteered = false; this.fitToHost(); this._autoFitted = true }
      this._scopeExitZoom = this._scopeHistory?.length ? this._fitFloor * 0.7 : undefined
      this.windowBoard.refreshHeaders()
      return
    }
    if (this.windowRootId && treeRoot && treeRoot !== this.windowRootId && this.windowBoard) {
      const frame = this.windowBoard.windows.find(frame => frame.graph === this)
      if (frame) this.windowBoard.choose(frame, treeRoot)
      if (id === treeRoot) return
    }
    this._cancelZoomMotion()
    this._rememberScopeRoot(id)
    this._spreadRequested = false
    if (fit) this._viewSteered = true
    if (id !== this.rootId) this._transitionRoot(id)
    if (fit) {
      this._viewSteered = false
      this.fitToHost()
      this._autoFitted = true
    }
    this._scopeExitZoom = this._scopeHistory?.length ? this._fitFloor * 0.7 : undefined
    this.windowBoard?.refreshHeaders()
  }

  clearRoot({ fit = true } = {}) {
    if (this.windowRootIds) {
      this._cancelZoomMotion()
      this._scopeHistory = []
      this._spreadRequested = false
      this.boxFocus = new Map()
      const root = this.windowRootId || null
      this._viewSteered = true
      if (root !== this.rootId) this._transitionRoot(root)
      else this._reconcile()
      if (fit) { this._viewSteered = false; this.fitToHost(); this._autoFitted = true }
      this.windowBoard?.refreshHeaders()
      return
    }
    if (this.windowRootId) { this.setRoot(this.windowRootId, { fit }); return }
    this._cancelZoomMotion()
    this._scopeHistory = []
    this._spreadRequested = false
    if (fit) this._viewSteered = true
    if (this.rootId) this._transitionRoot(null)
    if (fit) {
      this._viewSteered = false
      this.fitToHost()
      this._autoFitted = true
    }
  }

  _transitionRoot(nextRoot) {
    this._refreshExtensionPoints()
    if (this.windowRootIds) this.boxFocus = nextRoot && nextRoot !== this.windowRootId
      ? new Map([[this._scopeModel().ancestry(nextRoot)[0]?.id, nextRoot]]) : new Map()
    const transitionRevision = ++this._transitionRevision
    const oldRoot = this.rootId
    const focusId = nextRoot || oldRoot
    const focusRecord = this.nodes.get(focusId)
    const from = focusRecord ? { x: focusRecord.x, y: focusRecord.y } : null
    const wasPainted = new Set([...this.nodes.values()]
      .filter(record => !record.el.hidden && !this._culled.has(record.id))
      .map(record => record.id))
    for (const record of this.nodes.values()) record.el.classList.remove('tree-node-removing')
    this.rootId = nextRoot

    const visible = this.visibleAgents()
    const wanted = new Set(visible.map(agent => agent.id))
    for (const agent of visible) {
      const record = this.nodes.get(agent.id)
      if (!record) this._createRecord(agent, true)
      else {
        record.agent = agent
        this._renderRuntime(record)
        this._renderAccessibleName(record)
        this._renderScope(record)
        this._renderChipPreview(record)
      }
    }

    const outgoing = []
    for (const [id, record] of this.nodes) {
      if (!wanted.has(id) && !record.chatOpen) outgoing.push(record)
    }

    // Focus record is left at its old position while every other retained
    // node snaps invisibly to the new deterministic slots.
    this._layoutNow({ preserve: focusRecord ? new Set([focusId]) : new Set() })
    let targetSlot = focusRecord ? this._layoutResult?.slots.get(focusId) : null
    if (focusRecord && !targetSlot) {
      /* The focus record earned NO slot in the new layout (culled, or
         filtered out of the subtree). Preserving it anyway froze it at its
         old coordinates while every connector repainted around it — a stale
         line to a position no layout owns. Re-lay without the preserve so it
         is placed or hidden like any other record; the animation below is
         skipped (no target), and the single _renderLinks at the end paints
         the truth. */
      this._layoutNow()
      targetSlot = this._layoutResult?.slots.get(focusId) ?? null
    }
    const targetOffset = focusId ? this._positions[focusId] || { dx: 0, dy: 0 } : { dx: 0, dy: 0 }
    const target = focusRecord && targetSlot
      ? {
          /* Same containment-and-corridor as _layoutNow — the focus
             animation must land where the next layout would put it, or the
             settle jumps; and an un-nudged focus target is the slot
             itself, exactly. */
          x: clamp(targetSlot.x + targetOffset.dx, Math.min(focusRecord.r + 12, targetSlot.x), this._rightReach(focusRecord, targetSlot.x)),
          y: clamp(targetSlot.y + targetOffset.dy, ...this._rankCorridor(focusRecord, this._layoutResult, targetSlot.y)),
        }
      : null

    for (const record of this.nodes.values()) {
      if (record === focusRecord || !wanted.has(record.id)) continue
      record.el.classList.add('tree-branch-entering')
      const raf = requestAnimationFrame(() => {
        this._addRafs.delete(raf)
        record.el.classList.remove('tree-branch-entering')
      })
      this._addRafs.add(raf)
    }
    for (const record of outgoing) {
      if (!wasPainted.has(record.id)) {
        this._removeRecord(record, false)
        continue
      }
      // _layoutNow hides records outside the new subtree. Keep outgoing
      // records paintable for the one permitted removal fade.
      record.el.hidden = false
      record.el.classList.add('tree-node-removing')
      record.chip?.classList.remove('screen-chip-visible')
      record.chipLeader?.classList.remove('visible')
      record.chipLeaderDot?.classList.remove('visible')
      const timer = setTimeout(() => {
        this._removeTimers.delete(timer)
        if (!this._destroyed && transitionRevision === this._transitionRevision
          && !wanted.has(record.id) && !record.chatOpen
          && !this._layoutVisibleIds.has(record.id)
          && this.nodes.get(record.id) === record) this._removeRecord(record, false)
      }, REMOVE_MS + 24)
      this._removeTimers.add(timer)
    }

    if (focusRecord && from && target) {
      focusRecord.slot = targetSlot
      this._animateRecord(focusRecord, from, target)
    }
    this.onRootChange?.(nextRoot, nextRoot ? this.ancestryOf(nextRoot) : [])
    this._layoutVisibleIds = wanted
    this._renderLinks()
    this.updateDensity()
    this._placeChips()
  }

  /* The 680ms re-root glide re-ran the chip beam-search on EVERY frame — the
     most expensive routine on the page, sixty times a second, to decorate a
     click. The owner asked for no required motion and for function over
     decoration; the re-root now lands immediately. */
  _animateRecord(record, from, target) {
    if (this._animationRaf) cancelAnimationFrame(this._animationRaf)
    this._animationRaf = 0
    record.x = target.x
    record.y = target.y
    this._positionRecord(record)
    record.el.classList.remove('rerooting')
    this._renderLinks()
    this._placeChips()
  }

  setLayout() {
    this.layout = 'tree'
    this.container.dataset.layout = 'tree'
  }

  setEditMode(on, { rootIds = null } = {}) {
    const next = !!on
    if (next === this.editMode) return
    this._nodeDrag?.cancel()
    if (this.smartScope) {
      // A picker can outlive the trees it listed. Refuse before changing the
      // camera/style rather than opening an empty edit canvas.
      let editRoots
      if (next) {
        const scope = this._scopeModel()
        editRoots = [...new Set(rootIds || this.windowRootIds || scope.children.get(null) || [])]
        if (!editRoots.length || editRoots.some(id => !scope.branch(id).length)) {
          if (this.panHint) this.panHint.textContent = 'Choose an available tree before editing. The selected trees may have changed.'
          return false
        }
      }
      this._cancelZoomMotion()
      if (next) {
        if (this._linkMode) this.setLinkMode(false)
        const cameraKeys = ['zoom', 'panX', 'panY', '_fitFloor', '_viewSteered', '_autoFitted', '_scopeExitZoom']
        this._editView = { nodeStyle: this.nodeStyle, rootId: this.rootId, wide: this._treeWide, selectedId: this.selectedId,
          camera: Object.fromEntries(cameraKeys.map(key => [key, this[key]])), history: [...(this._scopeHistory || [])] }
        this._editRootIds = editRoots
        this.editMode = true
        this.rootId = null
        this._scopeHistory = []
        this._viewSteered = false
        this._setRenderStyle('circles')
        this.container.dataset.editMode = 'true'
        this.screenOverlay?.setAttribute('data-edit-mode', 'true')
        this.workspace?.showTrees({ focus: false })
        this.treeWindows?.grid.classList.add('is-editing')
        this.setWide(true)
      } else {
        const previous = this._editView
        this.editMode = false
        this._editRootIds = null
        this.rootId = previous && previous.rootId == null ? null
          : previous?.rootId && this._agentFor(previous.rootId) ? previous.rootId
            : this._agentFor(this.windowRootId) ? this.windowRootId : null
        this._scopeHistory = previous?.history || []
        this._setRenderStyle(previous?.nodeStyle || this.nodeStyle)
        this.container.removeAttribute('data-edit-mode')
        this.screenOverlay?.removeAttribute('data-edit-mode')
        this.treeWindows?.grid.classList.remove('is-editing')
        this._dropRec?.el.classList.remove('drop-ok')
        this._dropRec = this._dropRaw = null
        this.setWide(!!previous?.wide)
      }
      this._layoutKey = null
      this._reconcile()
      this.resize(true)
      if (next) {
        this.fitCurrentTree()
        if (this.panHint) this.panHint.textContent = `${countNoun(this.visibleAgents().length, 'agent')} · Complete structure · Drag to move · Double-click for agent actions`
      } else {
        if (this._editView?.camera) Object.assign(this, this._editView.camera)
        const selectedId = this._editView?.selectedId
        this.select(selectedId && this._agentFor(selectedId) ? selectedId : null)
        this._editView = null
        this._applyZoom()
      }
      this.treeWindows?.refreshHeaders()
      this.treeWindows?.toolbar?.sync()
      return
    }
    if (next && this._treeScope?.groups.has(this.rootId)) {
      const parent = this.ancestryOf(this.rootId).reverse().find(item => this._treeScope.byId.has(item.id))
      this._transitionRoot(parent?.id || null)
    }
    this.editMode = next
    this._reconcile()
    if (next) {
      this.container.dataset.editMode = 'true'
      this.screenOverlay?.setAttribute('data-edit-mode', 'true')
      /* Slots STAY in edit mode (owner defect 4: "keep the gray + nodes").
         The old withdrawal's stated reason — "a slot cannot be dropped on" —
         stopped being true when slot drops became real moves: a child slot
         accepts a node as moveNode(id, slot.parentId), and the new-tree slot
         is the drag-out-to-its-own-tree gesture. Withdrawing them would now
         remove the mode's best drop targets. */
      this.resetZoom()
      this._layoutNow()
    } else {
      this.container.removeAttribute('data-edit-mode')
      this.screenOverlay?.removeAttribute('data-edit-mode')
      this._dropRec?.el.classList.remove('drop-ok')
      this._dropRec = null
      this._dropRaw = null
      this._layoutNow()
    }
    for (const record of this.nodes.values()) {
      if (record.chip) {
        const visible = !next && !this._culled.has(record.id)
        record.chip.classList.toggle('screen-chip-visible', visible)
        record.chipLeader?.classList.toggle('visible', visible)
        record.chipLeaderDot?.classList.toggle('visible', visible)
        record.chip.tabIndex = visible ? 0 : -1
      }
    }
    this._renderLinks()
    this._placeChips()
  }

  addAgent(agent) {
    if (this.rootId && !this.visibleAgents().some(candidate => candidate.id === agent.id)) return
    this._createRecord(agent, true)
    this._layoutNow()
  }

  removeAgent(id) {
    const record = this.nodes.get(id)
    if (!record) return
    this._removeRecord(record, true)
    this._layoutNow()
  }

  _buildChipOverlay() {
    this.screenOverlay = document.createElement('div')
    this.screenOverlay.className = 'static-tree-chip-overlay'
    this.screenOverlay.dataset.cardSize = this.cardSize
    this.screenOverlay.setAttribute('aria-label', 'Fleet monitoring context')
    this.screenLeaderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.screenLeaderSvg.setAttribute('class', 'graph-chip-leaders')
    this.screenLeaderSvg.setAttribute('aria-hidden', 'true')
    this.screenOverlay.appendChild(this.screenLeaderSvg)
    this.zoomHost.appendChild(this.screenOverlay)
  }

  _makeChip(record) {
    if (this.nodeStyle === 'boxes') {
      record.chip = record.el.querySelector('.tree-box-context')
      this._renderChipPreview(record)
      return
    }
    const chip = el(`<div class="chip static-tree-chip role-${rimRole(record.agent.role)}">
      ${monitorBrace()}<div class="chip-preview"></div>${monitorBrace(true)}
    </div>`)
    chip.dataset.agentId = record.id
    paintRoleColor(chip, record.agent.declaredRole || record.agent.role, accentIdOf(record.agent))
    chip.style.width = `${SCREEN_CHIP_W}px`
    chip.setAttribute('role', 'button')
    chip.setAttribute('aria-label', record.agent.treeScope?.group
      ? `${record.agent.name}; explore this group`
      : `${record.agent.name} monitoring context; open side chat. Shift+Enter opens the conversation`)
    chip.tabIndex = 0
    this.screenOverlay.appendChild(chip)
    record.chip = chip

    const leader = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    leader.setAttribute('class', `graph-chip-leader role-${rimRole(record.agent.role)}`)
    leader.dataset.agentId = record.id
    paintRoleColor(leader, record.agent.declaredRole || record.agent.role, accentIdOf(record.agent))
    leader.setAttribute('vector-effect', 'non-scaling-stroke')
    this.screenLeaderSvg.appendChild(leader)
    record.chipLeader = leader

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('class', `graph-chip-leader-dot role-${rimRole(record.agent.role)}`)
    dot.setAttribute('r', '2.25')
    dot.dataset.agentId = record.id
    paintRoleColor(dot, record.agent.declaredRole || record.agent.role, accentIdOf(record.agent))
    this.screenLeaderSvg.appendChild(dot)
    record.chipLeaderDot = dot

    this._renderChipPreview(record)
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this._linkMode) void this._chooseLinkNode(record)
      else if (event.detail > 1) return // a double click's second press is not a second request
      else if (record.agent.treeScope?.group) this.setRoot(record.id)
      else this._openSideChat(record)
    })
    chip.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (this._linkMode) void this._chooseLinkNode(record)
      else if (record.agent.treeScope?.group) this.setRoot(record.id)
      else if (event.key === 'Enter' && event.shiftKey) { this._cancelPendingNodeClicks(); this.openChat(record) }
      else this._openSideChat(record)
    })
    chip.addEventListener('pointerdown', () => {
      if (record.chatOpen) chip.style.zIndex = String(++chatZ)
    })
  }

  _screenContext(record) {
    if (record.agent.treeScope?.group) return {
      current: branchSummaryText(record.agent.treeScope.summary),
      previous: 'Zoom in to explore the agents in this group.',
      chat: '', tool: '', unavailable: '', model: '', tasks: NaN, failRate: NaN,
    }
    let supplied = null
    try { supplied = this.contextFeed?.(record.agent) }
    catch {
      /* This value is deliberately rebuilt on every render, not stored on the
         record: a busy feed gets another chance. It must also remain distinct
         from a feed that really returned no activity. */
      supplied = {
        code: TREE_CONTEXT_READ_FAILED,
        unavailable: 'Agent context could not be read; this is not claiming that no context exists.',
      }
    }
    const rows = Array.isArray(supplied)
      ? supplied
      : supplied?.activities || supplied?.context || record.agent.context || []
    const values = Array.isArray(rows) ? rows : [rows]
    const clean = (value) => value == null ? '' : String(value).replace(/\s+/g, ' ').trim()
    return {
      scope: record.agent.treeScope?.summary.total > 1 ? branchSummaryText(record.agent.treeScope.summary) : '',
      current: clean(supplied?.current ?? values.at(-1)),
      task: clean(supplied?.task ?? record.agent.treeNode?.message),
      tool: clean(supplied?.tool),
      thinking: clean(supplied?.thinking),
      previous: clean(supplied?.previous ?? values.at(-2)),
      // Keep Markdown boundaries until the shared preview parser has read them.
      chat: String(supplied?.chat?.text ?? supplied?.recentChat?.text ?? supplied?.chat ?? supplied?.recentChat ?? '').trim(),
      unavailable: clean(supplied?.unavailable),
      unavailableCode: supplied?.code || '',
      tasks: measuredNumber(supplied?.tasks ?? record.agent.tasksDone),
      failRate: measuredNumber(supplied?.failRate ?? record.agent.failRate),
      model: clean(supplied?.model ?? record.agent.model),
    }
  }

  /* Draw the circle's runtime face from record.agent, idempotently. Called at
     creation AND from _reconcile's existing-node branch, so a status change
     reaches the glass without a remount. The key skips redraws when nothing
     this face reads has changed -- _reconcile runs on every store write, and
     tearing down a ticking clock to rebuild the identical clock would fight
     the very liveness this exists to show. bindRuntime reads record.agent at
     tick time, never the creation-time object: the reconciled agent is the one
     whose clock this is. */
  _renderRuntime(record) {
    const agent = record.agent
    const node = record.el
    const key = `${agent.bornAt}|${agent.stoppedAt}|${agent.state}|${agent.projectionUnavailableReason || ''}|${agent.treeScope?.group ? agent.treeScope.summary.total : ''}`
    if (record.runtimeKey === key) return
    record.runtimeKey = key
    record.runtimeUnsub?.()
    record.runtimeUnsub = null
    const holder = node.querySelector('.node-runtime')
    if (!holder) return
    if (agent.treeScope?.group) {
      node.classList.add('tree-scope-group')
      holder.innerHTML = `<div class="rt">${agent.treeScope.summary.total}</div><div class="rl">agents</div>`
      node.setAttribute('aria-label', `${agent.name}; zoom in or press Enter to explore`)
      return
    }
    node.classList.toggle('spawning', agent.state === 'spawning')
    if (Number.isFinite(agent.bornAt)) {
      node.classList.remove('no-telemetry')
      node.removeAttribute('title')
      holder.innerHTML = '<div class="rt">0:00:00</div><div class="rl">Runtime</div>'
      const runtime = holder.querySelector('.rt')
      if (Number.isFinite(agent.stoppedAt)) {
        runtime.textContent = fmtRuntime(agent.bornAt, agent.stoppedAt)
        node.dataset.runtimeState = 'stopped'
      } else {
        record.runtimeUnsub = bindRuntime(runtime, () => record.agent.bornAt)
        node.dataset.runtimeState = 'running'
      }
    } else {
      /* An empty circle reads as a broken one. The node still knows something
         true about itself — whether the fleet declares it enabled — so it says
         that instead of showing nothing, in the caps register, and the layout
         sizes it for a word rather than for a clock. */
      node.classList.add('no-telemetry')
      node.dataset.runtimeState = 'unavailable'
      const stateWord = agent.state === 'disabled' ? 'disabled'
        : agent.state === 'enabled' ? 'enabled'
          : agent.state === 'finished' ? 'finished'
            : agent.state === 'failed' ? 'failed'
              : 'no signal'
      holder.innerHTML = `<div class="rt-state">${escapeMarkup(stateWord)}</div><div class="rl">no runtime</div>`
      node.title = `Runtime unavailable · ${agent.projectionUnavailableReason || 'not provided'}`
    }
  }

  _renderScope(record) {
    if (this.nodeStyle === 'boxes') { this._renderBoxPreview(record); return }
    const scope = record.agent.treeScope
    if (scope?.group) {
      const role = record.el.querySelector('.node-role')
      if (role) role.textContent = 'Agent group'
    }
    let badge = record.el.querySelector('.tree-branch-count')
    if (!scope?.hidden || scope.group || !scope.expandable) { badge?.remove(); return }
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'tree-branch-count'
      record.el.querySelector('.node-glass')?.appendChild(badge)
    }
    badge.textContent = `+${scope.hidden}`
    badge.title = `${countNoun(scope.hidden, 'agent')} below this node. Zoom in to explore.`
  }

  setContactMarks(value = {}) {
    this.contactMarks = value
    for (const record of this.nodes.values()) this._renderContactMark(record)
    if (!this.chatOwner) for (const frame of this.windowBoard?.windows || []) {
      if (frame.graph !== this) frame.graph.setContactMarks(value)
    }
  }

  _renderContactMark(record) {
    const contact = record.el.querySelector('.node-contact-icon')
    if (!contact) return
    const selected = this.contactMarks.voiceNodeId === record.id
    const screen = this.contactMarks.screenNodeIds?.includes(record.id) === true
    const state = selected ? this.contactMarks.voiceState || 'off' : 'off'
    contact.dataset.voiceSelected = String(selected)
    contact.dataset.voiceState = state
    contact.dataset.screenAccess = String(screen)
    contact.setAttribute('aria-pressed', String(selected))
    contact.setAttribute('aria-label', `Voice controls for ${record.agent.name}`)
    contact.title = `${record.agent.name} · ${selected ? state === 'off' ? 'voice selected, not recording' : `voice ${state}` : 'open voice controls'}${screen ? ' · screen access on' : ''}`
  }

  /* THE SWARM BOX AND THE DRIFT LIGHT. What is drawn is decided in
     src/lane-marks.js (the pure half — see its header for the owner's rules
     and the cloudLane contract); this binding only places it. Both marks ride
     the bubble's bottom-right at 45° on the rim (chip centre at r × 0.71, so
     the inset is r × 0.293 minus half the 24px chip), and when both show the
     light sits directly above the box. Nothing else about the node changes —
     no rim tint, no geometry: a mark the layout never has to know about. */
  _renderLaneMarks(record) {
    const lane = readCloudLane(record.agent.cloudLane)
    const view = laneMarksView(lane)
    const boxed = this.nodeStyle === 'boxes'
    const key = `${boxed}|${view.box ? view.box.hue || 'none' : ''}|${view.light?.stage || ''}|${lane?.tokens ?? ''}`
    const glass = record.el.querySelector('.node-glass')
    if (!glass) return
    const status = boxed && glass.querySelector('.tree-box-status-row')
    let holder = glass.querySelector('.tree-box-lane-marks')
    let box = glass.querySelector('.node-lane-box'), light = glass.querySelector('.node-drift-light')
    if (record.laneMarksKey === key && !!box === !!view.box && !!light === !!view.light
      && (!status || !(view.box || view.light) || holder?.parentElement === status)) return
    record.laneMarksKey = key
    record.el.classList.toggle('has-lane-marks', !!(view.box || view.light))
    if (status && (view.box || view.light)) {
      if (!holder) holder = el('<span class="tree-box-lane-marks"></span>')
      status.insertBefore(holder, status.querySelector('.tree-box-branch'))
    } else { holder?.remove(); holder = null }
    const host = holder || glass
    const inset = Math.max(0, Math.round(record.r * 0.293 - 12))
    const mark = (element, markup, label, bottom) => {
      if (!element) {
        element = el(markup)
        for (const name of ['pointerdown', 'click', 'dblclick']) element.addEventListener(name, event => event.stopPropagation())
      }
      element.setAttribute('role', 'img')
      element.setAttribute('aria-label', label)
      element.title = label
      element.style.right = status ? '' : `${inset}px`
      element.style.bottom = status ? '' : `${bottom}px`
      if (element.parentElement !== host) host.appendChild(element)
      return element
    }
    if (view.box) {
      const label = `Cloud swarm running · ${lane?.tokens === undefined ? 'token use not reported' : `${lane.tokens.toLocaleString('en-US')} tokens · ${view.box.word}`}`
      box = mark(box, `<span class="node-lane-box">
        <svg class="lane-cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="miter" aria-hidden="true"><path d="M4 17H3L1.5 15.5V11L4.5 8H7L9 4H14L17 8H20L22.5 10.5V15L20.5 17H19"/></svg>
        <span class="lb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
      </span>`, label, inset)
      if (view.box.hue) box.dataset.burn = view.box.hue
      else delete box.dataset.burn
    } else box?.remove()
    if (view.light) {
      light = mark(light, `
        <span class="node-drift-light">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">
            <path d="M3 5H7L11 8H15L19 5H21"/>
            <path d="M3 10.5H7L11 13.5H15L19 10.5H21"/>
            <path d="M3 16H7L11 19H15L19 16H21"/>
          </svg>
        </span>
      `, `Agent drift · ${view.light.word}`, view.box ? inset + 28 : inset)
      light.dataset.stage = view.light.stage
    } else light?.remove()
  }

  /* Repaint ONE chip from the current feed, without the full reconcile.
     refresh() re-lays the whole canvas — the right tool for structure, far too
     heavy per streamed token. The caller frame-batches; this stays narrow. */
  refreshChip(agentId) {
    if (this._destroyed) return
    const record = this.nodes.get(agentId)
    if (!record || !record.chip) return
    /* PLACEMENT DEPENDS ON THE CHIP'S BOX, so it is re-run when the box moves
       and not otherwise. The elected slots are a function of chip dimensions
       and node geometry; a repaint that leaves the height alone elects the
       same slots, and _placeChips() is a beam search that reads layout for
       every node on the canvas -- the most expensive thing on this page to
       run once a frame for nothing. */
    const before = record.chip.offsetHeight
    if (!this._renderChipPreview(record)) return
    if (record.chip.offsetHeight !== before) this._placeChips()
  }

  /* Answers whether it painted. The key-and-skip is the same one _renderRuntime
     has, for the same reason: a full reconcile rewrites every chip's innerHTML,
     an agent start performs several reconciles, and a streamed turn asks for a
     repaint every frame -- while for most of those the chip's words are
     identical. Every value the markup below interpolates is in the key. */
  _renderChipPreview(record) {
    if (this.nodeStyle === 'boxes') return this._renderBoxPreview(record)
    const profile = this._contextCardProfile(record.agent)
    if (profile.value === 'off') return false
    const preview = record.chip?.querySelector('.chip-preview')
    if (!preview) return false
    const feed = this._screenContext(record)
    const key = [
      record.agent.name, record.agent.role, record.agent.declaredRole, record.agent.treeScope?.group,
      record.agent.bornAt, record.agent.stoppedAt,
      feed.tasks, feed.failRate, feed.model, feed.current, feed.previous, feed.tool,
      feed.chat, feed.unavailable, feed.scope, feed.task, profile.value
    ].join('\u0000')
    /* The ELEMENT is part of the identity, not only the words. _makeChip
       builds a fresh chip (and closing a chat rebuilds its inside), so a new
       and empty .chip-preview must be painted even when the words that belong
       in it have not changed since the old one was filled. */
    if (record.chipPreviewKey === key && record.chipPreviewNode === preview) return false
    record.chipPreviewKey = key
    record.chipPreviewNode = preview
    record.chipRuntimeUnsub?.()
    record.chipRuntimeUnsub = null
    const roleKey = record.agent.role
    const formattedName = formatInlineText(record.agent.name, {
      agents: this.computer.agents,
      roleKey,
    })
    const tasks = Number.isFinite(feed.tasks) ? `${Math.max(0, Math.round(feed.tasks))} tasks` : ''
    const failure = Number.isFinite(feed.failRate) ? `${Math.max(0, feed.failRate)}% fail` : ''
    /* THE MODEL RIDES WITH THE TELEMETRY; IT DOES NOT STAND IN FOR IT.
       `[tasks, failure, model].filter(Boolean)` meant one declared attribute --
       the provider, which is "none" in the shipped organisation -- was enough to
       make `facts` truthy, so the "telemetry unavailable" line below could never
       be reached on the copy that needs it. Whether this chip has a MEASUREMENT
       is now decided by the measurements alone. */
    const measured = [tasks, failure].filter(Boolean)
    const facts = measured.length ? [...measured, feed.model].filter(Boolean).join(' · ') : ''
    const group = record.agent.treeScope?.group
    const role = group ? 'Branch group' : roleAppearance(record.agent.declaredRole || roleKey).label
    /* Collapsing whitespace was already right for a one-line chip; T293 adds
       the other half -- the markup itself, taken off by the same parser the
       conversation renders with rather than by a second opinion here. */
    const briefText = value => latestNodeResponse(String(value || '').replace(/^asked:\s*/i, ''))
    // Show the latest actual context once. The original task is a fallback,
    // not a second section repeated beside the reply.
    const context = feed.chat || feed.previous || feed.task || ''
    const contextClass = feed.chat ? 'cl-chat' : 'cl-previous'
    const contextLabel = feed.chat ? 'Latest update' : /^asked:/i.test(context) ? 'Brief' : 'Context'
    const row = (className, label, value) => `<div class="cl ${className}" title="${escapeMarkup(value)}"><span class="chip-context-caption">${label}</span><span class="chip-context-text"${className === 'cl-chat' ? ' data-preview-tail="true"' : ''}>${escapeMarkup(value)}</span></div>`
    preview.innerHTML = `
      <div class="chip-preview-header">
        <div class="cl cl-name"><b title="${escapeMarkup(record.agent.name)}">${formattedName}</b><span class="chip-runtime"></span></div>
        <div class="cl cl-meta"><span class="chip-role" title="${escapeMarkup(role)}">${escapeMarkup(role)}</span>${feed.current ? `<span class="cl-current" title="${escapeMarkup(feed.current)}">${escapeMarkup(feed.current)}</span>` : ''}</div>
        ${feed.tool ? `<div class="chip-latest-action" title="${escapeMarkup(feed.tool)}" aria-label="Latest action: ${escapeMarkup(feed.tool)}">${escapeMarkup(feed.tool)}</div>` : ''}
      </div>
      <div class="chip-preview-activity">
      ${context ? row(contextClass, contextLabel, briefText(context)) : ''}
      ${!context && feed.unavailable ? row('cl-unavailable', 'Context', feed.unavailable) : ''}
      ${!context && !feed.tool && !feed.unavailable && !facts ? row('cl-unavailable', 'Context', 'No additional context reported') : ''}
      </div>
      ${feed.scope ? `<div class="cl cl-scope" title="${escapeMarkup(feed.scope)}">${escapeMarkup(feed.scope)}</div>` : ''}
      ${facts ? `<div class="chip-preview-footer"><div class="cl cl-facts" title="${escapeMarkup(facts)}">${escapeMarkup(facts)}</div></div>` : ''}
    `
    const runtime = preview.querySelector('.chip-runtime')
    if (Number.isFinite(record.agent.bornAt)) {
      if (Number.isFinite(record.agent.stoppedAt)) {
        runtime.textContent = fmtRuntime(record.agent.bornAt, record.agent.stoppedAt)
      } else {
        record.chipRuntimeUnsub = bindRuntime(runtime, () => record.agent.bornAt)
      }
    } else runtime.hidden = true
    this.previewFitter.watch(record, preview.querySelector('.chip-preview-activity'))
    return true
  }

  _renderBoxPreview(record) {
    const box = record.el
    const body = box.querySelector('.tree-box-context > p')
    if (!body) return false
    const feed = this._screenContext(record)
    const agent = record.agent
    const group = agent.treeScope?.group
    const large = this.cardSize === 'large'
    const scope = this._scopeModel()
    const summary = scope.summary(record.id)
    const grouped = group ? scope.groups.get(record.id) : null
    const members = grouped?.memberIds.map(id => scope.agent(id)).filter(Boolean) || []
    const status = group ? (summary.working ? `${summary.working} working` : summary.review ? `${summary.review} need review` : `${members.length} ${members.length === 1 ? 'branch' : 'branches'}`) : feed.current || agent.treeNode?.status || agent.state || 'No activity yet'
    const memberSeparator = this.cardSize === 'large' ? '\n' : ' · '
    // Public response text owns the compact body; activity stays in its header.
    const message = group ? (members.length ? members.slice(0, 4).map(member => member.name).join(memberSeparator) + (members.length > 4 ? `${memberSeparator}+${members.length - 4} more` : '') : branchSummaryText(summary))
      : latestNodeResponse(feed.chat || feed.previous || feed.task || feed.tool || feed.unavailable || '')
        || 'Open this agent to see its conversation.'
    const canExtend = !group && this._canExtend(agent)
    const followTail = !group && Boolean(feed.chat)
    const key = [agent.name, agent.role, agent.declaredRole, status, message, followTail, feed.scope, feed.task, feed.tool, this.cardSize, summary.total, group, canExtend].join('\u0000')
    if (record.boxPreviewKey === key) return false
    record.boxPreviewKey = key
    box.dataset.status = agent.treeNode?.status || agent.state || 'unknown'
    box.querySelector('.nn-t').textContent = agent.name
    box.querySelector('.node-role').textContent = group ? (grouped?.parentId ? 'Branch group' : 'Tree group') : roleAppearance(agent.declaredRole || agent.role).label
    box.querySelector('.tree-box-status').textContent = status
    box.querySelector('.tree-box-status').title = status
    const scopeLabel = /^\d+ agents? in this branch$/.test(feed.scope || '') ? '' : feed.scope
    const action = box.querySelector('.tree-box-latest-action')
    action.textContent = feed.tool || ''
    action.title = feed.tool || ''
    action.setAttribute('aria-label', `Latest action: ${feed.tool || ''}`)
    action.hidden = group || !feed.tool
    box.classList.toggle('has-latest-action', !action.hidden)
    body.dataset.previewTail = String(followTail)
    body.textContent = message.replace(/^asked:\s*/i, '')
    body.title = message
    body.hidden = false
    // Internal reasoning is retained by the transcript's own activity surface,
    // never presented as response output in the compact card.
    const boxThinking = box.querySelector('.tree-box-thinking')
    if (boxThinking) { boxThinking.hidden = true; boxThinking.textContent = '' }
    body.parentElement.setAttribute('aria-label', group ? 'Agents in this branch' : 'Agent context')
    box.querySelector('.tree-box-detail')?.remove()
    const indicators = box.querySelector('.tree-box-context-indicators')
    indicators.replaceChildren()
    indicators.hidden = !large
    if (large && !group) {
      for (const [label, symbol, value] of [['Scope', '▦', scopeLabel]]) {
        if (!value) continue
        const indicator = el('<span class="tree-box-context-indicator" role="img"></span>')
        indicator.textContent = symbol
        indicator.title = `${label}: ${value}`
        indicator.setAttribute('aria-label', indicator.title)
        indicator.dataset.contextKind = label === 'Latest action' ? 'action' : label.toLowerCase()
        indicators.append(indicator)
      }
    }
    const branch = box.querySelector('.tree-box-branch')
    branch.hidden = group || summary.total <= 1
    branch.textContent = `${summary.total} agents  ›`
    branch.title = feed.scope || `${summary.total} agents in this branch`
    branch.setAttribute('aria-label', `Explore ${agent.name} and its ${countNoun(Math.max(0, summary.total - 1), 'descendant')}`)
    const add = box.querySelector('.tree-box-add-agent')
    add.hidden = !canExtend
    add.textContent = '↳+'
    add.setAttribute('aria-label', `Add an agent under ${agent.name}`)
    box.querySelector('.tree-box-chat').hidden = !!group
    this.previewFitter.watch(record, body.parentElement)
    return true
  }

  openChat(record, { focus = true, pinned = true } = {}) {
    if (record.agent.treeScope?.group) { this.setRoot(record.id); return }
    if (this.chatOwner) {
      const owner = this.chatOwner
      const agent = owner._agentFor(record.id) || record.agent
      const target = owner.nodes.get(record.id) || owner._createRecord(agent, false)
      if (!owner._layoutVisibleIds.has(target.id)) target.el.hidden = true
      owner.openChat(target, { focus, pinned })
      return
    }
    const placed = this.workspace?.recordForNode?.(record.id)
    if (placed) {
      this.workspace.mode = 'chat'
      this.activeChatId = placed.id
      this.workspace.sync()
      if (focus) placed.session.focus()
      return
    }
    if (!this._layoutVisibleIds.has(record.id)) record.el.hidden = true
    if (!record.chip) return
    if (focus) this.workspace?.prepare(record, { pinned })
    if (record.chatOpen) { this._focusChat(record); return }
    /* A PERSON'S OWN AGENT GETS NO SIMULATOR. buildChat's seeded path was
       measured 2026-08-13 opening on a REAL node: a fabricated conversation
       painted over a genuinely running session. The tree-node card exists
       ONLY when the view supplies a real config (treeChat) whose onSend rides
       the real session — passing onSend is what makes the simulator
       unreachable inside buildChat, the same way the agent page does it. With
       no config, the chip still routes to the rail and fabricates nothing. */
    if (record.agent.treeNode) {
      const config = this.treeChat ? this.treeChat(record.agent) : null
      /* EITHER IT CAN SEND, OR IT SAYS WHY IT CANNOT. Both are honest configs
         and both make buildChat's seeded simulator unreachable -- onSend
         replaces the fake path outright, and composerReason refuses `send`
         before it can reach it. A config that offers neither is the one shape
         that could fabricate a conversation, so it still routes to the rail. */
      if (!config || (typeof config.onSend !== 'function' && !config.composerReason)) {
        this.onOpenControls?.(record.agent)
        return
      }
      /* THE WHOLE CONFIG, NOT A HAND-PICKED HALF OF IT.
       *
       * THE DEFECT THIS CLOSES, in the owner's words: "we had this right in the
       * past and it had the buttons in the chat window so maybe it just got
       * disabled on accident". It did, and here is the accident. This call was
       * written at 4bf6000 as an explicit list of the six fields the config had
       * then. Iteration 6 (7cce02c) grew the SHARED config -- the one
       * treeChatConfigFor builds for the card AND the rail -- by four more
       * powers: the busy feed behind the send/stop morph, the queue face, the
       * actions popup, and the stop verb. The rail spreads the config
       * (`buildChat({ ...config, tall: true })`) so it took all four the day
       * they landed. This list did not mention them, so the compact card
       * silently kept the old composer. MEASURED 2026-08-17 on a staged
       * packaged build, real presses: the rail's chat carried
       * ["attach","mention","actions","send"] and the card carried
       * ["close","attach","mention","send"] -- the actions button, the queue
       * strip and the stop face were all absent from the card and only the
       * card.
       *
       * So the config is spread now, exactly as the rail does it, and the only
       * fields written here are the three the CARD owns: its own seed (0 --
       * never the simulator), its own close, and the fallback role key. A
       * future power added to the config reaches both surfaces or neither. */
      this._openChatCard(record, {
        ...config,
        roleKey: config.roleKey || record.agent.role,
        accentId: config.accentId || record.agent.id,
        subtitle: config.subtitle || '',
        seed: 0,
        history: Array.isArray(config.history) ? config.history : [],
      }, { focus })
      return
    }
    this._openChatCard(record, {
      title: record.agent.name,
      subtitle: `${ROLES[record.agent.role]?.label || 'Agent'} · context`,
      roleKey: record.agent.role,
      accentId: record.agent.id,
      context: () => record.agent.context,
    }, { focus })
  }

  /* Open conversations live in normal flow, independent of preview placement
     and branch visibility. Each keeps the complete session-specific config. */
  _openChatCard(record, chatOptions, { focus = true } = {}) {
    record.chatOpen = true
    record.chatSession = record.agent.sessionId || null
    const panel = el('<section class="tree-conversation" tabindex="-1"></section>')
    panel.dataset.agentId = record.id
    panel.setAttribute('aria-label', `${record.agent.name} conversation`)
    paintRoleColor(panel, record.agent.declaredRole || record.agent.role, record.agent.id)
    record.chatPanel = panel
    this.chatTrack.appendChild(panel)
    const chat = buildChat({
      ...chatOptions,
      tall: true,
      onClose: null,
      onExpand: null,
    })
    record.chatRoot = chat
    panel.appendChild(chat)
    this.onMountChatControls?.(record.id, chat)
    panel.addEventListener('focusin', () => this._markActiveChat(record))
    panel.addEventListener('pointerdown', () => this._markActiveChat(record))
    if (this.onMountChatDraft) {
      record.releaseChatDraft = this.onMountChatDraft(record.id, record.chatRoot)
    } else {
      const draft = this.chatDrafts.get(record.id)
      this.chatDrafts.delete(record.id)
      record.chatRoot.importDraft?.(draft)
    }
    record.chip.classList.add('chat-is-open')
    if (focus) {
      this.chatShelf.hidden = false
      this.chatShelf.classList.remove('is-collapsed')
    }
    this._syncConversationShelf()
    if (focus) this._focusChat(record)
    this._placeChips()
  }

  _buildConversationShelf() {
    this.chatDrafts = new Map()
    if (this.tabbedWorkspace) { this.workspace = new TreeWorkspace(this); return }
    this.chatShelf = el(`
      <section class="tree-conversations" aria-label="Agent conversations" hidden>
        <div class="tree-shelf-resize" role="separator" aria-orientation="horizontal" aria-label="Resize conversation workspace" tabindex="0"></div>
        <div class="tree-conversations-bar">
          <div class="tree-chat-tabs" role="tablist" aria-label="Agent conversations"></div>
          <button type="button" class="tree-chat-add" aria-label="Open an agent chat" aria-expanded="false" title="Open an agent chat">+</button>
          <span class="tree-chat-window-controls">
            <button type="button" class="tree-chat-full">Full chat view</button>
            <button type="button" class="tree-chat-collapse" aria-label="Hide chat workspace" title="Hide chats; keep conversations open">Hide</button>
          </span>
        </div>
        <div class="tree-chat-chooser" hidden>
          <input type="search" class="tree-chat-picker" aria-label="Find an agent" placeholder="Find an agent…" autocomplete="off">
          <div class="tree-chat-options" aria-label="Choose an agent"></div>
        </div>
        <div class="tree-conversation-track"></div>
        <p class="tree-chat-empty">Open an agent with + to start switching between conversations.</p>
      </section>`)
    this.chatTrack = this.chatShelf.querySelector('.tree-conversation-track')
    this.chatPicker = this.chatShelf.querySelector('.tree-chat-picker')
    this.chatTabs = this.chatShelf.querySelector('.tree-chat-tabs')
    this.chatChooser = this.chatShelf.querySelector('.tree-chat-chooser')
    this._shelfResizeDispose = attachResizeHandle(this.chatShelf.querySelector('.tree-shelf-resize'), {
      axis: 'y', invert: true, min: 220, max: 1200,
      storageKey: 'mc.tree.chat-height.v1',
      getSize: () => this.chatShelf.offsetHeight,
      apply: px => {
        const available = this.chatShelf.parentElement?.clientHeight || 1400
        this.chatShelf.style.setProperty('--conversation-height', `${Math.min(px, Math.max(160, available - 140))}px`)
      },
    })
    this.chatShelf.querySelector('.tree-shelf-resize').addEventListener('dblclick', () => {
      this.chatShelf.style.removeProperty('--conversation-height')
      try { localStorage.removeItem('mc.tree.chat-height.v1') } catch { /* local reset still applies */ }
    })
    this.chatPicker.addEventListener('input', () => this._renderChatChoices())
    this.chatPicker.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault()
        const first = this.chatChooser.querySelector('.tree-chat-options button')
        if (event.key === 'Enter') first?.click()
        else first?.focus()
      }
    })
    this.chatShelf.querySelector('.tree-chat-add').addEventListener('click', () => this._showChatPicker(this.chatChooser.hidden))
    this.chatShelf.querySelector('.tree-chat-full').addEventListener('click', () => {
      const active = this.nodes.get(this.activeChatId)
      if (active?.chatOpen) this.toggleChatFull(active)
      else this.openFullChat()
    })
    this.chatShelf.querySelector('.tree-chat-collapse').addEventListener('click', () => this._hideChats())
    this._onChatPickerOutside = event => {
      if (!this.chatChooser.hidden && !this.chatChooser.contains(event.target)
        && !event.target.closest('.tree-chat-add')) this._showChatPicker(false)
    }
    this.chatShelf.ownerDocument.addEventListener('pointerdown', this._onChatPickerOutside)
    this.chatChooser.addEventListener('keydown', event => {
      const options = [...this.chatChooser.querySelectorAll('.tree-chat-options button')]
      const index = options.indexOf(event.target)
      if (index < 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (event.key === 'ArrowUp' && index === 0) this.chatPicker.focus()
        else options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
      }
    })
    this.chatShelf.addEventListener('keydown', event => {
      const tabs = [...this.chatTabs.querySelectorAll('[role="tab"]')]
      const tab = event.target.closest('[role="tab"]')
      const cycle = event.ctrlKey && ['PageUp', 'PageDown'].includes(event.key)
      if ((tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) || cycle) {
        event.preventDefault()
        const index = tabs.findIndex(item => item.dataset.agentId === this.activeChatId)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length
        const target = tabs[next]
        if (target) { this._focusChat(this.nodes.get(target.dataset.agentId), { composer: cycle }); if (!cycle) target.focus() }
      } else if (tab && event.key === 'Delete') {
        event.preventDefault()
        this.closeChat(this.nodes.get(tab.dataset.agentId))
      }
    })
    this.zoomHost.after(this.chatShelf)
  }

  _renderChatChoices() {
    const list = this.chatShelf.querySelector('.tree-chat-options')
    const query = this.chatPicker.value.trim().toLocaleLowerCase()
    const agents = this.computer?.agents || []
    const byId = new Map(agents.map(agent => [agent.id, agent]))
    /* WHAT THE PERSON TYPED IS WHAT THEY SEARCH FOR (T1487). Names are a role
       plus an ordinal or an id suffix, so the brief the person wrote and the
       tree it belongs to are searchable too, and each row names its tree the
       way the Add-to-tree picker does. */
    let trees = [], model = null
    try { trees = (this.chatOwner || this).treeWindows?.getTrees?.() || [] } catch { trees = [] }
    try { model = this._scopeModel() } catch { model = null }
    const treeOf = agent => {
      const head = model?.ancestry(agent.id)?.[0]
      return trees.find(tree => tree.rootId === head?.id)?.name || ''
    }
    const briefOf = agent => String(agent.treeNode?.message || '').split('\n').map(line => line.trim()).find(Boolean) || ''
    const options = agents.filter(agent => `${agent.name} ${agent.role} ${byId.get(agent.parentId)?.name || ''} ${briefOf(agent)} ${treeOf(agent)}`.toLocaleLowerCase().includes(query)).map(agent => {
      const option = el('<button type="button"><span></span><small></small></button>')
      option.dataset.agentId = agent.id
      option.querySelector('span').textContent = agent.name
      const tree = treeOf(agent)
      option.querySelector('small').textContent = `${byId.get(agent.parentId)?.name || 'Tree root'}${tree ? ` — ${tree}` : ''}${this.nodes.get(agent.id)?.chatOpen ? ' · open' : ''}`
      option.addEventListener('click', () => {
        this._showChatPicker(false)
        this.openChat(this.nodes.get(agent.id) || this._createRecord(agent, false))
      })
      return option
    })
    if (!options.length) {
      const empty = el('<p></p>')
      empty.textContent = agents.length ? 'No matching agents.' : 'Your agents will appear here when you add them to a tree.'
      options.push(empty)
    }
    list.replaceChildren(...options)
  }

  _showChatPicker(show = true) {
    if (this.workspace) { this.workspace.showPicker(show); return }
    this.chatChooser.hidden = !show
    this.chatShelf.querySelector('.tree-chat-add').setAttribute('aria-expanded', String(show))
    if (show) {
      this.chatPicker.value = ''
      this._renderChatChoices()
      const add = this.chatShelf.querySelector('.tree-chat-add')
      const left = Math.max(8, Math.min(add.offsetLeft, this.chatShelf.clientWidth - this.chatChooser.offsetWidth - 8))
      this.chatChooser.style.left = `${left}px`
      this.chatPicker.focus({ preventScroll: true })
    }
  }

  _hideChats() {
    if (this.workspace) { this.workspace.showTrees(); return }
    this._showChatPicker(false)
    this.chatShelf.hidden = true
    this._chatShelfRequested = false
    this._chatFull = false
    this._syncConversationShelf()
    this.chatToggle?.focus({ preventScroll: true })
  }

  openFullChat(agentId = null) {
    if (!this.chatShelf) return
    this._chatFull = true
    this._chatShelfRequested = true
    this.chatShelf.hidden = false
    const agent = this.computer?.agents?.find(item => item.id === (agentId || this.activeChatId || this.selectedId))
      || this.computer?.agents?.[0]
    if (agent) this.openChat(this.nodes.get(agent.id) || this._createRecord(agent, false))
    else { this._syncConversationShelf(); this._showChatPicker() }
  }

  _syncConversationShelf() {
    if (this.workspace) { this.workspace.sync(); return }
    if (!this.chatShelf) return
    if (!!this._chatFull !== !!this._chatWasFull) {
      this._chatWasFull = !!this._chatFull
      if (this._chatFull) {
        this._chatWideBefore = !!this._treeWide
        this.setWide(true)
      } else this.setWide(!!this._chatWideBefore)
    }
    const opened = [...this.nodes.values()].filter(record => record.chatOpen)
    if (!opened.some(record => record.id === this.activeChatId)) this.activeChatId = opened[0]?.id || null
    this.chatShelf.classList.toggle('is-empty', !opened.length)
    const ids = new Set(opened.map(record => record.id))
    for (const tab of [...this.chatTabs.children]) if (!ids.has(tab.dataset.agentId)) tab.remove()
    this.chatShelf.classList.toggle('is-expanded', !!this._chatFull)
    this.chatShelf.classList.remove('is-collapsed')
    for (const record of opened) {
      let wrapper = [...this.chatTabs.children].find(child => child.dataset.agentId === record.id)
      if (!wrapper) {
        wrapper = el('<span class="tree-chat-tab-wrap" role="presentation"><button type="button" class="tree-chat-tab" role="tab"></button><button type="button" class="tree-chat-tab-close" tabindex="-1">×</button></span>')
        wrapper.dataset.agentId = record.id
        paintRoleColor(wrapper, record.agent.declaredRole || record.agent.role, record.agent.id)
        const tab = wrapper.querySelector('[role="tab"]')
        tab.dataset.agentId = record.id
        tab.id = `chat-tab-${this.computer.id}-${record.id}`
        record.chatPanel.id = `chat-panel-${this.computer.id}-${record.id}`
        tab.setAttribute('aria-controls', record.chatPanel.id)
        record.chatPanel.setAttribute('role', 'tabpanel')
        record.chatPanel.setAttribute('aria-labelledby', tab.id)
        tab.addEventListener('click', () => this._focusChat(record))
        wrapper.querySelector('.tree-chat-tab-close').addEventListener('click', () => this.closeChat(record))
        this.chatTabs.appendChild(wrapper)
      }
      const active = this.activeChatId === record.id
      const tab = wrapper.querySelector('[role="tab"]')
      tab.textContent = record.agent.name
      tab.title = record.agent.name
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      wrapper.classList.toggle('is-active', active)
      wrapper.querySelector('.tree-chat-tab-close').setAttribute('aria-label', `Close ${record.agent.name} chat`)
      record.chatFull = !!this._chatFull && active
      record.chatPanel.hidden = !active
      record.chatPanel.classList.toggle('as-chat-full', record.chatFull)
      record.chatRoot?.querySelector('.chat-expand')?.setAttribute('aria-pressed', String(record.chatFull))
      record.chatPanel.style.width = '100%'
    }
    this.chatTrack.hidden = !opened.length
    this.chatShelf.querySelector('.tree-chat-empty').hidden = !!opened.length
    const full = this.chatShelf.querySelector('.tree-chat-full')
    full.textContent = this._chatFull ? 'Dock chat' : 'Full chat view'
    full.setAttribute('aria-pressed', String(!!this._chatFull))
    const hide = this.chatShelf.querySelector('.tree-chat-collapse')
    hide.textContent = this._chatFull ? 'Back to tree' : 'Hide'
    hide.setAttribute('aria-label', this._chatFull ? 'Back to tree' : 'Hide chat workspace')
    if (!opened.length && !this._chatShelfRequested) this.chatShelf.hidden = true
    if (this.chatToggle) {
      this.chatToggle.textContent = this.chatShelf.hidden ? (opened.length ? `Show chats (${opened.length})` : 'Show chats') : 'Hide chats'
      this.chatToggle.setAttribute('aria-expanded', String(!this.chatShelf.hidden))
    }
  }

  _markActiveChat(record) {
    this.activeChatId = record.id
    record.chatOrder = ++chatZ
  }

  _focusChat(record, { composer = true } = {}) {
    if (!record?.chatOpen) return
    this.chatShelf.hidden = false
    this._markActiveChat(record)
    this._syncConversationShelf()
    const tab = this.chatTabs.querySelector('[aria-selected="true"]')
    if (tab) {
      const left = tab.offsetLeft - this.chatTabs.offsetLeft
      if (left < this.chatTabs.scrollLeft) this.chatTabs.scrollLeft = left
      else if (left + tab.offsetWidth > this.chatTabs.scrollLeft + this.chatTabs.clientWidth) this.chatTabs.scrollLeft = left + tab.offsetWidth - this.chatTabs.clientWidth
    }
    if (composer) (record.chatRoot.querySelector('.chat-input input:not(:disabled)') || record.chatPanel).focus({ preventScroll: true })
  }

  toggleChatFull(record) {
    if (this.workspace) { this.workspace.showTrees(); return }
    if (!record.chatOpen) return
    this._chatFull = !this._chatFull
    this._focusChat(record)
  }

  _disposeChat(record) {
    record.releaseChatDraft?.()
    record.releaseChatDraft = null
    record._chatResizeDispose?.()
    record._chatResizeDispose = null
    record.chatRoot?.dispose?.()
    record.chatPanel?.remove()
    record.chatRoot = null
    record.chatPanel = null
    record.chatOpen = false
    record.chatFull = false
    record.chip?.classList.remove('chat-is-open')
  }

  refreshConversation(agentId) {
    const record = this.nodes.get(agentId)
    if (record) this._refreshChatSession(record, true)
  }

  _refreshChatSession(record, historyChanged = false) {
    if (!record.chatOpen || (!historyChanged && !record.chatRefreshPending && record.chatSession === (record.agent.sessionId || null))) return
    const draft = record.chatRoot?.exportDraft?.()
    // Do not turn an in-progress queue edit into a second, unsent message.
    if (!draft) { record.chatRefreshPending = true; return }
    record.chatRefreshPending = false
    const focused = record.chatPanel.contains(document.activeElement)
    const full = record.chatFull
    this._disposeChat(record)
    this.openChat(record, { focus: false })
    record.chatFull = full
    this._syncConversationShelf()
    record.chatRoot?.importDraft?.(draft)
    if (focused) record.chatRoot?.querySelector('.chat-input input')?.focus({ preventScroll: true })
  }

  closeChat(record) {
    if (this.workspace) { this.workspace.close(record); return }
    if (!record?.chatOpen) return
    const opened = [...this.nodes.values()].filter(other => other.chatOpen)
    const index = opened.indexOf(record)
    const wasActive = record.id === this.activeChatId
    const draft = record.chatRoot?.exportDraft?.()
    if (draft && !this.onMountChatDraft) this.chatDrafts.set(record.id, draft)
    else this.chatDrafts.delete(record.id)
    this._disposeChat(record)
    if (wasActive) this.activeChatId = (opened[index + 1] || opened[index - 1])?.id || null
    if (opened.length === 1) { this._chatFull = false; this._chatShelfRequested = false }
    this._syncConversationShelf()
    if (!this._layoutVisibleIds.has(record.id)) this._removeRecord(record, false)
    this._placeChips()
    if (wasActive) {
      const next = this.nodes.get(this.activeChatId)
      if (next) this._focusChat(next)
      else this.chatToggle?.focus({ preventScroll: true })
    }
  }

  _escapeTopChat(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (event.defaultPrevented || this._destroyed || document.querySelector('.drawer.open')) return
    if (event.key === 'Escape' && this._linkMode) { (this.chatOwner || this).setLinkMode(false); event.preventDefault(); return }
    if (event.key === 'Escape' && this.linkPopover?.isConnected) { this.linkPopover.remove(); event.preventDefault(); return }
    if (this.chatOwner) return
    if (this.workspace) {
      if (event.ctrlKey && event.code === 'Backquote') {
        event.preventDefault()
        if (this.workspace.mode === 'trees') this.workspace.showPicker()
        else this.workspace.showTrees()
      }
      return
    }
    if (event.key === 'Escape' && this._linkMode) { this.setLinkMode(false); event.preventDefault(); return }
    if (event.key === 'Escape' && this.linkPopover?.isConnected) { this.linkPopover.remove(); event.preventDefault(); return }
    if (event.ctrlKey && event.code === 'Backquote' && this.chatShelf) {
      event.preventDefault()
      if (this.chatShelf.hidden) {
        this._chatShelfRequested = true
        this.chatShelf.hidden = false
        const active = this.nodes.get(this.activeChatId)
        if (active?.chatOpen) this._focusChat(active)
        else { this._syncConversationShelf(); this._showChatPicker() }
      } else this._hideChats()
      return
    }
    if (event.key !== 'Escape' || !this.chatShelf?.contains(event.target)) return
    event.preventDefault()
    if (!this.chatChooser.hidden) {
      this._showChatPicker(false)
      this.chatShelf.querySelector('.tree-chat-add').focus()
    } else if (this._chatFull) {
      this._chatFull = false
      this._syncConversationShelf()
      this._focusChat(this.nodes.get(this.activeChatId))
    } else this._hideChats()
  }

  _placeChips() {
    // Edit instructions describe the active gestures even when context cards
    // were hidden in the normal view or a zoom/resize refreshes their placement.
    if (this.editMode) {
      if (this.screenOverlay) this.screenOverlay.hidden = true
      if (this.panHint) this.panHint.textContent = `${countNoun(this.visibleAgents().length, 'agent')} · Complete structure · Drag to move · Double-click for agent actions`
      return
    }
    if (this.nodeStyle === 'boxes') {
      if (this.screenOverlay) this.screenOverlay.hidden = true
      if (this.panHint) {
        const visible = this._layoutVisibleIds?.size || 0
        const total = this._scopeAgentCount()
        this.panHint.textContent = `${countNoun(total, 'agent')}${total > visible ? ` · ${visible} nodes shown · Zoom into a branch to reveal more` : ''} · Drag to pan · Double-click to open chat`
      }
      return
    }
    if (this.circleCards === false) {
      if (this.screenOverlay) this.screenOverlay.hidden = true
      if (this.panHint) this.panHint.textContent = `${countNoun(this._scopeAgentCount(), 'agent')} · Cards hidden · Double-click a circle to open chat`
      return
    }
    if (!this.screenChips || !this.screenOverlay || this.editMode) return
    // Below the overview, cards would dwarf the tree. Fit restores them.
    this.screenOverlay.hidden = !!this._fitFloor && this.zoom < this._fitFloor * 0.6
    if (this.screenOverlay.hidden) {
      if (this.panHint) this.panHint.textContent = 'Zoom in for context cards · Fit tree to restore the overview'
      return
    }
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    const visibleRecords = [...this.nodes.values()].filter(record =>
      record.chip && !this._culled.has(record.id) && this._layoutVisibleIds.has(record.id)
      && this.panX + (record.x + this._nodeRadius(record)) * this.zoom >= 0
      && this.panX + (record.x - this._nodeRadius(record)) * this.zoom <= hostWidth
      && this.panY + (record.y + this._nodeRadius(record)) * this.zoom >= 0
      && this.panY + (record.y - this._nodeRadius(record)) * this.zoom <= hostHeight)
    const records = visibleRecords.filter(record => this._contextCardProfile(record.agent).value !== 'off').sort((left, right) =>
      (ROLE_PRIORITY[right.agent.role] || 0) - (ROLE_PRIORITY[left.agent.role] || 0)
      || left.id.localeCompare(right.id))

    /* A Set, because this runs on every pointer move. The loop below walks
       every node in the fleet and asked `includes` of an array of the visible
       ones -- nodes x visible comparisons per call, and _placeChips() is called
       from _applyZoom() on each pointermove of a pan and each wheel tick. The
       membership answer is identical: this.nodes is keyed by id, so a record's
       identity and its id are one to one, and the boolean is only used to
       toggle three classes. */
    const visibleSet = new Set(records)
    for (const record of this.nodes.values()) {
      const visible = visibleSet.has(record)
      record.chip?.classList.toggle('screen-chip-visible', visible)
      record.chipLeader?.classList.toggle('visible', visible)
      record.chipLeaderDot?.classList.toggle('visible', visible)
      if (record.chip) record.chip.tabIndex = visible ? 0 : -1
    }
    if (!records.length) {
      if (this.panHint) this.panHint.textContent = `${visibleRecords.length} of ${countNoun(this._layoutVisibleIds.size, 'agent')} in view · 0 previews · Drag to pan · Fit to see all`
      return
    }

    const hostRect = this.zoomHost.getBoundingClientRect()
    const uiZoom = textZoom(this.zoomHost.ownerDocument)
    const originX = hostRect.left / uiZoom + this.zoomHost.clientLeft
    const originY = hostRect.top / uiZoom + this.zoomHost.clientTop
    const expand = (box, pad, weight = 1) => ({
      x: box.x - pad,
      y: box.y - pad,
      w: box.w + pad * 2,
      h: box.h + pad * 2,
      weight,
    })
    const obstacles = []
    for (const record of visibleRecords) {
      const x = this.panX + record.x * this.zoom
      const y = this.panY + record.y * this.zoom
      const radius = this._nodeRadius(record) * this.zoom
      obstacles.push(expand({ x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }, 5, 5))
      for (const label of record.el.querySelectorAll('.node-labels')) {
        const rect = label.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          // Rectangles include the document's text zoom; collision candidates
          // use host CSS pixels, just like the chrome and label leaders below.
          obstacles.push(expand({
            x: rect.left / uiZoom - originX,
            y: rect.top / uiZoom - originY,
            w: rect.width / uiZoom,
            h: rect.height / uiZoom,
          }, 4, 6))
        }
      }
    }
    // A direct-link control must stay visible and pressable between the cards.
    for (const marker of this.svg?.querySelectorAll('.tree-link-marker') || []) {
      const rect = marker.getBoundingClientRect()
      obstacles.push(expand({ x: rect.left / uiZoom - originX, y: rect.top / uiZoom - originY,
        w: rect.width / uiZoom, h: rect.height / uiZoom }, 6, 5))
    }
    /* An empty slot is an obstacle exactly like a circle, because it IS a
       circle on this canvas and it is pressable. A context card parked over
       one would both hide it and eat its clicks. */
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden) continue
      const x = this.panX + slot.x * this.zoom
      const y = this.panY + slot.y * this.zoom
      const radius = slot.r * this._nodeScale() * this.zoom
      obstacles.push(expand({ x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }, 5, 5))
    }
    /* The connector lanes are obstacles too. Without this the placer happily
       parked a card on top of the fan of edges and the lines ran straight
       through the text — the single ugliest thing on the page. */
    for (const segment of this._linkSegments || []) {
      const x1 = this.panX + segment.x1 * this.zoom
      const y1 = this.panY + segment.y1 * this.zoom
      const x2 = this.panX + segment.x2 * this.zoom
      const y2 = this.panY + segment.y2 * this.zoom
      obstacles.push({
        ...expand({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
        }, 5, 1),
        soft: true,
      })
    }
    for (const selector of ['.graph-title', '.graph-crumb', '.graph-hint.show', '.graph-tools', '.graph-edit-note']) {
      const element = this.zoomHost.querySelector(selector)
      if (!element || element.hidden || getComputedStyle(element).visibility === 'hidden') continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      obstacles.push(expand({
        x: rect.left / uiZoom - originX,
        y: rect.top / uiZoom - originY,
        w: rect.width / uiZoom,
        h: rect.height / uiZoom,
      }, 6, 9))
    }

    const dimensions = new Map(records.map(record => {
      const profile = this._contextCardProfile(record.agent)
      const width = Math.min(profile.width, hostWidth - SCREEN_EDGE * 2)
      record.chip.setAttribute('data-context-size', profile.value)
      record.chip.removeAttribute('data-compact-context')
      record.chip.style.setProperty('--tree-preview-height', `${Math.min(profile.height, Math.max(72, hostHeight - SCREEN_TOP - SCREEN_EDGE))}px`)
      record.chip.style.setProperty('--tree-current-lines', String(profile.currentLines))
      record.chip.style.setProperty('--tree-chat-lines', String(profile.chatLines))
      record.chip.style.setProperty('--tree-thinking-lines', String(profile.thinkingLines))
      record.chip.style.width = `${Math.max(0, width)}px`
      const height = Math.min(record.chip.offsetHeight || SCREEN_CHIP_H, hostHeight - SCREEN_TOP - SCREEN_EDGE)
      return [record.id, { width, height }]
    }))
    // Every visible circle in screen space — the leader must not cross any of
    // them except its own.
    const discs = visibleRecords.map(record => ({
      id: record.id,
      x: this.panX + record.x * this.zoom,
      y: this.panY + record.y * this.zoom,
      r: this._nodeRadius(record) * this.zoom + 4,
    }))
    // …and a leader ruled through an empty slot misattributes the same way one
    // ruled through an agent does, so slots join the discs a leader must clear.
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden) continue
      discs.push({
        id: slot.id,
        x: this.panX + slot.x * this.zoom,
        y: this.panY + slot.y * this.zoom,
        r: slot.r * this._nodeScale() * this.zoom + 4,
      })
    }
    const labelBoxes = []
    for (const record of visibleRecords) {
      const stack = record.el.querySelector('.node-labels')
      if (!stack) continue
      const rect = stack.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      labelBoxes.push({
        id: record.id,
        x: rect.left / uiZoom - originX,
        y: rect.top / uiZoom - originY,
        w: rect.width / uiZoom,
        h: rect.height / uiZoom,
      })
    }
    let slots = this._electChipSlots(records, dimensions, obstacles, hostWidth, hostHeight, discs, labelBoxes)
    if (!slots.size && records.some(record => this._contextCardProfile(record.agent).value === 'large')) {
      // A laptop can have room for a useful large card between its tiers,
      // while the preferred height just misses that pocket. Keep its type
      // and width; shorten only the context area before withholding it.
      for (const record of records) {
        if (this._contextCardProfile(record.agent).value !== 'large') continue
        const size = dimensions.get(record.id)
        size.height = Math.min(size.height, 240)
        record.chip.style.setProperty('--tree-preview-height', `${size.height}px`)
        record.chip.setAttribute('data-compact-context', 'true')
      }
      slots = this._electChipSlots(records, dimensions, obstacles, hostWidth, hostHeight, discs, labelBoxes)
    }
    if (this.panHint) {
      const grouped = visibleRecords.some(record => record.agent.treeScope?.hidden)
      const total = this._scopeAgentCount()
      this.panHint.textContent = grouped
        ? `${countNoun(total, 'agent')} · ${visibleRecords.length} nodes shown · Zoom into a branch to explore · Fit to see all`
        : `${visibleRecords.length} of ${countNoun(this._layoutVisibleIds.size, 'agent')} in view · ${slots.size} previews · Drag to pan · Fit to see all`
    }

    for (const record of records) {
      const chip = record.chip
      const selected = slots.get(record.id)
      if (!selected) {
        chip.classList.remove('screen-chip-visible')
        chip.tabIndex = -1
        record.chipLeader.classList.remove('visible')
        record.chipLeaderDot?.classList.remove('visible')
        continue
      }
      chip.classList.add('screen-chip-visible')
      record.chipLeader.classList.add('visible')
      record.chipLeaderDot?.classList.add('visible')
      const { width, height } = dimensions.get(record.id)
      const x = this.panX + record.x * this.zoom
      const y = this.panY + record.y * this.zoom
      const radius = this._nodeRadius(record) * this.zoom
      record.previewOffset = { x: selected.x - x, y: selected.y - y }
      chip.style.left = `${selected.x}px`
      chip.style.top = `${selected.y}px`
      chip.style.width = `${width}px`

      /* Attribution: a card floating near a circle is not attached to it, and
         with seventeen nodes the reader's guess is usually wrong. The leader
         lands on the card's NEAR EDGE (not an arbitrary clamped point) and
         wears the node's own role hue, so card and circle read as one object. */
      const c = center(selected)
      const angle = Math.atan2(c.y - y, c.x - x)
      const startX = x + Math.cos(angle) * radius
      const startY = y + Math.sin(angle) * radius
      // The nearest edge can now be above or below the node as well as beside it.
      const endX = clamp(x, selected.x + 8, selected.x + selected.w - 8)
      const endY = clamp(y, selected.y + 8, selected.y + selected.h - 8)
      record.chipLeader.classList.add('visible')
      record.chipLeaderDot?.classList.add('visible')
      record.chipLeader.setAttribute('x1', String(startX))
      record.chipLeader.setAttribute('y1', String(startY))
      record.chipLeader.setAttribute('x2', String(endX))
      record.chipLeader.setAttribute('y2', String(endY))
      record.chipLeaderDot?.setAttribute('cx', String(startX))
      record.chipLeaderDot?.setAttribute('cy', String(startY))
    }
  }

  /* The seat an open chat gets when election found none: the side of its own
     node with more room, vertically centred on it, clamped inside the canvas
     so no part of the panel can land off-screen. Deliberately NOT a search —
     a search is what already failed, and a panel the person is waiting for is
     owed a definite answer rather than a better-placed absence. */
  _chipCandidates(record, width, height, hostWidth, hostHeight) {
    const x = this.panX + record.x * this.zoom
    const y = this.panY + record.y * this.zoom
    const radius = this._nodeRadius(record) * this.zoom
    const maxX = Math.max(SCREEN_EDGE, hostWidth - width - SCREEN_EDGE)
    const maxY = Math.max(SCREEN_TOP, hostHeight - height - 32)
    const candidates = []
    const seen = new Set()
    const add = (left, top, rank) => {
      const cx = clamp(left, SCREEN_EDGE, maxX)
      const cy = clamp(top, SCREEN_TOP, maxY)
      const key = `${Math.round(cx)}:${Math.round(cy)}`
      if (seen.has(key)) return
      seen.add(key)
      const box = { x: cx, y: cy, w: width, h: height }
      const boxCenter = center(box)
      candidates.push({ ...box, rank, distance: Math.hypot(boxCenter.x - x, boxCenter.y - y) })
    }
    if (record.previewOffset) add(x + record.previewOffset.x, y + record.previewOffset.y, -1)
    const gap = radius + 20
    const shift = Math.max(40, height / 3)
    const nudges = [0, -shift, shift, -shift * 2, shift * 2, -shift * 3, shift * 3, -shift * 4, shift * 4]
    for (const nudge of nudges) add(x + gap, y - height / 2 + nudge, 0)
    for (const nudge of nudges) add(x - gap - width, y - height / 2 + nudge, 1)
    for (const nudge of [0, -70, 70, -140, 140]) {
      add(x - width / 2 + nudge, y - radius - height - 18, 2)
      add(x - width / 2 + nudge, y + radius + TREE_LABEL_STACK * this.zoom + 20, 3)
      if (this._contextCardProfile(record.agent).value === 'large') for (const vertical of [-16, 16, -32, 32]) {
        add(x - width / 2 + nudge, y - radius - height - 18 + vertical, 2)
        add(x - width / 2 + nudge, y + radius + TREE_LABEL_STACK * this.zoom + 20 + vertical, 3)
      }
    }
    // Use otherwise empty lanes too. Node and label collisions remain hard
    // refusals, but a card can inform the reader through a longer named leader.
    const columns = Math.max(1, Math.floor((hostWidth - SCREEN_EDGE * 2 + SCREEN_CHIP_GAP) / (width + SCREEN_CHIP_GAP)))
    const rows = Math.max(1, Math.floor((hostHeight - SCREEN_TOP - SCREEN_EDGE + SCREEN_CHIP_GAP) / (height + SCREEN_CHIP_GAP)))
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      add(SCREEN_EDGE + column * (width + SCREEN_CHIP_GAP), SCREEN_TOP + row * (height + SCREEN_CHIP_GAP), 4)
    }
    return candidates
  }

  _electChipSlots(records, dimensions, obstacles, hostWidth, hostHeight, discs = [], labelBoxes = []) {
    const BEAM = 32
    const BRANCHES = 14
    let states = [{ placed: [], slots: new Map(), score: 0 }]
    for (const record of records) {
      const { width, height } = dimensions.get(record.id)
      const nodeX = this.panX + record.x * this.zoom
      const nodeY = this.panY + record.y * this.zoom
      const reach = Math.max(CHIP_REACH, width * 1.5, Math.min(hostWidth, hostHeight) * 0.9)
      const base = this._chipCandidates(record, width, height, hostWidth, hostHeight)
        // Reject occupied seats before computing leader geometry. Most of
        // the extra lane candidates are occupied, and pointer pans run this
        // same search repeatedly.
        .filter(candidate => candidate.distance <= reach
          && !obstacles.some(obstacle => !obstacle.soft && overlap(candidate, obstacle) * obstacle.weight > 0.01))
        .map(candidate => {
          const c = center(candidate)
          const crossings = discs.reduce((count, disc) => count
            + (disc.id !== record.id && segmentHitsDisc(nodeX, nodeY, c.x, c.y, disc.x, disc.y, disc.r) ? 1 : 0), 0)
            + labelBoxes.reduce((count, box) => count
              + (box.id !== record.id && segmentHitsBox(nodeX, nodeY, c.x, c.y, box) ? 1 : 0), 0)
          return { ...candidate, leaderCrossings: crossings,
            laneOverlap: obstacles.reduce((sum, obstacle) => sum + (obstacle.soft ? overlap(candidate, obstacle) : 0), 0) }
        })
        /* Two classes of obstacle, not one. A circle, a label or a piece of
           chrome underneath a card is a hard collision — the card is withheld
           rather than painted over it. A CONNECTOR underneath a card is not:
           the card paints on the panel's own ground, so the line simply passes
           behind it. Treating lanes as hard rejects starved the canvas down to
           two visible blocks; as a ranked preference it keeps the density and
           still lands cards in clear lanes wherever clear lanes exist. */
        // The convention outranks everything: a block only leaves the right
        // side when the right side genuinely cannot hold it.
        .sort((left, right) => left.rank - right.rank
          || left.leaderCrossings - right.leaderCrossings
          || left.laneOverlap - right.laneOverlap
          || left.distance - right.distance || left.y - right.y || left.x - right.x)
      const next = []
      for (const state of states) {
        next.push(state)
        let branches = 0
        for (const candidate of base) {
          const padded = {
            x: candidate.x - SCREEN_CHIP_GAP / 2,
            y: candidate.y - SCREEN_CHIP_GAP / 2,
            w: candidate.w + SCREEN_CHIP_GAP,
            h: candidate.h + SCREEN_CHIP_GAP,
          }
          if (state.placed.some(other => overlap(padded, other) > 0.01)) continue
          const slots = new Map(state.slots)
          slots.set(record.id, candidate)
          next.push({
            placed: [...state.placed, padded],
            slots,
            score: state.score + candidate.distance + candidate.leaderCrossings * 500 - (candidate.rank === -1 ? 500 : 0) - (ROLE_PRIORITY[record.agent.role] || 0) * 18,
          })
          branches += 1
          if (branches >= BRANCHES) break
        }
      }
      if (!next.length) {
        // A very small viewport may have no mathematically clear pocket. Keep
        // the topology readable: the lower-priority context block is withheld
        // rather than painted across a node or another block.
        continue
      }
      next.sort((left, right) => right.slots.size - left.slots.size || left.score - right.score)
      states = next.slice(0, BEAM)
    }
    return states[0]?.slots || new Map()
  }

  /* Scale and framing are separate actions. Fit retains the selected tree. */
  _buildFitControl() {
    const cluster = el(`
      <div class="graph-zoomer" role="group" aria-label="Zoom">
        <button class="gz-out" type="button" title="Zoom out" aria-label="Zoom out">&#8722;</button>
        <output class="gz-level gf-z" aria-label="Tree zoom">100%</output>
        <button class="gz-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
        <button class="graph-fit static-tree-fit" type="button" title="Fit the current tree · 0" aria-label="Fit current tree">Fit tree</button>
      </div>`)
    cluster.querySelector('.gz-out').addEventListener('click', () => this._controlZoom(1 / 1.2))
    cluster.querySelector('.gz-in').addEventListener('click', () => this._controlZoom(1.2))
    cluster.querySelector('.graph-fit').addEventListener('click', () => this.fitCurrentTree())
    /* In the tool row, not floating over the canvas: parked bottom-left it sat
       on the last tier's labels at 1440 and read as debris on the tree. The
       row lives in the pane BAR now, a sibling of the canvas slot this graph
       zooms in — so the lookup climbs to the pane (.graph-wrap) first and
       falls back to the host for embedders with no bar. */
    const pane = this.zoomHost.closest('.graph-wrap')
    const tools = (pane || this.zoomHost).querySelector('.graph-tools')
    if (tools) tools.insertBefore(cluster, tools.firstChild)
    else this.zoomHost.appendChild(cluster)
    this.zoomerEl = cluster
    this.fitEl = cluster.querySelector('.graph-fit')
    {
      this.cardsToggle = el('<button type="button" class="tree-cards-toggle" title="Show or hide circle context cards">Cards</button>')
      this.cardsToggle.hidden = this.nodeStyle !== 'circles'
      this.cardsToggle.setAttribute('aria-pressed', String(this.circleCards))
      this.cardsToggle.addEventListener('click', () => this.setCircleCards(this.cardsToggle.getAttribute('aria-pressed') !== 'true'))
      cluster.appendChild(this.cardsToggle)
    }
    if (this.compactControls) {
      this.panHint = el('<div class="tree-pan-hint"></div>')
      this.zoomHost.appendChild(this.panHint)
      return
    }
    const controls = el(`<div class="tree-workspace-controls">
      <button type="button" class="tree-link-toggle" aria-pressed="false" title="Connect two agents with a direct communication channel">Link agents</button>
      <details class="tree-more">
        <summary aria-label="More tree controls">More</summary>
        <div class="tree-more-menu">
      <label class="tree-context-control">Context cards <select class="tree-context-size" aria-label="Context card size for trees in view"><option value="default">Use default</option>${TREE_CONTEXT_SIZES.map(row => `<option value="${row.value}">${row.label}</option>`).join('')}<option value="mixed" disabled>Mixed sizes</option></select></label>
          <button type="button" class="tree-wide-toggle" aria-pressed="false">Expand tree</button>
          <button type="button" class="tree-chats-toggle" aria-expanded="false">Show chats</button>
          <button type="button" class="tree-spread" title="Spread branches at a readable size">Spread branches</button>
          <label>Scrolling <select class="tree-input-mode" aria-label="Tree scrolling" title="Pinch always zooms. Drag or Shift-scroll to pan."><option value="mouse">Scroll to zoom</option><option value="trackpad">Scroll to pan</option></select></label>
          <p>Click for chat · Double-click to focus<br>Drag to pan · Pinch to zoom</p>
        </div>
      </details>
    </div>`)
    this.moreMenu = controls.querySelector('.tree-more')
    const editActions = tools?.querySelector('.graph-tool-set')
    if (editActions) this.moreMenu.querySelector('.tree-more-menu').prepend(editActions)
    this.moreMenu.addEventListener('click', event => { if (event.target.closest('button')) this.moreMenu.open = false })
    this.moreMenu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.moreMenu.open = false; this.moreMenu.querySelector('summary').focus() }
    })
    this._onMoreOutside = event => { if (!this.moreMenu.contains(event.target)) this.moreMenu.open = false }
    this.zoomHost.ownerDocument.addEventListener('pointerdown', this._onMoreOutside)
    controls.querySelector('.tree-spread').addEventListener('click', () => {
      this.spacious = true
      this._spreadRequested = true
      this._overviewRequested = false
      this._viewSteered = false
      this._layoutNow()
    })
    try { this.inputMode = localStorage.getItem('mc.tree.scroll-mode.v1') === 'trackpad' ? 'trackpad' : 'mouse' } catch { this.inputMode = 'mouse' }
    controls.querySelector('.tree-input-mode').value = this.inputMode
    controls.querySelector('.tree-input-mode').addEventListener('change', event => {
      this.inputMode = event.target.value
      this._wheelGesture = null
      try { localStorage.setItem('mc.tree.scroll-mode.v1', this.inputMode) } catch { /* session preference still applies */ }
    })
    this.linkToggle = controls.querySelector('.tree-link-toggle')
    this.linkToggle.addEventListener('click', () => this.setLinkMode(!this._linkMode))
    this.chatToggle = controls.querySelector('.tree-chats-toggle')
    this.chatToggle.hidden = !this.screenChips
    this.chatToggle.addEventListener('click', () => {
      if (!this.chatShelf.hidden) { this._hideChats(); return }
      this._chatShelfRequested = true
      this.chatShelf.hidden = false
      this._syncConversationShelf()
      const active = this.nodes.get(this.activeChatId)
      if (active?.chatOpen) this._focusChat(active)
      else this._showChatPicker()
    })
    if (tools) tools.appendChild(controls)
    else this.zoomHost.appendChild(controls)
    this.workspaceControls = controls
    this.contextCardSelect = controls.querySelector('.tree-context-size')
    this.contextCardSelect.closest('.tree-context-control').hidden = !this.screenChips || this.smartScope
    this.contextCardSelect.addEventListener('change', () => this.setContextCardSize(this.contextCardSelect.value))
    this.contextCardNotice = el('<span class="tree-context-notice" role="status" aria-live="polite"></span>')
    controls.appendChild(this.contextCardNotice)
    this._syncContextCardControl()
    this.wideToggle = controls.querySelector('.tree-wide-toggle')
    this.wideToggle.hidden = !pane?.closest('.comp-body')
    this.wideToggle.addEventListener('click', () => this.setWide(!this._treeWide))
    this.panHint = el('<div class="tree-pan-hint" aria-live="off">Drag background to pan · Fit to see all</div>')
    this.zoomHost.appendChild(this.panHint)
    if (this.tabbedWorkspace) {
      this.chatToggle.hidden = true
      controls.querySelector('.tree-spread').hidden = true
      this.moreMenu.querySelector('p').textContent = 'Click a card for side chat · Double-click a node to open chat · Scroll into a branch to explore'
      controls.prepend(this.wideToggle)
    }
    if (this.tabbedWorkspace) {
      this.wideToggle.hidden = true
      this.moreMenu.hidden = true
    }
  }

  setCommunicationLinks(links) {
    this.communicationLinks = Array.isArray(links) ? links.map(link => ({ from: link.from, to: link.to })) : []
    this._renderLinks()
    this._placeChips()
    if (this.treeWindows) {
      for (const frame of this.treeWindows.windows) if (frame.graph !== this) frame.graph.setCommunicationLinks(this.communicationLinks)
      this.treeWindows.scheduleLinks()
    }
  }

  setCircleCards(shown) {
    if (this.chatOwner) { this.chatOwner.setCircleCards(shown); return }
    const graphs = this.treeWindows?.windows.map(frame => frame.graph) || [this]
    if (shown) {
      const treeKeys = [...new Set(graphs.flatMap(graph => graph._contextTreeKeys()
        .filter(key => treeContextProfile(graph._contextPolicy, key).value === 'off')))]
      if (treeKeys.length) {
        const result = updateTreeContextCards({ treeKeys, size: this.cardSize || 'medium' })
        if (!result.ok) {
          if (this.contextCardNotice) this.contextCardNotice.textContent = result.reason
          return result
        }
        for (const graph of graphs) graph._applyContextCardPolicy(result.record, result.boxSize)
      }
    }
    for (const graph of graphs) {
      graph.circleCards = !!shown
      graph._syncContextCardControl()
      graph._placeChips()
    }
    try {
      if (shown) localStorage.removeItem(TREE_CARDS_KEY)
      else localStorage.setItem(TREE_CARDS_KEY, 'false')
    } catch { /* The current view still honors the choice. */ }
  }

  /* A linked/unlinked confirmation fades after the canvas status line's seven
     seconds: it sits over the top of the canvas, where tree heads are laid
     out, so a sentence that stayed would keep covering their names and
     buttons (T1417). Prompts and refusals stay until the next link action. */
  _linkStatus(message, { fade = false } = {}) {
    if (!this.linkStatus) {
      this.linkStatus = el('<div class="tree-link-status" role="status"></div>')
      this.zoomHost.appendChild(this.linkStatus)
    }
    clearTimeout(this._linkStatusTimer)
    this._linkStatusTimer = 0
    this.linkStatus.textContent = message
    this.linkStatus.hidden = !message
    if (message && fade) {
      this._linkStatusTimer = setTimeout(() => {
        this._linkStatusTimer = 0
        if (!this._destroyed && this.linkStatus?.textContent === message) this._linkStatus('')
      }, this.confirmationFadeMs ?? 7000)
    }
  }

  setLinkMode(enabled) {
    if (this.chatOwner) { this.chatOwner.setLinkMode(enabled); return }
    if (this._linkPending) return
    if (enabled) this.workspace?.showTrees({ focus: false })
    this._linkMode = enabled
    this._linkFrom = null
    this.linkToggle?.setAttribute('aria-pressed', String(enabled))
    this.zoomHost.classList.toggle('is-linking', enabled)
    for (const record of this.nodes.values()) record.el.classList.remove('link-source')
    if (enabled) {
      this.setEditMode(false)
      this.resetToOverview()
    }
    if (!enabled && this.smartScope) this._reconcile()
    this._linkStatus(enabled ? 'Choose two tree heads to connect their trees. Esc cancels.' : '')
    if (this.treeWindows) for (const frame of this.treeWindows.windows) {
      if (frame.graph === this) continue
      frame.graph._linkMode = enabled
      frame.graph.zoomHost.classList.toggle('is-linking', enabled)
      for (const record of frame.graph.nodes.values()) record.el.classList.remove('link-source')
      if (enabled) { frame.graph.setEditMode(false); frame.graph.clearRoot() }
      else if (frame.graph.smartScope) frame.graph._reconcile()
    }
  }

  async _chooseLinkNode(record) {
    if (this.chatOwner) { await this.chatOwner._chooseLinkNode(record); return }
    if (this._linkPending) return
    const scope = this._scopeModel()
    // A direct tree link always belongs to the complete tree's head, even
    // when an endpoint came from a child or another canvas.
    const headId = scope.ancestry(record.id)[0]?.id
    const head = scope.byId.get(headId)
    if (!head) { this._linkStatus('Choose a tree head in the overview to make a link.'); return }
    if (!this._linkFrom) {
      this._linkFrom = headId
      for (const graph of this.treeWindows?.windows.map(frame => frame.graph) || [this]) {
        graph.nodes.get(headId)?.el.classList.add('link-source')
      }
      this._linkStatus(`Linking ${head.name} › choose the head of another tree. You can switch trees.`)
      return
    }
    if (this._linkFrom === headId) {
      this._linkStatus(`${head.name} is already selected. Choose a different tree, or press Esc to cancel.`)
      return
    }
    const from = this._linkFrom
    const existing = this.communicationLinks.some(link => (link.from === from && link.to === headId) || (link.to === from && link.from === headId))
    if (existing) {
      this.setLinkMode(false)
      this._showLinkDetails({ from, to: headId })
      return
    }
    await this._changeLink({ from, to: headId, connected: true })
  }

  async _changeLink(request) {
    if (this._linkPending) return
    this._linkPending = true
    this._linkStatus(request.connected ? 'Connecting agents…' : 'Removing the direct link…')
    try {
      if (!this.onLinkChange) throw new Error('Direct links need the native app and a local tree.')
      const result = await this.onLinkChange(request)
      if (result?.ok !== true) throw new Error(result?.reason || 'The direct link could not be saved.')
      if (this._destroyed) return
      this.setCommunicationLinks(result.links)
      this._linkPending = false
      this.setLinkMode(false)
      const from = this._agentFor(request.from)?.name || 'Agent'
      const to = this._agentFor(request.to)?.name || 'agent'
      this._linkStatus(request.connected ? `${from} › ${to} linked. Messages can flow both ways when their sessions are running.` : `${from} › ${to} unlinked.`, { fade: true })
      this.linkPopover?.remove()
    } catch (error) {
      if (this._destroyed) return
      this._linkStatus(error.message || 'The direct link could not be saved.')
    } finally { this._linkPending = false }
  }

  _showLinkDetails(link) {
    if (this.chatOwner) { this.chatOwner._showLinkDetails(link); return }
    if (this._linkPending) return
    const document = this.zoomHost.ownerDocument, opener = document.activeElement
    this.linkPopover?.remove()
    const from = this._agentFor(link.from), to = this._agentFor(link.to)
    const popup = el(`<section class="tree-link-popover" popover="auto" role="dialog" aria-label="Agent link" tabindex="-1">
      <header><span class="link-symbol" aria-hidden="true">›</span><div><strong>Agent link</strong><span>Two-way communication</span></div><button type="button" class="link-dismiss" aria-label="Close link controls">×</button></header>
      <div class="link-peer-list">
        <div class="link-peer"><div><strong class="link-agent-name"></strong><span class="link-agent-role"></span></div><button type="button" class="link-open-first">Chat <span aria-hidden="true">↗</span></button></div>
        <div class="link-peer"><div><strong class="link-agent-name"></strong><span class="link-agent-role"></span></div><button type="button" class="link-open-second">Chat <span aria-hidden="true">↗</span></button></div>
      </div>
      <p class="link-action-error" role="alert" hidden></p>
      <footer><button type="button" class="link-remove">Remove link</button></footer>
    </section>`)
    let dismissed = false
    const close = (restoreFocus = true) => {
      if (dismissed) return
      dismissed = true
      popup.remove()
      if (this.linkPopover === popup) this.linkPopover = null
      if (restoreFocus) (opener?.isConnected ? opener : this.zoomHost).focus({ preventScroll: true })
    }
    for (const [selector, agent] of [['.link-open-first', from], ['.link-open-second', to]]) {
      const button = popup.querySelector(selector)
      const row = button.closest('.link-peer')
      row.querySelector('.link-agent-name').textContent = agent?.name || 'Agent no longer on this tree \u2014 Remove link below'
      row.querySelector('.link-agent-role').textContent = agent ? roleAppearance(agent.declaredRole || agent.role).label : ''
      button.setAttribute('aria-label', `Chat with ${agent?.name || 'agent'}`)
      button.disabled = !agent
      button.addEventListener('click', () => { close(false); this.openFullChat(agent.id) })
    }
    const remove = popup.querySelector('.link-remove'), error = popup.querySelector('.link-action-error')
    remove.addEventListener('click', async () => {
      remove.disabled = true
      remove.textContent = 'Removing…'
      error.hidden = true
      await this._changeLink({ ...link, connected: false })
      if (dismissed || this._destroyed || this.linkPopover !== popup) return
      if (!popup.isConnected) { close(); return }
      remove.disabled = false
      remove.textContent = 'Remove link'
      error.textContent = this.linkStatus?.textContent || 'The link could not be removed.'
      error.hidden = false
      remove.focus({ preventScroll: true })
    })
    popup.querySelector('.link-dismiss').addEventListener('click', () => close())
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key !== 'Tab') return
      const buttons = [...popup.querySelectorAll('button:not(:disabled)')]
      const target = event.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1)
        : !event.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : null
      if (target) { event.preventDefault(); target.focus() }
    })
    popup.addEventListener('toggle', event => { if (event.newState === 'closed') close(false) })
    const anchor = opener?.closest?.('.tree-link-marker, .tree-window-links [role="button"]') || this.zoomHost
    const rect = anchor.getBoundingClientRect(), uiZoom = textZoom(document)
    popup.style.setProperty('--link-popover-x', `${rect.left / uiZoom + 8}px`)
    popup.style.setProperty('--link-popover-y', `${(anchor === this.zoomHost ? rect.top + 24 : rect.bottom + 8) / uiZoom}px`)
    this.linkPopover = popup
    this.zoomHost.appendChild(popup)
    popup.showPopover()
    const peers = popup.querySelector('.link-peer-list')
    popup.style.setProperty('--link-popover-height', `${popup.offsetHeight + peers.scrollHeight - peers.clientHeight + 2}px`)
    const firstAction = popup.querySelector('button.link-open-first:not(:disabled)') || popup.querySelector('.link-dismiss')
    firstAction.focus({ preventScroll: true })
  }

  _renderCommunicationLinks(paintable) {
    const ns = 'http://www.w3.org/2000/svg'
    const boxed = this.nodeStyle === 'boxes', positioned = []
    const obstacles = boxed ? [...this.nodes.values()].filter(record => paintable(record) && !record.el.hidden)
      .map(record => this._labelBox(record)) : []
    for (const link of this.communicationLinks) {
      const from = this.nodes.get(link.from), to = this.nodes.get(link.to)
      if (!paintable(from) || !paintable(to)) continue
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1
      const ux = dx / length, uy = dy / length
      const x1 = from.x + ux * this._nodeRadius(from), y1 = from.y + uy * this._nodeRadius(from)
      const x2 = to.x - ux * this._nodeRadius(to), y2 = to.y - uy * this._nodeRadius(to)
      const start = this.nodeStyle === 'boxes' ? boxPort(from, to, 1, this.cardSize) : { x: x1, y: y1 }
      const end = this.nodeStyle === 'boxes' ? boxPort(to, from, 1, this.cardSize) : { x: x2, y: y2 }
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('class', 'tree-link link-direct')
      path.setAttribute('data-from', link.from)
      path.setAttribute('data-to', link.to)
      path.setAttribute('data-edge-type', 'direct')
      path.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y}`)
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      this.svg.appendChild(path)
      const marker = document.createElementNS(ns, 'g')
      marker.setAttribute('class', 'tree-link-marker')
      marker.style.transform = `translate(${(start.x + end.x) / 2}px, ${(start.y + end.y) / 2}px) scale(var(--link-marker-scale, 1))`
      if (boxed) positioned.push({ marker, start, end })
      marker.setAttribute('role', 'button')
      marker.setAttribute('tabindex', '0')
      marker.setAttribute('aria-label', `Direct link: ${from.agent.name} and ${to.agent.name}. Open link controls.`)
      const circle = document.createElementNS(ns, 'circle')
      circle.setAttribute('r', '11')
      const text = document.createElementNS(ns, 'text')
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dy', '6')
      text.textContent = '›'
      marker.append(circle, text)
      marker.addEventListener('click', event => { event.stopPropagation(); this._showLinkDetails(link) })
      marker.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); this._showLinkDetails(link) }
      })
      this.svg.appendChild(marker)
    }
    // The control stays the same screen size while cards scale. Reposition
    // only its center as needed; the direct line keeps its original geometry.
    this._positionCommunicationMarkers = positioned.length ? () => {
      const clearance = 13 / (this.zoom || 1)
      for (const { marker, start, end } of positioned) {
        const point = clearLinkMarkerPoint(start, end, obstacles, clearance)
        marker.style.transform = `translate(${point.x}px, ${point.y}px) scale(var(--link-marker-scale, 1))`
      }
    } : null
    this._positionCommunicationMarkers?.()
  }

  setWide(wide) {
    if (this.chatOwner) { this.chatOwner.setWide(wide); return }
    const body = this.zoomHost?.closest?.('.comp-body')
    if (!body) return
    this._treeWide = !!wide
    body.classList.toggle('tree-workspace-wide', this._treeWide)
    this.wideToggle?.setAttribute('aria-pressed', String(this._treeWide))
    if (this.wideToggle) this.wideToggle.textContent = this._treeWide ? 'Show details' : 'Expand tree'
    const overview = body.querySelector('.graph-open-btn')
    overview?.setAttribute('aria-expanded', String(!this._treeWide))
  }

  _contextTreeKeys(agents = this._layoutAgents()) {
    const scope = agents.some(agent => agent?.treeScope?.group) ? this._scopeModel() : null
    return [...new Set(agents.flatMap(agent => agentTreeContextKeys(this.computer?.id, agent, scope)))]
  }

  _contextCardProfile(agent, policy = this._contextPolicy || { defaultSize: this.cardSize }) {
    const profiles = this._contextTreeKeys([agent]).map(key => treeContextProfile(policy, key))
    // A collapsed group inherits its actual trees. If it spans trees with
    // different choices, use the largest enabled card; all-Off stays hidden.
    return profiles.reduce((largest, profile) => profile.width > largest.width ? profile : largest,
      profiles[0] || treeContextProfile(policy))
  }

  _syncContextCardControl() {
    if (!this._contextPolicyReadable && this.contextCardNotice) this.contextCardNotice.textContent = this._contextPolicyError
    const agents = this._layoutAgents()
    const keys = this._contextTreeKeys(agents)
    this.cardsToggle?.setAttribute('aria-pressed', String(this.circleCards !== false && agents.some(agent => this._contextCardProfile(agent).value !== 'off')))
    if (!this.contextCardSelect) return
    const choices = new Set(keys.map(key => this._contextPolicy?.trees?.[key] || 'default'))
    this.contextCardSelect.value = choices.size > 1 ? 'mixed' : [...choices][0] || 'default'
    this.contextCardSelect.disabled = !this._contextPolicyReadable || keys.length === 0
    this.contextCardSelect.title = keys.length ? `Applies to ${keys.length === 1 ? 'this tree' : 'the trees in view'}. The default is ${treeContextProfile(this._contextPolicy).label}.` : 'Add a tree to choose its context-card size.'
  }

  _applyContextCardPolicy(record, boxSize) {
    if (this._destroyed) return
    const nextSize = boxSize || (record.defaultSize === 'off' ? this.cardSize : record.defaultSize)
    const resized = nextSize !== this.cardSize
    if (!resized && JSON.stringify(record) === JSON.stringify(this._contextPolicy)) return
    const changed = this._layoutAgents().some(agent => {
      return this._contextCardProfile(agent, record).value !== this._contextCardProfile(agent).value
    })
    this._contextPolicy = record
    if (!changed && !resized) return
    if (resized) { this.cardSize = nextSize; this._syncCardMetrics() }
    this._contextRevision = (this._contextRevision || 0) + 1
    for (const node of this.nodes.values()) {
      node.chipPreviewKey = node.boxPreviewKey = null
      this._renderChipPreview(node)
    }
    if (this.nodeStyle === 'boxes' && resized) {
      this._cancelZoomMotion()
      this._layoutKey = null
      this._viewSteered = false
      this._reconcile()
    } else this._placeChips()
    // Detached cards occupy screen-space slots; changing them never changes
    // the hierarchy spacing, focused branch, or the person's camera.
    this._syncContextCardControl()
    const owner = this.chatOwner || this
    owner.treeWindows?.toolbar?.sync()
  }

  setContextCardSize(size) {
    const treeKeys = this._contextTreeKeys()
    if (!treeKeys.length) return { ok: false, reason: 'Add a tree before choosing its card size.' }
    const result = updateTreeContextCards({ treeKeys, size })
    if (result.ok) this._applyContextCardPolicy(result.record, result.boxSize)
    this._syncContextCardControl()
    if (this.contextCardNotice) this.contextCardNotice.textContent = result.ok ? '' : result.reason
    return result
  }

  /* Zoom about a point. Without an anchor it holds the centre of the visible
     area, so the thing being read stays where it is being read. */
  _cancelZoomMotion() {
    if (this._zoomFrame) cancelAnimationFrame(this._zoomFrame)
    this._zoomFrame = 0
    this._zoomMotion = null
    this._cancelCamera()
  }

  _cancelCamera() {
    if (this._cameraFrame) cancelAnimationFrame(this._cameraFrame)
    this._cameraFrame = 0
  }

  _moveCamera(target) {
    if (calm()) { Object.assign(this, target); this._applyZoom(); return }
    const start = { zoom: this.zoom, panX: this.panX, panY: this.panY }
    const began = performance.now()
    const tick = now => {
      this._cameraFrame = 0
      if (this._destroyed) return
      const progress = Math.min(1, (now - began) / 180)
      const amount = 1 - (1 - progress) ** 3
      this.zoom = Math.exp(Math.log(start.zoom) + Math.log(target.zoom / start.zoom) * amount)
      this.panX = start.panX + (target.panX - start.panX) * amount
      this.panY = start.panY + (target.panY - start.panY) * amount
      this._applyZoom()
      if (progress < 1) this._cameraFrame = requestAnimationFrame(tick)
    }
    this._cameraFrame = requestAnimationFrame(tick)
  }

  _controlZoom(factor) {
    const record = this.nodes.get(this.selectedId)
    if (record && !record.el.hidden) {
      const x = this.panX + record.x * this.zoom, y = this.panY + record.y * this.zoom
      if (x >= 0 && y >= 0 && x <= this.zoomHost.clientWidth && y <= this.zoomHost.clientHeight) {
        this._zoomInput(factor, x, y, { explore: !!this.smartScope && !this.editMode })
        return
      }
    }
    this._zoomInput(factor, null, null, { explore: !!this.smartScope && !this.editMode })
  }

  _zoomOutFloor() {
    const box = this._contentBox(1)
    const width = this.zoomHost.clientWidth || this.W
    const height = this.zoomHost.clientHeight || this.H
    let fitted = Number.isFinite(this._fitFloor) && this._fitFloor > 0 ? this._fitFloor : 1
    // A manually steered pane may have resized since its last Fit. Allow
    // enough room for its current content, including very large edit trees.
    if (box && width > 0 && height > 0) {
      fitted = Math.min(fitted, Math.max(1, width - FIT_PAD * 2) / box.w,
        Math.max(1, height - FIT_PAD * 2) / box.h)
    }
    let floor = fitted * ZOOM_OUT_FIT_RATIO
    // Returning to a parent must remain reachable even after a resize.
    if (this._scopeHistory?.length && this._scopeExitZoom > 0) floor = Math.min(floor, this._scopeExitZoom * 0.9)
    return Number.isFinite(floor) && floor > 0 ? floor : ZOOM_MIN
  }

  _zoomInput(factor, anchorX = null, anchorY = null, { gesture = null, explore = false } = {}) {
    if (!Number.isFinite(factor) || factor <= 0) return
    this._cancelCamera()
    if (calm()) { this.zoomBy(factor, anchorX, anchorY, { gesture, explore }); return }
    const floor = Math.min(this.zoom, this._zoomOutFloor())
    const target = clamp((this._zoomMotion?.target || this.zoom) * factor, floor, ZOOM_MAX)
    gesture ??= this._zoomGesture = (this._zoomGesture || 0) + 1
    this._zoomMotion = { target, anchorX, anchorY, time: performance.now(), inward: factor > 1, gesture, explore }
    if (this._zoomFrame) return
    const tick = now => {
      this._zoomFrame = 0
      const motion = this._zoomMotion
      if (!motion || this._destroyed) return
      const remaining = Math.log(motion.target / this.zoom)
      const done = Math.abs(remaining) < 0.002
      const step = done ? motion.target / this.zoom : Math.exp(remaining * (1 - Math.exp(-Math.max(8, now - motion.time) / 38)))
      motion.time = now
      const previous = this.zoom
      this.zoomBy(step, motion.anchorX, motion.anchorY, { inward: motion.inward, gesture: motion.gesture, explore: motion.explore })
      if (this._zoomMotion !== motion) return
      if (done || this.zoom === previous) this._zoomMotion = null
      else this._zoomFrame = requestAnimationFrame(tick)
    }
    this._zoomFrame = requestAnimationFrame(tick)
  }

  _captureRootAt(nextRoot, record, graphX, graphY, screenX, screenY) {
    const oldX = record.x, oldY = record.y
    this._viewSteered = true
    this._transitionRoot(nextRoot)
    const next = this.nodes.get(record.id)
    const anchor = next && this._layoutVisibleIds.has(next.id) ? next : this.nodes.get(nextRoot)
    if (anchor) {
      this.panX = screenX - (anchor.x + graphX - oldX) * this.zoom
      this.panY = screenY - (anchor.y + graphY - oldY) * this.zoom
    }
    this._applyZoom()
    if (this.smartScope || (this.computer?.agents?.length || 0) >= TREE_COLLAPSE_AT) {
      // Opening a group reveals its children in the available pane. Keeping
      // the old scale here puts every new child below the bottom edge when
      // the person zoomed into a group near the bottom of the overview.
      const start = { zoom: this.zoom, panX: this.panX, panY: this.panY }
      this.fitToHost()
      const target = { zoom: this.zoom, panX: this.panX, panY: this.panY }
      Object.assign(this, start)
      this._cancelZoomMotion()
      this._applyZoom()
      this._moveCamera(target)
    }
  }

  zoomBy(factor, anchorX = null, anchorY = null, { inward = factor > 1, gesture = null, explore = false } = {}) {
    if (!Number.isFinite(factor) || factor <= 0) return
    if (gesture == null) gesture = this._zoomGesture = (this._zoomGesture || 0) + 1
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    // Inward gestures name an area of interest. Outward gestures ask for
    // context, without requiring the pointer to be in a particular place.
    const centered = this.smartScope && !inward
    const screenX = centered || anchorX == null ? hostWidth / 2 : anchorX
    const screenY = centered || anchorY == null ? hostHeight / 2 : anchorY
    const graphX = (screenX - this.panX) / this.zoom
    const graphY = (screenY - this.panY) / this.zoom
    if (this.smartScope && inward && explore && this._zoomIntent?.gesture !== gesture) {
      // Capture intent before the canvas moves. The gap beside a card and
      // its connector belong to the same generous target as the card itself.
      const reach = Math.max(DRILL_RADIUS, Math.min(hostWidth, hostHeight) * 0.3) / this.zoom
      this._zoomIntent = { gesture, id: this._nearestRecordTo(graphX, graphY, reach)?.id || null }
    }
    // If a restored/resized view is already below the limit, hold it there
    // instead of making an outward gesture jump inward.
    const floor = Math.min(this.zoom, this._zoomOutFloor())
    const previous = this.zoom
    this.zoom = clamp(previous * factor, floor, ZOOM_MAX)
    this.panX = screenX - graphX * this.zoom
    this.panY = screenY - graphY * this.zoom
    /* Steering by hand ends the automatic fit's mandate: the next resize
       leaves this view where the person put it. */
    this._viewSteered = true
    this._autoFitted = false
    this._clampPan()
    this._applyZoom()
    // One level per input, even when the easing continues for several frames.
    // Further inward inputs may reveal another group at the zoom ceiling;
    // outward inputs may leave another level at the floor.
    if (!explore || this._linkMode || this._lastScopeGesture === gesture) return
    // Boxes already contain their context. Reveal the pointed branch after
    // a modest step beyond its fitted view, before magnifying a summary into
    // a whole screen. Circles retain their existing exploration threshold.
    const drillAt = this.smartScope && this.nodeStyle === 'boxes'
      ? Math.min(ZOOM_DRILL_AT, Math.max(1.12, (this._fitFloor || 1) * 1.35)) : ZOOM_DRILL_AT
    const intent = this.smartScope && this._zoomIntent?.gesture === gesture ? this.nodes.get(this._zoomIntent.id) : null
    const offCenter = intent && (Math.abs(this.panX + intent.x * this.zoom - hostWidth / 2) > hostWidth * 0.28
      || Math.abs(this.panY + intent.y * this.zoom - hostHeight / 2) > hostHeight * 0.28)
    const recenter = this.smartScope && offCenter && this.zoom >= Math.max(0.82, (this._fitFloor || 1) * 1.2)
    if (inward && (this.zoom >= drillAt || recenter)) {
      const nearest = this.smartScope ? intent : this._nearestRecordTo(graphX, graphY, DRILL_RADIUS / this.zoom)
      const branch = nearest?.agent.treeScope
      let nextRoot = null
      // A partially open manager still owns hidden descendants. Pointing at
      // that manager should enter its branch as naturally as a closed group.
      if ((branch?.expandable || (this.smartScope && branch?.hidden > 0)) && nearest.id !== this.rootId) {
        nextRoot = nearest.id
      } else if (recenter && nearest && !this.rootId) {
        // In a forest, a nearby leaf names its complete tree. It never turns
        // into a one-agent scope merely because the pointer was near it.
        const scope = this._scopeModel()
        const roots = this.windowRootIds || scope.children.get(null) || []
        const head = scope.ancestry(nearest.id)[0]?.id
        if (roots.length > 1 && head && scope.branch(head).length > 1) nextRoot = head
      }
      if (nextRoot) {
        this._scopeHistory ||= []
        this._scopeHistory.push({ rootId: this.rootId || null, exitZoom: this._scopeExitZoom })
        this._lastScopeGesture = gesture
        this._captureRootAt(nextRoot, nearest, graphX, graphY, screenX, screenY)
        this._scopeExitZoom = this._fitFloor * 0.7
      } else if (recenter && nearest) {
        const start = { zoom: this.zoom, panX: this.panX, panY: this.panY }
        this.panX = hostWidth / 2 - nearest.x * this.zoom
        this.panY = hostHeight / 2 - nearest.y * this.zoom
        this._clampPan()
        const target = { zoom: this.zoom, panX: this.panX, panY: this.panY }
        Object.assign(this, start)
        this._lastScopeGesture = gesture
        this._cancelZoomMotion()
        this._moveCamera(target)
      }
    } else if (!inward && this._scopeHistory?.length && this.zoom <= (this._scopeExitZoom || ZOOM_DRILL_OUT_AT)) {
      const record = this.nodes.get(this.rootId)
      const parent = this._scopeHistory.pop()
      this._lastScopeGesture = gesture
      if (record) this._captureRootAt(parent.rootId, record, graphX, graphY, screenX, screenY)
      this._scopeExitZoom = parent.exitZoom
    }
  }

  /* Put a node under the reader's eye at the current zoom. This is what
     "control where on the tree you end up" means when the tree outgrows the
     panel: pick a branch, land on it. */
  focusNode(id, { zoom = null } = {}) {
    const record = this.nodes.get(id)
    if (!record) return
    if (zoom != null) this.zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    this.panX = hostWidth / 2 - record.x * this.zoom
    this.panY = hostHeight / 2 - record.y * this.zoom
    /* Landing on a branch is steering, so the automatic fit stands down. */
    this._viewSteered = true
    this._autoFitted = false
    this._clampPan()
    this._applyZoom()
  }

  _wireHostInteractions() {
    this._onWheel = (event) => {
      if ((this.editMode && !this.smartScope) || event.target.closest?.('.chip.as-chat, .chat')) return
      event.preventDefault()
      const rect = this.zoomHost.getBoundingClientRect()
      const uiZoom = textZoom(this.zoomHost.ownerDocument)
      const screenX = (event.clientX - rect.left) / uiZoom - this.zoomHost.clientLeft
      const screenY = (event.clientY - rect.top) / uiZoom - this.zoomHost.clientTop
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.zoomHost.clientHeight : 1
      const now = performance.now()
      const pinch = event.ctrlKey || event.metaKey
      const kind = pinch ? 'zoom' : event.shiftKey || this.inputMode === 'trackpad' ? 'pan' : 'zoom'
      const direction = Math.sign(event.deltaY)
      const recent = this._wheelGesture && now - this._wheelGesture.at < 260
        && this._wheelGesture.kind === kind && this._wheelGesture.direction === direction
      const gesture = recent ? this._wheelGesture.id : this._zoomGesture = (this._zoomGesture || 0) + 1
      this._wheelGesture = { kind, at: now, id: gesture, direction }
      // Let a revealed branch settle before accepting another scroll gesture.
      if (kind === 'zoom' && gesture === this._lastScopeGesture) return
      if (kind === 'pan') {
        this._cancelZoomMotion()
        this.panX -= (event.shiftKey ? event.deltaX || event.deltaY : event.deltaX) * unit / uiZoom
        this.panY -= (event.shiftKey ? 0 : event.deltaY) * unit / uiZoom
        this._viewSteered = true
        this._autoFitted = false
        this._clampPan()
        this._applyZoom()
      } else {
        const delta = clamp(event.deltaY * unit, -120, 120)
        this._zoomInput(Math.exp(-delta * (pinch ? .006 : .0015)), screenX, screenY, { gesture, explore: !this.editMode })
      }
    }
    this.zoomHost.addEventListener('wheel', this._onWheel, { passive: false })

    this._onPanDown = (event) => {
      if (![0, 1].includes(event.button) || event.isPrimary === false || this._panState || this._nodeDrag
        || (this.editMode && !this.smartScope)) return
      // Capturing an anchor's pointer retargets Chromium's mouse click to the
      // graph host, swallowing navigation from the mobile sign-in gate.
      if (event.target.closest?.('button, input, select, a[href], .tree-link-marker')) return
      if (event.button === 0 && event.target.closest?.('.node, .chip, .graph-fit, .graph-zoomer, .graph-crumb')) return
      event.preventDefault()
      for (const record of this.nodes.values()) clearTimeout(record.clickTimer)
      this._cancelZoomMotion()
      this._panState = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panX: this.panX,
        panY: this.panY,
      }
      try { this.zoomHost.setPointerCapture(event.pointerId) } catch { /* optional */ }
      this.zoomHost.classList.add('panning')
    }
    this._onPanMove = (event) => {
      if (!this._panState || event.pointerId !== this._panState.id) return
      /* THE POINTER IS NOT DOWN ANY MORE, SO THIS IS NOT A DRAG.
         A pan ends on pointerup, pointercancel or lostpointercapture, and any
         of the three can be missed -- the captured element re-rendering under
         the cursor is enough, and so is the browser revoking capture. When one
         was missed, `_panState` survived and EVERY LATER MOUSE MOVE kept
         panning with no button held: the tree followed the cursor around the
         screen and could not be put down. That is the "it gets stuck after
         being moved around funny" report, and it is why this check is here
         rather than only on the three end events -- `buttons` is read from the
         move itself, so the state repairs itself on the very next event no
         matter what was missed or why. */
      if (event.buttons === 0) { this._onPanEnd(event); return }
      const uiZoom = textZoom(this.zoomHost.ownerDocument)
      this.panX = this._panState.panX + (event.clientX - this._panState.x) / uiZoom
      this.panY = this._panState.panY + (event.clientY - this._panState.y) / uiZoom
      /* Moving the tree by hand is a decision, the same as zooming by hand:
         the automatic fit stops re-answering and the view stays where it was
         put. */
      this._viewSteered = true
      this._autoFitted = false
      this._clampPan()
      this._applyZoom()
    }
    this._onPanEnd = (event) => {
      if (!this._panState || event.pointerId !== this._panState.id) return
      this._panState = null
      this.zoomHost.classList.remove('panning')
      try { this.zoomHost.releasePointerCapture(event.pointerId) } catch { /* optional */ }
    }
    this.zoomHost.addEventListener('pointerdown', this._onPanDown)
    this.zoomHost.addEventListener('pointermove', this._onPanMove)
    this.zoomHost.addEventListener('pointerup', this._onPanEnd)
    this.zoomHost.addEventListener('pointercancel', this._onPanEnd)
    /* THE THIRD WAY A DRAG ENDS, and the one nobody binds. Capture is lost
       without either of the two above when the captured element is removed or
       the browser takes it back; the pan then had no end event at all. */
    this.zoomHost.addEventListener('lostpointercapture', this._onPanEnd)

    /* Keyboard peers for every pointer gesture: +/- zoom, 0 returns to the
       overview, arrows pan, and F centres the focused node. */
    this._onHostKeydown = (event) => {
      if ((this.editMode && !this.smartScope) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target.closest?.('input, textarea, .chat')) return
      const step = event.shiftKey ? 120 : 48
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this._controlZoom(1.2); return }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); this._controlZoom(1 / 1.2); return }
      if (event.key === '0') { event.preventDefault(); this.fitCurrentTree(); return }
      if (event.key === 'f' || event.key === 'F') {
        const node = event.target.closest?.('.node')
        if (!node?.dataset.agentId) return
        event.preventDefault()
        this.focusNode(node.dataset.agentId)
        return
      }
      const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key]
      if (!pan) return
      event.preventDefault()
      this._cancelZoomMotion()
      this.panX += pan[0]
      this.panY += pan[1]
      // Keyboard panning is manual steering, just like a pointer drag.
      this._viewSteered = true
      this._autoFitted = false
      this._clampPan()
      this._applyZoom()
    }
    this.zoomHost.addEventListener('keydown', this._onHostKeydown)
    // Page 2 mounts the toolbar beside the canvas. Its focused buttons must
    // receive the same shortcuts; embedded toolbars already bubble to host.
    if (this.zoomerEl && !this.zoomHost.contains(this.zoomerEl)) {
      this.zoomerEl.addEventListener('keydown', this._onHostKeydown)
    }
  }

  _toGraph(event) {
    const rect = this.zoomHost.getBoundingClientRect()
    const uiZoom = textZoom(this.zoomHost.ownerDocument)
    return {
      x: ((event.clientX - rect.left) / uiZoom - this.zoomHost.clientLeft - this.panX) / this.zoom,
      y: ((event.clientY - rect.top) / uiZoom - this.zoomHost.clientTop - this.panY) / this.zoom,
    }
  }

  /* The old clamp allowed no pan at all at or below 1x — the view could not be
     moved, only reset, which is exactly the viewport fighting the reader. Now
     the content may be dragged anywhere that keeps a usable piece of it on
     screen, at any zoom. */
  _clampPan() {
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    const box = this._contentBox() || { x: 0, y: 0, w: this.W, h: this.H }
    const contentWidth = box.w * this.zoom
    const contentHeight = box.h * this.zoom
    if (this.smartScope) {
      // Keep a small forest inside its pane. For larger content, pan between
      // its edges with a little breathing room, without losing it offscreen.
      const edge = FIT_PAD
      const bounds = (origin, size, viewport) => {
        const first = edge - origin * this.zoom
        const last = viewport - edge - (origin * this.zoom + size)
        return [Math.min(first, last), Math.max(first, last)]
      }
      this.panX = clamp(this.panX, ...bounds(box.x, contentWidth, hostWidth))
      this.panY = clamp(this.panY, ...bounds(box.y, contentHeight, hostHeight))
      return
    }
    const keepX = Math.min(PAN_KEEP, contentWidth)
    const keepY = Math.min(PAN_KEEP, contentHeight)
    this.panX = clamp(this.panX, keepX - (box.x + box.w) * this.zoom, hostWidth - keepX - box.x * this.zoom)
    this.panY = clamp(this.panY, keepY - (box.y + box.h) * this.zoom, hostHeight - keepY - box.y * this.zoom)
  }

  _applyZoom() {
    this.container.style.setProperty('--link-marker-scale', String(1 / this.zoom))
    this._positionCommunicationMarkers?.()
    const textScale = Math.min(1.4, Math.max(1, 0.9 / this.zoom))
    this.container.style.setProperty('--tree-box-text-scale', String(textScale))
    if (this.container.dataset) this.container.dataset.boxCompact = String(this.nodeStyle === 'boxes' && this.zoom < 0.85)
    // Zoom compensation changes line height without necessarily resizing the
    // context container, so ResizeObserver alone cannot update its line budget.
    if (this.nodeStyle === 'boxes' && this._previewTextScale !== textScale) {
      for (const record of this.nodes.values()) {
        if (!record.el.hidden && record.previewFitContainer) this.previewFitter.schedule(record.previewFitContainer)
      }
    }
    this._previewTextScale = textScale
    const nodeScale = this._nodeScale()
    this.container.style.setProperty('--node-scale', String(nodeScale))
    for (const slot of this.emptySlots.values()) this._positionEmptySlot(slot)
    if (this._paintedNodeScale !== nodeScale) {
      this._paintedNodeScale = nodeScale
      this._renderLinks()
    }
    const identity = Math.abs(this.zoom - 1) < 0.001 && !this.panX && !this.panY
    this.container.style.transform = identity ? ''
      : `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.zoom})`
    this.zoomHost.classList.toggle('zoomed', !identity)
    this.fitEl?.classList.toggle('show', true)
    this.fitEl?.classList.toggle('is-off', !identity)
    const readout = this.zoomerEl?.querySelector('.gf-z') || this.fitEl?.querySelector('.gf-z')
    if (readout) readout.textContent = `${Math.round(this.zoom * 100)}%`
    this._placeChips()
    this.windowBoard?.scheduleLinks()
  }

  resetZoom() {
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this._fitFloor = null
    this._autoFitted = false
    this._viewSteered = false
    this._applyZoom()
  }

  /* THE BOX THE DRAWN TREE ACTUALLY OCCUPIES, in graph coordinates.
   *
   * Not `W x H` -- that is the canvas the layout was GIVEN, and the whole
   * defect below is the two being different. Every circle is positioned by its
   * centre (`transform: translate(-50%, -50%)`, tree-graph.css) and carries an
   * absolutely positioned label stack BELOW its own box, so the drawn extent
   * is read from the elements rather than from the radius alone: a name is as
   * much a part of "can I see this agent" as the circle is. */
  _contentBox(zoom = this.zoom) {
    const nodeScale = this._nodeScale(zoom)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const take = (left, top, right, bottom) => {
      if (![left, top, right, bottom].every(Number.isFinite)) return
      if (left < minX) minX = left
      if (top < minY) minY = top
      if (right > maxX) maxX = right
      if (bottom > maxY) maxY = bottom
    }
    for (const record of this.nodes.values()) {
      if (record.el?.hidden || this._culled?.has(record.id) || (this._layoutVisibleIds && !this._layoutVisibleIds.has(record.id))) continue
      if (this.nodeStyle === 'boxes') {
        take(record.x - this._boxSize().width / 2, record.y - this._boxSize().height / 2, record.x + this._boxSize().width / 2, record.y + this._boxSize().height / 2)
        continue
      }
      const labels = record.el?.querySelector?.('.node-labels')
      // Predict label bounds at the requested zoom rather than reading the
      // previous scale's wrapped width. Otherwise fitting requires a second
      // resize before a wide branch actually clears the pane edges.
      const labelWidth = record.agent && labels
        ? Math.min(record.r * 2 + 118, record.labelMax || Infinity)
        : labels?.offsetWidth || 0
      const labelHeight = record.agent && labels ? TREE_LABEL_STACK : labels?.offsetHeight || 0
      const radius = record.r * nodeScale
      const half = Math.max(radius, Math.min(labelWidth * nodeScale, record.labelMax || Infinity) / 2)
      /* The stack's own offsets are relative to the circle's box, whose top
         edge is `y - r`; that is the whole conversion. */
      const labelBottom = labels
        ? record.y + (-record.r + (labels.offsetTop || 0) + labelHeight) * nodeScale
        : record.y + radius
      take(record.x - half, record.y - radius, record.x + half, Math.max(labelBottom, record.y + radius))
    }
    for (const slot of this.emptySlots.values()) {
      if (slot.hidden || slot.el?.hidden) continue
      const point = this._emptyGeometry(slot, zoom)
      const halfW = (slot.el?.offsetWidth || slot.r * 2) * point.scale / 2
      const halfH = (slot.el?.offsetHeight || slot.r * 2) * point.scale / 2
      take(point.x - halfW, point.y - halfH, point.x + halfW, point.y + halfH)
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  /**
   * PUT THE WHOLE TREE INSIDE THE CANVAS THERE ACTUALLY IS.
   *
   * The layout is allowed to ask for more height than the pane has -- see
   * _layoutNow, which sets the container's min-height and expects the page to
   * scroll to it. On a phone the page CANNOT scroll: that is the mode's
   * central promise, and it is why a phone turned sideways lost its entire
   * fleet (750x342, both engines, 2026-08-28: five agents laid out 200-390px
   * below a screen with no scroll, no reachable pan and a zoom floor of 0.5x
   * that could not go far enough). An unscrollable page has exactly one honest
   * answer to a tree taller than its canvas, and it is to draw the tree
   * smaller. Returns false when there is nothing to fit, so the caller can say
   * so rather than paint a transform over an empty canvas.
   */
  fitToHost(options = {}) {
    this._fittingView = true
    try { return this._fitToHost(options) } finally { this._fittingView = false }
  }

  _fitToHost({ readable = false } = {}) {
    let box = this._contentBox(1)
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    if (!box || !(hostWidth > 0) || !(hostHeight > 0)) return false
    // Toolbar/crumbs can live in the canvas or in a sibling graph bar. Only
    // reserve the band that is actually over this host, in its CSS pixels.
    const hostRect = this.zoomHost.getBoundingClientRect?.()
    const uiZoom = textZoom(this.zoomHost.ownerDocument)
    let topPad = FIT_PAD
    for (const selector of ['.graph-zoomer', '.graph-title', '.graph-crumb', '.graph-hint.show']) {
      const chrome = this.zoomHost.querySelector?.(selector)
      const rect = chrome?.getBoundingClientRect?.()
      if (hostRect && rect?.height > 0 && rect.top >= hostRect.top && rect.bottom < hostRect.top + hostRect.height / 3) {
        topPad = Math.max(topPad, (rect.bottom - hostRect.top) / uiZoom + FIT_PAD)
      }
    }
    const usableWidth = Math.max(hostWidth - FIT_PAD * 2, 1)
    const usableHeight = Math.max(hostHeight - topPad - FIT_PAD, 1)
    // A sparse overview may grow modestly into spare room. The ceiling keeps
    // a single circle from becoming the canvas; Small text still has readable
    // circles. A person's own zoom/pan is never passed through automatic fit.
    const readableCeiling = Math.min(1.25, 1.12 / textZoom(this.zoomHost.ownerDocument))
    const fitFloor = this.spacious ? Math.min(ZOOM_FIT_MIN, usableWidth / box.w, usableHeight / box.h) : ZOOM_FIT_MIN
    let scale = clamp(Math.min(usableWidth / box.w, usableHeight / box.h, readableCeiling),
      readable && (this._spreadRequested || hostWidth >= 900) ? Math.min(0.8, usableHeight / box.h) : fitFloor, ZOOM_MAX)
    // Include the readable circles and labels when fitting the whole tree.
    if (this.spacious && !readable) {
      for (let pass = 0; pass < 8; pass++) {
        box = this._contentBox(scale)
        const next = Math.min(scale, usableWidth / box.w, usableHeight / box.h)
        if (Math.abs(next - scale) < 0.00001) break
        scale = next
      }
    }
    if (this.smartScope && this.nodeStyle === 'boxes' && this._projection?.folded) {
      const size = this._boxSize()
      // On a very small pane, retain a readable card and let bounded panning
      // reach the rest of this level. A fit must not turn its text into dots.
      scale = Math.max(scale, Math.min(0.72, usableWidth / size.width, usableHeight / size.height))
    }
    /* Read the container's own place in the pane BEFORE the pan changes: the
       measurement subtracts the current pan, so taking it afterwards would be
       subtracting the answer from itself. */
    const origin = this._hostOffset()
    this.zoom = scale
    this.panX = (hostWidth - box.w * scale) / 2 - box.x * scale - origin.x
    this.panY = topPad + (usableHeight - box.h * scale) / 2 - box.y * scale - origin.y
    /* A press-at-a-time zoom may follow a fit all the way back out to where
       the fit left it; stopping it at ZOOM_MIN would make the control lie
       about where the view already is. */
    this._fitFloor = scale
    this._applyZoom()
    return true
  }

  fitCurrentTree() {
    this._cancelZoomMotion()
    this._spreadRequested = false
    this._viewSteered = false
    if (!this.fitToHost()) this.resetZoom()
    if (this._scopeHistory?.length) this._scopeExitZoom = this._fitFloor * 0.7
    this._autoFitted = true
  }

  /* A requested overview centers all drawn nodes at a readable, bounded fit.
     A requested manual zoom remains separate and is never auto-reset. */
  resetToOverview() {
    if (this.windowRootIds) { this.clearRoot(); return }
    if (this.windowRootId) { this.setRoot(this.windowRootId); return }
    this._cancelZoomMotion()
    this._scopeHistory = []
    this._overviewRequested = true
    this._spreadRequested = false
    if (this.rootId) {
      this._viewSteered = true
      this._transitionRoot(null)
    }
    if (!this.fitToHost()) {
      this.resetZoom()
      return
    }
    /* A PRESSED FIT IS A STANDING INSTRUCTION, not a one-off. "Show me
       everything" is answered again when the canvas changes shape, exactly as
       an automatic fit is -- otherwise a person who presses this in landscape
       and then turns the phone upright is left at the sideways scale, 14px
       circles on a 390x844 screen (measured before this line existed). Any
       zoom or pan of their own hands the view back to them. */
    this._viewSteered = false
    this._autoFitted = true
  }

  /* WHERE THE CONTAINER'S OWN ORIGIN SITS INSIDE THE PANE, and it is not
     always (0, 0).
   *
   * The container is `position: absolute; inset: 0`, so on an ordinary canvas
   * its top-left IS the pane's. But _layoutNow may give it a `min-height`
   * larger than the pane, and an over-constrained absolutely positioned box is
   * resolved by the engine rather than by the author: measured 2026-08-28 at
   * 844x390, a 506px container in a 79px pane started 21px ABOVE the pane's
   * top edge. Assuming zero there put the whole comparison out by that amount
   * and made "is anything off the glass" answer yes when it was no and no when
   * it was yes. The transform is `translate(pan) scale(zoom)` about `0 0`, so
   * the painted top-left is the layout position plus the pan, and the layout
   * position is what is left when the pan is taken back off. */
  _hostOffset() {
    const host = this.zoomHost.getBoundingClientRect?.()
    const content = this.container.getBoundingClientRect?.()
    if (!host || !content) return { x: 0, y: 0 }
    const uiZoom = textZoom(this.zoomHost.ownerDocument)
    return { x: (content.left - host.left) / uiZoom - this.panX, y: (content.top - host.top) / uiZoom - this.panY }
  }

  /* Is every drawn circle and every label inside the pane, at a given
     transform? Graph coordinates go through the same `translate then scale`
     the container is painted with, so this answers about pixels on glass
     rather than about the layout's intentions. */
  _contentIsInsideHost(box, { zoom = this.zoom, panX = this.panX, panY = this.panY } = {}) {
    if (!box) return true
    const hostWidth = this.zoomHost.clientWidth || this.W
    const hostHeight = this.zoomHost.clientHeight || this.H
    const origin = this._hostOffset()
    const left = origin.x + box.x * zoom + panX
    const top = origin.y + box.y * zoom + panY
    return left >= -1 && top >= -1
      && left + box.w * zoom <= hostWidth + 1
      && top + box.h * zoom <= hostHeight + 1
  }

  /* CAN ANYTHING ON THIS PAGE SCROLL TO WHAT THE PANE IS CLIPPING?
     The layout's height ask is a request addressed to the page: grow, and let
     the reader scroll. Asked of a page that is pinned -- the phone canvas, or
     any embedder that clips -- it is a request nobody answers, and the part of
     the tree past the fold is simply gone. This is that question, asked of the
     DOM rather than assumed: it names no mode and no width, so it stays true
     wherever this graph is mounted. */
  _overflowIsReachable() {
    const doc = this.zoomHost?.ownerDocument
    const view = doc?.defaultView
    if (!view) return true
    const root = doc.documentElement
    let node = this.zoomHost.parentElement
    while (node && node !== root && node !== doc.body) {
      const overflowY = view.getComputedStyle(node).overflowY
      if (/auto|scroll/.test(overflowY) && node.scrollHeight - node.clientHeight > 2) return true
      /* A CLIPPER ENDS THE WALK. Past an ancestor that is already cutting
         content off, a scroller further up cannot reveal anything: it would
         scroll the clipped box, not its contents. */
      if (/hidden|clip/.test(overflowY) && node.scrollHeight - node.clientHeight > 2) return false
      node = node.parentElement
    }
    /* And the document scrolls unless it has been told not to. IT HAS BEEN
       TOLD NOT TO on a phone -- src/phone-canvas.css pins html and body and
       hides their overflow -- and reading scrollHeight alone missed that:
       a locked page still reports content taller than its box, which read as
       "the reader can scroll to it" for a page that cannot scroll at all.
       Measured: the second rotation into landscape kept 1.00x and left two of
       five agents off the screen, because of exactly this. */
    const locked = [root, doc.body]
      .filter(Boolean)
      .some(element => /hidden|clip/.test(view.getComputedStyle(element).overflowY))
    if (locked) return false
    return Boolean(root) && root.scrollHeight - root.clientHeight > 2
  }

  /* An untouched overview follows its available room, including text-size
     changes. A zoom or pan made by hand is a decision; resize is not
     permission to overrule it. */
  _autoFitToHost() {
    /* "HAS THE PERSON STEERED" IS A FLAG, NOT A READING OF THE TRANSFORM.
       This asked whether the view was still at 1x with no pan, and _clampPan
       makes that question unanswerable: on a 79px pane the clamp pushes a
       pan of zero to -81 to keep content on screen, so a view nobody had
       touched read as steered and the fit stood down. Measured 2026-08-28 --
       the SECOND rotation into landscape kept 1.00x with two of five agents
       off the screen while the first fitted correctly, and this was why. */
    if (this._viewSteered) return
    const box = this._contentBox()
    /* AND ONLY WHERE THE PAGE CANNOT ANSWER FOR ITSELF. A desktop that has
       grown taller than its window scrolls, and the layout's own height ask
       is addressed to exactly that; re-scaling those pages would be this
       routine overruling a cure that works. */
    if (!this.spacious && !this._contentIsInsideHost(box) && this._overflowIsReachable()) return
    if (this.fitToHost({ readable: !!this._spreadRequested && !this.editMode })) this._autoFitted = true
  }

  resize(settled = false) {
    if (this._destroyed) return
    if (this.smartScope && !settled) {
      clearTimeout(this._readabilityResize)
      this._readabilityResize = setTimeout(() => this.resize(true), 120)
      return
    }
    this._syncConversationShelf()
    const width = this.container.clientWidth || this.W
    const height = this.container.clientHeight || this.H
    /* THE PANE'S OWN BOX IS PART OF "HAS ANYTHING CHANGED", and leaving it out
       was a silent stop.
     *
     * The container carries a `min-height` written by _layoutNow whenever the
     * tree needs more room than the pane has, so on a short canvas the
     * container's height is PINNED to that ask -- and this early return then
     * compared two numbers that could not move. Measured 2026-08-28: a phone
     * rotated portrait -> landscape -> portrait -> landscape laid out once and
     * then ignored every later rotation, because container.clientHeight read
     * 480 each time while the pane it is drawn in went 321 -> 72 -> 321 -> 72.
     * Two of five agents stayed off the screen and no layout ran to notice. */
    const hostWidth = this.zoomHost.clientWidth
    const hostHeight = this.zoomHost.clientHeight
    if (width === this.W && height === this.H && hostWidth === this._hostW && hostHeight === this._hostH) {
      this._placeChips()
      return
    }
    this._hostW = hostWidth
    this._hostH = hostHeight
    this.W = width
    this.H = height
    const budget = this._detailLimit()
    if (this.smartScope || this._detailBudget !== budget) {
      this._detailBudget = budget
      this._reconcile()
      return
    }
    this._clampPan()
    this._applyZoom()
    this._layoutNow()
  }

  destroy() {
    this._nodeDrag?.cancel()
    if (this._panState) this._onPanEnd({ pointerId: this._panState.id })
    this._dropRec?.el.classList.remove('drop-ok')
    this._dropRec = this._dropRaw = null
    this._cancelZoomMotion()
    this._stopDragAutoPan()
    clearTimeout(this._readabilityResize)
    clearTimeout(this._linkStatusTimer)
    this.treeWindows?.destroy()
    this.workspace?.destroy()
    if (!this.chatOwner) this.setWide(false)
    this._destroyed = true
    window.removeEventListener(TREE_CONTEXT_CARDS_EVENT, this._onContextCardsChange)
    window.removeEventListener('storage', this._onContextCardsChange)
    this.ro.disconnect()
    this.previewFitter.destroy()
    this._shelfResizeDispose?.()
    this.chatShelf?.ownerDocument.removeEventListener('pointerdown', this._onChatPickerOutside)
    this.zoomHost.ownerDocument.removeEventListener('pointerdown', this._onMoreOutside)
    this.chatShelf?.remove()
    this.workspaceControls?.remove()
    this.panHint?.remove()
    this.linkStatus?.remove()
    this.linkPopover?.remove()
    this.chatDrafts?.clear()
    if (this._animationRaf) cancelAnimationFrame(this._animationRaf)
    for (const raf of this._addRafs) cancelAnimationFrame(raf)
    for (const timer of this._removeTimers) clearTimeout(timer)
    for (const timer of this._chatTimers) clearTimeout(timer)
    for (const record of this.nodes.values()) {
      this._disposeChat(record)
      record.runtimeUnsub?.()
      record.chipRuntimeUnsub?.()
      clearTimeout(record.clickTimer)
    }
    for (const slot of this.emptySlots.values()) slot.el.remove()
    this.emptySlots.clear()
    this.unsubs.forEach(unsub => unsub())
    document.removeEventListener('keydown', this._onDocumentKeydown)
    this.zoomHost.removeEventListener('wheel', this._onWheel)
    this.zoomHost.removeEventListener('keydown', this._onHostKeydown)
    this.zoomerEl?.removeEventListener('keydown', this._onHostKeydown)
    this.zoomHost.removeEventListener('pointerdown', this._onPanDown)
    this.zoomHost.removeEventListener('pointermove', this._onPanMove)
    this.zoomHost.removeEventListener('pointerup', this._onPanEnd)
    this.zoomHost.removeEventListener('pointercancel', this._onPanEnd)
    this.zoomHost.removeEventListener('lostpointercapture', this._onPanEnd)
    this.zoomHost.classList.remove('graph-zoom-host', 'static-tree-host', 'panning', 'zoomed', 'is-linking')
    this.zoomerEl?.remove()
    this.screenOverlay?.remove()
    this.container.innerHTML = ''
    this.container.removeAttribute('data-layout')
    this.container.removeAttribute('data-edit-mode')
    this.container.classList.remove('graph-canvas', 'static-tree-graph', 'zoomable')
    if (probeOwner === this) {
      probeOwner = null
      window.__graphFrameMs = window.__pageFrameMs = window.__graphTickMs = window.__graphNodeCount = undefined
      window.__graphStress = undefined
    }
  }
}
