/* THE WORDS THE LEDGER PAGE USES, IN THE ONE FILE THAT HAS NO BROWSER IN IT.
 *
 * WHY THESE STRINGS LEFT THE VIEW. src/views/ledger.js imports a stylesheet, so
 * a plain `node` run cannot load it, and every sentence this page shows when it
 * has no rows was composed inside a closure in there. That matters because the
 * defect on this page is not any one sentence. The owner's word for it was "a
 * mess (not human friendly)", and what he was looking at was one state told
 * three different ways at once: a red "could not be read" in the register's
 * accessible name and in its counter, a calm "this copy does not keep one, so
 * there is nothing here to show" in the paragraph between them, and below that
 * two red forms whose fields described themselves in terms of a list that was
 * not on the screen. Every sentence, read on its own, was defensible.
 *
 * A check that reads string literals one at a time cannot see that, which is
 * how tools/check-plain-language.mjs passed the whole thing. So the strings
 * live here, where a plain `node` run can build the WHOLE panel for a state and
 * measure it as one thing -- see tools/check-composed-output.mjs.
 *
 * TWO STATES THAT LOOK THE SAME AND ARE NOT, and keeping them apart is most of
 * the repair:
 *
 *   EMPTY      the read answered, and there is nothing in it. Since 2026-09-02
 *              the installed application keeps the person's own request
 *              ledger, so this is a fresh install nobody has filed into yet --
 *              the ordinary first state, with the two ways to file named in
 *              the sentence. Nothing is wrong.
 *   UNREADABLE the read did not answer. Something is there and could not be
 *              trusted, or the read never finished. That is a fault, it has a
 *              different repair, and it is the only one of the two that has
 *              earned the words "could not".
 *
 * src/ledger-live.js tells them apart: a read that answered comes back ok
 * with its rows (none, for a fresh install); a read that fell over comes back
 * ok: false with its reason. That is the signal, and the page keeps it.
 */

/* The read is still in flight. Not a failure and not an empty answer -- the
   third thing, and it is only on screen for a moment. */
export const LEDGER_LOADING = Object.freeze({
  state: 'loading',
  tone: 'note',
  label: 'Reading your requests',
  className: 'projection-loading',
  body: 'Reading your requests…',
  count: 'reading…',
  countsKnown: false,
  door: false,
})

/* WHAT THIS LIST IS, SAID PLAINLY. Since 2026-09-02 the installed application
   keeps the person's own request ledger and the page reads it live, so an
   empty list is a list nothing has been filed into yet -- and the two ways to
   file into it are named right here, because "nothing yet" with no door is a
   dead end with a calm face. */
export const LEDGER_EMPTY = Object.freeze({
  state: 'empty',
  tone: 'note',
  label: 'Your requests, of which there are none',
  className: 'projection-empty',
  /* The box sits ABOVE the list (owner, 2026-09-15), so the sentence points
     up at it (T1262). */
  body: 'There is nothing on file yet. File a request above, or type /Request in any chat.',
  count: 'nothing to show',
  countsKnown: true,
  /* No door: a fresh install with nothing on file has no problem for the
     guide to solve. The unreadable state keeps its door. */
  door: false,
})

/* The sentence inside a register that answered with rows to draw and, after
   the scope filter and the hide set, has none left to draw here. */
export const EMPTY_LIST = Object.freeze({
  r: 'There are no requests in this list. File one above, or type /Request in any chat.',
  /* All has no filing box of its own; it says where filing is (T1262). */
  all: 'There are no records in this list. Choose Rules or Tasks to file one, or type /Request or /Task in any chat.',
  q: 'There are no questions waiting on a decision.',
  /* THE OWNER'S FOUR SUBSETS (2026-09-07): T tasks, A asks, P purchases.
     A keeps q's sentence too -- it is drawn beside the questions half of that
     tab, which q's wording already describes, and gains its own for the
     kind-A ledger records beside it. */
  t: 'There are no tasks in this list.',
  a: 'There are no asks waiting on an answer.',
  p: 'There are no purchases in this list.',
})

/* A GENUINE FAILURE, WORDED SO IT CANNOT BE MISTAKEN FOR THE ONE ABOVE. It says
   what happened, that nothing was changed, and the one thing worth doing. It
   does NOT put the underlying reason in the sentence: that reason comes from a
   file and can be a schema complaint. It rides on the element as data instead,
   the way src/refusal-copy.js carries a code. */
export const LEDGER_UNREADABLE = Object.freeze({
  state: 'unreadable',
  tone: 'refused',
  label: 'Your requests could not be read',
  className: 'projection-unavailable',
  body: 'Your requests could not be read, so this page cannot show them. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
  count: 'could not be read',
  countsKnown: false,
  door: true,
})

export const QUESTIONS_EMPTY = Object.freeze({
  state: 'empty',
  tone: 'note',
  label: 'Your questions, of which there are none',
  className: 'projection-empty',
  body: 'This list holds questions that are waiting on a decision from you. There are none, so there is nothing here to show.',
  count: 'nothing to show',
  countsKnown: true,
  door: true,
})

export const QUESTIONS_UNREADABLE = Object.freeze({
  state: 'unreadable',
  tone: 'refused',
  label: 'Your questions could not be read',
  className: 'projection-unavailable',
  body: 'Your questions could not be read, so this page cannot show them. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
  count: 'could not be read',
  countsKnown: false,
  door: true,
})

/* THE OWNER'S FOUR SUBSETS (2026-09-07): T, the kind-A half of A, P and all
   share ONE read -- the same live ledger feed the R tab already reads, only
   filtered to a different letter -- so a read that fell over says so in the
   same two words on every one of those tabs, unlike R's and Q's, which each
   earned their own noun because each one is its own separate read. Nothing
   here names "requests" or "questions": it must be true on all four tabs
   at once. */
export const KIND_EMPTY = Object.freeze({
  state: 'empty',
  tone: 'note',
  label: 'Nothing on file',
  className: 'projection-empty',
  body: 'There is nothing on file in this list yet.',
  count: 'nothing to show',
  countsKnown: true,
  door: false,
})

export const KIND_UNREADABLE = Object.freeze({
  state: 'unreadable',
  tone: 'refused',
  label: 'This list could not be read',
  className: 'projection-unavailable',
  body: 'This list could not be read, so this page cannot show it. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
  count: 'could not be read',
  countsKnown: false,
  door: true,
})

/* A LEDGER FILE THAT IS DAMAGED, NOT MERELY UNREAD (T1382). Closing and
   reopening cannot repair a file cut in half, and "needs attention" named
   nothing; this says what is wrong and the repair that works, and points at
   no unrelated Settings page. The file's name is said; its path never crosses
   into the page. */
export const LEDGER_DAMAGED = Object.freeze({
  state: 'damaged',
  tone: 'refused',
  label: 'Your Ledger file is damaged',
  className: 'projection-unavailable',
  body: 'Your Ledger file on this computer is damaged, so this page cannot show it, and nothing can be filed. Nothing was changed. Reopening ToolsEnabled will not repair it. Replace OWNER-REQUEST-LEDGER.json with the backup copy beside it, the one ending in .bak, then open this page again.',
  bodyNoBackup: 'Your Ledger file on this computer is damaged, so this page cannot show it, and nothing can be filed. Nothing was changed. Reopening ToolsEnabled will not repair it. Restore OWNER-REQUEST-LEDGER.json from a backup of this computer, then open this page again.',
  count: 'damaged',
  countsKnown: false,
  door: false,
})

/* THE FILE BOX WHILE THE LEDGER CANNOT BE READ (T1382): off, with the reason,
   rather than on and answering "Try once more". */
export const FILE_BOX_OFF = Object.freeze({
  damaged: 'Filing is off because the Ledger file is damaged. Restore it first; nothing you type here is lost.',
  unreadable: 'Filing is off until the Ledger can be read. Nothing you type here is lost.',
})

/* THE STATES THE REGISTER CAN BE IN WITH NOTHING TO DRAW, declared rather than
   discovered, so tools/check-composed-output.mjs measures every one of them and
   a state added later cannot arrive unmeasured. */
export const REGISTER_NOTICE_STATES = Object.freeze(['loading', 'empty', 'unreadable', 'damaged'])

const NOTICES = Object.freeze({
  loading: LEDGER_LOADING,
  empty: LEDGER_EMPTY,
  unreadable: LEDGER_UNREADABLE,
  damaged: LEDGER_DAMAGED,
})

const QUESTION_NOTICES = Object.freeze({
  loading: LEDGER_LOADING,
  empty: QUESTIONS_EMPTY,
  unreadable: QUESTIONS_UNREADABLE,
})

const KIND_NOTICES = Object.freeze({
  loading: LEDGER_LOADING,
  empty: KIND_EMPTY,
  unreadable: KIND_UNREADABLE,
  damaged: LEDGER_DAMAGED,
})

/**
 * What the register shows when it has no rows, or null when it has rows.
 *
 * ONE NOTICE, ONE STORY. The paragraph, the accessible name, the counter, the
 * state marker and whether the totals above are knowable all come out of the
 * same object, so they cannot disagree with each other again.
 */
export function registerNotice(source, { mode = 'r' } = {}) {
  if (!source) return null
  const table = mode === 'q' ? QUESTION_NOTICES : (mode === 'r' ? NOTICES : KIND_NOTICES)
  const notice = table[source.kind] || null
  /* The damaged notice names the .bak only when one is really there. */
  if (notice === LEDGER_DAMAGED && source.backup === false) return Object.freeze({ ...notice, body: notice.bodyNoBackup })
  return notice
}

/* ---------------------------------------------------------------- forms -- */

/* WHY THE FORMS WERE UNREADABLE, AND IT WAS NOT THE WORD COUNT.
 *
 * Both asked for "its number, as shown in the list" -- on a page whose list, in
 * the state a first-time reader meets, is empty. The field sent the person to
 * read something that was not there. And the Approve/Decline form was not
 * connected to the list above it in any way: the register shows requests, the
 * field took free text, and nothing checked that what was typed was one of the
 * things on screen.
 *
 * So the label says what the field is, the field is filled FROM the register
 * whenever the register has anything in it, and when it does not the control is
 * off with the reason beside it rather than open and useless. */
export const DECISION_FORM = Object.freeze({
  title: 'Approve or decline a request',
  targetLabel: 'Which request',
  /* When the register has rows the field is a picker and needs no example. */
  targetHint: 'Choose the one you want to answer.',
  /* When it does not -- the demonstration list, or a copy with no register --
     the field is typed, and the example is a shape rather than a pointer at
     something that may not be on screen. */
  targetHintTyped: 'Type the reference of the request, which looks like R1152.',
  reasonLabel: 'Why',
  reasonHint: 'Recorded with your decision. The rest of the system acts on this.',
  approve: 'Approve',
  decline: 'Decline',
})

export const QUEUE_FORM = Object.freeze({
  title: 'Take or finish queued work',
  reveal: 'Show queued work',
  hide: 'Hide queued work',
  rootLabel: 'Folder',
  itemLabel: 'Which item',
  itemHint: 'The item’s short number in that folder’s work list, such as 3.',
  reasonLabel: 'Why you are closing it',
  reasonHint: 'Needed only when you close one.',
  claim: 'Claim',
  close: 'Close',
})

/* THE ONE LINE UNDER THE QUEUE BUTTONS, AND THE ONE REFUSAL ON THIS SURFACE
   THAT WAS WRITTEN BY HAND INSTEAD OF THROUGH refusalSentence().
 *
 * It read: "This folder's work list could not be read, so Claim and Close are
 * off." followed by whatever the layer said -- which, until the engine's
 * typedError() stopped replacing every message with a constant, was always the
 * same six words: "The audited dependency refused the action." That is the red
 * line the owner was looking at, and it is why it read differently from every
 * other refusal in the product.
 *
 * The check on the current list is stated here rather than asked for in a box.
 * It used to be a visible 64-character field labelled "Proof you are looking at
 * the current list", filled in for the person, that they could not type into. */
/* `context.folders` is how many folders the picker offers, when the caller
   knows (T1472): with one there is no other folder to choose, and a line that
   told the person to choose one, or to press a Retry that is not on screen,
   was advice that could not be followed. Without context the line keeps its
   general wording. */
export function queueSnapshotLine(snapshot, context = {}) {
  const ready = snapshot?.ok === true && /^[a-f0-9]{64}$/.test(snapshot?.hash || '')
  if (ready) {
    return Object.freeze({
      ready: true,
      tone: 'ready',
      text: 'That folder’s work list was read just now, so Claim and Close will act on what you are looking at.',
    })
  }
  const said = typeof snapshot?.reason === 'string' && /[a-z]/.test(snapshot.reason) ? snapshot.reason.trim() : ''
  const because = said ? ` ${/[.!?…]$/.test(said) ? said : `${said}.`}` : ''
  const folders = Number.isSafeInteger(context?.folders) ? context.folders : null
  const next = folders === null ? ' Choose another folder, or press Retry above.'
    : folders > 1 ? ' Choose another folder.'
      : ' There is no other folder to choose, so this computer may have no queued work.'
  return Object.freeze({
    ready: false,
    tone: 'unavailable',
    text: `Claim and Close are off, because that folder’s work list was not read.${because}${next}`,
  })
}

/* WHY A CONTROL IS OFF, SAID WHERE THE CONTROL IS.
 *
 * A disabled button with no sentence beside it is the most common lie a screen
 * tells: it looks like the person did something wrong. Each of these names the
 * state, so the reason sits next to the thing it explains instead of having to
 * be inferred from a paragraph further up the page. */
/* EACH ONE CARRIES ITS OWN TONE, and that is the half of this repair that is
   easy to miss. A control that is off because there is NOTHING TO DO is not a
   failure and must not be painted as one -- painting it red is the same defect
   as the register's, one level down: the words say "there is nothing here" and
   the colour says "something went wrong". Only the unreadable case has earned
   the failure colour. */
/* THE WHOLE AUDITED-ACTIONS BLOCK USED TO VANISH WITHOUT A WORD.
 *
 * mountLedgerWriteSurface opens with `if (!decisionEnabled && !queueEnabled)
 * return () => {}`, and both flags default to off -- isWriteEnabled reads
 * localStorage and answers false when nothing is stored, which is every fresh
 * install. So the forms, the Approve and Decline buttons and the queue controls
 * were simply ABSENT, and nothing on the page accounted for them.
 *
 * The owner's own question is the evidence this needed saying: "why cant i see
 * or edit what the R items are?" The feature was built and working the whole
 * time. It was two switches away and the page never mentioned them.
 *
 * The tone is 'note', deliberately, and DECISION_OFF's own header says why: a
 * control that is off because nobody turned it on is not a failure, and
 * painting it as one would be the same defect one level down. This says where
 * the switch is, which is the only thing the reader is missing. */
export const WRITE_ACTIONS_OFF = Object.freeze({
  tone: 'note',
  text: 'Approving, declining and taking queued work are switched off. Turn on "Approve or decline" or "Take or finish queued work" in Settings to show them here.',
})

export const DECISION_OFF = Object.freeze({
  loading: Object.freeze({
    tone: 'note',
    text: 'Approve and Decline switch on once your requests have been read.',
  }),
  empty: Object.freeze({
    tone: 'note',
    text: 'There is nothing to approve or decline yet. Once a request is on file, this fills in from the register.',
  }),
  unreadable: Object.freeze({
    tone: 'unavailable',
    text: 'Approve and Decline are off until your requests can be read, because nothing can check that what you answer is really one of them.',
  }),
})

/**
 * Why the Approve/Decline form is off, as the sentence and the colour together.
 *
 * Returns null when the control should simply work, which is the state that
 * needs no explanation.
 */
export function decisionOff(register) {
  if (!register) return null
  if (register.kind === 'loading') return DECISION_OFF.loading
  if (register.kind === 'unreadable' || register.kind === 'damaged') return DECISION_OFF.unreadable
  if (register.kind === 'empty') return DECISION_OFF.empty
  if (register.kind === 'live' && (register.items || []).length === 0) return DECISION_OFF.empty
  return null
}

/* ------------------------------------------------------- hiding a row -- */

/* THE × ON A ROW, AND EVERY WORD AROUND IT.
 *
 * WHAT THE CONTROL REALLY DOES, which is what the words must say. Three lists
 * were looked at for "delete" (plan O6) and none of them has an honest one: an
 * owner request lives in an append-only, hash-chained ledger that is never
 * shortened, an archived request still reaches every projected list until
 * three separate sessions have seen it, and an owner question is parsed out of
 * a planning file the app has no writer for. So a × here hides the row on this
 * screen, in this copy's own storage, and changes nothing else anywhere. Every
 * sentence below says so, because a × that looked like a delete and was not
 * would be the register's old defect again: chrome saying one thing, the facts
 * another.
 *
 * TONE 'note', NEVER RED. The :214-219 rule above applies one level down: a
 * row that is gone because the person hid it is not a failure and must not be
 * painted as one. Nothing in this table uses a failure word. */
export const HIDE_ROW = Object.freeze({
  tone: 'note',
  /* the control's accessible name and its tooltip */
  aria: id => `Hide ${id} from this list`,
  title: 'Hide from this list',
  /* the control on a row that is already hidden and shown on request */
  putBack: id => `Put ${id} back in this list`,
  putBackTitle: 'Put back in this list',
  /* under the row, after the first press */
  armed: id => `Hide ${id}? Press × again. It is hidden on this screen only; nothing else changes.`,
  /* in the toolbar note, after the second press */
  hiddenR: id => `${id} hidden. It is still in your records — only this list stops showing it.`,
  hiddenQ: id => `${id} hidden. It is still in the work list — only this list stops showing it.`,
  restored: id => `${id} is back in this list.`,
  /* The × on a full hide list (500 rows): nothing was hidden, and the way to
     make room is on screen (T1283). */
  full: id => `${id} was not hidden, because 500 rows are hidden already. Press Show hidden and put some back to make room.`,
  /* The hide list could not be written at all. */
  unsaved: id => `${id} was not hidden, because this window could not save its hidden rows. Nothing else changed.`,
  /* A refinement whose rule is not in the list (hidden, declined or narrowed
     away) says which rule it refines, rather than sitting indented under an
     unrelated row (T1522). */
  refines: id => `Refines ${id}, which is not shown in this list.`,
  /* the counter's tail and the toggle beside it */
  count: n => `${n} hidden`,
  show: 'Show hidden',
  hideAgain: 'Hide them again',
  undo: 'Undo',
})

/* ---------------------------------------------------- the live register -- */

/* THE SENTENCE A PRESS ON ANY WRITE CONTROL GETS WHILE THE REGISTER IS THE
   EXAMPLE, instead of a write. Tone 'note', never 'refused': nothing failed --
   there was never anything real to send -- and painting "nothing happened, by
   design" in the failure colour is the register's own old defect one level
   down. Shared by the view's fence, the row controls and the file box, so the
   three cannot drift into three accents. */
export const EXAMPLE_WRITE_NOTE = 'Nothing was sent. These are example records, not yours, so there is nothing real here to act on. Connect your own computers to act on real work.'
/* THE SAME PRESS WHERE THE PERSON TURNED THE EXAMPLE ON (T1415): on the desktop
   with "Show the example fleet" on, this computer is already connected, so the
   way to act on real records is that switch, named where it lives. */
export const EXAMPLE_WRITE_NOTE_CHOSEN = 'Nothing was sent. These are example records, not yours, so there is nothing real here to act on. Turn off “Show the example fleet” in Settings, under What the screens show, to act on your own records.'

/* THE R/T/A/P CHOICE (owner's ruling, 2026-09-07): "ledger should have the
   following subsets: R for rules; T for tasks... Asks for things agents need
   from the owner; and Purchases for actual purchases". These replace the old
   R/Q toggle; a copy with 'q' remembered from before this shipped reads it as
   'a' (see readMode in ledger.js), which is where the Q tab's questions moved
   -- A is Q's successor, not a fifth thing beside it. */
export const KIND_FILTER = Object.freeze({
  label: 'Ledger kind',
  /* THE OWNER'S OWN NAMES, SPELLED OUT (T1363): "R items" was a letter a
     person had to decode, and the list and counter repeated it ("801 t
     items"). The letters stay the ids' first letters (R12, T4, A7, P3). */
  r: 'Rules',
  t: 'Tasks',
  a: 'Asks',
  p: 'Purchases',
  all: 'All',
})

/* A COUNT, IN WORDS, WITH THE RIGHT NUMBER (T1263): "1 rule", "801 tasks",
   never "1 requests" or "801 t items". */
const NOUNS = Object.freeze({
  rule: ['rule', 'rules'],
  task: ['task', 'tasks'],
  ask: ['ask', 'asks'],
  purchase: ['purchase', 'purchases'],
  question: ['question', 'questions'],
  record: ['record', 'records'],
})
export function countOf(count, noun) {
  const forms = NOUNS[noun] || [noun, `${noun}s`]
  return `${count} ${count === 1 ? forms[0] : forms[1]}`
}

/* THE ASKS COUNTER (T1265, T1383): open asks are waiting for the owner, and
   say so; when the asks could not be read, the counter says that rather
   than counting the questions alone as if they were everything. */
export const ASKS_COUNTER = Object.freeze({
  waiting: count => `${count} waiting for you`,
  open: count => `${count} open`,
  unread: 'the asks could not be read',
  tileNote: '· asks could not be read',
})

/* WHICH RULES: the segment beside the kind tabs. The four reaches are the
   ledger's own (the /Request family), in the words the rules panel already
   uses for them, plus "all". */
export const SCOPE_FILTER = Object.freeze({
  /* The segment narrows tasks and asks as well as rules, so its name says
     what it filters by, in the file box's own words. */
  label: 'Who it is for',
  all: 'All',
  global: 'Everywhere',
  tree: 'One tree',
  session: 'One session',
  thread: 'One circle',
})

/* The chip on a row that says who a rule reaches. A row with a label shows the
   label; a keyed row without one shows the reach word and the key's tail. */
export const SCOPE_CHIP = Object.freeze({
  global: 'everywhere',
  tree: 'tree',
  session: 'session',
  thread: 'circle',
})

/* THE PERSON'S HAND ON A ROW. Edit turns the words into a box with Save and
   Cancel; Delete takes two presses; Approve counts a rule an agent filed;
   Decline takes two presses with room for a reason between them. Complete
   (T) and Answer (A) are the owner's 2026-09-07 additions: a task is
   completed rather than approved, and an ask is answered rather than
   decided. Resolve (R's own 2026-09-07 addition) is the owner's way to move
   a standing rule to one of RESOLUTION_STATUSES without deleting it. Every
   one draws a control in this same style, never a second one. */
export const ROW_ACTIONS = Object.freeze({
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  decline: 'Decline',
  complete: 'Complete',
  answer: 'Answer',
  resolve: 'Resolve',
  save: 'Save',
  cancel: 'Cancel',
  editorLabel: id => `The words of ${id}`,
  answerLabel: id => `Your answer to ${id}`,
  resolveLabel: id => `Resolve ${id}`,
  reasonLabel: 'Why, if you want to say',
  groupLabel: id => `What you can do with ${id}`,
})

/* THE SIX RESOLUTION STATUSES (owner's Resolve action, 2026-09-07). The
   engine's own store export, RESOLUTION_STATUSES
   (src/lib/owner-request-store.js, carried onto the app pair as an engine
   follow-on), stays the authority for which six exist and their order; this
   is only their page copy, in the register's own voice, for the picker the
   Resolve control opens. */
export const RESOLVE_STATUSES = Object.freeze([
  Object.freeze({ value: 'in-progress', label: 'In progress' }),
  Object.freeze({ value: 'partial', label: 'Partly done' }),
  Object.freeze({ value: 'blocked-external', label: 'Blocked, needs someone outside' }),
  Object.freeze({ value: 'done', label: 'Done' }),
  Object.freeze({ value: 'not-possible-as-asked', label: 'Not possible as asked' }),
  Object.freeze({ value: 'superseded', label: 'Superseded' }),
])

/* RESOLVE, REFUSED, IN THE SAME SHAPE COMPLETE_ROW AND ANSWER_ROW ALREADY
   ARE: what is off, and what to do about it. The bridge verb is
   resolveStandingRequest (Worker 4, engine lane, own branch, owner-only --
   assertPerson exactly as decide); until a bridge actually has it the
   control that would trigger it is simply never drawn (see
   src/views/ledger.js verbs). `gone` matches DECIDE_ROW's own sentence for
   the same shape of surprise: the row stopped standing between the picker
   opening and the press landing. */
export const RESOLVE_ROW = Object.freeze({
  unavailableWrite: 'This build cannot resolve requests from here yet. Update ToolsEnabled on the computer you are driving, or use its ledger tools.',
  failed: 'That request was not resolved. Try once more.',
  gone: id => `${id} is not standing any more, so nothing was changed.`,
  /* Save pressed on the status the rule already has, with no reason typed. */
  unchanged: (id, label) => `${id} is already ${label}, so nothing was changed. Choose another status, or type why to add a note.`,
  /* The first Save on Done, Not possible as asked or Superseded. */
  finalArmed: (id, label) => `Resolve ${id} as ${label}? Press Save again. This is final: the Ledger has no way to reopen it.`,
})

/* Under a standing row, once its Resolve control is open: what the picker
   does, in PROPOSED_NOTE's own voice -- what the control is for, said once,
   beside it. */
export const RESOLVE_NOTE = Object.freeze({
  tone: 'note',
  text: id => `Resolve ${id} to move it off the open list without deleting it. Choose what happened, and say why if you want to. Done, Not possible as asked and Superseded are final.`,
})

/* T's Complete and A's Answer (owner's 2026-09-07 addition), refused in the
   same shape R's edit and delete already are: what is off, and what to do
   about it. The bridge verbs are completeTask and answerAsk (Worker 4,
   engine lane, own branch); until a bridge actually has them the controls
   that would trigger them are simply never drawn (see src/views/ledger.js
   verbs). */
export const COMPLETE_ROW = Object.freeze({
  unavailableWrite: 'This build cannot mark tasks complete from here yet. Update ToolsEnabled on the computer you are driving, or use its ledger tools.',
  failed: 'That task was not marked complete. Try once more.',
  /* The store completes only an open, in-progress or recurring task. A task
     blocked on the owner draws no Complete; this says why, under the row. */
  blocked: id => `${id} needs something from you before it can go on, so Complete is off. Once that is done, its agent moves it on.`,
  /* Refused because the task changed state under the press: the list is read again. */
  gone: id => `${id} is not open any more, so it was not marked complete. The list now shows where it is.`,
})

export const ANSWER_ROW = Object.freeze({
  unavailableWrite: 'This build cannot answer asks from here yet. Update ToolsEnabled on the computer you are driving, or use its ledger tools.',
  empty: 'Type your answer first. Nothing was sent.',
  failed: 'That answer was not saved. Try once more.',
  /* An agent (or another window) answered or declined the ask first. The
     person's own words stay in the box, so they can still act on them. */
  gone: id => `${id} is not waiting for an answer any more, so yours was not saved. Your words are still in the box.`,
})

/* WHAT THE STORE KEEPS, mirrored so a box can say "too long" before sending
   rather than after (the store measures bytes, not letters): an answer or a
   rule's words up to 16 KB, a reason up to 2 KB. */
export const LEDGER_LIMITS = Object.freeze({ wordsBytes: 16 * 1024, reasonBytes: 2048 })

/* REFUSALS NO RETRY CAN FIX, SAID AS WHAT THEY ARE. A write the store refused
   because the Ledger history needs the person's review, because that history
   is damaged, or because the text is longer than the store keeps used to fall
   through to "Try once more", which can never work (T1296, T1418). */
export const LEDGER_REFUSAL = Object.freeze({
  historyUnconfirmed: 'Nothing was saved, because the Ledger history needs your review first. Press Review unconfirmed history on this page, then save again.',
  historyDamaged: 'Nothing was saved, because the saved Ledger history is damaged at its end. Everything already on file is kept. Restore the history from a backup, then save again.',
  wordsTooLong: 'That is longer than the Ledger keeps: 16,384 bytes, about 16,000 letters or 5,000 Chinese characters. Nothing was saved. Shorten it and save again.',
  reasonTooLong: 'That reason is longer than the Ledger keeps: 2,048 bytes, about 2,000 letters or 680 Chinese characters. Nothing was saved. Shorten it and save again.',
})

/* The sentence for a refusal code every Ledger write can meet, whichever
   family it came back in (the rule verbs re-prefix R_LEDGER_ as
   AGENT_REQUEST_; the task and ask verbs pass it through), or null. */
export function ledgerRefusalSentence(code) {
  const tail = typeof code === 'string' ? code.replace(/^(?:AGENT_REQUEST_|R_LEDGER_)/, '') : ''
  if (tail === 'CHAIN_APPEND_UNCONFIRMED') return LEDGER_REFUSAL.historyUnconfirmed
  if (tail === 'CHAIN_BROKEN') return LEDGER_REFUSAL.historyDamaged
  if (code === 'R_LEDGER_WORDS_TOO_LONG') return LEDGER_REFUSAL.wordsTooLong
  if (tail === 'REASON_INVALID' || tail === 'REASON_TOO_LONG') return LEDGER_REFUSAL.reasonTooLong
  return null
}

/* Bytes, the way the store counts them. */
export const utf8Bytes = text => new TextEncoder().encode(String(text ?? '')).length

/* DELETE, AND WHAT IT REALLY DOES. The ledger never shortens: a deleted request
   is kept as deleted, and every agent stops reading it at its next start. The
   armed sentence says exactly that, because a Delete that hid more than it
   said would be the × control's old lie the other way round. Tone 'note': a
   row the person is about to delete is not a failure. */
/* A LIST OF IDS, SPOKEN: "R202", "R202 and R202.1", "R202, R202.1 and R202.2". */
const spokenIds = ids => (ids.length < 2 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`)

export const DELETE_ROW = Object.freeze({
  tone: 'note',
  /* RULES ARE READ TO AGENTS AT EVERY START; TASKS AND ASKS ARE NOT, so only
     a rule's sentence promises that agents stop reading it. A rule's live
     refinements go with it (the store removes them together), so they are
     named before the second press rather than discovered after it. */
  armed: (id, refinements = []) => {
    if (/^[TA]/.test(id)) return `Delete ${id}? Press Delete again. It stays in your records as deleted and leaves this list.`
    if (!Array.isArray(refinements) || refinements.length === 0) return `Delete ${id}? Press Delete again. It stays in your records as deleted, and agents stop reading it at their next start.`
    const count = refinements.length === 1 ? 'its refinement' : `its ${refinements.length} refinements`
    return `Delete ${id} and ${count}, ${spokenIds(refinements)}? Press Delete again. They stay in your records as deleted, and agents stop reading them at their next start.`
  },
  failed: 'That request was not deleted. Try once more.',
  failedFor: id => `${/^T/.test(id) ? 'That task' : /^A/.test(id) ? 'That ask' : 'That request'} was not deleted. Try once more.`,
  /* After the second press: what went, and where to find it again. */
  deleted: ids => (ids.length === 1
    ? `${ids[0]} deleted. It is kept in your records as deleted; Show removed lists it.`
    : `${spokenIds(ids)} deleted. They are kept in your records as deleted; Show removed lists them.`),
})

/* APPROVE AND DECLINE ON A ROW AN AGENT FILED. Approve is one press. Decline
   arms first and opens a box for the reason, kept with the decision. */
export const DECIDE_ROW = Object.freeze({
  tone: 'note',
  declineArmed: id => `Decline ${id}? Press Decline again. Say why first if you want to; it is kept with your decision.`,
  declined: id => `${id} declined. It is kept in your records as declined; Show removed lists it.`,
  failed: 'That decision was not recorded. Try once more.',
  gone: id => `${id} is not waiting for a decision any more, so nothing was changed.`,
})

/* Under a row an agent filed from the person's words and nobody has approved
   yet: who filed it, and what the two buttons beside it do. */
export const PROPOSED_NOTE = Object.freeze({
  tone: 'note',
  text: who => `Your agent ${who} filed this from your words. Approve it to make it count, or decline it.`,
})

/* T's own terminal state, same standing as done and removed: a superseded
   task is replaced by a newer one, not acted on again -- the store refuses
   complete and remove on it by its own typed code, so this row draws no
   buttons at all (see kindActionsMarkup's early return). The sentence names
   which task replaced it, the way a row already cites another row's id. */
export const SUPERSEDED_NOTE = Object.freeze({
  tone: 'note',
  text: id => `Superseded by ${id}.`,
})

/* THE OPEN PAGE FOLLOWS THE LEDGER (src/views/ledger.js refreshQuietly). While
   a person is typing in a box the list is not redrawn under them; this says a
   change is waiting and offers it. A quiet read that fails keeps the last
   records on screen and says so, with no failure painted over them. */
export const LEDGER_UPDATES = Object.freeze({
  waiting: 'The Ledger has changed since this list was drawn. Your typing is kept either way.',
  show: 'Show the changes',
  unreadable: 'The latest Ledger changes could not be read, so this list shows the last records that were read. It tries again in a few seconds.',
})

/* WHAT A ROW HAS ON FILE BEYOND ITS WORDS (T1276, T1277, T1281, T1353, T1490,
   T1492): when it was filed, what the owner answered, how often a repeating
   task has been completed, what a task is waiting on, and why a rule was
   resolved or declined -- and whether the owner or an agent did it. The store
   keeps all of it; these are the words the row says it in. `who` is the
   actor on file: 'owner' is the person, anything else is an agent's name. */
const byWhom = who => (!who || who === 'owner' ? 'you' : `your agent ${who}`)
export const ROW_DETAIL = Object.freeze({
  filed: 'filed',
  runs: count => (count === 0 ? 'Not completed yet.' : `Completed ${count === 1 ? 'once' : `${count} times`}, last`),
  completed: who => `Completed by ${byWhom(who)}`,
  answered: who => `Answered by ${byWhom(who)}`,
  declinedAsk: who => `Declined by ${byWhom(who)}`,
  waitingOn: 'Waiting on',
  progress: 'Latest progress',
  resolved: (label, who) => `Resolved as ${label} by ${byWhom(who)}`,
  declinedRule: who => `Declined by ${byWhom(who)}`,
  approvedRule: who => `Approved by ${byWhom(who)}`,
  /* Purchases (T1280): what was bought, who decided, what was charged. */
  purchaseLine: 'Item',
  approvedPurchase: who => `Approved by ${byWhom(who)}`,
  declinedPurchase: who => `Declined by ${byWhom(who)}`,
  charged: 'Charge recorded',
  /* A record the person adopted with its history unconfirmed (T1548). */
  adopted: 'History not verified: adopted as it stood',
})

/* THE LIST HOME'S LEDGER LINE OPENS (T1344): the records Home counts as
   waiting on the owner, across every kind, with the way back to the whole
   Ledger beside the sentence. */
export const WAITING_FILTER = Object.freeze({
  blocked: 'Showing the records blocked on you, the ones Home counts, across every kind.',
  attention: 'Showing the records waiting for your review, the ones Home counts, across every kind.',
  clear: 'Show the whole Ledger',
})

/* FINDING ONE RECORD IN A LARGE LEDGER (T1459): a box that narrows the tab to
   rows whose id starts with, or whose words contain, what was typed. */
export const FIND_BOX = Object.freeze({
  label: 'Find in this list',
  placeholder: 'Find an id or words',
  tail: query => `matching “${query}”`,
  none: query => `No record in this list matches “${query}”. Try other words, another tab, or clear the box.`,
})

/* The toggle beside the counter, and the counter's tail while it is on. */
export const REMOVED_TOGGLE = Object.freeze({
  show: 'Show removed',
  hide: 'Hide removed',
  count: n => `${n} removed`,
})

/* THE HISTORY CHECK. Every write to the ledger appends one line to a chained
   history file; the read verifies the chain and compares each record with its
   last line. A break means the history file was edited in place; drift means
   a record changed without a line. Either is worth a sentence above the list
   -- the rows are still drawn, because hiding them would hide the evidence. */
export const CHAIN_NOTE = Object.freeze({
  broken: 'The history behind this list could not be verified. Check it before you act on it.',
  drift: ids => `${ids.join(', ')} ${ids.length === 1 ? 'does' : 'do'} not match the available history. Check these records before you act on them.`,
  missing: ids => `${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} missing from the ledger although their history remains. Restore these records before relying on the list.`,
})

/* THE BOX THAT FILES A REQUEST FROM THIS PAGE. Same filing seam as /Request in
   a chat; the picker's tree, circle and session choices come from the fleet
   trees this window already keeps. Every refusal names what to do next. */
export const FILE_BOX = Object.freeze({
  title: 'File a request',
  scopeLabel: 'Who it is for',
  keyLabel: 'Which one',
  wordsLabel: 'Your words',
  wordsHint: 'Your words are saved with outer whitespace trimmed. Every agent it reaches is told at its next start.',
  submit: 'File it',
  pending: 'Filing it…',
  runningNow: 'running now',
  reach: Object.freeze({
    global: 'Every agent on this computer, until you edit or delete it.',
    session: 'One running session and every agent it starts.',
    tree: 'One agent and every agent working under it.',
    thread: 'One conversation only, every time it runs.',
  }),
  nothingToPick: Object.freeze({
    tree: 'No agents are set up on this computer yet, so there is no tree to file it under. Add one on the Computers page first.',
    thread: 'No agents are set up on this computer yet, so there is no circle to file it under. Add one on the Computers page first.',
    session: 'No session is running right now, so a session rule has nowhere to apply. Start an agent first, or file it for a tree.',
  }),
  empty: 'Type the request first. Nothing was filed.',
  noTarget: 'Pick which one it is for first. Nothing was filed.',
  failed: 'That request was not filed. Try once more.',
  wrongKind: 'The Ledger returned a different record type. Check the list before filing again.',
  refreshFailed: 'The record was filed, but the list could not refresh. Reopen the page to read it.',
})

export const TASK_FILE_BOX = Object.freeze({
  ...FILE_BOX,
  title: 'File a task',
  wordsHint: 'Saved as a task to complete, with outer whitespace trimmed.',
  empty: 'Type the task first. Nothing was filed.',
  failed: 'That task was not filed. Try once more.',
  reach: Object.freeze({
    global: 'A task for this computer.',
    session: 'A task for one running session and the agents it starts.',
    tree: 'A task for one agent and every agent working under it.',
    thread: 'A task for one conversation.',
  }),
})
