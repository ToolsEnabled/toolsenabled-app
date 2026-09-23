/* THE GOOGLE SIGN-IN CONTROL THAT CANNOT BE PRESSED HAS TO LOOK LIKE ONE.
 *
 * THE DEFECT THIS FILE EXISTS TO END, reported by the owner against the build
 * on the site: "sign in with google in the version on the site -> when i
 * download and open and press sign in to google it doesnt work".
 *
 * What was actually on the screen, measured by driving the app rather than by
 * reading it: src/account-markup.js googleOptionMarkup() rendered its
 * `unavailable` row correctly -- data-google-state="unavailable",
 * data-google-code="GOOGLE_SIGNIN_NOT_CONFIGURED", a heading saying "not
 * available on this copy" and a sentence naming what works instead -- and the
 * button under it carried `disabled`. But its COMPUTED style in the running
 * window was `cursor: pointer`, `opacity: 1`, the full white .ctl-btn card with
 * --elev-1 under it, and the unconditional `.ctl-btn:hover` in styles.css
 * lifting it 1px when the pointer crossed it. Nothing about it read as off. So
 * a person presses it, `disabled` eats the click, and the product answers with
 * silence -- which is indistinguishable from broken, and is what was reported.
 *
 * WHY NO RULE APPLIED. The sign-in question renders into
 * `section.settings-section.setup-section`, on both surfaces it appears on. Every
 * `.ctl-btn:disabled` rule in the product is scoped somewhere else --
 * .board-page, .computers .stats-page, .agentv-panels .ctl-actions, and
 * .fleet-profile-section -- and this screen is none of them. Confirmed in the
 * shipped artifact as well as the tree.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. It cannot run a cascade: there is no
 * DOM here. What it can do, and what a per-string check could not, is hold the
 * three facts that together made the defect possible:
 *
 *   1. which controls googleOptionMarkup() actually renders `disabled`, taken
 *      from the builder itself rather than from a list written here;
 *   2. that an off-state rule for those controls exists and is scoped by an
 *      attribute the row genuinely carries, so it can reach them; and
 *   3. that the stylesheet holding it is imported by BOTH views that render the
 *      row -- the account screen and the first-run walkthrough. The rule that
 *      was missing had a sibling four lines away in the same file; what it did
 *      not have was a selector that matched this screen.
 *
 * The rendered proof is a driven window, not this file. This is what stops the
 * rule being deleted again by somebody who cannot see what it is holding up.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { googleOptionMarkup } from '../../src/account-markup.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

/* The stylesheet the rule lives in, and the two views that must receive it. */
const STYLESHEET = 'src/fleet-profile-settings.css'
const VIEWS = Object.freeze(['src/views/account.js', 'src/views/setup.js'])

/* The attribute the row carries on every state, and therefore the only ancestor
   hook a rule may legitimately be scoped by. Taken from the builder below rather
   than trusted: if the row stops carrying it, the scoped rule stops matching and
   this file has to say so. */
const ROW_HOOK = '[data-google-signin]'

/* Every state googleOptionMarkup() can be asked for. `unknown` is the row before
   the shell has answered, `unavailable` is the state this machine is in until
   the owner registers a Desktop client, and the last two are the configured
   product. Written as inputs to the real builder, so a state that changes shape
   changes what this file measures. */
const STATES = Object.freeze([
  { name: 'unknown — still asking the shell', input: { google: null, busy: false } },
  {
    name: 'unavailable — no Google application id on this copy',
    input: {
      google: {
        available: false,
        code: 'GOOGLE_SIGNIN_NOT_CONFIGURED',
        reason: 'This copy has not been given a Google sign-in application id yet, so signing in with Google is not available. Making an account on this computer works now and does the same job.',
      },
      busy: false,
    },
  },
  { name: 'available — configured and idle', input: { google: { available: true, source: 'shipped', testProvider: null }, busy: false } },
  { name: 'available — a sign-in is waiting for the browser', input: { google: { available: true, source: 'shipped', testProvider: null }, busy: true } },
])

/* ------------------------------ reading the markup ------------------------------ */

/** Every <button ...> opening tag in a fragment, as raw text. */
function buttonTags(markup) {
  return markup.match(/<button\b[^>]*>/g) || []
}

const isDisabled = tag => /\sdisabled(\s|=|>)/.test(tag)

/* ------------------------------- reading the CSS ------------------------------- */

/** Rules as { selector, body }, with comments removed first so a selector quoted
    inside a comment can never be mistaken for a rule that exists. */
function rulesOf(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@')) continue
    rules.push({ selector, body: match[2] })
  }
  return rules
}

/** The declared value of one property in a rule body, or null. */
function declaration(body, property) {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)
  return match ? match[1].trim() : null
}

/** Does this selector list contain a selector that turns off a .ctl-btn inside
    the Google row? Scoped by the row's own attribute, or unscoped -- anything
    scoped by a class this screen does not carry is what the defect WAS. */
function coversTheRow(selector) {
  return selector.split(',').some(one => {
    const part = one.trim()
    if (!/\.ctl-btn\b/.test(part)) return false
    if (!/:disabled|\[aria-disabled/.test(part)) return false
    if (/:hover|:focus|:active/.test(part)) return false
    const scope = part.slice(0, part.indexOf('.ctl-btn')).trim()
    return scope === '' || scope === ROW_HOOK
  })
}

/** The same, for the hover state. `.ctl-btn:hover` in styles.css is
    unconditional, so an off-state rule without this is undone by the pointer. */
function coversTheRowOnHover(selector) {
  return selector.split(',').some(one => {
    const part = one.trim()
    if (!/\.ctl-btn\b/.test(part) || !/:hover/.test(part)) return false
    if (!/:disabled|\[aria-disabled/.test(part)) return false
    const scope = part.slice(0, part.indexOf('.ctl-btn')).trim()
    return scope === '' || scope === ROW_HOOK
  })
}

/* ---------------------------------- the tests ---------------------------------- */

test('the Google option still offers the control it explains, in every state', () => {
  for (const state of STATES) {
    const markup = googleOptionMarkup(state.input)
    assert.ok(
      markup.includes('data-google-signin-start'),
      `the Google option renders no sign-in control at all in the "${state.name}" state. `
      + 'Hiding it is not the repair: a person told to sign in with Google would be hunting '
      + 'for a control that is not there, and the owner\'s remaining setup step would be invisible.',
    )
    assert.ok(markup.includes(ROW_HOOK.slice(1, -1)), `the "${state.name}" row no longer carries ${ROW_HOOK}, so every rule scoped by it stops matching`)
  }
})

test('a configured, idle Google option is a LIVE control', () => {
  /* The guard on the guard. Without this, everything below could be satisfied by
     disabling the button in every state, which would pass a styling gate and
     ship a product nobody can sign in to. */
  const markup = googleOptionMarkup({ google: { available: true, source: 'shipped', testProvider: null }, busy: false })
  const [button] = buttonTags(markup).filter(tag => tag.includes('data-google-signin-start'))
  assert.ok(button, 'the configured Google option renders no sign-in button')
  assert.ok(!isDisabled(button), 'the Google sign-in button is disabled even when Google sign-in is configured and idle')
})

test('every disabled Google control is covered by an off-state rule that reaches this screen', () => {
  const disabledStates = STATES.filter(state => buttonTags(googleOptionMarkup(state.input))
    .filter(tag => tag.includes('data-google-signin-start'))
    .some(isDisabled))

  /* If no state renders a disabled control there is nothing to style, and this
     file would be passing by measuring nothing -- the failure mode
     tools/check-suites-discovered.mjs exists to refuse. */
  assert.ok(
    disabledStates.length > 0,
    'googleOptionMarkup() no longer renders a disabled control in any state, so this gate is measuring nothing. '
    + 'If that is deliberate, this file needs rewriting rather than deleting.',
  )

  const rules = rulesOf(read(STYLESHEET))
  const off = rules.find(rule => coversTheRow(rule.selector))
  assert.ok(
    off,
    `${STYLESHEET} has no rule that turns off a .ctl-btn inside ${ROW_HOOK}, so the disabled Google control in `
    + `${disabledStates.map(state => `"${state.name}"`).join(', ')} paints exactly like a live one: `
    + 'cursor: pointer, opacity 1, the full card and the hover lift. That is the shipped defect -- '
    + 'the owner pressed it, disabled ate the click, and the product answered with silence. '
    + 'Every .ctl-btn:disabled rule in the product is scoped to .board-page, .computers .stats-page, '
    + '.agentv-panels .ctl-actions or .fleet-profile-section, and this row is inside none of them.',
  )

  assert.equal(
    declaration(off.body, 'cursor'), 'not-allowed',
    'the off-state rule does not set cursor: not-allowed, so the pointer still says the control can be pressed',
  )
  const opacity = Number(declaration(off.body, 'opacity'))
  assert.ok(
    Number.isFinite(opacity) && opacity > 0 && opacity < 1,
    'the off-state rule does not dim the control, so it is still the same weight on the screen as a live button',
  )
  assert.equal(
    declaration(off.body, 'transform'), 'none',
    'the off-state rule does not cancel the transform, so the control still moves like a live one',
  )

  assert.ok(
    rules.some(rule => coversTheRowOnHover(rule.selector)),
    `${STYLESHEET} turns the control off but does not neutralise :hover. `
    + '.ctl-btn:hover in src/styles.css is unconditional -- it brightens the background, darkens the ink to '
    + '--ink and lifts the button 1px -- so a dimmed button comes back to life at the exact moment a person '
    + 'is deciding whether to press it.',
  )
})

test('the stylesheet holding that rule reaches both screens the row appears on', () => {
  /* The account screen and the first-run walkthrough render the same builder.
     A rule delivered to one of them and not the other is the defect again, on
     whichever surface was missed -- and the walkthrough is the one a stranger
     meets first. */
  const stylesheet = path.posix.basename(STYLESHEET)
  for (const view of VIEWS) {
    const source = read(view)
    /* Anchored on the control's own hook rather than on the builder's name:
       account.js reaches googleOptionMarkup() through the composed account
       markup and never names it, while both views handle the press by that
       selector. A view that stops handling it is a view the row has left. */
    assert.ok(
      source.includes('data-google-signin-start'),
      `${view} no longer handles the Google sign-in control, so this file is guarding a screen that has moved`,
    )
    assert.ok(
      new RegExp(`import\\s+['"][^'"]*${stylesheet.replace('.', '\\.')}['"]`).test(source),
      `${view} does not import ${stylesheet}, so the rule that turns the disabled Google control off never `
      + 'reaches that screen and the button paints as a live control there.',
    )
  }
})
