/* WHAT FIRST-RUN SETUP IS ALLOWED TO SAY ABOUT WHAT IT HAS DONE.
 *
 * Two claims on that walkthrough were measured false against the code running
 * underneath them (hand test, 2026-09-24, on a sterile profile):
 *
 *   1. THE FOLDER STEP PROMISED A FOLDER IT DOES NOT MAKE. Its hint read "It is
 *      created for you when you accept", and the very next paint of the SAME
 *      <small> read "Nothing is created or changed until you finish setup."
 *      Both cannot be true, and the second is the true one. Accepting calls
 *      confirmWizardFolder, which runs mcSetup.checkWorkspace -- the identical
 *      validation with no provisioning and no write, chosen precisely so that
 *      accepting a suggestion is not a terminal act. Only finish() reaches
 *      mcSetup.recordWorkspaces, and that is what makes the folder on disk and
 *      runs the version-control step (engine/src/lib/setup/workspace.js).
 *
 *   2. A SKIPPED SETUP CAME BACK CLAIMING TO BE AN ANSWERED ONE. Reopening
 *      after "Skip the rest for now" drew ticks on Access, Folder, Account and
 *      Actions above "Your settings are saved", for somebody who answered
 *      nothing. The ticks are positional, and finish() has said so in its own
 *      note for some time: "the Folder step draws a tick for having been walked
 *      past, not for having recorded anything". skip() stores step 'review', so
 *      every earlier step sits behind the cursor and every one of them ticks.
 *      The sentence above them was worse. It fired on hasSavedSetupNotice(),
 *      which is true whenever the account-switching answer was deferred -- and
 *      that deferral happens on EVERY fresh installation, because there is no
 *      account list yet for it to be written to. "Your settings are saved" was
 *      being printed BECAUSE something could not be saved.
 *
 * WHY THE WORDS AND THE COMPLETION RULE LIVE HERE. Same reason
 * src/agent-confinement-copy.js gives for its own sentences: src/views/setup.js
 * imports three stylesheets and touches the DOM, so no plain `node --test`
 * process can drive it, and a suite over it is reduced to matching source
 * TEXT -- which passes just as well when the sentence is right and the branch
 * that picks it is wrong. Both defects above are branch defects, not spelling
 * defects. This module is DOM-free and bridge-free, so the suite can ask it
 * what a person would actually read.
 */

/* THE FOLDER STEP'S TWO STATES, WRITTEN AS ONE PAIR. They were two independent
   template branches, which is how one came to promise a folder the other
   promised not to make. Defined together, the claim about WHEN anything is
   created is one sentence used twice and cannot drift again.

   "where it can" is not a hedge for its own sake: version control needs Git on
   this computer, and where it is missing the folder is still made and setup
   says so on the last screen ("Undo will not be available in them"). */
const FOLDER_AT_FINISH = 'Finish setup is what makes the folder, if it is missing. It also puts the folder under version control where it can, so an assistant’s changes there can be undone. Nothing on this computer is created or changed before you press it.'

export const SETUP_FOLDER_HINT = Object.freeze({
  suggestion: `This is a suggestion. Press “Use this folder” to accept it, or choose a different one. ${FOLDER_AT_FINISH}`,
  held: `This folder is the answer you gave. ${FOLDER_AT_FINISH}`,
})

/* THE THREE THINGS THE REVIEW MAY SAY IT HAS DONE, chosen by the stored
   profile's status and by nothing else.
 *
 * Status is the only fact that records what the PERSON did: 'complete' means
 * they answered the questions and pressed Finish, 'skipped' means they pressed
 * one button on screen one, and anything else means the walk is still open.
 * The old branch read a carried notice instead, and a notice is a fact about
 * the MACHINE -- which is how a deferral that exists on every fresh install
 * came to be reported as a saved setup. */
const REVIEW_LEDE = Object.freeze({
  complete: 'Your settings are saved. Review the items below before you continue.',
  /* Says what is true of a skip and no more: the Basic answers really are live
     -- skip() applies them rather than leaving storage empty -- and they are
     this program's answers, not the person's. */
  skipped: 'Setup was skipped, so the Basic answers are in use. Nothing below was answered by you. Change anything you like here, then press Finish setup.',
  open: 'Your permission level is saved. Finish setup to save the rest. You can change these choices later in Settings.',
})

export function setupReviewLede(stored) {
  const status = stored?.status
  if (status === 'complete') return REVIEW_LEDE.complete
  if (status === 'skipped') return REVIEW_LEDE.skipped
  return REVIEW_LEDE.open
}

/**
 * Which setup steps has the person actually ANSWERED?
 *
 * Not the same question as "which steps has the cursor moved past", which is
 * what the progress ticks asked. Two states answer those two questions
 * differently, and both of them are ordinary:
 *
 *   A SKIPPED WALK answers exactly one question -- the permission level, which
 *   the skip button records on the way out because the first-run gate is built
 *   on it. Everything after that is this program's default, applied on the
 *   person's behalf. A tick there claims a decision as theirs.
 *
 *   A WALK PAST THE FOLDER STEP is not a choice of folder. The suggested path
 *   is a suggestion until "Use this folder" or the chooser records one, and
 *   finish() reports "No folder was chosen" for exactly this state -- under
 *   four ticks, on the same screen, until now.
 *
 * Total by construction: every id in `steps` gets an answer, so a step added to
 * the walk cannot quietly fall through to a tick.
 */
export function answeredSetupSteps(stored, { steps, current, tierRecorded = false } = {}) {
  const order = Array.isArray(steps) ? steps : []
  const cursor = order.indexOf(current)
  const skipped = stored?.status === 'skipped'
  const roots = stored?.answers?.workspaceRoots
  const folderChosen = Array.isArray(roots) && roots.length > 0
  const answered = Object.create(null)
  for (const [position, id] of order.entries()) {
    /* The level is the one thing recorded before the end, by Continue and by
       Skip alike, so the machine record answers this and not the cursor. */
    if (id === 'tier') { answered[id] = Boolean(tierRecorded); continue }
    if (skipped) { answered[id] = false; continue }
    const walkedPast = cursor !== -1 && position < cursor
    if (id === 'workspace') { answered[id] = walkedPast && folderChosen; continue }
    answered[id] = walkedPast
  }
  return Object.freeze(answered)
}

/* WHAT THE REVIEW MAY SAY ABOUT THE SWITCHES, WHICH IS NOT "IT TURNED THEM ON".
 *
 * MEASURED on a sterile 1.0.46 profile, 2026-09-24, standing on the review
 * screen with "Act when I start it" chosen. The disclosure read:
 *
 *     Review all settings            4 controls enabled
 *     Switches this turned on
 *     Hand out work to agents
 *     This is a control this program will now offer you.
 *
 * and at that instant `Object.keys(localStorage).filter(k =>
 * k.startsWith('mc.write.'))` was []. Not one switch existed, let alone four.
 * Pressing Finish is what wrote all seven keys (dispatch, report-read,
 * agent-session and cloud-launch enabled; decision, queue and thread-reply
 * disabled) -- because applyProfile, the only caller of setWriteEnabled, is
 * reached from finish() and skip() and from nowhere else in the walkthrough.
 * src/setup-intent-commit.js opens with the same rule in its own words:
 * "In-progress walkthrough records are drafts. Only Finish or Settings Save
 * writes the runtime policies."
 *
 * IT IS THE FOLDER DEFECT AGAIN, ONE SCREEN LATER. Two steps back the same walk
 * promises "Nothing on this computer is created or changed before you press
 * it", and then this screen says four controls are enabled and that this turned
 * them on. Both cannot be true, and -- exactly as with the folder -- the
 * promise is the true one.
 *
 * SO THE REVIEW SPEAKS ABOUT THE ANSWER AND NOT ABOUT THE MACHINE. The answer
 * is a fact that holds while the person is standing there; what has been
 * written to this computer is not. Answer-tense is also the one wording that
 * stays true on a review screen reopened after a COMPLETE setup, where the
 * switches really are on -- so there is no second sentence for that state to
 * drift away from. */
export const REVIEW_SWITCHES = Object.freeze({
  heading: 'Switches this answer turns on',
  /* The summary's count. "enabled" is a claim about this computer; "this turns
     on" is a claim about the answer, which is all the review knows. */
  count: (n) => `${n} control${n === 1 ? '' : 's'} this turns on`,
  /* Was "will now offer you". "now" is the word that made it false: nothing is
     offered now, because nothing has been written now. */
  row: 'This is a control this answer asks for. The same switch is in Settings → Things it may do for you.',
  none: 'This answer turns nothing on that acts. Every screen still reads and reports; turn on what you want when you want it, here or in Settings → Things it may do for you.',
})

/**
 * WHICH WORKING FOLDERS DID THE PERSON ACTUALLY ANSWER WITH?
 *
 * Not the same question as "which folders would Finish record", and the two
 * were answered by one function. src/views/setup.js keeps workspaceRoots(),
 * which falls back to the suggested default on purpose -- finish() needs
 * something to record for somebody who accepted the suggestion by walking past
 * it, and recording nothing is the dead end that ships "No working folder has
 * been confirmed" at the first agent start.
 *
 * That same fallback was being handed to answeredSetupSteps(), so the Folder
 * tick asked "is there a folder" and never "did they choose one". MEASURED on a
 * sterile 1.0.46 profile, 2026-09-24: walked past the Folder step without
 * pressing "Use this folder", the stored profile read `"workspaceRoots":[]`,
 * and the progress rail still drew `✓ Folder`. The suite that was supposed to
 * stop this passes -- it hands answeredSetupSteps the empty array directly --
 * so the branch shipped unreachable and the tick stayed positional in
 * everything but name.
 *
 * TWO WAYS TO HAVE ANSWERED IT, AND THE SUGGESTION IS NEITHER:
 *   this walk      `answers.workspaceRoots`, written by confirmWizardFolder()
 *                  and the chooser, and by nothing else.
 *   an earlier one `workspace.chosen`, which shell/setup-record.cjs sets "true
 *                  only once the person has been shown the question and
 *                  answered it" and deliberately withholds from "a record whose
 *                  roots are exactly the suggested default and which was never
 *                  asked ... so the walkthrough can tell 'they picked this'
 *                  from 'nobody ever asked'".
 *
 * `chosen` is read strictly: an older copy that does not send the field at all
 * leaves the tick off, which understates rather than claims.
 */
export function answeredWorkspaceRoots({ answers = null, workspace = null } = {}) {
  const chosenHere = answers?.workspaceRoots
  if (Array.isArray(chosenHere) && chosenHere.length > 0) return chosenHere
  const recorded = workspace?.roots
  if (workspace?.chosen === true && Array.isArray(recorded) && recorded.length > 0) return recorded
  return []
}
