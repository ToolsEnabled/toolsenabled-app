/* THE PHONE CANVAS — ONE NAMED MODE, AND THE LOCK AROUND MACHINERY THAT
   ALREADY EXISTS.
 *
 * The owner's design, verbatim: "on mobile with non downloaded version - the
 * trick is to keep the zoom static, force them to use the + and - then strip
 * the page of everything but computer selection and the tree, then if they
 * scroll, force no scroll on the page no matter what it is forced to render in
 * the screen size; and then they can drag any direction to see the rest of the
 * tree, manually hit the zoom in/out button; see all the same stuff as on the
 * software; and then if they press a bubble or a chat; we do it as a sort of on
 * screen pop up." And his hard constraint, verbatim: "we cannot let mobile
 * development change the main app or the normal site".
 *
 * SO THE CONSTRAINT COMES FIRST, AND IT IS THE SHAPE OF THIS FILE.
 *
 * Nothing here reads a width in a stylesheet. There is exactly one switch —
 * the `data-phone-canvas="on"` attribute on <html> — it is written in exactly
 * one function in this file, and every rule in src/phone-canvas.css names it.
 * A browser that never gets the attribute cannot reach one declaration of the
 * phone dress, whatever its window is doing. That is the mechanism, and
 * tools/test/phone-canvas.test.mjs holds both halves of it: every selector in
 * the sheet carries the attribute, and no desktop environment can turn it on.
 *
 * AND IT IS A MODE RATHER THAN A FORK, because the owner said what comes next:
 * "We might actually be able to copy this to the mobile app as an optional 2nd
 * view style." So the decision is a pure function of a small environment
 * record, and the first thing that record carries is a stored choice —
 * `mc.phoneCanvas`, 'auto' | 'on' | 'off'. Nothing writes it today; a settings
 * control that does is one line, and it will not need this file changed.
 *
 * WHAT IS REUSED RATHER THAN REBUILT. The graph already pans by pointer drag
 * (_onPanDown in src/tree-graph.js), already zooms, and already renders the
 * +/1.00x/- cluster and wires all three of its buttons. The rail already holds
 * every fact about the fleet and about one agent. None of that is
 * re-implemented here: the phone canvas locks the page around it and MOVES the
 * rail into a sheet — the same element, built by the same code, carrying the
 * same numbers. A phone-only data shape is the one thing this file must never
 * create.
 */

import { textZoom } from './text-size.js'

export const PHONE_CANVAS_ATTR = 'data-phone-canvas'

/* THE SHAPE THE PHONE IS BEING HELD IN, AND WHY IT IS AN ATTRIBUTE.
 *
 * src/phone-canvas.css may not contain a media query — a width must never be
 * able to reach the phone dress, and tools/test/phone-canvas.test.mjs fails on
 * any at-rule in that sheet. But a phone held sideways is a genuinely different
 * canvas from one held upright, and pretending otherwise is what shipped: the
 * bar's three stacked full-width rows are a 390px PORTRAIT decision, and at
 * 750x342 they took 151 of the graph pane's 152 pixels. Measured 2026-08-28 on
 * the served build, both engines: `.graph-canvas-slot` came out 0px tall and
 * every one of the five agents was laid out 200-390px below the screen, with
 * no page scroll, no pan and no zoom able to reach them.
 *
 * So the shape is a FACT ABOUT THE DEVICE, decided by the same function that
 * decides the mode, written by the same one writer, and read by CSS as an
 * attribute rather than as a width. A desktop never gets it, because a desktop
 * never gets the mode. */
export const PHONE_SHAPE_ATTR = 'data-phone-shape'
export const PHONE_SHAPE_PORTRAIT = 'portrait'
export const PHONE_SHAPE_LANDSCAPE = 'landscape'

/* The stored choice, in the app's own settings namespace. 'auto' is the
   shipped value and is what every reader gets until somebody chooses. */
export const PHONE_CANVAS_SETTING = 'mc.phoneCanvas'
export const PHONE_CANVAS_CHOICES = ['auto', 'on', 'off']
export const PHONE_CANVAS_DEFAULT_CHOICE = 'auto'
export const PHONE_CANVAS_COULD_NOT_TELL = 'PHONE_CANVAS_COULD_NOT_TELL'

function couldNotTell(subject, cause) {
  const error = new Error(
    `Phone canvas could not determine ${subject}; this does not claim that it is absent or false.`,
    { cause },
  )
  error.code = PHONE_CANVAS_COULD_NOT_TELL
  return error
}

/**
 * Mobile browsers use the phone canvas by default. The ledger chooses rows
 * within that canvas, and its saved off choice keeps the optional graph.
 * Explicit canvas choices and the ledger entry link remain available on any
 * device; installed desktop windows and mouse/hover browsers retain their view.
 */
export function phoneCanvasDecision(environment = {}) {
  const choice = PHONE_CANVAS_CHOICES.includes(environment.choice)
    ? environment.choice
    : PHONE_CANVAS_DEFAULT_CHOICE
  if (choice === 'off') return false
  if (choice === 'on' || environment.ledgerRoute) return true
  if (environment.desktopRoute) return false
  if (environment.installed || environment.coarsePointer !== true || environment.canHover !== false) return false
  const width = Number(environment.width)
  const height = Number(environment.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  return width <= height ? width <= 820 : height <= 520
}

/**
 * WHICH WAY THE PHONE IS BEING HELD, as arithmetic, from the same record.
 *
 * Wider than it is tall is landscape and nothing else is. Equal sides are
 * portrait: a square canvas has the portrait problem (no width to spread into)
 * and none of the landscape one. A record with no usable numbers answers
 * portrait, because portrait is the dress that already shipped and an unknown
 * device must not be moved onto an untested one.
 */
export function phoneShape(environment = {}) {
  const width = Number(environment.width)
  const height = Number(environment.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return PHONE_SHAPE_PORTRAIT
  }
  return width > height ? PHONE_SHAPE_LANDSCAPE : PHONE_SHAPE_PORTRAIT
}

/** A missing key means the choice is absent; a failed read does not. */
export function readPhoneCanvasChoice(win = globalThis.window) {
  try {
    const stored = win?.localStorage?.getItem(PHONE_CANVAS_SETTING)
    return PHONE_CANVAS_CHOICES.includes(stored) ? stored : PHONE_CANVAS_DEFAULT_CHOICE
  } catch (cause) {
    throw couldNotTell('the stored choice', cause)
  }
}

/** Convert client rectangles to painted pixels in engines with different CSS-zoom coordinates. */
function screenPixelScale(win) {
  const body = win?.document?.body
  if (!body || typeof body.getBoundingClientRect !== 'function' || typeof win.getComputedStyle !== 'function') return 1
  const cssWidth = Number.parseFloat(win.getComputedStyle(body).width)
  const measuredWidth = body.getBoundingClientRect().width
  return cssWidth > 0 && measuredWidth > 0 ? textZoom(win.document) * cssWidth / measuredWidth : 1
}

/** Measure the app slot after seeding its fixed body from the live viewport.
 * The stage still applies the host's constraints; it cannot report yesterday's
 * portrait height back to the resize listener. Restore both temporary values
 * even when layout fails. The separate body height preserves Text size zoom. */
function stageBox(win) {
  const doc = win?.document
  const stage = typeof doc?.getElementById === 'function' ? doc.getElementById('stage') : null
  const active = phoneCanvasOn(doc)
  const style = active ? doc?.documentElement?.style : null
  const viewportHeight = Number(win?.visualViewport?.height ?? win?.innerHeight ?? 0)
  const measureLive = style && viewportHeight > 0
  const pinned = ['--phone-canvas-h', '--phone-canvas-body-h', '--phone-canvas-body-top'].map(name => [name, style?.getPropertyValue?.(name)])
  if (measureLive) {
    style.setProperty('--phone-canvas-h', viewportHeight + 'px')
    style.setProperty('--phone-canvas-body-h', viewportHeight / textZoom(doc) + 'px')
    style.setProperty('--phone-canvas-body-top', Math.max(0, Number(win?.visualViewport?.offsetTop || 0)) / textZoom(doc) + 'px')
  }
  let rect
  let scale = 1
  try {
    rect = typeof stage?.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null
    scale = screenPixelScale(win)
  } finally {
    if (measureLive) for (const [name, value] of pinned) {
      if (value) style.setProperty(name, value)
      else style.removeProperty(name)
    }
  }
  if (rect && rect.width > 0 && rect.height > 0) {
    const box = { width: rect.width * scale, height: rect.height * scale, source: 'stage' }
    if (active) {
      const viewport = win?.visualViewport
      const width = Number(viewport?.width ?? win?.innerWidth ?? 0)
      const height = Number(viewport?.height ?? win?.innerHeight ?? 0)
      const left = Math.max(0, Number(rect.left || 0) * scale - Number(viewport?.offsetLeft || 0))
      const top = Math.max(0, Number(rect.top || 0) * scale - Number(viewport?.offsetTop || 0))
      if (width > left) box.width = Math.min(box.width, width - left)
      if (height > top) box.height = Math.min(box.height, height - top)
    }
    return box
  }
  return {
    width: Number(win?.visualViewport?.width ?? win?.innerWidth ?? 0),
    height: Number(win?.visualViewport?.height ?? win?.innerHeight ?? 0),
    source: 'window',
  }
}

/** Read the device record without changing its stored choice or active mode. */
export function readPhoneCanvasEnvironment(win = globalThis.window) {
  const ask = (query) => {
    try {
      return Boolean(win?.matchMedia?.(query)?.matches)
    } catch (cause) {
      throw couldNotTell(`whether ${query} matches`, cause)
    }
  }
  const box = stageBox(win)
  return {
    choice: readPhoneCanvasChoice(win),
    installed: Boolean(win?.mcPrefs),
    desktopRoute: Boolean(win?.location?.search && /[?&]desktop=1\b/.test(win.location.search)),
    coarsePointer: ask('(pointer: coarse)'),
    canHover: ask('(hover: hover)'),
    width: Number(box.width),
    height: Number(box.height),
    /* THE LEDGER LINK'S OWN SIGNAL, read the same way src/phone-ledger.js's
       adoptLedgerEntryFlag() reads it -- location.search, the same param the
       mobile page's own /app/?ledger=1 link carries. A query read, never a
       write: nothing here stores anything, so a person who leaves and comes
       back without the param is read fresh, honestly, next time. */
    ledgerRoute: Boolean(win?.location?.search && /[?&]ledger=1\b/.test(win.location.search)),
  }
}

/** Is the mode on right now? The single reader of the single switch. */
export function phoneCanvasOn(doc = globalThis.document) {
  return doc?.documentElement?.getAttribute(PHONE_CANVAS_ATTR) === 'on'
}

let gestureLocksInstalled = false

/**
 * THE GESTURE LOCK, AND WHY IT IS NOT ONE THING.
 *
 * VERIFIED rather than recited; the sources and the dates are in the pass
 * report that accompanies this file.
 *
 *  - `user-scalable=no` and `maximum-scale` in the viewport meta are ignored by
 *    iOS Safari. WebKit bug 186970 asked for them back and was closed RESOLVED
 *    INVALID on 2022-02-12; the WebKit engineer's answer on it names
 *    `touch-action` as the supported route from iOS 13. So the declarative
 *    route does not exist, and index.html is deliberately NOT touched.
 *  - `touch-action` is therefore the primary lock, and it is applied at the
 *    ROOT in src/phone-canvas.css. Pinch-zoom is implemented by the viewport,
 *    so the browser intersects touch-action all the way up to the root, where
 *    the mode's `pan-y` excludes `pinch-zoom`. Scrolling inside the sheet is
 *    implemented by the sheet, so that walk stops at the sheet's own scroller
 *    and the sheet still scrolls.
 *  - Double-tap-to-zoom is excluded by that same value: it is a non-standard
 *    gesture that only `auto` permits. WebKit implemented that for iOS in bug
 *    149854, RESOLVED FIXED (landed r191452, confirmed on iOS 9.3), so it is
 *    honoured on every iOS this product can meet.
 *  - THE BELT, for engines older than the touch-action route and for anything
 *    that disagrees: Safari's own proprietary gesturestart / gesturechange /
 *    gestureend, which are the events that carry a pinch in WebKit and which
 *    zoom the page unless they are cancelled. They are non-standard and exist
 *    nowhere else, so binding them costs other browsers nothing.
 *    `{ passive: false }` is not optional — a passive listener cannot cancel,
 *    and browsers default the touch family to passive.
 *  - A second belt for the same older engines: a touchmove carrying more than
 *    one finger is a pinch, and is cancelled.
 *
 * WHAT IS DELIBERATELY NOT DONE: no touchend double-tap timer. Cancelling a
 * touchend suppresses the click the browser would have synthesised, and this
 * graph gives a double press its own meaning — a node's dblclick opens its
 * conversation. Buying double-tap-zoom prevention we already have from
 * touch-action, at the price of one of the product's own gestures, is a bad
 * trade.
 *
 * Every listener re-asks whether the mode is on before it cancels anything, so
 * a device that leaves the mode stops being locked in the same frame.
 */
function installGestureLocks(win) {
  if (gestureLocksInstalled || !win?.addEventListener) return
  gestureLocksInstalled = true
  const refuse = (event) => {
    if (!phoneCanvasOn(win.document)) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
  }
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    win.addEventListener(name, refuse, { passive: false })
  }
  win.addEventListener('touchmove', (event) => {
    if (event.touches && event.touches.length > 1) refuse(event)
  }, { passive: false })
}

/** Measure the content slot, but size the body from the entire visual viewport. */
function measureBox(win) {
  const root = win?.document?.documentElement
  if (!root) return
  const box = stageBox(win)
  // The stage excludes the reserved voice row. It sizes content, never the body.
  const height = Number(win?.visualViewport?.height ?? win?.innerHeight ?? box.height)
  const width = Math.round(Number(box.width))
  if (height > 0) {
    /* Keep the measured height in painted/window pixels for consumers that
       already divide it by --zoom, and separately give the zoomed body the
       CSS-pixel height it needs to paint to that same edge. Using one variable
       for both jobs made 390px paint as 437px at Large and 351px at Small.
       Both values come from the visual viewport, so the voice row cannot be
       subtracted a second time when the content slot is measured. The offset
       follows the viewport pan performed when a phone keyboard opens. */
    root.style.setProperty('--phone-canvas-h', `${height}px`)
    root.style.setProperty('--phone-canvas-body-h', `${height / textZoom(win.document)}px`)
    root.style.setProperty('--phone-canvas-body-top', `${Math.max(0, Number(win?.visualViewport?.offsetTop || 0)) / textZoom(win.document)}px`)
  }
  if (width > 0) root.style.setProperty('--phone-canvas-w', `${width}px`)
  return box
}

/** Start the mode and track rotation, viewport changes, and text size.
 * Mobile browsers and explicit entry routes need these listeners so their
 * canvas dimensions and portrait/landscape layout remain current.
 */
export function startPhoneCanvas({ win = globalThis.window } = {}) {
  const root = win?.document?.documentElement
  if (!root) return false

  let textScaleObserver = null
  let focusFrame = null
  const revealKeyboardField = () => {
    if (focusFrame !== null) win.cancelAnimationFrame?.(focusFrame)
    focusFrame = win.requestAnimationFrame?.(() => {
      focusFrame = null
      if (root.getAttribute(PHONE_CANVAS_ATTR) !== 'on') return
      const viewport = win.visualViewport
      if (!viewport || win.innerHeight - viewport.height < 80) return
      const field = win.document.activeElement
      const stage = win.document.getElementById('stage')
      if (!field?.matches?.('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]')
          || !stage?.contains(field)) return
      const rect = field.getBoundingClientRect()
      const slot = stage.getBoundingClientRect()
      const bottom = Math.min(slot.bottom, viewport.offsetTop + viewport.height)
      // The browser focuses before the keyboard shrinks the stage. Reveal
      // the complete field in its existing scroller after the fitted layout
      // settles; do not move focus or restart the user's active call.
      if (rect.bottom > bottom && rect.height < slot.height) {
        field.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }) ?? null
  }
  const apply = () => {
    const environment = readPhoneCanvasEnvironment(win)
    const on = phoneCanvasDecision(environment)
    if (on) {
      root.setAttribute(PHONE_CANVAS_ATTR, 'on')
      /* The shape rides with the mode and is rewritten on the same events, so
         a rotation moves it in the same frame the height is remeasured. */
      const box = measureBox(win)
      root.setAttribute(PHONE_SHAPE_ATTR, phoneShape(box || environment))
      installGestureLocks(win)
      revealKeyboardField()
      // Text size can change without a viewport event. Observe its existing
      // writer on body, while geometry writes only to the root.
      if (!textScaleObserver && win.MutationObserver && win.document.body) {
        textScaleObserver = new win.MutationObserver(() => { apply() })
        textScaleObserver.observe(win.document.body, { attributes: true, attributeFilter: ['style'] })
      }
      return true
    }
    if (root.getAttribute(PHONE_CANVAS_ATTR) === 'on') {
      root.removeAttribute(PHONE_CANVAS_ATTR)
      root.removeAttribute(PHONE_SHAPE_ATTR)
      root.style.removeProperty('--phone-canvas-h')
      root.style.removeProperty('--phone-canvas-body-h')
      root.style.removeProperty('--phone-canvas-body-top')
      root.style.removeProperty('--phone-canvas-w')
      textScaleObserver?.disconnect()
      textScaleObserver = null
    }
    return false
  }

  const environment = readPhoneCanvasEnvironment(win)
  const followable = environment.ledgerRoute
    || (environment.coarsePointer && !environment.canHover)
    || environment.choice !== PHONE_CANVAS_DEFAULT_CHOICE
  if (followable) {
    const refresh = () => { apply() }
    win.addEventListener?.('resize', refresh)
    win.addEventListener?.('orientationchange', refresh)
    win.visualViewport?.addEventListener?.('resize', refresh)
    win.visualViewport?.addEventListener?.('scroll', refresh)
  }
  return apply()
}

/* ------------------------------------------------------------------
   THE SHEET
   ------------------------------------------------------------------ */

/**
 * WHAT MOVES, AND WHY MOVING BEATS HIDING.
 *
 * The owner: "the functionality must remain isomorphic". The safest way to keep
 * a phone's facts identical to the desktop's is to refuse to author them twice.
 * So the rail is not hidden and re-drawn small — the actual `aside.rail` is
 * MOVED into the sheet, with its pages, its numbers, its listeners and its own
 * scroller intact, and the graph's three named tool buttons are moved with it.
 * Every style those carry is written `.computers .something`, and the sheet
 * lives inside `.computers`, so they keep their dress as well as their code.
 *
 * Each entry is a promise this module keeps and the test checks: what leaves
 * the phone's first screen, and the door it leaves through.
 */
export const PHONE_RELOCATED = [
  {
    what: '.rail-title-slot-title',
    desktop: 'the selected agent panel label above Chat and Details',
    phone: 'the selected agent identity and example marking in the sheet header',
    how: 'only the duplicate label is withheld; Back, forward navigation and both panel tabs stay available',
  },
  {
    what: '.tree-rail-close',
    desktop: 'close the fixed side panel',
    phone: 'Close details in the sheet header',
    how: 'the sheet close owns dismissal and restores focus to the agent row',
  },
  ...['.tree-display-controls', '.tree-active-zoom', '.tree-workspace-controls', '.tree-window-add', '.tree-window-header'].map(what => ({
    what,
    desktop: 'graph canvas appearance, navigation and editing controls',
    phone: 'Quick settings → Show the tree as → Graph; rows keep their own search, branches and size controls',
    how: 'unchanged graph controls are withheld only in row mode and return when Graph is selected',
  })),
  {
    what: '.rail',
    desktop: 'a column beside the tree, always on screen',
    phone: 'the body of the details sheet, opened by the Details control and by pressing a bubble',
    how: 'the element itself is moved, never copied and never re-rendered',
  },
  {
    what: '.graph-tool-set',
    desktop: 'a group of chips in the graph bar: Reset positions, Edit, Open agent detail',
    phone: 'the same three buttons, at the top of the details sheet',
    how: 'the element itself is moved, never copied and never re-rendered',
  },
]

const SHEET_OPEN_LABEL = 'Details'
const SHEET_TITLE = 'Details'
const REAL_SOURCE = () => false
const SHEET_CLOSE_LABEL = 'Close details'

/* HOW LONG THE SHEET TAKES TO GO BACK DOWN, and why a number lives in the
 * module at all.
 *
 * The rise used to be a keyframe: `animation: phone-sheet-rise`, translateY of
 * one spacing step, played once on the frame the element stopped being
 * `hidden`. Two things were wrong with it and the owner named both — "the chat
 * surface needs to pull up super clean and easy". A 24px nudge is not a pull-up;
 * measured 120ms after a real touch tap on the served build (2026-08-28), the
 * card was already fully in place and fully opaque. And an animation cannot run
 * on the way out, because `hidden` removes the element in the same frame — so
 * the sheet rose (a little) and then vanished (instantly), which is the grammar
 * of a popup, not of a sheet.
 *
 * It is a transition now, driven by a class, so it plays in BOTH directions;
 * the only thing script still has to know is when the fall is over, because
 * `hidden` — the state screen readers and the tab ring read — must not land
 * until the card is off the glass. The value matches the transition in
 * src/phone-canvas.css and is deliberately a touch longer than it, so a slow
 * frame cannot cut the last few pixels off.
 *
 * A person who asked for reduced motion has no transition to wait for
 * (src/phone-ledger.css), and waiting anyway costs them nothing: the card is
 * already down, and the only thing the delay defers is the `hidden` attribute.
 */
const SHEET_FALL_MS = 460

/**
 * Mount the phone canvas onto a computers view. Returns null — and touches
 * nothing — unless the mode is on, which is what makes the two lines this adds
 * to src/views/computers.js unreachable on a desktop.
 *
 * The sheet is `position: absolute` INSIDE the page box, not fixed to the
 * document and not a browser dialog: it cannot scroll the page behind it,
 * because in this mode the page behind it cannot scroll at all.
 */
export function mountPhoneCanvas({ root, doc = globalThis.document, isExample = REAL_SOURCE } = {}) {
  if (!root || !phoneCanvasOn(doc)) return null

  const rail = root.querySelector('.rail')
  const toolSet = root.querySelector('.graph-tool-set')
  const tools = root.querySelector('.graph-tools')
  const body = root.querySelector('.comp-body')
  const tabs = root.querySelector('.tabs')
  if (!rail) return null

  const make = (tag, className) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    return node
  }

  const sheet = make('div', 'phone-sheet')
  sheet.hidden = true
  const scrim = make('button', 'phone-sheet-scrim')
  scrim.type = 'button'
  scrim.setAttribute('aria-label', SHEET_CLOSE_LABEL)
  scrim.tabIndex = -1
  const card = make('section', 'phone-sheet-card')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', SHEET_TITLE)
  /* THE GRAB BAR IS THE GRAMMAR EVERY PHONE ALREADY TAUGHT. It says "this came
     up from the bottom and it goes back down" before anything is read, and it
     is the one piece of this sheet that carries no fact — so it is decoration
     and it is marked as such rather than announced. */
  const grab = make('div', 'phone-sheet-grab')
  grab.setAttribute('aria-hidden', 'true')
  const head = make('div', 'phone-sheet-head')
  const title = make('span', 'phone-sheet-title')
  title.textContent = SHEET_TITLE
  const heading = make('div', 'phone-sheet-heading')
  const example = make('span', 'phone-sheet-example')
  example.textContent = 'Example, not your data'
  example.hidden = true
  /* THE HEAD NAMES WHAT WAS PRESSED, when something was.
     The word "Details" over a conversation is a container talking about itself.
     The rail below already knows the agent, but it says so four rows down —
     past a Back link, a caps title and a Chat/Details segment — so on a 664px
     phone the first thing under the sheet's own head was chrome. These nodes
     are filled by setSubject from the ledger row that was pressed: the same
     records, the same role hue, and the clock handed over as a binding so the
     head ticks on the one runtime clock rather than a second copy of it. */
  const subject = make('div', 'phone-sheet-subject')
  subject.hidden = true
  const subjectBar = make('span', 'phone-sheet-rolebar')
  const subjectWho = make('span', 'phone-sheet-who')
  const subjectName = make('span', 'phone-sheet-name')
  const subjectLine = make('span', 'phone-sheet-line')
  subjectWho.append(subjectName, subjectLine)
  const vitals = make('span', 'phone-sheet-vitals')
  const subjectRun = make('span', 'phone-sheet-run')
  const subjectState = make('span', 'phone-sheet-state')
  vitals.append(subjectRun, subjectState)
  subject.append(subjectBar, subjectWho, vitals)
  const close = make('button', 'phone-sheet-close')
  close.type = 'button'
  close.setAttribute('aria-label', SHEET_CLOSE_LABEL)
  close.textContent = '×'
  const sheetBody = make('div', 'phone-sheet-body')
  const actions = make('details', 'phone-sheet-actions')
  const actionsSummary = make('summary', 'phone-sheet-actions-summary')
  actionsSummary.textContent = 'Actions'
  const toolSlot = make('div', 'phone-sheet-tools')
  actions.append(actionsSummary, toolSlot)
  heading.append(title, subject, example)
  head.append(heading, actions, close)
  toolSlot.addEventListener('click', event => {
    if (event.target.closest?.('button:not(:disabled)')) actions.open = false
  })
  card.append(grab, head, sheetBody)
  sheet.append(scrim, card)
  root.append(sheet)

  /* The one clock binding the head holds, released before the next is taken so
     a sheet reopened on twenty agents never leaves twenty tickers behind. */
  let subjectUnbind = null
  let subjectLabel = SHEET_TITLE
  const syncSource = () => {
    const sample = isExample() === true
    example.hidden = !sample
    subjectLine.hidden = sample
    const host = subject.hidden ? heading : subjectWho
    if (example.parentNode !== host) host.append(example)
    card.setAttribute('aria-label', sample ? `${subjectLabel} — Example, not your data` : subjectLabel)
  }
  let subjectId = null
  const setSubject = (next) => {
    subjectUnbind?.()
    subjectUnbind = null
    subjectId = next && next.id != null ? next.id : null
    if (!next) {
      subjectName.textContent = ''
      subjectLine.textContent = ''
      subjectRun.textContent = ''
      subjectState.textContent = ''
      subjectBar.style.background = ''
      subject.hidden = true
      title.hidden = false
      subjectLabel = SHEET_TITLE
      syncSource()
      return
    }
    subjectName.textContent = String(next.name || '')
    subjectLine.textContent = String(next.lineage || '')
    subjectBar.style.background = String(next.roleHex || '')
    subjectRun.textContent = String(next.runtimeText || '')
    subjectRun.dataset.live = next.live ? 'true' : 'false'
    subjectState.textContent = String(next.statusWord || '')
    subjectState.dataset.mark = String(next.mark || 'off')
    subject.hidden = false
    /* One name in the head, not two: the container's own word steps aside for
       the agent's, and comes back when there is no agent. */
    title.hidden = true
    subjectLabel = `${next.name || SHEET_TITLE} — ${SHEET_TITLE}`
    syncSource()
    if (typeof next.bindRun === 'function') subjectUnbind = next.bindRun(subjectRun)
  }
  /* THE HEAD FOLLOWS THE AGENT IT IS ABOUT. It was filled once, from the row
     that was pressed, so an agent that finished, failed or stopped while its
     sheet was up still read "running" over a chat saying otherwise. The ledger
     hands every rebuilt row here; only the agent the head is about, and only a
     change, repaints it. */
  const refreshSubject = (next) => {
    if (!next || next.id == null || next.id !== subjectId || subject.hidden) return
    const same = subjectState.textContent === String(next.statusWord || '')
      && subjectState.dataset.mark === String(next.mark || 'off')
      && subjectRun.dataset.live === (next.live ? 'true' : 'false')
      && (next.live || subjectRun.textContent === String(next.runtimeText || ''))
    if (!same) setSubject(next)
  }

  /* THE MOVE. Same nodes, same handlers, same numbers. */
  if (toolSet) toolSlot.append(toolSet)
  else actions.remove()
  sheetBody.append(rail)

  /* The one control that opens it, parked beside the zoom cluster the owner
     asked people to use, so the live controls on the tree are together. */
  const opener = make('button', 'phone-sheet-open')
  opener.type = 'button'
  opener.textContent = SHEET_OPEN_LABEL
  opener.setAttribute('aria-expanded', 'false')
  if (tools) tools.append(opener)
  else root.prepend(opener)

  /* THE ACCOUNTS MENU IS BEHIND THE SHEET TOO. It is the tab strip's sibling
     in the page's first row (src/views/computers.js .comp-topbar), and a list
     that named only `.tabs` assumed the strip was the whole row -- so the
     chip stayed tabbable under an aria-modal dialog and could open a second
     panel beneath it. */
  const accounts = root.querySelector('.comp-accounts')
  const topbar = doc.querySelector?.('.topbar')
  const skipLink = doc.querySelector?.('.skip-link')
  const behind = [body, tabs, accounts, topbar, skipLink].filter(Boolean)
  let open = false
  let restoreFocus = null
  const win = doc.defaultView || globalThis
  let fallTimer = 0
  let sheetFrame = null
  const frame = (run) => {
    if (typeof win.requestAnimationFrame === 'function') sheetFrame = win.requestAnimationFrame(() => { sheetFrame = null; run() })
    else run()
  }

  const setOpen = (next) => {
    syncSource()
    if (next === open) return
    /* READ BEFORE INERT. The thing that opened this sheet is usually the bubble
       that was just pressed, and the bubble is inside the part of the page the
       next two lines make inert — which blurs it. Ask where focus was while it
       is still somewhere. */
    if (next) restoreFocus = doc.activeElement
    open = next
    /* THE RISE AND THE FALL, EITHER SIDE OF `hidden`.
       Going up: stop being hidden FIRST, then take the class on the next frame,
       so the browser has a start position to move from — set in the same frame
       and there is no transition, only a jump. Coming down: drop the class now
       and defer `hidden` until the card has left the glass, because `hidden`
       ends the transition by removing the box. `pointer-events` is off while
       the class is absent (src/phone-canvas.css), so a falling sheet cannot
       swallow the next press. */
    win.clearTimeout?.(fallTimer)
    if (open) {
      sheet.hidden = false
      frame(() => { if (open) sheet.classList.add('is-up') })
    } else {
      sheet.classList.remove('is-up')
      fallTimer = win.setTimeout?.(() => { if (!open) sheet.hidden = true }, SHEET_FALL_MS)
    }
    opener.setAttribute('aria-expanded', open ? 'true' : 'false')
    /* The page behind a modal has to leave the tab ring as well as the screen;
       this is the same treatment src/main.js gives the quick-settings drawer,
       for the same WCAG reason. The rail is not in this list because the rail
       is no longer behind the sheet — it is inside it. */
    for (const node of behind) {
      if (open) node.setAttribute('inert', '')
      else node.removeAttribute('inert')
    }
    if (open) {
      close.focus?.()
    } else {
      const back = restoreFocus && root.contains(restoreFocus) ? restoreFocus : opener
      restoreFocus = null
      back?.focus?.()
    }
  }

  const onKeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key !== 'Tab') return
    // The dialog owns focus until it closes, including with a phone keyboard.
    // Inert prevents landing on the page; wrapping prevents leaving it for
    // browser chrome after the last control.
    const stops = [...card.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
      .filter(node => !node.hasAttribute('disabled') && node.tabIndex !== -1 && node.offsetParent !== null && !node.closest?.('[inert]'))
    if (!stops.length) return
    const first = stops[0], last = stops[stops.length - 1]
    const outside = !card.contains(doc.activeElement)
    if (event.shiftKey && (doc.activeElement === first || outside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (doc.activeElement === last || outside)) {
      event.preventDefault()
      first.focus()
    }
  }

  /* The Details door is about the machine, not about any one agent, so it
     clears whatever the last press put in the head. */
  opener.addEventListener('click', () => { opener.focus?.(); setSubject(null); setOpen(true) })
  close.addEventListener('click', () => setOpen(false))
  scrim.addEventListener('click', () => setOpen(false))
  doc.addEventListener('keydown', onKeydown)

  return {
    /* Called from activateRail. A press on a bubble puts the rail on its
       controls page and a press on an empty slot puts it on the compose page;
       both are the moment the answer arrives, so both raise the sheet. Going
       back to the overview does NOT close it — the overview is a page a person
       reads, and closing the sheet under them would be the product deciding
       they were finished. */
    onRailPage(page) {
      if (page === 'controls') {
        const active = rail.querySelector('.ctl-page')
        const tabs = active?.querySelector('.rail-tabs')
        const nav = active?.querySelector('.rail-title-row')
        if (tabs && nav && !active.querySelector('.phone-agent-nav')) {
          const row = make('div', 'phone-agent-nav')
          active.prepend(row)
          row.append(nav, tabs)
        }
        const chat = active?.querySelector('.chat-cannot-send')
        const refusal = chat?.querySelector('.chat-nosend')
        const composer = chat?.querySelector('.chat-input')
        if (refusal && composer && !chat.querySelector('.phone-chat-footer')) {
          // Preserve the shared composer, including its Changes panel, chips,
          // controls and styling. Moving only the input tears it out of the
          // desktop component and leaves an empty composer surface above it.
          const composerSurface = composer.closest('.chat-composer-dock') || composer
          const footer = make('div', 'phone-chat-footer')
          chat.append(footer)
          footer.append(refusal, composerSurface)
        }
      }
      if (page === 'controls' || page === 'compose') setOpen(true)
      if (page === 'controls') {
        // The shared composer can be taller than the chat's remaining space.
        // Reveal it on entry through the existing rail scroller; keep the
        // complete footer and its explanation in their natural document flow.
        const active = rail.querySelector('.ctl-page')
        const composer = active?.querySelector('.chat-composer-dock') || active?.querySelector('.chat-input')
        const viewport = active?.getBoundingClientRect?.()
        const target = composer?.getBoundingClientRect?.()
        if (viewport?.height > 0 && target?.height > 0 && active.offsetHeight > 0) {
          const scale = viewport.height / active.offsetHeight
          const bottom = viewport.top + (active.clientTop + active.clientHeight) * scale
          if (target.bottom > bottom) active.scrollTop += (target.bottom - bottom) / scale
        }
      }
    },
    /* Called by src/phone-ledger.js with the row that was pressed, before the
       press reaches this view's own selection path — so the sheet is already
       about the right agent on the frame it starts to rise. Null puts the
       container's own name back. */
    setSubject,
    refreshSubject,
    syncSource,
    open() { setOpen(true) },
    close() { setOpen(false) },
    isOpen() { return open },
    destroy() {
      if (sheetFrame !== null) win.cancelAnimationFrame?.(sheetFrame)
      sheetFrame = null
      doc.removeEventListener('keydown', onKeydown)
      subjectUnbind?.()
      subjectUnbind = null
      win.clearTimeout?.(fallTimer)
      for (const node of behind) node.removeAttribute('inert')
    },
  }
}
