/* THE PHONE LEDGER — THE TREE AS ROWS A THUMB CAN READ, ON TOP OF THE
   PHONE CANVAS'S OWN LOCK.
 *
 * The owner chose this across three design rounds (2026-08-27): "I like the
 * dropdown functions instead of a tree for mobile" — the graph's circles
 * become an indented ledger, kinship carried by indentation, a fold control
 * and a repeated lineage label, and pressing a row raises the same details
 * sheet the phone canvas already owns, chat tab first. His standing rule from
 * the canvas applies unchanged: "we cannot let mobile development change the
 * main app or the normal site", and his isomorphism rule with it — the ledger
 * may not know a fact the graph does not know, so it reads the SAME agent
 * records the graph reads and never builds a phone-only shape.
 *
 * HOW IT STAYS OFF EVERY DESKTOP. Two gates in series, both proven elsewhere:
 * it renders only when the phone canvas attribute is already on (the mode no
 * desktop can reach — see phoneCanvasDecision and its 3,000-point matrix), AND
 * only when its own stored choice says 'on'. Nothing in the shipped product
 * writes that choice except the one entry door: /app/?ledger=1, the link the
 * mobile page carries. 'auto' is therefore OFF — a phone that arrives at the
 * canonical page keeps the canonical locked graph, which is the owner's
 * scope ruling verbatim: "leave canonical toolsenabled up ... and then when
 * they click mobile ... the link to the mobile app".
 *
 * WHAT IS REUSED RATHER THAN REBUILT. The rows are the view's own
 * treeAgentRecord shapes; the runtime digits come from the same
 * bindRuntime/tickRuntimes clock every other readout uses; the role colours
 * are ROLES from vocab.js; a row press lands in the view's own selection path
 * (showTreeNodeControls / showProjectionControls), which raises the phone
 * sheet exactly as a bubble press does; an add-row press lands in
 * openComposeFor. The graph itself still mounts and still owns every
 * behaviour — this module only decides what is VISIBLE, so turning the ledger
 * off returns the canonical surface with nothing to migrate.
 */

import { phoneCanvasOn } from './phone-canvas.js'
import { bindRuntime, fmtRuntime } from './runtime-clock.js'
import { NO_RUNTIME } from './runtime-duration.js'
import { ROLES } from './vocab.js'
import { paintRoleColor, roleColorCss } from './role-colors.js'

export const PHONE_LEDGER_SETTING = 'mc.phoneLedger'
export const PHONE_LEDGER_CHOICES = ['auto', 'on', 'off']
export const PHONE_LEDGER_DEFAULT_CHOICE = 'auto'
export const PHONE_LEDGER_COULD_NOT_TELL = 'PHONE_LEDGER_COULD_NOT_TELL'
export const PHONE_LEDGER_STORAGE_UNAVAILABLE = 'PHONE_LEDGER_STORAGE_UNAVAILABLE'

// The entry hint belongs to one window. A later explicit choice must survive
// view remounts while ?ledger=1 remains in that window's address. The existing
// win parameter gives tests fresh, independent windows without global resets.
const handledLedgerEntryWindows = new WeakSet()

function persistLedgerChoice(choice, win) {
  try {
    const storage = win?.localStorage
    if (typeof storage?.setItem !== 'function') throw new Error('Settings storage is unavailable')
    storage.setItem(PHONE_LEDGER_SETTING, choice)
  } catch (cause) {
    const error = new Error('The tree view preference could not be saved.', { cause })
    error.code = PHONE_LEDGER_STORAGE_UNAVAILABLE
    throw error
  }
}

function couldNotTell(subject, cause) {
  const error = new Error(
    `Phone ledger could not determine ${subject}; this does not claim that it is absent or false.`,
    { cause },
  )
  error.code = PHONE_LEDGER_COULD_NOT_TELL
  return error
}

/**
 * THE DECISION, AS ARITHMETIC. True when the phone canvas is on and the person
 * has not turned the ledger OFF.
 *
 * 'auto' USED TO MEAN OFF, and that was wrong. The reasoning written here was
 * that the ledger is "entered through a named door, never guessed onto a
 * visitor" — sound for an experiment, and exactly backwards for this one. The
 * ledger IS the mobile surface: it is the design that was chosen, built and
 * asked to be made live. Defaulting it off meant the only way to see it was to
 * follow /app/?ledger=1 from the mobile page, so every person who typed the
 * domain on a phone — the owner included — got the canonical tree squeezed
 * onto a phone instead, and the built surface sat behind a flag nothing
 * visible sets.
 *
 * A DEFAULT IS A DECISION ABOUT WHAT EVERYBODY SEES. 'off' still means off,
 * and the control in quick settings still switches it, so anyone who prefers
 * the tree keeps it. What changed is which one you get for doing nothing.
 */
export function phoneLedgerDecision(environment = {}) {
  const choice = PHONE_LEDGER_CHOICES.includes(environment.choice)
    ? environment.choice
    : PHONE_LEDGER_DEFAULT_CHOICE
  return environment.canvasOn === true && choice !== 'off'
}

/** Real fleet data requires sign-in. An explicitly chosen example can open
 * only after this view resolves to mock records; a signed-out default or an
 * unresolved/real source does not grant demo access. */
export function phoneLedgerNeedsSignIn({ signedIn, source, exampleChosen } = {}) {
  return signedIn !== true && !(source === 'mock' && exampleChosen === true)
}

/** A missing key means the choice is absent; a failed read does not. */
export function readPhoneLedgerChoice(win = globalThis.window) {
  try {
    const stored = win?.localStorage?.getItem(PHONE_LEDGER_SETTING)
    return PHONE_LEDGER_CHOICES.includes(stored) ? stored : PHONE_LEDGER_DEFAULT_CHOICE
  } catch (cause) {
    throw couldNotTell('the stored choice', cause)
  }
}

/**
 * THE ENTRY DOOR. /mobile/ links to /app/?ledger=1; this reads that flag once
 * and stores the choice, the same remember-once pattern the site's front door
 * uses for ?desktop=1.
 *
 * True means the first entry hint was saved. A failure throws and remains
 * retryable; mounting keeps the previous preference and states the failure.
 * Once handled, remounts read the current saved choice. A fresh window can
 * honour its own entry hint independently.
 */
export function adoptLedgerEntryFlag(win = globalThis.window) {
  const search = String(win?.location?.search || '')
  if (!/[?&]ledger=1\b/.test(search)) return false
  if (handledLedgerEntryWindows.has(win)) return false
  persistLedgerChoice('on', win)
  handledLedgerEntryWindows.add(win)
  return true
}

/* THE CHOICE CHANGED, ANNOUNCED SO THE PAGE UNDER IT CAN BE REDRAWN.
   The decision is read ONCE, when src/views/computers.js builds the view, so a
   choice written afterwards would sit in storage and change nothing a person
   can see until the next launch. src/main.js listens for this and re-renders
   the current route, which is the same door the checkout probe already uses.
   detail: { choice }. */
export const PHONE_LEDGER_EVENT = 'mc:phone-ledger-changed'

/**
 * THE DOOR THAT WAS ONLY EVER OPEN ONE WAY (owner, 2026-08-27: the pop-out
 * settings panel "needs to provide useful settings").
 *
 * Until this existed the ONLY writer of the stored choice was
 * adoptLedgerEntryFlag — /app/?ledger=1, the mobile page's link. A phone that
 * followed that link was in the ledger permanently: nothing in the product
 * could write 'off', so the canonical graph was unreachable without clearing
 * site data. This is the way back, and the way in for somebody already inside
 * the app; it stays in THIS module so the suite's one-writer licence still
 * holds (tools/test/phone-ledger.test.mjs).
 *
 * The announcement redraws the page from storage, so it follows a successful
 * write. Failure leaves the current view and drawer intact for a retry. An
 * unrecognised value writes nothing, announces nothing, and answers null.
 */
export function setPhoneLedgerChoice(choice, win = globalThis.window) {
  if (!PHONE_LEDGER_CHOICES.includes(choice)) return null
  persistLedgerChoice(choice, win)
  handledLedgerEntryWindows.add(win)
  const CustomEventClass = win?.CustomEvent || globalThis.CustomEvent
  if (typeof CustomEventClass === 'function' && typeof win?.dispatchEvent === 'function') {
    win.dispatchEvent(new CustomEventClass(PHONE_LEDGER_EVENT, {
      detail: Object.freeze({ choice }),
    }))
  }
  return choice
}

/**
 * THE ROWS, AS A PURE FUNCTION. Agents in, ordered visible rows out —
 * parents before children, siblings in input order, a folded family reduced
 * to its head carrying the count of what it hides. Information may fold,
 * never vanish.
 *
 * Cycle-safe by construction: children are reached only by walking down from
 * roots, and a corrupt parent chain that loops never reaches a root — its
 * members are appended at depth 0 instead of hanging the walk, because a
 * ledger that renders a corrupt tree beats a page that renders nothing.
 */
export function ledgerRowModel({ agents = [], folded } = {}) {
  const foldedIds = folded instanceof Set ? folded : new Set()
  const byId = new Map()
  for (const agent of agents) {
    if (agent && agent.id != null && !byId.has(agent.id)) byId.set(agent.id, agent)
  }
  const children = new Map()
  const roots = []
  for (const agent of byId.values()) {
    const parentId = agent.parentId != null && byId.has(agent.parentId) && agent.parentId !== agent.id
      ? agent.parentId
      : null
    if (parentId === null) { roots.push(agent); continue }
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId).push(agent)
  }

  const descendantCount = (id, seen = new Set()) => {
    if (seen.has(id)) return 0
    seen.add(id)
    let count = 0
    for (const child of children.get(id) || []) {
      count += 1 + descendantCount(child.id, seen)
    }
    return count
  }

  const rows = []
  const visited = new Set()
  const walk = (agent, depth) => {
    if (visited.has(agent.id)) return
    visited.add(agent.id)
    const kin = children.get(agent.id) || []
    const isFolded = foldedIds.has(agent.id) && kin.length > 0
    rows.push({
      agent,
      depth,
      childCount: kin.length,
      hiddenCount: isFolded ? descendantCount(agent.id) : 0,
      isFolded,
    })
    if (isFolded) {
      /* The subtree is hidden, not forgotten: mark it visited so a cycle back
         into it cannot resurrect a hidden row at the root. */
      const bury = (id) => {
        for (const child of children.get(id) || []) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          bury(child.id)
        }
      }
      bury(agent.id)
      return
    }
    for (const child of kin) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  /* Whatever the walk never reached is a cycle member; it appears, at the
     ground floor, in input order. */
  for (const agent of byId.values()) {
    if (!visited.has(agent.id)) {
      visited.add(agent.id)
      rows.push({ agent, depth: 0, childCount: 0, hiddenCount: 0, isFolded: false })
    }
  }
  return rows
}

/** Search keeps a matching agent's ancestors so the dropdown still explains
 * where that agent belongs. It never changes the underlying records or fold
 * choices; clearing the query returns to exactly the branches left open. */
export function ledgerSearchModel({ agents = [], query = '' } = {}) {
  const byId = new Map()
  for (const agent of agents) {
    if (agent && agent.id != null && !byId.has(agent.id)) byId.set(agent.id, agent)
  }
  const needle = String(query).trim().toLocaleLowerCase()
  const records = [...byId.values()]
  if (!needle) return { agents: records, matches: records.length, searching: false }
  const included = new Set()
  let matches = 0
  for (const agent of records) {
    const role = ROLES[agent.role]?.label || agent.role || ''
    if (!`${agent.name || ''} ${role}`.toLocaleLowerCase().includes(needle)) continue
    matches += 1
    let cursor = agent
    const visited = new Set()
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      included.add(cursor.id)
      cursor = byId.get(cursor.parentId)
    }
  }
  return { agents: records.filter(agent => included.has(agent.id)), matches, searching: true }
}

/* The deepest indent the dress distinguishes; deeper kin share the last step
   plus the lineage label, which is the honest limit of a 320px screen. */
const MAX_INDENT_STEP = 6

/**
 * WHERE THE ADD-ROWS LAND, AS A PURE FUNCTION. Rows (from ledgerRowModel) and
 * the store's extension points in; the ledger's full entry order out — each
 * entry either `{ kind: 'agent', row }` or `{ kind: 'add', parentId, depth,
 * parentName }`, with the root offer (`{ kind: 'add-root' }`) last when the
 * points carry one.
 *
 * THE RULE: every family reads parent, its agents, its add-row — the add-row
 * lands directly after its parent's visible subtree, and when nested subtrees
 * close on the same row the DEEPER family's offer comes first, so nothing
 * separates a family from its own dashed row. Deterministic in the rows'
 * order alone; the points' arrival order carries no meaning here.
 *
 * WHY IT IS A FUNCTION WITH A NAME. The first version computed each insertion
 * index against the row model and applied it to the half-built DOM list —
 * aligned only until the first splice, after which every later index landed
 * progressively wrong. Measured on a fresh profile (phone press-through,
 * 2026-08-27): all five add-rows clustered mid-list in scrambled order, "add
 * an agent under Default 2" three rows ABOVE Default 2 itself, the five-high
 * dashed stack reading as a rendering fault.
 *
 * A FOLDED FAMILY TAKES ITS OFFERS WITH IT: a folded head's own add-row and
 * its buried children's are all absent, which is the fold behaviour the
 * press-through verified (folding Coordinator removed exactly its two adds).
 */
export function ledgerEntries({ rows = [], points = [] } = {}) {
  const visibleIds = new Set(rows.filter(row => !row.isFolded).map(row => row.agent.id))
  const childPoints = points.filter(point => point.parentId != null && visibleIds.has(point.parentId))
  const rowIndexOf = new Map(rows.map((row, index) => [row.agent.id, index]))
  childPoints.sort((left, right) => (rowIndexOf.get(left.parentId) ?? Infinity) - (rowIndexOf.get(right.parentId) ?? Infinity))
  const addsAt = new Map()
  for (const point of childPoints) {
    const parentIndex = rowIndexOf.get(point.parentId)
    const parentRow = rows[parentIndex]
    /* Where the parent's visible subtree ends: the first later row at the
       parent's depth or shallower. */
    let end = parentIndex + 1
    while (end < rows.length && rows[end].depth > parentRow.depth) end += 1
    const bucket = addsAt.get(end) || []
    /* Outer parents are walked first, so unshift puts the deeper family's
       offer ahead when two subtrees close on the same row. */
    bucket.unshift({
      kind: 'add',
      parentId: point.parentId,
      depth: Math.min(parentRow.depth + 1, MAX_INDENT_STEP),
      parentName: parentRow.agent.name,
    })
    addsAt.set(end, bucket)
  }
  const entries = []
  for (let index = 0; index <= rows.length; index += 1) {
    for (const add of addsAt.get(index) || []) entries.push(add)
    if (index < rows.length) entries.push({ kind: 'agent', row: rows[index] })
  }
  if (points.some(point => point.kind === 'tree' || point.kind === 'root')) {
    entries.push({ kind: 'add-root' })
  }
  return entries
}

/* THE SIGN-IN DOOR ITSELF (owner: "house mark, one sentence, sign in, nothing
 * else"). Built from the app's own idioms, not the reference mocks — see the
 * fleet correction on this lane: the restyle-toward-the-mock pass is dead,
 * functionality only, and this door's dress is the shipped Dense tokens like
 * every other surface in this file.
 *
 * THE HOUSE MARK IS TEXT, on purpose and not an oversight: this product has
 * no logo asset anywhere in src/ or index.html — every existing surface names
 * itself in words ("Your ToolsEnabled account", rail-sec headings throughout
 * src/views/computers.js) — so a text mark is the existing convention, not a
 * placeholder standing in for an image that was never built.
 *
 * The initial entrance offers sign-in and an explicit example choice. Demo
 * access does not authenticate an account or enable any computer actions.
 */
export function buildSignInDoor(doc, { onExploreDemo } = {}) {
  const make = (tag, className) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    return node
  }
  const door = make('div', 'phone-ledger-door')
  const mark = make('a', 'phone-ledger-door-mark')
  mark.href = '#/'
  mark.tabIndex = 0
  mark.setAttribute('aria-label', 'ToolsEnabled — Home')
  mark.textContent = 'ToolsEnabled'
  const sentence = make('p', 'phone-ledger-door-sentence')
  sentence.textContent = 'Sign in to see your fleet here.'
  /* .ctl-btn, NOT A NEW BUTTON STYLE. The whole product's action button, used
     on an <a> exactly this way already — src/account-markup.js's cartMarkup():
     `<a class="ctl-btn" href="#/approvals" ...>Open your purchase list</a>`.
     Reusing the class is the door reusing OUR button, not a phone-sized
     reinvention of one; the shared touch-floor rule below (this sheet, "every
     rule in the phone sheet is behind the mode attribute") already grows
     every `a[href]` to the phone-mode minimum, so this needs no size rule
     of its own either. */
  const link = make('a', 'ctl-btn phone-ledger-door-signin')
  link.href = '/signin/'
  // Keep this primary action in WebKit's sequential keyboard navigation.
  link.tabIndex = 0
  link.textContent = 'Sign in'
  door.append(mark, sentence, link)
  if (typeof onExploreDemo === 'function') {
    const demo = make('button', 'ctl-btn phone-ledger-door-demo')
    demo.type = 'button'
    demo.textContent = 'Explore the demo'
    const explanation = make('p', 'phone-ledger-door-sentence')
    explanation.textContent = 'Explore example agents and charts before connecting your computer.'
    const error = make('p', 'phone-ledger-door-error')
    error.setAttribute('role', 'alert')
    demo.addEventListener('click', () => {
      try { onExploreDemo() }
      catch { error.textContent = 'The demo preference could not be saved. Allow site storage and try again.' }
    })
    const choice = make('div', 'phone-ledger-demo-choice')
    choice.append(demo, explanation, error)
    door.append(choice)
  }
  return door
}

/**
 * Mount the ledger onto a computers view. Returns null — and touches
 * nothing — unless the phone canvas is on AND the stored ledger choice is on,
 * which keeps the two lines this adds to src/views/computers.js unreachable
 * on a desktop and inert on the canonical phone surface.
 *
 * `signedInFn` IS A SYNCHRONOUS GETTER, matching `computerFn`'s own existing
 * convention, not a promise: mounting itself stays synchronous (unchanged),
 * and src/views/computers.js resolves the actual account read asynchronously
 * — alongside its existing resolveDataSource() call, on the same
 * DATA_SOURCE_EVENT re-resolve the account service's own sign-in/sign-out
 * already fires — and hands this function a closure over the resolved value.
 * Absent entirely, or answering anything but a fresh read, is read here as
 * "not signed in" the moment it is asked (phoneLedgerNeedsSignIn's own fail-
 * closed rule); refresh() is what actually asks it, on every rebuild.
 */
export function mountPhoneLedger({
  root,
  doc = globalThis.document,
  computerFn,
  stateFn,
  statusWordFor,
  onPressAgent,
  onPressAdd,
  extensionPointsFn,
  sheet,
  signedInFn,
  sourceFn,
  exampleChosenFn,
  onExploreDemo,
} = {}) {
  if (!root || !phoneCanvasOn(doc)) return null
  const win = doc.defaultView || globalThis.window
  /* An entry hint is saved once. If that fails, retain the previous choice
     and leave a visible route to retry; a failed read still keeps the graph. */
  let entered = false
  let entryNotice = null
  root.querySelector('.phone-ledger-entry-error')?.remove()
  try { entered = adoptLedgerEntryFlag(win) } catch {
    const slot = root.querySelector('.graph-canvas-slot')
    if (slot?.parentNode) {
      entryNotice = doc.createElement('p')
      entryNotice.className = 'phone-ledger-entry-error'
      entryNotice.setAttribute('role', 'status')
      entryNotice.textContent = 'Rows could not be saved. Try again in quick settings.'
      slot.parentNode.insertBefore(entryNotice, slot)
    }
  }
  let choice = PHONE_LEDGER_DEFAULT_CHOICE
  if (!entered) {
    try {
      choice = readPhoneLedgerChoice(win)
    } catch {
      return null
    }
  }
  if (!phoneLedgerDecision({ choice: entered ? 'on' : choice, canvasOn: true })) return null

  const slot = root.querySelector('.graph-canvas-slot')
  if (!slot) return null

  const make = (tag, className) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    return node
  }

  root.classList.add('phone-ledger-mode')
  // Hide sample computer chrome until the account read has resolved, too.
  root.classList.add('phone-ledger-auth-required')

  const ledger = make('div', 'phone-ledger')
  const heading = make('div', 'phone-ledger-heading')
  const headingLine = make('div', 'phone-ledger-heading-line')
  const headingText = make('div', 'phone-ledger-heading-text')
  const title = make('h2', 'phone-ledger-title')
  title.textContent = 'Your agents'
  const summary = make('p', 'phone-ledger-summary')
  summary.setAttribute('role', 'status')
  summary.setAttribute('aria-live', 'polite')
  const foldAll = make('button', 'phone-ledger-fold-all')
  foldAll.type = 'button'
  const voiceDoor = make('a', 'phone-ledger-voice')
  voiceDoor.href = '#/'
  voiceDoor.textContent = 'Voice'
  voiceDoor.setAttribute('aria-label', 'Open voice controls')
  headingText.append(title, summary)
  const headingActions = make('div', 'phone-ledger-heading-actions')
  headingActions.append(voiceDoor, foldAll)
  headingLine.append(headingText, headingActions)
  const search = make('input', 'phone-ledger-search')
  search.type = 'search'
  search.placeholder = 'Find an agent'
  search.setAttribute('aria-label', 'Find an agent by name or role')
  search.setAttribute('autocomplete', 'off')
  search.setAttribute('spellcheck', 'false')
  heading.append(headingLine, search)
  heading.hidden = true
  const list = make('div', 'phone-ledger-list')
  list.setAttribute('aria-label', 'Agents and branches')
  ledger.append(heading, list)

  /* The zoom contract kept: the page never pinches, the buttons decide. Three
     steps on a custom property the dress reads; the graph's own cluster is
     hidden with the canvas it zooms. */
  const STEPS = [0.85, 1, 1.18]
  let stepAt = 1
  const zoom = make('div', 'phone-ledger-zoom')
  const zoomOut = make('button', 'phone-ledger-zoom-out')
  zoomOut.type = 'button'
  zoomOut.textContent = '−'
  zoomOut.setAttribute('aria-label', 'Smaller rows')
  const zoomLabel = make('span', 'phone-ledger-zoom-level')
  const zoomIn = make('button', 'phone-ledger-zoom-in')
  zoomIn.type = 'button'
  zoomIn.textContent = '+'
  zoomIn.setAttribute('aria-label', 'Larger rows')
  zoom.append(zoomOut, zoomLabel, zoomIn)
  const applyZoom = () => {
    ledger.style.setProperty('--phone-ledger-scale', String(STEPS[stepAt]))
    zoomLabel.textContent = `${STEPS[stepAt].toFixed(2)}x`
    zoomOut.disabled = stepAt === 0
    zoomIn.disabled = stepAt === STEPS.length - 1
  }
  zoomIn.addEventListener('click', () => { stepAt = Math.min(stepAt + 1, STEPS.length - 1); applyZoom() })
  zoomOut.addEventListener('click', () => { stepAt = Math.max(stepAt - 1, 0); applyZoom() })
  applyZoom()

  slot.append(ledger, zoom)

  /* THE DETAILS DOOR COMES DOWN TO WHERE THE OTHER LIVE CONTROL IS.
     mountPhoneCanvas parks its opener in `.graph-tools`, beside the graph's own
     zoom cluster — correct while the cluster is there. In ledger mode that
     cluster is hidden and the ledger draws its own, so the opener was the only
     thing left in the bar's third row: 44 pixels of chrome, plus its gap, for
     one button, measured 52px off the top of the rows on a 664px phone. It is
     MOVED (never redrawn) to the foot of the ledger's own world, opposite the
     zoom, which is where the owner's composition puts it and what the slot's
     `:not(.phone-sheet-open)` exception above has always been written for. */
  const opener = root.querySelector('.phone-sheet-open')
  if (opener) slot.append(opener)

  const foldedIds = new Set()
  const foldedTreeIds = new Set()
  let unbinds = []
  let searchQuery = ''
  let branchIds = []
  // Keep the static door mounted so anonymous refreshes preserve focus and presses.
  let signInDoor = null
  search.addEventListener('input', () => {
    searchQuery = search.value || ''
    refresh()
  })
  foldAll.addEventListener('click', () => {
    const allFolded = branchIds.every(id => foldedIds.has(id))
    for (const id of branchIds) {
      if (allFolded) foldedIds.delete(id)
      else foldedIds.add(id)
    }
    refresh()
  })

  const lineageFor = (row, byId) => {
    const names = []
    let cursor = row.agent
    const seen = new Set()
    while (cursor && cursor.parentId != null && byId.has(cursor.parentId) && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId)
      cursor = byId.get(cursor.parentId)
      names.unshift(String(cursor.name || ''))
      if (names.length >= 3) break
    }
    const roleKey = ROLES[row.agent.role] ? row.agent.role : 'default'
    const roleName = ROLES[roleKey].label
    const repeatsName = String(row.agent.name || '').trim().toLocaleLowerCase() === roleName.toLocaleLowerCase()
    const role = repeatsName ? '' : roleName
    return [names.join(' / '), role].filter(Boolean).join(' · ')
  }

  const refresh = () => {
    const scrollTop = ledger.scrollTop || 0
    for (const unbind of unbinds) unbind()
    unbinds = []

    /* THE GATE, ASKED FRESH ON EVERY REBUILD. Sign-out while the ledger is on
       screen (the account service's own event re-fires DATA_SOURCE_EVENT,
       which src/views/computers.js already listens for) must drop straight to
       the door on the very next refresh, the same way a mock/real data change
       already does — not only at first mount. */
    const needsSignIn = phoneLedgerNeedsSignIn({
      signedIn: typeof signedInFn === 'function' ? signedInFn() : undefined,
      source: typeof sourceFn === 'function' ? sourceFn() : undefined,
      exampleChosen: typeof exampleChosenFn === 'function' ? exampleChosenFn() : undefined,
    })
    if (needsSignIn) root.classList.add('phone-ledger-auth-required')
    else root.classList.remove('phone-ledger-auth-required')
    if (needsSignIn) {
      heading.hidden = true
      zoom.hidden = true
      if (opener) opener.hidden = true
      if (!signInDoor) signInDoor = buildSignInDoor(doc, { onExploreDemo })
      if (list.children.length !== 1 || list.children[0] !== signInDoor) list.replaceChildren(signInDoor)
      return
    }
    heading.hidden = false
    title.textContent = typeof sourceFn === 'function' && sourceFn() === 'mock' ? 'Example agents' : 'Your agents'
    zoom.hidden = false
    if (opener) opener.hidden = false

    const computer = typeof computerFn === 'function' ? computerFn() : null
    const sourceState = typeof stateFn === 'function' ? stateFn() : null
    const waiting = !computer && sourceState === 'loading'
    const unavailable = !computer && sourceState === 'unavailable'
    const agents = computer?.agents || []
    const nativeTrees = computer?.authoritative === true && Array.isArray(computer.trees) ? computer.trees : null
    const byId = new Map(agents.map(agent => [agent.id, agent]))
    const searchModel = ledgerSearchModel({ agents, query: searchQuery })
    const rows = ledgerRowModel({ agents: searchModel.agents, folded: searchModel.searching ? undefined : foldedIds })
    const allRows = ledgerRowModel({ agents })
    branchIds = allRows.filter(row => row.childCount > 0).map(row => row.agent.id)
    const runningCount = allRows.filter(row => row.agent.state === 'enabled').length
    const unknownActivity = nativeTrees ? allRows.filter(row => typeof row.agent.busy !== 'boolean').length : 0
    const agentCount = allRows.length
    summary.textContent = waiting ? 'Reading the computer’s saved trees…'
      : unavailable ? 'Reconnect to read saved trees'
      : searchModel.searching
      ? `${searchModel.matches} ${searchModel.matches === 1 ? 'match' : 'matches'} · ${agentCount} total`
      : `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}${nativeTrees ? ` · ${nativeTrees.length} saved trees` : ''} · ${runningCount} ${unknownActivity ? 'known running' : 'running'}${unknownActivity ? ` · ${unknownActivity} without activity readings` : ''}`
    if (computer && sourceState === 'refreshing') summary.textContent += ' · refreshing'
    if (computer && sourceState === 'stale') summary.textContent += ' · last verified snapshot'
    foldAll.hidden = branchIds.length === 0
    foldAll.disabled = searchModel.searching
    const allFolded = branchIds.length > 0 && branchIds.every(id => foldedIds.has(id))
    foldAll.textContent = allFolded ? 'Expand all' : 'Collapse all'
    foldAll.setAttribute('aria-label', allFolded ? 'Expand all agent branches' : 'Collapse all agent branches')
    const built = []

    const buildAgentLine = (row) => {
      const line = make('div', 'phone-ledger-row')
      if (nativeTrees) {
        line.dataset.nativeNodeId = row.agent.id
        line.dataset.nativeTreeId = row.agent.treeId
      }
      line.dataset.depth = String(row.depth)
      line.style.setProperty('--phone-ledger-depth', String(Math.min(row.depth, MAX_INDENT_STEP)))
      const roleKey = ROLES[row.agent.role] ? row.agent.role : 'default'
      paintRoleColor(line, row.agent.declaredRole || row.agent.role, row.agent.id)

      if (row.childCount > 0) {
        const fold = make('button', 'phone-ledger-fold')
        fold.type = 'button'
        fold.dataset.agentId = String(row.agent.id)
        fold.disabled = searchModel.searching
        fold.setAttribute('aria-expanded', row.isFolded ? 'false' : 'true')
        fold.setAttribute('aria-label', row.isFolded
          ? `Unfold ${row.agent.name} (${row.hiddenCount} hidden)`
          : `Fold ${row.agent.name}`)
        const glyph = make('span', 'phone-ledger-fold-glyph')
        glyph.textContent = '⌄'
        fold.append(glyph)
        if (row.isFolded) {
          fold.classList.add('is-shut')
          const count = make('span', 'phone-ledger-fold-count')
          count.textContent = String(row.hiddenCount)
          fold.append(count)
        }
        fold.addEventListener('click', (event) => {
          event.stopPropagation()
          const hadFocus = doc.activeElement === fold
          if (foldedIds.has(row.agent.id)) foldedIds.delete(row.agent.id)
          else foldedIds.add(row.agent.id)
          refresh()
          if (hadFocus) {
            const next = [...list.querySelectorAll('.phone-ledger-fold')].find(button => button.dataset.agentId === String(row.agent.id))
            next?.focus({ preventScroll: true })
          }
        })
        line.append(fold)
      } else {
        const leaf = make('span', 'phone-ledger-leaf')
        leaf.textContent = '·'
        line.append(leaf)
      }

      const press = make('button', 'phone-ledger-press')
      press.type = 'button'
      const bar = make('span', 'phone-ledger-rolebar')
      const who = make('span', 'phone-ledger-who')
      const name = make('span', 'phone-ledger-name')
      name.textContent = row.agent.name || ''
      name.title = row.agent.name || ''
      /* THE COUNT IS SAID ONCE. A shut family used to repeat its hidden count
         inside the lineage as well as beside the chevron, and the second copy
         was what pushed the lineage past its column: measured on the phone,
         "COORDINATOR · 1 FO…" — a truncation that turned a readable label into
         nonsense to restate a number already on screen. The fold control
         carries it, visibly and in its aria-label. */
      const lineage = make('span', 'phone-ledger-lineage')
      lineage.textContent = lineageFor(row, byId)
      lineage.title = lineage.textContent
      lineage.hidden = !lineage.textContent
      who.append(name, lineage)

      /* THE RUNTIME, AND THE WORD THAT SAYS WHAT THE NUMBER IS.
         fmtRuntime answers `0:00:00` — the exact shape src/runtime-duration.js
         exists to warn about, because colon-separated digits are also how a
         wall clock reads. The caps line under it is the composition's own
         answer and this product's documented one: name the unit beside the
         value. It appears only when there IS a figure; the no-runtime sentence
         already says what it is. */
      const runtime = make('span', 'phone-ledger-runtime')
      const value = make('span', 'phone-ledger-runtime-value')
      const unit = make('span', 'phone-ledger-runtime-unit')
      const running = row.agent.state === 'enabled'
      if (running && row.agent.bornAt) {
        runtime.classList.add('is-live')
        const bornAt = row.agent.bornAt
        unbinds.push(bindRuntime(value, () => bornAt))
        value.textContent = fmtRuntime(bornAt)
        unit.textContent = 'elapsed'
      } else if (row.agent.bornAt && row.agent.stoppedAt) {
        value.textContent = fmtRuntime(row.agent.bornAt, row.agent.stoppedAt)
        unit.textContent = 'ran for'
      } else {
        value.textContent = nativeTrees ? 'Time not reported' : NO_RUNTIME
      }
      runtime.append(value, unit)

      const status = make('span', 'phone-ledger-status')
      status.dataset.live = running ? 'true' : 'false'
      /* THE MARK IS READ OFF THE RECORD, NEVER OFF THE WORD. Matching on the
         status sentence would make the glyph a second opinion about state that
         drifts the moment the vocabulary is edited; `agent.state` is the same
         field the row's colour and clock already branch on. Ink for three of
         the four, ember for the one with a pulse — V001's discipline, which
         the owner's composition states as its rule. */
      status.dataset.mark = running ? 'run'
        : nativeTrees ? 'off'
        : row.agent.state === 'failed' ? 'fail'
          : row.agent.state === 'finished' ? 'done'
            : 'off'
      status.textContent = typeof statusWordFor === 'function'
        ? String(statusWordFor(row.agent) || '')
        : String(row.agent.state || '')

      press.setAttribute('aria-label', `Open ${row.agent.name || 'agent'}. ${lineage.textContent}. ${status.textContent}. ${value.textContent} ${unit.textContent}`.trim())

      const meta = make('span', 'phone-ledger-meta')
      meta.append(status, runtime)
      const open = make('span', 'phone-ledger-open-mark')
      open.textContent = '›'
      open.setAttribute('aria-hidden', 'true')
      press.append(bar, who, meta, open)
      /* THE SHEET LEARNS WHO IT IS ABOUT BEFORE IT RISES. Same values this
         row just drew, from the same records — the role hue from ROLES, the
         lineage from the same walk, and the clock handed over as a BINDING
         rather than a number, so the head ticks on the one clock every other
         readout in this product uses. */
      const subjectNow = () => ({
        id: row.agent.id,
        name: row.agent.name || '',
        lineage: lineage.textContent,
        roleHex: roleColorCss(row.agent.declaredRole || row.agent.role, 'accent', row.agent.id),
        runtimeText: value.textContent,
        runtimeUnit: unit.textContent,
        live: running,
        statusWord: status.textContent,
        mark: status.dataset.mark,
        bindRun: running && row.agent.bornAt
          ? (node) => bindRuntime(node, () => row.agent.bornAt)
          : null,
      })
      /* A sheet already up over this agent follows the row it was opened from. */
      sheet?.refreshSubject?.(subjectNow())
      press.addEventListener('click', () => {
        // Touching a button does not focus it in every engine. Remember the
        // actual opener so closing the dialog returns to this agent.
        press.focus({ preventScroll: true })
        sheet?.setSubject?.(subjectNow())
        onPressAgent?.(row.agent)
      })
      line.append(press)
      return line
    }

    /* The graph's dashed circles, as rows: one under each parent the store
       would accept a child under, one at the ground for a new root. Same
       affordance, same destination, ledger dress. WHERE each lands is
       ledgerEntries' rule — pure, tested by value, and the only writer of the
       final order; this loop just dresses what it is handed. */
    const points = typeof extensionPointsFn === 'function' ? (extensionPointsFn() || []) : []
    if (rows.length === 0 && (!nativeTrees?.length || searchModel.searching)) {
      const empty = make('div', 'phone-ledger-empty')
      const emptyTitle = make('h3', 'phone-ledger-empty-title')
      const emptyText = make('p', 'phone-ledger-empty-text')
      emptyTitle.textContent = waiting ? 'Reading saved trees' : unavailable ? 'Reconnect to read saved trees' : searchModel.searching ? 'No matching agents' : 'No agents yet'
      emptyText.textContent = waiting ? 'Waiting for the computer’s complete saved workspace.'
        : unavailable ? 'The computer’s saved workspace could not be verified. Reconnect to try again.'
        : searchModel.searching
        ? 'Try another name or role.'
        : points.some(point => point.kind === 'tree' || point.kind === 'root')
          ? 'Start a tree below, then open an agent to check in.'
          : 'Agents from this computer will appear here.'
      empty.append(emptyTitle, emptyText)
      built.push(empty)
    }
    /* Saved-tree boundaries are native facts too. Render every native tree,
       including an empty one; a session graph cannot supply these headings.
       Folding and search are ephemeral presentation only. */
    if (nativeTrees) {
      for (const tree of nativeTrees) {
        const treeRows = rows.filter(row => row.agent.treeId === tree.id)
        if (searchModel.searching && treeRows.length === 0) continue
        const total = agents.filter(agent => agent.treeId === tree.id).length
        const folded = !searchModel.searching && foldedTreeIds.has(tree.id)
        const section = make('section', 'phone-ledger-tree')
        section.dataset.nativeTreeId = tree.id
        const heading = make('h3', 'phone-ledger-tree-heading')
        const toggle = make('button', 'phone-ledger-tree-toggle')
        toggle.type = 'button'
        toggle.setAttribute('aria-expanded', folded ? 'false' : 'true')
        toggle.disabled = searchModel.searching
        const name = make('span', 'phone-ledger-tree-name')
        name.textContent = tree.name || tree.id
        const count = make('span', 'phone-ledger-tree-count')
        count.textContent = `${total} ${total === 1 ? 'agent' : 'agents'}`
        const mark = make('span', 'phone-ledger-tree-mark')
        mark.textContent = folded ? '›' : '⌄'
        mark.setAttribute('aria-hidden', 'true')
        toggle.append(name, count, mark)
        toggle.addEventListener('click', () => {
          const hadFocus = doc.activeElement === toggle
          if (foldedTreeIds.has(tree.id)) foldedTreeIds.delete(tree.id)
          else foldedTreeIds.add(tree.id)
          refresh()
          if (hadFocus) [...list.querySelectorAll('.phone-ledger-tree')]
            .find(candidate => candidate.dataset.nativeTreeId === tree.id)?.querySelector('.phone-ledger-tree-toggle')?.focus({ preventScroll: true })
        })
        heading.append(toggle)
        section.append(heading)
        if (!folded) {
          for (const row of treeRows) section.append(buildAgentLine(row))
          if (total === 0) {
            const empty = make('p', 'phone-ledger-tree-empty')
            empty.textContent = 'No agents are saved in this tree.'
            section.append(empty)
          }
        }
        built.push(section)
      }
    }
    for (const entry of nativeTrees ? [] : ledgerEntries({ rows, points: searchModel.searching ? [] : points })) {
      if (entry.kind === 'agent') {
        built.push(buildAgentLine(entry.row))
        continue
      }
      const addRow = make('button', 'phone-ledger-add')
      addRow.type = 'button'
      addRow.style.setProperty('--phone-ledger-depth', String(entry.kind === 'add' ? entry.depth : 0))
      const mark = make('span', 'phone-ledger-add-mark')
      mark.textContent = '+'
      const label = make('span', 'phone-ledger-add-label')
      label.textContent = entry.kind === 'add' ? `Add agent under ${entry.parentName}` : 'Start a new tree'
      addRow.append(mark, label)
      addRow.addEventListener('click', () => {
        /* An empty slot has no agent to name, so the head goes back to naming
           the container. Anything else would leave the last agent's name over
           a compose form that is not about it. */
        sheet?.setSubject?.(null)
        onPressAdd?.(entry.kind === 'add' ? { kind: 'child', parentId: entry.parentId } : { kind: 'root' })
      })
      built.push(addRow)
    }

    list.replaceChildren(...built)
    // Safari can clamp the scroller while its live rows are replaced.
    ledger.scrollTop = scrollTop
  }

  /* NO PAINT AT MOUNT, and it is load-bearing: the view wires this up near
     the top of its build, before its own `computer` and `treeStore` bindings
     exist — an eager refresh() here reads straight into their temporal dead
     zone and takes the whole view down with a blank page (measured on the
     first drive of this module: topbar, nothing else). The first rows arrive
     when mountGraph calls refresh(), which is also the first moment there is
     a computer to draw. */

  return {
    refresh,
    resetSource() {
      foldedIds.clear()
      foldedTreeIds.clear()
      searchQuery = ''
      search.value = ''
      ledger.scrollTop = 0
    },
    destroy() {
      for (const unbind of unbinds) unbind()
      unbinds = []
      ledger.remove()
      zoom.remove()
      entryNotice?.remove()
      root.classList.remove('phone-ledger-mode')
      root.classList.remove('phone-ledger-auth-required')
    },
  }
}
