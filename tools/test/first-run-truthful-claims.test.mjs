/* DOES THE PRODUCT ONLY CLAIM, ON FIRST RUN, WHAT IT HAS ACTUALLY DONE?
 *
 * tools/test/setup-truthful-claims.test.mjs holds the two claims measured false
 * earlier on 2026-09-24 (the folder "created for you when you accept", and a
 * skipped walk reopening as "Your settings are saved"). This file holds three
 * more of the same shape, all measured on a sterile 1.0.46 profile the same
 * day, on the packaged Linux build:
 *
 *   1. THE REVIEW SCREEN SAID THE SWITCHES WERE ALREADY ON. "Switches this
 *      turned on" over "4 controls enabled", every row reading "This is a
 *      control this program will now offer you" -- while localStorage held no
 *      `mc.write.*` key at all. Finish is what wrote all seven.
 *
 *   2. THE FOLDER TICK COUNTED THE SUGGESTION AS AN ANSWER. Walked past the
 *      Folder step without pressing "Use this folder"; stored profile read
 *      `"workspaceRoots":[]`; the rail drew `✓ Folder` anyway, because the view
 *      handed answeredSetupSteps the fallback-to-suggestion roots.
 *
 *   3. THE EMPTY APPROVAL QUEUE PROMISED AN IDLE PRODUCT. "Nothing acts on your
 *      behalf while this is empty", under "· nothing is approved unless you
 *      approve it" -- on a build whose RECOMMENDED answer maps to
 *      `agent.blocked_question = 'Decide for itself'`, where an assistant
 *      answers its own permission questions and files nothing.
 *
 * EVERY ASSERTION IS OVER THE READING A PERSON GETS, never over view source.
 * src/views/setup.js and src/ledger-prompt-queue.js both import stylesheets and
 * touch the DOM, so a plain `node --test` process cannot drive them, and a
 * suite reduced to matching their source passes just as well when the sentence
 * is right and the branch picking it is wrong -- which is exactly what defect 2
 * was. The decisions and the words live in DOM-free modules and are asked here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REVIEW_SWITCHES, answeredSetupSteps, answeredWorkspaceRoots } from '../../src/setup-copy.js'
import { APPROVAL_QUEUE_EMPTY } from '../../src/ledger-copy.js'

const STEPS = Object.freeze(['tier', 'workspace', 'account', 'autonomy', 'review'])

/* ---------- 1. the review screen's switch section ---------- */

/* THE MEASUREMENT. Standing on the review screen, mid-walk, the stored profile
   is `in-progress` and not one `mc.write.*` key exists; applyProfile -- the
   only caller of setWriteEnabled -- is reached from finish() and skip() alone.
   So no sentence here may report a switch as already thrown. */
test('the review never reports a switch this computer has not been given yet', () => {
  const readings = [
    REVIEW_SWITCHES.heading,
    REVIEW_SWITCHES.row,
    REVIEW_SWITCHES.none,
    REVIEW_SWITCHES.count(0),
    REVIEW_SWITCHES.count(1),
    REVIEW_SWITCHES.count(4),
  ]
  for (const reading of readings) {
    assert.doesNotMatch(reading, /\bcontrols? enabled\b/i,
      `the review reports controls as enabled before Finish writes one: ${reading}`)
    assert.doesNotMatch(reading, /\bthis turned on\b/i,
      `the review claims it has already turned something on: ${reading}`)
    assert.doesNotMatch(reading, /\bwill now offer\b/i,
      `"now" claims an offer that does not exist until Finish: ${reading}`)
  }
})

/* The count is the other half of the same claim and has to survive being a
   count: it may say how many the ANSWER asks for, never how many are on. */
test('the count speaks about the answer and agrees with itself on one', () => {
  assert.match(REVIEW_SWITCHES.count(4), /^4 controls\b/, REVIEW_SWITCHES.count(4))
  assert.match(REVIEW_SWITCHES.count(1), /^1 control\b/, REVIEW_SWITCHES.count(1))
  assert.doesNotMatch(REVIEW_SWITCHES.count(1), /1 controls/, 'the singular count reads wrong')
  for (const n of [0, 1, 4, 7]) {
    assert.match(REVIEW_SWITCHES.count(n), /this turns on$/,
      `the count does not attribute itself to the answer: ${REVIEW_SWITCHES.count(n)}`)
  }
})

/* THE CONTRADICTION WAS WITH A SCREEN TWO STEPS BACK, so the repair is checked
   against it. The folder hint's promise is the true one and it is absolute. */
test('the switch section does not contradict the folder step it follows', async () => {
  const { SETUP_FOLDER_HINT } = await import('../../src/setup-copy.js')
  assert.match(SETUP_FOLDER_HINT.suggestion, /Nothing on this computer is created or changed before you press it/,
    'the folder promise this section must not contradict has moved or changed')
  for (const reading of [REVIEW_SWITCHES.heading, REVIEW_SWITCHES.row, REVIEW_SWITCHES.none]) {
    assert.doesNotMatch(reading, /\b(is|are) (now )?(enabled|switched on|turned on)\b/i,
      `this asserts a change the folder step promises has not happened: ${reading}`)
  }
})

/* ---------- 2. the folder tick ---------- */

/* THE EXACT SHIPPED STATE. answers.workspaceRoots is [] -- nobody pressed "Use
   this folder" -- and the machine has no recorded roots, only a suggestion.
   This is the ordinary fresh install, and it is the one the rail ticked. */
test('a suggestion nobody pressed is not an answer to the folder question', () => {
  const walkedPast = {
    answers: { workspaceRoots: [] },
    workspace: { suggested: '/srv/documents/ai-workspace', roots: [], chosen: false },
  }
  assert.deepEqual(answeredWorkspaceRoots(walkedPast), [],
    'the suggested folder is being reported as the person’s answer')

  const answered = answeredSetupSteps(
    { status: 'in-progress', answers: { workspaceRoots: answeredWorkspaceRoots(walkedPast) } },
    { steps: STEPS, current: 'review', tierRecorded: true },
  )
  assert.equal(answered.workspace, false,
    'the Folder step is ticked for somebody who walked past the suggestion')
})

/* THE TICK MUST STILL APPEAR FOR EVERY WAY OF REALLY ANSWERING, or the repair
   has only moved the lie to the other side. confirmWizardFolder() and the
   chooser both write answers.workspaceRoots; an earlier completed setup is
   carried by shell/setup-record.cjs's `chosen` stamp. */
test('a folder the person did choose keeps its tick, this walk or an earlier one', () => {
  const pressedUseThisFolder = {
    answers: { workspaceRoots: ['/srv/documents/ai-workspace'] },
    workspace: { suggested: '/srv/documents/ai-workspace', roots: [], chosen: false },
  }
  assert.deepEqual(answeredWorkspaceRoots(pressedUseThisFolder), ['/srv/documents/ai-workspace'])

  const answeredInAnEarlierSetup = {
    answers: { workspaceRoots: [] },
    workspace: { suggested: '/srv/documents/ai-workspace', roots: ['/srv/projects'], chosen: true },
  }
  assert.deepEqual(answeredWorkspaceRoots(answeredInAnEarlierSetup), ['/srv/projects'])

  for (const state of [pressedUseThisFolder, answeredInAnEarlierSetup]) {
    const answered = answeredSetupSteps(
      { status: 'in-progress', answers: { workspaceRoots: answeredWorkspaceRoots(state) } },
      { steps: STEPS, current: 'review', tierRecorded: true },
    )
    assert.equal(answered.workspace, true, 'a folder the person really chose lost its tick')
  }
})

/* `chosen` is read strictly rather than inferred from roots, because roots
   alone cannot tell a chosen folder from the suggested default an older record
   carries. An answer that cannot be got stays unanswered. */
test('recorded roots without the chosen stamp are not treated as an answer', () => {
  assert.deepEqual(
    answeredWorkspaceRoots({ answers: { workspaceRoots: [] }, workspace: { roots: ['/srv/projects'] } }),
    [], 'roots with no chosen stamp were counted as a decision')
  assert.deepEqual(answeredWorkspaceRoots({}), [], 'an unread workspace answered with a folder')
  assert.deepEqual(answeredWorkspaceRoots(), [], 'no arguments at all answered with a folder')
})

/* ---------- 3. the empty approval queue ---------- */

/* WHY THE OLD SENTENCE WAS FALSE, in one line: "Act on its own" is Recommended,
   it maps to `agent.blocked_question = 'Decide for itself'`, and the engine's
   own tool-registry text says the agent's considered decision is "Used only
   when the person chose Decide for itself". The queue is then empty BECAUSE
   something is deciding in the owner's place. */
test('an empty queue is never sold as proof that nothing is acting', () => {
  const readings = [APPROVAL_QUEUE_EMPTY.title, APPROVAL_QUEUE_EMPTY.body, APPROVAL_QUEUE_EMPTY.waitingNote]
  for (const reading of readings) {
    assert.doesNotMatch(reading, /Nothing acts on your behalf/i,
      `the empty queue still promises an idle product: ${reading}`)
    assert.doesNotMatch(reading, /^·? ?nothing is approved unless you approve it$/i,
      `the tile still claims every approval is the person's: ${reading}`)
  }
})

/* THE ONE GUARANTEE THAT HOLDS ON EVERY ANSWER is the carve-out the engine
   names itself -- "Purchases reserved for the person still require their
   decision" -- so that is what the words may claim, and it must actually be
   claimed rather than merely not contradicted. */
test('the empty queue claims the purchase guarantee and nothing wider', () => {
  assert.match(APPROVAL_QUEUE_EMPTY.waitingNote, /purchase/i,
    'the tile no longer names the guarantee it is entitled to make')
  assert.match(APPROVAL_QUEUE_EMPTY.body, /purchase always waits for you/i,
    'the empty panel does not state the one thing that is always true')
  assert.match(APPROVAL_QUEUE_EMPTY.body, /decide for themselves|set to ask/i,
    'the empty panel does not say that an assistant may be deciding instead')
})
