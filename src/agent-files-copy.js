/* EVERY WORD THE FILES-AND-REPORTS PANEL SAYS.
 *
 * Its own module, for the reason src/agent-availability-copy.js is its own
 * module: a copy test written against source text passes when the table is
 * right and the lookup is wrong. This imports no DOM and no view, so
 * `node --test` can hold it and assert the sentence a refusal produces.
 *
 * THE CODE NEVER REACHES THE GLASS, AND NEITHER DOES `reason`.
 *
 * The main process replies {ok:false, code, reason}. The code is carried on the
 * node by markRefusalCode() so a support conversation can still name it. The
 * `reason` is deliberately NOT shown, which is a departure from
 * refusalSentence()'s usual behaviour and the departure is the point: two of
 * these reasons are written by somebody other than this product. `openPath`
 * hands back whatever Windows said, which can carry the file's full path; the
 * workspace boundary hands back a sentence written for whoever holds the
 * repository. Both belong in the log this shell already writes, and neither
 * belongs in front of a person.
 *
 * So the table below is the whole vocabulary, and refusalRemedy() from
 * src/refusal-copy.js is the FLOOR: a code nobody here has written a sentence
 * for still produces a whole sentence with something to do in it, and never the
 * identifier. That is the same arrangement the availability table uses, and it
 * is what stops the next code added in the shell reaching a customer bare.
 *
 * ONE SENTENCE IS NOT WRITTEN HERE. "The product's own workspace" is the label
 * the start panel already uses for the folder an agent runs in when nobody
 * picked one (src/fleet-tree-copy.js). It is imported rather than retyped: two
 * names for one folder is how a person comes to believe there are two folders.
 */

import { formatBytes } from './account-reset-copy.js'
import { START_PANEL } from './fleet-tree-copy.js'
import { refusalRemedy } from './refusal-copy.js'

export const FILES_PANEL = Object.freeze({
  title: 'Files and reports',
  /* WHERE THIS LIST COMES FROM, said plainly and first, because it is not what
     a reader will assume. Nothing in this product records which files an agent
     wrote -- measured across the shell and the renderer -- so a panel headed
     "what your agent made" would be a claim nothing on this computer can
     support. It lists the folder instead, and says so. */
  source: 'These are the files in the folder your agents work in, newest first.',
  honesty: 'Nothing yet records which of them an agent wrote, so all of them are shown.',
  folderLabel: 'Folder',
  /* The folder an agent runs in when nobody picked one. Same words as the start
     panel, from the same place. */
  productFolder: START_PANEL.folderWorkspace,
  refresh: 'Refresh',
  open: 'Open',
  reveal: 'Show in folder',
  read: 'Read here',
  close: 'Close',
  reading: 'Reading…',
  opening: 'Opening…',
  showing: 'Showing…',
  loading: 'Reading the folder…',
  /* Not an empty box. The rule for this panel is that an empty folder is a
     sentence, because a bordered table with no rows in it tells a person their
     computer is broken. */
  emptyFolder: 'This folder has no files in it yet.',
  noFolders: 'No folder has been set up for your agents yet. Choose one in Settings, under the folders your agents work in.',
  /* The state a page in a browser is in. The controls stay on screen and
     disabled with this beside them, rather than disappearing, so nobody hunts
     for a control that was never drawn. */
  needsApp: 'Opening a file needs the installed application, and only it can hand a file to the program that opens it.',
  opened: 'Handed over. The program that opens this kind of file should appear in a moment.',
  revealed: 'Asked this computer to show the file. Look behind this window for the folder.',
  /* Beside the one control on a row that cannot succeed. */
  openInstead: 'Open it instead',
  /* BESIDE A REFUSED OPEN, and the whole reason the panel has a second one of
     these. The rule it states is the shell's OPENABLE_EXTENSIONS: a kind whose
     registered program is an interpreter is never handed over, however plainly
     the file is sitting in a folder the person chose. It names the way to the
     file that is still open to them, because a refusal that leaves nowhere to
     go is the defect tools/check-plain-language.mjs exists to catch. */
  openRefused: 'This kind of file can start a program, so this window will not open it. Use Show in folder instead.',
  /* And beside a Read on the same row. A file that this window cannot show AND
     must not hand over has one way left, and "Open it instead" would be false. */
  showInstead: 'Use Show in folder to open this one.',
  /* A FOLDER WITH NO LAST SEGMENT. A workspace root of `C:\` has no name to
     print, and printing the path instead would put an installation path on the
     glass through the one field a folder reply carries. */
  folderUnnamed: 'A folder your agents work in',
})

/* THE REFUSALS THAT MEAN THE FENCE ITSELF IS ABSENT, mirrored from
   FENCE_CODES in shell/agent-files.cjs -- a copy this module cannot import,
   because it must stay loadable without the shell, so a suite asserts the two
   lists are the same list. They are the states in which NOTHING on this panel
   can succeed, which is why they switch its controls off rather than just
   saying something. */
export const FENCE_REFUSAL_CODES = Object.freeze([
  'FILES_PAYLOAD_ABSENT',
  'FILES_FENCE_ABSENT',
  'FILES_FENCE_UNRECOGNIZED',
])

/* WHAT EACH REFUSAL SAYS. Every entry names something to do, because a refusal
   that only diagnoses leaves a person holding a dead end -- the rule
   tools/check-plain-language.mjs enforces and src/refusal-copy.js was written
   for. The three fence failures share one sentence on purpose: "no payload",
   "no boundary module" and "a boundary this shell does not recognise" are three
   causes of one thing a person can act on. */
export const FILES_REFUSAL = Object.freeze({
  FILES_PAYLOAD_ABSENT: 'This copy of the program cannot tell which folder a file is in, so it will not open one. That part of it is missing and has to be put back before files can be opened.',
  FILES_FENCE_ABSENT: 'This copy of the program cannot tell which folder a file is in, so it will not open one. That part of it is missing and has to be put back before files can be opened.',
  FILES_FENCE_UNRECOGNIZED: 'This copy of the program cannot tell which folder a file is in, so it will not open one. That part of it is missing and has to be put back before files can be opened.',
  FILES_FOLDER_UNKNOWN: 'That folder is not one this computer works in. Pick another one from the list.',
  FILES_FOLDER_UNREADABLE: 'That folder could not be read. Check it is still on this computer, then press Refresh.',
  FILES_NAME_REFUSED: 'That is not a file in this folder. Pick one from the list.',
  FILES_OUTSIDE_FOLDER: 'That name leads out of the folder you picked, so nothing was opened. Pick another file from the list.',
  FILES_NOT_THERE: 'That file is not in the folder any more. Press Refresh to see what is there now.',
  FILES_NOT_A_FILE: 'That is a folder, not a file. Pick a file from the list.',
  FILES_NO_PROGRAM: 'Nothing on this computer is set up to open that kind of file. Use Show in folder, then open it from there.',
  FILES_NOT_OPENABLE: 'That kind of file can start a program on this computer, so it was not handed over. Use Show in folder, then open it yourself.',
  FILES_OPEN_FAILED: 'The file could not be handed to this computer. Try again, or use Show in folder.',
  FILES_REVEAL_FAILED: 'The folder could not be shown. Try again, or open the file instead.',
  FILES_NOT_TEXT: 'This pane shows written notes and reports. Press Open to read this one.',
  FILES_TOO_BIG: 'This file is too long to show here. Press Open to read the whole thing.',
  FILES_READ_FAILED: 'The file could not be read. Check it is still there, then press Refresh.',
})

/**
 * The sentence for a refusal from the file bridge.
 *
 * Takes the whole reply rather than the code, so a caller cannot accidentally
 * pass `result.reason` and put the shell's own words on the glass. An unknown
 * code, an absent one, or a reply that is not a refusal at all still produces a
 * whole sentence: refusalRemedy() is the floor and it never returns an empty
 * string and never returns an identifier.
 */
export function fileRefusalSentence(result) {
  const code = result && typeof result === 'object' && typeof result.code === 'string' ? result.code.trim() : ''
  if (code && Object.hasOwn(FILES_REFUSAL, code)) return FILES_REFUSAL[code]
  return refusalRemedy(code)
}

/** What kind of thing this row is, in words rather than in a key. */
export function fileKindLabel(kind) {
  if (kind === 'report') return 'Report'
  if (kind === 'text') return 'Written notes'
  /* NAMED FOR WHAT IT CAN DO, not for its extension. This is the row whose Open
     is switched off, and a person deciding whether to read it first is owed the
     reason in the same words the refusal beside it uses. */
  if (kind === 'script') return 'A file that can run'
  return 'File'
}

/**
 * The right-hand half of a row: what it is, how big, and when it last changed.
 *
 * The date is the person's own locale. A date that will not parse contributes
 * nothing rather than the words "Invalid Date", which is the shape this
 * codebase keeps finding: a failed read rendered as if it were a value.
 */
export function fileMetaText(file, { locale = undefined } = {}) {
  const parts = [fileKindLabel(file?.kind)]
  if (Number.isFinite(file?.bytes)) parts.push(formatBytes(file.bytes))
  const changed = typeof file?.changedAt === 'string' ? new Date(file.changedAt) : null
  if (changed && !Number.isNaN(changed.getTime())) {
    try {
      parts.push(changed.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }))
    } catch {
      parts.push(changed.toISOString().slice(0, 10))
    }
  }
  return parts.join(' · ')
}

/**
 * The name a folder is offered under.
 *
 * THE TWO NAMELESS CASES ARE NOT THE SAME CASE. The product's own workspace has
 * no name because its path must never cross; a folder the person chose can have
 * no name because a drive root has no last segment. Printing the product's
 * label for the second one would tell somebody their own folder is ours.
 */
export function folderLabel(folder) {
  if (!folder || typeof folder !== 'object' || folder.kind === 'product') return FILES_PANEL.productFolder
  if (typeof folder.name !== 'string' || folder.name.trim() === '') return FILES_PANEL.folderUnnamed
  return folder.name
}

/**
 * The line above the list when the folder holds more files than one screen
 * should carry. Absent -- an empty string -- when it does not, so a caller can
 * render it or not without asking a second question.
 */
export function truncatedLine(reply, shown) {
  if (!reply || reply.truncated !== true) return ''
  return `Showing the newest ${shown} files of ${reply.total}.`
}

/** A reply that answered something other than yes. `null` counts: a bridge that
    threw told us nothing, and nothing is not "there are no folders". */
function refused(reply) {
  return !reply || reply.ok !== true
}

function fenceIsGone(reply) {
  return Boolean(reply) && FENCE_REFUSAL_CODES.includes(reply.code)
}

/**
 * WHICH SLOT SAYS WHAT, FOR ONE STATE OF THIS PANEL -- the whole composition,
 * in one pure function.
 *
 * WHY THIS IS NOT INSIDE THE PANEL. tools/check-composed-output.mjs exists
 * because two panels in this product each said one condition twice, in two
 * boxes, and every string in them passed the copy gate one at a time. That gate
 * can only measure a panel it can BUILD, and it builds no DOM -- so a panel
 * whose composition lives in its render function is a panel the gate cannot
 * see. This one's lives here, the renderer applies it, and the gate measures
 * the same function the screen uses.
 *
 * THE RULE IT ENFORCES, and it is the rule that gate's first finding names: one
 * condition goes in ONE slot and the others stay empty. A panel-level condition
 * -- no application behind the page, no folder set up, no fence in this copy of
 * the program -- is a notice above the controls, and the list stays empty
 * because the list is not what failed. A LIST-level refusal is a sentence where
 * the rows would have been, and the status line stays empty and carries only
 * the code. The empty folder is the same shape: one sentence, in the list.
 *
 * IT ALSO ANSWERS WHICH CONTROLS MAY STAY LIVE, because "the screen says why
 * and switches its controls off" was a claim this panel made and did not keep:
 * with no fence, every verb refused and the chooser and Refresh stayed on.
 *
 * @param available  is there an application behind this page at all
 * @param folders    the last reply from folders(), or null
 * @param list       the last reply from list(), or null
 * @param action     {verb, result} of the last press, or null
 */
export function filesPanelSlots({ available = true, folders = null, list = null, action = null } = {}) {
  const slots = {
    notice: '', listLine: '', listNote: '', status: '', tone: '',
    controlsWhy: '', chooserWhy: '', refusal: null, rows: false,
  }

  if (!available) {
    slots.notice = FILES_PANEL.needsApp
    slots.controlsWhy = FILES_PANEL.needsApp
    return Object.freeze(slots)
  }

  if (folders !== null && refused(folders)) {
    slots.notice = fileRefusalSentence(folders)
    slots.refusal = folders
    /* A fence that is not there cannot come back on a press, so nothing on this
       panel is left live to press. Any other refusal might be a folder that
       came back, and Refresh is exactly how a person finds out. */
    if (fenceIsGone(folders)) slots.controlsWhy = slots.notice
    return Object.freeze(slots)
  }

  const known = Array.isArray(folders?.folders) ? folders.folders : []
  if (folders !== null && known.length === 0) {
    slots.notice = FILES_PANEL.noFolders
    /* The chooser only. Refresh stays live BECAUSE the sentence sends a person
       to Settings and back, and a control that refused to notice they did as
       they were told is worse than no sentence at all. */
    slots.chooserWhy = FILES_PANEL.noFolders
    return Object.freeze(slots)
  }

  if (list !== null && refused(list)) {
    const sentence = fileRefusalSentence(list)
    slots.refusal = list
    if (fenceIsGone(list)) {
      slots.notice = sentence
      slots.controlsWhy = sentence
    } else {
      slots.listLine = sentence
    }
    return Object.freeze(slots)
  }

  const files = Array.isArray(list?.files) ? list.files : []
  if (list !== null && files.length === 0) slots.listLine = FILES_PANEL.emptyFolder
  else if (list !== null) {
    slots.rows = true
    slots.listNote = truncatedLine(list, files.length)
  }

  if (action && refused(action.result)) {
    slots.status = fileRefusalSentence(action.result)
    slots.tone = 'refused'
    slots.refusal = action.result
  } else if (action?.verb === 'open') {
    slots.status = FILES_PANEL.opened
    slots.tone = 'confirmed'
  } else if (action?.verb === 'reveal') {
    slots.status = FILES_PANEL.revealed
    slots.tone = 'confirmed'
  }
  /* A successful Read says nothing: the reading pane opening IS the answer, and
     a line under it announcing that it opened is the panel talking to itself. */

  return Object.freeze(slots)
}

/**
 * The reason a row's Open cannot succeed, or an empty string when it can.
 *
 * ONE PLACE, because the panel needs it for the control's own state and the
 * composed-output gate needs it for the words on screen, and two copies of a
 * rule about which control is off is how a control comes to be off with the
 * wrong reason on it.
 */
export function openWhy(file, { available = true } = {}) {
  if (!available) return FILES_PANEL.needsApp
  return file?.openable === true ? '' : FILES_PANEL.openRefused
}

/** The reason a row's Read here cannot succeed, or an empty string. */
export function readWhy(file, { available = true } = {}) {
  if (!available) return FILES_PANEL.needsApp
  if (file?.readable === true) return ''
  /* "Open it instead" is only true if Open is live on this row. When the same
     file is one this window will not hand over either, the one way left is the
     file manager, and saying otherwise sends a person to a switched-off
     control. */
  return file?.openable === true ? FILES_PANEL.openInstead : FILES_PANEL.showInstead
}
