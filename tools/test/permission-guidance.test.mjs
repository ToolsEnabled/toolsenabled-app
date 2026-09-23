/* THE GUIDED-STEP MECHANISM (owner, R1529).
 *
 * Ordered ABSENCE FIRST, deliberately. This codebase's recurring defect is
 * absence read as consent -- a missing key that meant enabled, a skipped
 * walkthrough that switched something on, an empty result that looked like a
 * clean answer. So the first thing asserted about a mechanism whose whole job is
 * to explain a setting is what it does when there is no explanation, and the
 * required answer is "says so", never "says nothing" and never "says harmless".
 *
 * The declarations are read as EXPORTED VALUES, not as a regex over the source.
 * A sentence assembled from two halves, or moved from one field to another, is
 * still seen this way -- which is the lesson tools/test/setup-profile.test.mjs
 * already paid for once.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ANSWER_SUBJECTS,
  CAPABILITY_STATES,
  EXTERNAL_CAPABILITIES,
  RISK_PROFILES,
  SECTION_RISK_PROFILE,
  SUBJECTS,
  capabilityState,
  describeSubject,
  explainWithheld,
  externalCapability,
  guidedStepFor,
  unexplainedSettingIds,
  validateGuidance,
} from '../../src/permission-guidance.js'
import { WRITE_ACTION_FLAGS } from '../../src/write-flags.js'
import { AUTONOMY_VALUES } from '../../src/setup-profile.js'
import { guidanceMarkup } from '../../src/guided-step.js'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { resolveDataSource } from '../../src/data-source.js'
import {
  CONNECT_SECTION,
  CONNECT_SETTING_ID,
  createConnectComputerSettings,
} from '../../src/connect-computer-settings.js'
import {
  UPDATE_SECTION,
  UPDATE_SETTING_ID,
  createUpdateSettings,
} from '../../src/update-settings.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('desk guidance keeps its local subject and gives relay readers the driven-computer twin', async () => {
  const localAudited = EXTERNAL_CAPABILITIES['audited-connection'].whatItDoes
  const localRetention = SUBJECTS.uninstall_data.risks[0]
  assert.match(localAudited, /It runs on this computer and is not reachable from anywhere else\./,
    'mutating the audited-connection desk sentence must not silently replace its local voice')
  assert.match(localRetention, /stay on this computer.*using this computer/,
    'mutating the retention desk sentence must not silently replace its local voice')

  setBridgeTransport(async () => ({ ok: false }))
  await resolveDataSource()
  const auditedRelay = guidanceMarkup('write_dispatch', { probe: () => false })
  const retentionRelay = guidanceMarkup('uninstall_data')
  assert.match(auditedRelay, /It runs on that computer and is not reachable from anywhere else\./,
    'mutating the audited-connection remote twin back to the desk sentence must make the relay reading fail')
  assert.doesNotMatch(auditedRelay, /It runs on this computer and is not reachable from anywhere else\./)
  assert.match(retentionRelay, /stay on the computer you are driving.*using that computer/,
    'mutating the retention remote twin back to the desk sentence must make the relay reading fail')
  assert.doesNotMatch(retentionRelay, /stay on this computer.*using this computer/)
})

/* THE SETTINGS CATALOGUE IS READ AS SOURCE, NOT IMPORTED, and that is the house
 * pattern rather than a shortcut: src/views/settings.js imports four
 * stylesheets, which `node --test` cannot load, so tools/test/chatbox-feed and
 * tools/test/ledger-archive-ui read the same file the same way.
 *
 * The extractor tolerates the multi-line literals (uninstall_data is written
 * across six lines) and the one GENERATED family left -- the write-action rows
 * are spread from their own register, which IS importable, so they are added
 * from the real list rather than parsed out of a template string. (The
 * live-view family this used to add is gone: the seven per-view rows became
 * the one literal `example_mode` row, which the regex walk sees directly.)
 * Under-counting here would silently narrow the coverage test below into one
 * that proves nothing, which is why it asserts a floor. */
function settingsCatalogue() {
  const source = read('src/views/settings.js')
  const declaration = source.indexOf('export const SETTINGS = [')
  assert.notEqual(declaration, -1, 'the settings catalogue declaration was not found')
  const openingBracket = source.indexOf('[', declaration)
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  let closingBracket = -1
  for (let index = openingBracket; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1 }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (character === '[') depth += 1
    if (character === ']') {
      depth -= 1
      if (depth === 0) { closingBracket = index; break }
    }
  }
  assert.notEqual(closingBracket, -1, 'the settings catalogue array is not closed')
  const body = source.slice(declaration, closingBracket + 1)
  const rows = []
  for (const match of body.matchAll(/id: '([a-z0-9_]+)'/g)) {
    const after = body.slice(match.index, match.index + 400)
    const section = after.match(/section: '([^']+)'/)
    if (section) rows.push({ id: match[1], section: section[1] })
  }
  const writeSection = body.match(/\.\.\.WRITE_ACTION_FLAGS\.map\([\s\S]*?section: '([^']+)'/)
  assert.ok(writeSection, 'the generated write-action section was not found')
  for (const flag of WRITE_ACTION_FLAGS) rows.push({ id: `write_${flag.id}`, section: writeSection[1] })
  /* These controls are section controllers rather than catalogue entries, but
     they are still settings-page rows and owe the same disclosure. */
  rows.push(
    { id: CONNECT_SETTING_ID, section: CONNECT_SECTION },
    { id: UPDATE_SETTING_ID, section: UPDATE_SECTION },
  )
  return rows
}

/* ---------- 1. ABSENCE ---------- */

test('an id nothing has been written about degrades honestly, and never to "harmless"', () => {
  for (const missing of ['no_such_setting', 'write_invented', '', '   ', null, undefined, 42, {}]) {
    const guidance = describeSubject(missing)
    assert.equal(guidance.declared, false, `${String(missing)} was treated as declared`)
    assert.deepEqual(guidance.capabilities, [], 'an undeclared subject must not come back with invented capabilities')
    assert.deepEqual(guidance.risks, [], 'an undeclared subject must not come back with invented risks')
    assert.ok(guidance.absenceNote.length > 40, 'an undeclared subject must say that nobody has written it down')
    assert.match(guidance.absenceNote, /unknown/i, 'the absence must read as unknown, not as nothing')
  }
})

test('an unknown section falls through to the honest absence, not to a soothing default', () => {
  const guidance = describeSubject('some_row', { section: 'A Section That Does Not Exist' })
  assert.equal(guidance.declared, false)
  assert.equal(guidance.risks.length, 0)
})

test('an undeclared WRITE flag never inherits a family statement', () => {
  /* The families exist so ninety cosmetic rows are not reworded ninety times.
     A write flag is not cosmetic: if one is ever added without a statement, it
     has to be visible as unexplained rather than quietly described as a
     harmless appearance control because it happened to sit in some section. */
  const guidance = describeSubject('write_something_new', { section: 'Appearance' })
  assert.equal(guidance.declared, false)
  assert.equal(guidance.risks.length, 0)
})

test('a subject that depends on nothing outside gets null, not an empty walkthrough', () => {
  assert.equal(guidedStepFor('theme'), null)
  assert.equal(guidedStepFor('uninstall_data'), null)
  assert.equal(guidedStepFor('no_such_setting'), null)
  assert.equal(guidedStepFor(null), null)
  assert.equal(externalCapability('no-such-capability'), null)
  assert.equal(externalCapability(undefined), null)
})

test('a probe that cannot answer reports UNKNOWN, and never rounds to either side', () => {
  assert.deepEqual([...CAPABILITY_STATES].sort(), ['available', 'missing', 'unknown'])
  assert.equal(capabilityState(true), 'available')
  assert.equal(capabilityState(false), 'missing')
  for (const unanswerable of [undefined, null, 0, 1, '', 'true', NaN, {}]) {
    assert.equal(capabilityState(unanswerable), 'unknown', `${String(unanswerable)} was rounded to a verdict`)
  }

  // No probe at all is the same as one that could not answer.
  const none = guidedStepFor('write_dispatch')
  assert.equal(none.state, 'unknown')
  assert.match(none.headline, /could not check/)
  assert.equal(none.showSteps, true, 'an unknown state still shows what the step would be')

  // A probe that throws is a probe that could not answer, not a crash.
  const thrown = guidedStepFor('write_dispatch', { probe: () => { throw new Error('bridge is gone') } })
  assert.equal(thrown.state, 'unknown')

  assert.equal(guidedStepFor('write_dispatch', { probe: () => true }).state, 'available')
  assert.equal(guidedStepFor('write_dispatch', { probe: () => false }).state, 'missing')
})

test('local agent-session guidance is provider-neutral and has no provider prerequisite', () => {
  const guidance = describeSubject('write_agent-session')
  let probeCalls = 0
  assert.equal(guidance.externalCapability, null)
  assert.equal(guidedStepFor('write_agent-session', {
    probe: () => { probeCalls += 1; return false },
  }), null)
  assert.equal(probeCalls, 0, 'provider-neutral guidance still probed the Codex-only prerequisite')
  assert.doesNotMatch(JSON.stringify(guidance), /Codex|Claude|Gemini/i)
})

test('a withheld state with no declaration still answers what it can, and admits the rest', () => {
  const withheld = explainWithheld('write_invented', { label: 'Something new' })
  assert.equal(withheld.declared, false)
  assert.match(withheld.what, /Something new is switched off/)
  assert.ok(withheld.absenceNote.length > 40)
  assert.ok(withheld.optional.length > 20, 'even an undeclared refusal must say that leaving it off is allowed')
  assert.deepEqual(withheld.risks, [])
})

/* ---------- 2. RESTRICTION IS REAL ---------- */

test('nothing in the guidance module can turn anything on', () => {
  /* The mechanism explains switches. If it could move one, an explanation
     surface would be a permission surface, and reading about a setting could
     change it. Asserted over the source because it is a statement about what
     the file may CONTAIN, not about what one call returns. `setExampleMode`
     took `setLiveView`'s place in this list when the one example toggle
     replaced the seven per-view flags: the writer changed, the doctrine did
     not. */
  const source = read('src/permission-guidance.js') + read('src/guided-step.js')
  for (const writer of ['setWriteEnabled', 'setExampleMode', 'localStorage', 'sessionStorage', 'writeStoredProfile']) {
    assert.doesNotMatch(source, new RegExp(`\\b${writer}\\b`), `the guidance modules reference ${writer}`)
  }
})

test('no declaration anywhere may call itself required', () => {
  const result = validateGuidance()
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)

  for (const id of [...Object.keys(SUBJECTS), ...Object.keys(ANSWER_SUBJECTS)]) {
    assert.equal(describeSubject(id).required, false, `${id} is not offered as optional`)
  }
  for (const capability of Object.values(EXTERNAL_CAPABILITIES)) {
    assert.equal(capability.required, false, `${capability.id} makes an outside step required`)
    assert.equal(capability.neverPerformedForYou, true, `${capability.id} does not promise we never perform it`)
  }
})

test('every outside step says what still works without it, and how you would know it worked', () => {
  for (const capability of Object.values(EXTERNAL_CAPABILITIES)) {
    assert.ok(capability.withoutIt.length > 60, `${capability.id}: the partial-function sentence is too short to be honest`)
    /* The honest partial function is a SPECIFIC claim: the setting is on and
       saved, and the thing that needs the outside step reports it. A sentence
       that only says "it might not work" is the vaguer refusal this lane is
       forbidden to write. */
    assert.match(capability.withoutIt, /stays on|still works|keeps working|is already on/i,
      `${capability.id}: does not say the setting stays on without the step`)
    assert.ok(capability.verify.length > 20, `${capability.id}: does not say how you would know it worked`)
    assert.ok(capability.steps.length > 0)
    for (const step of capability.steps) assert.ok(step.do.trim().length > 10)
  }
})

/* ---------- 3. COVERAGE: EVERY SETTING, NOT ONLY THE INTERESTING ONES ---------- */

test('every settings-page row states what it grants and what it risks', () => {
  /* Owner, R1529 gate 8: "we also give them the capabilities and risks granted
     from each setting of ours". Not the write flags. Each. */
  const catalogue = settingsCatalogue()
  assert.deepEqual(unexplainedSettingIds(catalogue), [])
  /* THE FLOOR WAS 22 UNTIL THE ONE-TOGGLE CHANGE AND IS NOW 15, WHICH IS THE
     WHOLE CATALOGUE, NOT A LOWERED BAR. It exists to catch the extraction
     silently returning nothing, so it has to track the real count: the seven
     live-view rows collapsed into the one `example_mode` row and the
     demonstration-speed slider died with the simulation engine, leaving 8
     declared rows plus 7 write-action flags, and 9 declared rows since the
     cloud mirror setup row was added 2026-08-24. Pinning it AT the total rather
     than below it means this fails on the next removal too, which is correct
     -- a floor that drifts under the truth is how "the extraction broke"
     stops being detectable. */
  /* 16 UNTIL 2026-08-27, AND 19 SINCE. THREE SURFACES LANDED TOGETHER AND EACH
     ARRIVED WITH ITS OWN ARITHMETIC, so this merge had to re-derive rather than
     pick one. The notification lane counted 9 declared rows + 7 write-action
     flags + its 2 rows = 18. The compare-window lane counted a tenth declared
     row + the same 7 = 17. Both were right about their own branch and neither
     is right about the tree that holds both. Twelve declared rows -- the nine,
     plus the two notification rows, plus `compare_files` -- and the same seven
     write-action flags is NINETEEN.
     Pinned AT the total rather than below it, for the reason given above: a
     floor that drifts under the truth is how "the extraction broke" stops being
     detectable. The connect and update controllers add two custom control rows,
     bringing the page-wide contract to twenty-one. */
  // The merged tree adds tree style, circle cards, Home style and Home motion.
  // T254 (6cd8427a, 2026-09-17) added the vault_credentials row and its
  // settings.js entry without updating this floor or writing its SUBJECTS
  // statement -- the second half of the gap this comment's own rule exists to
  // catch. Pinned AT 26 for the same reason as every count above it.
  assert.equal(catalogue.length, 26, `${catalogue.length} rows were walked, not the 26 this page declares; either the extraction broke or a row arrived without a statement`)

  let checked = 0
  for (const setting of catalogue) {
    const guidance = describeSubject(setting.id, { section: setting.section })
    checked += 1
    assert.equal(guidance.declared, true, `${setting.id} has no statement`)
    assert.ok(guidance.capabilities.length > 0, `${setting.id} states no capabilities`)
    assert.ok(guidance.risks.length > 0, `${setting.id} states no risks`)
  }
  assert.equal(checked, catalogue.length)
})

test('custom settings controls render the same declared capabilities-and-risks disclosure', () => {
  const connect = createConnectComputerSettings({
    resolveBridge: () => null,
    readingOverRelay: () => false,
  })
  const update = createUpdateSettings({ readPolicy: () => 'ask', writePolicy: () => {} })
  try {
    for (const [id, markup] of [
      [CONNECT_SETTING_ID, connect.markup()],
      [UPDATE_SETTING_ID, update.markup()],
    ]) {
      assert.match(markup, new RegExp(`data-guided-for="${id}"`), `${id} has no disclosure`)
      assert.match(markup, new RegExp(`data-guided-for="${id}"[^>]*data-guided-declared="true"`), `${id} is undeclared`)
      assert.match(markup, /What it lets happen/)
      assert.match(markup, /What it risks/)
    }
  } finally {
    connect.destroy()
    update.destroy()
  }
})

test('every write flag and the example toggle have their own statement', () => {
  for (const flag of WRITE_ACTION_FLAGS) {
    const guidance = describeSubject(`write_${flag.id}`)
    assert.equal(guidance.declared, true, `write flag ${flag.id} has no statement`)
    assert.ok(guidance.turnOnAt.includes('Settings'), `write flag ${flag.id} does not say where its switch is`)
    assert.ok(guidance.capabilities.length > 0 && guidance.risks.length > 0, flag.id)
  }
  /* The one row that decides what every screen shows. It replaced the seven
     shared live_<view> declarations, so it must carry its OWN statement --
     there is no family left for it to fall through to. */
  const example = describeSubject('example_mode')
  assert.equal(example.declared, true, 'the example toggle has no statement')
  assert.ok(example.turnOnAt.includes('Settings'), 'the example toggle does not say where its switch is')
  assert.ok(example.capabilities.length > 0 && example.risks.length > 0, 'example_mode')
  for (const value of AUTONOMY_VALUES) {
    const guidance = describeSubject(value)
    assert.equal(guidance.declared, true, `setup answer ${value} has no statement`)
    assert.ok(guidance.capabilities.length > 0 && guidance.risks.length > 0, value)
  }
})

test('every section named by the settings page resolves to a statement', () => {
  const catalogue = settingsCatalogue()
  const sections = new Set(catalogue.map(setting => setting.section))
  /* Was 10; the six sections that were inert top to bottom are gone, leaving
     the five that carry rows in SETTINGS -- Data & Privacy, Appearance, Text &
     Reading, Motion & Effects, Ledger, Data & Sim and Write. Pinned exactly,
     for the reason given at the row floor above. */
  /* 7 UNTIL 2026-08-27; 'Notifications' is the eighth. It is deliberately NOT
     in SECTION_RISK_PROFILE below: its two rows carry their own declarations,
     so a family statement over it would never be consulted -- the same reason
     'Ledger' and the example row's section are absent from that table. The
     custom Connect and System rows bring the represented sections to ten. */
  assert.equal(sections.size, 10, `${sections.size} sections were found, not the 10 this catalogue declares; re-derive this, do not nudge it`)
  for (const section of sections) {
    const covered = catalogue
      .filter(setting => setting.section === section)
      .every(setting => describeSubject(setting.id, { section }).declared)
    assert.ok(covered, `section ${section} has rows with nothing written about them`)
  }
  for (const profileId of Object.values(SECTION_RISK_PROFILE)) {
    assert.ok(RISK_PROFILES[profileId], `${profileId} is named by a section and does not exist`)
  }
})

/* ---------- 4. THE WORDS THEMSELVES ---------- */

/* Every sentence this lane puts in front of a person, walked as data. */
function everySentenceThisLaneShows() {
  const strings = []
  for (const subject of [...Object.values(SUBJECTS), ...Object.values(ANSWER_SUBJECTS)]) {
    strings.push(subject.whatItDoes, subject.turnOnAt, ...subject.capabilities, ...subject.risks)
  }
  for (const profile of Object.values(RISK_PROFILES)) {
    strings.push(...profile.capabilities, ...profile.risks)
  }
  for (const capability of Object.values(EXTERNAL_CAPABILITIES)) {
    strings.push(capability.name, capability.whatItDoes, capability.verify, capability.withoutIt)
    for (const step of capability.steps) strings.push(step.do, step.why || '')
  }
  strings.push(describeSubject('nothing').absenceNote)
  strings.push(explainWithheld('write_dispatch', { label: 'x' }).optional)
  return strings.filter(value => typeof value === 'string' && value.trim().length >= 10)
}

test('no sentence this lane shows names a mechanism', () => {
  const copy = everySentenceThisLaneShows()
  assert.ok(copy.length >= 90, `only ${copy.length} sentences were found; the extraction broke and this test is checking nothing`)
  /* Same rule and nearly the same pattern as tools/test/setup-profile.test.mjs.
     A person reading a settings row has no idea what this program is made of,
     and an internal name here is a leak rather than a style choice. `codex` and
     `winget` are deliberately absent from this list: they are programs the
     person installs and runs themselves, which is the opposite of an internal
     name -- naming them is the only way the step is followable. */
  const mechanism = /\b(localStorage|sessionStorage|IPC|ipcRenderer|preload|renderer|asar|machine\.json|workspaceRoots|mc\.write|mc\.live|mc\.set|JSON|schema|payload|boolean|null|undefined|serialise|serialize|repository|commit)\b/i
  let checked = 0
  for (const sentence of copy) {
    checked += 1
    assert.doesNotMatch(sentence, mechanism, `a user-facing sentence names a mechanism: "${sentence}"`)
  }
  assert.equal(checked, copy.length)
  assert.ok(checked >= 90, `only ${checked} sentences were examined; this guard is checking air`)
})

/* THE ABSOLUTE CLAIMS, REGISTERED WITH WHAT KEEPS THEM TRUE.
 *
 * Copied in form from tools/test/setup-profile.test.mjs, which learned it the
 * hard way: an absolute sentence is written when it is true and falsified by a
 * lane that never reads it. That test walks the setup view and the setup
 * settings section; the statements in src/permission-guidance.js are rendered
 * through template interpolation, which its source scanner cannot see, so
 * without this registry they would be exactly the unwatched copy its own
 * comment warns about. */
const PINNED_ABSOLUTE_CLAIMS = Object.freeze([
  {
    match: /^None worth the word\. This changes what you see, not what this program is allowed to do/,
    pinnedBy: 'the appearance rows write only their own value and no module reads them to decide what may be done; the settings catalogue test asserts these ids are in the Appearance section, whose rows are the theme, font and spacing controls',
  },
  {
    match: /^None worth the word\. Nothing about what this program may do changes with it\.$/,
    pinnedBy: 'the reading rows change type size and spacing only; no write-action flag and no live-view flag is in the Text & Reading section, which the section coverage test walks',
  },
  {
    match: /^None worth the word\. Turning animation down hides no information/,
    pinnedBy: 'the motion rows change transition timing and the glow custom property; every value they animate is also rendered as text, and reduce-motion is a class on the body rather than a data filter',
  },
  /* THREE PINS WERE REMOVED HERE ON 2026-08-20, and the reason is the point of
     this registry rather than an exception to it.
     They pinned the risk statements of the `layout`, `performance` and
     `developer` families -- "It rearranges what is on screen and adds or removes
     nothing", "None to your files or your privacy", "None to what this program
     may do". Each reason given was a claim about what those ROWS do. Not one of
     those rows was read by anything: they wrote a key nothing consumed. So the
     pins were true sentences about behaviour that did not exist, which is the
     failure mode this file is supposed to catch and could not, because a pin
     justifies a claim and nothing was checking that the claim had a subject.
     The rows, the sections and the three profiles are gone; the pins go with
     them. The wording is kept in docs/design/UNBUILT-SETTINGS-ROWS-2026-08-20.md.
     A profile restored with a built feature brings its pin back. */
  {
    /* TWO PINS BECAME THIS ONE when the seven per-view rows and the
       demonstration profile collapsed into the single example toggle. The old
       reasons said the demonstration rows drove src/sim.js -- a second render
       with its own generated data. That mechanism is gone: the truth now is
       that the example is data fed through the same screens as the person's
       own records, with the source decided in one place. */
    match: /^None to your computer\. The example is invented data/,
    pinnedBy: 'the example toggle selects the mock source in src/data-source.js, and the example is sample data fed through the SAME screens that draw a person’s own records -- there is no second render to leak through; sourceIsBadged() marks the mock source on every surface, and the setup lane pins the companion sentence "None of it is your data and each screen says so"',
  },
  {
    match: /Nothing on this computer will be able to start an assistant while this is the answer/,
    pinnedBy: 'AUTONOMY_WRITE_FLAGS.observe is the empty array so the answer requests no start flag; both the agent-page and Fleet-tree launch handlers check that flag and refuse while it is absent, which the setup lane also pins through autonomyStartsAgents()',
  },
  {
    match: /Nothing runs until you press something, and approving, closing queue items and replying stay off\./,
    pinnedBy: 'the assisted answer requests report-read, agent-session, dispatch and cloud-launch, every one of which is a control a person presses; the setup lane’s recommended-answer test fails if decision, queue or thread-reply are ever switched on by it',
  },
  {
    match: /Turning this on starts nothing by itself\. It enables the Start controls; you still decide what to run\./,
    pinnedBy: 'setWriteEnabled writes one switch and dispatches an event but never calls a launch handler; the agent page replaces its form with the switched-off explanation and the Fleet composer disables Start, and only those surfaces can later launch a session from a person’s press',
  },
  {
    match: /Each launch still asks you for approval first, so nothing starts without a second press\./,
    pinnedBy: 'src/write-flags.js states the same for cloud-launch and src/cloud-tasks-controller.js posts a launch only from the form’s submit handler; pinned by tools/test/cloud-launch-binding.test.mjs',
  },
  {
    match: /This reads a file in your chosen folder and changes nothing\./,
    pinnedBy: 'the report-read action posts to one read-only route in src/mission-bridge.js and its receipt carries the file’s bytes back; there is no write in that path, and the route’s own name is the whole of what it may do',
  },
  {
    match: /Nothing else stops working while it is off, and you can turn it on later/,
    pinnedBy: 'every write-action flag gates only its own surface, and each surface returns a no-op mount when its flag is off; asserted by tools/test/write-flags-fail-closed.test.mjs, which reads each flag independently',
  },
  {
    match: /The first press only shows you what would move; nothing moves until you press again/,
    pinnedBy: 'the ledger archive control is a two-phase button whose first press requests a preview and whose second press submits exactly that preview; asserted by tools/test/ledger-archive-ui.test.mjs',
  },
  {
    match: /Switches on nothing that acts\. Every screen still reads and reports\.$/,
    pinnedBy: 'AUTONOMY_WRITE_FLAGS.observe is the empty array, so the answer requests no write-action flag; the setup lane asserts the equivalent through "skipping applies exactly the state of a machine that never ran setup"',
  },
  {
    match: /Nothing fails quietly and nothing is switched back off behind you\./,
    pinnedBy: 'setWriteEnabled is called only from a control a person pressed, and no code path in this lane calls it at all — asserted directly by "nothing in the guidance module can turn anything on" above; the Start control reports a refusal code from src/agent-availability-copy.js rather than reverting the switch',
  },
  {
    /* THIS PIN MOVED WITH THE ROW ON 2026-08-22, and it is the same claim about
       the same mechanism. The row used to print `winget install OpenAI.Codex`
       and `codex login` for a person to copy, and its pinned sentence was "The
       sign-in stays inside Codex. This product never sees or stores that
       account." The commands are gone -- Settings, under "This computer", installs and signs in
       at the press of a button, and two ways to do one thing is what the owner
       ruled out -- but what makes the claim TRUE is unchanged and is if
       anything more directly checkable: the sign-in still happens in a terminal
       window, in Codex itself, and this product has no field that could collect
       one. */
    match: /You finish it there, and no password or key comes anywhere near this product\./,
    pinnedBy: 'shell/provider-login.cjs start() hands the terminal seam a fixed command line and nothing else, and reads nothing back from the window it opens; tools/test/provider-login.test.mjs asserts the module contains no call that returns file contents and that the install it does run has stdin closed, and no setup or settings surface collects a provider credential, which the setup lane asserts by discovering the collected fields rather than listing them',
  },
  {
    match: /This product never asks for that password and never holds it\./,
    pinnedBy: 'same mechanism as the sentence above: the Codex sign-in happens in a terminal window that is the person’s own, and this product has no field that collects it',
  },
  {
    match: /It runs on this computer and is not reachable from anywhere else\./,
    pinnedBy: 'src/mission-bridge.js resolves only http://127.0.0.1 on the declared port range and refuses any other origin at the URL check, so the connection has no address off this machine',
  },
  {
    match: /Nothing outside this computer is involved, so there is nothing to sign in to\./,
    pinnedBy: 'same mechanism: the audited connection is loopback-only by construction in src/mission-bridge.js',
  },
  {
    match: /Nothing is sent and nothing is recorded until the connection answers\./,
    pinnedBy: 'src/write-surfaces.js disables every control in a surface until prepareSurface resolves, and each action posts only from its own submit handler',
  },
  {
    match: /It is not silently retried somewhere else\./,
    pinnedBy: 'src/cloud-tasks-controller.js posts one launch to one route and reports its refusal code; there is no second provider in that path',
  },
  {
    match: /What a record holds is never shown here, and this row never asks for or displays a value\.$/,
    pinnedBy: 'src/vault-credentials-settings.js draws only record names -- never a value, a masked prefix, or a length derived from one -- and tools/test/vault-credentials-settings.test.mjs drives the panel over a fake store that CONTAINS values and asserts none of them, and no length of any of them, appears in the rendered text',
  },
  {
    match: /What you type there goes straight into the encrypted vault; it never passes through this settings screen\./,
    pinnedBy: 'add() in src/vault-credentials-settings.js sends bridge.add only { credential: \'custom\', customName }, never a value; the value is collected by the detached native entry form the request opens, which this settings screen has no field or handler to read from',
  },
  {
    match: /Once your approval finishes it, the record is gone from this computer’s vault, with no undo and no copy kept anywhere else\./,
    pinnedBy: 'capability/tools/secrets.ps1\'s \'del\' verb removes the key from the vault hashtable and rewrites the file with no backup or archive step, logging only the fact of the deletion to the access log, not a restorable copy of the value',
  },
  {
    /* One pin, because it is one statement. Two pins over one sentence would
       make the registry larger than the set of claims and turn the "the
       detector has gone inert" floor below into a false alarm. */
    match: /On "remove everything", it is gone\. There is no undo and no copy kept anywhere else\./,
    pinnedBy: 'shell/uninstall-retention.cjs removes the named directories on the remove-everything answer and this product writes no backup of them; the retention suite asserts what each answer removes',
  },
  {
    /* THE PROMISE THE NOTIFICATION ROWS MAKE, AND IT IS DELIBERATELY THE ONE
       ABOUT NOISE RATHER THAN THE ONE ABOUT SILENCE.
       It used to be the other way round: "Nothing appears while this window has
       focus and you are already watching that agent." That reads as a guarantee
       of quiet, and quiet is the half this mechanism CANNOT guarantee -- the
       suppression needs the page's report of what it is showing to have
       arrived, and a report that never arrived leaves the program notifying.
       The claim that survives every path is the opposite one, so that is what
       is written and what is pinned. The suppression itself is still driven, by
       all four combinations of focus and session match, in
       tools/test/agent-notifications.test.mjs; it is simply not sold as an
       absolute any more. */
    match: /^When this page has not said what it is showing, nothing is held back and you are told\.$/,
    pinnedBy: 'shell/agent-notifications.cjs watching() returns false on every path that is not an explicit focused === true beside an exact session-id match -- an attention probe that throws, a shape with no focus field, a truthy non-boolean focus, and an empty or absent session on screen all answer false -- so every way the page report can be missing or wrong reaches show(); tools/test/agent-notifications.test.mjs drives each of those shapes and asserts the platform WAS asked to draw one in each',
  },
  {
    /* THE COMPARE WINDOW'S SAVE. Registered rather than softened because the
       absoluteness is the POINT: the owner ruled this surface is a person's
       manual override of an agent, so the one thing the statement must not do
       is imply a safety net that is not there. */
    match: /A save replaces the file straight away and nothing here undoes it\./,
    pinnedBy: 'shell/diff-file.cjs replaces a file by writing a temporary beside it and renaming over the top, and it keeps no copy of the previous contents anywhere; there is no undo, restore or history verb on that module or on the three mc-diff channels in shell/main.cjs, and tools/test/diff-file-fence.test.mjs asserts the directory holds nothing but the saved file afterwards',
  },
  {
    match: /^Nobody has written down yet what this one grants and what it risks/,
    pinnedBy: 'this is the sentence shown INSTEAD of a statement, and the absence tests above assert it is what an undeclared id returns; it makes no claim about the product beyond that nobody has written one',
  },
])

test('every absolute claim this lane shows is registered with the reason it is true', () => {
  const absolute = /\b(never|nothing|no one|anywhere|always|none)\b/i
  const claims = everySentenceThisLaneShows().filter(sentence => absolute.test(sentence))
  /* The detector must find something. A pattern that has gone inert reports a
     clean scan over copy full of promises, which is the exact shape of a green
     test proving nothing. */
  assert.ok(
    claims.length >= PINNED_ABSOLUTE_CLAIMS.length,
    `the detector found ${claims.length} absolute sentences but ${PINNED_ABSOLUTE_CLAIMS.length} are registered; the pattern has gone inert`,
  )
  for (const claim of claims) {
    const pin = PINNED_ABSOLUTE_CLAIMS.find(entry => entry.match.test(claim))
    assert.ok(pin, `this sentence promises something absolute and nothing pins it true:\n    "${claim}"\n  Register it with the reason, or soften it.`)
    assert.ok(pin.pinnedBy.length > 40, 'a pinned claim needs a real reason, not a placeholder')
  }
  for (const entry of PINNED_ABSOLUTE_CLAIMS) {
    assert.ok(
      claims.some(claim => entry.match.test(claim)),
      `a claim is pinned here but no longer appears: ${entry.match}. Remove the pin, or restore the sentence.`,
    )
  }
})

test('no risk statement is boilerplate reused across unrelated subjects', () => {
  /* A family sharing ONE declaration is honest -- the appearance rows really do
     share a risk. The same sentence written twice into two different subjects
     is not: it means one of them was filled in rather than thought about. */
  const seen = new Map()
  for (const [id, subject] of [...Object.entries(SUBJECTS), ...Object.entries(ANSWER_SUBJECTS)]) {
    for (const statement of [...subject.capabilities, ...subject.risks]) {
      const previous = seen.get(statement)
      assert.equal(previous, undefined, `${id} repeats a statement verbatim from ${previous}`)
      seen.set(statement, id)
    }
  }
  assert.ok(seen.size >= 30, `only ${seen.size} statements were compared; the walk went inert`)
})

/* ---------- 5. THE SURFACES ASK, RATHER THAN AUTHORING THEIR OWN ---------- */

test('the surfaces that show a withheld state get their words from the one module', () => {
  for (const [name, relative] of [
    ['the settings page', 'src/views/settings.js'],
    ['the quick-settings drawer', 'src/quick-settings.js'],
    ['the setup walkthrough', 'src/views/setup.js'],
    ['the settings setup section', 'src/setup-profile-settings.js'],
    ['the agent page', 'src/agent-session.js'],
  ]) {
    assert.match(read(relative), /from '\.\.?\/guided-step\.js'/, `${name} does not use the shared guidance`)
  }
})

test('the setup review explains every switch it left off, and does not switch any on', () => {
  const view = read('src/views/setup.js')
  assert.match(view, /function withheldSectionMarkup/, 'the review no longer explains what it withheld')
  assert.match(view, /Left off, and what each one would have given you/)
  /* The repair is guidance. The one thing it must not have done is widen what
     the recommended answers grant, so the derivation is asserted untouched by
     name: this lane changed no flag table. */
  const profile = read('src/setup-profile.js')
  assert.match(profile, /observe: Object\.freeze\(\[\]\)/, 'the observe answer no longer requests nothing')
  assert.match(profile, /assisted: Object\.freeze\(\['report-read', 'agent-session', 'dispatch', 'cloud-launch'\]\)/,
    'the recommended answer’s granted flags changed; this lane may not widen a default')
  assert.match(profile, /guided: Object\.freeze\(\{\s*writeFlags: Object\.freeze\(\['report-read', 'agent-session'\]\)/,
    'the guided ceiling changed; this lane may not widen a default')
})

test('the drawer disclosure is a sibling of its row, never inside the label', () => {
  /* A <details> nested in a <label> toggles the label's own control when the
     summary is clicked, so reading about the example switch would flip it --
     and flipping THIS one silently swaps every screen between a person's own
     records and the example. The row moved from pageRows to appRows when the
     per-view flags became the one toggle; the rule moved with it. */
  const drawer = read('src/quick-settings.js')
  const appRows = drawer.slice(drawer.indexOf('function appRows'), drawer.indexOf('async function fillBuildRow'))
  const label = appRows.indexOf('</label>')
  const disclosure = appRows.indexOf("guidanceMarkup('example_mode'")
  assert.ok(label !== -1 && disclosure !== -1,
    'the example row or its disclosure is gone from the drawer’s app rows')
  assert.ok(label < disclosure,
    'the drawer disclosure sits inside the label, so reading it would change the setting')
})
