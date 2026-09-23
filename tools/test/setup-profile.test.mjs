// THE SETUP WALKTHROUGH: does it stay few, safe, visible, and reversible?
//
// The owner asked for a first run that behaves like twenty questions -- a small
// number of maximally informative questions landing on the right profile -- and
// named four properties the result has to have. Each section below is one of
// them, because each is a way this feature can be built, demoed, and still be
// wrong:
//
//   1. FEW. Three questions, and the derivation from three answers to nineteen
//      settings actually happens. A walkthrough that asks three questions and
//      sets three settings has not done the thing.
//   2. SAFE. The permission level is a CEILING an answer can never raise, an
//      unrecognised anything collapses to the cautious end, and the skip path
//      lands on exactly the state of a machine that never ran setup. That last
//      one is asserted as an equivalence rather than described, because "safe
//      default" is the kind of claim that is always made and rarely checked.
//   3. VISIBLE. Every setting the questions produce is reachable afterwards.
//   4. REVERSIBLE. Nothing is written until Finish, so a window closed halfway
//      through leaves the machine as it was.
//
// The shell half is exercised for REAL rather than matched in source: every
// function in shell/setup-record.cjs takes its payload modules by injection, so
// the tests below drive the actual code with a fake machine record and observe
// what it does -- including what it does NOT do on a refusal.

import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import {
  AUTONOMY_CHOICES,
  INTENT_BANNER_BODY,
  INTENT_IN_USE,
  INTENT_RECORDED_ONLY,
  PROFILE_INTENT,
  PROFILE_READ_UNAVAILABLE,
  PROFILE_SCHEMA_VERSION,
  PROFILE_STORAGE_KEY,
  RECOMMENDED_ANSWERS,
  SAFE_ANSWERS,
  SCREENS_CHOICES,
  START_CONTROL_FLAG,
  TIER_CEILINGS,
  answersForAutonomy,
  applyProfile,
  autonomyStartsAgents,
  ceilingForTier,
  deriveProfile,
  intentField,
  profileCanStartAnAgent,
  readStoredProfile,
  resumeStep,
  stepAfter,
  stepBefore,
  stepsAreReachable,
  writeStoredProfile,
  startControlOffBecause,
} from '../../src/setup-profile.js'
import { WRITE_ACTION_FLAGS } from '../../src/write-flags.js'
import { createSetupProfileSettings } from '../../src/setup-profile-settings.js'
import { SETTINGS_GROUPS } from '../../src/settings-presentation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')
const require_ = createRequire(import.meta.url)

const VIEW = read('src/views/setup.js')
const SETTINGS_VIEW = read('src/views/settings.js')
const SHELL = read('shell/main.cjs')
const PRELOAD = read('shell/fleet-profile-preload.cjs')

const WRITE_IDS = WRITE_ACTION_FLAGS.map(flag => flag.id)

const derive = (answers, tier) => deriveProfile(answers, { tier, writeFlagIds: WRITE_IDS })

/* ---------- 1. FEW: three questions, nineteen settings ---------- */

test('the walkthrough is three questions and a review, not a form', () => {
  const steps = /const STEPS = Object\.freeze\(\[([^\]]*)\]\)/.exec(VIEW)
  const labels = /const STEP_LABELS = Object\.freeze\(\[([^\]]*)\]\)/.exec(VIEW)
  assert.ok(steps, 'src/views/setup.js no longer declares a STEPS list')
  assert.ok(labels, 'every setup step must have a visible label')

  const parse = match => match[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
  const stepList = parse(steps)
  const questionList = stepList.filter(step => !['account', 'review'].includes(step))
  assert.equal(parse(labels).length, stepList.length, 'the progress indicator must include every step')

  /* THE PROMISE, not the list. Section 1 of docs/design/INSTALLER-EXPERIENCE.md
     promises a beginner "a total of three questions", and THAT is what must not
     drift. Pinning the whole of STEPS was too tight for a file several lanes
     touch: the account lane added a sign-in step, correctly kept it OUT of
     QUESTION_STEPS because it derives none of the nineteen settings, and turned
     this red for doing exactly the right thing. A step may be added; a QUESTION
     may not be, because each question is a promise about how few there are. */
  assert.deepEqual(questionList, ['tier', 'workspace', 'autonomy'])
  assert.equal(stepList.at(-1), 'review', 'the walkthrough no longer ends on the page that shows what was chosen')
  for (const question of questionList) {
    assert.ok(stepList.includes(question), `${question} is counted as a question but is not a step`)
  }
  assert.ok(!questionList.includes('review'), 'the review is not a question and must not be counted as one')

  /* EVERY STEP IS ARRIVED AT. This is the assertion that would have caught the
     worst defect of the session: an entire sign-in screen was added to STEPS,
     built, and covered by green tests, while the workspace step's Continue still
     named 'autonomy' -- so nothing routed to it and no user could ever reach it.
     A test that a screen RENDERS cannot see that. */
  assert.ok(stepsAreReachable(stepList), `walking forward from ${stepList[0]} does not arrive at every step: ${stepList.join(' -> ')}`)
})

test('a step is reachable by construction, not by remembering to wire it', () => {
  /* The destinations are computed from STEPS. A literal here is how the flow and
     the list drift apart, so literals are banned rather than merely discouraged:
     the previous version of this file named every destination by hand, which is
     exactly how a step got added with nothing pointing at it. */
  const literals = [...VIEW.matchAll(/next: '([a-z-]+)'/g)].map(match => match[1]).filter(value => value !== 'finish')
  assert.deepEqual(literals, [], `these Continue targets are hardcoded instead of derived from STEPS: ${literals.join(', ')}`)
  assert.match(VIEW, /stepAfter\(STEPS,/, 'the walkthrough no longer derives its Continue target from the step list')
  assert.match(VIEW, /stepBefore\(STEPS,/, 'the walkthrough no longer derives its Back target from the step list')
})

test('the step helpers walk the list and refuse a broken one', () => {
  const steps = ['a', 'b', 'c']
  assert.equal(stepAfter(steps, 'a'), 'b')
  assert.equal(stepAfter(steps, 'c'), null, 'the last step must not claim a next one')
  assert.equal(stepBefore(steps, 'a'), null, 'the first step must not claim a previous one')
  assert.equal(stepBefore(steps, 'c'), 'b')
  assert.equal(stepsAreReachable(steps), true)
  /* An unknown current step resolves to the END rather than to the beginning: a
     stale stored step must never drop someone back at the start of a walkthrough
     they already finished. */
  assert.equal(stepAfter(steps, 'nonsense'), 'c')
  assert.equal(stepsAreReachable([]), false)
})

test('one answer moves ten settings, which is what earns it a step', () => {
  const observing = derive({ autonomy: 'observe' }, 'unrestricted')
  const acting = derive({ autonomy: 'autonomous' }, 'unrestricted')

  const movedFlags = WRITE_IDS.filter(id => observing.writeFlags[id] !== acting.writeFlags[id])
  const movedIntent = PROFILE_INTENT.filter(field => observing.intent[field.id] !== acting.intent[field.id])
  assert.equal(movedFlags.length, WRITE_IDS.length, 'the autonomy answer does not reach every write-action flag')
  assert.equal(movedIntent.length, PROFILE_INTENT.length, 'the autonomy answer does not reach every cross-lane setting')
  assert.ok(movedFlags.length + movedIntent.length >= 10, 'one question moving fewer than ten settings has not earned a step')
})

test('the other answer reaches every screen', () => {
  /* It used to reach them seven flags at a time, and the canary here counted
     the flag register so a new screen could not silently widen the answer.
     The register is gone: the answer now lands on the ONE example toggle in
     src/data-source.js, which every screen resolves its data through, so
     "reaches every screen" holds by construction and the derivation only has
     to point the toggle the right way -- true means "show the example". */
  const live = derive({ screens: 'live' }, 'unrestricted')
  const demonstration = derive({ screens: 'demonstration' }, 'unrestricted')
  assert.equal(live.exampleMode, false, 'choosing your own activity left the example toggle on')
  assert.equal(demonstration.exampleMode, true, 'choosing the demonstration did not turn the example toggle on')
})

/* A typo in the derivation's flag list would leave one flag off at the most
   permissive combination and nothing else would notice. */
test('every flag the most permissive answer names is a flag that exists', () => {
  const profile = derive({ autonomy: 'autonomous' }, 'unrestricted')
  for (const id of WRITE_IDS) {
    assert.equal(profile.writeFlags[id], true, `${id} is never switched on by any answer, so the derivation names it wrongly or not at all`)
  }
})

/* ---------- 2. SAFE ---------- */

/* THE PROPERTY THAT MAKES SKIP DEFENSIBLE, asserted as an equivalence.
   src/write-flags.js returns true only for the literal 'enabled', and
   src/data-source.js reads the example toggle as OFF when no choice is
   stored. So the state a skipped walkthrough applies has to be: every write
   flag false, the example toggle off. Anything else means skipping changed
   the machine. */
test('skipping applies exactly the state of a machine that never ran setup', () => {
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const skipped = derive(SAFE_ANSWERS, tier)
    for (const id of WRITE_IDS) {
      assert.equal(skipped.writeFlags[id], derive({ autonomy: 'autonomous' }, tier).writeFlags[id], `Basic action ${id} lost its ${tier} ceiling`)
    }
    assert.equal(skipped.exampleMode, false, `skipping switched every screen to the example at ${tier}`)
  }
})

/* THIS TEST USED TO ASSERT THE DEFECT, and the replacement is deliberate rather
 * than an adjustment, so the next reader knows which way round it went.
 *
 * It said: "the preselected answer is the safe one, and it is the one marked
 * Recommended", and it pinned AUTONOMY_CHOICES[0] -- `observe` -- as both. It
 * was green for the whole life of the defect it was protecting. Taking the two
 * Recommended answers produced an installation with NO CONTROL ANYWHERE that
 * starts an agent, because `observe` requests no write-action flag and
 * `agent-session` is one. The product's own guidance led a trusting reader into
 * a dead end, and every "eight clicks to a running agent" measurement this
 * project has was obtained by refusing the recommendation.
 *
 * The rule the old test was reaching for is kept and split into the two
 * questions it had merged:
 *   - SKIP still leaves the machine untouched. That is the test above, and it
 *     is unchanged, because declining to choose may still switch nothing on.
 *   - WHAT WE RECOMMEND must leave a working product. That is this test, and
 *     it is stated as a property of the DERIVED settings at every permission
 *     level -- not as a property of a label, which is what let a recommendation
 *     and an unusable outcome coexist. */
test('the recommended answer leaves a control that starts an agent, at every level', () => {
  assert.ok(WRITE_IDS.includes(START_CONTROL_FLAG), 'the flag that decides whether an agent can be started has been renamed or removed')
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const recommended = derive(RECOMMENDED_ANSWERS, tier)
    assert.equal(
      profileCanStartAnAgent(recommended),
      true,
      `taking the recommended answers at ${tier} leaves no way to start an agent, which is the defect this test exists for`,
    )
  }
  /* And the recommendation is the thing the screen preselects. Two constants
     that are allowed to differ have to be checked against each other, or the
     label and the default drift apart and the label is the one that lies. */
  const recommended = AUTONOMY_CHOICES.filter(choice => choice.note === 'Recommended')
  assert.equal(recommended.length, 1, 'exactly one autonomy answer may carry the Recommended note')
  assert.equal(recommended[0].value, RECOMMENDED_ANSWERS.autonomy)
  assert.equal(SCREENS_CHOICES[0].value, RECOMMENDED_ANSWERS.screens)
  /* Recommending an acting answer is only defensible while it acts ONLY when a
     person presses something. The moment it approves, closes or replies on its
     own, the recommendation has to be re-argued rather than inherited. */
  const flags = derive(RECOMMENDED_ANSWERS, 'unrestricted').writeFlags
  for (const id of ['decision', 'queue', 'thread-reply']) {
    assert.equal(flags[id], true, `Basic should expose the authorized ${id} action`)
  }
})

/* The ORDER is still safest-first, which is what makes the three options read
   as an axis; it is simply no longer the same thing as the recommendation. */
test('the answers are listed least-acting first', () => {
  assert.equal(SAFE_ANSWERS.autonomy, 'autonomous')
  assert.deepEqual(derive({ autonomy: AUTONOMY_CHOICES[0].value }, 'unrestricted').writeFlags,
    Object.fromEntries(WRITE_IDS.map(id => [id, false])))
  let previous = -1
  for (const choice of AUTONOMY_CHOICES) {
    const count = WRITE_IDS.filter(id => derive({ autonomy: choice.value }, 'unrestricted').writeFlags[id]).length
    assert.ok(count > previous, `${choice.value} switches on no more than the answer before it, so the list is not an axis`)
    previous = count
  }
})

/* THE DEAD END IS ALLOWED TO EXIST; BEING SILENT ABOUT IT IS NOT.
   `observe` is a legitimate answer -- someone who wants to read before running
   anything is entitled to it -- so the repair is not to remove it but to make
   its consequence visible where the choice is made. Pinned to the derivation,
   so a fourth answer cannot be added that quietly leaves no start control. */
test('an answer that leaves no way to start an agent says so at the point of choice', () => {
  for (const choice of AUTONOMY_CHOICES) {
    const starts = autonomyStartsAgents(choice.value)
    assert.equal(
      Boolean(choice.consequence),
      !starts,
      `"${choice.label}" ${starts ? 'starts agents but carries a consequence sentence' : 'leaves no way to start an agent and says nothing about it'}`,
    )
    if (starts) continue
    assert.match(choice.consequence, /start an assistant|start an agent/i, 'the consequence must name what becomes impossible')
    assert.match(choice.consequence, /Settings|turn(s)? it on|one click/i, 'the consequence must say where it is turned back on')
  }
  /* And the walkthrough must actually print it. A sentence in a frozen table
     that no screen renders is the same as no sentence. */
  assert.match(VIEW, /choice\.consequence/, 'the autonomy step must render the consequence of each option')
  assert.match(VIEW, /data-setup-consequence/, 'the walkthrough must state the consequence of the CURRENT answer, not only the options')
})

test('the permission level is a ceiling no answer can raise', () => {
  const asked = derive({ autonomy: 'autonomous' }, 'guided')
  for (const id of ['dispatch', 'decision', 'queue', 'thread-reply']) {
    assert.equal(asked.writeFlags[id], false, `the guided level let ${id} through`)
    assert.ok(asked.refusedWriteFlags.includes(id), `${id} was dropped silently instead of being reported as refused`)
  }
  // ...and the two it does permit are still reachable, or the level is unusable
  assert.equal(asked.writeFlags['agent-session'], true)
  assert.equal(asked.writeFlags['report-read'], true)
})

test('the ceiling clamps the cross-lane settings too, and says that it did', () => {
  const guided = derive({ autonomy: 'autonomous' }, 'guided')
  assert.equal(guided.intent.attach, 'mirror', 'the beginner level allowed taking over a live editor session')
  assert.equal(guided.intent.approvals, 'stop')
  assert.equal(guided.intent.ideImport, 'none')
  assert.equal(guided.intent.failover, 'manual')
  assert.equal(guided.clampedIntent.length, 4, 'four settings were clamped and fewer than four were reported')

  const standard = derive({ autonomy: 'autonomous' }, 'standard')
  assert.equal(standard.intent.ideImport, 'ask', 'the standard level imported every editor session it could find')
  assert.equal(standard.intent.attach, 'fork', 'a preset must not select unavailable editor takeover')
})

/* An unknown level is a record from a newer build, a typo, or a truncated read.
   Resolving it to the LARGEST ceiling would make an unreadable file the reason a
   stranger's machine switched everything on. */
test('an unrecognised permission level gets the smallest ceiling, not the largest', () => {
  assert.deepEqual(ceilingForTier('omnipotent'), TIER_CEILINGS.guided)
  assert.deepEqual(ceilingForTier(undefined), TIER_CEILINGS.guided)
  const profile = derive({ autonomy: 'autonomous' }, 'omnipotent')
  assert.equal(profile.writeFlags.dispatch, false)
  assert.equal(profile.intent.attach, 'mirror')
})

test('missing answers use Basic while an explicitly invalid autonomy choice stays off', () => {
  for (const answers of [undefined, null, 'nonsense', []]) {
    const profile = derive(answers, 'unrestricted')
    assert.equal(profile.answers.autonomy, SAFE_ANSWERS.autonomy)
    assert.equal(profile.answers.screens, SAFE_ANSWERS.screens)
    for (const id of WRITE_IDS) assert.equal(profile.writeFlags[id], true)
  }
  const invalid = derive({ autonomy: 'yolo', screens: 'sideways' }, 'unrestricted')
  assert.equal(invalid.answers.autonomy, 'observe')
  for (const id of WRITE_IDS) assert.equal(invalid.writeFlags[id], false)
})

test('a hand-moved cross-lane setting is kept, and a nonsense one is not', () => {
  const moved = derive({ autonomy: 'observe', attach: 'fork' }, 'unrestricted')
  assert.equal(moved.intent.attach, 'fork', 'an individually changed setting was overwritten by the answer it came from')
  assert.equal(moved.intent.approvals, 'stop', 'changing one setting changed another')

  const nonsense = derive({ autonomy: 'observe', attach: 'obliterate' }, 'unrestricted')
  assert.equal(nonsense.intent.attach, 'mirror', 'an unrecognised value became an answer')
})

test('choosing a different overall answer resets the settings that answer implies', () => {
  const moved = { ...SAFE_ANSWERS, attach: 'adopt', approvals: 'judgement', workspaceRoots: [] }
  const reset = answersForAutonomy('observe', moved)
  assert.equal(reset.attach, 'mirror')
  assert.equal(reset.approvals, 'stop')
  assert.equal(reset.autonomy, 'observe')
  const raised = answersForAutonomy('autonomous', moved)
  assert.equal(raised.ideImport, 'all-detected')
})

/* ---------- 3. VISIBLE ---------- */

test('every setting the questions produce is reachable in Settings afterwards', () => {
  /* The rail is generated from this exported presentation model. Checking the
     value the rail consumes permits a dispatcher rename, reordering its helper
     declarations, or replacing the if-chain with a table without turning a
     working Settings page red. */
  assert.ok(
    SETTINGS_GROUPS.some(group => group.sections.includes('Setup')),
    'the Settings presentation model has no Setup category, so the profile rows cannot be reached from its rail',
  )

  /* AND THE ASSERTIONS ABOVE ARE NOT ENOUGH, which is the whole lesson.
   *
   * Every one of them reads SOURCE TEXT, and a defect that empties markup()
   * leaves all of it untouched: the dispatcher still says
   * `return setupController.markup()`, the import is still there, the rail entry
   * is still there, and the section renders nothing. Planting `return ''` at the
   * top of markup() with the real builder still below it kept this suite GREEN.
   * Dead code matches a text search exactly as well as live code does, so no
   * assertion over source can see reachability -- it can only see presence, and
   * presence is what survives every defect of this family.
   *
   * A sibling lane had to move its markup into a DOM-free module to make this
   * checkable. Mine already is one: src/setup-profile-settings.js imports no
   * stylesheet and touches no DOM, so the test CALLS it and reads what comes
   * back. That is a rendered result, not a description of one.
   *
   * The view itself (src/views/setup.js) cannot be called here -- it imports
   * three stylesheets and builds DOM -- so its rendering is covered by the
   * packaged run instead, which drives the real window and reads real text. */
  const rendered = createSetupProfileSettings().markup()
  for (const row of ['Permission level', 'Working folders', 'How much it does without asking', 'What the screens show', 'Walk through setup again']) {
    assert.ok(rendered.includes(row), `the Setup section renders without its "${row}" row`)
  }
  for (const field of PROFILE_INTENT) {
    assert.ok(rendered.includes(field.name), `the Setup section renders without the "${field.name}" row, so that setting is unreachable after first run`)
  }

  const SECTION = read('src/setup-profile-settings.js')
  assert.match(SECTION, /chooseTier/, 'the permission level is not changeable in Settings, so "you can change it later in Settings" is still untrue')
  assert.match(SECTION, /recordWorkspaces/, 'the working folder is not changeable in Settings')
  for (const field of PROFILE_INTENT) {
    assert.match(SECTION, new RegExp(`intent:\\$\\{field\\.id\\}|${field.id}`), `${field.id} has no row in Settings`)
  }
})

/* WHAT THIS PINNED BEFORE, AND WHY IT HAD TO CHANGE RATHER THAN BE DELETED.
 *
 * Until 2026-08-18 this asserted `field.enforced === false` for EVERY intent
 * row, and it was right to: all four were recorded and none was read, and the
 * screens said so. `failover` is now genuinely acted on -- the answer reaches
 * the payload's rotation module as its mode, and decides whether a spent
 * account may hand a session to the next one. So the old assertion would now
 * be pinning a lie in the other direction.
 *
 * THE REPLACEMENT IS STRICTER, NOT LOOSER, AND THAT IS DELIBERATE. Flipping a
 * boolean is the cheapest possible way to claim a setting is real, so this
 * asserts BOTH populations exist and BOTH sentences appear. A change that
 * marked every row enforced to make a test pass would fail here, and so would
 * one that quietly marked this row unenforced again while leaving the code
 * that reads it in place. */
test('each recorded setting says truthfully whether it is acted on yet', () => {
  const SECTION = read('src/setup-profile-settings.js')
  const enforced = PROFILE_INTENT.filter(field => field.enforced === true)
  const recordedOnly = PROFILE_INTENT.filter(field => field.enforced !== true)

  // Every row now has a reader. Unsupported provider attachment operations
  // refuse at that reader; the availability statement remains explicit.
  assert.ok(enforced.length > 0, 'no intent row is acted on; the settings list would be claiming nothing works')
  assert.equal(recordedOnly.length, 0)
  assert.match(PROFILE_INTENT.find(field => field.id === 'attach').desc, /unavailable without that handoff/)

  /* An enforced row must NAME where it is acted on. A boolean alone is a claim
     nobody can check, which is the failure this whole change is about. */
  for (const field of enforced) {
    assert.equal(typeof field.enforcedBy, 'string')
    assert.ok(field.enforcedBy.trim().length > 0,
      `${field.id} says it is enforced but names nothing that enforces it`)
  }

  /* The same honesty rule src/setup-state.js applies to the permission level's
     own enforcement gap. A row that silently does nothing is worse than no row. */
  /* Asserted through the exported sentences rather than a literal in the screen:
     the copy moved beside the rows precisely so two screens could not drift, and
     a test matching a literal in one screen would not have noticed the other. */
  assert.match(INTENT_RECORDED_ONLY, /not yet acted on/i, 'the rows that are not yet acted on no longer say so')
  assert.match(INTENT_IN_USE, /in use now/i, 'the row that IS acted on is described as though it were not')
  assert.match(SECTION, /INTENT_RECORDED_ONLY/, 'the settings list stopped printing what a recorded-only row does')
  assert.match(SECTION, /INTENT_IN_USE/, 'the settings list stopped printing what an acted-on row does')
  assert.match(INTENT_BANNER_BODY, /Takeover requires a verified editor handoff, which is unavailable today/, 'the banner must state the unsupported takeover capability')
  assert.match(INTENT_BANNER_BODY, /applied when you save/, 'the banner no longer names when the working policies are applied')
  assert.match(VIEW, /INTENT_BANNER_BODY/, 'the review page stopped printing the banner that says what these rows do')
})

test('the failover answer is the one the account switching actually reads', async () => {
  /* THE ANTI-DECORATION CHECK. `enforced: true` is a string in a file; what
     makes it true is that the main process passes this answer to the module
     that switches accounts. This asserts the wiring exists rather than
     trusting the flag, because the flag is exactly what a mistake would set
     without doing the work. */
  /* Since 2026-09-02 the answer reaches switching through ONE record: a change
     to it is mirrored into the accounts registry's selectionMode (the page-2
     menu's own rule), and main hands that recorded mode to the engine on every
     start. The main process no longer reads the answer itself, so what is
     asserted is each hop of that path rather than a word. */
  const PROFILE = read('src/setup-profile.js')
  assert.doesNotMatch(PROFILE, /mirrorFailoverAnswer/, 'saving an in-progress walkthrough must not write runtime account policy')
  const { applySetupIntentChanges } = await import('../../src/setup-intent-commit.js')
  const choices = []
  for (const next of ['manual', 'auto']) {
    await applySetupIntentChanges({ approvals: 'stop', ideImport: 'none', failover: next === 'auto' ? 'manual' : 'auto' },
      { approvals: 'stop', ideImport: 'none', failover: next },
      { mcProviders: { accountPolicy: async request => { choices.push(request); return { ok: true } } } })
  }
  assert.deepEqual(choices, [{ selectionMode: 'manual' }, { selectionMode: 'priority' }], 'only the selection mode is changed; account thresholds are preserved')
  const MAIN = read('shell/main.cjs')
  const start = MAIN.indexOf('async function resolveSessionAccount(')
  const end = MAIN.indexOf('\n}', start)
  assert.ok(start > 0 && end > start)
  let policy
  const calls = []
  const resolve = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR',
    'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE',
    MAIN.slice(start, end + 2) + '; return resolveSessionAccount;')(
    () => ({ resolveAccountForSession: async request => { calls.push(request); return { rotated: true } } }),
    () => policy, () => 'fixture-services', 'fixture-owning-home', false, 'fixture-registry')
  for (const selectionMode of ['manual', 'priority', 'most-available', 'least-available', 'even', 'dynamic', 'resets-soonest']) {
    policy = { selectionMode, reservePercent: 20, rankWindow: 'weekly' }
    await resolve({ provider: 'claude' })
    assert.equal(calls.at(-1).selectionMode, selectionMode, 'ordinary starts must preserve the recorded choice')
    assert.equal(calls.at(-1).reservePercent, 20)
    assert.equal(calls.at(-1).rankWindow, 'weekly')
    await resolve({ provider: 'claude', excludeAccounts: ['spent-account'] })
    assert.equal(calls.at(-1).selectionMode, selectionMode === 'manual' ? 'priority' : selectionMode)
    assert.deepEqual(calls.at(-1).excludeAccounts, ['spent-account'])
    await resolve({ provider: 'claude', preferred: 'original-account', exact: true })
    assert.equal(calls.at(-1).selectionMode, 'manual', 'resume must retain its exact account')
    assert.equal(calls.at(-1).preferred, 'original-account')
  }
  policy = null
  await resolve({ provider: 'claude' })
  assert.equal(Object.hasOwn(calls.at(-1), 'selectionMode'), false, 'an absent policy must not invent a choice')
  assert.doesNotMatch(MAIN, /failoverModeFromProfile/, 'a second reader of the walkthrough answer came back; the registry is the one record')
  assert.match(MAIN, /accountResolver/, 'the account choice is never handed to the thing that starts a session')
})

/* WHAT THIS ASSERTED FIRST, AND WHY THAT WAS THE WRONG PROPERTY.
 *
 * It used to assert that no setup surface contained `type="password"` at all,
 * and that both surfaces stated "No account, password, or key is asked for
 * anywhere in this setup". That went red the moment the account lane added a
 * sign-in step to this same walkthrough -- and it was right to, because the
 * sentence had become FALSE: a password IS asked for now, for a local account on
 * this computer. A first-impression screen promising it collects nothing while
 * collecting something is the worst defect either lane could ship, so the copy
 * was corrected rather than the assertion deleted.
 *
 * The property worth defending is not "no field exists". It is that whatever any
 * setup surface collects CANNOT REACH THE STORED PROFILE, which is serialised to
 * localStorage and rendered on the review page. That is asserted below against
 * the fields actually present in the walkthrough, so it keeps holding as other
 * lanes add steps, instead of going stale the way the literal ban did. */
test('nothing a setup surface collects can reach the stored profile', () => {
  const collected = [...VIEW.matchAll(/data-setup-account-field="([a-zA-Z]+)"/g)].map(match => match[1])
  const fields = [...new Set([...collected, 'password', 'apiKey', 'token', 'secret'])]
  const stored = writeStoredProfile(
    { status: 'complete', answers: { autonomy: 'observe', ...Object.fromEntries(fields.map(field => [field, 'a-value-that-must-not-persist'])) } },
    fakeStorage(),
  )
  for (const field of fields) {
    assert.equal(stored.answers[field], undefined, `${field} survived into the stored profile`)
  }
  assert.equal(JSON.stringify(stored).includes('a-value-that-must-not-persist'), false)
})

/* EVERY SENTENCE THE WALKTHROUGH SHOWS, WALKED UNDER ONE RULE.
 *
 * Twenty-nine user-facing sentences live as literals in src/views/setup.js and,
 * until this test, exactly two of them were looked at by anything. The rest could
 * have named a mechanism, leaked an internal identifier, or made a promise the
 * product had stopped keeping, and every test in this repo would have stayed
 * green. That is not hypothetical here: the credential sentence went false TWICE
 * in one session, and only one of the two was caught by a test -- the other was
 * caught by another lane reading it.
 *
 * WHY THE COPY IS NOT MOVED INTO A `COPY` OBJECT, which is the stronger fix and
 * the one a sibling lane applied to its own view. src/views/setup.js is now
 * shared: the account step and its sentences belong to another lane and are
 * being edited concurrently. Hoisting every string would rewrite their work to
 * make my test tidier, which is the collision the coordination board exists to
 * prevent. Walking the rendered source gets the same RULES over the same
 * sentences without touching a line anyone else owns. If this file ever settles
 * to one owner, hoist them.
 *
 * KNOWN BOUND, stated rather than papered over: this reads text nodes plus
 * aria-label and placeholder values. Copy assembled at runtime from a variable
 * is not visible to it. The model's own copy -- the choices and the four
 * cross-lane fields -- is covered separately, because those ARE structured data
 * and are asserted against by name elsewhere in this file.
 */
function renderedCopy(source) {
  const text = [...source.matchAll(/>([A-Z][a-z][^<>{}$]{10,})</g)].map(match => match[1])
  const attributes = [...source.matchAll(/(?:aria-label|placeholder)="([^"${}]{10,})"/g)].map(match => match[1])
  return [...text, ...attributes]
}

/* THE MODEL'S COPY IS WALKED AS DATA, NOT AS SOURCE.
 *
 * The choices and the four cross-lane fields are structured objects, so the test
 * reads the real exported values instead of regexing the file. That is strictly
 * stronger: a sentence assembled from two halves, or moved between fields, is
 * still seen. */
function modelCopy() {
  const strings = []
  for (const choice of [...AUTONOMY_CHOICES, ...SCREENS_CHOICES]) {
    /* `consequence` is walked for the same reason `detail` is, and it was the
       first thing checked when it was added: a new copy field that no rule
       reads is a sentence in front of a stranger that nothing is watching, and
       the consequence sentences are the most absolute copy on the screen. */
    strings.push(choice.label, choice.note, choice.detail, choice.consequence)
  }
  for (const field of PROFILE_INTENT) {
    strings.push(field.name, field.desc, ...Object.values(field.labels))
  }
  return strings.filter(value => typeof value === 'string' && value.trim().length >= 10)
}

/* ALL THREE PLACES THIS LANE PUTS WORDS IN FRONT OF A PERSON.
 *
 * The first version of these rules walked ONE of them -- the view -- and that
 * was the same error the rules exist to catch, committed inside the fix for it.
 * Measured immediately afterwards: seven absolute claims were sitting
 * unregistered in the other two files, including the very sentence that had
 * already gone false twice. Fixing one instance and not asking what else is
 * unwatched is apparently the hardest habit here to break; this is the third
 * time in one session it has come up, and the first time it was mine twice. */
function everySentenceThisLaneShows() {
  return [
    ...renderedCopy(VIEW),
    ...renderedCopy(read('src/setup-profile-settings.js')),
    ...modelCopy(),
  ]
}

test('no sentence this lane shows names a mechanism', () => {
  const viewCopy = renderedCopy(VIEW)
  const settingsCopy = renderedCopy(read('src/setup-profile-settings.js'))
  const structuredCopy = modelCopy()
  assert.ok(
    viewCopy.length > 0 && settingsCopy.length > 0 && structuredCopy.length > 0,
    `the copy guard must examine every surface (walkthrough: ${viewCopy.length}, Settings: ${settingsCopy.length}, model: ${structuredCopy.length})`,
  )
  const copy = [...viewCopy, ...settingsCopy, ...structuredCopy]
  /* A stranger reads this screen before they have any idea what the program is
     made of. An internal identifier here is not jargon-as-style, it is a leak. */
  const mechanism = /\b(localStorage|sessionStorage|IPC|ipcRenderer|preload|renderer|asar|machine\.json|workspaceRoots|mc\.write|mc\.live|mc\.set|JSON|schema|payload|boolean|null|undefined|serialise|serialize|git|repository|commit)\b/i
  /* COUNTED, because a loop that iterates nothing passes.
     Asserting on `copy` and then looping over something else is the shape that
     lets a guard go inert while reporting success -- the same rule
     tools/check-no-owner-data.mjs applies to itself ("scanned 0 files" is an
     error there, not a pass). A planted `for (const sentence of [])` kept this
     test green until this counter existed. */
  let checked = 0
  for (const sentence of copy) {
    checked += 1
    assert.doesNotMatch(sentence, mechanism, `a user-facing sentence names a mechanism: "${sentence}"`)
  }
  assert.equal(checked, copy.length, 'the loop did not examine every sentence that was collected')
})

/* THE CLASS THAT ACTUALLY BIT, TWICE, so it gets the strictest rule.
 *
 * An absolute claim about what the product never does is the most fragile
 * sentence a first-run screen can carry: it is written when it is true, and it
 * is falsified by a lane that never reads it. So every one of them has to be
 * REGISTERED HERE with the reason it is still true. A new absolute claim fails
 * this test until someone writes that reason down, which is the whole point --
 * the cost of the sentence is paid at the moment it is added, by the person who
 * knows why they added it, instead of by whoever finds it false later. */
/* Two kinds of entry, because a word is not a promise.
 *
 * `pinned` is a claim about what the product does, and its reason must name the
 * MECHANISM that keeps it true -- ideally a test in this file, so falsifying the
 * behaviour turns something red before the sentence becomes a lie.
 * `not-a-promise` is a sentence where the word appears without any claim being
 * made: the name of an ANSWER a person is choosing, not an assertion by us.
 *
 * Splitting them is the precise repair rather than the loose one. The loose
 * repair -- exempting short strings, or dropping "nothing" from the pattern --
 * would have silenced a real promise the next time one was written short. */
const PINNED_ABSOLUTE_CLAIMS = Object.freeze([
  {
    /* THE BOTTOM CAP OF THE PERMISSION SLIDER. It is an absolute claim and it
       is meant to be: naming the unrestricted end softly is how a person
       slides past it. It is true by construction rather than by promise --
       the level IS the confinement, so at `unrestricted` there is no
       confinement left to apply. See setup-state.js's TIER_CHOICES entry for
       unrestricted and permission-tier-policy.js's INSTALL_TIER_SESSIONS,
       where that level maps to the unconfined local session. */
    match: /Nothing off limits/,
    kind: 'pinned',
    pinnedBy: 'the unrestricted level maps to an unconfined session in INSTALL_TIER_SESSIONS, so there is no confinement remaining to name; the cap states the end of the axis rather than promising a behaviour',
  },
  {
    /* REWRITTEN FROM A NEGATIVE-SUBJECT SENTENCE INTO AN ACTIVE ONE. It read
       "No subscription, key, or password for Claude, ChatGPT or Google is asked
       for anywhere in this setup or stored by this program", which is
       twenty-eight words in the passive voice on a screen a stranger reads once.
       It is now "Nothing in this setup asks for a subscription, key or password
       for Claude, ChatGPT or Google, and this program stores none." Same two
       claims -- nothing is asked for, nothing is stored -- and the pattern is
       written against the subjects rather than against the word order, so a
       later rewording that keeps the promise does not turn this red. */
    match: /(setup|product) (asks|is asked).{0,40}(subscription|key|password)|(subscription|key,? or password).{0,60}(asked for|stores none)/i,
    kind: 'pinned',
    pinnedBy: 'no setup surface collects a provider credential; asserted by "nothing a setup surface collects can reach the stored profile", which discovers the collected fields rather than listing them, and by the credential-claims test',
  },
  {
    /* The settings-drawer copy of the same claim, deliberately scoped to THIS
       SCREEN rather than to the product: it said "anywhere in this product"
       until a lane could have falsified it on a screen no test of mine can see,
       and a claim nothing can keep is not worth making. */
    match: /This screen asks for no subscription, key or password for Claude, ChatGPT or Google/,
    kind: 'pinned',
    pinnedBy: 'same mechanism as above. Deliberately scoped to the screen it is printed on, for the reason recorded above it',
  },
  {
    match: /nothing at all is switched on that acts: no assistant starts/,
    kind: 'pinned',
    pinnedBy: 'AUTONOMY_WRITE_FLAGS.observe is the empty array, so the answer requests no write-action flag; asserted by "skipping applies exactly the state of a machine that never ran setup", which checks every flag false at all three levels',
  },
  {
    match: /None of it is your data and each screen says so/,
    kind: 'pinned',
    pinnedBy: 'the demonstration answer turns on the one example toggle, src/data-source.js answers the mock source for every screen while it is on, and sourceIsBadged() marks that source on every surface; asserted by "the other answer reaches every screen"',
  },
  {
    match: /The permission level takes effect as soon as you pick it/,
    kind: 'pinned',
    pinnedBy: 'src/views/setup.js commitTier() calls mcSetup.chooseTier() and then goTo("workspace") -- the level is written at the moment it is picked, and that file says so in its own words: "The level is the ONLY thing this walkthrough writes before the end, and only because the first-run gate is built on it." THE SENTENCE THIS REPLACED SAID THE OPPOSITE: "Nothing is written until you finish it, and leaving partway changes nothing." Its pin justified a NARROWER fact than the copy claimed -- that the ANSWERS are applied only from Finish or Skip, which is true -- so the register held a correct reason for a sentence that overclaimed past it. Somebody re-running setup from Settings, picking a wider level and then abandoning at the folder question kept the wider level, having been told leaving partway changed nothing.',
  },
  {
    match: /^Nothing yet — let me look around first$/,
    kind: 'not-a-promise',
    pinnedBy: 'the NAME of the answer a person is choosing, not an assertion about the product. The promise that answer carries is the detail beneath it, which is pinned separately above',
  },
  {
    match: /With this answer, nothing here will start an agent/,
    kind: 'pinned',
    pinnedBy: 'rendered only when profileCanStartAnAgent() is false for the CURRENT answers with the tier ceiling applied, so the sentence and the state it describes are computed from one value; asserted by "the recommended answer leaves a control that starts an agent, at every level", which is the test that would go red if the two ever disagreed',
  },
  {
    match: /Nothing on this computer will be able to start an assistant while this is the answer/,
    kind: 'pinned',
    pinnedBy: 'AUTONOMY_WRITE_FLAGS.observe is the empty array so the answer requests no start flag, and src/agent-session.js mounts no Start control without it; asserted by "an answer that leaves no way to start an agent says so at the point of choice", which pins this sentence to autonomyStartsAgents() rather than to the label',
  },
  {
    /* Not a new sentence: it has been on the review since the block existed,
       but it sat inside a ternary, and the scanner cannot see copy assembled
       through an interpolation -- the known bound stated at renderedCopy(). The
       R1529 rewrite of that block split the branches into literals, which is
       what brought it into view. It is registered rather than reworded because
       it is true and because a sentence becoming VISIBLE to the guard is the
       guard working. */
    match: /Nothing that acts is switched on\. Every screen still reads and reports/,
    kind: 'pinned',
    pinnedBy: 'rendered only when the derived profile leaves every write-action flag false, computed from the same value the row list is built from, so the sentence and the state it describes cannot disagree; the skip-equivalence test asserts that state is exactly a machine that never ran setup',
  },
  {
    /* R1529. The lede over the block that explains every switch the answers
       left off. It is the sentence that makes the block guidance rather than a
       nudge, so it is the one sentence in that block that must be true. */
    match: /None of these is required\. This program works as it is/,
    kind: 'pinned',
    pinnedBy: 'no write-action flag is a precondition for any other surface: each one gates only its own mount and every mount returns a no-op when its flag is off, which tools/test/write-flags-fail-closed.test.mjs asserts flag by flag. The guidance module that supplies the rest of the block is asserted to contain no writer at all, so nothing it renders can switch anything on -- see "nothing in the guidance module can turn anything on" in tools/test/permission-guidance.test.mjs',
  },
  {
    match: /Nothing runs until you press start/,
    kind: 'pinned',
    pinnedBy: 'the recommended answer requests report-read, agent-session, dispatch and cloud-launch, and every one of those is a control a person presses; asserted by the recommended-answer test, which fails if decision, queue or thread-reply are ever switched on by it',
  },
  /* The standing-requests brief (owner, 2026-08-19). These two sentences
     describe the owner's request commands, not a state of this product, and
     each was verified verbatim against the request skills' own SKILL.md
     before it was written -- the source of truth the owner names for these
     scopes. tools/test/settings-one-click.test.mjs pins the card's wording;
     if the skills' scope semantics ever change, that suite and this registry
     are the two places the change must land. */
  {
    match: /The rule stands for that working session and every agent it starts\. Other sessions never see it/,
    kind: 'pinned',
    pinnedBy: 'the session ledger is keyed by one session id and handed only to that session\'s own spawns at their boot; the request-session skill states "Other sessions never see it" in those words, and the card was checked against it rather than remembered',
  },
  {
    match: /It never reaches its neighbours or its manager/,
    kind: 'pinned',
    pinnedBy: 'the tree ledger anchors at the agent the command was typed to and descends transitively; the request-tree skill states the rule "never flows upward or sideways", and the card was checked against it rather than remembered',
  },
  {
    /* "Always" here is inside the words a person would TYPE -- the example
       request itself -- not a promise this product makes. The clause after it
       is the promise, and it is the global scope's own definition. */
    match: /Type: \/Request Always ask before spending money\. From then on, every agent starts its work knowing that rule/,
    kind: 'pinned',
    pinnedBy: 'the global request ledger is carried in every agent\'s onboarding packet at boot until the owner edits or deletes it -- the request skill\'s definition of the global scope, which the card was checked against rather than remembered',
  },
])

test('every absolute claim on screen is registered with the reason it is true', () => {
  const absolute = /\b(never|nothing|no one|anywhere|always|none)\b/i
  const claims = everySentenceThisLaneShows().filter(sentence => absolute.test(sentence))
  /* THE DETECTOR MUST FIND SOMETHING. A sibling lane shipped this exact rule
     with a word-boundary escape that a heredoc had eaten into a literal
     backspace: it compiled, it ran, it matched nothing, and it reported zero
     absolute sentences in copy that had thirteen. A green test over an empty
     scan, committed inside the fix for green tests over empty scans. The
     registry is the floor -- every pinned sentence is one the detector is known
     to be able to find, so finding fewer than that means the pattern died. */
  assert.ok(
    claims.length >= PINNED_ABSOLUTE_CLAIMS.length,
    `the detector found ${claims.length} absolute sentences but ${PINNED_ABSOLUTE_CLAIMS.length} are registered; the pattern has gone inert and this guard is checking air`,
  )
  for (const claim of claims) {
    const pin = PINNED_ABSOLUTE_CLAIMS.find(entry => entry.match.test(claim))
    assert.ok(
      pin,
      `this sentence promises something absolute and nothing pins it true:\n    "${claim}"\n  Register it in PINNED_ABSOLUTE_CLAIMS with the reason, or soften it. Two sentences of this exact shape went false in one session.`,
    )
    assert.ok(pin.pinnedBy.length > 40, 'a pinned claim needs a real reason, not a placeholder')
    assert.ok(['pinned', 'not-a-promise'].includes(pin.kind), `${pin.kind} is not a kind of entry this registry has`)
  }
  /* And the pins are not allowed to rot into decoration: a registered claim that
     no longer appears means the sentence was reworded and its reason was left
     behind describing nothing. */
  for (const entry of PINNED_ABSOLUTE_CLAIMS) {
    assert.ok(
      claims.some(claim => entry.match.test(claim)),
      `a claim is pinned here but no longer appears on screen: ${entry.match}. Remove the pin, or restore the sentence.`,
    )
  }
})

test('the setup surfaces claim only what is still true about credentials', () => {
  for (const [name, source] of [['the walkthrough', VIEW], ['the settings section', read('src/setup-profile-settings.js')]]) {
    /* The absolute claim is banned, not merely absent: it read well, it is the
       obvious sentence to write, and it is now untrue. */
    assert.doesNotMatch(
      source, /No account, password, or key is asked for anywhere in this setup/,
      `${name} still claims setup asks for no account, which stopped being true when the sign-in step landed`,
    )
    assert.match(
      source, /stay in their own programs/,
      `${name} no longer says where an assistant subscription actually lives`,
    )
    assert.doesNotMatch(source, /ANTHROPIC_API_KEY|sk-[a-zA-Z0-9]{10}/, `${name} names a provider credential`)
  }
})

/* ---------- 4. REVERSIBLE ---------- */

test('nothing but the permission level is written before Finish', () => {
  const finish = VIEW.slice(VIEW.indexOf('async function finish()'), VIEW.indexOf('  /**\n   * Skip'))
  assert.ok(finish.includes('recordWorkspaces'), 'Finish does not record the folders')
  const beforeFinish = VIEW.slice(0, VIEW.indexOf('async function finish()'))
  assert.ok(!beforeFinish.includes('recordWorkspaces('), 'a folder is recorded before the person finishes setup')

  /* Settings reach storage through exactly one helper, and that helper is called
     from exactly two places: Finish and Skip. Both are terminal -- the person
     has said they are done. Matching on `applyProfile(` instead was the obvious
     way to write this and was worthless: the import line and the helper's own
     body both contain it, so it passed while proving nothing. Counting CALL
     SITES is the assertion that means what the comment above it says. */
  const declaration = VIEW.indexOf('function applyDerived()') + 'function '.length
  const callSites = [...VIEW.matchAll(/applyDerived\(\)/g)]
    .map(match => match.index)
    .filter(index => index !== declaration)
  assert.equal(callSites.length, 2, `the settings are applied from ${callSites.length} places; only Finish and Skip may apply them`)
  for (const index of callSites) {
    assert.ok(index > VIEW.indexOf('async function finish()'),
      'settings are applied somewhere earlier than Finish, so leaving the walkthrough halfway changes the machine')
  }

  /* The folder write goes FIRST and a failure stops everything: applying the
     switches and then failing to record the folder leaves a machine that
     half-agrees with the screen the person is looking at. */
  assert.ok(finish.indexOf('recordWorkspaces') < finish.indexOf('applyDerived()'),
    'the switches are applied before the write that can fail')
})

test('a walkthrough left halfway holds its answers and applies none of them', () => {
  const storage = fakeStorage()
  writeStoredProfile({ status: 'in-progress', step: 'autonomy', answers: { autonomy: 'autonomous' } }, storage)
  const stored = readStoredProfile(storage)
  assert.equal(stored.status, 'in-progress')
  assert.equal(stored.answers.autonomy, 'autonomous')
  assert.equal(resumeStep(stored, { tierRecorded: true, steps: ['tier', 'workspace', 'autonomy', 'review'] }), 'autonomy')
})

test('the walkthrough opens where the person actually is', () => {
  const steps = ['tier', 'workspace', 'autonomy', 'review']
  assert.equal(resumeStep(null, { tierRecorded: false, steps }), 'tier', 'a fresh machine does not open on the permission question')
  assert.equal(resumeStep(null, { tierRecorded: true, steps }), 'workspace', 'a machine with a level but no profile does not continue the walkthrough')
  const complete = { status: 'complete', step: 'review', answers: SAFE_ANSWERS }
  assert.equal(resumeStep(complete, { tierRecorded: true, steps }), 'review', 'reopening setup asks the questions again instead of showing the answers')
})

test('skip is offered on every step that has one, and cannot be hidden by a caller', () => {
  const actions = VIEW.slice(VIEW.indexOf('function actionsMarkup('), VIEW.indexOf('function stepMarkup('))
  assert.match(actions, /skip = true/, 'skip is no longer the default for a step')
  assert.match(actions, /data-setup-skip/, 'the skip control is not rendered')
  assert.ok(!VIEW.includes('skip: false'), 'a step suppresses the skip control, which makes the walkthrough a trap')
})

/* ---------- the stored record refuses what it cannot trust ---------- */

function fakeStorage(initial = null) {
  let value = initial
  return {
    localStorage: {
      getItem: () => value,
      setItem: (_key, next) => { value = next },
    },
  }
}

test('a stored profile this build cannot trust is read as no profile', () => {
  for (const raw of ['not json', '[]', '42', 'null', JSON.stringify({ schemaVersion: 99, status: 'complete' }), JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, status: 'invented' })]) {
    assert.equal(readStoredProfile(fakeStorage(raw)), null, `${raw} was accepted as a profile`)
  }
})

test('an unreadable stored profile is not reported absent and is never latched', () => {
  let reads = 0
  const busy = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
  const record = JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION, status: 'complete', answers: SAFE_ANSWERS,
  })
  const hostile = { localStorage: {
    getItem() {
      reads += 1
      if (reads === 1) throw busy
      if (reads === 2) throw 'opaque storage refusal'
      return record
    },
    setItem() { throw new Error('quota') },
  } }

  assert.throws(
    () => readStoredProfile(hostile),
    error => error.code === PROFILE_READ_UNAVAILABLE
      && error.cause === busy
      && /not claiming.*absent/i.test(error.message),
    'EMFILE was turned into null, the definite answer that no stored profile exists',
  )
  assert.throws(
    () => readStoredProfile(hostile),
    error => error.code === PROFILE_READ_UNAVAILABLE
      && error.cause === 'opaque storage refusal'
      && /not claiming.*absent/i.test(error.message),
    'a non-Error throw with no code was turned into definite absence',
  )
  assert.equal(readStoredProfile(hostile)?.status, 'complete',
    'the could-not-tell result was cached or latched instead of retrying storage')
  assert.equal(reads, 3, 'each read must consult storage; there is no negative cache to retain a transient failure')

  /* CONTROL: null remains the definite, legitimate absence result, and even it
     is not negatively cached. This prevents a "never read storage" change from
     satisfying only the error assertions above. */
  let absentReads = 0
  const absent = { localStorage: { getItem() { absentReads += 1; return null } } }
  assert.equal(readStoredProfile(absent), null)
  assert.equal(readStoredProfile(absent), null)
  assert.equal(absentReads, 2, 'absence was cached even though a later write may create the profile')

  assert.equal(writeStoredProfile({ status: 'complete', answers: SAFE_ANSWERS }, hostile), null)
})

test('the stored key is the one the settings section reads', () => {
  assert.equal(PROFILE_STORAGE_KEY, 'mc.setup.profile')
  const storage = fakeStorage()
  writeStoredProfile({ status: 'complete', answers: { autonomy: 'assisted', screens: 'demonstration' } }, storage)
  const back = readStoredProfile(storage)
  assert.equal(back.answers.autonomy, 'assisted')
  assert.equal(back.answers.screens, 'demonstration')
})

test('applying the profile goes through the application’s own setters', () => {
  const wrote = []
  const exampled = []
  const profile = derive({ autonomy: 'assisted', screens: 'demonstration' }, 'unrestricted')
  applyProfile(profile, {
    setWriteFlag: (id, on) => { wrote.push([id, on]); return on },
    setExampleMode: on => { exampled.push(on); return on },
  })
  assert.equal(wrote.length, WRITE_IDS.length, 'not every write flag was written, so one keeps a stale value')
  assert.deepEqual(wrote.find(entry => entry[0] === 'agent-session'), ['agent-session', true])
  assert.deepEqual(wrote.find(entry => entry[0] === 'decision'), ['decision', false])
  /* Exactly one call, carrying the answer: the demonstration answer turns the
     example ON, and the toggle is written in both directions so a leftover
     example state cannot survive a profile that chose the other answer. */
  assert.deepEqual(exampled, [true])
  const backToLive = []
  applyProfile(derive({ autonomy: 'assisted', screens: 'live' }, 'unrestricted'), {
    setWriteFlag: () => true,
    setExampleMode: on => { backToLive.push(on); return on },
  })
  assert.deepEqual(backToLive, [false], 'choosing your own activity did not switch the example off')
})

/* ---------- the shell: the folder question, driven for real ---------- */

const SETUP_RECORD = require_(path.join(REPO_ROOT, 'shell', 'setup-record.cjs'))

/* Real temporary directories, not invented absolute paths. `recordWorkspaces`
   now writes an assistant configuration into the chosen folder, so a fixture
   naming `C:\Work` would have this suite create that directory on the machine
   running it. Every path below lives under one temp root that is removed after. */
const SANDBOX_PARENT = ownedFixtureTempRoot()
function admitSandboxDirectory(directory) {
  if (process.platform !== 'win32') return directory
  const normalized = path.win32.resolve(directory)
  const parent = SANDBOX_PARENT.toLowerCase()
  assert.ok(normalized.toLowerCase() === parent || normalized.toLowerCase().startsWith(parent + '\\'),
    'test scratch must be inside the validated owner temp before any path inspection')
  let cursor = path.win32.parse(normalized).root
  for (const segment of path.win32.relative(cursor, normalized).split('\\')) {
    cursor = path.win32.join(cursor, segment)
    const entry = lstatSync(cursor)
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'test scratch parents must be ordinary directories')
  }
  const finalPath = path.win32.normalize(realpathSync.native(normalized)).replace(/^\\\\\?\\/, '')
  assert.equal(finalPath.toLowerCase(), normalized.toLowerCase(), 'test scratch must not resolve through a path alias')
  return normalized
}
admitSandboxDirectory(SANDBOX_PARENT)
const SANDBOX = admitSandboxDirectory(mkdtempSync(path.join(SANDBOX_PARENT, 'mc-setup-profile-')))
const inSandbox = (...parts) => path.join(SANDBOX, ...parts)
const SERVICES_ROOT = inSandbox('services-root')
const INSTALL_ROOT = inSandbox('install-root')
const NODE_PATH = inSandbox('install-root', 'node.exe')
const DEFAULT_WORKSPACE = inSandbox('home', 'Documents', 'AI Workspace')
const WORK = inSandbox('work')
const REFUSED_ROOT = inSandbox('refused')

after(() => {
  admitSandboxDirectory(SANDBOX)
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10 })
})

function baseRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    tier: 'standard',
    machine: { id: 'test-machine', label: 'Test machine' },
    installRoot: INSTALL_ROOT,
    servicesRoot: SERVICES_ROOT,
    nodePath: NODE_PATH,
    workspaceRoots: [DEFAULT_WORKSPACE],
    loopbackHost: '127.0.0.1',
    shellPortRange: { first: 4601, last: 4609 },
    bridgePortRange: { first: 4610, last: 4619 },
    createdAtMs: 1,
    ...overrides,
  }
}

function fakeModules({ record = baseRecord(), readThrows = null, refuse = () => null, provisionThrows = false } = {}) {
  const calls = { provisioned: [], written: [], configured: [] }
  return {
    calls,
    modules: {
      ok: true,
      machineRecord: {
        TIERS: ['guided', 'standard', 'unrestricted'],
        resolveServicesRoot: () => SERVICES_ROOT,
        readMachineRecord: () => { if (readThrows) throw readThrows; return record },
        buildMachineRecord: input => ({ ...baseRecord(), ...input, machine: { id: input.machineId, label: input.machineLabel } }),
        writeMachineRecord: written => { calls.written.push(written); return 'written' },
        writeMcpConfig: (record, { targetDirectory }) => {
          calls.configured.push(targetDirectory)
          writeFileSync(path.join(targetDirectory, '.mcp.json'), '{"mcpServers":{}}\n')
          return { document: { mcpServers: { 'toolsenabled-readonly': {} } } }
        },
      },
      workspace: {
        defaultWorkspacePath: () => DEFAULT_WORKSPACE,
        checkWorkspaceCandidate: candidate => {
          const refusal = refuse(candidate)
          return refusal || { ok: true, resolved: candidate }
        },
        provisionWorkspace: candidate => {
          if (provisionThrows) throw Object.assign(new Error('no'), { code: 'SETUP_WORKSPACE_UNAVAILABLE' })
          calls.provisioned.push(candidate)
          mkdirSync(candidate, { recursive: true })
          return { workspace: candidate, created: true, undoAvailable: true }
        },
      },
    },
  }
}

test('the folder question refuses to answer before the permission level does', () => {
  const { modules, calls } = fakeModules({ record: null })
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_TIER_NOT_RECORDED')
  assert.equal(calls.written.length, 0, 'a record was written with no permission level in it')
  assert.equal(calls.provisioned.length, 0)
})

/* A list whose third entry is refused must not leave two new folders on
   someone's disk and no record to show for them. */
test('every folder is checked before any folder is created', () => {
  const { modules, calls } = fakeModules({
    refuse: candidate => (candidate === 'C:\\Windows'
      ? { ok: false, code: 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED', message: 'That is the top of a whole drive.', resolved: candidate }
      : null),
  })
  const result = SETUP_RECORD.recordWorkspaces(['C:\\Fine', 'C:\\AlsoFine', 'C:\\Windows'], { modules })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED')
  assert.equal(calls.provisioned.length, 0, 'folders were created before the whole list was known to be allowed')
  assert.equal(calls.written.length, 0)
})

test('recording a folder keeps every other thing the record already said', () => {
  const { modules, calls } = fakeModules({ record: baseRecord({ tier: 'unrestricted', createdAtMs: 12345 }) })
  const result = SETUP_RECORD.recordWorkspaces([WORK, WORK], { modules })
  assert.equal(result.ok, true)
  assert.deepEqual(result.roots, [WORK], 'a repeated folder was recorded twice')
  const written = calls.written[0]
  assert.equal(written.tier, 'unrestricted', 'recording a folder moved the permission level')
  assert.equal(written.createdAtMs, 12345)
  assert.equal(written.nodePath, NODE_PATH)
  assert.deepEqual(written.workspaceRoots, [WORK])
  /* The one added field, and what it is for: a folder the person was shown and
     chose is a different fact from the default nobody was asked about. */
  assert.equal(written.workspaceChosen, true)
})

test('a folder that cannot be prepared is reported, not half-recorded', () => {
  const { modules, calls } = fakeModules({ provisionThrows: true })
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.equal(result.ok, false)
  assert.equal(calls.written.length, 0, 'a folder that could not be created was recorded anyway')
})

test('an empty or oversized list of folders is refused', () => {
  const { modules } = fakeModules()
  assert.equal(SETUP_RECORD.recordWorkspaces([], { modules }).code, 'SETUP_WORKSPACE_MISSING')
  const many = Array.from({ length: SETUP_RECORD.MAX_WORKSPACE_ROOTS + 1 }, (_, index) => inSandbox(`work-${index}`))
  assert.equal(SETUP_RECORD.recordWorkspaces(many, { modules }).code, 'SETUP_WORKSPACE_TOO_MANY')
})

/* The check applies the inside-the-installation refusal that `unrestricted`
   waives. Defaulting to the permissive level because a file could not be read
   would waive a refusal for the worst possible reason. */
test('an unreadable record makes the folder check stricter, not looser', () => {
  const seen = []
  const { modules } = fakeModules({ readThrows: Object.assign(new Error('malformed'), { code: 'SETUP_MACHINE_RECORD_MALFORMED' }) })
  modules.workspace.checkWorkspaceCandidate = (candidate, options) => {
    seen.push(options.tier)
    return { ok: true, resolved: candidate }
  }
  SETUP_RECORD.checkWorkspace(WORK, { modules, repoRoot: INSTALL_ROOT })
  assert.deepEqual(seen, ['guided'])
})

test('the folder state distinguishes chosen from never asked', () => {
  const asked = SETUP_RECORD.readWorkspaceState({ modules: fakeModules({ record: baseRecord({ workspaceChosen: true }) }).modules })
  assert.equal(asked.chosen, true)
  const never = SETUP_RECORD.readWorkspaceState({ modules: fakeModules().modules })
  assert.equal(never.chosen, false, 'a folder nobody was asked about is reported as one they chose')
  assert.equal(never.tier, 'standard')
})

test('a copy with no setup code says so instead of pretending', () => {
  const absent = { ok: false, code: 'SETUP_PAYLOAD_ABSENT', reason: 'no payload' }
  const state = SETUP_RECORD.readWorkspaceState({ modules: absent })
  assert.equal(state.available, false)
  assert.equal(state.code, 'SETUP_PAYLOAD_ABSENT')
  assert.deepEqual(state.roots, [])
  assert.equal(SETUP_RECORD.checkWorkspace(WORK, { modules: absent }).ok, false)
  assert.equal(SETUP_RECORD.recordWorkspaces([WORK], { modules: absent }).ok, false)
})

/* ---------- the assistant configuration follows the folder ----------
 *
 * FOUND IN A REAL PACKAGED BUILD, not deduced. `recordTier` generates
 * `.mcp.json` into `workspaceRoots[0]`, which during first run is the folder
 * setup picked by itself -- so answering only the permission question created
 * `<profile>\Documents\AI Workspace` AND configured an assistant inside it,
 * before anyone had been asked which folder they wanted. Answering the folder
 * question then moved the record and left that document behind, describing a
 * workspace the person had just declined.
 */

test('choosing a folder configures the assistant in THAT folder', () => {
  const { modules, calls } = fakeModules()
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.configured, [WORK], 'the assistant was configured somewhere other than the folder the person chose')
  assert.equal(result.assistantConfig.ok, true)
  assert.ok(existsSync(path.join(WORK, '.mcp.json')))
})

test('choosing another folder preserves the unchosen default configuration byte for byte', () => {
  mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  writeFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), '{"mcpServers":{"stale":{}}}\n')
  writeFileSync(path.join(DEFAULT_WORKSPACE, 'a-note-from-the-user.txt'), 'mine\n')

  const { modules } = fakeModules({ record: baseRecord({ workspaceRoots: [DEFAULT_WORKSPACE] }) })
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.equal(result.ok, true)
  assert.deepEqual(result.releasedRoots, [])
  assert.equal(readFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), 'utf8'), '{"mcpServers":{"stale":{}}}\n',
    'a suggested path does not prove this installation owns the existing configuration')
  /* The unselected document, folder and anything in it belong to the person. */
  assert.equal(existsSync(DEFAULT_WORKSPACE), true, 'the folder itself was deleted')
  assert.equal(existsSync(path.join(DEFAULT_WORKSPACE, 'a-note-from-the-user.txt')), true, 'something the person put in that folder was deleted')
})

/* Choosing another folder does not authorize changing a previously chosen one. */
test('a folder the person actually chose is never stripped', () => {
  mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  writeFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), '{"mcpServers":{}}\n')
  const { modules } = fakeModules({ record: baseRecord({ workspaceRoots: [DEFAULT_WORKSPACE], workspaceChosen: true }) })
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.deepEqual(result.releasedRoots, [], 'changing to a second folder was treated as consent to strip the first')
  assert.equal(existsSync(path.join(DEFAULT_WORKSPACE, '.mcp.json')), true)
})

/* An unselected folder is preserved regardless of how its path was recorded. */
test('an earlier typed folder is also left unchanged when choosing another', () => {
  const typed = inSandbox('typed-by-hand')
  mkdirSync(typed, { recursive: true })
  writeFileSync(path.join(typed, '.mcp.json'), '{"mcpServers":{}}\n')
  const { modules } = fakeModules({ record: baseRecord({ workspaceRoots: [typed] }) })
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules })
  assert.deepEqual(result.releasedRoots, [])
  assert.equal(existsSync(path.join(typed, '.mcp.json')), true)
})

test('keeping the same folder does not release it', () => {
  mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  writeFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), '{"mcpServers":{}}\n')
  const { modules } = fakeModules({ record: baseRecord({ workspaceRoots: [DEFAULT_WORKSPACE] }) })
  const result = SETUP_RECORD.recordWorkspaces([DEFAULT_WORKSPACE], { modules })
  assert.deepEqual(result.releasedRoots, [])
  assert.equal(existsSync(path.join(DEFAULT_WORKSPACE, '.mcp.json')), true, 'confirming the suggested folder removed its own configuration')
})

/* ---------- the Documents folder is the known-folder answer, not a guess ---------- */

/* OneDrive's "Back up your folders" moves the real Documents known folder to
   `%USERPROFILE%\OneDrive\Documents`; the engine module can only guess
   `%USERPROFILE%\Documents`. The shell asks Electron and passes the answer in
   at EVERY defaultWorkspacePath call site, so the suggested card, the recorded
   default and the Browse dialog (main.cjs, app.getPath('documents')) name the
   same folder. `options.documentsDir` is the test seam for the same value. */
test('the suggested folder derivation is handed the real Documents location', () => {
  const oneDrive = inSandbox('home', 'OneDrive', 'Documentos')
  const seen = []
  const { modules } = fakeModules()
  modules.workspace.defaultWorkspacePath = (options = {}) => {
    seen.push(options.documentsDir)
    return options.documentsDir ? path.join(options.documentsDir, 'AI Workspace') : DEFAULT_WORKSPACE
  }
  const state = SETUP_RECORD.readWorkspaceState({ modules, documentsDir: oneDrive })
  assert.equal(state.suggested, path.join(oneDrive, 'AI Workspace'),
    'the suggestion follows the known folder, not the %USERPROFILE% guess')
  assert.deepEqual(seen, [oneDrive], 'the known-folder answer reached the engine derivation')
})

/* A known-folder redirect is still a suggestion, not file ownership. */
test('the previously guessed default is preserved on a redirected machine', () => {
  const oneDrive = inSandbox('home', 'OneDrive', 'Documentos')
  mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  writeFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), '{"mcpServers":{}}\n')
  const { modules } = fakeModules({ record: baseRecord({ workspaceRoots: [DEFAULT_WORKSPACE] }) })
  modules.workspace.defaultWorkspacePath = (options = {}) =>
    (options.documentsDir ? path.join(options.documentsDir, 'AI Workspace') : DEFAULT_WORKSPACE)
  const result = SETUP_RECORD.recordWorkspaces([WORK], { modules, documentsDir: oneDrive })
  assert.deepEqual(result.releasedRoots, [])
  assert.equal(readFileSync(path.join(DEFAULT_WORKSPACE, '.mcp.json'), 'utf8'), '{"mcpServers":{}}\n',
    'redirected Documents does not authorize changing the earlier unselected folder')
  assert.equal(existsSync(DEFAULT_WORKSPACE), true)
})

/* shell/setup-record.cjs states that the workspace is the ONE path allowed to
   cross to the renderer. This checks the other half of that sentence. */
test('no reply carries an internal path to the renderer', () => {
  const { modules } = fakeModules()
  const replies = [
    SETUP_RECORD.readWorkspaceState({ modules }),
    SETUP_RECORD.checkWorkspace(WORK, { modules }),
    SETUP_RECORD.recordWorkspaces([WORK], { modules }),
    SETUP_RECORD.readWorkspaceState({ modules: { ok: false, code: 'SETUP_MODULES_ABSENT', reason: `cannot find ${INSTALL_ROOT}\\thing` } }),
  ]
  for (const reply of replies) {
    const serialized = JSON.stringify(reply)
    assert.ok(!serialized.includes(SERVICES_ROOT.replace(/\\/g, '\\\\')), `a reply named the services root: ${serialized}`)
    assert.ok(!serialized.includes(NODE_PATH.replace(/\\/g, '\\\\')), `a reply named the runtime: ${serialized}`)
  }
})

/* ---------- the channels exist and are guarded ---------- */

test('every new setup channel is behind the same sender check as the level', () => {
  for (const channel of ['mc-setup:workspace-state', 'mc-setup:check-workspace', 'mc-setup:record-workspaces', 'mc-setup:choose-workspace']) {
    const at = SHELL.indexOf(`ipcMain.handle('${channel}'`)
    assert.notEqual(at, -1, `shell/main.cjs does not register ${channel}`)
    const registration = SHELL.slice(at, SHELL.indexOf('\n}))', at) + 4)
    assert.match(registration, /withFleetProfileSender/, `${channel} accepts a request from any frame`)
  }
  /* A folder write is the most consequential thing this window can do to a
     disk, so it must be an invoke and never a sendSync convenience. */
  assert.ok(!SHELL.includes("ipcMain.on('mc-setup:record-workspaces'"), 'the folder write became a synchronous channel')
  for (const method of ['workspaceState', 'checkWorkspace', 'chooseWorkspace', 'recordWorkspaces']) {
    assert.match(PRELOAD, new RegExp(`${method}:`), `the preload does not expose ${method}, so the control cannot work on an installed copy`)
  }
})

test('the model and the flag lists cannot drift apart', () => {
  for (const field of PROFILE_INTENT) {
    assert.equal(intentField(field.id), field)
    assert.ok(field.order.length >= 2, `${field.id} is not a choice`)
    for (const value of field.order) {
      assert.equal(typeof field.labels[value], 'string', `${field.id} has no label for ${value}`)
    }
    /* Ordered safest first: the ceiling is a maximum INDEX into this list, so an
       order written the other way round would silently invert every clamp. */
    const guided = TIER_CEILINGS.guided.intent[field.id]
    assert.equal(field.order.indexOf(guided), 0, `${field.id} does not put its safest option first`)
  }
})

test('a walkthrough nobody answered is never described as an answer somebody gave', () => {
  /* Skip writes the Basic defaults; the completed record below preserves an
     explicit saved Observe choice. Reading answers alone must not infer
     "they chose to look around first" from
     "they pressed the button that ended setup". It used to report both as
     Setup recorded "Nothing yet - let me look around first", on the agent page
     and the fleet start panel, to a person who recorded nothing.

     setup-profile-settings.js reads status on this same record and says "Setup
     was skipped". One record, two live surfaces, two descriptions, one false. */
  const skipped = fakeStorage(JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION, status: 'skipped', answers: SAFE_ANSWERS,
  }))
  const answered = fakeStorage(JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION, status: 'complete', answers: answersForAutonomy('observe'),
  }))

  const skippedSentence = startControlOffBecause(skipped)
  const answeredSentence = startControlOffBecause(answered)

  assert.notEqual(skippedSentence, answeredSentence,
    'a skipped Basic default and an explicitly saved Observe choice must stay distinct')
  assert.doesNotMatch(skippedSentence, /Setup recorded/,
    'a skipped walkthrough recorded nothing, so it may not be quoted as an answer')
  assert.match(skippedSentence, /skipped/,
    'and it should say what actually happened, in the words Settings already uses')

  /* IN-PROGRESS IS THE SAME MISTAKE. Somebody who closed setup halfway also
     never gave an autonomy answer. */
  const halfway = fakeStorage(JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION, status: 'in-progress', answers: SAFE_ANSWERS,
  }))
  assert.doesNotMatch(startControlOffBecause(halfway), /Setup recorded/,
    'an unfinished walkthrough recorded no answer either')

  /* AND A REAL ANSWER MUST STILL BE QUOTED. Fixing the false attribution must
     not silence the true one, which is the more useful sentence of the two. */
  assert.match(answeredSentence, /Setup recorded/,
    'a completed walkthrough did record an answer and should still say so')
})

test('replacing the working folder says which folders it dropped', () => {
  /* THE ROW IS TITLED "Working folders", PLURAL, AND LISTS ALL OF THEM.
   *
   * chooseFolder calls recordWorkspaces([picked.path]) -- a SINGLE-element array
   * -- so choosing one folder drops every other recorded root. A person with
   * three listed pressed "Choose a different folder…", picked one, and the other
   * two vanished from the list behind a success message that never mentioned
   * them. Their permission had to be reconstructed from memory.
   *
   * The replacement is the intended behaviour. Saying nothing about it was not,
   * and neither was a button label that reads like a swap when it is a wipe.
   */
  const source = readFileSync(
    new URL('../../src/setup-profile-settings.js', import.meta.url), 'utf8')

  assert.match(source, /const replaced = \(workspace/,
    'chooseFolder no longer captures the roots it is about to replace, so it cannot name them')
  assert.match(source, /no longer recorded/,
    'the success message does not say which folders were dropped')
  assert.match(source, /again if you still need/,
    'the message names what was dropped but not what to do about it')

  /* THE BUTTON MUST NOT READ LIKE A SWAP WHEN IT IS A WIPE. */
  assert.match(source, /roots\.length > 1 \? `Replace all \$\{roots\.length\}/,
    'the button says "a different folder" even when pressing it replaces several')

  /* THE CONTROL: with ONE root there is nothing to warn about, and warning
     anyway would make an ordinary swap look destructive. */
  assert.match(source, /replaced\.length\s*\?\s*'Working folder replaced'\s*:\s*'Working folder saved'/,
    'the title no longer distinguishes a replacement from an ordinary save, so a single-folder swap is '
    + 'reported as though something was lost')
})

/* T1583: THE "IF AN ACCOUNT RUNS OUT" ROW SAYS WHAT ITS TWO ANSWERS DO. Its
   description was a disclosure about the Account step, so the row that decides
   whether agents move between provider accounts explained nothing about that. */
test('the account switching row explains both of its answers instead of the Account step', async () => {
  const { PROFILE_INTENT } = await import('../../src/setup-profile.js')
  const row = PROFILE_INTENT.find(field => field.id === 'failover')
  assert.match(row.desc, /reaches its limit/)
  assert.match(row.desc, new RegExp(`${row.labels.manual}: the agent stops, and you pick the next account in the Accounts menu on Computers`))
  assert.match(row.desc, new RegExp(`${row.labels.auto}: the agent carries on with another signed-in account`))
  assert.doesNotMatch(row.desc, /The account setup asks for is an account on this computer/, 'the row still explains the Account step')
})

/* T1553: THE ROW IS NAMED FOR ITS QUESTION. It was headed "Acting on its own"
   above a lit "Act when I start it", which reads as the opposite answer. The
   row now carries the question's own words, on Review and in Settings, and the
   guidance that sends people to it names the renamed row. */
test('the autonomy row is named for its question, not for one of its answers', () => {
  const rendered = createSetupProfileSettings().markup()
  assert.ok(rendered.includes('How much it does without asking'), 'the Setup section lost its autonomy row')
  assert.doesNotMatch(rendered, /Acting on its own/, 'the Setup section still heads the row with one of its answers')
  const VIEW_SOURCE = read('src/views/setup.js')
  assert.doesNotMatch(VIEW_SOURCE, /'Acting on its own'|aria-label="Acting on its own"/, 'the Review row still carries the old heading')
  const guidance = read('src/permission-guidance.js')
  assert.doesNotMatch(guidance, /Setup → Acting on its own/, 'guidance still sends people to a row that is not there')
  assert.match(guidance, /Settings → Setup → How much it does without asking/)
})
