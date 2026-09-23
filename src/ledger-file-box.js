/* THE BOX THAT FILES A REQUEST FROM THE LEDGER PAGE.
 *
 * The /Request family already files from any chat; this is the same filing
 * seam reached from the page that lists the results, so a person reading their
 * requests can add one without leaving. The tier picker offers the four reaches
 * the ledger knows (everywhere, one session, one tree, one circle), and the
 * tree, circle and session choices come from the fleet-tree record this window
 * already keeps -- read back through src/fleet-trees.js's own parser, never a
 * second reading of the same file.
 *
 * WHAT IS SENT. Scope, key, the words exactly as typed, and a label: the name
 * the person sees in the picker, so the Ledger page can show "Coordinator"
 * beside a rule instead of a node id. The bridge's main-process side refuses
 * any caller that is not the person at the window.
 *
 * PURE OVER THE ELEMENT IT IS HANDED. The slot needs innerHTML, querySelector
 * and addEventListener; storage needs length, key and getItem.
 * tools/test/ledger-file-box.test.mjs drives it against stand-ins and a
 * recording bridge. The person's words go to the bridge and nowhere else.
 */

import { fleetTreesStorageKey, nodeDisplayName, parseFleetTrees } from './fleet-trees.js'
import { roleLabel } from './fleet-tree-copy.js'
import { REQUEST_COMMANDS, requestConfirmationSentence, taskConfirmationSentence } from './slash-commands.js'
import { REQUEST_PANEL } from './tree-standing-requests.js'
import { EXAMPLE_WRITE_NOTE, FILE_BOX, TASK_FILE_BOX, SCOPE_FILTER, ledgerRefusalSentence } from './ledger-copy.js'
import { TASK_DIFFICULTIES, taskDifficultyFieldMarkup } from './task-difficulty.js'

const TASK_GRADING_ID = 'agent.task_difficulty_enabled'
const CHOOSE_GRADE = 'Choose Easy, Medium or Hard for this new task.'
const GRADING_UNREAD = 'Task grading could not be read. Check it again before filing a task.'
const MAX_WORDS_CHARS = 16384
const MAX_LABEL_CHARS = 120
const KEYED_SCOPES = new Set(['tree', 'thread', 'session'])
const CODE_SHAPED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/* Every saved fleet-tree record in this window's storage, whichever computer
   it belongs to. A record that fails its own parser reads as no trees, which
   is the parser's rule and not this box's business. */
export function storedFleetTrees(storage) {
  const prefix = fleetTreesStorageKey('')
  const records = []
  if (!storage || typeof storage.getItem !== 'function') return records
  const keys = []
  if (typeof storage.key === 'function' && Number.isSafeInteger(storage.length)) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
    }
  }
  for (const key of keys) {
    let raw = null
    try { raw = storage.getItem(key) } catch { raw = null }
    const parsed = parseFleetTrees(raw)
    if (parsed.nodes.length > 0) records.push(parsed)
  }
  return records
}

/* A node whose session can still be filed against. The saved record keeps a
   session id on finished, failed and interrupted nodes too -- it is the only
   handle anything has for asking about them -- but a rule filed for one of
   those has nowhere to apply. Only a session that is running, or was asked
   for and not yet answered about, is offered. */
const LIVE_NODE_STATUSES = new Set(['running', 'starting'])

/**
 * The choices the picker offers for one keyed scope, from the saved trees.
 * Tree and circle: every node, named the way the Computers page names it.
 * Session: only nodes with a live session on record, because a session rule
 * filed against no session, or a finished one, has nowhere to apply.
 *
 * Each choice carries `label`, the name that is SENT with the filing and
 * shown beside the rule on the Ledger page, and `text`, what the option says
 * in the picker. For a session the two differ: "running now" belongs in the
 * picker, where it is true at the moment of choosing, and not on a record
 * that outlives the session.
 */
export function keyChoicesFor(scope, records) {
  const choices = []
  for (const record of records) {
    const manyTrees = record.trees.length > 1
    for (const node of record.nodes) {
      const treeIndex = record.trees.findIndex(tree => tree.id === node.treeId)
      const tree = record.trees[treeIndex] || null
      const treeName = tree && tree.name ? tree.name : `Tree ${treeIndex + 1}`
      const name = nodeDisplayName(node, record.nodes, { roleLabel })
      const label = clip(manyTrees ? `${name} · ${treeName}` : name, MAX_LABEL_CHARS)
      if (scope === 'session') {
        if (!LIVE_NODE_STATUSES.has(node.status)) continue
        if (typeof node.sessionId === 'string' && node.sessionId !== '' && SAFE_KEY.test(node.sessionId)) {
          choices.push({ value: node.sessionId, label, text: clip(`${label} · ${FILE_BOX.runningNow}`, MAX_LABEL_CHARS) })
        }
        continue
      }
      if (SAFE_KEY.test(node.id)) choices.push({ value: node.id, label, text: label })
    }
  }
  return choices
}

function refusalCodeOf(error) {
  if (error && typeof error.code === 'string' && error.code.length > 0) return error.code
  const message = error && typeof error.message === 'string' ? error.message : ''
  const found = message.match(CODE_SHAPED) || []
  return found.length ? found[found.length - 1] : ''
}

function refusalSentence(error, copy = FILE_BOX) {
  const code = refusalCodeOf(error)
  if (code === 'AGENT_REQUEST_UNAVAILABLE') return REQUEST_PANEL.unavailableWrite
  if (code === 'AGENT_REQUEST_WORDS_TOO_LONG') return REQUEST_PANEL.tooLong
  if (code === 'AGENT_REQUEST_WORDS_HEADING') return REQUEST_PANEL.heading
  if (code === 'AGENT_REQUEST_WORDS_EMPTY') return copy.empty
  if (code === 'AGENT_REQUEST_KEY_INVALID' || code === 'AGENT_REQUEST_SCOPE_INVALID' || code === 'MC_AGENT_INVALID_PAYLOAD') return copy.noTarget
  if (code === 'MC_AGENT_PRINCIPAL_READ_ONLY' || code === 'MC_AGENT_PRINCIPAL_INVALID') return REQUEST_PANEL.readOnly
  if (code === 'AGENT_REQUEST_DIFFICULTY_REQUIRED' || code === 'AGENT_REQUEST_DIFFICULTY_INVALID') return CHOOSE_GRADE
  if (code === 'AGENT_REQUEST_DIFFICULTY_SETTINGS_UNAVAILABLE') return GRADING_UNREAD
  /* History that needs review or is damaged: no retry can fix it (T1296). */
  return ledgerRefusalSentence(code) || copy.failed
}

export function fileBoxMarkup({ scope = 'global', choices = [], kind = 'r', escape = escapeText,
  gradingEnabled = false, difficulty = '', gradingMessage = '', gradingPending = false } = {}) {
  if (kind !== 'r' && kind !== 't') return ''
  const copy = kind === 't' ? TASK_FILE_BOX : FILE_BOX
  const scopeOptions = REQUEST_COMMANDS.map(command => `<option value="${escape(command.scope)}"${command.scope === scope ? ' selected' : ''}>${escape(SCOPE_FILTER[command.scope] || command.scope)}</option>`).join('')
  const keyed = KEYED_SCOPES.has(scope)
  const keyOptions = choices.map(choice => `<option value="${escape(choice.value)}">${escape(typeof choice.text === 'string' ? choice.text : choice.label)}</option>`).join('')
  const noneToPick = keyed && choices.length === 0 ? copy.nothingToPick[scope] : ''
  return `<form class="write-form ledger-file-form" data-ledger-file-form data-file-kind="${kind}">
      <span class="write-form-title">${escape(copy.title)}</span>
      <label>${escape(copy.scopeLabel)}<select name="scope" data-file-scope aria-describedby="ledger-file-reach">${scopeOptions}</select></label>
      <p class="write-form-hint" id="ledger-file-reach" data-file-reach>${escape(copy.reach[scope] || '')}</p>
      <label data-file-key-row${keyed ? '' : ' hidden'}>${escape(copy.keyLabel)}<select name="key" data-file-key${choices.length === 0 ? ' disabled' : ''}>${keyOptions}</select></label>
      <p class="write-form-hint" data-file-key-hint${noneToPick ? '' : ' hidden'}>${escape(noneToPick)}</p>
      <label class="write-wide">${escape(copy.wordsLabel)}<textarea name="words" data-file-words rows="3" maxlength="${MAX_WORDS_CHARS}" aria-describedby="ledger-file-words-hint"></textarea></label>
      <p class="write-wide write-form-hint" id="ledger-file-words-hint">${escape(copy.wordsHint)}</p>
      ${kind === 't' ? taskDifficultyFieldMarkup({ enabled: gradingEnabled, value: difficulty, escape }) : ''}
      ${kind === 't' ? `<p class="write-form-hint" data-task-grading-status role="status">${escape(gradingMessage)}</p>${gradingEnabled === null ? `<button type="button" data-task-grading-refresh${gradingPending ? ' disabled' : ''}>Check task grading again</button>` : ''}` : ''}
      <div class="write-choice"><button type="submit" data-ledger-file${noneToPick ? ' disabled' : ''}>${escape(copy.submit)}</button></div>
      <output data-action-output role="status"></output>
    </form>`
}

/**
 * Mount the box into `slot`.
 *
 * @param slot      the section the form is drawn in
 * @param bridge    window.mcAgent, or a stand-in with request()
 * @param storage   window.localStorage, or a stand-in (length, key, getItem)
 * @param onFiled   called after the bridge accepted a filing; the view reloads
 * @param isBadged  whether the register on screen is the example
 */
export function mountLedgerFileBox(slot, {
  bridge = null,
  settingsBridge = globalThis.window?.mcSettings,
  storage = null,
  onFiled = () => {},
  isBadged = () => false,
  exampleNote = () => EXAMPLE_WRITE_NOTE,
  kind = 'r',
  escape = escapeText,
} = {}) {
  if (!slot) return () => {}
  if (typeof bridge?.request !== 'function') {
    slot.innerHTML = ''
    slot.hidden = true
    return () => {}
  }
  const drafts = new Map(['r', 't'].map(key => [key, {
    scope: 'global', key: '', words: '', difficulty: '', message: '', tone: '', pending: false,
  }]))
  let active = null
  let choices = []
  let destroyed = false
  /* The page's reason filing is off (a Ledger that cannot be read), or null. */
  let blocked = null
  let gradingRead = 0
  const taskGrading = { value: null, pending: false, message: 'Reading task grading…' }
  const query = selector => (typeof slot.querySelector === 'function' ? slot.querySelector(selector) : null)
  const copyFor = key => key === 't' ? TASK_FILE_BOX : FILE_BOX

  function capture() {
    const draft = drafts.get(active)
    if (!draft) return
    const words = query('[data-file-words]')
    const key = query('[data-file-key]')
    if (words && typeof words.value === 'string') draft.words = words.value
    if (key && typeof key.value === 'string') draft.key = key.value
    const difficulty = query('[data-task-difficulty]')
    if (active === 't' && difficulty && typeof difficulty.value === 'string') draft.difficulty = difficulty.value
  }

  function showStatus(draft) {
    const output = query('[data-action-output]')
    if (output) { output.textContent = draft.message; output.dataset.state = draft.tone }
    const submit = query('[data-ledger-file]')
    /* Nothing to file under (no agents, no running session): File it stays
       off, and the sentence beside the empty picker says why (T1348). */
    if (submit) submit.disabled = draft.pending || (active === 't' && (taskGrading.pending || taskGrading.value === null)) || Boolean(blocked) || (KEYED_SCOPES.has(draft.scope) && choices.length === 0)
    if (blocked && output && !draft.message) { output.textContent = blocked; output.dataset.state = 'unavailable' }
  }

  function say(draft, text, tone) {
    draft.message = text || ''
    draft.tone = tone
    if (!destroyed && drafts.get(active) === draft) showStatus(draft)
  }

  function paint() {
    if (destroyed) return
    const draft = drafts.get(active)
    slot.hidden = !draft
    if (!draft) { slot.innerHTML = ''; choices = []; return }
    choices = KEYED_SCOPES.has(draft.scope) ? keyChoicesFor(draft.scope, storedFleetTrees(storage)) : []
    slot.innerHTML = fileBoxMarkup({ scope: draft.scope, choices, kind: active, escape,
      gradingEnabled: taskGrading.value, difficulty: draft.difficulty,
      gradingMessage: taskGrading.message, gradingPending: taskGrading.pending })
    const words = query('[data-file-words]')
    if (words) words.value = draft.words
    const key = query('[data-file-key]')
    if (key) {
      if (!choices.some(choice => choice.value === draft.key)) draft.key = choices[0]?.value || ''
      key.value = draft.key
    }
    showStatus(draft)
  }

  async function refreshGrading() {
    if (destroyed) return
    const attempt = ++gradingRead
    capture()
    taskGrading.pending = true
    taskGrading.message = 'Reading task grading…'
    if (active === 't') paint()
    let result = null
    try { result = await settingsBridge?.read?.() } catch { /* report unknown below */ }
    if (destroyed || attempt !== gradingRead) return
    const rows = Array.isArray(result?.rows) ? result.rows.filter(item => item?.id === TASK_GRADING_ID) : []
    const row = rows.length === 1 ? rows[0] : null
    const rejected = !Array.isArray(result?.rejected)
      ? result?.rejected != null : result.rejected.some(item => item?.id === '*' || item?.id === TASK_GRADING_ID)
    capture()
    taskGrading.value = result?.ok === true && result.available === true && row?.present === true
      && row.control === 'toggle' && typeof row.value === 'boolean' && !rejected ? row.value : null
    taskGrading.pending = false
    taskGrading.message = taskGrading.value === null ? GRADING_UNREAD : ''
    if (active === 't') paint()
  }

  function onClick(event) {
    if (event?.target?.closest?.('[data-task-grading-refresh]') && active === 't' && !taskGrading.pending) void refreshGrading()
  }

  function setKind(next) {
    const selected = next === 'r' || next === 't' ? next : null
    if (destroyed || selected === active) return
    capture()
    active = selected
    paint()
    if (active === 't') void refreshGrading()
  }

  function onChange(event) {
    if (event?.target?.closest?.('[data-task-difficulty]')) { capture(); return }
    const select = event?.target?.closest?.('[data-file-scope]')
    const draft = drafts.get(active)
    if (!select || !draft || destroyed) return
    const next = String(select.value || 'global')
    if (!REQUEST_COMMANDS.some(command => command.scope === next)) return
    capture()
    draft.scope = next
    draft.key = ''
    paint()
  }

  async function onSubmit(event) {
    event?.preventDefault?.()
    const submittedKind = active
    const draft = drafts.get(submittedKind)
    if (destroyed || !draft || draft.pending) return
    const copy = copyFor(submittedKind)
    if (isBadged()) { say(draft, exampleNote(), 'note'); return }
    if (blocked) { say(draft, blocked, 'unavailable'); return }
    capture()
    const { scope, words } = draft
    const difficulty = draft.difficulty
    if (submittedKind === 't') {
      if (taskGrading.pending || taskGrading.value === null) {
        say(draft, GRADING_UNREAD, 'refused')
        return
      }
      if (taskGrading.value === true && !TASK_DIFFICULTIES.includes(difficulty)) {
        say(draft, CHOOSE_GRADE, 'refused')
        return
      }
    }
    const submittedDifficulty = submittedKind === 't' && taskGrading.value === true ? difficulty : null
    if (!words.trim()) { say(draft, copy.empty, 'refused'); return }
    let key = null
    let label = null
    if (KEYED_SCOPES.has(scope)) {
      key = draft.key
      const chosen = choices.find(choice => choice.value === key)
      if (!key || !SAFE_KEY.test(key) || !chosen) { say(draft, copy.noTarget, 'refused'); return }
      label = typeof chosen.label === 'string' && chosen.label !== '' ? clip(chosen.label, MAX_LABEL_CHARS) : null
    }
    draft.pending = true
    say(draft, copy.pending, 'pending')
    let answer = null
    let failure = null
    try {
      answer = await bridge.request({ scope, ...(key ? { key } : {}), words, ...(label ? { label } : {}),
        ...(submittedKind === 't' ? { kind: 'T', ...(submittedDifficulty ? { difficulty: submittedDifficulty } : {}) } : {}) })
    } catch (error) { failure = error }
    draft.pending = false
    if (destroyed) return
    if (active === submittedKind) capture()
    if (answer?.ok === true && typeof answer.id === 'string' &&
        (submittedKind === 't' ? /^T[1-9][0-9]*$/ : /^R[1-9][0-9]*$/).test(answer.id)) {
      // A later draft, changed target or other page must survive an older save.
      if (draft.words === words && draft.scope === scope && (key || '') === draft.key && draft.difficulty === difficulty) {
        draft.words = ''
        draft.difficulty = ''
        if (active === submittedKind) {
          const field = query('[data-file-words]')
          if (field) field.value = ''
          const gradeField = query('[data-task-difficulty]')
          if (gradeField) gradeField.value = ''
        }
      }
      const confirm = submittedKind === 't' ? taskConfirmationSentence : requestConfirmationSentence
      say(draft, confirm(scope, answer.id), 'confirmed')
      try { await onFiled({ id: answer.id, scope, key }) }
      catch { say(draft, confirm(scope, answer.id) + ' ' + copy.refreshFailed, 'confirmed') }
      return
    }
    say(draft, answer?.ok === true ? copy.wrongKind : refusalSentence(failure || answer, copy), 'refused')
    if (submittedKind === 't') void refreshGrading()
  }

  setKind(kind)
  // A non-filing initial page starts with no form, including stale markup.
  if (active === null) paint()
  slot.addEventListener?.('click', onClick)
  slot.addEventListener?.('change', onChange)
  slot.addEventListener?.('submit', onSubmit)
  return Object.freeze(Object.assign(() => {
    destroyed = true
    slot.removeEventListener?.('click', onClick)
    slot.removeEventListener?.('change', onChange)
    slot.removeEventListener?.('submit', onSubmit)
  }, { submit: onSubmit, change: onChange, setKind, refreshGrading,
    /* The page says filing is off, and why, or null to turn it back on. */
    block(reason) {
      const next = typeof reason === 'string' && reason ? reason : null
      if (next === blocked) return
      blocked = next
      const draft = drafts.get(active)
      if (draft && !destroyed) showStatus(draft)
    },
    repaint: () => { capture(); paint() }, scope: () => drafts.get(active)?.scope || null }))
}
