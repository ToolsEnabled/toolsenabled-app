/* "RESET TO THE BASIC ANSWERS" MUST RESET THE ANSWERS, NOT CLOSE THE WIZARD.
 *
 * WHAT HAND TESTING FOUND. A returning customer opens Settings -> "Walk through
 * setup again", lands on the review holding their real answers, and presses the
 * leftmost control. It arms ("Press again to reset to the Basic answers"). They
 * press again -- and the walkthrough is gone: the window is on the home screen,
 * nothing says what happened, and the only evidence that anything was destroyed
 * is that every answer is different the next time they look.
 *
 * WHY IT HAPPENED. The control is one function, skip(), wearing two labels. On a
 * FRESH install its job really is to leave -- "Skip the rest for now" -- and
 * leaving is what the last line of skip() does. On a CONFIGURED one the label
 * promises a reset and says nothing about leaving, but that same last line ran,
 * so the press did a second, larger thing nobody asked for and nothing named.
 *
 * WHAT THIS PINS. Both halves of the press on a configured profile: the reset
 * happens (answers back to Basic, applied and recorded), and the person stays on
 * the review with the result in front of them and a sentence naming it. The
 * first-run exit is pinned here too, because "never navigate" would strand a
 * fresh install on a step with no way out -- the trap this control exists to
 * prevent, and the one tools/test/setup-profile.test.mjs guards.
 *
 * DRIVEN, NOT READ. The whole defect was one reachable line, and a source
 * assertion that skip() "mentions navigate" is green on either side of it.
 * tools/test/setup-skip-confirms.test.mjs holds the source rules for the
 * confirmation; this holds the behaviour of the press, over the DOM stand-in.
 * A fresh module instance per case, because `liveWalk` is page-scoped state that
 * outlives a view and a reset deliberately keeps it (first-run-tier-screen.test.mjs
 * imports this same view that way, for the same reason).
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
const { SETUP_RESOLUTION, readSetupState } = await import('../../src/setup-state.js')
const { readStoredProfile } = await import('../../src/setup-profile.js')

const settle = async () => { for (let turn = 0; turn < 30; turn += 1) await Promise.resolve() }

/* A configured machine answered deliberately AWAY from the Basic answers, so
   the reset shows up in the stored record rather than being inferred. */
const CHOSEN = Object.freeze({ autonomy: 'observe', screens: 'demonstration', workspaceRoots: ['/work/customer'] })

let instance = 0

/** Mount the real view over the stand-in and hand back the glass. */
async function walkthrough({ configured = true, status = 'complete' } = {}) {
  const store = new Map()
  const dom = installDomStandIn(globalThis)
  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
  globalThis.window.dispatchEvent = () => true
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail } }
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  }
  globalThis.mcSetup = {
    bootstrap: { ok: true, available: true, configured, tier: configured ? 'standard' : null },
    chooseTier: async tier => ({ ok: true, tier }),
    workspaceState: async () => ({ ok: true, available: true, roots: ['/work/customer'], chosen: true }),
    setEditorImportPolicy: async () => ({ ok: true }),
  }
  globalThis.mcSettings = { set: async () => ({ ok: true }) }
  globalThis.mcProviders = { accountPolicy: async () => ({ ok: true }) }
  store.set('mc.setup.profile', JSON.stringify({ schemaVersion: 1, status, step: 'review', answers: CHOSEN }))
  Object.assign(SETUP_RESOLUTION, readSetupState(globalThis))

  instance += 1
  const { setupView } = await import(`../../src/views/setup.js?reset-keeps-walkthrough=${instance}`)
  const navigations = []
  const view = setupView({ navigate: destination => navigations.push(destination) })
  dom.document.body.appendChild(view.el)
  const stage = view.el.querySelector('[data-setup-section]')
  await settle()
  return {
    stage,
    navigations,
    /* The one control, wherever it is drawn: first-run's one-press exit carries
       its own attribute because it also records the lit level. */
    control: () => [...stage.querySelectorAll('button')]
      .find(button => button.hasAttribute('data-setup-skip') || button.hasAttribute('data-setup-skip-first')),
    async press() { this.control().click(); await settle() },
    finish() { view.destroy(); dom.restore() },
  }
}

test('a returning customer who resets to the Basic answers stays in the walkthrough', async () => {
  const walk = await walkthrough()
  assert.match(walk.stage.textContent, /Reset to the Basic answers/,
    'the walkthrough did not open on the review of a configured profile')

  await walk.press()
  assert.match(walk.stage.textContent, /Press again to reset to the Basic answers/, 'the first press did not arm the control')
  assert.deepEqual(walk.navigations, [], 'the arming press left the walkthrough')
  assert.equal(readStoredProfile().answers.autonomy, 'observe', 'the arming press already reset the answers')

  await walk.press()

  /* The reset itself still happens: that is what the label promises. */
  const stored = readStoredProfile()
  assert.equal(stored.answers.autonomy, 'autonomous', 'the second press did not reset the answers')
  assert.equal(stored.answers.screens, 'live', 'the second press did not reset the screens answer')

  /* And the person is still in the walkthrough, looking at what it did. */
  assert.deepEqual(walk.navigations, [],
    'the reset ejected the person out of the walkthrough; this control says it resets the answers and says nothing about leaving')
  assert.match(walk.stage.textContent, /Finish setup/,
    'the review is no longer on the glass after a reset, so the person can neither see nor keep the answers it wrote')
  assert.match(walk.stage.textContent, /Reset to the Basic answers/,
    'the control did not return to its resting label, so a further press is still armed')

  walk.finish()
})

test('the reset says what it reset, where the person is standing', async () => {
  const walk = await walkthrough()
  assert.equal(walk.stage.querySelectorAll('[data-setup-reset-applied]').length, 0,
    'the reset notice is drawn before anything has been reset')

  await walk.press()
  await walk.press()

  const notice = walk.stage.querySelector('[data-setup-reset-applied]')
  assert.ok(notice, 'nothing on the screen says the answers were reset, so the press is as silent as it was when it navigated away')
  assert.equal(notice.getAttribute('role'), 'status', 'the reset notice is not announced, so a screen reader meets that same silence')
  assert.match(notice.textContent, /Basic/, 'the notice does not name what the answers were reset to')

  walk.finish()
})

/* THE CONTROL. A fresh install has nothing to lose and its one press must still
   be a way OUT. setup-profile.test.mjs pins that this control is rendered, and a
   step whose only exit stops exiting is the trap the confirmation was added to
   avoid. */
test('on a fresh install the same control still leaves in one press', async () => {
  const walk = await walkthrough({ configured: false, status: 'in-progress' })
  assert.ok(walk.control(), 'the first-run walkthrough offers no way out at all')
  assert.match(walk.stage.textContent, /Skip the rest for now/, 'the first-run label promises a reset rather than an exit')

  await walk.press()
  assert.deepEqual(walk.navigations, ['#/'], 'the first-run exit no longer enters the application')

  walk.finish()
})
