/* The copy that four screens now share, and the two ways it could quietly stop
 * being true.
 *
 * WHAT THIS FILE IS FOR, stated as the defect rather than the feature. The
 * unavailable-host state (LEGACY-ONB-001) was four screens each printing its own
 * bare refusal. The repair gives them one set of words and one door. That repair
 * has exactly two failure modes worth a test:
 *
 *   1. THE WORDS DRIFT BACK. A screen stops using the module and writes its own
 *      sentence again, or the module starts promising a remedy that does not
 *      exist. The first is caught by the packaged driver
 *      (tools/first-run-recovery-qa.mjs), which reads these values and looks for
 *      them on the glass. The second is caught here.
 *   2. THE ABSENCE CASE. `hostAbsentNotice()` is called with whatever the
 *      projection said, and a projection that failed without saying why hands it
 *      undefined, null or ''. This codebase's signature defect is a missing field
 *      read as a decision -- so an absent reason must remove the quoted line and
 *      NOTHING ELSE. A person whose read failed silently is the person who most
 *      needs the explanation and the door.
 *
 * Run: node --test tools/test/first-run-needs.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The page that drew the provider copy is now the Settings section module (2026-09-10).
const GUIDE_VIEW = path.join(REPO_ROOT, 'src', 'this-computer-settings.js')

import {
  FIRST_RUN_NEEDS,
  firstRunNeeds,
  GUIDE_ACTION,
  GUIDE_HREF,
  PROVIDER_SETUP,
  presenceSentence,
  SETTINGS_HREF,
  WORKS_HERE,
  hostAbsentMarkup,
  hostAbsentNotice,
} from '../../src/first-run-needs.js'

/* ------------------------------------------------------------------
   The absence case, first, because it is the one that has bitten nine times.
   ------------------------------------------------------------------ */

const NO_REASON = [
  ['undefined', undefined],
  ['null', null],
  ['an empty string', ''],
  ['whitespace only', '   '],
  ['a number', 42],
  ['an object', { reason: 'nope' }],
]

test('a missing reason removes the quoted line and nothing else', () => {
  const full = hostAbsentNotice('No local agent fleet host detected on this machine.')
  assert.equal(full.reason, 'No local agent fleet host detected on this machine.')

  for (const [label, value] of NO_REASON) {
    const notice = hostAbsentNotice(value)
    assert.equal(notice.reason, null, `${label} should produce no quoted line`)
    /* The three things that must survive it. */
    assert.equal(notice.title, full.title, `${label} lost the title`)
    assert.equal(notice.body, full.body, `${label} lost the explanation`)
    assert.deepEqual(notice.action, full.action, `${label} lost the door`)
  }
})

test('a reason is carried verbatim, trimmed but never softened', () => {
  const said = 'No local agent fleet host detected on this machine.'
  assert.equal(hostAbsentNotice(`  ${said}  `).reason, said)
  /* Not paraphrased, not shortened, not turned into an apology: this is the
     product's honest report of what it looked for. */
  assert.equal(hostAbsentNotice(said).reason, said)
})

test('the notice is frozen, so one screen cannot edit the words another screen shows', () => {
  const notice = hostAbsentNotice('anything')
  assert.ok(Object.isFrozen(notice))
  assert.throws(() => { notice.body = 'something else' }, TypeError)
})

/* ------------------------------------------------------------------
   The promise the guide may not make.
   ------------------------------------------------------------------ */

test('nothing in this copy promises a remedy for the host that does not exist', () => {
  const host = FIRST_RUN_NEEDS.find(need => need.id === 'host')
  assert.ok(host, 'the host section is the reason this module exists')
  /* MEASURED, not assumed: dist/data/*.json are build-time outputs packed into
     the read-only asar and no process on a customer machine writes them. So this
     section must be marked as one nobody can clear, and must not tell a person
     to connect, install or wait for anything. */
  assert.equal(host.fix, 'none')
  for (const forbidden of [
    /once (a|another) computer/i,
    /fills in on its own/i,
    /connect (a|another|your) computer/i,
    /install (an? )?agent host/i,
  ]) {
    assert.doesNotMatch(host.body, forbidden, `the host section promises a remedy: ${forbidden}`)
  }
  /* And it must say the flat thing, or a reader will keep looking. */
  assert.match(host.body, /no setting that connects one and no command that installs one/i)
})

test('a section anybody can clear says exactly how, and a section nobody can does not pretend', () => {
  for (const need of FIRST_RUN_NEEDS) {
    assert.ok(['self', 'none'].includes(need.fix), `${need.id} has an unrecognised fix kind`)
    assert.ok(need.steps.length > 0, `${need.id} offers no step at all`)
    for (const step of need.steps) {
      assert.ok(['command', 'switch', 'link'].includes(step.kind), `${need.id} has an unrecognised step kind`)
      assert.ok(step.text.length > 0, `${need.id} has an empty step`)
      assert.ok(step.note.length > 0, `${need.id} has a step with no context`)
      /* A step that sends a person to a screen must carry the way there. A
         switch step with no href is "in Settings" with no Settings, which is
         half an instruction and the exact shape of the dead end being repaired.
         AND IT MUST NAME THE ROW. Three of these landed at the top of a page
         six screens tall, under three different problems, all wearing the same
         label -- so the address must carry the `?setting=` the home screen has
         used correctly all along. */
      if (step.kind === 'switch') {
        assert.ok(
          step.href.startsWith(`${SETTINGS_HREF}?setting=`),
          `${need.id} names a switch with no way to the ROW it means: ${step.href}`,
        )
      }
    }
  }
})

test('the section about running an agent points at the buttons rather than a command line', () => {
  /* WHAT THIS USED TO REQUIRE, and why it went. It asserted this section
     printed `winget install OpenAI.Codex` and then `codex login`, in that
     order, for a person to copy. Both are gone: a few inches down the same page
     is a section that installs and signs in at the press of a button, and the
     owner's instruction on 2026-08-22 was that there be one way to do a thing
     and never two. The copied way is also the one that failed a real person --
     the window their install ran in answered "'codex' is not recognized" --
     so the page keeps the way that works and drops the way that did not. */
  const codex = FIRST_RUN_NEEDS.find(need => need.id === 'codex')
  assert.equal(codex.steps.filter(step => step.kind === 'command').length, 0,
    'the agent section is printing a command line again')
  /* It must still lead somewhere. A section with the instructions removed and
     nothing put in their place is the dead end this whole page exists to end. */
  const said = codex.steps.map(step => `${step.text} ${step.note}`).join(' ')
  assert.match(said, /button/i, 'the agent section no longer says where the install and sign-in are')
})

/* ------------------------------------------------------------------
   Shape, so a renderer cannot be handed something it will draw as blank.
   ------------------------------------------------------------------ */

test('every sentence a person will read is a non-empty string', () => {
  assert.ok(FIRST_RUN_NEEDS.length >= 3, 'the three things a bare machine is missing')
  assert.ok(WORKS_HERE.length > 0, 'a page of absences with nothing that works reads as a broken product')
  const strings = [
    ...FIRST_RUN_NEEDS.flatMap(need => [need.id, need.title, need.body]),
    ...WORKS_HERE,
    GUIDE_ACTION.label,
    hostAbsentNotice(null).title,
    hostAbsentNotice(null).body,
  ]
  for (const value of strings) {
    assert.equal(typeof value, 'string')
    assert.ok(value.trim().length > 0, `empty: ${JSON.stringify(value)}`)
  }
  assert.equal(new Set(FIRST_RUN_NEEDS.map(need => need.id)).size, FIRST_RUN_NEEDS.length)
})

/* ---- THE DOOR THE OWNER COULD NOT FIND ---------------------------------
 *
 * "as a user I dont even see how after signing up that I now connect my
 * computer." Measured on the rendered guide before this section existed: the
 * word "account" appeared thirteen times and every one of them meant a Codex or
 * Claude sign-in folder; "toolsenabled.ai", "signed up" and "code" appeared
 * zero times. A person arriving from the home row about computers read a page
 * that never mentioned the thing they had paid for. */
test('the guide has a section about the ToolsEnabled account, and it leads to the connect screen', () => {
  const account = FIRST_RUN_NEEDS.find(need => need.id === 'account')
  assert.ok(account, 'the guide says nothing about the account a person just made')
  assert.equal(account.fix, 'self', 'the one thing on this page a person can do today is marked as impossible')
  assert.equal(FIRST_RUN_NEEDS[0].id, 'account', 'it is not the first thing on the page')
  assert.match(account.body, /toolsenabled\.ai/i, 'the section never names the website they signed up at')
  assert.match(account.body, /code/i, 'the section never mentions the code, which is the whole ceremony')
  const door = account.steps.find(step => step.href === '#/settings?setting=connect_computer')
  assert.ok(door, 'the account section carries no link to the connect screen')
  assert.ok(door.linkLabel.length > 0, 'the link to the connect screen has no label of its own')
})

test('the account guide entry keeps its desk copy and has a relay twin', () => {
  const local = firstRunNeeds().find(need => need.id === 'account')
  const remote = firstRunNeeds({ viaRelay: true }).find(need => need.id === 'account')
  assert.equal(local.title, 'Joining this computer to your ToolsEnabled account')
  assert.equal(local.body, 'If you signed up at toolsenabled.ai, this is the step that puts this computer on that account. The screen below gives you a short code; you type it into your account page in a browser, and the two halves meet. It is what lets you reach this computer from a browser later. It is a separate thing from the assistant sign-ins further down this page: those are your Codex and Claude accounts, not your ToolsEnabled one.')
  assert.equal(remote.title, 'Joining the computer you are driving to your ToolsEnabled account')
  assert.equal(remote.body, 'If you signed up at toolsenabled.ai, this is the step that puts the computer you are driving on that account. The screen below gives you a short code; you type it into your account page in a browser, and the two halves meet. It is what lets you reach that computer from a browser later. It is a separate thing from the assistant sign-ins further down this page: those are your Codex and Claude accounts, not your ToolsEnabled one.')
  assert.equal(remote.steps, local.steps, 'the literal "Connect this computer" control reference was rewritten')
})

test('the section about the empty screens does not read as "you cannot connect a computer"', () => {
  /* The flat statement stays -- it is true of the FLEET HOST, the program that
     reports on a group of computers, and a reader who does not get it flat
     keeps hunting. It is NOT true of the agent host that runs sessions
     (shell/agent-host.cjs), which ships in this build; saying it of "an agent
     host" was the defect, because the product uses that name for both. What
     the statement may not do is leave that as the last word about connecting
     anything, on the page somebody reached from a home row about computers. */
  const host = FIRST_RUN_NEEDS.find(need => need.id === 'host')
  assert.match(host.body, /no setting that connects one and no command that installs one/i)
  assert.match(host.body, /ToolsEnabled account/i, 'the flat statement is left with nothing beside it')
})

test('every screen offers one door, at one address', () => {
  assert.equal(GUIDE_ACTION.href, GUIDE_HREF)
  assert.equal(hostAbsentNotice('x').action.href, GUIDE_HREF)
  assert.equal(hostAbsentNotice('x').action.label, GUIDE_ACTION.label)
  /* A hash route, because that is the only kind this router has and an http
     link here would open a browser instead of a screen. */
  assert.match(GUIDE_HREF, /^#\//)
  assert.match(SETTINGS_HREF, /^#\//)

  /* AND THE ADDRESS NAMES A ROW, NOT THE TOP OF A PAGE WITH HUNDREDS ON IT.
     The door used to open a page of its own; it opens one section of Settings
     now, and `#/settings` alone would land a person roughly six screens above
     the answer -- the exact defect the `?setting=` mechanism exists to close,
     reintroduced through the one control every empty screen offers. Asserted
     by parsing the address rather than by comparing it to a spelling, so a
     better row id passes and a missing row does not. */
  const [page, query] = GUIDE_HREF.split('?')
  assert.equal(page, SETTINGS_HREF, 'the door no longer opens Settings')
  assert.ok(query, 'the door opens Settings without naming the row it means')
  const row = new URLSearchParams(query).get('setting')
  assert.ok(row && row.length > 0, `the door names no row: ${GUIDE_HREF}`)

  /* And the label is what a person will look for once they are there. A door
     labelled for a page that no longer exists is a door that reads as broken. */
  assert.match(GUIDE_ACTION.label, /Settings/,
    `the door does not say where it goes: ${GUIDE_ACTION.label}`)
})

/* ------------------------------------------------------------------
   The wiring. A copy module only helps if something asserts the screens use it.
   ------------------------------------------------------------------ */

test('the four screens read the shared copy rather than writing their own', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..', '..')
  const wired = [
    ['src/local-activity.js', /from '\.\/first-run-needs\.js'/],
    ['src/views/computers.js', /from '\.\.\/first-run-needs\.js'/],
    ['src/views/comms.js', /from '\.\.\/first-run-needs\.js'/],
    ['src/views/settings.js', /from '\.\.\/first-run-needs\.js'/],
    ['src/views/research.js', /from '\.\.\/first-run-needs\.js'/],
    ['src/views/ledger.js', /from '\.\.\/first-run-needs\.js'/],
    ['src/views/metrics.js', /from '\.\.\/first-run-needs\.js'/],
    /* AND THE ROUTER STILL READS THE STOP TABLE, or the address every door
       above points at is resolved by something no node test can reach. This
       pins the delegation only. WHAT the table resolves `#/guide` and
       GUIDE_HREF to is asserted by behaviour, by calling the function, in
       tools/test/guide-route-alias.test.mjs. It replaces the older pin on
       `case 'guide': return guideView()` here, which named a render that no
       longer exists because the page became a section of Settings. */
    ['src/main.js', /from '\.\/route-parse\.js'/],
  ]
  for (const [file, pattern] of wired) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assert.match(source, pattern, `${file} does not use the shared copy`)
  }

  /* THE SCREEN THAT DRAWS THE ASSISTANT-PROGRAM LIST, WHICHEVER FILE HOLDS IT.
     It was the page src/views/guide.js. The owner asked for that page to be
     folded into Settings, so the same code is src/this-computer-settings.js
     once that lands. Naming one spelling would make this assertion fail on the
     MOVE rather than on a defect, and the quickest way back to green would be
     to put the deleted page back -- which is the opposite of what was asked
     for. So the module is looked up and asserted wherever it is. If NEITHER is
     present nothing draws that copy at all, and this fails loudly, which is
     the defect actually worth catching. */
  const drawsPrograms = ['src/this-computer-settings.js', 'src/views/guide.js']
    .filter(file => existsSync(path.join(root, file)))
  assert.ok(drawsPrograms.length > 0,
    'nothing draws the assistant-program copy: neither src/this-computer-settings.js nor src/views/guide.js is in the tree')
  for (const file of drawsPrograms) {
    assert.match(readFileSync(path.join(root, file), 'utf8'), /from '\.\.?\/first-run-needs\.js'/,
      `${file} does not use the shared copy`)
  }
})

/* ------------------------------------------------------------------
   The markup six screens draw, because a shared string is only shared if the
   thing that builds it is too.
   ------------------------------------------------------------------ */

test('the markup carries the whole notice and escapes what the projection said', () => {
  const html = hostAbsentMarkup('No local agent fleet host detected on this machine.')
  const notice = hostAbsentNotice('x')
  assert.ok(html.includes(notice.title))
  assert.ok(html.includes(notice.body))
  assert.ok(html.includes(`href="${GUIDE_HREF}"`))
  assert.ok(html.includes(notice.action.label))
  assert.ok(html.includes('No local agent fleet host detected on this machine.'))

  /* The reason is the ONLY untrusted string on this path -- it comes from a
     projection envelope, i.e. from a file on disk. A build that ever emitted a
     reason containing markup would otherwise put it into six screens. */
  const hostile = hostAbsentMarkup('<img src=x onerror="alert(1)">')
  assert.ok(!hostile.includes('<img'), hostile)
  assert.ok(hostile.includes('&lt;img'), hostile)
})

test('the markup survives a projection that failed without saying why', () => {
  for (const value of [undefined, null, '', '   ']) {
    const html = hostAbsentMarkup(value)
    assert.ok(html.includes(hostAbsentNotice('x').body), `explanation lost for ${JSON.stringify(value)}`)
    assert.ok(html.includes(GUIDE_HREF), `door lost for ${JSON.stringify(value)}`)
    assert.ok(!html.includes('host-absent-reason'), `an empty quoted line for ${JSON.stringify(value)}`)
  }
})

test('the alongside clause lands inside the refusal paragraph, not after it', () => {
  /* tools/agent-route-reachability.mjs asserts both are in the SAME visible
     element: separated, a person can read "no host reported" without reading
     "these are declared, not observed" and take a configured agent for a running
     one. Splitting them turned that suite red once already. */
  const html = hostAbsentMarkup('reason here.', { alongside: 'And this too.' })
  const paragraph = html.match(/<p class="host-absent-reason[^"]*">([^<]*)<\/p>/)
  assert.ok(paragraph, `no refusal paragraph in ${html}`)
  assert.equal(paragraph[1], 'reason here. And this too.')
})

test('a host page can keep a class an existing probe reads', () => {
  const html = hostAbsentMarkup('r', { reasonClass: 'graph-empty-reason' })
  assert.match(html, /class="host-absent-reason projection-unavailable graph-empty-reason"/)
  /* And omitting it adds no stray whitespace class. */
  assert.match(hostAbsentMarkup('r'), /class="host-absent-reason projection-unavailable"/)
})

/* ------------------------------------------------------------------
   The three assistant programs, and the two ways this list turns into a lie.

   1. IT PROMISES SOMETHING THAT CANNOT START. The rule the owner set is that a
      menu entry which cannot run is worse than no entry. Gemini is on this page
      on purpose -- a person comparing the three deserves an answer about the
      third -- and the entire safety of that decision is the word "none" and the
      sentence beside it. If a later lane flips `reach` without wiring anything,
      this page starts telling people to install a program it will not use.
   2. IT REPEATS THE HALF-TRUTH THE TIER MENU ALREADY TOLD. "Claude cannot start
      from a tree" was on the menu for a release with nowhere in the product
      saying where Claude DOES work, so a person read it as "Claude is not
      supported" and never found the agent page. Claude's entry must carry both
      halves or it reproduces that defect on the one screen meant to fix it.
   ------------------------------------------------------------------ */

const PROVIDERS = Object.fromEntries(PROVIDER_SETUP.map(provider => [provider.id, provider]))

/* DOES THIS BUILD START CLAUDE FROM A TREE? Asked of the shell, which answers it
   by require()ing the payload engine module and confirming it exports the start
   function -- the same resolution a press runs. This file must not answer it
   from a list, because a list is what went stale. */
function claudeStartsFromATree() {
  const require_ = createRequire(import.meta.url)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { createAgentHost } = require_(path.join(root, 'shell', 'agent-host.cjs'))
  const host = createAgentHost({
    enginePath: path.join(root, 'capability', 'src', 'lib', 'agent-engine', 'codex-process.js'),
    defaultCwd: root,
  })
  return host.startableTiers().tiers.some(id => id.startsWith('claude-'))
}

test('all four rows are named, and none is invented', () => {
  /* WAS "all three assistant programs", before `local` -- a model on the
     person's own computer -- joined the same table LAUNCH_TIERS already
     carries it in (src/orchestration-controls.js: "the free path is the
     product, not a consolation", owner 2026-08-12). Renamed rather than
     split into two tests, because the property this asks -- every row is
     real, named, and says what it does -- is the same property for all four;
     the CLI-specific install/sign-in machinery below is where they diverge. */
  assert.deepEqual(PROVIDER_SETUP.map(provider => provider.id), ['codex', 'claude', 'gemini', 'grok', 'local'])
  for (const provider of PROVIDER_SETUP) {
    assert.ok(provider.name.length > 0, `${provider.id} has no name a person could read`)
    assert.ok(provider.doesHere.length > 0, `${provider.id} does not say what it does here`)
  }
})

test('every one of the three CLI programs is offered the same pair of buttons', () => {
  /* THE OWNER'S INSTRUCTION, 2026-08-22: "all 3 gemini codex and claude should
     be easy single click download+sign in". So the thing to hold is not that
     each entry has steps -- it now has none, deliberately -- but that the
     buttons exist for all three and that the login table behind them can
     actually answer for each one. A program listed on this page with no way to
     install it is the guessing this section was written to end.

     SCOPED TO THE THREE CLI PROGRAMS, NOT ALL OF PROVIDER_SETUP. `local` was
     added deliberately outside LOGIN_PROVIDERS/SIGN_IN_PROVIDERS: it has no
     npm package and no sign-in command at all
     (local-node-runtime.js's own header, "NO CREDENTIAL, ANYWHERE ON THIS
     PATH"), so holding it to this test's shape would be requiring the thing
     that must not exist for it. Its own buttons are asserted below. */
  const guide = readFileSync(GUIDE_VIEW, 'utf8')
  assert.match(guide, /SIGN_IN_PROVIDERS = Object\.freeze\(new Set\(\['codex', 'claude', 'gemini', 'grok'\]\)\)/,
    'the guide draws the two buttons for fewer than three programs')
  const { LOGIN_PROVIDER_IDS, LOGIN_PROVIDERS, signInLine } = createRequire(import.meta.url)(
    path.join(REPO_ROOT, 'shell', 'provider-login.cjs'),
  )
  for (const provider of PROVIDER_SETUP) {
    if (provider.id === 'local') continue
    assert.ok(LOGIN_PROVIDER_IDS.includes(provider.id),
      `${provider.id} is on this page with no install and no sign-in behind it`)
    assert.ok(LOGIN_PROVIDERS[provider.id].npmPackage.length > 0, `${provider.id} has no package to install`)
    assert.ok(signInLine(provider.id).length > 0, `${provider.id} has no sign-in command to run`)
  }
  /* THE CONVERSE, so a `local` that quietly grew a sign-in table entry (which
     would reintroduce a credential path a local runtime structurally has no
     use for) is caught here rather than only by the absence tests below. */
  assert.ok(!LOGIN_PROVIDER_IDS.includes('local'), 'local grew an npm-install/sign-in table entry it must never have')
})

test('the local-model row is offered its own pair of buttons, on the same bridge, never a sign-in', () => {
  const guide = readFileSync(GUIDE_VIEW, 'utf8')
  assert.match(guide, /localModelSlotMarkup\(provider\)/, 'the local-model panel is no longer wired into the provider row')
  assert.doesNotMatch(guide, /SIGN_IN_PROVIDERS[\s\S]{0,40}'local'/, 'local was added to the sign-in provider set, which claims a credential flow it must never have')
  assert.doesNotMatch(guide, /ACCOUNT_PROVIDERS[\s\S]{0,40}'local'/, 'local was added to the account-panel provider set, which claims accounts a local runtime has no use for')
  const shell = createRequire(import.meta.url)(path.join(REPO_ROOT, 'shell', 'provider-login.cjs'))
  assert.equal(typeof shell.createProviderLoginService, 'function')
  const service = shell.createProviderLoginService({
    spawnHidden: () => { throw new Error('not exercised') },
    openTerminal: () => {},
    providerSpawnRefused: () => false,
    localNodeRuntime: { RUNTIMES: {}, CURATED_MODELS: [], detect: async () => ({ ready: false, runtimes: [], selected: null, reason: 'x', nextCommand: 'y' }) },
  })
  for (const verb of ['detectLocal', 'installRuntime', 'pullModel']) {
    assert.equal(typeof service[verb], 'function', `the local-model bridge is missing ${verb}()`)
  }
})

test('provider reach matches the installed interactive tree engines', () => {
  for (const provider of PROVIDER_SETUP) {
    assert.ok(
      ['tree', 'not-from-tree', 'none'].includes(provider.reach),
      `${provider.id} claims a reach this product has no rendering for`,
    )
  }
  assert.equal(PROVIDERS.codex.reach, 'tree')
  /* MOVED DELIBERATELY, WHICH IS WHAT THE NOTE BELOW ASKS FOR. This asserted
     'not-from-tree' until the Claude engine shipped in the payload. It is not
     re-pinned to a value read off the source: the check is against the SHELL,
     which resolves each tier by require()ing the engine module the press
     requires. A build that drops the engine fails this, and so does a guide that
     claims a reach the gate does not open. */
  assert.equal(PROVIDERS.claude.reach, claudeStartsFromATree() ? 'tree' : 'not-from-tree')

  /* THE ONE THAT GUARDS THE OWNER'S RULE. Nothing in this product starts Gemini
     -- there is no adapter at the engine seam and no lane row for it -- so this
     page may not imply otherwise. The day something can start it, this assertion
     is the thing that has to be changed deliberately, by somebody who has driven
     it. */
  assert.equal(
    PROVIDERS.gemini.reach,
    'tree',
    'Gemini must be launchable from Research',
  )
  assert.equal(PROVIDERS.grok.reach, 'tree')
  assert.match(PROVIDERS.gemini.doesHere, /ToolsEnabled tools only/)

  // Local's interactive engine is shipped alongside the provider engines.
  // reach-words-are-live additionally compares the guide with the host gate.
  assert.equal(PROVIDERS.local.reach, 'tree')
})

test('the dispatch front door offers local unfiltered, the claim the guide reach word depends on', () => {
  /* THE CLAIM `reach: 'dispatch'` MAKES, MEASURED RATHER THAN ASSUMED. Both
     real dispatch surfaces (computers.js's launchControlsBox and
     teamControlsBox, not the simulated board) render every LAUNCH_TIERS
     entry into a picker with no exclusion -- read here from LAUNCH_TIERS
     itself and from the source, the same two-sided check tools/test/
     first-run-needs.test.mjs already applies to Claude's engine claim. This
     is a source-level proof, not a live dispatch proof: a QA script that
     actually dispatches tier 'local' against a real mission bridge is the
     converse half, named in the execution report rather than pinned here,
     because this suite cannot start a real bridge. */
  const computers = readFileSync(path.join(REPO_ROOT, 'src', 'views', 'computers.js'), 'utf8')
  assert.ok(PROVIDER_SETUP.some(provider => provider.id === 'local'), 'this test\'s premise: PROVIDER_SETUP still carries a local row')
  assert.match(computers, /function launchControlsBox/, 'the Launch controls dispatch panel moved or was renamed')
  assert.match(computers, /function teamControlsBox/, 'the Team dispatch panel moved or was renamed')
  const launchBody = computers.slice(computers.indexOf('function launchControlsBox'), computers.indexOf('function teamControlsBox'))
  assert.match(launchBody, /DISPATCH_TIERS\.map/, 'the Launch controls tier picker no longer renders every detached-launch row')
  assert.doesNotMatch(launchBody, /LAUNCH_TIERS\.filter/, 'the Launch controls tier picker now filters LAUNCH_TIERS, which may exclude local without this test noticing')
})

test('the Claude entry claims only what this build can be asked to prove', () => {
  const said = PROVIDERS.claude.doesHere.toLowerCase()
  /* IT MUST NOT NAME THE AGENT PAGE. That clause was driven on 2026-08-17 from
     the exact state this copy is read in -- a set-up machine, a tree, a refused
     start -- and there were ZERO doors to it: no link, no enabled control, and
     the agent route is not on the ring either. A direction with no route is a
     dead end wearing the costume of help. */
  assert.ok(!said.includes('agent page'), `the guide names a page with no route to it: "${said}"`)
  /* And it must not claim the hand-over works, because nobody has driven it end
     to end. The lane that tried was blocked before reaching the form and
     reported NOT EXERCISED rather than passing it from a demonstration board. */
  assert.ok(!/hand (the )?work over/.test(said), 'the guide claims a hand-over nobody has measured')
  /* WHAT IT MAY SAY IS NOW DECIDED BY THE GATE, NOT BY THIS FILE. The previous
     version required /does not carry the part/ and /sign-in is fine/ -- a suite
     REQUIRING the sentence that had gone false, which is how the false one
     survived a sweep that corrected three of its siblings. So the requirement is
     the pairing: the guide may claim a tree start exactly when the shell opens
     one, and must claim the opposite when it does not. */
  if (claudeStartsFromATree()) {
    assert.match(said, /tree/)
    assert.ok(!/does not carry/.test(said), `the guide says this build has no Claude launcher, and the shell starts one: "${said}"`)
  } else {
    assert.match(said, /does not carry the part/)
  }
  /* Either way it must not put the fault on the person's own install. */
  assert.ok(!/you (have not|did not|need to) install/.test(said))
})

/* ------------------------------------------------------------------
   THE SINGLE-PATH GUARD, and it is the one to read first if this suite ever
   goes red on a line somebody just added.

   THE OWNER'S INSTRUCTION, 2026-08-22, in his own words: "we need single clear
   paths" -- one way to do a thing, never two. The thing in question is getting
   an assistant program onto this computer and signed in, and until that day
   this product offered it twice: a button on the guide that did it, and,
   inches above the button, a printed command line for the person to copy into
   a terminal themselves.

   THE PRINTED ONE IS THE ONE THAT FAILED A REAL PERSON. The first external
   user of 1.0.20 typed `winget install OpenAI.Codex` and then `codex login` in
   the same window, and that window answered "'codex' is not recognized",
   because a shell that is already open never re-reads the PATH an installer
   wrote. So the printed one goes, everywhere it was shown, and this is what
   stops it coming back a line at a time.

   IT IS DELIBERATELY BLUNT. It walks every sentence these three surfaces put
   in front of a person and fails on anything shaped like an install or a
   sign-in the reader is expected to type. A new provider, a new settings row
   or a helpful example added in a comment-free copy string all trip it, and
   that is the intent: the button is the path, and a command on the glass is a
   second one no matter how kindly it is worded.
   ------------------------------------------------------------------ */

/* GOOGLE STOPPED SERVING PERSONAL ACCOUNTS THROUGH GEMINI CLI (2026-06-18,
   github.com/google-gemini/gemini-cli/discussions/28017), and the row still
   said "Sign in with its official program, then choose Gemini" to everybody.
   A person with a personal Google account followed it, signed in, and met a
   refusal at start. The row now says where that person goes -- the Antigravity
   connection in Accounts, the same place the start refusal names -- and keeps
   the sign-in step for the accounts Google still serves. */
test('the Gemini row sends a personal Google account to Antigravity instead of a sign-in Google no longer serves', () => {
  const said = PROVIDERS.gemini.doesHere
  assert.match(said, /personal Google account/i, 'the row does not say who can no longer use Gemini CLI')
  assert.match(said, /add Antigravity in Accounts/i, 'the row does not say what a personal account holder does instead')
  assert.match(said, /Code Assist/, 'the accounts Google still serves lost their way in')
  assert.doesNotMatch(said, /Gemini (?:CLI )?(?:is|was|has been) (?:retired|discontinued|shut down|gone)/i,
    'Google changed personal accounts only; the row must not say Gemini ended for everyone')
  for (const sentence of said.split(/(?<=[.!?])\s+/)) {
    assert.ok(sentence.split(/\s+/).length <= 25, `a sentence a person has to read twice: ${sentence}`)
  }
})

/* Each pattern is a thing a person could be expected to TYPE. Words that merely
   name a program ("Codex is a separate free program") are not commands and are
   not matched -- the surfaces are allowed, and need, to say what these programs
   are. */
const A_COMMAND_TO_TYPE = Object.freeze([
  /\bwinget\s+install\b/i,
  /\bnpm\s+install\b/i,
  /\bcodex\s+(login|auth)\b/i,
  /\bclaude\s+auth\b/i,
  /\bgemini\s+(login|auth)\b/i,
  /\b(codex|claude|gemini)\s+login\b/i,
])

function everySentenceTheseSurfacesShow(externalCapabilities) {
  const strings = []
  for (const need of FIRST_RUN_NEEDS) {
    strings.push(need.title, need.body, need.quote || '')
    for (const step of need.steps) strings.push(step.kind, step.text, step.note || '', step.linkLabel || '')
  }
  for (const provider of PROVIDER_SETUP) {
    strings.push(provider.name, provider.doesHere)
    for (const step of provider.steps) strings.push(step.kind, step.text, step.note || '', step.linkLabel || '')
  }
  for (const capability of Object.values(externalCapabilities)) {
    strings.push(capability.name, capability.whatItDoes, capability.verify, capability.withoutIt)
    strings.push(...capability.gains, ...capability.costs)
    for (const step of capability.steps) strings.push(step.do, step.why || '')
  }
  return strings.filter(value => typeof value === 'string' && value.length > 0)
}

test('no install-or-sign-in command is printed for a person to type, anywhere on these surfaces', async () => {
  const { EXTERNAL_CAPABILITIES } = await import('../../src/permission-guidance.js')
  const sentences = everySentenceTheseSurfacesShow(EXTERNAL_CAPABILITIES)
  /* Prove the detector rather than pinning how many sentences happen to be on
     this machine's version of the three surfaces. Condensing or removing
     honest copy must not disable the test; each forbidden behaviour must still
     be recognisable independently of the current fixture. */
  for (const command of [
    'winget install Example.Agent',
    'npm install example-agent',
    'codex login',
    'claude auth',
    'gemini login',
  ]) {
    assert.ok(
      A_COMMAND_TO_TYPE.some(pattern => pattern.test(command)),
      `the command detector does not recognise a printed command: "${command}"`,
    )
  }

  const printed = []
  for (const sentence of sentences) {
    for (const pattern of A_COMMAND_TO_TYPE) {
      if (pattern.test(sentence)) printed.push(sentence)
    }
  }
  assert.deepEqual(printed, [], 'a command line came back onto a surface that has a button for it:\n    '
    + printed.map(line => `"${line}"`).join('\n    ')
    + '\n  The guide installs and signs in at the press of a button. Point people at the button.')

  /* AND NO STEP MAY BE OF THE KIND THAT DRAWS ONE. The renderer draws
     `kind: 'command'` as a monospaced, selectable block -- the shape that says
     "copy me" -- so a step of that kind is the printed path even if the text
     inside it slipped past the patterns above. */
  const commandSteps = [...FIRST_RUN_NEEDS, ...PROVIDER_SETUP]
    .flatMap(entry => entry.steps)
    .filter(step => step.kind === 'command')
  assert.deepEqual(commandSteps, [], 'a step that draws as a copyable command line came back')
})

test('the page never asks a person for a credential', () => {
  /* The product's promise is that it starts these programs and never handles
     their sign-ins. A step that asked for a key or a token would break it on the
     one screen where a person is most primed to hand one over. */
  const prose = PROVIDER_SETUP
    .flatMap(provider => [provider.doesHere, ...provider.steps.map(step => `${step.text} ${step.note || ''}`)])
    .join(' ')
    .toLowerCase()
  for (const ask of ['paste your', 'enter your key', 'api key here', 'copy your token']) {
    assert.ok(!prose.includes(ask), `the guide asks for a credential: "${ask}"`)
  }
})

/* ------------------------------------------------------------------
   The sentence beside each program's name, and the one way it turns cruel.

   The failure worth a test is not a wrong word, it is a CONFIDENT wrong word.
   Claude and Gemini can both authenticate in ways a file check cannot see, so
   "no sign-in file here" is not "you are signed out". A page that says the
   second sends somebody to re-run a sign-in that already worked, and they
   conclude the product is broken. Every uncertain state must therefore read as
   uncertain, and must still point at the control that settles it.
   ------------------------------------------------------------------ */

test('a machine that is ready says so, and only when it really is', () => {
  assert.equal(presenceSentence({ installed: 'yes', signedIn: 'yes' }), 'Installed here, and signed in.')
  /* Every other combination must NOT claim a sign-in. */
  for (const signedIn of ['no', 'unknown']) {
    const said = presenceSentence({ installed: 'yes', signedIn })
    assert.ok(!/and signed in/.test(said), `"${said}" claims a sign-in it has not got`)
  }
})

test('uncertainty never reads as a verdict', () => {
  const unknownSignIn = presenceSentence({ installed: 'yes', signedIn: 'unknown' })
  /* It must not tell the person they are signed out... */
  assert.ok(!/nobody is signed in/.test(unknownSignIn), unknownSignIn)
  /* ...and it must still give them the way to find out. It used to say "run
     the last command below", which was true while three commands were printed
     under every program. They are gone, so it names the button instead; a
     sentence pointing at something that is no longer on the page is a dead end
     on the page written to end dead ends. */
  assert.match(unknownSignIn, /Sign in below/)

  const unknownInstall = presenceSentence({ installed: 'unknown', signedIn: 'unknown' })
  assert.match(unknownInstall, /could not tell/)
  assert.ok(!/not on this computer/i.test(unknownInstall), unknownInstall)
})

test('a missing program is stated plainly, because that one IS known', () => {
  assert.equal(presenceSentence({ installed: 'no', signedIn: 'no' }), 'Not on this computer yet.')
  /* The install answer does not depend on the sign-in answer: a machine with no
     program cannot have a meaningful sign-in state, and reporting one would be
     two claims where there is one fact. */
  for (const signedIn of ['yes', 'no', 'unknown']) {
    assert.equal(presenceSentence({ installed: 'no', signedIn }), 'Not on this computer yet.')
  }
})

test('a missing program keeps the desk sentence and has a relay twin', () => {
  const presence = { installed: 'no', signedIn: 'no' }
  assert.equal(presenceSentence(presence), 'Not on this computer yet.')
  assert.equal(presenceSentence(presence, { viaRelay: true }), 'Not on the computer you are driving yet.')
})

test('an unreadable answer produces no sentence at all', () => {
  /* The page hides the slot on null. Saying nothing is correct here: a status
     line that appeared with an apology in it would be the product reporting its
     own plumbing to somebody who wanted to install Codex. */
  for (const value of [null, undefined, '', 42, 'yes', []]) {
    assert.equal(presenceSentence(value), null, `${JSON.stringify(value)} produced a sentence`)
  }
})

/* ------------------------------------------------------------------
   THE CLAUDE ANSWER, ACROSS BOTH PLACES THAT GIVE IT.

   One decision, two modules, and they are edited by different lanes and never
   rendered on the same screen -- which is exactly how they drift. The refusal is
   what a person meets when they PRESS a Claude tier; the guide is what they meet
   when they go looking for why. They have to survive two rules together:

     1. NO IMPLIED REMEDY. Nothing a person can press, restart, reinstall or
        switch on makes Claude start from a tree today. The part is not in this
        build. A sentence hinting otherwise is the "try once more" dead end the
        start-refusal vocabulary was written to remove -- and it is worse here,
        because the loop has no exit at all.
     2. NO CONTRADICTING THE SIGN-IN READOUT. The guide now reports, truthfully,
        that Claude is installed on this computer and signed in. A refusal
        implying the sign-in or the install is at fault would be two screens of
        one product calling each other liars, and would send somebody to repair
        something that is already correct.
   ------------------------------------------------------------------ */

test('neither place implies that anything the person does will fix it', async () => {
  const { UNAVAILABLE_TEXT } = await import('../../src/agent-availability-copy.js')
  const refusal = UNAVAILABLE_TEXT.AGENT_TIER_NO_LAUNCHER
  const guide = PROVIDERS.claude.doesHere

  for (const [where, sentence] of [['the refusal', refusal], ['the guide', guide]]) {
    /* "yet" is on this list and it is the subtle one. Beside a working sign-in
       it reads as "your program is not ready", which is precisely the wrong
       place to put the reason. */
    for (const remedy of ['try again', 'try once more', 'reinstall', 'restart', 'yet']) {
      assert.ok(
        !sentence.toLowerCase().includes(remedy),
        `${where} says "${remedy}", which promises a repair that does not exist: "${sentence}"`,
      )
    }
  }
})

test('the guide names the sign-in the session actually runs on', () => {
  /* WHAT THIS USED TO REQUIRE. `assert.match(guide, /this copy does not carry the
     part/i)` -- the exact sentence that went false when the engine shipped, held
     in place by the test written to protect it.
     What matters underneath it has not changed: the person's own sign-in is what
     the session runs on, and the guide has to say so, because the refusal beside
     it must never read as "your Claude install is at fault". */
  const guide = PROVIDERS.claude.doesHere
  assert.match(guide, /your own claude sign-in/i)
  /* IT NO LONGER POINTS ANYWHERE, and that is the repair rather than a
     regression. This used to require the sentence to name the agent page as
     "the place Claude genuinely works today". Driven 2026-08-17 from the state
     this copy is read in: zero doors to that page. A test that REQUIRES a
     direction is how a dead end gets held in place by its own suite. */
  assert.ok(!/agent page/i.test(guide), 'the guide points at a page with no route to it')
})

test('the refusal names the build, and names no engine this build carries', async () => {
  const { UNAVAILABLE_TEXT } = await import('../../src/agent-availability-copy.js')
  const refusal = UNAVAILABLE_TEXT.AGENT_TIER_NO_LAUNCHER
  /* WHAT THESE ASSERTIONS USED TO REQUIRE, AND WHY REQUIRING IT WAS THE DEFECT.
     They pinned /does not carry the part/, /sign-in is fine/, /local/ and
     /Pick Luna, Terra or Sol/ -- a sentence naming Claude and local as the two
     things this build cannot start, and the three Codex tiers as the whole
     startable set. All four were true when they were written. The Claude engine
     then shipped in the payload, resolveStartTier() opened the Claude tiers on a
     require() of it, and this suite went on REQUIRING the false version. A test
     that pins what a build carries is a test that holds the lie in place on the
     day the build changes.
     So the shared sentence names no provider at all, and these assertions are
     about that property rather than about a provider list.
     tools/test/refusal-engine-honesty.test.mjs is the mechanical half: it reads
     the payload and fails on any refusal claiming this build lacks an engine the
     payload is carrying. */
  assert.match(refusal, /carries no launcher/i)
  for (const provider of [/\bclaude\b/i, /\bcodex\b/i, /\bgemini\b/i]) {
    assert.ok(!provider.test(refusal),
      `the shared refusal names a provider it cannot know is the missing one: "${refusal}"`)
  }
  /* IT MUST NOT NAME THE AGENT PAGE. Same measurement as before: from a set-up
     machine with a tree and a refused start there are no links and no enabled
     controls that reach it, and the agent route is not on the ring. */
  assert.ok(!/agent page/i.test(refusal), 'the refusal sends people to a page with no door on it')
  /* It must still END on something the reader can do HERE, or removing the
     provider name would have made it a dead end of a different kind. */
  assert.match(refusal, /pick one it does not mark/i)
})

test('the tree names the provider of the tier that was actually refused', async () => {
  const { tierNoLauncherSentence, startRefusalSentence } = await import('../../src/fleet-tree-copy.js')
  /* The specific half of the answer, and the reason the shared table can afford
     to name nobody: the press knows which tier it asked for, so the tree names
     that one provider and no other. The sentence is only ever produced for a
     tier the shell just refused, which is what makes it true by construction
     rather than by upkeep. */
  const local = tierNoLauncherSentence('local')
  assert.match(local, /an agent on this computer itself/i)
  assert.ok(!/\bclaude\b/i.test(local), `a refused local tier is being told about Claude: "${local}"`)
  const claude = tierNoLauncherSentence('claude-sonnet')
  assert.match(claude, /a Claude agent/i)
  assert.ok(!/\bcodex\b/i.test(claude), `a refused Claude tier is being told about Codex: "${claude}"`)
  /* A tier this module does not recognise falls back to the shared sentence
     rather than inventing a provider for it. */
  assert.equal(tierNoLauncherSentence('not-a-tier'), null)
  assert.equal(tierNoLauncherSentence(undefined), null)
  const fallback = startRefusalSentence({ ok: false, code: 'AGENT_TIER_NO_LAUNCHER' })
  assert.match(fallback, /carries no launcher/i)
  assert.ok(!/\bclaude\b/i.test(fallback))
})

/* ------------------------------------------------------------------
   The friend's defect, held shut. 1.0.20 told a person to run the
   sign-in "in the same window, once the install finishes", and the
   window the install ran in answered "'codex' is not recognized":
   winget writes the new program's PATH entry to the registry, and a
   shell that is already open never re-reads it. Reproduced on
   2026-08-19 against a PATH snapshotted before the install. The first
   external user hit exactly this. No note may ever send a person back
   to the stale window again.
   ------------------------------------------------------------------ */

test('the guide sends nobody to a window at all, stale or otherwise', () => {
  /* THE DEFECT IS CLOSED AT A DEEPER PLACE NOW, so what this asserts has moved
     with it. It used to require every printed sign-in step to say "in a new
     terminal window" and never "in the same window" -- the best a page of
     copied commands can do, because it can only ASK a person to open the right
     window. The page no longer asks. The Sign in button OPENS the window
     itself, after the install, so the window is new by construction and the
     wording cannot be got wrong. What is left to hold is that no note on this
     page sends a person back to a window of their own to type something. */
  const notes = [...FIRST_RUN_NEEDS, ...PROVIDER_SETUP]
    .flatMap(entry => entry.steps)
    .map(step => `${step.text} ${step.note || ''}`)
  for (const note of notes) {
    assert.ok(!/same window/i.test(note), `a step sends a person back to the stale window: "${note}"`)
    assert.ok(!/\b(type|paste|run) (this|it|the command)\b/i.test(note),
      `a step asks a person to type something into a terminal: "${note}"`)
  }
})

test('the shell opens the sign-in window itself, and opens a fresh one', async () => {
  /* The half of the same defect that now lives in code rather than in copy.
     tools/test/provider-login.test.mjs holds the details -- which terminal, how
     it is resolved, what runs in it. This asserts the join: the guide's button
     reaches a shell that opens a window, rather than a page that describes one. */
  const guide = readFileSync(GUIDE_VIEW, 'utf8')
  assert.match(guide, /loginStart\(\{ provider:/, 'the Sign in button no longer asks the render-proven shell verb for anything')
  const shell = readFileSync(path.join(REPO_ROOT, 'shell', 'provider-login.cjs'), 'utf8')
  assert.match(shell, /function resolveTerminal\(/, 'the shell no longer resolves a terminal to open')
  assert.match(shell, /openTerminal\(/, 'the sign-in no longer opens a window')
})

test('the refusal sentences hold the same rule, wherever the instruction appears', async () => {
  /* The same defect lived in four modules; the guide's two were fixed first and
     these are the other two. Driven on a sealed foreign build (cross-machine
     lane, 2026-08-19): the signed-out refusal also ASSERTED "Codex is
     installed" on a machine where nothing had probed it and nothing was there. */
  const { UNAVAILABLE_TEXT } = await import('../../src/agent-availability-copy.js')
  for (const code of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
    const sentence = UNAVAILABLE_TEXT[code]
    assert.ok(!/same window/i.test(sentence), `${code} sends a person back to the stale window`)
    assert.match(sentence, /new terminal window/i, `${code} does not say where "codex login" can actually run`)
  }
  /* The ASSERTIVE phrase is what is banned. "If Codex is installed" is the
     honest conditional and stays; "Codex is installed on this computer" was
     the claim measured false on a driven Claude-only machine, because the
     press route raises this code with no probe behind it. */
  assert.ok(!/Codex is installed on this computer/i.test(UNAVAILABLE_TEXT.AGENT_CONFINEMENT_SIGNED_OUT),
    'the signed-out refusal claims an installation that nothing at raise time has checked')

  /* The home screen's variant, held by source because that module needs a DOM. */
  const { readFileSync } = await import('node:fs')
  const localActivity = readFileSync(new URL('../../src/local-activity.js', import.meta.url), 'utf8')
  const homeSentence = /AGENT_CODEX_CLI_NOT_INSTALLED: `([^`]+)`/.exec(localActivity)?.[1] || ''
  assert.ok(homeSentence.length > 0, 'the home screen no longer carries its not-installed sentence')
  assert.match(homeSentence, /new terminal window/i, 'the home screen variant lost the new-window truth')
})

/* THE OWNER'S GEMINI RULE, CHECKED WHERE IT WAS ACTUALLY BROKEN.
 *
 * "reach is one of the four known values, and Gemini is not offered" already
 * pins PROVIDERS.gemini.reach to 'none', with the reason spelled out: this page
 * must not tell people to set up something it will not use. That guarded the
 * Gemini ROW, and nothing guarded the PROSE. The section about running an agent
 * said Codex, Claude and Gemini "each do", and that "once one of them" was
 * installed and signed in the agent page could start a session -- naming Gemini
 * among the three and then promising a session. A reader who picked Gemini from
 * that sentence installed a program, signed into it, and found nothing that
 * used it, which is the precise outcome the reach rule exists to prevent.
 *
 * So the rule is now checked on the sentences too, not only on the row. */
test('no guide sentence offers Gemini as a way to start a session', () => {
  const bodies = FIRST_RUN_NEEDS.map(need => String(need.body || ''))
  const guide = readFileSync(GUIDE_VIEW, 'utf8')
  const remoteTwins = [...guide.matchAll(/'((?:[^'\\]|\\.)*Gemini(?:[^'\\]|\\.)*)'/g)].map(match => match[1])

  for (const sentence of [...bodies, ...remoteTwins]) {
    if (!/Gemini/.test(sentence)) continue
    if (/nothing in this copy starts Gemini/i.test(sentence)) continue
    assert.ok(
      !/start (a session|an agent)/i.test(sentence),
      `a sentence names Gemini and promises a session; nothing in this copy starts Gemini: ${sentence}`,
    )
  }
})
