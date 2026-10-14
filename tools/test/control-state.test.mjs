import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { controlState } from '../../src/components.js'

const read = relative => fs.readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

test('controlState makes the render decision and its reason inseparable', () => {
  assert.throws(() => controlState({ enabled: true }), TypeError,
    'omitting why must reject the incomplete control state')
  assert.throws(() => controlState({ enabled: false, why: '' }), TypeError,
    'a disabled control without a visible reason must be rejected')
  assert.throws(() => controlState({ enabled: 'yes', why: null }), TypeError,
    'a non-boolean enabled value must be rejected')

  assert.deepEqual(controlState({ enabled: true, why: null }), {
    enabled: true,
    disabled: false,
    why: '',
  })
  assert.deepEqual(controlState({ enabled: false, why: '  Not available here.  ' }), {
    enabled: false,
    disabled: true,
    why: 'Not available here.',
  })
})

test('bridge-backed controls are gated before rendering and never optional-call a missing verb', () => {
  const guide = read('src/this-computer-settings.js') // the provider controls' home since 2026-09-10
  assert.doesNotMatch(guide, /installStart\?\.\(/)
  assert.doesNotMatch(guide, /loginStop\?\.\(/)
  assert.doesNotMatch(guide, /mcProviders\?\.account(?:Add|Remove)\(/)
  assert.match(guide, /if \(!answer \|\| answer\.ok !== true\) \{ refuse\(answer\); return \}/)

  const cloud = read('src/cloud-tasks.js')
  assert.doesNotMatch(cloud, /mcProviders\?\.cloudAccountAdd\(/)

  const setup = read('src/views/setup.js')
  assert.match(setup, /typeof globalThis\.mcSetup\?\.recordWorkspaces !== 'function'/)
  assert.match(setup, /MC_SETUP_WORKSPACE_UNAVAILABLE/)

  const setupSettings = read('src/setup-profile-settings.js')
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.chooseTier !== 'function'/)
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.chooseWorkspace === 'function'/)
  assert.match(setupSettings, /typeof globalThis\.mcSetup\?\.recordWorkspaces === 'function'/)

  const fleetSettings = read('src/fleet-profile-settings.js')
  assert.match(fleetSettings, /typeof globalThis\.mcFleetProfile\?\.chooseDirectory === 'function'/)

  /* The tool switches moved out of the quick-settings drawer and onto their own
     page when they grew a third state; the gate moved with them, which is what
     this now reads. The drawer keeps a plain link, and a link needs no bridge. */
  const toolsPage = read('src/views/tools.js')
  assert.match(toolsPage, /typeof account\.putSetting === 'function'/)
  assert.match(toolsPage, /This copy cannot save answers about tools/)
  assert.match(toolsPage, /typeof agent\?\.tools !== 'function'/,
    'the tools page calls the machine before checking that it can answer')

  const compose = read('src/agent-compose-panel.js')
  assert.match(compose, /typeof onSubmit === 'function' \? '' : START_REFUSAL\.notWired/)
  assert.match(compose, /unavailableReason: submitControl\.why/)
})

/* THE MARKER VOCABULARY WAS DELIBERATELY NARROWED, AND THIS TEST FOLLOWED IT
   RATHER THAN THE REVERSE. It previously required one inline alternation
   carrying four phrases -- "at its limit", "already connected", "switched off"
   and "cannot". The harness now keeps a NAMED marker table instead, holding
   only the first two, and the reason is written beside it:

     - "cannot" also describes legitimate permission boundaries, so it fires on
       copy that is telling the truth about a working control.
     - a "switched off" section DELIBERATELY CONTAINS A WORKING CONTROL -- the
       one that switches the feature on. Flagging its enabled control as a dead
       control is precisely backwards.

   Both dropped phrases would have produced false positives, and a gate that
   cries wolf is disabled by the next person and then guards nothing. So the
   narrowing is the correct call and this test now pins the STRUCTURE and the
   BEHAVIOUR -- a named table, consulted per enabled stop -- instead of pinning
   one regex's literal text. Pinning the spelling of an implementation is what
   made this assertion fail against a better implementation. */
test('the packaged keyboard walk checks enabled stops against AX refusal copy', () => {
  const qa = read('tools/a11y-keyboard-qa.mjs')
  assert.match(qa, /Accessibility\.queryAXTree/)

  const markers = qa.slice(qa.indexOf('const REFUSAL_MARKERS'), qa.indexOf('const delay'))
  assert.ok(markers.length > 0, 'the named refusal-marker table is gone')
  assert.match(markers, /name: 'at its limit'/)
  assert.match(markers, /name: 'already connected'/)
  assert.doesNotMatch(markers, /name: 'cannot'/,
    'a marker this broad fires on copy describing a legitimate permission boundary')
  assert.doesNotMatch(markers, /name: 'switched off'/,
    'a switched-off section deliberately contains the working control that turns it on')

  assert.match(qa, /REFUSAL_MARKERS\.find\(candidate => candidate\.pattern\.test\(text\)\)/,
    'the walk must consult the marker table for each stop, not a hardcoded regex')
  assert.match(qa, /for \(const stop of real\)/)
  assert.match(qa, /!stop\.disabled && stop\.ariaDisabled !== 'true' && stop\.ax\?\.disabled !== true/)
})

test('the default keyboard audit never presses Start while the live roster is explicit and fail-closed', () => {
  const qa = read('tools/a11y-keyboard-qa.mjs')

  assert.doesNotMatch(qa, /NOT EXERCISED/,
    'the default roster must not deterministically add an unmeasured paid-session check')
  assert.match(qa, /const PRESS_START = process\.argv\.includes\('--press-start'\)/,
    'a real session may be enabled only by the caller naming --press-start')

  const costlyPrecondition = qa.indexOf("check('the live Start/Stop audit has an enabled Start control'")
  const costlyGuard = qa.indexOf('if (start && !startProbe.disabled && PRESS_START)')
  const safeRefusal = qa.indexOf("check('Start with an empty prompt does not start anything'", costlyGuard)
  const realStart = qa.indexOf("check('Enter on Start starts a session'", costlyGuard)
  const phaseEnd = qa.indexOf('/* TEXT SCALING WHERE THE CONTROL ACTUALLY IS.', costlyGuard)
  assert.ok(costlyPrecondition >= 0 && costlyPrecondition < costlyGuard,
    'the live lane must fail if Start is missing or disabled rather than closing a smaller green roster')
  assert.ok(costlyGuard >= 0 && safeRefusal > costlyGuard && realStart > safeRefusal && phaseEnd > realStart,
    'every Enter on Start, including the empty-form refusal, must remain inside the --press-start-only section')

  const optInSection = qa.slice(costlyGuard, phaseEnd)
  assert.match(optInSection, /typeText\('Reply with the single word OK and stop\.'\)/)
  assert.match(optInSection, /check\('Enter on Stop ends the session'/,
    'the opt-in path must clean up the real session it starts')
  assert.match(optInSection, /stopped\.present && !stopped\.disabled/,
    'a changed status string alone must not masquerade as a started real session')

  assert.doesNotMatch(qa, /delete environment\.MC_SMOKE_HEADLESS/,
    'the unattended free lane must preserve the suite headless marker')
  assert.match(qa, /import \{ createSession \} from '\.\/test-account-harness\.mjs'/,
    'the keyboard audit must share the account harness transport whose CDP deadlines are behaviorally tested')
  assert.match(qa, /session = createSession\(port, child, \{\}\)/,
    'the keyboard audit must launch through the shared bounded CDP session')
  assert.doesNotMatch(qa, /function createSession\(/,
    'an untested local transport can send before registering its reply and wait forever')
})
