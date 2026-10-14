/* WHICH RULE-SCOPES AN AGENT IN A TREE IS ACTUALLY UNDER, and the words the
 * surface uses to say so.
 *
 * THE CONTRACT THIS FILE EXISTS TO HOLD. Two things in this product decide
 * what a tree agent is told at boot, and until now only one of them was
 * written down:
 *
 *   the START carries `requestKeys` — treeAnchors and threadId — and the
 *   engine's onboarding injects those ledgers beside the global layer
 *   the RAIL shows a person the rules this circle carries
 *
 * If those two derive their scopes separately they drift, and the drift is
 * invisible in the worst direction: the panel shows a person rules their
 * agents are not getting, or hides rules they are. So the derivation lives
 * here, in a module with no DOM and no stylesheet, both callers use it, and
 * tools/test/tree-standing-requests.test.mjs runs it.
 *
 * THE PANEL'S OWN BODY LIVES HERE TOO (O7 improvements, owner 2026-08-22:
 * "its a hand edit tool. for the user to go in on the toolsenabled ledger and
 * hand edit or delete them"). The rules panel draws each entry with Edit and
 * a two-press Delete; the markup builder and the press handler below are pure
 * over the element they are handed, so tools/test/rules-panel-edit.test.mjs
 * can press them against a stand-in body and a recording bridge. The view
 * (src/views/computers.js, mountStandingRequests) reads the ledgers and hands
 * this module the body to paint; it keeps no copy of the markup.
 *
 * WHY IT IS NOT IN src/views/computers.js. That file imports board.css, so
 * `node --test` cannot load it at all — a rule proven only by reading the
 * view is a rule nothing checks.
 */

import { armOnce } from './arm-press.js'

/* THE ORDER IS THE PRECEDENCE, and it is stated rather than implied.
 *
 * Broadest first, narrowest last: what the whole computer is told, then the
 * tree from its top down to this circle, then this circle's own thread, then
 * its running session. A rule written closer to the agent is the more
 * specific instruction, which is the ordinary reading of instructions and the
 * order the engine's own onboarding lays them out in. */
export const SCOPE_ORDER = Object.freeze(['global', 'tree', 'thread', 'session'])

/**
 * The scopes one circle's agents are under, in precedence order.
 *
 * @param node     the tree node — its id is the thread anchor, its sessionId
 *                 the session anchor when one is really running.
 * @param anchors  the tree anchors for this node, from the SAME derivation a
 *                 start uses (treeAnchorsFor in src/views/computers.js).
 *
 * A SESSION SCOPE ONLY WHEN A SESSION EXISTS. Filing a session rule against a
 * circle with no session is already refused by the filing path with its own
 * sentence; offering to READ one would promise a ledger that cannot exist.
 */
export function standingRequestScopesFor(node = {}, { anchors = [] } = {}) {
  const scopes = [{ scope: 'global', key: null }]
  for (const anchor of anchors) {
    if (typeof anchor === 'string' && anchor !== '') scopes.push({ scope: 'tree', key: anchor })
  }
  if (typeof node.id === 'string' && node.id !== '') scopes.push({ scope: 'thread', key: node.id })
  if (typeof node.sessionId === 'string' && node.sessionId !== '') {
    scopes.push({ scope: 'session', key: node.sessionId })
  }
  return scopes
}

/* THE WORDS. Every sentence this surface says lives here for the same reason
   src/fleet-tree-copy.js exists: one flow rendered in more than one place
   becomes more than one voice inside a week. */
export const REQUEST_PANEL = Object.freeze({
  title: 'Instructions these agents follow',
  /* THE PRECEDENCE, IN ONE SENTENCE — the brief's statement 5. It says what
     the product DOES rather than what it intends, and it is the same order
     SCOPE_ORDER above performs. */
  precedence: 'Every agent here is told all of these when it starts, widest first. A rule written for this circle is read last, so it refines the ones above it.',
  scopeLabel: Object.freeze({
    global: 'Everywhere on this computer',
    tree: 'This tree',
    thread: 'This conversation only',
    session: 'The session running now',
  }),
  /* WRITING one is the command a person already has. The panel does not
     duplicate the composer; it names the command and gets out of the way. */
  howToAdd: 'Add one by typing /RequestTree followed by the rule in the message box.',
  /* AND CHANGING OR REMOVING ONE IS A PRESS HERE, on the person's own hand:
     the product rewrites one record in place, and a deleted rule is kept in
     the ledger as deleted -- nothing is ever shortened out of it. The Ledger
     page shows every rule with its history. */
  howToRemove: 'Edit or delete any rule right here. A deleted rule stays in your records as deleted, and the Ledger page keeps the history.',
  /* The box is drawn with its heading before the read answers, so the panel
     never flashes in as a new box under the person's eye. This is what the
     body says for that instant, and it is a statement about THIS COPY rather
     than about the rules — "none" has not been established yet. */
  reading: 'Reading the rules these agents are given.',
  empty: 'No rules written for these agents yet. They still get the standing requests for the whole computer.',
  unavailable: 'This copy could not read your standing requests, so this is not a list of none.',
  /* An id is shown because it is how a person finds the entry in the file
     they are being told to edit. It is the ONE identifier on this panel, and
     it is the owner's own numbering, not an internal key. */
  entryHint: id => `Filed as ${id}`,
  /* WHO WROTE IT, when it was an agent and not the person. With "Turning
     something you said into a standing rule" on, an agent files the rule in
     the person's words under its own name; the panel says so beside the id,
     because a rule the person does not remember typing needs its author
     named before they go hunting for it in the file. The name is the agent's
     own (codex, claude), never an internal key. */
  filedByHint: who => `filed by your agent ${who}`,
  /* A REFINEMENT. The ledger's dotted ids (R3.1 under R3) mean "this narrows
     the one above"; the panel draws it indented under its parent and says so
     beside the id, so a person reading R3.1 knows which rule it belongs to. */
  refinementHint: parentId => `refinement of ${parentId}`,
  /* A RULE AN AGENT FILED THAT NOBODY HAS APPROVED YET. With "Approving a
     rule an agent filed before it counts" on, the rule waits on the Ledger
     page; the rail says so beside the id, because a rule that is listed here
     and not yet in force would otherwise read as one that is. */
  awaitingHint: 'waiting for your approval on the Ledger page',

  /* THE PERSON'S HAND. Edit turns the words into a box with Save and Cancel;
     Save sends the new words exactly as typed. Delete takes two presses, and
     the first one says what the second will do. */
  edit: 'Edit',
  delete: 'Delete',
  save: 'Save',
  cancel: 'Cancel',
  editAria: id => `Edit ${id}`,
  deleteAria: id => `Delete ${id}`,
  editorLabel: id => `The words of ${id}`,
  deleteArmed: id => `Delete ${id}? Press again. It stays in the ledger as deleted, and agents stop reading it at their next start.`,
  /* Refusals, each a plain sentence under the entry it belongs to. */
  editEmpty: 'Type the rule first. An empty rule is not saved, and the old words stay.',
  editFailed: 'That change was not saved, so the old words stay. Try once more.',
  deleteFailed: 'That rule was not removed. Try once more.',
  entryGone: id => `${id} is not in this ledger any more, so nothing was changed.`,
  tooLong: 'That rule is too long to save. Shorten it and try again.',
  heading: 'A line starting with "## " would read as a new ledger entry. Reword the rule and try again.',
  unavailableWrite: 'This build cannot change standing requests from here yet. Update ToolsEnabled on the computer you are driving, or edit its ledger file.',
  editUnavailable: 'This build cannot edit standing requests from here yet. Update ToolsEnabled on the computer you are driving, or edit its ledger file.',
  deleteUnavailable: 'This build cannot delete standing requests from here yet. Update ToolsEnabled on the computer you are driving, or edit its ledger file.',
  readOnly: 'This screen may read the rules but not change them from here.',
})

/* ---------------------------------------------------------------------------
 * THE DOTTED IDS. The ledger files R3.1 under R3 (the engine's r-ledger.js,
 * through request-id.js's dotted grammar); the reader this panel is fed by
 * hands back ids and words only, so the parent is read off the id here: the
 * text before the last dot. A root has none.
 * ------------------------------------------------------------------------- */
export function requestParentId(id) {
  const text = typeof id === 'string' ? id : ''
  const at = text.lastIndexOf('.')
  return at > 0 ? text.slice(0, at) : null
}

const keyOf = entry => (entry && typeof entry.key === 'string' ? entry.key : '')

/**
 * Reading order for one layer: each entry followed by its refinements, depth
 * first, file order kept among siblings. A child nests only under a parent
 * from the SAME ledger (same key): two tree anchors can both hold an RT1, and
 * RT1.1 belongs to exactly one of them. A child whose parent is gone (a hand
 * edit) lists at the top with its parentId still set, so nothing standing is
 * ever hidden. Every row carries `depth` (0 for a root) and `parentId`.
 */
export function nestStandingRequests(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string' && entry.id !== '')
  const standing = new Set(list.map(entry => `${keyOf(entry)} ${entry.id}`))
  const children = new Map()
  const roots = []
  for (const entry of list) {
    const parentId = requestParentId(entry.id)
    const parentKey = parentId ? `${keyOf(entry)} ${parentId}` : null
    if (parentKey && standing.has(parentKey)) {
      if (!children.has(parentKey)) children.set(parentKey, [])
      children.get(parentKey).push(entry)
    } else {
      roots.push(entry)
    }
  }
  const out = []
  const walk = (entry, depth) => {
    out.push(Object.freeze({ ...entry, depth, parentId: requestParentId(entry.id) }))
    for (const child of children.get(`${keyOf(entry)} ${entry.id}`) || []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return out
}

/* ---------------------------------------------------------------------------
 * THE BODY OF THE PANEL: groups of entries by scope, each entry with its
 * words, its hint line, Edit and Delete, and a hint slot under it for the
 * armed sentence or a refusal. One entry at a time may be in its editing
 * state, drawn as a text box with Save and Cancel in place of the words.
 * ------------------------------------------------------------------------- */

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

/* Children are indented under their parent. The board stylesheet is not this
   module's to edit, so the indent is the one inline measure on the panel:
   sixteen pixels per level, the board's own small step. */
const INDENT_PX = 16

function entryMarkup(entry, {
  editing = null,
  draft = '',
  note = null,
  canEdit = true,
  canRemove = true,
  writeReason = null,
  escape = escapeText,
} = {}) {
  const id = entry.id
  const key = typeof entry.key === 'string' && entry.key !== '' ? ` data-request-key="${escape(entry.key)}"` : ''
  const depth = Number.isInteger(entry.depth) && entry.depth > 0 ? entry.depth : 0
  const indent = depth > 0 ? ` style="margin-left: ${depth * INDENT_PX}px"` : ''
  const parentId = entry.parentId === undefined ? requestParentId(id) : entry.parentId
  const hints = [REQUEST_PANEL.entryHint(id)]
  if (parentId) hints.push(REQUEST_PANEL.refinementHint(parentId))
  if (entry.filedBy) hints.push(REQUEST_PANEL.filedByHint(entry.filedBy))
  if (entry.awaitingApproval === true) hints.push(REQUEST_PANEL.awaitingHint)
  const noteText = note && note.id === id && typeof note.text === 'string' ? note.text : ''
  const noteLine = `<p class="rail-prose is-dim request-note" data-request-hint="${escape(id)}" role="status"${noteText ? '' : ' hidden'}>${escape(noteText)}</p>`
  const writeReasonLine = writeReason
    ? `<p class="rail-prose is-dim request-write-reason" data-request-write-reason role="status">${escape(writeReason)}</p>`
    : ''
  const ids = `data-request-id="${escape(id)}"${key}`
  if (editing === id) {
    return `<div class="request-entry is-editing" data-request-entry="${escape(id)}"${indent}>
      <textarea class="ctl-textarea request-editor" data-request-editor="${escape(id)}" aria-label="${escape(REQUEST_PANEL.editorLabel(id))}" rows="3">${escape(draft)}</textarea>
      <p class="rail-prose is-dim request-id">${escape(hints.join(', '))}</p>
      <div class="ctl-row request-actions">
        <button class="ctl-btn" type="button" data-request-action="save" ${ids}${canEdit ? '' : ` disabled title="${escape(writeReason)}"`}>${escape(REQUEST_PANEL.save)}</button>
        <button class="ctl-btn" type="button" data-request-action="cancel" ${ids}>${escape(REQUEST_PANEL.cancel)}</button>
      </div>
      ${writeReasonLine}
      ${noteLine}
    </div>`
  }
  return `<div class="request-entry" data-request-entry="${escape(id)}"${indent}>
    <p class="rail-prose request-words">${escape(entry.words)}</p>
    <p class="rail-prose is-dim request-id">${escape(hints.join(', '))}</p>
    <div class="ctl-row request-actions">
      <button class="ctl-btn" type="button" data-request-action="edit" ${ids}${canEdit ? '' : ` disabled title="${escape(writeReason)}"`} aria-label="${escape(REQUEST_PANEL.editAria(id))}">${escape(REQUEST_PANEL.edit)}</button>
      <button class="ctl-btn danger" type="button" data-request-action="delete" ${ids}${canRemove ? '' : ` disabled title="${escape(writeReason)}"`} aria-pressed="false" aria-label="${escape(REQUEST_PANEL.deleteAria(id))}">${escape(REQUEST_PANEL.delete)}</button>
    </div>
    ${writeReasonLine}
    ${noteLine}
  </div>`
}

/**
 * The whole body under the panel's heading.
 *
 * @param state   { groups: [{ scope, entries: [{ id, words, filedBy?, key?, awaitingApproval? }] }],
 *                  refused, editing, draft, note: { id, text } | null }
 *                groups carry ONE heading per scope; entries inside a group
 *                may come from more than one ledger and carry their own key.
 * A REFUSAL IS NOT AN EMPTY LIST: a copy that could not read one of its
 * ledgers says so beside whatever it did read.
 */
export function standingRequestsMarkup(state = {}, { escape = escapeText, writes = null } = {}) {
  const groups = Array.isArray(state.groups) ? state.groups : []
  const total = groups.reduce((count, group) => count + (Array.isArray(group.entries) ? group.entries.length : 0), 0)
  const canEdit = writes?.edit !== false
  const canRemove = writes?.remove !== false
  const writeReason = canEdit && canRemove
    ? null
    : !canEdit && !canRemove
      ? REQUEST_PANEL.unavailableWrite
      : !canEdit
        ? REQUEST_PANEL.editUnavailable
        : REQUEST_PANEL.deleteUnavailable
  const options = {
    editing: state.editing || null,
    draft: typeof state.draft === 'string' ? state.draft : '',
    note: state.note || null,
    canEdit,
    canRemove,
    writeReason,
    escape,
  }
  const written = total === 0
    ? `<p class="rail-prose is-dim">${escape(REQUEST_PANEL.empty)}</p>`
    : `${groups.map(group => `
        <div class="rail-sec">${escape(REQUEST_PANEL.scopeLabel[group.scope] || group.scope)}</div>
        ${nestStandingRequests(group.entries).map(entry => entryMarkup(entry, options)).join('')}`).join('')}
      <p class="rail-prose is-dim">${escape(REQUEST_PANEL.precedence)}</p>`
  return `${written}
    ${state.refused ? `<p class="rail-prose is-dim">${escape(REQUEST_PANEL.unavailable)}</p>` : ''}
    <p class="rail-prose is-dim">${escape(REQUEST_PANEL.howToAdd)}</p>
    <p class="rail-prose is-dim">${escape(REQUEST_PANEL.howToRemove)}</p>`
}

/* ---------------------------------------------------------------------------
 * THE PRESSES. One handler over the body, reading the button's own data
 * attributes: edit opens the box, cancel closes it, save sends the words
 * exactly as typed (empty refused before anything is sent), delete arms on
 * the first press and sends on the second. A success re-reads the panel
 * through the caller's `reread`; a refusal is a sentence under the entry.
 * The person's words are never logged here; they go to the bridge and to
 * the text box, nowhere else.
 * ------------------------------------------------------------------------- */

const CODE_SHAPED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

/* The code on a refusal, whether it crossed as `error.code` or -- the way
   Electron hands a main-process throw to the window -- as the last
   code-shaped word of the message. */
function refusalCodeOf(error) {
  if (error && typeof error.code === 'string' && error.code.length > 0) return error.code
  const message = error && typeof error.message === 'string' ? error.message : ''
  const found = message.match(CODE_SHAPED) || []
  return found.length ? found[found.length - 1] : ''
}

function refusalSentence(error, id, verb) {
  const code = refusalCodeOf(error)
  if (code === 'AGENT_REQUEST_UNAVAILABLE') return REQUEST_PANEL.unavailableWrite
  if (code === 'AGENT_REQUEST_ENTRY_UNKNOWN') return REQUEST_PANEL.entryGone(id)
  if (code === 'AGENT_REQUEST_WORDS_EMPTY') return REQUEST_PANEL.editEmpty
  if (code === 'AGENT_REQUEST_WORDS_TOO_LONG') return REQUEST_PANEL.tooLong
  if (code === 'AGENT_REQUEST_WORDS_HEADING') return REQUEST_PANEL.heading
  if (code === 'MC_AGENT_PRINCIPAL_READ_ONLY' || code === 'MC_AGENT_PRINCIPAL_INVALID') return REQUEST_PANEL.readOnly
  return verb === 'edit' ? REQUEST_PANEL.editFailed : REQUEST_PANEL.deleteFailed
}

const SAFE_ID = /^[A-Za-z0-9.]+$/

/**
 * One panel over one body element. `body` needs innerHTML, querySelector and
 * (for the real DOM) addEventListener; the test hands in a stand-in with the
 * same three. `bridge` is window.mcAgent (requestEdit / requestRemove);
 * `arm` is the two-press mechanism, src/arm-press.js by default.
 */
export function createStandingRequestsPanel(body, { bridge = null, escape = escapeText, arm = armOnce } = {}) {
  const state = { groups: [], refused: false, editing: null, draft: '', note: null, reread: null }
  /* Optional write verbs are a render fact. Asking once here keeps older or
     browser-only bridges from drawing controls whose only outcome is the
     handler refusal below. The handler checks remain as a defensive boundary,
     but no unavailable control gets to open an editor or arm a deletion. */
  const writes = Object.freeze({
    edit: typeof bridge?.requestEdit === 'function',
    remove: typeof bridge?.requestRemove === 'function',
  })
  let pending = false

  function paint() {
    body.innerHTML = standingRequestsMarkup(state, { escape, writes })
  }

  function query(selector) {
    return body && typeof body.querySelector === 'function' ? body.querySelector(selector) : null
  }

  function entryOf(id) {
    for (const group of state.groups) {
      const found = (Array.isArray(group.entries) ? group.entries : []).find(entry => entry && entry.id === id)
      if (found) return found
    }
    return null
  }

  /* The hint slot under one entry, written in place: arming must not repaint
     the button it armed. */
  function hint(id, text) {
    if (!SAFE_ID.test(String(id))) return
    const slot = query(`[data-request-hint="${id}"]`)
    if (!slot) return
    slot.textContent = text || ''
    slot.hidden = !text
  }

  function show({ groups = [], refused = false, reread = null, preserveEditing = false } = {}) {
    const editor = preserveEditing && state.editing ? query('[data-request-editor]') : null
    const keepEditing = editor && Array.isArray(groups)
      && groups.some(group => group.entries?.some(entry => entry.id === state.editing))
    const restoreFocus = keepEditing && editor.ownerDocument?.activeElement === editor
    const selection = restoreFocus ? [editor.selectionStart, editor.selectionEnd] : null
    state.groups = Array.isArray(groups) ? groups : []
    state.refused = refused === true
    if (keepEditing) state.draft = editor.value
    else { state.editing = null; state.draft = '' }
    state.note = null
    state.reread = typeof reread === 'function' ? reread : null
    paint()
    if (restoreFocus) {
      const replacement = query('[data-request-editor]')
      replacement?.focus()
      if (Number.isInteger(selection[0]) && Number.isInteger(selection[1])) replacement?.setSelectionRange?.(...selection)
    }
  }

  async function succeeded() {
    if (typeof state.reread === 'function') await state.reread()
  }

  async function save(id, key) {
    if (pending) return
    const editor = query('[data-request-editor]')
    const words = editor && typeof editor.value === 'string' ? editor.value : ''
    state.draft = words
    if (!words.trim()) {
      state.note = { id, text: REQUEST_PANEL.editEmpty }
      paint()
      return
    }
    if (!bridge || typeof bridge.requestEdit !== 'function') {
      state.note = { id, text: REQUEST_PANEL.unavailableWrite }
      paint()
      return
    }
    pending = true
    let answer = null
    let failure = null
    try {
      answer = await bridge.requestEdit({ id, ...(key ? { key } : {}), words })
    } catch (error) {
      failure = error
    }
    pending = false
    if (answer && answer.ok === true) { await succeeded(); return }
    state.note = { id, text: refusalSentence(failure, id, 'edit') }
    paint()
  }

  async function remove(button, id, key) {
    if (pending) return
    if (!writes.remove) return
    const classes = button && button.classList && typeof button.classList.add === 'function' ? button.classList : null
    /* FIRST PRESS ARMS, SECOND ACTS. The sentence under the entry says what
       the second press will do; a lone press disarms and the sentence goes
       with it, so the entry never sits there threatening. */
    if (!arm(button, { onDisarm: () => { hint(id, ''); if (classes) classes.remove('armed') } })) {
      if (classes) classes.add('armed')
      hint(id, REQUEST_PANEL.deleteArmed(id))
      return
    }
    if (classes) classes.remove('armed')
    if (!bridge || typeof bridge.requestRemove !== 'function') {
      hint(id, REQUEST_PANEL.unavailableWrite)
      return
    }
    pending = true
    let answer = null
    let failure = null
    try {
      answer = await bridge.requestRemove({ id, ...(key ? { key } : {}) })
    } catch (error) {
      failure = error
    }
    pending = false
    if (answer && answer.ok === true) { await succeeded(); return }
    hint(id, refusalSentence(failure, id, 'remove'))
  }

  async function press(event) {
    const target = event && event.target
    const button = target && typeof target.closest === 'function' ? target.closest('[data-request-action]') : null
    if (!button || !button.dataset) return
    const action = button.dataset.requestAction
    const id = button.dataset.requestId
    const key = typeof button.dataset.requestKey === 'string' && button.dataset.requestKey !== '' ? button.dataset.requestKey : null
    if (typeof id !== 'string' || !SAFE_ID.test(id)) return
    if (action === 'edit') {
      if (pending || !writes.edit) return
      const entry = entryOf(id)
      state.editing = id
      state.draft = entry && typeof entry.words === 'string' ? entry.words : ''
      state.note = null
      paint()
      const editor = query('[data-request-editor]')
      if (editor && typeof editor.focus === 'function') editor.focus()
      return
    }
    if (action === 'cancel') {
      if (pending) return
      state.editing = null
      state.draft = ''
      state.note = null
      paint()
      return
    }
    if (action === 'save') { await save(id, key); return }
    if (action === 'delete') { await remove(button, id, key) }
  }

  if (body && typeof body.addEventListener === 'function') body.addEventListener('click', press)

  function destroy() {
    if (body && typeof body.removeEventListener === 'function') body.removeEventListener('click', press)
  }

  return Object.freeze({ show, press, destroy, state: () => ({ ...state }) })
}

/* One panel per body element, however many times the rail is re-read: the
   view calls this on every mount and gets the panel it already bound, so a
   re-read never stacks a second click listener on the same body. */
const PANELS = new WeakMap()
export function standingRequestsPanelFor(body, options = {}) {
  let panel = PANELS.get(body)
  if (!panel) {
    panel = createStandingRequestsPanel(body, options)
    PANELS.set(body, panel)
  }
  return panel
}
