/* DOES FIRST-RUN SETUP ONLY CLAIM WHAT IT ACTUALLY DID?
 *
 * Two claims were measured false by hand on 2026-09-24, on a sterile profile,
 * and both are branch defects rather than spelling defects:
 *
 *   the folder step said "It is created for you when you accept", and the same
 *   <small> said "Nothing is created or changed until you finish setup" one
 *   press later. Accepting runs mcSetup.checkWorkspace, which validates and
 *   provisions nothing; only Finish reaches recordWorkspaces.
 *
 *   reopening after "Skip the rest for now" drew ticks on Access, Folder,
 *   Account and Actions above "Your settings are saved", for somebody who had
 *   answered nothing. The ticks are positional and skip() stores step 'review';
 *   the sentence fired on a carried notice that is present on EVERY fresh
 *   install, because the account-switching answer cannot be written before an
 *   account list exists.
 *
 * SO THE ASSERTIONS ARE OVER THE READING A PERSON GETS, not over source text.
 * src/views/setup.js cannot be driven by a plain `node --test` process -- it
 * imports three stylesheets and touches the DOM -- and a suite reduced to
 * matching its source passes just as well when the sentence is right and the
 * branch picking it is wrong, which is exactly the shape of both defects. The
 * decision and the words are in src/setup-copy.js, which is DOM-free, so the
 * questions below are asked of it directly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SETUP_FOLDER_HINT, answeredSetupSteps, setupReviewLede } from '../../src/setup-copy.js'

/* The walk's real step list and order, as src/views/setup.js declares them. */
const STEPS = Object.freeze(['tier', 'workspace', 'account', 'autonomy', 'review'])

/* What skip() writes: the Basic answers, no folder, and the account-switching
   deferral every fresh installation produces. */
const SKIPPED = Object.freeze({
  status: 'skipped',
  step: 'review',
  answers: { autonomy: 'autonomous', screens: 'live', workspaceRoots: [] },
  accountPolicyDeferred: { reason: 'There are no provider accounts to switch between yet.' },
})

/* ---------- 1. the folder step ---------- */

test('accepting the suggested folder is never described as creating it', () => {
  for (const [state, hint] of Object.entries(SETUP_FOLDER_HINT)) {
    assert.doesNotMatch(hint, /created for you when you accept/i,
      `the ${state} hint promises a folder that accepting does not make`)
    assert.doesNotMatch(hint, /\bcreated\b[^.]*\baccept/i,
      `the ${state} hint ties creation to accepting: ${hint}`)
  }
})

/* THE CONTRADICTION WAS STRUCTURAL, so the repair is too. The two states were
   independent template branches, which is how one came to promise a folder the
   other promised not to make. One shared sentence about WHEN anything is
   created is what stops it happening again; two sentences that merely agree
   today would not. */
test('both folder states make one and the same promise about when anything is created', () => {
  const sentenceAbout = hint => hint.split(/(?<=\.)\s+/).filter(part => /created|makes the folder/i.test(part))
  const suggestion = sentenceAbout(SETUP_FOLDER_HINT.suggestion)
  const held = sentenceAbout(SETUP_FOLDER_HINT.held)
  assert.ok(suggestion.length > 0, 'the suggestion hint says nothing about when the folder is made')
  assert.deepEqual(held, suggestion,
    'the two folder states describe creation differently, which is the contradiction that was reported')
  for (const hint of [SETUP_FOLDER_HINT.suggestion, SETUP_FOLDER_HINT.held]) {
    assert.match(hint, /Finish setup/, `the hint does not name the press that makes the folder: ${hint}`)
  }
})

/* ---------- 2. what the review says was done ---------- */

/* THE EXACT CAUSE. The lede used to read `hasSavedSetupNotice()`, which is true
   whenever the account-switching answer was deferred -- and that deferral is
   the ordinary outcome on a fresh installation, skip or no skip. So the screen
   announced saved settings BECAUSE something could not be saved. */
test('a deferred account-switching answer does not become a claim that the settings are saved', () => {
  const lede = setupReviewLede(SKIPPED)
  assert.doesNotMatch(lede, /settings are saved/i,
    'skipping setup still reports saved settings: ' + lede)
  assert.match(lede, /skipped/i, 'the review does not say the questions were skipped: ' + lede)

  /* The same deferral carried by a walk that really was answered must not lose
     the true sentence. The fix is which fact is read, not the removal of one. */
  const finished = setupReviewLede({ ...SKIPPED, status: 'complete' })
  assert.match(finished, /Your settings are saved/,
    'a completed setup no longer says its settings are saved: ' + finished)
})

test('a walk still open says the level is saved and the rest is not', () => {
  for (const stored of [null, undefined, { status: 'in-progress', step: 'autonomy', answers: {} }]) {
    const lede = setupReviewLede(stored)
    assert.match(lede, /permission level is saved/, `an open walk reads wrong: ${lede}`)
    assert.match(lede, /Finish setup to save the rest/, `an open walk reads wrong: ${lede}`)
  }
})

/* ---------- 3. the progress ticks ---------- */

test('reopening after a skip ticks the level and nothing else', () => {
  const answered = answeredSetupSteps(SKIPPED, { steps: STEPS, current: 'review', tierRecorded: true })
  assert.equal(answered.tier, true, 'the level really is recorded by the skip button, so it keeps its tick')
  for (const id of ['workspace', 'account', 'autonomy', 'review']) {
    assert.equal(answered[id], false, `${id} is ticked for somebody who never answered it`)
  }
})

/* finish()'s own note: "the Folder step draws a tick for having been walked
   past, not for having recorded anything". A person who walked past the
   suggestion without pressing "Use this folder" reaches a review row reading
   "No folder was chosen" under a ticked Folder step. */
test('walking past the folder question is not choosing a folder', () => {
  const walking = { status: 'in-progress', step: 'review', answers: { workspaceRoots: [] } }
  const answered = answeredSetupSteps(walking, { steps: STEPS, current: 'review', tierRecorded: true })
  assert.equal(answered.workspace, false, 'the folder step is ticked although no folder was chosen')
  assert.equal(answered.account, true, 'an optional step actually walked through lost its tick')
  assert.equal(answered.autonomy, true, 'a question actually answered lost its tick')

  const chosen = { ...walking, answers: { workspaceRoots: ['/srv/projects/example'] } }
  assert.equal(
    answeredSetupSteps(chosen, { steps: STEPS, current: 'review', tierRecorded: true }).workspace,
    true,
    'a folder the person did choose is not ticked',
  )
})

test('a step ahead of the person is never reported as answered', () => {
  const answered = answeredSetupSteps({ status: 'in-progress', step: 'workspace', answers: { workspaceRoots: [] } },
    { steps: STEPS, current: 'workspace', tierRecorded: true })
  assert.deepEqual({ ...answered },
    { tier: true, workspace: false, account: false, autonomy: false, review: false })
})

/* A step added to the walk must not fall through to a tick, which is how the
   positional rule shipped its answer for every step nobody had thought about. */
test('every step in the list gets an answer, including one nobody planned for', () => {
  const steps = [...STEPS.slice(0, 4), 'backup', 'review']
  const answered = answeredSetupSteps(SKIPPED, { steps, current: 'review', tierRecorded: true })
  assert.deepEqual(Object.keys(answered), steps, 'a step in the walk got no answer at all')
  assert.equal(answered.backup, false)
})

/* No stored profile and no recorded level is the first launch. Nothing has been
   answered, and a tick anywhere on that screen would be this program claiming a
   decision before the person has made one. */
test('a first launch has answered nothing', () => {
  const answered = answeredSetupSteps(null, { steps: STEPS, current: 'tier', tierRecorded: false })
  assert.deepEqual(Object.values(answered), [false, false, false, false, false])
})
