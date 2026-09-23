// /ledger — owner requests (R) and owner questions (Q).
// State is deliberately encoded once, at a fixed left rail: a distinct glyph
// plus a themed status colour. Everything after the title is quiet metadata.
//
// ONE RENDER PATH. This page used to keep a second face -- its own markup
// builders, its own richer data shape, an age ticker -- selected by a
// per-view flag. The owner's ruling collapsed that: "all simulated pages ARE
// the UI pages, just mock data." So the register is drawn by one set of
// builders whatever the data's origin. src/data-source.js answers where the
// data comes from ('local', 'relay' or 'mock'), and that answer changes
// exactly two things here: what feeds the render, and whether the page is
// badged as an example. Nothing about HOW it renders.
//
// THE R ROWS ARE THE PERSON'S OWN REQUESTS, READ LIVE (2026-09-02). The
// installed application keeps one canonical request ledger -- everything
// /Request, /RequestTree, /RequestSession and /RequestThread file, and
// everything an agent files from the person's words -- and this page reads it
// through src/ledger-live.js on every load. Each row carries the person's
// words and who the rule reaches; a row an agent filed and nobody has
// approved yet wears its own glyph and its own Approve and Decline; every row
// can be edited or deleted here, and a request can be filed from the box at
// the foot of the page. The Q rows still come from the report written when
// ToolsEnabled itself is built, and the two halves fail independently.

import { el, attachSeg } from '../components.js'
import { fetchLiveLedger } from '../ledger-live.js'
import { mountLedgerResetControls } from '../ledger-reset-controls.js'
import { mountLedgerCustodyControls } from '../ledger-custody-controls.js'
/* THE OWNER'S TWO WAITING COLOURS, AND WHERE THEY COME FROM.
   ownerWaitingStatus is the SAME rule Home's circle is coloured by -- one
   function in src/home-ledger-status.js, called here per row and there over
   the whole register -- so the page a person opens from the circle cannot
   disagree with the circle about which rows the owner is waiting on.
   mountHomeStatusColors puts the person's own picked colour for each of those
   statuses on this page as `--home-ledger-blocked` / `--home-ledger-attention`,
   per theme, read back out by src/ledger.css. The picker itself is the one
   that already exists (quick settings, src/home-status-quick-settings.js);
   this page grows no second one. */
import { ownerWaitingStatus } from '../home-ledger-status.js'
import { mountHomeStatusColors } from '../home-status-colors.js'
/* WHERE THE DATA COMES FROM -- one axis, three answers, resolved async and
   re-resolved whenever the host announces the world changed. The badge rule
   lives there too (sourceIsBadged: mock is badged, real data never is), so
   this page cannot derive a private one and drift from its neighbours. */
import { DATA_SOURCE_EVENT, resolveDataSource, sourceIsBadged, currentDataSource } from '../data-source.js'
/* Whether the person turned the example on themselves (a namespace read, so
   a copy of data-source.js without the question still loads this page). */
import * as dataSourceChoice from '../data-source.js'
/* THE NOTICE BODY WAS NEVER READ THROUGH readerRemedy, unlike every other
   refusal-shaped sentence this product shows. "Close ToolsEnabled and open it
   again" reaches a browser reading this register over the relay exactly as
   often as a genuine read failure does -- the comment above names this page's
   data as reachable from the relay leg the same way its rows are -- so it
   needs the same translation views/computers.js and views/home.js already
   apply to theirs. */
import { readerRemedy } from '../refusal-copy.js'
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })
/* The example fleet's register, ALREADY in the exact shape the live feed
   answers with -- src/sample-ledger.js's header carries the why. It is handed
   to the very assignment a fetched register lands in, so from that line on the
   render cannot tell the two apart and never needs to: the badge, not the code
   path, is what separates them. */
import { sampleLedgerData } from '../sample-ledger.js'
import { mountLedgerWriteSurface } from '../write-surfaces.js'
import {
  CHAIN_NOTE,
  COMPLETE_ROW,
  DECIDE_ROW,
  DELETE_ROW,
  EMPTY_LIST,
  EXAMPLE_WRITE_NOTE,
  EXAMPLE_WRITE_NOTE_CHOSEN,
  HIDE_ROW,
  KIND_FILTER,
  ASKS_COUNTER,
  countOf,
  LEDGER_UPDATES,
  KIND_UNREADABLE,
  FIND_BOX,
  FILE_BOX_OFF,
  WAITING_FILTER,
  LEDGER_LIMITS,
  ledgerRefusalSentence,
  utf8Bytes,
  PROPOSED_NOTE,
  RESOLVE_NOTE,
  RESOLVE_ROW,
  RESOLVE_STATUSES,
  ROW_DETAIL,
  SUPERSEDED_NOTE,
  REMOVED_TOGGLE,
  ROW_ACTIONS,
  SCOPE_CHIP,
  SCOPE_FILTER,
  registerNotice,
} from '../ledger-copy.js'
/* "filed by your agent codex", in the rules panel's own words, so a row here
   and the same rule on the Computers page name its author the same way. */
import { REQUEST_PANEL } from '../tree-standing-requests.js'
/* THE × ON EVERY ROW, AND WHY IT HIDES RATHER THAN DELETES. The × does the one
   thing it always did -- stop drawing the row here -- and says so in every
   sentence beside it (HIDE_ROW). Deleting is a separate control now, and it
   really deletes: the ledger keeps the record as deleted and agents stop
   reading it. The two are drawn apart and worded apart so neither can be
   mistaken for the other. The hide set lives in this copy's own storage,
   keyed per list so an example R1 never hides a real R1, and nothing is sent. */
import { createHiddenRows } from '../hidden-rows.js'
/* Two presses for anything that takes a row away -- the research page's
   measured rule, lifted into a shared helper so the × cannot fire on a pointer
   that was on its way to the scroll bar. */
import { armOnce } from '../arm-press.js'
/* THE DOOR OUT OF THIS SCREEN'S UNREADABLE STATE. A copy with no installed
   application behind it cannot read a ledger, and the honest answer needs
   somewhere to send a person who wants to know why. The label and the address
   are imported rather than retyped so this screen and the other five point at
   one page under one name. */
import { GUIDE_ACTION } from '../first-run-needs.js'
/* The person's hand: Edit, Delete, Approve and Decline on a row; the box that
   files a request. Both are pure over the elements they are handed and driven
   by their own suites. */
import { mountLedgerRowActions } from '../ledger-row-actions.js'
/* `storedFleetTrees` is the file box's own reader for the saved fleet-tree
   records -- the ONE scan of this window's storage for them. The reach chip
   below names the same circles the box's picker names, so it reads through the
   same door rather than opening a second one that could disagree about what a
   record is. */
import { mountLedgerFileBox, storedFleetTrees } from '../ledger-file-box.js'
import { taskDifficultyMetadataMarkup } from '../task-difficulty.js'
/* THE NAMING RULE ITSELF LIVES WITH THE RECORD (src/fleet-trees.js), because
   the Computers page rail and the file box already name these same circles from
   it and a third derivation here would let one agent wear three names. */
import { nodeNamesByKey } from '../fleet-trees.js'
import { roleLabel } from '../fleet-tree-copy.js'
/* THE P SUBSET IS THE PURCHASES PAGE, MOUNTED, NOT REBUILT (owner's ruling,
   2026-09-07: "Most of this is already built. Respect how its built, build
   it the same or similar"). approvals.js already reads the one purchase
   queue live, polls it, and gates Approve/Decline on the engine's own
   OWNER_PROMPT_NOT_PRESENTED presentation check -- a plain
   `.ledger-row-actions` button, drawn once and enabled on sight, cannot
   reproduce that check, and a purchase batch's per-line merchant/purpose/
   amount has nowhere to sit in a row built for one title and one status. So
   the P tab mounts ledgerPromptQueue() itself, exactly as /approvals does, in
   its own slot beside the register rather than inside it. */
import { renderPurchasesTab } from './ledger-purchases.js'
import '../ledger.css'
import { focusKeeper } from '../focus-keep.js'

/* THE OWNER'S FOUR SUBSETS (2026-09-07, verbatim): "ledger should have the
   following subsets: R for rules; T for tasks... Asks for things agents need
   from the owner; and Purchases for actual purchases". This is the R/Q
   choice's replacement; the Q tab's questions did not get a fifth home, they
   moved into A (see readMode's 'q' -> 'a' migration and renderAsks below). */
const KINDS = ['r', 't', 'a', 'p', 'all']
/* Exported so main.js's approvals->ledger redirect can set the same key the
   mode picker itself reads, rather than carrying a second copy of the
   string that could drift from this one. */
export const MODE_KEY = 'mc.ledger.mode'
/* How often the open page re-reads the Ledger for what agents filed or changed
   (see refreshQuietly). Exported so a test can find its own timer. */
export const LEDGER_REFRESH_MS = 5000
/* Which reach the list is narrowed to, remembered per copy the same way the
   kind choice is. 'all' here is the whole reach (every scope tier) -- a
   different axis from the 'all' kind above, which is every SUBSET at once;
   the two happen to share a word because English does not have two. */
const SCOPE_KEY = 'mc.ledger.scope'
const SCOPES = ['all', 'global', 'tree', 'session', 'thread']
/* ONE HIDE LIST PER REGISTER. The example register is shaped exactly like a
   real one down to its ids, so the two must never share a set: a row hidden
   while the example toggle was on would otherwise vanish from the real list
   the moment the toggle went off. The suffix follows sourceIsBadged(), which
   is the page's one badge rule. */
const HIDDEN_KEY_LIVE = 'mc.ledger.hidden:live'
const HIDDEN_KEY_EXAMPLE = 'mc.ledger.hidden:example'
const SUMMARY_STATES = ['open', 'in-progress', 'gated', 'proposed', 'done', 'blocked']
/* THE TASKS TAB COUNTS TASKS IN THEIR OWN WORDS (T1551). R's six tiles gave
   tasks a Gated tile that is always 0, a Waiting for you tile that missed
   every task blocked on the owner, and no tile at all for recurring and
   superseded tasks, so the tiles did not add up to the tasks listed. A task
   blocked on the owner is exactly what Home counts as waiting on them. */
const TASK_TILES = Object.freeze([
  { state: 'open', mark: 'open', label: 'Open' },
  { state: 'in-progress', mark: 'in-progress', label: 'In progress' },
  { state: 'blocked-external', mark: 'blocked', label: 'Waiting for you' },
  { state: 'recurring', mark: 'open', label: 'Recurring' },
  { state: 'done', mark: 'done', label: 'Done' },
  { state: 'superseded', mark: 'done', label: 'Superseded' },
])

const STATE = {
  open: { glyph: '●', label: 'Open' },
  'in-progress': { glyph: '◐', label: 'In progress' },
  gated: { glyph: '■', label: 'Gated' },
  proposed: { glyph: '◇', label: 'Waiting for you' },
  done: { glyph: '✓', label: 'Done' },
  blocked: { glyph: '✕', label: 'Blocked' },
  removed: { glyph: '–', label: 'Removed or declined' },
  unknown: { glyph: '?', label: 'Unclassified status' },
  /* T's own state: a task on its second-or-later lap, still open. */
  recurring: { glyph: '↻', label: 'Recurring' },
  /* A's own state: the owner has answered. */
  answered: { glyph: '✓', label: 'Answered' },
  /* P's own state: the owner said yes; pay.record has not run yet. */
  approved: { glyph: '✓', label: 'Approved' },
  /* T's own terminal state, same standing as done and removed: replaced by
     a newer task (Worker's owner-request-store.js TASK_STATUS_VOCABULARY,
     "terminal, like done or removed"). R's own Resolve action (below) can
     land a standing rule on this same status; it wears the same mark --
     "replaced by something newer" reads the same whichever kind it is. */
  superseded: { glyph: '»', label: 'Superseded' },
  /* R's OWN RESOLVE ACTION (owner's ruling, 2026-09-07): four of the six
     RESOLUTION_STATUSES used to collapse into a neighbour on this rail
     (partial into in-progress, blocked-external and not-possible-as-asked
     both into the one generic 'blocked'; see src/ledger-live.js stateOf).
     Each earns its own mark here so the rail tells them apart at a glance,
     the way 'gated' already stands apart from plain 'open'. */
  partial: { glyph: '◑', label: 'Partly done' },
  'blocked-external': { glyph: '⊘', label: 'Blocked, needs someone outside' },
  'not-possible-as-asked': { glyph: '⊗', label: 'Not possible as asked' },
}

/* THE EXAMPLE MARKING, IN HOME'S EXACT WORDS. Every landing view labels its
   own example data and "Example, not your data" is the product's one phrasing
   for it (src/local-activity.js, src/approvals-example.js). It rides in the
   counter line, which sits directly above the register it describes, so the
   label and the rows it disclaims cannot scroll apart. */
const EXAMPLE_COUNT_PREFIX = 'Example, not your data — '

const esc = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The waiting filter Home's ledger line asks for, or null (see ledgerView). */
function waitingFromAddress() {
  try {
    const hash = typeof location !== 'undefined' && typeof location.hash === 'string' ? location.hash : ''
    const asked = new URLSearchParams(hash.split('?')[1] || '').get('waiting')
    return asked === 'blocked' || asked === 'attention' ? asked : null
  } catch { return null }
}

/* The record a link asks the page to open on (#/ledger?id=T1553), or null. */
function idFromAddress() {
  try {
    const hash = typeof location !== 'undefined' && typeof location.hash === 'string' ? location.hash : ''
    const asked = new URLSearchParams(hash.split('?')[1] || '').get('id')
    return typeof asked === 'string' && /^[RTAP](?:0\d|[1-9]\d{0,5})(?:\.[1-9]\d*)*$/.test(asked) ? asked : null
  } catch { return null }
}

function readMode() {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    /* THE 'q' -> 'a' MIGRATION. A copy that had the Q tab open before this
       feature shipped remembers 'q'; A is where that half of the page moved
       (see renderAsks), so the stored choice reads as 'a' rather than
       falling back to 'r' and silently switching what the person was
       looking at. */
    if (stored === 'q') return 'a'
    return KINDS.includes(stored) ? stored : 'r'
  } catch { return 'r' }
}

function writeMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode) } catch {}
}

function readScope() {
  try {
    const stored = localStorage.getItem(SCOPE_KEY)
    return SCOPES.includes(stored) ? stored : 'all'
  } catch { return 'all' }
}

function writeScope(scope) {
  try { localStorage.setItem(SCOPE_KEY, scope) } catch {}
}

/* The rail glyph for a row. The live feed precomputes `state`; a row that
   carries only a status word (the projection's old shape) is classified here
   from the word alone. */
function requestState(status) {
  if (Object.hasOwn(STATE, status)) return status
  if (typeof status === 'string' && status.startsWith('blocked')) return 'blocked'
  if (status === 'declined') return 'removed'
  return 'unknown'
}

function questionState(statusClass) {
  return Object.hasOwn(STATE, statusClass) ? statusClass : 'unknown'
}

const rowState = item => (item.state && Object.hasOwn(STATE, item.state) ? item.state : requestState(item.status))

/* THE ROW'S OWNER-WAITING MARK, or nothing at all. `data-state` says what the
   RECORD is ('open', 'proposed', 'blocked'...); this says whether the OWNER is
   the one holding it up, which is a different question and the only one the
   two picked colours answer. Absent on every row that answers neither, because
   an attribute that is always present is not a signal. `kind` is handed in
   rather than left to the id's first letter: A and P at 'open' are asks and R
   and T at 'open' are not, so the letter is load-bearing here. A row that
   carries its own kind keeps it. */
const ownerStatusAttr = (item, kind) => {
  const waiting = ownerWaitingStatus({ kind, ...item })
  return waiting ? ` data-owner-status="${waiting}"` : ''
}

/* THE SIX-TILE STRIP STAYS COARSE, RULED BY CONTROLLER (2026-09-07): the row
   badge is exact -- 'blocked-external' and 'partial' keep their own glyph
   and label on the row (see STATE above) -- but the summary strip was not
   redrawn for this feature, so for COUNTING PURPOSES ONLY 'blocked-external'
   folds into the existing 'blocked' tile and 'partial' folds into
   'in-progress'. 'superseded' and 'not-possible-as-asked' are terminal and
   count in no tile, exactly as 'declined'/'removed' already do not (neither
   is a SUMMARY_STATES key). This must never touch rowState's own return
   value -- that would blur the row's glyph along with the tile -- it only
   wraps the state on its way INTO the tile counter. */
const summaryTileOf = state => {
  if (state === 'blocked-external') return 'blocked'
  if (state === 'partial') return 'in-progress'
  return state
}

/* THE CONTROL AT THE ROW'S RIGHT EDGE, in both of its states. It is a SIBLING
   of the row inside `.ledger-line` (position:relative), never a child of it:
   the Q row is itself a <button>, and a button inside a button is invalid
   markup that browsers split unpredictably. A row that is hidden and shown on
   request gets the same control with the opposite verb. */
function hideControl(key, id, { hidden = false } = {}) {
  return hidden
    ? `<button class="ledger-hide" type="button" data-unhide="${esc(key)}" aria-label="${esc(HIDE_ROW.putBack(id))}" title="${esc(HIDE_ROW.putBackTitle)}">↩</button>`
    : `<button class="ledger-hide" type="button" data-hide="${esc(key)}" aria-label="${esc(HIDE_ROW.aria(id))}" title="${esc(HIDE_ROW.title)}">×</button>`
}

/* Under the row: where the first press says what the second will do. Empty
   and hidden until then, so a register of fifty rows does not carry fifty
   blank paragraphs. tabindex -1 so focus can be handed to it after a write
   redraws the row with no control left on it (a row that is now removed). */
const ROW_HINT = '<p class="ledger-row-hint" data-row-hint role="status" tabindex="-1" hidden></p>'

/* The chip that says who a rule reaches: the name the person saw when filing,
   or the circle that key belongs to, or the reach word with the key's tail, or
   the word for a rule with no key.
   `words` is SCOPE_CHIP; without it the reach word is the ledger's own.

   THE THIRD BRANCH IS NOT THE ORDINARY ONE, AND IT USED TO BE THE ONLY ONE.
   `scopeLabel` is sent by the surfaces a PERSON files from -- the /Request
   family (src/views/computers.js fileStandingRequestFor) and the box at the
   foot of this page -- and it is optional on the way in, so a rule an agent
   filed, or one filed before labels existed, arrives carrying nothing but its
   key. MEASURED 2026-09-03 against a row with scope 'thread', no label and the
   store's own id shape: the chip read "circle · …9b278ed". That is the id of
   node-2-6c518599-05aa-4c77-a154-cefe49b278ed with eight characters of it
   showing, and it answers nothing a person asked.

   `names` is nodeNamesByKey's map over this window's saved fleet-tree records,
   and it names the circle the key belongs to for BOTH keyed shapes -- a
   circle/tree rule keyed on the node id, a session rule keyed on the session
   the circle is running. The reach word rides with a session name because the
   filing path writes exactly that ("Coordinator · session"), so a named row and
   a resolved one read the same.

   AND THE TAIL STAYS FOR THE CASE THAT IS REALLY UNNAMEABLE: a browser reading
   this register over the relay has no fleet-tree record to look in, and a rule
   outlives the circle it was filed for. Printing the reach word alone there
   would turn "I could not look this up" into "this rule is for the whole tree",
   which is a different and wrong claim. */
function scopeText(item, words, names = null) {
  const scope = typeof item.scope === 'string' && item.scope !== '' ? item.scope : 'global'
  const word = (words && typeof words[scope] === 'string') ? words[scope] : scope
  /* A NAME KEEPS ITS REACH (T1510). "Worker" alone read the same for a rule
     that reaches Worker and every agent under it and one for Worker's own
     conversation, which the box offers as different choices; every named
     chip now says how far, the way a session chip always did. */
  const reached = name => (scope === 'global' || name.endsWith(` · ${word}`) ? name : `${name} · ${word}`)
  if (typeof item.scopeLabel === 'string' && item.scopeLabel !== '') return reached(item.scopeLabel)
  if (scope === 'global') return word
  const key = typeof item.scopeKey === 'string' ? item.scopeKey : ''
  const named = key !== '' && names && typeof names.get === 'function' ? names.get(key) : ''
  if (typeof named === 'string' && named !== '') return reached(named)
  const tail = key.length > 10 ? `…${key.slice(-8)}` : key
  return tail ? `${word} · ${tail}` : word
}

/* THE CHIP CARRIES ITS WHOLE TEXT (T1516): the rail cuts it at the chip's
   width, so the full name rides as the tooltip too. */
function chipMarkup(item, copy, names) {
  const text = scopeText(item, copy ? copy.scope : null, names)
  return `<span class="ledger-scope" data-scope="${esc(item.scope || 'global')}" title="${esc(text)}">${esc(text)}</span>`
}

/* R'S OWN STANDING STATUSES (owner's Resolve action, 2026-09-07): the
   status words a rule sits in BEFORE the owner has said what happened to
   it, matching Worker's engine ruling verbatim ("a standing R row (open,
   in-progress, partial, blocked-external) moves to one of
   RESOLUTION_STATUSES"). This is `item.status`, never the rail state --
   'gated' is still 'open' or 'in-progress' underneath, and a gated rule is
   exactly as standing as an ungated one; the gate is a different axis. */
const STANDING_STATUSES = new Set(['open', 'in-progress', 'partial', 'blocked-external'])
/* The three resolutions a rule does not come back from (see the submit
   handler): the store resolves only from a standing status. */
const RESOLVE_FINAL = new Set(['done', 'not-possible-as-asked', 'superseded'])
/* The rule statuses a decision (Approve or Decline) can land on. */
const DECIDABLE_STATUSES = new Set(['proposed', 'open', 'in-progress', 'partial', 'blocked-external'])
/* The task statuses the store's completeTask accepts. */
const TASK_COMPLETABLE = new Set(['open', 'in-progress', 'recurring'])

/* THE PERSON'S HAND ON THE ROW, drawn only for the verbs this copy's bridge
   really has (`actions` carries a label per verb, or null): a row waiting for
   approval gets Approve, Decline and Edit; any other live row gets Edit and
   Delete; a standing row also gets Resolve, when the bridge has it; a
   removed row gets nothing, because the ledger keeps it as it is. Never
   nested in the row, and never a button inside a button. */
function rowActionsMarkup(item, state, actions) {
  if (!actions || state === 'removed') return ''
  const key = typeof item.scopeKey === 'string' && item.scopeKey !== '' ? ` data-key="${esc(item.scopeKey)}"` : ''
  const control = (action, label, { danger = false, pressed = false } = {}) =>
    `<button class="ledger-ctl${danger ? ' is-danger' : ''}" type="button" data-row-action="${action}" data-id="${esc(item.id)}"${key}${pressed ? ' aria-pressed="false"' : ''}>${esc(label)}</button>`
  const buttons = []
  if (state === 'proposed') {
    if (actions.approve) buttons.push(control('approve', actions.approve))
    if (actions.decline) buttons.push(control('decline', actions.decline, { danger: true, pressed: true }))
  }
  if (actions.edit) buttons.push(control('edit', actions.edit))
  if (state !== 'proposed' && actions.delete) buttons.push(control('delete', actions.delete, { danger: true, pressed: true }))
  /* RESOLVE IS GATED ON THE STATUS, NOT THE RAIL STATE: a proposed row has
     never stood, a gated row still stands (see STANDING_STATUSES above),
     and a done/superseded/not-possible/removed/declined row does not --
     status alone answers all of those correctly without a second check. */
  if (actions.resolve && STANDING_STATUSES.has(item.status)) buttons.push(control('resolve', actions.resolve))
  if (buttons.length === 0) return ''
  const label = typeof actions.groupLabel === 'function' ? actions.groupLabel(item.id) : item.id
  return `<div class="ledger-row-actions" role="group" aria-label="${esc(label)}">${buttons.join('')}</div>`
}

/* THE RESOLVE PICKER, opened under the row in its own slot -- never the
   `.ledger-row-editor` slot Edit and Answer share with ledger-row-actions.js,
   so this control's whole lifecycle (open, choose, submit, cancel) stays in
   this file, exactly as the owner's file-scope for this piece requires,
   without racing that module's own openSlot/closeSlot for the same node. */
/* A RULE'S CHECKS, ONLY WHEN IT HAS ANY (T1355). Every rule used to read
   "gates 0 unmet 0", a term the page never explained, for a thing no control
   here adds or meets. A rule captured with checks still says how many are
   open, in words, with the reason in its tooltip. */
function gatesMarkup(item) {
  const total = Number.isSafeInteger(item.gateCount) ? item.gateCount : 0
  if (total <= 0) return ''
  const open = Number.isSafeInteger(item.unmetGateCount) ? item.unmetGateCount : 0
  const text = open > 0 ? `${open} of ${total} ${total === 1 ? 'check' : 'checks'} still open` : `${total === 1 ? 'Its check is' : `All ${total} checks are`} met`
  return `<span class="ledger-agent" data-gates title="Checks this rule was filed with; it counts as gated until they are met.">${esc(text)}</span>`
}

/* THE PICKER OPENS ON WHERE THE RULE ALREADY IS. It used to preselect the
   first choice, In progress, whatever the rule was, so opening it on a Partly
   done or Blocked rule and pressing Save moved the rule backwards. A rule that
   is still plain open has no matching choice and keeps In progress, the first
   step forward. */
function resolvePickerMarkup(id, current = null) {
  const at = Math.max(0, RESOLVE_STATUSES.findIndex(entry => entry.value === current))
  const options = RESOLVE_STATUSES.map((entry, index) => `
      <label class="ledger-resolve-option">
        <input type="radio" name="${esc(`resolve-status-${id}`)}" data-resolve-status value="${esc(entry.value)}"${index === at ? ' checked' : ''} />
        ${esc(entry.label)}
      </label>`).join('')
  return `
    <p class="ledger-row-note" data-state="note">${esc(RESOLVE_NOTE.text(id))}</p>
    <div class="ledger-resolve-statuses" role="radiogroup" aria-label="${esc(ROW_ACTIONS.resolveLabel(id))}">${options}</div>
    <label class="ledger-reason">${esc(ROW_ACTIONS.reasonLabel)}<input class="ledger-reason-input" data-resolve-reason maxlength="2000" /></label>
    <div class="ledger-row-actions" role="group" aria-label="${esc(ROW_ACTIONS.groupLabel(id))}">
      <button class="ledger-ctl" type="button" data-resolve-submit data-id="${esc(id)}">${esc(ROW_ACTIONS.save)}</button>
      <button class="ledger-ctl" type="button" data-resolve-cancel data-id="${esc(id)}">${esc(ROW_ACTIONS.cancel)}</button>
    </div>`
}

/* T AND A's OWN GLYPH, from their OWN status vocabularies (see
   LEDGER-KINDS-INTERFACE-20260907.md's STATUS VOCABULARIES). Kept apart from
   requestState/questionState above rather than folded into them: R's
   `gated`/`unmet` reading has no meaning for a task or an ask, and a shared
   function branching on kind is more of a trap for the next edit than two
   short ones are. */
function kindState(item, kind) {
  const status = typeof item?.status === 'string' ? item.status : ''
  if (status === 'removed' || status === 'declined') return 'removed'
  if (kind === 'T') {
    if (status === 'done') return 'done'
    if (status === 'superseded') return 'superseded'
    if (status === 'recurring') return 'recurring'
    /* One status, one mark (T1430): a task blocked on someone outside wears
       the rule's own ⊘, never the generic ✕ that reads like a close button. */
    if (status === 'blocked-external') return 'blocked-external'
    if (status === 'in-progress') return 'in-progress'
    if (status === 'open') return 'open'
    return 'unknown'
  }
  if (kind === 'A') {
    if (status === 'answered') return 'answered'
    if (status === 'open') return 'open'
    return 'unknown'
  }
  if (kind === 'P') {
    if (status === 'recorded') return 'done'
    if (status === 'approved') return 'approved'
    if (status === 'proposed') return 'proposed'
    return 'unknown'
  }
  return 'unknown'
}

/* T AND A's HAND ON THEIR OWN ROW: at most two verbs, and neither is gated on
   a 'proposed' state the way R's are, because neither kind has one. T's verb
   is Complete; A's is Answer. Delete is the one control every kind shares,
   drawn last, in the same `.ledger-row-actions` group R's controls use --
   the owner's "build it the same or similar" for the one thing that really
   is the same across all three. Verbs this copy's bridge lacks are simply
   never drawn, exactly as rowActionsMarkup already does for R. */
function kindActionsMarkup(item, state, kind, actions) {
  /* Superseded stands with removed: terminal, the store refuses complete
     and remove on it by its own typed code, so this row draws no buttons
     at all rather than drawing them to be refused. */
  if (!actions || state === 'removed' || state === 'superseded') return ''
  const key = typeof item.scopeKey === 'string' && item.scopeKey !== '' ? ` data-key="${esc(item.scopeKey)}"` : ''
  const control = (action, label, { danger = false, pressed = false } = {}) =>
    `<button class="ledger-ctl${danger ? ' is-danger' : ''}" type="button" data-row-action="${action}" data-id="${esc(item.id)}"${key}${pressed ? ' aria-pressed="false"' : ''}>${esc(label)}</button>`
  const buttons = []
  /* COMPLETE ONLY WHERE THE STORE COMPLETES: an open, in-progress or
     recurring task. A task blocked on the owner used to offer Complete and
     answer every press with "Try once more" (T1273); its row says why the
     control is off instead (see kindRecordMarkup). */
  if (kind === 'T' && actions.complete && TASK_COMPLETABLE.has(item.status)) buttons.push(control('complete', actions.complete))
  if (kind === 'A' && actions.answer && state !== 'answered') buttons.push(control('answer', actions.answer))
  if (kind === 'A' && actions.decline && state !== 'answered') buttons.push(control('decline', actions.decline, { danger: true, pressed: true }))
  if (actions.delete) buttons.push(control('delete', actions.delete, { danger: true, pressed: true }))
  if (buttons.length === 0) return ''
  const label = typeof actions.groupLabel === 'function' ? actions.groupLabel(item.id) : item.id
  return `<div class="ledger-row-actions" role="group" aria-label="${esc(label)}">${buttons.join('')}</div>`
}

/* ONE ROW MARKUP FOR T AND FOR THE KIND-A HALF OF A -- the same
   `.ledger-record` / `.ledger-line` / `.ledger-row` shape requestMarkup
   draws for R, minus the gate counters R's meta line carries (neither
   status vocabulary has gates) and with kindActionsMarkup's own verbs in
   place of rowActionsMarkup's. Kept as its own function rather than a branch
   inside requestMarkup so R's markup -- and every test pinned to its exact
   bytes -- is untouched by this feature. */
/* WHEN, AS A PERSON READS IT, with the exact stamp kept on the element for a
   hover, a screen reader and a script. Nothing at all for a stamp that is not
   one: a row with no date says nothing rather than "Invalid Date". */
function whenMarkup(at) {
  if (typeof at !== 'string' || at.length > 40) return ''
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return ''
  let shown
  try { shown = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { shown = at }
  return `<time datetime="${esc(at)}" title="${esc(at)}">${esc(shown)}</time>`
}

/* The date a row was filed, beside who filed it, inside the words line. */
function filedAtMarkup(item, copy) {
  const when = whenMarkup(item.filedAt)
  if (!when || !copy || !copy.detail) return ''
  const byAgent = typeof item.filedBy === 'string' && item.filedBy !== '' && item.filedBy !== 'owner'
  return `<span class="ledger-filed-by" data-filed-at>${byAgent ? '' : `${esc(copy.detail.filed)} `}${when}</span>`
}

/* What the record has on file beyond its words, one short line each (see
   ROW_DETAIL in src/ledger-copy.js). Bounded: a reason or an answer is cut
   at 2,000 characters on the row; the store keeps the whole of it. */
function detailMarkup(item, kind, copy) {
  const words = copy && copy.detail
  if (!words) return ''
  const lines = []
  const bounded = value => (typeof value === 'string' ? (value.length > 2000 ? `${value.slice(0, 2000)}…` : value) : '')
  const line = (name, lead, when, said = '') => {
    lines.push(`<p class="ledger-row-note" data-row-detail="${name}">${esc(lead)}${when ? ` ${when}` : ''}${said ? `: ${esc(bounded(said))}` : ''}</p>`)
  }
  const lastBy = historyKind => {
    const rows = Array.isArray(item.history) ? item.history : []
    for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index] && rows[index].kind === historyKind) return rows[index]
    return null
  }
  const decision = item.latestDecision && typeof item.latestDecision === 'object' ? item.latestDecision : null
  /* ADOPTED WITH ITS HISTORY UNCONFIRMED (T1548): the mark the Review dialog
     promised, on the row itself. */
  const adopted = lastBy('adopt')
  if (adopted && words.adopted) line('adopted', words.adopted, whenMarkup(adopted.at))
  if (kind === 'T') {
    if (item.status === 'recurring' || item.recurrence) {
      const runs = Array.isArray(item.recurrence && item.recurrence.completions) ? item.recurrence.completions : []
      const last = runs.length ? runs[runs.length - 1] : null
      if (item.status === 'recurring') line('runs', words.runs(runs.length), runs.length ? whenMarkup(last && last.at) : '')
    }
    if (item.status === 'done') line('completed', words.completed(item.completedBy), whenMarkup(item.completedAt))
    if (decision && decision.decision === 'progress' && decision.reason && ['open', 'in-progress', 'blocked-external'].includes(item.status)) {
      line('progress', item.status === 'blocked-external' ? words.waitingOn : words.progress, '', decision.reason)
    }
  }
  if (kind === 'A') {
    if (item.status === 'answered' && item.answer && typeof item.answer.words === 'string') {
      line('answer', words.answered((lastBy('answer') || {}).actor), whenMarkup(item.answer.at), item.answer.words)
    }
    if (item.status === 'declined') {
      line('declined', words.declinedAsk((lastBy('decline') || {}).actor), whenMarkup(decision && decision.at), decision && decision.decision === 'decline' ? decision.reason : '')
    }
  }
  if (kind === 'P' && item.purchase && typeof item.purchase === 'object') {
    const lines = Array.isArray(item.purchase.lines) ? item.purchase.lines : []
    for (const entry of lines.slice(0, 20)) {
      if (!entry || typeof entry !== 'object') continue
      const said = [entry.merchant, entry.purpose || entry.description].filter(part => typeof part === 'string' && part !== '').join(' — ')
      const amount = Number.isSafeInteger(entry.amountCents) && typeof entry.currency === 'string' ? `${(entry.amountCents / 100).toFixed(2)} ${entry.currency}` : ''
      if (said || amount) line('purchase-line', words.purchaseLine, '', [said, amount].filter(Boolean).join(', '))
    }
    const settled = item.purchase.decision && typeof item.purchase.decision === 'object' ? item.purchase.decision : null
    if (settled && (settled.decision === 'approve' || settled.decision === 'decline')) {
      line('purchase-decision', settled.decision === 'approve' ? words.approvedPurchase(settled.actor) : words.declinedPurchase(settled.actor), whenMarkup(settled.at), settled.reason || '')
    }
    const charge = item.purchase.recordedCharge && typeof item.purchase.recordedCharge === 'object' ? item.purchase.recordedCharge : null
    if (charge) {
      const amount = Number.isSafeInteger(charge.amountCents) && typeof charge.currency === 'string' ? `${(charge.amountCents / 100).toFixed(2)} ${charge.currency}` : ''
      line('purchase-charge', words.charged, whenMarkup(charge.at), amount)
    }
  }
  if (kind === 'R' && decision) {
    const label = decision.status && STATE[decision.status] ? STATE[decision.status].label : decision.status
    if (decision.decision === 'resolve' && decision.status === item.status) line('resolved', words.resolved(label, decision.actor), whenMarkup(decision.at), decision.reason || '')
    if (decision.decision === 'decline' && item.status === 'declined') line('declined', words.declinedRule(decision.actor), whenMarkup(decision.at), decision.reason || '')
    if (decision.decision === 'approve' && decision.reason) line('approved', words.approvedRule(decision.actor), whenMarkup(decision.at), decision.reason)
  }
  return lines.join('')
}

function kindRecordMarkup(item, kind, { hidden = false, actions = null, copy = null, names = null } = {}) {
  const state = kindState(item, kind)
  const meta = STATE[state] || STATE.unknown
  const key = `${kind.toLowerCase()}:${item.id}`
  const words = typeof item.words === 'string' ? item.words : ''
  /* THE ONE THING A TERMINAL SUPERSEDED ROW STILL SAYS: which task replaced
     it, the way a row already cites another row's id (R's parentId nesting,
     DECIDE_ROW.gone(id)). Silent when the store has not supplied one -- an
     id-less superseded row is still honestly superseded, just not citable. */
  const supersededLine = state === 'superseded' && typeof item.supersededBy === 'string' && item.supersededBy !== ''
    ? `<p class="ledger-row-note" data-state="note">${esc(SUPERSEDED_NOTE.text(item.supersededBy))}</p>`
    : ''
  /* WHO FILED IT, in the rule row's own words and place (T1474): an ask is
     answered differently depending on which agent is asking. */
  const filedBy = typeof item.filedBy === 'string' && item.filedBy !== '' && item.filedBy !== 'owner' ? item.filedBy : ''
  const agentLine = filedBy && copy && typeof copy.filedBy === 'function' ? `<span class="ledger-filed-by">${esc(copy.filedBy(filedBy))}</span>` : ''
  return `
    <div class="ledger-record" role="listitem" data-record-key="${esc(key)}" data-row-id="${esc(item.id)}"${hidden ? ' data-hidden' : ''}>
      <div class="ledger-line" data-state="${state}"${ownerStatusAttr(item, kind)}>
        <div class="ledger-row">
          <span class="ledger-state" title="${esc(meta.label)}"><span class="ledger-glyph" aria-hidden="true">${meta.glyph}</span><span class="ledger-sr-only">${esc(meta.label)}</span></span>
          <span class="ledger-id-cell"><span class="ledger-id">${esc(item.id)}</span></span>
          <span class="ledger-title">${esc(meta.label)}</span>
          <span class="ledger-meta">
            ${kind === 'T' ? taskDifficultyMetadataMarkup({ difficulty: item.difficulty, failedReviewCount: item.failedReviewCount, escape: esc }) : ''}
            ${chipMarkup(item, copy, names)}
          </span>
        </div>
        ${hideControl(key, item.id, { hidden })}
      </div>
      <p class="ledger-words">${esc(words)}${agentLine}${filedAtMarkup(item, copy)}</p>
      ${supersededLine}
      ${detailMarkup(item, kind, copy)}
      ${kind === 'T' && item.status === 'blocked-external' && actions && actions.complete && copy && typeof copy.completeOff === 'function'
        ? `<p class="ledger-row-note" data-state="note" data-complete-off>${esc(copy.completeOff(item.id))}</p>`
        : ''}
      ${kindActionsMarkup(item, state, kind, actions)}
      <div class="ledger-row-editor" data-row-editor hidden></div>
      ${ROW_HINT}
    </div>`
}

function requestMarkup(item, { hidden = false, actions = null, copy = null, names = null, resolveOpen = false, drawn = null, listItem = false } = {}) {
  const state = rowState(item)
  const meta = STATE[state]
  const key = `r:${item.id}`
  /* THE INDENT FOLLOWS WHAT IS DRAWN (T1522). The dots in the id say how deep
     a refinement is; when its rule is not on screen (hidden, declined, or
     narrowed away) the refinement used to sit indented under whatever row was
     above it. It now counts only the ancestors actually drawn, and a
     refinement whose own rule is missing says which rule it refines. */
  const ancestors = []
  for (let at = String(item.id).lastIndexOf('.'), id = String(item.id); at > 0; at = id.lastIndexOf('.')) { id = id.slice(0, at); ancestors.push(id) }
  const depth = drawn ? ancestors.filter(id => drawn.has(id)).length : ancestors.length
  const orphanOf = drawn && ancestors.length > 0 && !drawn.has(ancestors[0]) ? ancestors[0] : null
  const orphanLine = orphanOf ? `<p class="ledger-row-note" data-state="note" data-refines="${esc(orphanOf)}">${esc(HIDE_ROW.refines(orphanOf))}</p>` : ''
  const words = typeof item.words === 'string' ? item.words : ''
  const filedBy = typeof item.filedBy === 'string' && item.filedBy !== '' && item.filedBy !== 'owner' ? item.filedBy : ''
  const agentLine = filedBy && copy && typeof copy.filedBy === 'function' ? `<span class="ledger-filed-by">${esc(copy.filedBy(filedBy))}</span>` : ''
  const proposedLine = state === 'proposed' && copy && typeof copy.proposed === 'function'
    ? `<p class="ledger-row-note" data-state="note">${esc(copy.proposed(filedBy || 'agent'))}</p>`
    : ''
  /* THE RESOLVE PICKER'S OPEN/CLOSED STATE LIVES IN THE VIEW (resolvingId, a
     single id or null), not in the row's own data, so it is passed in here
     rather than read off `item`. Only ever true for a standing row with the
     verb -- rowActionsMarkup already refused to draw the button that could
     have opened it on any other row. */
  const resolveSlot = `<div class="ledger-resolve-slot" data-resolve-slot${resolveOpen ? '' : ' hidden'}>${resolveOpen ? resolvePickerMarkup(item.id, item.status) : ''}</div>`

  /* THE R ROW IS NOT A BUTTON, AND ITS DETAIL IS GONE. The detail it used to
     open repeated the row above it word for word, so the row is a plain div
     and the only control on it is the × beside it. What the row carries now
     that it did not before is the person's own sentence, under the rail, and
     the reach chip in the metadata. The Q row keeps its expansion, because
     its detail adds what the row lacks (statusClass, packageId). */
  return `
    <div class="ledger-record" style="--depth:${depth}" ${listItem ? 'role="listitem"' : `role="treeitem" aria-level="${depth + 1}"`} data-record-key="${esc(key)}" data-row-id="${esc(item.id)}"${hidden ? ' data-hidden' : ''}>
      <div class="ledger-line" data-state="${state}"${ownerStatusAttr(item, 'R')}>
        <div class="ledger-row">
          <span class="ledger-state" title="${esc(meta.label)}"><span class="ledger-glyph" aria-hidden="true">${meta.glyph}</span><span class="ledger-sr-only">${esc(meta.label)}</span></span>
          <span class="ledger-id-cell"><span class="ledger-guides" aria-hidden="true"></span><span class="ledger-id">${esc(item.id)}</span></span>
          <span class="ledger-title">${esc(meta.label)}</span>
          <span class="ledger-meta">
            ${gatesMarkup(item)}
            ${chipMarkup(item, copy, names)}
          </span>
        </div>
        ${hideControl(key, item.id, { hidden })}
      </div>
      <p class="ledger-words">${esc(words)}${agentLine}${filedAtMarkup(item, copy)}</p>
      ${orphanLine}
      ${proposedLine}
      ${detailMarkup(item, 'R', copy)}
      ${rowActionsMarkup(item, state, actions)}
      ${resolveSlot}
      <div class="ledger-row-editor" data-row-editor hidden></div>
      ${ROW_HINT}
    </div>`
}

function questionMarkup(item, { expanded = false, hidden = false } = {}) {
  const state = questionState(item.statusClass)
  const meta = STATE[state]
  const key = `q:${item.id}`
  const detailId = `ledger-detail-q-${item.id.replace(/\./g, '-')}`
  const packageId = item.packageId ?? '—'

  return `
    <div class="ledger-record is-question" role="listitem" data-record-key="${esc(key)}"${hidden ? ' data-hidden' : ''}>
      <div class="ledger-line" data-state="${state}">
        <button class="ledger-row" type="button" data-expand="${esc(key)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${esc(detailId)}">
          <span class="ledger-state" title="${esc(item.status)}"><span class="ledger-glyph" aria-hidden="true">${meta.glyph}</span><span class="ledger-sr-only">${esc(item.status)}</span></span>
          <span class="ledger-id-cell"><span class="ledger-guides" aria-hidden="true"></span><span class="ledger-id">${esc(item.id)}</span></span>
          <span class="ledger-title">${esc(item.title)}</span>
          <span class="ledger-meta">
            <span class="ledger-agent" title="${esc(item.status)}">${esc(item.status)}</span>
            <span class="ledger-age" title="${esc(packageId)}">${esc(packageId)}</span>
          </span>
        </button>
        ${hideControl(key, item.id, { hidden })}
      </div>
      <div class="ledger-detail" id="${esc(detailId)}" ${expanded ? '' : 'hidden'}>
        <span class="ledger-detail-label">status-class</span>
        <code>${esc(item.statusClass)}</code>
        <span class="ledger-detail-sep" aria-hidden="true">·</span>
        <span class="ledger-detail-label">package-id</span>
        <code>${esc(packageId)}</code>
      </div>
      ${ROW_HINT}
    </div>`
}

export function ledgerView() {
  /* R's six tiles; the Tasks tab swaps in TASK_TILES (see useTiles). One tile
     per state; `mark` is the colour family the stylesheet keys on. */
  const DEFAULT_TILES = Object.freeze(SUMMARY_STATES.map(state => ({ state, mark: state, label: STATE[state].label })))
  const tilesMarkup = list => list.map(tile => `
            <div class="ledger-stat" data-state="${tile.mark}">
              <span class="ledger-stat-value" data-summary="${tile.state}">0</span>
              <span class="ledger-stat-label">${esc(tile.label)}</span>
              <span class="ledger-stat-note" data-summary-note>· this session</span>
            </div>`).join('')
  const root = el(`
    <div class="view-pad ledger-page">
      <div class="ledger-shell">
        <h1 class="ledger-sr-only">Ledger</h1>
        <section class="ledger-summary" aria-label="Ledger state totals">
          ${tilesMarkup(DEFAULT_TILES)}
        </section>

        <div class="ledger-toolbar">
          <div class="ledger-toolbar-groups">
            <div class="seg ledger-mode" role="group" aria-label="${esc(KIND_FILTER.label)}">
              ${KINDS.map(kind => `<button type="button" data-mode="${kind}" aria-pressed="false">${esc(KIND_FILTER[kind])}</button>`).join('')}
            </div>
            <div class="seg ledger-scope-filter" role="group" aria-label="${esc(SCOPE_FILTER.label)}" data-scope-filter>
              ${SCOPES.map(scope => `<button type="button" data-scope="${scope}" aria-pressed="false">${esc(SCOPE_FILTER[scope])}</button>`).join('')}
            </div>
            <label class="ledger-find"><span class="ledger-sr-only">${esc(FIND_BOX.label)}</span><input type="search" data-ledger-find maxlength="200" placeholder="${esc(FIND_BOX.placeholder)}" aria-label="${esc(FIND_BOX.label)}" /></label>
          </div>
          <p class="ledger-register-note" aria-live="polite"><span data-visible-count>0</span> <button class="ledger-hidden-toggle" type="button" data-show-hidden hidden>${esc(HIDE_ROW.show)}</button> <button class="ledger-hidden-toggle ledger-removed-toggle" type="button" data-show-removed aria-pressed="false" hidden>${esc(REMOVED_TOGGLE.show)}</button></p>
        </div>
        <p class="ledger-hidden-note" data-waiting-filter role="status" hidden></p>
        <p class="ledger-hidden-note" data-hidden-note aria-live="polite" hidden></p>
        <p class="ledger-hidden-note" data-ledger-update role="status" hidden></p>
        <div class="ledger-reset-controls" data-ledger-resets role="group" aria-label="Reset entire Ledger categories" hidden>
          <button type="button" class="ledger-ctl" data-reset-kind="T">Reset tasks…</button>
          <button type="button" class="ledger-ctl" data-reset-kind="R">Reset rules…</button>
          <button type="button" class="ledger-ctl" data-reset-kind="A">Reset asks…</button>
          <button type="button" class="ledger-ctl" data-reset-kind="P">Reset purchases…</button>
        </div>
        <p class="ledger-reset-status" data-ledger-reset-status role="status"></p>
        <div class="ledger-reset-controls" data-ledger-custody hidden>
          <button type="button" class="ledger-ctl" data-ledger-custody-review>Review unconfirmed history…</button>
          <p class="ledger-reset-status" data-ledger-custody-status role="status"></p>
        </div>
        <p class="ledger-chain-note" data-chain-note role="status" hidden></p>

        <!-- THE ADD BOX SITS ABOVE THE LIST (owner, 2026-09-15: "i want to be
             able to manually add on the page"). Under sixty rows it was the
             last thing on the page and read as absent; here it is the first
             control after the filters, and the list it adds to follows. -->
        <section class="ledger-file" data-ledger-file-slot hidden></section>
        <!-- On Purchases the approval queue comes first (what waits for the
             person), then every purchase on file (T1280). -->
        <section class="ledger-purchases-slot" data-purchases-slot hidden></section>
        <section class="ledger-register" aria-live="polite"></section>
      </div>
    </div>`)

  const register = root.querySelector('.ledger-register')
  /* The person's picked colours land on THIS page's element, never on the
     document, exactly the way Home mounts them on its own root: two pages
     reading one preference, neither writing a global. It re-paints itself on
     a theme change and on the picker's event, so the drawer's colour input
     moves this register while it is on screen. */
  const statusColors = mountHomeStatusColors(root)
  /* THE FORMS ARE TOLD WHAT THE LIST IS DOING, which is the whole of finding 11
     part two. The Approve/Decline form asked for "its number, as shown in the
     list" while the list beside it was empty, and it asked in exactly the same
     words whether the list was empty, unreadable or full -- because nothing
     connected the two. Now the register's state and its rows go to the surface
     every time they change, and the form either fills itself from them or turns
     itself off and says why. */
  let showRegisterInForms = () => {}
  const destroyWriteSurface = mountLedgerWriteSurface(root, {
    onMount: api => { showRegisterInForms = api.showRegister },
    /* A decision the form recorded changes a row on this list: re-read it,
       so the row no longer offers Approve and Decline for a choice already
       made (T1278). */
    onChanged: () => { if (!destroyed) void load() },
  })
  const modeGroup = root.querySelector('.ledger-mode')
  const scopeGroup = root.querySelector('[data-scope-filter]')
  const hiddenNote = root.querySelector('[data-hidden-note]')
  const chainNote = root.querySelector('[data-chain-note]')
  const showHiddenToggle = root.querySelector('[data-show-hidden]')
  const findInput = root.querySelector('[data-ledger-find]')
  const showRemovedToggle = root.querySelector('[data-show-removed]')
  const fileSlot = root.querySelector('[data-ledger-file-slot]')
  const purchasesSlot = root.querySelector('[data-purchases-slot]')
  const summarySection = root.querySelector('.ledger-summary')
  /* Q rows only: the R row no longer expands (its detail said nothing). */
  const expandedRows = new Set()
  /* THE HIDE SET STARTS ON THE LIVE KEY AND IS RE-CREATED WHEN THE BADGE IS
     KNOWN (see load). Before the source resolves the page draws no rows, so
     the key it holds then is never consulted; the moment `badged` is set the
     set is rebound to the matching list so an example hide can never land on
     a real row. */
  let hidden = createHiddenRows(HIDDEN_KEY_LIVE)
  /* OPENED FROM HOME'S LEDGER LINE (`#/ledger?waiting=blocked|attention`,
     T1344): every kind, every reach, hidden rows included, narrowed to the
     records Home counted -- so the Ledger's list and Home's number agree. A
     tab or reach press, or the button beside the sentence, ends it. */
  let waitingFilter = waitingFromAddress()
  /* WHAT THE FIND BOX HOLDS (T1459), lower-cased, or '' for everything. A
     link that names a record (#/ledger?id=T1553) opens its tab with the id in
     the box and focus on its row. */
  const askedId = idFromAddress()
  let findText = askedId ? askedId.toLowerCase() : ''
  if (findInput && askedId) findInput.value = askedId
  const matchesFind = item => {
    if (!findText) return true
    const id = String(item.id || '').toLowerCase()
    const said = String(item.words || item.title || '').toLowerCase()
    return id === findText || id.startsWith(findText) || said.includes(findText)
  }
  let showHidden = Boolean(waitingFilter)
  let showRemoved = false
  let mode = waitingFilter ? 'all' : askedId ? ({ R: 'r', T: 't', A: 'a', P: 'p' })[askedId[0]] : readMode()
  let filing = null
  let scope = waitingFilter ? 'all' : readScope()
  /* THE MOUNTED PURCHASES VIEW, while the P tab is open, or null the rest of
     the time. ledgerPromptQueue() runs its own 2-second poll and its own
     presentation-confirmation loop; both are real cost, so this is created
     on entering P and destroyed on leaving it, never left running behind a
     hidden tab. See syncPurchasesMount below. */
  let purchasesMount = null
  let source = null
  /* The questions half's own observation ({ ok, reason, observedAt, value }),
     kept apart from `source` so the Q tab renders whatever the requests
     read said. null until a read answers. */
  let questions = null
  /* The row a write just landed on, for restoreFocus after the reload. */
  let focusRowAfterLoad = null
  /* The sentence a Delete or Decline leaves once the reload lands. */
  let noteAfterLoad = null
  /* A refusal's sentence, put back under its row once a re-read lands. */
  let hintAfterLoad = null
  /* WHICH ROW'S RESOLVE PICKER IS OPEN, or null: one at a time, the way Edit
     and Answer already are (one shared editor slot). Held here rather than
     in the row's own data, since it is what the PERSON is doing, not a fact
     about the record. */
  let resolvingId = null
  let resolvePending = false
  /* Whether the register on screen is the example. Set ONLY from
     sourceIsBadged() at each resolution, never inferred from the data --
     the badge follows the source, and the whole point of the example being
     shaped exactly like a real register is that the data cannot tell you. */
  let badged = false
  let requestVersion = 0
  let destroyed = false
  /* The rows on screen, by id, for the editor to open on their words. */
  let rowsById = new Map()
  /* WHICH CIRCLE EACH SCOPE KEY BELONGS TO, read once per load rather than per
     row: a repaint from the filter buttons redraws every row and must not
     re-parse this window's whole fleet-tree record to do it. Empty until the
     first load answers, which is the same map an unnameable key gets -- so the
     chip's fallback is what a person sees while the read is out, never a name
     from the previous register. */
  let circleNames = new Map()

  /* THE BRIDGE, AND WHICH OF ITS VERBS THIS COPY HAS. A control is drawn only
     for a verb that exists: an older installed application, or a browser with
     none, draws no Edit, no Delete and no file box rather than controls whose
     only outcome is a refusal. Person-only is enforced on the other side of
     the bridge; this page only decides what to draw. */
  const bridge = typeof window === 'undefined' ? null : (window.mcAgent || null)
  const resetControls = mountLedgerResetControls(root, { bridge, onReset() {
    if (destroyed) return
    if (purchasesMount) { purchasesMount.destroy(); purchasesMount = null }
    void load()
  } })
  const custodyControls = mountLedgerCustodyControls(root, { bridge, onAdopt() { if (!destroyed) void load() } })
  const verbs = Object.freeze({
    edit: typeof bridge?.requestEdit === 'function',
    /* R's own remove and decide, untouched: T, A and P each have their own
       remove/decline now (below), so requestRemove/requestDecide are never
       reused across a kind they were not written for. */
    remove: typeof bridge?.requestRemove === 'function',
    decide: typeof bridge?.requestDecide === 'function',
    /* T's Complete and Remove, A's Answer, Decline and Remove: the engine
       lane's own per-kind verbs (Worker 4, own branch) -- completeTask,
       removeTask, answerAsk, declineAsk, removeAsk. Until a bridge actually
       has one these read false and the page draws neither control, the same
       as every other verb here. */
    complete: typeof bridge?.completeTask === 'function',
    removeTask: typeof bridge?.removeTask === 'function',
    answer: typeof bridge?.answerAsk === 'function',
    declineAsk: typeof bridge?.declineAsk === 'function',
    removeAsk: typeof bridge?.removeAsk === 'function',
    /* R's own Resolve (owner's 2026-09-07 addition): resolveStandingRequest,
       owner-only, Worker 4's own branch alongside the verbs above. */
    resolve: typeof bridge?.resolveStandingRequest === 'function',
  })
  const rowActions = verbs.edit || verbs.remove || verbs.decide || verbs.resolve
    ? Object.freeze({
        edit: verbs.edit ? ROW_ACTIONS.edit : null,
        delete: verbs.remove ? ROW_ACTIONS.delete : null,
        approve: verbs.decide ? ROW_ACTIONS.approve : null,
        decline: verbs.decide ? ROW_ACTIONS.decline : null,
        resolve: verbs.resolve ? ROW_ACTIONS.resolve : null,
        groupLabel: ROW_ACTIONS.groupLabel,
      })
    : null
  /* T's own action set: Complete and its own Remove. */
  const taskActions = verbs.complete || verbs.removeTask
    ? Object.freeze({
        complete: verbs.complete ? ROW_ACTIONS.complete : null,
        delete: verbs.removeTask ? ROW_ACTIONS.delete : null,
        groupLabel: ROW_ACTIONS.groupLabel,
      })
    : null
  /* A's own action set: Answer, Decline and its own Remove -- the owner's
     "answer, decline or remove" (LEDGER-KINDS-INTERFACE-20260907.md). */
  const askActions = verbs.answer || verbs.declineAsk || verbs.removeAsk
    ? Object.freeze({
        answer: verbs.answer ? ROW_ACTIONS.answer : null,
        decline: verbs.declineAsk ? ROW_ACTIONS.decline : null,
        delete: verbs.removeAsk ? ROW_ACTIONS.delete : null,
        groupLabel: ROW_ACTIONS.groupLabel,
      })
    : null
  /* THE SENTENCE AN EXAMPLE PRESS GETS (T1415): on the desktop, where the
     person turned "Show the example fleet" on, it names that switch;
     elsewhere it keeps the website's sentence. */
  const exampleNote = () => {
    let chosen = false
    try { chosen = typeof dataSourceChoice.exampleWasChosen === 'function' && dataSourceChoice.exampleWasChosen() === true } catch { chosen = false }
    return chosen ? EXAMPLE_WRITE_NOTE_CHOSEN : EXAMPLE_WRITE_NOTE
  }
  const rowCopy = Object.freeze({ scope: SCOPE_CHIP, proposed: PROPOSED_NOTE.text, filedBy: REQUEST_PANEL.filedByHint, completeOff: COMPLETE_ROW.blocked, detail: ROW_DETAIL })

  function syncModeButtons() {
    for (const button of modeGroup.querySelectorAll('button[data-mode]')) {
      const on = button.dataset.mode === mode
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    if (scopeGroup) {
      for (const button of scopeGroup.querySelectorAll('button[data-scope]')) {
        const on = button.dataset.scope === scope
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', on ? 'true' : 'false')
      }
      /* THE REACH FILTER NARROWS EVERY KIND BUT P. T, A and P records carry
         scope like R (LEDGER-KINDS-INTERFACE-20260907.md); the questions half
         of A does not, but A's kind-A records do, so the filter stays for A
         too. P is the one tab with nothing to narrow: it mounts approvals.js
         wholesale, which has no reach concept of its own. */
      scopeGroup.hidden = mode === 'p'
    }
  }

  /* Which classifier counts a row into the six tiles: R and Q keep their own
     (unchanged); T, A and 'all' pass rowKindState/questionState explicitly
     from their own render function, below. Some of T/A/P's own states
     (recurring, answered, approved) have no tile here and simply do not
     count in the strip -- the tiles are R's six, not redrawn for this
     feature; see the report for that scoping. */
  /* THE STRIP'S TILES FOLLOW THE TAB: R's six everywhere but Tasks, which
     counts in its own vocabulary (TASK_TILES). Redrawn only when the set
     changes, so a tile a reader already holds stays the same element. */
  let tiles = DEFAULT_TILES
  function useTiles(next) {
    if (next === tiles) return
    tiles = next
    if (summarySection) summarySection.innerHTML = tilesMarkup(tiles)
  }

  function renderSummary(items, { unavailable = false, stateOfItem = null, tileNote = null } = {}) {
    useTiles(mode === 't' ? TASK_TILES : DEFAULT_TILES)
    const states = tiles.map(tile => tile.state)
    const classify = stateOfItem || (mode === 'r' ? item => summaryTileOf(rowState(item)) : item => questionState(item.statusClass))
    const counts = Object.fromEntries(states.map(state => [state, 0]))
    for (const item of items) {
      const state = classify(item)
      if (Object.hasOwn(counts, state)) counts[state] += 1
    }
    for (const state of states) {
      const node = root.querySelector(`[data-summary="${state}"]`)
      if (!node) continue
      node.textContent = unavailable ? '—' : counts[state]
      // presentation only: a zero has no state to colour, and the Q register
      // leaves most of the six at zero. See .ledger-stat[data-empty].
      node.closest('.ledger-stat')?.toggleAttribute('data-empty', !unavailable && counts[state] === 0)
    }
    for (const note of root.querySelectorAll('[data-summary-note]')) {
      /* "your records" over somebody else's example numbers would be the exact
         lie the badge exists to prevent, so the note is keyed to it too. */
      note.textContent = unavailable ? '· unavailable' : (badged ? '· example data' : (tileNote || '· your records'))
    }
  }

  /* THE HISTORY NOTE. The read verifies the ledger's chained history; a break
     or a drift is said above the rows, which are still drawn -- hiding them
     would hide the evidence. Hidden whenever there is nothing to say.
     MEASURED 2026-09-03: the engine's verifyHistory() (src/lib/
     owner-request-store.js) computes `ok: drift.length === 0 && missing.length
     === 0`, so a drifted record ALWAYS reads chain.ok:false too -- ok:true
     with a non-empty drift is a shape the real read side never produces. The
     drift check used to run after an unconditional `chain.ok === false`
     return, which made it dead code: every real drift reply took the generic
     "edited in place" branch and the specific sentence naming which request
     drifted could never be reached. Drift, the more specific fact when it is
     known, is checked first; a chain that is not-ok for any other reason
     (the history file itself broken, or a record missing without a
     tombstone) still falls through to the generic sentence below. */
  function paintChainNote(chain) {
    if (!chainNote) return
    if (!chain || badged) { chainNote.hidden = true; chainNote.textContent = ''; return }
    const problems = []
    if (Array.isArray(chain.drift) && chain.drift.length > 0) problems.push(CHAIN_NOTE.drift(chain.drift))
    if (Array.isArray(chain.missing) && chain.missing.length > 0) problems.push(CHAIN_NOTE.missing(chain.missing))
    if (problems.length > 0) {
      chainNote.textContent = problems.join(' ')
      chainNote.dataset.state = 'unavailable'
      chainNote.hidden = false
      return
    }
    if (chain.ok === false) {
      chainNote.textContent = CHAIN_NOTE.broken
      chainNote.dataset.state = 'refused'
      chainNote.hidden = false
      return
    }
    chainNote.hidden = true
    chainNote.textContent = ''
  }

  /* ONE NOTICE, ONE STORY. Everything a no-rows state paints -- the paragraph,
     the register's accessible name, the counter, the state marker and whether
     the totals above are even knowable -- comes from the one object, so the
     page cannot say "could not be read" in three places while the paragraph
     between them says there is simply nothing here. */
  function paintNotice(notice, { reason = null, kind = notice.state } = {}) {
    renderSummary([], { unavailable: !notice.countsKnown })
    register.removeAttribute('role')
    register.setAttribute('aria-label', notice.label)
    const door = notice.door
      ? `<p class="ledger-empty"><a class="host-absent-action" href="${esc(GUIDE_ACTION.href)}">${esc(GUIDE_ACTION.label)}</a></p>`
      : ''
    register.innerHTML = `<p class="ledger-empty ${notice.className}">${esc(readerSentence(notice.body))}</p>${door}`
    /* The reason travels as data, never in the sentence -- the rule
       src/refusal-copy.js sets for a refusal code, applied to a read reason,
       which can be anything the read said. */
    if (reason) register.dataset.registerReason = String(reason).slice(0, 300)
    else delete register.dataset.registerReason
    root.querySelector('[data-visible-count]').textContent = notice.count
    root.dataset.projectionState = notice.state
    showHiddenToggle.hidden = true
    if (showRemovedToggle) showRemovedToggle.hidden = true
    showRegisterInForms({ kind, items: [] })
  }

  /* THE REQUESTS HALF AS LISTS, or null while the requests read is not a
     register: the reach filter and the removed filter applied to the rows
     whatever fed them, so the example narrows exactly the way the real list
     does; then the hide set, applied here and only here. Every reader of the
     list -- the totals strip, the counter, the rows, the forms' picker --
     takes the VISIBLE list, so a hidden row is hidden from all of them at once
     rather than from the rows alone while the counter above still counts it. */
  function requestLists() {
    if (!source || source.kind !== 'live') return null
    /* R ONLY (2026-09-07). Every record used to be an R; now the feed can
       carry T, A and P records too (src/ledger-live.js kindOf), and the R
       tab must draw exactly the rules, the same as it always drew every
       record because every record was one. */
    const rAll = source.data.requests.filter(item => item.kind === 'R' && matchesFind(item))
    const rItems = rAll.filter(item => (scope === 'all' || item.scope === scope) && (showRemoved || rowState(item) !== 'removed'))
    const removedShown = rItems.filter(item => rowState(item) === 'removed').length
    const hiddenKeys = new Set(hidden.list())
    const isHidden = key => hiddenKeys.has(key)
    const rShown = rItems.filter(item => !isHidden(`r:${item.id}`))
    return { rAll, rItems, rShown, rHidden: rItems.length - rShown.length, removedShown, isHidden }
  }

  /* THE STATE OF ANY ROW, WHATEVER KIND IT IS: R keeps its own gated/unmet
     reading (rowState); T, A and P read their state from kindState's own
     vocabularies. One dispatcher so 'removed' means the same thing -- hidden
     from the ordinary list, offered back by the removed toggle -- on every
     tab that shares one, rather than four copies of the same two-line
     dispatch drifting apart. */
  const rowKindState = item => (item.kind === 'R' ? rowState(item) : kindState(item, item.kind))
  /* The tile an ask counts in: open is waiting for the owner. */
  const askTile = item => (item.status === 'open' ? 'proposed' : kindState(item, 'A'))

  /* THE SAME SHAPE AS requestLists(), for T, for the kind-A records inside
     the A tab, and for the R+T+A mix on 'all' -- one register in the feed's
     shape, narrowed by reach and the removed toggle, then by the hide set.
     `kinds` is an array so 'all' can ask for more than one letter at once. */
  function kindLists(kinds) {
    if (!source || source.kind !== 'live') return null
    const kAll = source.data.requests.filter(item => kinds.includes(item.kind) && (!waitingFilter || ownerWaitingStatus(item) === waitingFilter) && matchesFind(item))
    /* The Purchases tab has no reach filter on screen, so a reach chosen on
       another tab does not narrow the purchases it lists. */
    const kItems = kAll.filter(item => (scope === 'all' || item.scope === scope || (mode === 'p' && item.kind === 'P')) && (showRemoved || rowKindState(item) !== 'removed'))
    const removedShown = kItems.filter(item => rowKindState(item) === 'removed').length
    const hiddenKeys = new Set(hidden.list())
    const isHidden = key => hiddenKeys.has(key)
    const keyOf = item => `${item.kind.toLowerCase()}:${item.id}`
    const kShown = kItems.filter(item => !isHidden(keyOf(item)))
    return { kAll, kItems, kShown, kHidden: kItems.length - kShown.length, removedShown, isHidden, keyOf }
  }

  /* THE FORMS BELOW ACT ON REQUESTS, so they are given the requests -- in
     both tabs, because Approve and Decline answer a request whichever list
     happens to be on screen. The example rows are offered too, deliberately:
     a picker that empties itself the moment the data is an example would
     hide what this surface does from the one person it is demonstrating to.
     What the example must never do is WRITE, and the fence for that sits on
     the view (see the capture listener below), not on the picker's contents.
     A removed row is not offered: nothing can be decided about it. While the
     requests read is not a register the forms get its state and no rows. */
  function offerRequestsToForms(lists) {
    if (!lists) {
      showRegisterInForms({ kind: source ? source.kind : 'loading', items: [] })
      return
    }
    showRegisterInForms({
      kind: badged ? 'simulated' : 'live',
      /* Only a rule a decision can land on (T1361): a done, superseded or
         not-possible rule used to be offered too, and every choice there was
         a refusal waiting to happen. */
      items: lists.rShown.filter(item => DECIDABLE_STATUSES.has(item.status)).map(item => ({ id: item.id, label: `${item.id} · ${item.status}` })),
    })
  }

  /* THE RULES FORM STAYS WITH THE RULES (T1361). "Approve or decline a
     request" acts on rules only; on Tasks, Asks and Purchases it offered
     rules above a list of something else, and on Purchases it put a second
     Approve, for a rule, above the purchase cards' own. */
  function syncDecisionForm() {
    const form = typeof root.querySelector === 'function' ? root.querySelector('[data-decision-form]') : null
    if (form) form.hidden = !(mode === 'r' || mode === 'all')
  }

  function paintWaitingFilter() {
    const note = typeof root.querySelector === 'function' ? root.querySelector('[data-waiting-filter]') : null
    if (!note) return
    note.hidden = !waitingFilter
    note.textContent = waitingFilter ? WAITING_FILTER[waitingFilter] : ''
    if (!waitingFilter) return
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'ledger-hidden-toggle'
    clear.dataset.clearWaiting = ''
    clear.textContent = WAITING_FILTER.clear
    note.append(' ', clear)
  }

  function endWaitingFilter() {
    if (!waitingFilter) return
    waitingFilter = null
    showHidden = false
    try { if (typeof history !== 'undefined' && /[?&]waiting=/.test(location.hash)) history.replaceState(null, '', '#/ledger') } catch { /* the address keeps it; nothing on screen does */ }
  }

  /* THE FIND BOX'S PART OF EVERY RENDER: the counter says the list is
     narrowed, and a tab with nothing matching says so in place of its
     ordinary empty sentence. */
  function paintFind() {
    if (!findText || source?.kind !== 'live' || typeof register.querySelector !== 'function') return
    const count = root.querySelector('[data-visible-count]')
    const shown = findInput && typeof findInput.value === 'string' && findInput.value.trim() ? findInput.value.trim() : findText
    if (count && !count.textContent.includes(FIND_BOX.tail(shown))) count.textContent = `${count.textContent} · ${FIND_BOX.tail(shown)}`
    if (!register.querySelector('.ledger-record')) {
      const empty = register.querySelector('.ledger-empty')
      if (empty) empty.textContent = FIND_BOX.none(shown)
    }
  }

  function renderRegister() {
    renderRegisterBody()
    paintFind()
  }

  function renderRegisterBody() {
    paintWaitingFilter()
    syncDecisionForm()
    filing?.setKind?.(mode)
    /* Filing is off, with the reason, while the Ledger cannot be read (T1382). */
    filing?.block?.(source?.kind === 'damaged' ? FILE_BOX_OFF.damaged : source?.kind === 'unreadable' ? FILE_BOX_OFF.unreadable : null)
    resetControls.update({ enabled: !badged && source?.kind === 'live' })
    custodyControls.update({ enabled: !badged && source?.kind === 'live' })
    syncModeButtons()
    syncPurchasesMount()
    /* P MOUNTS THE APPROVAL QUEUE (syncPurchasesMount) AND LISTS EVERY
       PURCHASE ON FILE HERE (T1280): an approved or recorded purchase leaves
       the queue, and used to leave the Ledger with it, while Reset purchases
       still counted it. */
    if (mode === 'p') {
      renderKindList('P')
      return
    }
    if (mode === 'a') {
      renderAsks()
      return
    }
    if (mode === 't') {
      renderKindList('T')
      return
    }
    if (mode === 'all') {
      renderAllKinds()
      return
    }
    const notice = registerNotice(source, { mode })
    if (notice) {
      rowsById = new Map()
      paintChainNote(null)
      paintNotice(notice, { reason: source.reason })
      return
    }

    /* Past the notices there is exactly one case left: a register in the
       feed's shape -- read from this copy, or the example fleet's. The two
       were made indistinguishable on purpose, so nothing below may branch on
       where it came from except the badge. */
    const lists = requestLists()
    const { rAll, rItems, rShown, rHidden, removedShown, isHidden } = lists

    /* A NOTHING-ON-FILE LEDGER SAYS SO, WITH THE DOOR TO FILING. The feed
       answered and there is no request at all -- the ordinary state of a
       fresh install, and the one a first-time reader meets. Only the whole
       ledger, unnarrowed: a filter that hides every row is the list sentence
       below, not a claim that nothing is on file. And only a ledger that was
       never written (see load: `emptyLedger`): a ledger whose every request
       was deleted answers with no rows too, but those rows are still in it as
       deleted, and the list sentence with the Show removed toggle beside it
       is the door back to them. */
    if (rAll.length === 0 && scope === 'all' && !showRemoved && source.emptyLedger) {
      rowsById = new Map()
      paintChainNote(source.data.chain)
      paintNotice(registerNotice({ kind: 'empty' }, { mode: 'r' }), { kind: 'empty' })
      root.dataset.projectionState = badged ? 'simulated' : 'empty'
      return
    }

    /* A failed questions read leaves its diagnostic on the register. The
       requests tab can still be healthy, so clear that failure-only metadata
       before drawing the readable list rather than exposing a stale reason
       beside a ready read. */
    delete register.dataset.registerReason

    /* With "Show hidden" on, the hidden rows are drawn dimmed, carry
       data-hidden, and offer the put-back control instead of the ×. */
    const rList = showHidden ? rItems : rShown
    /* THE TOTALS COUNT THE RECORDS, NOT THE ROWS SHOWN (T1544). A × hides a
       row from this list and says nothing else changes, so the tiles labelled
       "your records" keep counting it -- and keep agreeing with Home. */
    renderSummary(rItems)
    rowsById = new Map(rAll.map(item => [item.id, item]))

    const rows = []
    const drawn = new Set(rList.map(item => item.id))
    for (const item of rList) rows.push(requestMarkup(item, { hidden: isHidden(`r:${item.id}`), actions: rowActions, copy: rowCopy, names: circleNames, resolveOpen: resolvingId === item.id, drawn }))
    register.setAttribute('role', 'tree')
    register.setAttribute('aria-label', badged ? 'Example requests — not yours' : 'Your requests')
    register.innerHTML = rows.length
      ? rows.join('')
      : `<p class="ledger-empty">${esc(EMPTY_LIST.r)}</p>`
    root.querySelector('[data-visible-count]').textContent =
      `${badged ? EXAMPLE_COUNT_PREFIX : ''}${countOf(rList.length, 'rule')}${rHidden > 0 ? ` · ${HIDE_ROW.count(rHidden)}` : ''}${removedShown > 0 ? ` · ${REMOVED_TOGGLE.count(removedShown)}` : ''}`
    paintChainNote(source.data.chain)
    paintHiddenToggle(rHidden)
    /* THE REMOVED TOGGLE IS OFFERED WHENEVER THE READ ANSWERED. The reply
       carries the removed rows only when asked for them (removed: true), so
       their number is not on screen to count and the toggle cannot be keyed
       to it the way the hidden toggle is. A register whose every request was
       deleted lands here with no rows, and the toggle is the one door to the
       rows the Delete sentence promised are still on file. */
    if (showRemovedToggle) {
      showRemovedToggle.hidden = false
      showRemovedToggle.textContent = showRemoved ? REMOVED_TOGGLE.hide : REMOVED_TOGGLE.show
      showRemovedToggle.setAttribute('aria-pressed', showRemoved ? 'true' : 'false')
    }
    /* 'simulated' here is DOM VOCABULARY, not architecture: the attribute's
       two values predate the source axis and tooling reads them, so the words
       stay while the thing that decides them is now the badge alone. There is
       no second render for 'simulated' to name any more. */
    root.dataset.projectionState = badged ? 'simulated' : 'ready'
    offerRequestsToForms(lists)
  }

  /* THE T TAB: kind-T ledger records, the same shape and the same failure
     handling requestLists()/renderRegister's R body use, with T's own
     actions and empty sentence. Empty on every real install until the
     engine lane lands `kind` (see kindOf, src/ledger-live.js) -- there is no
     id in the feed today that can carry the letter T. */
  function renderKindList(kind) {
    const notice = registerNotice(source, { mode })
    if (notice) {
      rowsById = new Map()
      paintChainNote(null)
      paintNotice(notice, { reason: source.reason })
      return
    }
    const lists = kindLists([kind])
    const { kAll, kItems, kShown, kHidden, removedShown, isHidden, keyOf } = lists
    delete register.dataset.registerReason
    const kList = showHidden ? kItems : kShown
    /* Every record in the tab, hidden or not (T1544); a task counts under its
       own status, one of the Tasks tab's own tiles (T1551). */
    renderSummary(kItems, { stateOfItem: item => (kind === 'T' ? item.status : kindState(item, kind)) })
    rowsById = new Map(kAll.map(item => [item.id, item]))
    /* A purchase has no row controls here: the queue above decides it. */
    const actionsFor = kind === 'T' ? taskActions : kind === 'A' ? askActions : null
    const rows = kList.map(item => kindRecordMarkup(item, kind, { hidden: isHidden(keyOf(item)), actions: actionsFor, copy: rowCopy, names: circleNames }))
    register.setAttribute('role', 'list')
    register.setAttribute('aria-label', badged ? `Example ${KIND_FILTER[kind.toLowerCase()].toLowerCase()} — not yours` : `Your ${KIND_FILTER[kind.toLowerCase()].toLowerCase()}`)
    register.innerHTML = rows.length ? rows.join('') : `<p class="ledger-empty">${esc(EMPTY_LIST[kind.toLowerCase()])}</p>`
    root.querySelector('[data-visible-count]').textContent =
      `${badged ? EXAMPLE_COUNT_PREFIX : ''}${countOf(kList.length, kind === 'T' ? 'task' : kind === 'P' ? 'purchase' : 'ask')}${kHidden > 0 ? ` · ${HIDE_ROW.count(kHidden)}` : ''}${removedShown > 0 ? ` · ${REMOVED_TOGGLE.count(removedShown)}` : ''}`
    paintChainNote(source.data.chain)
    paintHiddenToggle(kHidden)
    if (showRemovedToggle) {
      showRemovedToggle.hidden = false
      showRemovedToggle.textContent = showRemoved ? REMOVED_TOGGLE.hide : REMOVED_TOGGLE.show
      showRemovedToggle.setAttribute('aria-pressed', showRemoved ? 'true' : 'false')
    }
    root.dataset.projectionState = badged ? 'simulated' : 'ready'
    offerRequestsToForms(requestLists())
  }

  /* THE ASKS TAB: THE OWNER'S RULING SAYS A IS Q'S SUCCESSOR, SO IT KEEPS Q'S
     OWN READ, WORD FOR WORD, AND GAINS THE NEW KIND-A LEDGER RECORDS BESIDE
     IT (LEDGER-KINDS-INTERFACE-20260907.md: "the A tab shows the existing
     questions observation (source and never-removed rule unchanged) AND the
     new kind-A ledger records"). The two are drawn as two sections inside
     one register and fail independently, the same separation R and Q always
     kept: a requests-feed failure (serving the records half, same axis R and
     T read) must not take the questions half down, and a questions-report
     failure must not take the records half down. The page-level signals
     (aria-label, the projection state, the visible-count line, the removed
     toggle) track the QUESTIONS half exactly as they did before this
     feature -- unchanged behaviour for a tab whose name changed and whose
     content grew, not whose old half moved. */
  function renderAsks() {
    const asksLists = kindLists(['A'])
    const aList = asksLists ? (showHidden ? asksLists.kItems : asksLists.kShown) : []
    const asksReadFailed = !asksLists && source && source.kind !== 'loading'
    const aRows = aList.map(item => kindRecordMarkup(item, 'A', { hidden: asksLists.isHidden(asksLists.keyOf(item)), actions: askActions, copy: rowCopy, names: circleNames }))
    /* The asks section is a wrapper only (role none), so its rows are items of
       the register's own list beside the question rows (T1408). */
    const asksSection = `<section class="ledger-asks-records" role="none">${
      aRows.length ? aRows.join('') : `<p class="ledger-empty">${esc(readerSentence(asksReadFailed ? (source?.kind === 'damaged' ? registerNotice(source, { mode: 'a' }).body : KIND_UNREADABLE.body) : EMPTY_LIST.a))}</p>`
    }</section>`

    function paintAsksNotice(notice, reason) {
      const questionsSection = `<p class="ledger-empty ${notice.className}">${esc(readerSentence(notice.body))}</p>${notice.door ? `<p class="ledger-empty"><a class="host-absent-action" href="${esc(GUIDE_ACTION.href)}">${esc(GUIDE_ACTION.label)}</a></p>` : ''}`
      rowsById = new Map()
      paintChainNote(null)
      renderSummary(asksLists ? asksLists.kItems : [], { stateOfItem: askTile, unavailable: !asksLists })
      register.removeAttribute('role')
      register.setAttribute('aria-label', notice.label)
      register.innerHTML = asksSection + questionsSection
      if (reason) register.dataset.registerReason = String(reason).slice(0, 300)
      else delete register.dataset.registerReason
      root.querySelector('[data-visible-count]').textContent = notice.count
      root.dataset.projectionState = notice.state
      showHiddenToggle.hidden = true
      if (showRemovedToggle) showRemovedToggle.hidden = true
      offerRequestsToForms(requestLists())
    }

    const observation = questions
    if (!observation) {
      /* No observation yet: the read is still out, or the page could not
         even say where data would come from (see load's resolve failure). */
      const kind = source && source.kind === 'loading' ? 'loading' : 'unreadable'
      paintAsksNotice(registerNotice({ kind }, { mode: 'q' }), kind === 'unreadable' ? source?.reason || '' : null)
      return
    }
    if (!observation.ok) {
      paintAsksNotice(registerNotice({ kind: 'unreadable' }, { mode: 'q' }), observation.reason || '')
      return
    }
    delete register.dataset.registerReason
    const qItems = observation.value.filter(item => matchesFind(item))
    const qHiddenKeys = new Set(hidden.list())
    const qIsHidden = key => qHiddenKeys.has(key)
    const qShown = qItems.filter(item => !qIsHidden(`q:${item.id}`))
    const qHidden = qItems.length - qShown.length
    const qList = showHidden ? qItems : qShown
    /* AN OPEN ASK IS WAITING FOR THE OWNER (T1265), so it counts in Waiting
       for you, the way its row already wears the owner-waiting mark. Every
       record counts, hidden or not (T1544). When the asks could not be read,
       the tiles say they count the questions alone (T1383). */
    renderSummary([...(asksLists ? asksLists.kItems : []), ...qItems], { stateOfItem: item => (item.statusClass ? questionState(item.statusClass) : askTile(item)), tileNote: asksReadFailed ? ASKS_COUNTER.tileNote : null })
    const lists = requestLists()
    rowsById = new Map(lists ? lists.rAll.map(item => [item.id, item]) : [])

    const qRows = qList.map(item => questionMarkup(item, { expanded: expandedRows.has(`q:${item.id}`), hidden: qIsHidden(`q:${item.id}`) }))
    const questionsSection = qRows.length ? qRows.join('') : `<p class="ledger-empty">${esc(EMPTY_LIST.q)}</p>`
    register.setAttribute('role', 'list')
    register.setAttribute('aria-label', badged ? 'Example asks — not yours' : 'Your asks')
    register.innerHTML = asksSection + questionsSection
    const open = qList.filter(item => item.statusClass === 'open').length
    const aHidden = asksLists ? asksLists.kHidden : 0
    const asksWaiting = aList.filter(item => item.status === 'open').length
    const asksPart = asksLists
      ? `${countOf(aList.length, 'ask')} · ${ASKS_COUNTER.waiting(asksWaiting)}${aHidden > 0 ? ` · ${HIDE_ROW.count(aHidden)}` : ''}${asksLists.removedShown > 0 ? ` · ${REMOVED_TOGGLE.count(asksLists.removedShown)}` : ''} · `
      : ''
    root.querySelector('[data-visible-count]').textContent =
      `${badged ? EXAMPLE_COUNT_PREFIX : ''}${asksPart}${countOf(qList.length, 'question')} · ${ASKS_COUNTER.open(open)}${qHidden > 0 ? ` · ${HIDE_ROW.count(qHidden)}` : ''}${asksReadFailed ? ` · ${ASKS_COUNTER.unread}` : ''}`
    paintChainNote(null)
    paintHiddenToggle(qHidden + aHidden)
    /* THE ASKS TAB OFFERS ITS OWN SHOW REMOVED (T1284). It used to hide the
       toggle while still honouring a Show removed pressed on another tab, so
       declined and deleted asks were listed with no control here to put
       them away. Questions are never removed; the asks half offers its own
       removed rows the way R, T and All do. */
    if (showRemovedToggle) {
      showRemovedToggle.hidden = !asksLists
      showRemovedToggle.textContent = showRemoved ? REMOVED_TOGGLE.hide : REMOVED_TOGGLE.show
      showRemovedToggle.setAttribute('aria-pressed', showRemoved ? 'true' : 'false')
    }
    root.dataset.projectionState = badged ? 'simulated' : 'ready'
    offerRequestsToForms(lists)
  }

  /* THE 'all' TAB: R, T and A rows in one list, R's own markup for kind R so
     it reads exactly as the R tab does, kindRecordMarkup for T and A. P is
     NOT part of 'all' -- it mounts a wholly different component (see
     syncPurchasesMount) with its own presentation-gated decision flow that
     cannot be interleaved into a plain list without either losing that gate
     or running it against rows nobody asked to see, so 'all' stays four
     kinds short of its name on purpose. Questions are not part of 'all'
     either: they are not a ledger record and have no kind. */
  function renderAllKinds() {
    const notice = registerNotice(source, { mode })
    if (notice) {
      rowsById = new Map()
      paintChainNote(null)
      paintNotice(notice, { reason: source.reason })
      return
    }
    const lists = kindLists(['R', 'T', 'A', 'P'])
    const { kAll, kItems, kShown, kHidden, removedShown, isHidden, keyOf } = lists
    delete register.dataset.registerReason
    const kList = showHidden ? kItems : kShown
    /* R's own coarsening applies here too -- 'all' mixes R rows into the
       same six tiles rowKindState already feeds, and the strip must not
       disagree with itself depending on which tab drew it. T/A rows pass
       through kindState unchanged, exactly as rowKindState already does,
       except an open ask, which is waiting for the owner (T1265). Every
       record counts, hidden or not (T1544). */
    renderSummary(kItems, { stateOfItem: item => (item.kind === 'A' ? askTile(item) : summaryTileOf(rowKindState(item))) })
    rowsById = new Map(kAll.map(item => [item.id, item]))
    const drawn = new Set(kList.map(item => item.id))
    const rows = kList.map(item => (item.kind === 'R'
      ? requestMarkup(item, { hidden: isHidden(keyOf(item)), actions: rowActions, copy: rowCopy, names: circleNames, resolveOpen: resolvingId === item.id, drawn, listItem: true })
      : kindRecordMarkup(item, item.kind, { hidden: isHidden(keyOf(item)), actions: item.kind === 'T' ? taskActions : item.kind === 'A' ? askActions : null, copy: rowCopy, names: circleNames })))
    register.setAttribute('role', 'list')
    register.setAttribute('aria-label', badged ? 'Example ledger — not yours' : 'Your whole ledger')
    register.innerHTML = rows.length ? rows.join('') : `<p class="ledger-empty">${esc(EMPTY_LIST.all)}</p>`
    root.querySelector('[data-visible-count]').textContent =
      `${badged ? EXAMPLE_COUNT_PREFIX : ''}${countOf(kList.length, 'record')}${kHidden > 0 ? ` · ${HIDE_ROW.count(kHidden)}` : ''}${removedShown > 0 ? ` · ${REMOVED_TOGGLE.count(removedShown)}` : ''}`
    paintChainNote(source.data.chain)
    paintHiddenToggle(kHidden)
    if (showRemovedToggle) {
      showRemovedToggle.hidden = false
      showRemovedToggle.textContent = showRemoved ? REMOVED_TOGGLE.hide : REMOVED_TOGGLE.show
      showRemovedToggle.setAttribute('aria-pressed', showRemoved ? 'true' : 'false')
    }
    root.dataset.projectionState = badged ? 'simulated' : 'ready'
    offerRequestsToForms(requestLists())
  }

  /* THE P TAB MOUNTS approvals.js WHOLESALE (see the import above for why:
     its presentation-gated decide flow and its per-line cart detail have no
     honest ledger-row shape). Entering P creates it; leaving P, or this view
     being destroyed, tears it down -- see destroy() below. Every other tab
     hides the slot and, on the way out of P specifically, tears the mount
     down; syncPurchasesMount is called from renderRegister on every render
     so this stays correct across a tab press, a reload, and a destroy. */
  function syncPurchasesMount() {
    if (mode !== 'p') {
      if (purchasesMount) {
        purchasesMount.destroy()
        purchasesMount = null
        if (purchasesSlot) purchasesSlot.hidden = true
      }
      if (summarySection) summarySection.hidden = false
      register.hidden = false
      return
    }
    if (summarySection) summarySection.hidden = true
    register.hidden = false
    if (fileSlot) fileSlot.hidden = true
    if (!purchasesSlot) return
    purchasesSlot.hidden = false
    /* THE P TAB IS ITS OWN MODULE (src/views/ledger-purchases.js): it mounts
       approvals.js's card renderer unmodified, with the presentation-
       verification handshake and per-line detail intact, and draws the
       checkout link gated on checkoutSurfaceAvailable() -- see that module's
       own header for why nothing here duplicates any of it. */
    if (!purchasesMount) purchasesMount = renderPurchasesTab(purchasesSlot, {})
  }

  /* The hidden toggle exists only while there is something it would show. A
     button reading "Show hidden" over a list with nothing hidden is a control
     that looks real and is not. */
  function paintHiddenToggle(hiddenCount) {
    /* While hidden rows are being shown the toggle stays, so the dimmed rows
       always have their explanation and their way back beside them. */
    showHiddenToggle.hidden = hiddenCount === 0 && !showHidden
    showHiddenToggle.textContent = showHidden ? HIDE_ROW.hideAgain : HIDE_ROW.show
    showHiddenToggle.setAttribute('aria-pressed', showHidden ? 'true' : 'false')
  }

  /* THE TOOLBAR NOTE: one sentence about the last hide or put-back, with Undo
     beside it. Tone 'note' always -- a row a person hid is not a failure. */
  function paintHiddenNote(text, { undoKey = null } = {}) {
    if (!text) {
      hiddenNote.hidden = true
      hiddenNote.textContent = ''
      return
    }
    hiddenNote.hidden = false
    hiddenNote.dataset.state = HIDE_ROW.tone
    hiddenNote.textContent = text
    if (undoKey) {
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.className = 'ledger-hidden-toggle'
      undo.dataset.undoHide = undoKey
      undo.textContent = HIDE_ROW.undo
      hiddenNote.append(' ', undo)
    }
  }

  /* A record key is 'r:R12' or 'q:Q7'; the id a person reads is the part
     after the colon, and which note to paint follows the prefix. */
  const idOfKey = key => key.slice(2)
  const hiddenSentence = key => (key.startsWith('q:') ? HIDE_ROW.hiddenQ : HIDE_ROW.hiddenR)(idOfKey(key))

  modeGroup.addEventListener('click', event => {
    const button = event.target.closest('button[data-mode]')
    if (!button || button.dataset.mode === mode) return
    endWaitingFilter()
    mode = button.dataset.mode
    writeMode(mode)
    /* Show hidden belongs to the tab it was pressed on (T1410): carried over,
       it kept a row the person just hid on screen with no toggle to say why. */
    showHidden = false
    syncModeButtons()
    /* The note was about a row on the other list; it does not follow. An
       open Edit, Answer or Decline box, and an open Resolve picker, DO follow:
       a person who looks at another tab mid-sentence gets the sentence back
       when the row is on screen again (redraw parks what it cannot reopen). */
    paintHiddenNote(null)
    redraw()
  })

  /* THE REACH FILTER RE-READS. The installed application narrows the read to
     the reach asked for; the render narrows again so the example behaves the
     same way, and so a stale wider read never leaks a row through. */
  scopeGroup?.addEventListener('click', event => {
    const button = event.target.closest('button[data-scope]')
    if (!button || !SCOPES.includes(button.dataset.scope) || button.dataset.scope === scope) return
    endWaitingFilter()
    scope = button.dataset.scope
    writeScope(scope)
    syncModeButtons()
    paintHiddenNote(null)
    void load()
  })

  root.querySelector('[data-waiting-filter]')?.addEventListener('click', event => {
    if (!event.target.closest('[data-clear-waiting]') || destroyed) return
    endWaitingFilter()
    redraw()
    modeGroup.querySelector?.('[data-mode="all"]')?.focus?.()
  })

  findInput?.addEventListener('input', () => {
    if (destroyed) return
    findText = String(findInput.value || '').trim().toLowerCase().slice(0, 200)
    redraw()
  })

  showHiddenToggle.addEventListener('click', () => {
    showHidden = !showHidden
    redraw()
  })

  /* The reload hides the toggle while it reads, which drops keyboard focus;
     it gets focus back once it is drawn again, now reading Hide removed, so
     the next Tab continues from it (T1387). */
  const removedFocus = focusKeeper()
  showRemovedToggle?.addEventListener('click', async () => {
    showRemoved = !showRemoved
    removedFocus.hold(showRemovedToggle)
    await load()
    removedFocus.restore(showRemovedToggle)
  })

  hiddenNote.addEventListener('click', event => {
    const undo = event.target.closest('button[data-undo-hide]')
    if (!undo) return
    const key = undo.dataset.undoHide
    hidden.remove(key)
    redraw()
    paintHiddenNote(HIDE_ROW.restored(idOfKey(key)))
    focusRestoredRow(idOfKey(key))
  })

  /* After Undo or put-back, focus returns to the row that came back: its ×
     (or its first control), so the keyboard is where the person left it. */
  function focusRestoredRow(id) {
    const record = register.querySelector?.(`[data-row-id="${id}"]`)
    const target = record ? (record.querySelector('[data-hide]') || record.querySelector('.ledger-ctl')) : null
    target?.focus?.()
  }

  register.addEventListener('click', event => {
    /* THE × AND ITS OPPOSITE, before the expand handler so a press on the
       control never also toggles the Q row it sits beside. */
    const hideButton = event.target.closest('button[data-hide]')
    if (hideButton) {
      const key = hideButton.dataset.hide
      const hint = hideButton.closest('.ledger-record')?.querySelector('[data-row-hint]')
      /* FIRST PRESS ARMS, SECOND ACTS. The hint under the row says what the
         second press will do and what it will not; a lone press disarms and
         the hint goes with it, so the row never sits there threatening. */
      if (!armOnce(hideButton, { onDisarm: () => { if (hint) { hint.hidden = true; hint.textContent = '' } } })) {
        if (hint) {
          hint.dataset.state = HIDE_ROW.tone
          hint.textContent = HIDE_ROW.armed(idOfKey(key))
          hint.hidden = false
        }
        return
      }
      /* NOTHING IS SENT. The key goes into this copy's own storage and the
         list is redrawn from it; the capture fence below never sees this
         press because the × carries no write attribute, and it needs no
         fence -- there was never a write here to stop. */
      let stored = false
      try { stored = hidden.add(key) } catch { paintHiddenNote(HIDE_ROW.unsaved(idOfKey(key))); return }
      if (!stored) { paintHiddenNote(HIDE_ROW.full(idOfKey(key))); return }
      redraw()
      paintHiddenNote(hiddenSentence(key), { undoKey: key })
      /* The row and its × are gone; focus goes to Undo beside the sentence,
         not to the top of the page (T1409). */
      hiddenNote.querySelector('[data-undo-hide]')?.focus?.()
      return
    }
    const unhideButton = event.target.closest('button[data-unhide]')
    if (unhideButton) {
      /* Putting a row back needs no second press: the only thing it can do is
         restore what the person is looking at. */
      const key = unhideButton.dataset.unhide
      hidden.remove(key)
      redraw()
      paintHiddenNote(HIDE_ROW.restored(idOfKey(key)))
      focusRestoredRow(idOfKey(key))
      return
    }
    const row = event.target.closest('button[data-expand]')
    if (!row) return
    const key = row.dataset.expand
    const detail = row.closest('.ledger-record').querySelector('.ledger-detail')
    const open = !expandedRows.has(key)
    if (open) expandedRows.add(key)
    else expandedRows.delete(key)
    row.setAttribute('aria-expanded', open ? 'true' : 'false')
    detail.hidden = !open
  })

  /* R'S OWN RESOLVE CONTROL, entirely in this file (owner-only, R's own
     verb): resolveStandingRequest lives in a bridge Worker 4 builds
     elsewhere, and ledger-row-actions.js's own ACTIONS set does not include
     'resolve' -- it ignores this button's press outright -- so the whole
     interaction (open the picker, choose a status, an optional reason,
     submit or cancel) is handled here, never routed through that module,
     matching the owner's file-scope for this piece. The example fence above
     already stops the opening press (data-row-action) and the submit press
     (data-resolve-submit) on a badged row, so nothing below ever reaches a
     real write from the example register. */
  register.addEventListener('click', async event => {
    const openButton = event.target.closest('button[data-row-action="resolve"]')
    if (openButton) {
      const next = openButton.dataset.id || null
      /* One picker at a time: opening another row's drops this one's choice. */
      if (next !== resolvingId) heldPicker = null
      resolvingId = next
      redraw()
      return
    }
    const cancelButton = event.target.closest('[data-resolve-cancel]')
    if (cancelButton) {
      resolvingId = null
      heldPicker = null
      redraw()
      return
    }
    const submitButton = event.target.closest('[data-resolve-submit]')
    if (!submitButton) return
    if (resolvePending) return
    const id = submitButton.dataset.id
    const record = submitButton.closest('.ledger-record')
    const hint = record && typeof record.querySelector === 'function' ? record.querySelector('[data-row-hint]') : null
    const say = (text, tone = 'note') => {
      if (!hint) return
      hint.textContent = text || ''
      hint.dataset.state = tone
      hint.hidden = !text
    }
    /* Defensive: the button that opens this picker is only ever drawn when
       verbs.resolve is true, so this is not reachable from the page's own
       controls -- kept because the picker's own markup, once open, no
       longer re-checks the verb the way rowActionsMarkup did to draw it. */
    if (!verbs.resolve) { say(RESOLVE_ROW.unavailableWrite, 'unavailable'); return }
    const statusInput = record && typeof record.querySelectorAll === 'function'
      ? [...record.querySelectorAll('[data-resolve-status]')].find(input => input.checked === true) || null
      : null
    const status = statusInput && typeof statusInput.value === 'string' ? statusInput.value : ''
    if (typeof id !== 'string' || id === '' || !RESOLVE_STATUSES.some(entry => entry.value === status)) return
    const reasonInput = record && typeof record.querySelector === 'function' ? record.querySelector('[data-resolve-reason]') : null
    const reason = reasonInput && typeof reasonInput.value === 'string' ? reasonInput.value.trim() : ''
    const label = RESOLVE_STATUSES.find(entry => entry.value === status)?.label || status
    /* Longer than the store keeps: said before sending; the reason stays. */
    if (utf8Bytes(reason) > LEDGER_LIMITS.reasonBytes) { say(ledgerRefusalSentence('R_LEDGER_REASON_INVALID'), 'refused'); return }
    /* SAVE WITH NOTHING CHANGED CHANGES NOTHING: the same status and no
       reason would only add a line to the rule's history. */
    if (rowsById.get(id)?.status === status && !reason) { say(RESOLVE_ROW.unchanged(id, label)); return }
    /* A FINAL STATUS TAKES TWO PRESSES, like Delete. Done, Not possible as
       asked and Superseded take the rule off the standing list for good: the
       store resolves only from a standing status, so nothing on this page can
       put it back. The first press says so; the second resolves. */
    if (RESOLVE_FINAL.has(status) && !armOnce(submitButton, { onDisarm: () => say('') })) {
      say(RESOLVE_ROW.finalArmed(id, label))
      return
    }
    /* Armed on Done, then switched to a standing status: this press sends,
       and the Save button stops reading as armed. */
    if (!RESOLVE_FINAL.has(status) && submitButton.dataset?.armed === 'true') armOnce(submitButton)
    resolvePending = true
    let answer = null
    let failure = null
    try {
      answer = await bridge.resolveStandingRequest({ id, status, ...(reason ? { reason } : {}) })
    } catch (error) {
      failure = error
    }
    resolvePending = false
    if (answer && answer.ok === true) {
      resolvingId = null
      focusRowAfterLoad = id
      await load()
      return
    }
    /* The store's own typed code, translated the way every other refusal on
       this page is (ledger-row-actions.js's own refusalSentence does the
       same for edit/delete/decide): a row that stopped standing between the
       picker opening and the press landing gets RESOLVE_ROW.gone, anything
       else gets the plain failed sentence. */
    const code = (failure && typeof failure.code === 'string' && failure.code)
      || (failure && typeof failure.message === 'string' ? (failure.message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []).at(-1) : '')
      || ''
    const sentence = (code === 'AGENT_REQUEST_ENTRY_UNKNOWN' || code === 'AGENT_REQUEST_STATUS_INVALID')
      ? RESOLVE_ROW.gone(id)
      : ledgerRefusalSentence(code) || RESOLVE_ROW.failed
    say(sentence, 'refused')
  })

  /* AN EXAMPLE NEVER ISSUES A WRITE. The example register fills the picker so
     a person can see exactly what this surface does -- but a press must not
     become a record. This matters beyond the signed-out page: the example
     toggle works on the desktop too, where the audited connection is real, a
     press really would land, and a picked example id could collide with a
     real request's id. The fence sits where the knowledge is: the press is
     stopped here in the capture phase, before any surface's own handler can
     run, and the person is told nothing was sent. Every write control on the
     page is fenced together -- Approve and Decline, Claim and Close, the row
     controls and the file box -- because a page marked as an example must not
     reach a real process through ANY of its buttons, the same line
     src/views/agent.js draws for its own page. */
  root.addEventListener('click', event => {
    if (!badged) return
    /* data-row-action already covers the Resolve BUTTON that would open the
       picker, so an example row never opens one; data-resolve-submit is
       named here too, belt and suspenders, exactly as this comment already
       promised for every write control on the page. */
    const button = event.target.closest('button[data-decision], button[data-queue-operation], button[data-ledger-file], button[data-row-action], button[data-resolve-submit]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const output = button.closest('form')?.querySelector('[data-action-output]')
      || button.closest('.ledger-record')?.querySelector('[data-row-hint]')
    if (output) {
      output.dataset.state = 'note'
      output.textContent = exampleNote()
      output.hidden = false
    }
  }, true)

  syncModeButtons()
  const detachSeg = attachSeg(modeGroup)
  const detachScopeSeg = scopeGroup ? attachSeg(scopeGroup) : () => {}

  /* THE PERSON'S HAND, MOUNTED ONCE. Both modules reload the register through
     load() after a write the bridge accepted, so what is on screen is always
     what is on file and never a guess about what the write did. */
  const rowHand = mountLedgerRowActions(register, {
    bridge,
    /* After a write the row is redrawn and the pressed control is gone with
       it, so the reload is told which row to hand focus back to. */
    onChanged: change => { focusRowAfterLoad = change && typeof change.id === 'string' ? change.id : null; return load() },
    /* A DELETE OR A DECLINE TAKES THE ROW AWAY, so the page says what
       happened and where the row went, in the note a hide already uses. */
    /* A refusal because the record moved on (an agent answered the ask
       first, the task was blocked): re-read, and keep the sentence on the
       row and the person's words in its box across the reload. */
    onStale: ({ id, sentence } = {}) => {
      if (destroyed) return undefined
      hintAfterLoad = typeof id === 'string' && sentence ? { id, sentence } : null
      return load()
    },
    onOutcome: outcome => {
      noteAfterLoad = outcome?.verb === 'delete' ? DELETE_ROW.deleted(outcome.removed || [outcome.id])
        : outcome?.verb === 'decide' && outcome.decision === 'decline' ? DECIDE_ROW.declined(outcome.id)
          : null
    },
    rowOf: id => rowsById.get(id) || null,
    exampleNote,
    /* A rule's live refinements, named before a Delete takes them with it. */
    refinementsOf: id => [...rowsById.values()]
      .filter(item => typeof item.id === 'string' && item.id.startsWith(`${id}.`) && rowKindState(item) !== 'removed')
      .map(item => item.id),
    isBadged: () => badged,
  })
  const destroyRowActions = rowHand.destroy
  let storage = null
  try { storage = typeof window === 'undefined' ? null : window.localStorage } catch { storage = null }
  const destroyFileBox = mountLedgerFileBox(fileSlot, {
    kind: mode,
    bridge,
    storage,
    onFiled: () => load(),
    isBadged: () => badged,
    exampleNote,
  })
  filing = destroyFileBox

  /* WHAT A REDRAW MUST NOT TAKE AWAY. Every load() repaints the register from
     the answer, and a person can have an editor open with half a sentence in
     it -- or a reason typed under Decline -- while a reload lands: the reach
     filter, Show removed, another row's write, the host announcing the world
     changed. So the open boxes are held by row before the loading repaint and
     reopened, with the same text, once the rows are back on screen. A row
     that the answer no longer carries has nowhere to reopen, and its text is
     the one thing a reload can still lose. */
  function holdOpenBoxes() {
    const held = []
    if (typeof register.querySelectorAll !== 'function') return held
    for (const field of register.querySelectorAll('[data-row-editor-words]')) {
      const record = typeof field.closest === 'function' ? field.closest('.ledger-record') : null
      const id = record && record.dataset ? record.dataset.rowId : null
      /* Edit and Answer share this one field (src/ledger-row-actions.js
         editorMarkup); its own data-editor-purpose says which box a reload
         must reopen, so an open Answer box never comes back as an Edit box
         gated on the wrong verb. */
      const kind = field.dataset && field.dataset.editorPurpose === 'answer' ? 'answer' : 'editor'
      if (typeof id === 'string' && id !== '') held.push({ id, kind, value: typeof field.value === 'string' ? field.value : '' })
    }
    for (const field of register.querySelectorAll('[data-row-reason]')) {
      const record = typeof field.closest === 'function' ? field.closest('.ledger-record') : null
      const id = record && record.dataset ? record.dataset.rowId : null
      if (typeof id === 'string' && id !== '') held.push({ id, kind: 'reason', value: typeof field.value === 'string' ? field.value : '' })
    }
    return held
  }

  /* A BOX WHOSE ROW IS NOT ON SCREEN IS PARKED, NOT DROPPED. A tab change, a
     reach filter or Show hidden can take the row a person is typing under off
     the screen for a while; the box and its words wait here and come back the
     next time that row is drawn. A box the person closes (Cancel, Save) is
     never held, so it never comes back. */
  let parkedBoxes = []
  function reopenBoxes(held) {
    const heldKeys = new Set(held.map(box => `${box.id} ${box.kind}`))
    const pending = [...parkedBoxes.filter(box => !heldKeys.has(`${box.id} ${box.kind}`)), ...held]
    parkedBoxes = pending.filter(box => !rowHand.reopen(box))
  }

  /* THE RESOLVE PICKER'S CHOICE AND REASON, held the same way. The picker is
     drawn from resolvingId on every render, so it comes back open by itself;
     what a redraw would lose is the status the person picked and the reason
     they typed. */
  let heldPicker = null
  function holdResolvePicker() {
    if (!resolvingId || typeof register.querySelector !== 'function') return heldPicker
    const record = register.querySelector(`[data-row-id="${resolvingId}"]`)
    const slot = record ? record.querySelector('[data-resolve-slot]') : null
    if (!slot || slot.hidden) return heldPicker
    const checked = [...slot.querySelectorAll('[data-resolve-status]')].find(input => input.checked === true)
    const reason = slot.querySelector('[data-resolve-reason]')
    return { id: resolvingId, status: checked ? checked.value : null, reason: reason && typeof reason.value === 'string' ? reason.value : '' }
  }
  function reopenResolvePicker(state) {
    heldPicker = state && state.id === resolvingId ? state : null
    if (!heldPicker || typeof register.querySelector !== 'function') return
    const record = register.querySelector(`[data-row-id="${heldPicker.id}"]`)
    const slot = record ? record.querySelector('[data-resolve-slot]') : null
    if (!slot || slot.hidden) return
    if (heldPicker.status !== null) {
      for (const input of slot.querySelectorAll('[data-resolve-status]')) input.checked = input.value === heldPicker.status
    }
    const reason = slot.querySelector('[data-resolve-reason]')
    if (reason) reason.value = heldPicker.reason
  }

  /* EVERY REDRAW THAT IS NOT A RELOAD. renderRegister rebuilds every row's
     markup, so a hide, a put-back, Undo, Show hidden, a tab change and
     opening or closing Resolve all used to throw away a half-typed answer,
     edit or reason on any other row. They all come through here now, and so
     keep what load() already kept. */
  function redraw() {
    const held = holdOpenBoxes()
    const picker = holdResolvePicker()
    renderRegister()
    reopenBoxes(held)
    reopenResolvePicker(picker)
  }

  /* WHERE FOCUS LANDS AFTER A ROW WRITE. The write's own control is gone
     with the redraw, so focus would fall to the page. It goes to the first
     control of the row that was written, or to the row's hint when the row
     has no control left (it is removed now), or to the register itself when
     the row is no longer drawn. */
  function restoreFocus() {
    const id = focusRowAfterLoad
    focusRowAfterLoad = null
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || typeof register.querySelector !== 'function') return
    const record = register.querySelector(`[data-row-id="${id}"]`)
    record?.scrollIntoView?.({ block: 'nearest' })
    let target = record ? (record.querySelector('.ledger-ctl') || record.querySelector('[data-row-hint]')) : null
    /* The row is gone and the note says where it went: focus goes there, so
       a keyboard or screen reader user hears what the second press did. */
    if (!target && !hiddenNote.hidden && hiddenNote.textContent) {
      hiddenNote.setAttribute('tabindex', '-1')
      target = hiddenNote
    }
    if (!target) {
      register.setAttribute('tabindex', '-1')
      target = register
    }
    if (target && typeof target.focus === 'function') target.focus()
  }

  async function load({ reask = false } = {}) {
    /* A reload answers whatever a waiting quiet update would have shown. */
    waitingUpdate = null
    paintUpdateNote(null)
    const version = ++requestVersion
    const held = holdOpenBoxes()
    const picker = holdResolvePicker()
    source = { kind: 'loading' }
    questions = null
    paintHiddenNote(null)
    renderRegister()
    const note = noteAfterLoad
    noteAfterLoad = null
    const rowHint = hintAfterLoad
    hintAfterLoad = null
    const paint = () => {
      renderRegister()
      reopenBoxes(held)
      reopenResolvePicker(picker)
      if (note) paintHiddenNote(note)
      if (rowHint && typeof register.querySelector === 'function') {
        const hint = register.querySelector(`[data-row-id="${rowHint.id}"]`)?.querySelector('[data-row-hint]')
        if (hint) { hint.textContent = rowHint.sentence; hint.dataset.state = 'refused'; hint.hidden = false }
      }
      restoreFocus()
    }
    /* Resolution is async because on a public origin the relay-versus-mock
       answer needs the host asked for its transport; the loading notice is
       already on screen, so nothing is blank while the question is out. Note
       data-live-mode is NOT set yet: before the answer arrives the page does
       not know what world it is in, and stamping either word early would be
       a guess -- the same rule currentDataSource() states for its null. */
    let origin
    try {
      origin = await resolveDataSource({ reask })
    } catch (error) {
      /* No verdict at all: the page cannot say where data would even come
         from. That is a read that did not answer, and it wears the words a
         read that did not answer has earned -- never a quiet default to some
         source, which would either badge real data or unbadge the example. */
      if (destroyed || version !== requestVersion) return
      source = { kind: 'unreadable', reason: error?.message || String(error) }
      paint()
      return
    }
    if (destroyed || version !== requestVersion) return
    badged = sourceIsBadged(origin)
    /* The hide set follows the badge: the example list and the real list
       keep separate sets, re-bound here at the one place the badge is set. */
    hidden = createHiddenRows(badged ? HIDDEN_KEY_EXAMPLE : HIDDEN_KEY_LIVE)
    /* AND SO DO THE NAMES, for the same reason and at the same line. The
       example register is shaped exactly like a real one down to its ids, so
       naming its rows out of the person's OWN saved trees would print their
       real circles beside somebody else's example rules -- the precise mix the
       badge exists to prevent. The example's own rows carry their labels. */
    circleNames = badged ? new Map() : nodeNamesByKey(storedFleetTrees(storage), { roleLabel })
    /* 'live'/'simulated' is the attribute's established vocabulary and tools
       key on it, so the words survive -- but they are derived from the source
       axis now, not from a second render path. mock -> 'simulated'. */
    root.dataset.liveMode = badged ? 'simulated' : 'live'
    if (badged) {
      /* The example register lands in the SAME assignment a fetched one does:
         kind 'live', data in the feed's shape. Everything downstream of this
         line is shared with the real path, which is what makes the badge
         trustworthy -- it is the only difference left. A fresh Date.now()
         per resolution keeps the sample's stamps reading as recent. */
      source = { kind: 'live', data: sampleLedgerData(Date.now()), emptyLedger: false }
      questions = source.data.questions
      paint()
      return
    }
    return fetchLiveLedger({ scope, removed: showRemoved }).then(result => {
      if (destroyed || version !== requestVersion) return
      /* THE DISTINCTION IS IN THE ANSWER. A read that answered -- with rows,
         or with none -- is a register; a read that fell over is a fault with
         a different repair, and collapsing the two is why this page once told
         a person his request list could not be read when it was simply empty.
         An answered list with nothing in it is the ordinary state of a fresh
         install, and the render says so with the door to filing -- but only
         when the ledger was never written (`exists` false). A ledger whose
         every request was deleted answers with no rows and `exists` true:
         those rows are still in it as deleted, and the list sentence with the
         Show removed toggle beside it is the honest render of that.
         THE QUESTIONS OBSERVATION RIDES ON BOTH KINDS OF REPLY and is kept
         apart from the requests verdict, so the Q tab renders from it
         whatever happened to the requests read. */
      if (result.ok) {
        source = { kind: 'live', data: result.data, emptyLedger: result.data.requests.length === 0 && result.data.exists !== true }
        questions = result.data.questions
        /* A read of every reach is the whole ledger (removed rows too when
           asked): hides for records it no longer carries stop taking room. */
        if (scope === 'all') {
          try { hidden.prune(new Set(result.data.requests.map(item => `${String(item.kind || 'R').toLowerCase()}:${item.id}`))) } catch { /* the list stays as it was */ }
        }
      } else {
        if (result.data) source = { kind: 'empty', reason: result.reason }
        /* A file that is damaged, not a read that did not answer (T1382). */
        else if (result.code === 'AGENT_LEDGER_DAMAGED') source = { kind: 'damaged', reason: result.reason, backup: result.backup === true }
        else source = { kind: 'unreadable', reason: result.reason }
        questions = result.questions && typeof result.questions === 'object'
          ? result.questions
          : { ok: false, reason: result.reason, observedAt: null, value: [] }
      }
      paint()
    }, error => {
      if (destroyed || version !== requestVersion) return
      const reason = error?.message || String(error)
      source = { kind: 'unreadable', reason }
      questions = { ok: false, reason, observedAt: null, value: [] }
      paint()
    })
  }

  /* THE LIST FOLLOWS THE LEDGER WHILE IT IS OPEN (T1315). Agents file and
     change tasks, asks and rules all the time, and Home's circle already
     counts what they file; this page used to show them only after leaving and
     coming back. It re-reads quietly every few seconds while it is on screen,
     with the same filters, and redraws only when the answer changed. A person
     typing in a box on this page is never redrawn under: the change waits
     behind a "Show the changes" button, and the typed text stays either way
     (redraw keeps every open box). A quiet read that fails leaves the last
     records on screen and says so. Nothing here writes. */
  const updateNote = root.querySelector('[data-ledger-update]')
  let refreshTimer = null
  let refreshing = false
  let waitingUpdate = null
  const snapshotKey = data => (data ? JSON.stringify([data.revision, data.updatedAt, data.exists, data.requests.length,
    data.requests.map(item => [item.id, item.status, item.words.length, item.history.length]),
    data.questions && data.questions.ok, data.questions && data.questions.value && data.questions.value.length]) : '')
  function personIsTyping() {
    if (resolvePending || typeof document === 'undefined') return resolvePending
    const active = document.activeElement
    /* The find box is not a record being edited: a redraw leaves it alone. */
    if (active && active === findInput) return false
    return Boolean(active && active !== document.body && typeof root.contains === 'function' && root.contains(active)
      && /^(INPUT|TEXTAREA|SELECT)$/.test(String(active.tagName || '')))
  }
  function paintUpdateNote(text, { offer = false } = {}) {
    if (!updateNote) return
    updateNote.hidden = !text
    updateNote.textContent = text || ''
    if (!offer) return
    const show = document.createElement('button')
    show.type = 'button'
    show.className = 'ledger-hidden-toggle'
    show.dataset.showUpdates = ''
    show.textContent = LEDGER_UPDATES.show
    updateNote.append(' ', show)
  }
  function applyUpdate(result) {
    const scroller = typeof document === 'undefined' ? null : document.scrollingElement
    const top = scroller ? scroller.scrollTop : null
    source = { kind: 'live', data: result.data, emptyLedger: result.data.requests.length === 0 && result.data.exists !== true }
    questions = result.data.questions
    waitingUpdate = null
    paintUpdateNote(null)
    redraw()
    if (scroller && Number.isFinite(top)) scroller.scrollTop = top
  }
  async function refreshQuietly() {
    if (destroyed || badged || refreshing || source?.kind !== 'live') return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const version = requestVersion
    refreshing = true
    let result = null
    try { result = await fetchLiveLedger({ scope, removed: showRemoved }) } catch { result = null }
    refreshing = false
    if (destroyed || badged || version !== requestVersion || source?.kind !== 'live') return
    if (!result || result.ok !== true) { waitingUpdate = null; paintUpdateNote(LEDGER_UPDATES.unreadable); return }
    if (snapshotKey(result.data) === snapshotKey(source.data)) {
      if (!waitingUpdate) paintUpdateNote(null)
      return
    }
    if (personIsTyping()) {
      waitingUpdate = result
      paintUpdateNote(LEDGER_UPDATES.waiting, { offer: true })
      return
    }
    applyUpdate(result)
  }
  function scheduleRefresh() {
    if (destroyed) return
    refreshTimer = setTimeout(async () => {
      /* A page that was taken off the screen without being destroyed stops
         here rather than reading on in the background for good. */
      if (destroyed || root.isConnected === false) return
      try { await refreshQuietly() } catch { /* the next tick tries again */ }
      scheduleRefresh()
    }, LEDGER_REFRESH_MS)
    if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref()
  }
  updateNote?.addEventListener('click', event => {
    if (!event.target.closest('[data-show-updates]') || !waitingUpdate || destroyed) return
    applyUpdate(waitingUpdate)
  })

  /* The event deliberately carries no verdict -- a verdict in an event payload
     is how two views end up in different worlds -- so the whole response is to
     re-resolve and re-render. reask: true because the moment this fires is
     exactly the moment a transport may have just appeared (a sign-in), and it
     is harmless when one is already installed. */
  const onDataSourceChanged = () => { void load({ reask: true }) }
  window.addEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)
  /* A link that named a record lands focus on its row once it is drawn. */
  if (askedId) focusRowAfterLoad = askedId
  void load()
  scheduleRefresh()

  return {
    el: root,
    destroy() {
      statusColors.destroy()
      resetControls.destroy()
      custodyControls.destroy()
      destroyWriteSurface()
      destroyRowActions()
      destroyFileBox()
      /* THE MOUNTED PURCHASES VIEW OUTLIVES NOTHING. Its own poll timer must
         stop the instant this page goes away, the same as the ledger's own
         load() does via requestVersion below -- a safety net beside
         syncPurchasesMount's own teardown on leaving the P tab, for the case
         this view is destroyed WHILE P is still open. */
      if (purchasesMount) { purchasesMount.destroy(); purchasesMount = null }
      destroyed = true
      requestVersion += 1
      clearTimeout(refreshTimer)
      waitingUpdate = null
      window.removeEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)
      detachSeg()
      detachScopeSeg()
    },
  }
}
