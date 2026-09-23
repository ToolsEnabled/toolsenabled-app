/**
 * THE SPLIT COMPARE WINDOW.
 *
 * The owner: "i think we should offer a basic diff editing screen... All we
 * want though -- it might not make sense to use monaco -- is the original file
 * and the new file; split; in a popup window with easy text editing over both
 * and a save this version under both, so a user can pull up review and modify
 * diffs easily."
 *
 * TWO TEXTAREAS, AND NO EDITOR LIBRARY. He doubted the obvious dependency and
 * he was right about it: a code editor component is several megabytes of
 * third-party code entering a build whose publication boundary is decided file
 * by file, to draw two boxes a person types in. The product already has the
 * idiom this needs -- `ctl-textarea`, in src/cloud.css and the standing-rules
 * panel -- so the panes are two of those and nothing else.
 *
 * THE SAVE IS A DELIBERATE OVERRIDE, NOT A THING TO REFUSE. The owner again:
 * "warn the user about the staleness possibility - only advanced users will use
 * this anyway. and let them have a check box not to show them the warning again.
 * then let them do it themselves - this is their manual override of the agent."
 * So the warning states plainly that the file may have moved since the agent
 * produced this version and that saving replaces it, offers to stop asking, and
 * then gets out of the way. There is no freshness token and no refusal on a
 * changed file anywhere in this path, and adding one later would be reversing a
 * decision he made in words.
 *
 * WHY TYPING DOES NOT REDRAW THIS WINDOW. src/cloud-mirror-setup.js re-renders
 * its whole dialog on every input event and restores the caret afterwards,
 * which is fine for a folder name and catastrophic for a file: at a megabyte
 * that is an escape, a parse and a layout on every keystroke. Here the panes
 * are drawn ONCE per structural change, their text is set through `.value`
 * rather than through markup, and an input event touches nothing but the state
 * object and two small nodes. `renderCount` on the returned controller is how a
 * suite proves that instead of taking it on trust.
 *
 * SETTING `.value` RATHER THAN WRITING THE TEXT INTO THE MARKUP is also the
 * thing that makes the window safe to point at any file. Text placed inside a
 * <textarea> tag is parsed as markup, so a file containing the closing tag
 * would end the element and the rest would become live nodes in this window.
 * The markup below emits empty textareas on purpose; nothing in this module
 * ever interpolates file contents into HTML.
 *
 * WHAT IT MAY REACH. Every read and the single write go through the main
 * process, fenced to the configured workspace for editing. A still-owned
 * session or saved native tree can authorize review of its registered folder
 * through shell/session-diff-access.cjs. Saving revalidates that association
 * and requires the exact file previously opened by this window. This module
 * holds no path logic of its own and cannot widen either fence.
 *
 * THE LINE ENDINGS A <textarea> CANNOT CARRY, AND WHY THIS FILE PUTS THEM BACK.
 * A textarea's `value` is its API VALUE: per HTML, the raw value with every
 * CRLF pair and every lone CR replaced by one LF, on the way in and on the way
 * out. So a Windows file cannot be held in one of these boxes as it is on disk,
 * and a module that reads `.value` and writes that string whole rewrites every
 * line ending in the file on the first keystroke -- ~1500 lines of
 * src/views/settings.js, which is CRLF in this repository right now, for a
 * one-character correction, under a window saying "the file on disk now matches
 * this side". That is the same silent destruction shell/diff-file.cjs refuses a
 * binary for, arriving through the ordinary door instead of the exotic one.
 *
 * So the ending is read off the file when it is opened, carried on the pane,
 * and put back on the way out; the box and `savedText` both hold the plain
 * form, which is also what stops a file nobody changed from being reported as
 * edited. What cannot be recovered is a file whose lines DISAGREE -- the box
 * hands back one kind of ending and cannot be asked which line had which -- so
 * that file's pane says the save will make them uniform rather than doing it
 * quietly.
 */

/* THE SENTENCE FOR EVERY REFUSAL THIS WINDOW CAN RECEIVE.
 *
 * The main process answers with a code and never a sentence, for the reason
 * src/agent-availability-copy.js records: the message is the field that names
 * absolute paths. This table spends that specificity, and `refusalSentence`
 * below renders nothing it cannot find here -- an unknown code gets the last
 * line rather than being printed.
 *
 * Every entry ends with something to do. That is the house rule
 * tools/check-plain-language.mjs enforces, and it is the difference between a
 * refusal and a dead end. */
import { CHANGE_LIMITS, boundedChangePatches, reverseSessionPatches, reverseSubstringEdits } from './session-change-patches.js'
import { mountRecordedPatch } from './diff-presentation.js'
import { mountLiveComparison } from './diff-live.js'

const REFUSALS = Object.freeze({
  MC_DIFF_SESSION_SCOPE_UNAVAILABLE: 'This file’s original session folder is not currently available for review. Check that the tree still uses its registered folder, or open the named file in your editor.',
  MC_DIFF_CHANGE_READ_UNAVAILABLE: 'This window cannot load session files yet. Reopen the updated desktop app, or choose the files below.',
  MC_DIFF_PATH_UNBOUND: 'The working folder for this older change is unavailable. Choose the file below to compare it.',
  MC_DIFF_PATH_MISSING: 'No file was named, so nothing was saved. Choose a file for this side and try again.',
  MC_DIFF_TEXT_MISSING: 'This window sent no text, so nothing was saved. Choose the file for this side once more, then save it.',
  /* Two states, one sentence, because there is one thing to do about both: the
     folder was never chosen, or it was chosen and is not on the disk any more.
     The earlier wording said only the first, which was the state
     shell/diff-file.cjs could not actually reach. */
  MC_DIFF_NO_WORKSPACE: 'This window could not find the folder your assistants work in, so nothing was saved. Open Settings, choose that folder again, then try again.',
  MC_DIFF_OUTSIDE_WORKSPACE: 'That file sits outside the folder your assistants work in, so nothing was saved. Move it inside that folder, or change the folder in Settings.',
  MC_DIFF_TOO_LARGE: 'This window handles files up to one megabyte. Open this one in your usual editor instead.',
  /* THE SAME LIMIT ON THE OTHER SIDE OF THE WORK, and it needs its own sentence
     because the advice is different. "Open it in your usual editor" is what to
     do about a file you have not opened yet; said after an hour of hand
     editing, over a box holding the only copy of that hour, it is a dead end.
     This one says the edits are still here and what will fit. */
  MC_DIFF_TOO_LARGE_TO_SAVE: 'This side is longer than the one megabyte this window saves, so nothing was saved. Your edits are still in the box: take some of it out, or copy it into your usual editor.',
  MC_DIFF_NOT_A_FILE: 'That is a folder, not a file. Choose a file and try again.',
  MC_DIFF_NOT_TEXT: 'That file is not text, so it was left exactly as it was. Open it in the program that made it.',
  MC_DIFF_STAT_FAILED: 'The file’s details could not be checked. Check that it is still there and that you can open it, then try again.',
  MC_DIFF_READ_FAILED: 'The file could not be read. Check that it is still there and that you can open it, then try again.',
  MC_DIFF_HANDLER_FAILED: 'Compare could not finish checking or opening the file because an unexpected error occurred. Try again.',
  MC_DIFF_WRITE_FAILED: 'The file could not be written, and nothing on disk was changed. Close anything else holding it open, then try again.',
})

/* Reached when the answer carries no code this table knows -- a sender check
   the shell refused, an older build, or a reply that never arrived. It states
   what to assume about the file, which is the one thing a person needs. */
const UNKNOWN_REFUSAL = 'The save could not be confirmed, so treat the file as unchanged. Check the file yourself before you decide anything on the strength of this window.'

/* One megabyte, stated here because a person is told it before they open a
   file, and enforced in shell/diff-file.cjs, which is where MAX_FILE_BYTES
   lives. tools/test/diff-editor.test.mjs holds the two together, so the
   sentence above cannot go on claiming a limit the main process stopped
   applying. */
export const MAX_FILE_BYTES = 1024 * 1024

/* Where this window remembers that a person asked it to stop warning them.
   The renderer's settings all live behind localStorage, which shell/renderer-prefs.cjs
   replaced with a per-person file in userData -- see public/durable-storage.js
   -- so this is a durable choice for this person on this computer, and it is
   keyed like every other one in the product. */
export const WARNING_PREFERENCE_KEY = 'mc.diff.stale-warning'

export const SIDES = Object.freeze(['original', 'proposed'])

/* THE THREE LINE ENDINGS A TEXT FILE ARRIVES WITH, and the plain one this
   window falls back to when a file has none to preserve. */
const CRLF = '\r\n'
const LF = '\n'
const CR = '\r'

/* The sentence a pane shows about its own file, when there is something about
   the file itself worth saying before a save. One per ending, because "saving
   makes them uniform" is only honest if it says WHICH. Each ends with something
   to do, which is the rule tools/check-plain-language.mjs enforces. */
const MIXED_ENDING_NOTE = Object.freeze({
  [CRLF]: 'The lines in this file end in two different ways. Saving writes them all the Windows way. Keep a copy first if that matters to you.',
  [LF]: 'The lines in this file end in two different ways. Saving writes them all the plain way, with no carriage returns. Keep a copy first if that matters to you.',
  [CR]: 'The lines in this file end in two different ways. Saving writes them all as carriage returns. Keep a copy first if that matters to you.',
})

/**
 * How this file's lines end, taken from the file itself.
 *
 * Counted rather than sniffed from the first line: a file whose first line is
 * the one odd one out would otherwise decide for all the rest. A file with no
 * line ending at all has nothing to preserve and gets the plain one, which is
 * what this product writes everywhere else.
 */
export function dominantLineEnding(text) {
  const { pairs, plain, carriage } = countLineEndings(text)
  if (pairs === 0 && carriage === 0) return LF
  if (pairs >= plain && pairs >= carriage) return CRLF
  if (carriage > plain) return CR
  return LF
}

/** True when the file's lines do not all end the same way. */
export function lineEndingsDisagree(text) {
  const counts = countLineEndings(text)
  return [counts.pairs, counts.plain, counts.carriage].filter(count => count > 0).length > 1
}

/* One walk, no allocation. Both of the two above run once per file opened and
   never on a keystroke, but a megabyte through a regex that builds an array
   per line ending is a quarter of a million throwaway strings for an answer
   that is three numbers. */
function countLineEndings(text) {
  const source = String(text ?? '')
  let pairs = 0
  let plain = 0
  let carriage = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === CR) {
      if (source[index + 1] === LF) { pairs += 1; index += 1 } else carriage += 1
    } else if (character === LF) plain += 1
  }
  return { pairs, plain, carriage }
}

/** What the box will hold: the API value a textarea would hand back anyway. */
export function toPaneText(text) {
  return String(text ?? '').replace(/\r\n?/g, LF)
}

/** What goes to disk: the pane's plain text with this file's ending put back. */
export function toFileText(text, ending) {
  const plain = toPaneText(text)
  return ending === CRLF || ending === CR ? plain.replace(/\n/g, ending) : plain
}

const SIDE_COPY = Object.freeze({
  original: Object.freeze({
    heading: 'Original file',
    choose: 'Choose the original file',
    empty: 'No original file is open yet.',
  }),
  proposed: Object.freeze({
    heading: 'Changed file',
    choose: 'Choose the changed file',
    empty: 'No changed file is open yet.',
  }),
})

const SAVE_LABEL = 'Save this version'
const SAVED_LINE = 'Saved. The file on disk now matches this side.'
const DIRTY_LINE = 'Edited here, not yet saved.'
const FOCUSABLE = 'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const diffIcon = path => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

function emptyPane(side) {
  return {
    side,
    path: null,
    sessionId: null,
    /* `text` is what is in the box; `savedText` is what this window last knew
       to be on disk. Their difference is the only definition of "unsaved" here,
       and it is what the close guard and the save control both read. */
    text: '',
    savedText: '',
    /* HOW THIS FILE'S LINES END, and whether they all agree. Both are read off
       the file at the moment it is opened, because the box cannot be asked
       afterwards: it normalises every ending to a plain one. `ending` is what
       goes back on at the write; `endingsDisagree` is what the pane says out
       loud, since for that file the write changes bytes nobody typed. */
    ending: LF,
    endingsDisagree: false,
    bytes: null,
    /* When the file was last written, as this window read it. Compared against
       a fresh reading at save time so the warning can say whether the file
       really has moved rather than only that it might have. */
    modifiedMs: null,
  }
}

export function emptyDiffEditorState() {
  return {
    sides: { original: emptyPane('original'), proposed: emptyPane('proposed') },
    busy: null,
    /* { side, moved: true | false | null, remember: boolean }. `moved` is null
       when the file's state on disk could not be read; that is a third answer
       and the warning says so rather than guessing either way. */
    warning: null,
    refusal: null,
    /* Which pane a refusal is about, so the one line at the top of a dialog
       holding two files can say which of them it means. */
    refusalSide: null,
    saved: null,
    /* True once a close has been asked for while edits were unsaved. The second
       ask goes through. */
    confirmingClose: false,
    warningSuppressed: false,
  }
}

export function paneIsDirty(pane) {
  return Boolean(pane && pane.path) && pane.text !== pane.savedText
}

export function stateIsDirty(state) {
  return SIDES.some(side => paneIsDirty(state.sides[side]))
}

/**
 * WHY THE SAVE CONTROL UNDER THIS PANE CANNOT BE PRESSED, or null when it can.
 *
 * A sentence rather than a boolean, because the house rule is that a control
 * which cannot succeed is disabled and says why beside it -- never silently
 * absent, and never live and refusing. src/cloud-mirror-setup.js states the
 * same rule over its own register control.
 */
/* THE CAPTURED ORIGINAL, AND WHETHER IT CAN BE TRUSTED AS ONE.
 *
 * `trusted` is the whole question. The capture was read when the edit was
 * ANNOUNCED, which is before the assistant's process performs it -- but those
 * are two processes and nothing orders them, so a slow read can return the file
 * as it already is AFTER the edit. The modification stamps are the evidence: if
 * the file's stamp now differs from the stamp the capture carried, the file was
 * written after the capture was taken, and the capture is therefore the version
 * that preceded it. A file that did not exist when the edit was announced is
 * the same proof in its clearest form -- its original is the empty file.
 *
 * Exported for the same reason saveBlockedReason is: it is a decision about
 * what a person is shown, and it takes values rather than reading a closure. */
export function capturedOriginal(selection, result) {
  const capture = selection?.originalCapture
  if (!capture || typeof capture.text !== 'string') return { text: null, trusted: false }
  const text = toPaneText(capture.text)
  if (capture.existed === false) return { text, trusted: true }
  const before = capture.modifiedMs
  const now = result?.modifiedMs
  const moved = Number.isFinite(before) && Number.isFinite(now) ? before !== now : false
  return { text, trusted: moved }
}

export function saveBlockedReason(state, side) {
  const pane = state.sides[side]
  if (!pane) return 'This side does not exist.'
  if (!pane.path) return 'Choose a file for this side first.'
  if (pane.readOnly) return 'Review only for this session folder. Open this file in your editor to save changes.'
  if (state.busy) return 'Working.'
  if (state.warning) return 'Answer the question below first.'
  if (pane.text === (pane.diskText ?? pane.savedText)) return 'This side already matches the file on disk.'
  /* THE SAVE THAT COULD NOT SUCCEED, SAID BEFORE THE WORK RATHER THAN AFTER IT.
     A file may be read at 1,048,570 bytes and then typed past the limit, and
     the write refuses. This is that refusal moved to where a person can still
     act on it, at a cost of nothing: a UTF-8 byte is never smaller than the
     UTF-16 unit that produced it, so more units than the limit is more bytes
     than the limit, and `length` is a field rather than a scan. It is a floor
     and not the whole answer -- a pane under the limit in units can still be
     over it in bytes, and MC_DIFF_TOO_LARGE_TO_SAVE catches that -- but it is
     the case a person actually reaches, and it costs no work per keystroke.
     Anything proportional to the file here would be a keystroke cost over a
     megabyte, which is the one thing this window is built not to pay. */
  if (pane.text.length > MAX_FILE_BYTES) {
    return 'This side is longer than the one megabyte this window saves. Take some of it out, or copy it into your usual editor.'
  }
  return null
}

/** The sentence for a reply that refused. Never the code, and never a path. */
export function refusalSentence(result) {
  const code = result && typeof result.code === 'string'
    ? result.code
    : (result && result.error && typeof result.error.code === 'string' ? result.error.code : null)
  if (code && Object.hasOwn(REFUSALS, code)) return REFUSALS[code]
  return UNKNOWN_REFUSAL
}

/** The machine field, carried on the node so a suite and a support conversation
 *  can still name the exact refusal. It is never rendered as text. */
export function refusalCode(result) {
  if (result && typeof result.code === 'string') return result.code
  if (result && result.error && typeof result.error.code === 'string') return result.error.code
  return 'MC_DIFF_UNKNOWN'
}

/* THE WARNING, IN THE THREE STATES IT CAN HONESTLY BE IN. The first sentence is
   the owner's staleness point and is said every time. The second is what this
   window actually measured a moment ago, and "we could not tell" is a real
   answer that gets its own line rather than being rounded to either of the
   others. */
export function warningLines(warning) {
  const lines = ['The file on disk may have changed since the agent produced this version. Saving replaces whatever is there now.']
  if (warning.moved === true) lines.push('This file has changed on disk since you opened it here.')
  else if (warning.moved === false) lines.push('This file has not changed on disk since you opened it here.')
  else lines.push('Whether it has changed could not be read just now, so treat it as though it has.')
  lines.push('Nothing here is undone for you, so keep a copy first if you are not sure.')
  return lines
}

/* WHAT THIS PANE HAS TO SAY ABOUT ITS OWN FILE, or nothing at all.
 *
 * Only one thing qualifies today: a file whose lines end in more than one way,
 * where the save makes them uniform and so changes bytes the person did not
 * type. It sits with the path rather than in the warning because it is a fact
 * about the file, and the warning can be switched off. */
function paneNote(pane, side) {
  if (!pane.path || !pane.endingsDisagree) return ''
  const note = MIXED_ENDING_NOTE[pane.ending] || MIXED_ENDING_NOTE[LF]
  return `<p class="diff-pane-note" data-diff-note="${side}">${escapeHtml(note)}</p>`
}

function paneMarkup(state, side) {
  const pane = state.sides[side]
  const copy = SIDE_COPY[side]
  const blocked = saveBlockedReason(state, side)
  const dirty = paneIsDirty(pane)
  const savedHere = state.saved === side
  const reasonId = `diff-save-blocked-${side}`
  const labelId = `diff-pane-label-${side}`
  return `<article class="diff-pane" data-diff-side="${side}">
    <header class="diff-pane-head">
      <div class="diff-pane-toolbar">
        <h3 class="diff-pane-title" id="${labelId}">${escapeHtml(state.change ? (side === 'original' ? 'Before session edits' : 'Current file') : copy.heading)}</h3>
        <button type="button" class="ctl-btn diff-choose" data-diff-action="pick" data-diff-side="${side}" aria-label="${escapeHtml(pane.path ? `Choose a different ${side === 'original' ? 'original' : 'changed'} file` : copy.choose)}"${state.busy ? ' disabled' : ''}>${diffIcon('M3 6h5l2 2h7v8H3V6Zm0 0V4h5l2 2h5v2')}<span>Choose file</span></button>
      </div>
      <p class="diff-pane-where"${pane.path ? ` title="${escapeHtml(pane.path)}"` : ' data-diff-empty'}>${escapeHtml(pane.path ? (state.change?.path || pane.path) : copy.empty)}</p>
      ${paneNote(pane, side)}
    </header>
    <textarea class="ctl-textarea diff-text" data-diff-pane="${side}" aria-labelledby="${labelId}" spellcheck="false" wrap="off"${pane.path ? '' : ' disabled'}${pane.readOnly ? ' readonly' : ''}></textarea>
    <footer class="diff-pane-foot">
      <button type="button" class="ctl-btn diff-save" data-diff-action="save" data-diff-side="${side}" aria-describedby="${reasonId}"${blocked ? ' disabled' : ''}>${diffIcon('M4 3h10l3 3v11H3V3h1Zm2 0v5h7V3M6 17v-6h8v6')}<span>${escapeHtml(SAVE_LABEL)}</span></button>
      <span class="diff-blocked" id="${reasonId}" data-diff-blocked="${side}"${blocked ? '' : ' hidden'}>${escapeHtml(blocked || '')}</span>
      <span class="diff-pane-state" data-diff-state="${side}" role="status">${escapeHtml(
        /* UNSAVED WINS OVER SAVED, and the order is a fix rather than a
           preference. A person may keep typing while the write is in flight;
           those characters were never sent, so the window would have said
           "the file on disk now matches this side" over a box that no longer
           matched it -- found by driving exactly that interleaving. */
        dirty ? DIRTY_LINE : (savedHere ? SAVED_LINE : '')
      )}</span>
    </footer>
  </article>`
}

/* WHICH SIDE THIS IS ABOUT, in the words the pane above it is headed with.
   With two files open, "the file" names neither of them. */
const sideLabel = side => SIDE_COPY[side]?.heading || ''

function warningMarkup(state) {
  if (!state.warning) return ''
  const lines = warningLines(state.warning)
  const pane = state.sides[state.warning.side]
  /* THE SENTENCE UNDER THE CHECKBOX SAYS THIS WINDOW "still says which file it
     is about", AND THIS IS WHERE IT DOES. It was written before the line
     existed and was false: with two files open, one warning at the top of the
     dialog headed "Before this replaces the file" identified nothing. The path
     is the person's own -- they chose it in a dialog and it is drawn in the
     pane above -- so showing it here names nothing new. */
  const where = pane && pane.path
    ? `<p class="diff-warning-where" data-diff-warning-side="${escapeHtml(state.warning.side)}">${escapeHtml(`${sideLabel(state.warning.side)}: ${pane.path}`)}</p>`
    : ''
  return `<section class="diff-warning" data-diff-warning role="alertdialog" aria-labelledby="diff-warning-title">
    <h3 class="diff-warning-title" id="diff-warning-title">Before this replaces the file</h3>
    ${where}
    ${lines.map(line => `<p class="diff-warning-line">${escapeHtml(line)}</p>`).join('')}
    <label class="diff-warning-remember">
      <input type="checkbox" data-diff-remember${state.warning.remember ? ' checked' : ''} />
      <span>Do not show this warning again</span>
    </label>
    <p class="diff-warning-note">That choice is kept for you on this computer, and this window still says which file it is about.</p>
    <div class="diff-warning-actions">
      <button type="button" class="ctl-btn" data-diff-action="cancel-save">Cancel</button>
      <button type="button" class="ctl-btn armed" data-diff-action="confirm-save">${escapeHtml(SAVE_LABEL)}</button>
    </div>
  </section>`
}

export function diffEditorMarkup(state) {
  /* THE REFUSAL SAYS WHICH SIDE IT IS ABOUT. It is one paragraph at the top of
     a dialog with two files in it, and "that file sits outside the folder your
     assistants work in" over two panes is a question rather than an answer. The
     side is what disambiguates: a refused pick has no path yet, and a refused
     save is about the path already drawn in its own pane. */
  const refusal = state.refusal
    ? `<p class="diff-refusal" role="alert" data-refusal-code="${escapeHtml(refusalCode(state.refusal))}"${state.refusalSide ? ` data-refusal-side="${escapeHtml(state.refusalSide)}"` : ''}>${escapeHtml(
      state.refusalSide ? `${sideLabel(state.refusalSide)}: ${refusalSentence(state.refusal)}` : refusalSentence(state.refusal)
    )}</p>`
    : ''
  const closing = state.confirmingClose
    ? '<p class="diff-closing" role="alert">You have edits here that are not saved. Press close again to leave without saving them.</p>'
    : ''
  const filename = state.change?.path?.replace(/\\/g, '/').split('/').pop()
  const reviewOnly = SIDES.some(side => state.sides[side].readOnly)
  const liveComparison = SIDES.every(side => state.sides[side].path)
  const unmeasured = state.change?.unmeasuredEdits || 0
  const measured = state.change && state.change.edits > unmeasured
  const changeTotals = state.change
    ? unmeasured && !measured
      ? '<div class="diff-session-totals diff-counts-unavailable"><small>Line counts unavailable, see the diff</small></div>'
      : `<div class="diff-session-totals" aria-label="${escapeHtml(state.change.added)} recorded lines added, ${escapeHtml(state.change.removed)} recorded lines removed${unmeasured ? '; additional line counts unavailable, see the diff' : ''}"><span class="diff-total-added">+${escapeHtml(state.change.added)}${unmeasured ? '*' : ''}</span><span class="diff-total-removed">−${escapeHtml(state.change.removed)}${unmeasured ? '*' : ''}</span><small>${unmeasured ? '* partial counts' : 'session lines'}</small></div>`
    : ''
  return `<div class="diff-overlay" data-diff-overlay>
    <section class="diff-dialog"${state.change ? ' data-diff-session' : ''} role="dialog" aria-modal="true" aria-labelledby="diff-title" tabindex="-1">
      <header class="diff-head">
        <div class="diff-heading">
          <p class="diff-eyebrow">${state.change ? 'Session changes / Compare' : 'Compare & edit'}</p>
          <h2 id="diff-title">${state.change ? escapeHtml(filename || state.change.path) : 'Compare two files'}</h2>
          <p class="diff-lede">${reviewOnly ? 'Review the versions below. To change a file in the registered session folder, open it in your editor.' : state.change ? 'Review the recorded changes below. Edit either version and save the one you want.' : 'Open the original on the left and the changed version on the right. Edit either side. Save each side on its own.'}</p>
        </div>
        ${changeTotals}
        <button type="button" class="diff-close" data-diff-action="close" aria-label="Close this window">${diffIcon('m5 5 10 10M15 5 5 15')}</button>
      </header>
      ${refusal}
      ${closing}
      ${state.changeNote ? `<p class="diff-change-note" role="status">${escapeHtml(state.changeNote)}</p>` : ''}
      ${liveComparison ? '<section class="diff-live" aria-label="Current comparison"><div class="diff-live-lines" data-live-diff></div></section>' : ''}
      ${state.change?.patches?.length ? `<details class="diff-recorded"${liveComparison ? '' : ' open'}><summary><span class="diff-recorded-title">Recorded changes</span><span class="diff-recorded-legend"><span class="diff-legend-added">+ Added</span><span class="diff-legend-removed">− Removed</span></span></summary><div class="diff-recorded-lines" data-recorded-patch tabindex="0" aria-label="Recorded session patch with old and new line numbers"></div></details>` : ''}
      <div class="diff-panes">${SIDES.map(side => paneMarkup(state, side)).join('')}</div>
      ${warningMarkup(state)}
      <p class="diff-foot-note">Files up to one megabyte open here. Save writes to the file named above that version.</p>
    </section>
  </div>`
}

/**
 * The controller.
 *
 * @param documentRef  the document, for the Escape key and for focus.
 * @param files        { pick, stamp, save } -- the bridge in
 *                     shell/fleet-profile-preload.cjs, injected so this can be
 *                     driven with values instead of asserted against source.
 * @param prefs        { read, write } for the warning preference. Injected for
 *                     the same reason; the real one is localStorage, which is a
 *                     file in userData on this product.
 * @param onClose      called once, after this window has taken itself down.
 */
export function createDiffEditor({ documentRef, files, prefs, onClose = null } = {}) {
  const state = emptyDiffEditorState()
  let root = null
  let renderCount = 0
  let loadRevision = 0
  let loadSelectionKey = null
  let paneControls = {}
  let comparisonTimer = null

  function renderComparison() {
    clearTimeout(comparisonTimer)
    comparisonTimer = null
    const comparison = root?.querySelector('[data-live-diff]')
    if (comparison) mountLiveComparison(comparison, state.sides.original.text, state.sides.proposed.text, documentRef)
  }

  function readWarningPreference() {
    try { return prefs?.read?.() === 'off' } catch { return false }
  }

  /* Text is written through `.value`, never through markup: see the head of
     this file. It runs after every structural render, so a pane's contents
     survive the window redrawing around it. */
  function applyPaneText() {
    if (!root) return
    for (const side of SIDES) {
      const box = root.querySelector(`[data-diff-pane="${side}"]`)
      if (box && box.value !== state.sides[side].text) box.value = state.sides[side].text
    }
  }

  function render() {
    if (!root) return
    /* THE CLOSE WARNING MUST NOT OUTLIVE WHAT IT IS ABOUT. "You have edits here
       that are not saved" stays on the screen after the save that made it
       false unless something clears it, and a sentence that is false on screen
       is the defect this product spends most of its comments on. Cleared as an
       invariant here rather than at each of the three call sites that could
       make it stale. */
    if (state.confirmingClose && !stateIsDirty(state)) state.confirmingClose = false
    const previousPatch = root.querySelector('.diff-recorded')
    const nowComparable = SIDES.every(side => state.sides[side].path)
    const patchOpen = nowComparable && !root.querySelector('[data-live-diff]')
      ? false : previousPatch ? previousPatch.open : !nowComparable
    const patchScroll = root.querySelector('[data-recorded-patch]')?.scrollTop || 0
    renderCount += 1
    root.innerHTML = diffEditorMarkup(state)
    // These controls survive every input. Refresh their references only when
    // the surrounding markup changes, so typing never searches the dialog.
    paneControls = Object.fromEntries(SIDES.map(side => [side, {
      line: root.querySelector(`[data-diff-state="${side}"]`),
      button: root.querySelector(`.diff-save[data-diff-side="${side}"]`),
      reason: root.querySelector(`[data-diff-blocked="${side}"]`),
    }]))
    const patchDetails = root.querySelector('.diff-recorded')
    if (patchDetails) patchDetails.open = patchOpen
    applyPaneText()
    renderComparison()
    const recorded = root.querySelector('[data-recorded-patch]')
    if (recorded) {
      mountRecordedPatch(recorded, state.change.patches, documentRef)
      recorded.scrollTop = patchScroll
    }
  }

  /* THE ONLY THING A KEYSTROKE DOES, AND IT NEVER REDRAWS THIS WINDOW.
   *
   * The state object, one status line, one button's disabled flag and one
   * reason sentence -- four in-place writes, none of which reads the text back
   * out and none of which touches innerHTML. A redraw here would cost an escape
   * and a parse of the whole file per character, and it would take the caret
   * away mid-word on the first keystroke of every editing session, which is the
   * bug that made src/cloud-mirror-setup.js restore the caret by hand.
   *
   * Both nodes exist in every state and are toggled rather than added, which is
   * what makes the in-place update possible at all. */
  function onInput(event) {
    const side = event?.target?.dataset?.diffPane
    if (!side || !state.sides[side]) return
    state.sides[side].text = event.target.value
    if (state.saved === side) state.saved = null
    if (!root) return
    const { line, button, reason } = paneControls[side] || {}
    if (line) line.textContent = paneIsDirty(state.sides[side]) ? DIRTY_LINE : ''
    const blocked = saveBlockedReason(state, side)
    if (button) button.disabled = blocked !== null
    if (reason) {
      reason.textContent = blocked || ''
      reason.hidden = blocked === null
    }
    clearTimeout(comparisonTimer)
    comparisonTimer = setTimeout(renderComparison, 150)
    /* The one keystroke that IS allowed to redraw: the person typed their edit
       back to what is on disk while a close warning about that edit was up. It
       fires once, because the redraw clears the flag. */
    if (state.confirmingClose && !stateIsDirty(state)) render()
  }

  async function pick(side) {
    if (!state.sides[side] || state.busy) return
    state.busy = `pick:${side}`
    state.refusal = null
    state.refusalSide = null
    state.saved = null
    render()
    let result
    try { result = await files.pick(side) } catch { result = { ok: false, code: 'MC_DIFF_HANDLER_FAILED' } }
    state.busy = null
    if (result && result.canceled) { render(); return }
    if (!result || result.ok !== true || typeof result.text !== 'string') {
      state.refusal = result || {}
      state.refusalSide = side
      render()
      return
    }
    const pane = state.sides[side]
    pane.readOnly = false
    pane.sessionId = null
    // Choosing another file changes this into a manual two-file comparison.
    // The prior session's patch must not label the newly chosen file.
    state.change = null
    state.changeNote = ''
    /* THE ONE PLACE THE FILE'S OWN ENDING CAN BE READ. After this the bytes
       are in a box that has already flattened them, so anything not measured
       here is gone. */
    pane.path = result.path
    pane.ending = dominantLineEnding(result.text)
    pane.endingsDisagree = lineEndingsDisagree(result.text)
    pane.text = toPaneText(result.text)
    pane.savedText = pane.text
    delete pane.diskText
    pane.bytes = Number.isFinite(result.bytes) ? result.bytes : null
    pane.modifiedMs = Number.isFinite(result.modifiedMs) ? result.modifiedMs : null
    render()
  }

  async function loadChange(selection) {
    if (!root || (state.busy && state.busy !== 'read-change') || stateIsDirty(state) || typeof selection?.path !== 'string') return
    const patches = boundedChangePatches(selection.patches, [selection], CHANGE_LIMITS.events)
    const unmeasuredEdits = selection.unmeasuredEdits || (selection.added === null || selection.removed === null ? 1 : 0)
    const complete = selection.complete === true && patches.length === selection.patches?.length
    const change = { path: selection.path, added: selection.added, removed: selection.removed, edits: selection.edits ?? 1, unmeasuredEdits, patches }
    // Preserve unchanged refreshes, but a new edit to the same path is a new
    // selection. Patch text is bounded before it enters this comparison.
    const sessionId = typeof selection.sessionId === 'string' ? selection.sessionId : null
    /* The edit chain is part of the identity of this selection: two loads can
       agree on path, counts and patch list and still rebuild different
       originals. Leaving it out let a second edit reuse the first one's panes. */
    const selectionKey = JSON.stringify({ ...change, complete, sessionId,
      substringEdits: selection.editsReversible === true ? selection.substringEdits ?? null : null,
      /* The recorded original is part of this selection's identity too: the
         capture can land after the change was first reported, and a reload
         that ignored it would keep showing the pane built without one. */
      originalCapture: selection.originalCapture ?? null })
    if (state.change && !state.refusal && selectionKey === loadSelectionKey) return
    const revision = ++loadRevision
    loadSelectionKey = selectionKey
    state.change = change
    state.changeNote = 'Loading this file…'
    state.sides = { original: emptyPane('original'), proposed: emptyPane('proposed') }
    state.refusal = null
    state.refusalSide = null
    state.saved = null
    state.busy = 'read-change'
    render()
    let result
    try { result = typeof files?.readChange === 'function' ? await files.readChange(selection.path, sessionId ? { sessionId } : undefined) : { ok: false, code: 'MC_DIFF_CHANGE_READ_UNAVAILABLE' } } catch { result = { ok: false, code: 'MC_DIFF_HANDLER_FAILED' } }
    if (!root || revision !== loadRevision) return
    state.busy = null
    if (!result || result.ok !== true || typeof result.text !== 'string' || typeof result.path !== 'string') {
      state.refusal = result || { code: 'MC_DIFF_READ_FAILED' }
      state.changeNote = ''
      render()
      return
    }
    const current = toPaneText(result.text)
    /* TWO ROUTES TO THE ORIGINAL, AND BOTH VERIFY AGAINST THE FILE ON DISK.
       A retained unified patch is the Codex route. A chain of Claude edits that
       each carried their own before/after text is the other, and without it a
       Claude-driven session could never fill the left pane at all -- measured
       2026-09-17: one file, every file, every session. Either route returns
       null rather than a guess, and null still means no original pane. */
    const rebuilt = !unmeasuredEdits && complete
      ? reverseSessionPatches(result.text, patches)
      : unmeasuredEdits && selection.editsReversible === true && !patches.length
        ? reverseSubstringEdits(result.text, selection.substringEdits) : null
    /* A RECORDED ORIGINAL BEATS A REBUILT ONE, AND ONLY WHEN IT CAN BE PROVED
       EARLY ENOUGH. The capture and the assistant's write are two processes
       racing; a capture that lost the race read the file AFTER the edit, and
       showing that as "before" would be the one wrong original this window
       exists to prevent. The file's own modification stamp settles it: a stamp
       that has moved since the capture is proof the write landed afterwards.
       An equal stamp is NOT proof of the opposite -- the capture may simply be
       of a file nothing has touched -- so it is demoted below the
       reconstructions rather than thrown away. */
    const captured = capturedOriginal(selection, result)
    const original = captured.trusted ? captured.text
      : rebuilt !== null ? rebuilt
      : captured.text !== null ? captured.text
      : null
    /* THE LEFT PANE IS ALWAYS FILLED. It used to be skipped outright whenever
       no original could be established, which left a disabled box nobody could
       read, edit or save beside a file that had certainly changed. Falling back
       to the current file keeps both panes editable and savable while inventing
       nothing; the note below says which of these four it is looking at. */
    const originalText = original === null ? current : original
    for (const side of SIDES) {
      const pane = state.sides[side]
      pane.path = result.path
      pane.sessionId = sessionId
      pane.readOnly = result.readOnly === true
      pane.text = side === 'original' ? originalText : current
      pane.savedText = pane.text
      pane.diskText = current
      pane.ending = dominantLineEnding(result.text)
      pane.endingsDisagree = lineEndingsDisagree(result.text)
      pane.modifiedMs = result.modifiedMs ?? null
      pane.bytes = result.bytes ?? null
    }
    const both = result.readOnly === true ? 'shown for review' : 'editable'
    state.changeNote = captured.trusted
      ? `The original was recorded from this file before this session's first edit to it. Both versions are ${both}.${unmeasuredEdits ? ' Line counts are unavailable for this session, so the totals above are not shown.' : ''}`
      : original === null
      ? `The original version could not be established: this session did not retain a complete patch or an original, and the file may have changed again. BOTH PANES SHOW THE CURRENT FILE, and both are ${both}; recorded changes are available above when retained.`
      : original === captured.text
      ? `The original shown was recorded from this file. No later write has been recorded, so this may not be the version before the edit. Both versions are ${both}.`
      : unmeasuredEdits
      ? `The original is rebuilt from the recorded edits. Line counts are unavailable for this session, so the totals above are not shown; both versions are ${both}.`
      : result.exists === false ? result.readOnly === true
        ? 'This file was deleted. The original is reconstructed on the left; copy it into your editor to restore the file.'
        : 'This file was deleted. Save the original version to restore it.'
        : 'The original is reconstructed by removing the recorded session edits from the current file.'
    if (result.readOnly === true) state.changeNote += ' Review only for this registered session folder; open the file in your editor to save changes.'
    state.refusal = null
    state.refusalSide = null
    state.saved = null
    render()
    // Keep the comparison at its beginning when the panes stack. Focusing the
    // lower textarea here scrolls the original version out of view on arrival.
    root.querySelector('.diff-dialog')?.focus({ preventScroll: true })
  }

  /**
   * The save control under a pane.
   *
   * Warned first unless the person has said not to. The reading of the file's
   * state on disk happens HERE rather than in the warning's own render, so the
   * warning states a fact that was true a moment ago rather than one measured
   * when the window opened.
   */
  async function requestSave(side) {
    if (saveBlockedReason(state, side) !== null) return
    if (state.warningSuppressed) { await commitSave(side); return }
    state.refusal = null
    state.refusalSide = null
    state.busy = `stamp:${side}`
    render()
    let moved = null
    try {
      const pane = state.sides[side]
      const now = await files.stamp(pane.path, pane.sessionId ? { sessionId: pane.sessionId } : undefined)
      if (now && now.ok === true) {
        /* A file that is not there any more has not "changed"; it is gone, and
           the save will create it. Both are covered by the first sentence of
           the warning, so this reports the one thing it can be sure of. */
        moved = now.exists === true && Number.isFinite(now.modifiedMs) && Number.isFinite(state.sides[side].modifiedMs)
          ? now.modifiedMs !== state.sides[side].modifiedMs
          : null
      } else {
        state.refusal = now || { ok: false, code: 'MC_DIFF_HANDLER_FAILED' }
        state.refusalSide = side
      }
    } catch {
      state.refusal = { ok: false, code: 'MC_DIFF_HANDLER_FAILED' }
      state.refusalSide = side
    }
    state.busy = null
    state.warning = { side, moved, remember: false }
    render()
    root?.querySelector('[data-diff-action="confirm-save"]')?.focus()
  }

  async function commitSave(side) {
    const pane = state.sides[side]
    if (!pane || !pane.path || pane.readOnly) return
    if (state.warning && state.warning.remember) {
      state.warningSuppressed = true
      try { prefs?.write?.('off') } catch { /* a settings write that fails must not eat the save */ }
    }
    state.warning = null
    state.refusal = null
    state.refusalSide = null
    state.busy = `save:${side}`
    render()
    const text = pane.text
    /* THE FILE'S OWN LINE ENDINGS GO BACK ON HERE, and this is the only place
       they can: the box gave up the originals the moment it was handed the
       file. `savedText` below stays in the box's plain form, so a person who
       types a character and takes it out again is back to "nothing to save"
       rather than being told a file nobody changed is edited. */
    const fileText = toFileText(text, pane.ending)
    let result
    try { result = await files.save(pane.path, fileText, pane.sessionId ? { sessionId: pane.sessionId } : undefined) } catch { result = null }
    state.busy = null
    if (!result || result.ok !== true) {
      state.refusal = result || {}
      state.refusalSide = side
      render()
      return
    }
    /* `savedText` is set to the exact string that was sent, not to whatever is
       in the box now: a person can keep typing while the write is in flight,
       and marking those later characters as saved would be a lie the unsaved
       indicator would then repeat. */
    pane.savedText = text
    for (const other of Object.values(state.sides)) {
      if (other.path === pane.path && Object.hasOwn(other, 'diskText')) other.diskText = text
    }
    pane.modifiedMs = Number.isFinite(result.modifiedMs) ? result.modifiedMs : null
    pane.bytes = Number.isFinite(result.bytes) ? result.bytes : null
    /* AND THE NOTE ABOUT DISAGREEING LINE ENDINGS IS NOW FALSE, because this
       save is what made them agree. A sentence left on screen after the thing
       it describes has been dealt with is the same defect as the close warning
       above, in a quieter place. */
    pane.endingsDisagree = false
    state.saved = side
    render()
  }

  function cancelSave() {
    state.warning = null
    render()
  }

  /* A close that would throw away hand edits asks once. The owner's ruling is
     about the SAVE being the person's own decision; it says nothing about
     losing an hour of editing to a stray Escape, and this window is the only
     place those edits exist. */
  function requestClose() {
    if (stateIsDirty(state) && !state.confirmingClose) {
      state.confirmingClose = true
      render()
      return
    }
    close()
  }

  function onClick(event) {
    const action = event?.target?.closest?.('[data-diff-action]')
    if (action) {
      const side = action.getAttribute('data-diff-side')
      const name = action.getAttribute('data-diff-action')
      if (name === 'edit-line') {
        const box = root?.querySelector(`[data-diff-pane="${side}"]`)
        if (!box || box.disabled || box.readOnly) return
        const number = Number(action.getAttribute('data-diff-line'))
        let start = 0
        for (let line = 1; line < number; line++) {
          const next = box.value.indexOf('\n', start)
          if (next < 0) break
          start = next + 1
        }
        const end = box.value.indexOf('\n', start)
        box.focus()
        box.setSelectionRange?.(start, end < 0 ? box.value.length : end)
        return
      }
      if (name === 'close') { requestClose(); return }
      if (name === 'pick') { void pick(side); return }
      if (name === 'save') { void requestSave(side); return }
      if (name === 'cancel-save') { cancelSave(); return }
      if (name === 'confirm-save') { void commitSave(state.warning ? state.warning.side : null); return }
      return
    }
    /* The backdrop does NOT close this window. Everywhere else in the product a
       stray backdrop click costs a re-open; here it would cost the edits. */
  }

  function onChange(event) {
    if (event?.target?.dataset?.diffRemember === undefined) return
    if (state.warning) state.warning.remember = Boolean(event.target.checked)
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault?.()
      if (state.warning) { cancelSave(); return }
      requestClose()
      return
    }
    if (event.key !== 'Tab' || !root) return
    const dialog = root.querySelector('.diff-dialog')
    if (!dialog) return
    const stops = [...dialog.querySelectorAll(FOCUSABLE)].filter(node => !node.disabled && node.tabIndex !== -1)
    if (!stops.length) { event.preventDefault?.(); dialog.focus?.(); return }
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && documentRef?.activeElement === first) {
      event.preventDefault?.()
      last.focus?.()
    } else if (!event.shiftKey && documentRef?.activeElement === last) {
      event.preventDefault?.()
      first.focus?.()
    }
  }

  function open(host) {
    root = host
    state.warningSuppressed = readWarningPreference()
    root.addEventListener('input', onInput)
    root.addEventListener('change', onChange)
    root.addEventListener('click', onClick)
    documentRef?.addEventListener?.('keydown', onKeydown)
    render()
    root.querySelector('.diff-dialog')?.focus?.()
    return state
  }

  function close() {
    clearTimeout(comparisonTimer)
    loadRevision++
    if (root) {
      root.removeEventListener('input', onInput)
      root.removeEventListener('change', onChange)
      root.removeEventListener('click', onClick)
      root.innerHTML = ''
    }
    documentRef?.removeEventListener?.('keydown', onKeydown)
    root = null
    paneControls = {}
    if (typeof onClose === 'function') onClose()
  }

  return {
    open,
    close,
    state,
    pick,
    loadChange,
    requestSave,
    commitSave,
    cancelSave,
    requestClose,
    onKeydown,
    renderCount: () => renderCount,
  }
}

/**
 * THE DOOR ONTO THIS WINDOW, AND THE ONLY PLACE IT IS MOUNTED.
 *
 * THE WINDOW GOES WITH THE PAGE THAT OPENED IT. src/cloud-mirror-setup.js's own
 * note in src/views/settings.js spells out why, because that page shipped the
 * defect first: the host node is on document.body, not inside the view, so
 * nothing else takes it down -- leaving the page with the dialog open left a
 * modal over whatever came next, listening on document keydown, holding edits
 * nobody could see, and the view's closure was gone so the row opened a SECOND
 * one on top of it. `close()` is the half a page's destroy() has to call, and
 * `open()` returning the window it already has is the other half.
 *
 * EVERYTHING THE WINDOW TALKS TO ARRIVES THROUGH ONE OF THESE ARGUMENTS, so
 * this is drivable rather than assertable-from-source: `bridge` is
 * shell/fleet-profile-preload.cjs's `mcDiff`, read per open so a page built
 * before the bridge existed still gets it, and `storage` is the settings store
 * that keeps the person's answer to the warning.
 */
export function createCompareFilesDoor({
  documentRef = globalThis.document,
  bridge = () => globalThis.mcDiff,
  storage = () => globalThis.localStorage,
  create = createDiffEditor,
} = {}) {
  let editor = null
  let host = null
  let opener = null
  let openerPanel = null
  const selectedFile = selection => {
    if (typeof selection?.path === 'string') return selection
    // A list-only request can use its selected row (or its first row). Never
    // replace an explicit but unavailable target with a different file.
    if (!selection || Object.hasOwn(selection, 'path') || !Array.isArray(selection.files)) return null
    const index = Number.isInteger(selection.activeIndex) && selection.activeIndex >= 0 && selection.activeIndex < selection.files.length
      ? selection.activeIndex : 0
    const file = selection.files[index]
    if (typeof file?.path !== 'string') return null
    return { ...file, patches: file.patches ?? boundedChangePatches(selection.patches, [file]) }
  }
  return {
    open(selection) {
      const selected = selectedFile(selection)
      // Reuse the window, while honoring a newly requested file. The editor
      // protects unsaved edits and rejects stale asynchronous read results.
      if (editor) {
        if (selected) void editor.loadChange?.(selected)
        return editor
      }
      opener = documentRef.activeElement
      openerPanel = opener?.closest?.('[data-session-changes]') || null
      host = documentRef.createElement('div')
      documentRef.body.appendChild(host)
      editor = create({
        documentRef,
        files: bridge(),
        prefs: {
          read: () => { try { return storage()?.getItem(WARNING_PREFERENCE_KEY) ?? null } catch { return null } },
          write: value => { try { storage()?.setItem(WARNING_PREFERENCE_KEY, value) } catch { /* a settings write that fails must not eat the save */ } },
        },
        /* A role="dialog" left in the tree while closed is announced as though
           it were open, so the host node goes when the window does. */
        onClose: () => {
          host?.remove(); host = null; editor = null
          if (opener?.isConnected !== false) opener?.focus?.()
          else openerPanel?.querySelector('[data-changes-toggle]')?.focus?.()
          opener = null; openerPanel = null
        },
      })
      editor.open(host)
      if (selected) void editor.loadChange?.(selected)
      return editor
    },
    /* A CLOSE FROM THE PAGE IS NOT A CLOSE FROM THE PERSON, AND IT DOES NOT
       ASK. requestClose() -- the × and Escape -- asks once when a pane is
       unsaved, because a stray key must not cost an hour of typing. A page
       being destroyed cannot ask: there is nothing left for a second press to
       land on, and a window that refused to go is the exact defect this exists
       to prevent, sitting over whatever page came next. So navigating away with
       unsaved edits loses them. That is the trade deliberately taken, and the
       overlay covering the whole page is what keeps it an act rather than an
       accident: the page behind it cannot be clicked. */
    close() { editor?.close() },
    isOpen: () => editor !== null,
  }
}
