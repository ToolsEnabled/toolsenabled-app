/* THE SETUP WALK AT 320px, AND THE PROOF THAT THE DESKTOP DID NOT MOVE.
 *
 * WHAT WAS MEASURED. `.seg > button` is 12.5px/600 in var(--font-ui) with
 * white-space: nowrap and 8px of side padding (settings.css .settings-seg).
 * Advance widths taken from the shipped face itself --
 * node_modules/@fontsource-variable/ibm-plex-sans, instanced at wght 600 -- not
 * estimated. A 320px screen leaves .view-pad a 288px column. Against it:
 *
 *   permission level (first screen)   561px   +273 over the column
 *   acting on its own                 562px   +274
 *   when it needs permission          507px   +219
 *   sessions found in your editor     423px   +135
 *   if an account runs out            409px   +121
 *   attaching to a session            321px    +33
 *   what the screens show             279px        fits
 *
 * .settings-seg caps the box at 100% and nothing caps the items, so the buttons
 * hang out of the trough, reach .view-pad -- overflow-y: auto, therefore
 * overflow-x: auto -- and the page pans sideways to ~594px. On the FIRST screen
 * body.first-run has already taken the topbar away, so a customer meets a page
 * 1.86x the width of their phone with no navigation on it, before they have used
 * the product at all.
 *
 * WHAT THIS SUITE CAN AND CANNOT DO. There is no DOM in these node tests, so
 * nothing below measures a rendered box -- the same limit
 * tools/test/mobile-size-floor.test.mjs states about itself. What IS checkable
 * at source, and is the assertion that matters most here, is that the repair is
 * unreachable above the breakpoint: a declaration inside @media (max-width:
 * 620px) cannot match at 621px, and a shared file that was not edited cannot
 * have changed. Both are pinned below, in both directions.
 *
 * AND THE WORDS. The three permission levels and the autonomy answers are
 * consent surfaces. A layout fix that quietly shortened one would be a change to
 * what a person is agreeing to, so every option's text is pinned here verbatim,
 * by count and by string.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TIER_CHOICES, TIER_IDS } from '../../src/setup-state.js'
import { AUTONOMY_CHOICES, SCREENS_CHOICES, PROFILE_INTENT } from '../../src/setup-profile.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8')

const SETUP_CSS = read('src', 'setup.css')
const STYLES_CSS = read('src', 'styles.css')
const SETTINGS_CSS = read('src', 'settings.css')
const COMPONENTS = read('src', 'components.js')
const VIEW = read('src', 'views', 'setup.js')

/* The phone step this repair takes. Named once: every assertion below reads it
   rather than repeating the number, so the two cannot drift apart. */
const PHONE_MAX = 620

/* Prose in this codebase quotes the declarations it explains, so a reader that
   treated comments as rules would fail on the explanation. Same stripper
   tools/test/mobile-size-floor.test.mjs uses, and for the same reason. */
const stripCssComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** Flatten a sheet to { atRule, selector, body }, one entry per declaration block. */
function cssRules(text) {
  const cleaned = stripCssComments(text)
  const rules = []
  const stack = []
  let index = 0
  let head = ''
  while (index < cleaned.length) {
    const character = cleaned[index]
    if (character === '{') {
      const selector = head.trim()
      head = ''
      if (selector.startsWith('@')) {
        stack.push(selector)
        index += 1
        continue
      }
      const close = cleaned.indexOf('}', index)
      const end = close === -1 ? cleaned.length : close
      rules.push({ atRule: stack.join(' '), selector, body: cleaned.slice(index + 1, end) })
      index = end + 1
      continue
    }
    if (character === '}') { stack.pop(); head = ''; index += 1; continue }
    head += character
    index += 1
  }
  return rules
}

const SETUP_RULES = cssRules(SETUP_CSS)
const phoneQuery = atRule => {
  const match = /max-width\s*:\s*(\d+)px/.exec(atRule || '')
  return match ? Number(match[1]) : null
}

/* Every rule this repair added that reaches the seg control. Derived from the
   sheet, never listed by hand -- a hand-kept list is a list that stops matching
   the sheet it claims to describe. */
const SEG_RULES = SETUP_RULES.filter(rule => /\.seg(\b|-)/.test(rule.selector) && !rule.selector.includes(':has(.seg)'))

/* ------------------------------------------------------------------
   1. THE DESKTOP CANNOT REACH ANY OF IT.  This is the owner's constraint --
      "we cannot let mobile development change the main app or the normal site"
      -- and it is the one assertion here a source test can settle outright.
   ------------------------------------------------------------------ */

test('every seg rule this sheet declares is inside a phone media query', () => {
  assert.ok(SEG_RULES.length > 0, 'setup.css no longer re-presents the seg on a phone')
  for (const rule of SEG_RULES) {
    const breakpoint = phoneQuery(rule.atRule)
    assert.ok(
      breakpoint !== null,
      `setup.css declares "${rule.selector}" outside a media query, so it lands on the desktop too`,
    )
    assert.ok(
      breakpoint <= PHONE_MAX,
      `"${rule.selector}" is scoped at ${breakpoint}px, wider than the ${PHONE_MAX}px phone step`,
    )
  }
})

test('action wrapping stays scoped to setup and never clips controls', () => {
  const wraps = SETUP_RULES.filter(rule => /flex-wrap|flex-basis/.test(rule.body))
  assert.ok(wraps.length > 0, 'the setup action bar no longer wraps')
  for (const rule of wraps) {
    assert.match(rule.selector, /\.setup-(page|actions|readiness-actions)/)
    assert.doesNotMatch(rule.body, /overflow\s*:\s*hidden/)
  }
})

test('every phone rule is scoped to the setup walk, never to the seg control at large', () => {
  for (const rule of SETUP_RULES) {
    if (phoneQuery(rule.atRule) === null) continue
    for (const part of rule.selector.split(',')) {
      assert.match(
        part.trim(),
        /^\.setup-page(\s|$)/,
        `"${part.trim()}" is a phone rule that is not anchored to .setup-page, so it can reach another route`,
      )
    }
  }
})

/* THE SHARED CONTROL WAS NOT EDITED, and this checks the recipe rather than
   promising it. If any of these move, the desktop seg has moved with them. */
test('the desktop seg recipe in styles.css is exactly what it was', () => {
  const rules = cssRules(STYLES_CSS)
  const container = rules.find(rule => rule.selector === '.seg:where(:has(> button))')
  assert.ok(container, 'the seg trough is gone')
  assert.equal(phoneQuery(container.atRule), null, 'the seg trough is now width-conditional')
  assert.match(container.body, /display\s*:\s*inline-flex/)
  assert.match(container.body, /height\s*:\s*var\(--seg-h\)/)

  const button = rules.find(rule => rule.selector === '.seg > button')
  assert.ok(button, 'the seg button is gone')
  assert.equal(phoneQuery(button.atRule), null, 'the seg button is now width-conditional')
  assert.match(button.body, /white-space\s*:\s*nowrap/)
  assert.match(button.body, /font-size\s*:\s*12\.5px/)

  const indicator = rules.find(rule => rule.selector === '.seg-ind')
  assert.ok(indicator, 'the seg indicator is gone')
  assert.equal(phoneQuery(indicator.atRule), null, 'the seg indicator is now width-conditional')
  assert.match(indicator.body, /top\s*:\s*3px/)
  assert.match(indicator.body, /bottom\s*:\s*3px/)
  assert.match(indicator.body, /opacity\s*:\s*0/, 'the indicator no longer rests hidden')

  /* The .on fallback that paints when the helper has not measured yet. The
     phone mark is a SECOND mark, never a replacement for this one. */
  assert.ok(
    rules.some(rule => rule.selector === '.seg:not(:has(> .seg-ind.ready)) > button.on'),
    'the unmeasured-indicator fallback is gone, so an option could carry no mark at all',
  )

  /* settings.css is the other half of the desktop recipe. */
  assert.ok(
    cssRules(SETTINGS_CSS).some(rule => rule.selector === '.settings-seg > button'
      && /padding-inline\s*:\s*var\(--s2\)/.test(rule.body)
      && phoneQuery(rule.atRule) === null),
    'the settings seg padding moved',
  )
})

test('attachSeg still knows one axis only, so no route is measured differently', () => {
  const body = /export function attachSeg\(group\) \{[\s\S]*?\n\}/.exec(COMPONENTS)
  assert.ok(body, 'attachSeg is gone')
  const source = body[0]
  assert.match(source, /ind\.style\.width = `\$\{on\.offsetWidth\}px`/)
  assert.match(source, /ind\.style\.transform = `translateX\(\$\{on\.offsetLeft\}px\)`/)
  /* The repair deliberately did not teach it a second axis. If one appears, the
     desktop indicator is being positioned by new arithmetic and this proof no
     longer holds -- rewrite the proof before rewriting the function. */
  assert.doesNotMatch(
    source,
    /offsetTop|offsetHeight|translateY|matchMedia|innerWidth/,
    'attachSeg gained a second axis or a width branch; the desktop can no longer be assumed unmoved',
  )
})

/* ------------------------------------------------------------------
   2. NOTHING IS HIDDEN, AND NOTHING IS RE-WORDED.
   ------------------------------------------------------------------ */

test('no phone rule on the setup walk switches anything off', () => {
  for (const rule of SETUP_RULES) {
    if (phoneQuery(rule.atRule) === null) continue
    assert.doesNotMatch(
      rule.body,
      /(?:^|;|\s)display\s*:\s*none/,
      `"${rule.selector}" hides something because the screen is narrow`,
    )
    assert.doesNotMatch(
      rule.body,
      /(?:^|;|\s)visibility\s*:\s*hidden/,
      `"${rule.selector}" hides something because the screen is narrow`,
    )
  }
})

test('the phone seg wraps the words rather than clipping them', () => {
  const button = SEG_RULES.find(rule => rule.selector === '.setup-page .seg > button')
  assert.ok(button, 'the phone seg row is gone')
  assert.match(button.body, /white-space\s*:\s*normal/, 'the phone rows still refuse to wrap')
  for (const rule of SEG_RULES) {
    assert.doesNotMatch(
      rule.body,
      /text-overflow|line-clamp|overflow\s*:\s*hidden/,
      `"${rule.selector}" cuts an option's words to make it fit`,
    )
  }
})

/* A contained scroll would clip the 3.5px focus ring .seg > button:focus-visible
   paints outside the button, which is why the repair stacks instead. */
test('the phone seg is not a scroll box', () => {
  for (const rule of SEG_RULES) {
    assert.doesNotMatch(
      rule.body,
      /overflow(-x|-y)?\s*:\s*(auto|scroll)/,
      `"${rule.selector}" scrolls, which clips the focus ring on the option inside it`,
    )
  }
})

test('the selected option still carries a mark, and it is not the focus ring', () => {
  const on = SEG_RULES.find(rule => rule.selector === '.setup-page .seg > button.on')
  assert.ok(on, 'the phone seg has no rule for the chosen option')
  assert.match(
    on.body,
    /background\s*:\s*var\(--sheet\)/,
    'the chosen row does not carry the fill the desktop chip uses',
  )
  /* .seg > button:focus-visible paints its ring with box-shadow. A shadow here
     outranks it and would erase the ring on the selected row. */
  assert.doesNotMatch(
    on.body,
    /box-shadow/,
    'the chosen row paints a box-shadow, which overrides the focus ring on that row',
  )
})

test('every permission level still has a button, with its own words', () => {
  assert.deepEqual(TIER_IDS, ['guided', 'standard', 'unrestricted'])
  assert.deepEqual(TIER_CHOICES.map(choice => choice.label), [
    'I’m new to this',
    'I’ve used AI coding tools before',
    'I run agents with permissions bypassed',
  ])
  /* One button per choice, from the list itself: an option cannot be dropped
     from the control without being dropped from the list. */
  assert.match(VIEW, /TIER_CHOICES\.map\(choice => choiceMarkup\(choice, lit\)\)/)
  assert.match(
    VIEW,
    /<button type="button" class="setup-choice-card" data-setup-choice=/,
    'the permission choices must be native keyboard-accessible buttons',
  )
})

test('every autonomy and screens answer still has its own words', () => {
  assert.deepEqual(AUTONOMY_CHOICES.map(choice => choice.label), [
    'Nothing yet — let me look around first',
    'Act when I start it',
    /* 0fe7fecb dropped "and tell me after" from this label in the same hunk
       that narrowed the option's detail, so the words were withdrawn on
       purpose rather than lost. Anchored to what the product ships. */
    'Act on its own',
  ])
  assert.deepEqual(SCREENS_CHOICES.map(choice => choice.label), [
    'My own activity',
    'A labelled demonstration',
  ])
  assert.match(VIEW, /AUTONOMY_CHOICES\.map\(choice => `<button type="button" class="setup-choice-card" data-setup-set="autonomy"/)
})

test('every review seg still offers the same options in the same order', () => {
  assert.deepEqual(
    PROFILE_INTENT.map(field => [field.id, field.order.map(value => field.labels[value])]),
    [
      ['approvals', ['Stop and ask me', 'Work on something else while it waits', 'Use its own judgement']],
      ['attach', ['Watch it only', 'Continue it in a copy', 'Take it over']],
      ['ideImport', ['Do not bring any in', 'Ask me each time', 'Bring in everything it finds']],
      ['failover', ['Stop and let me switch', 'Switch to another account automatically']],
    ],
  )
})

/* ------------------------------------------------------------------
   3. THE THEME IS THE TOKEN LAYER, AND ONLY THE TOKEN LAYER.
   ------------------------------------------------------------------ */

const COLOUR_PROPERTY =
  /(^|;|\s)(color|background|background-color|border-color|border-left-color|border-right-color|border-top-color|border-bottom-color|box-shadow|outline-color|fill|stroke)\s*:\s*([^;]+)/g

test('no phone rule introduces a colour of its own', () => {
  for (const rule of SETUP_RULES) {
    if (phoneQuery(rule.atRule) === null) continue
    for (const match of rule.body.matchAll(COLOUR_PROPERTY)) {
      const value = match[3].trim()
      if (/^(transparent|inherit|currentColor|none|initial|unset)$/i.test(value)) continue
      assert.match(
        value,
        /var\(--/,
        `"${rule.selector}" sets ${match[2]} to ${value}, which is not from the token layer`,
      )
      assert.doesNotMatch(
        value,
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
        `"${rule.selector}" sets ${match[2]} with a literal colour`,
      )
    }
  }
})

/* Sizes, spacing and radii come from the step scale too, with no exceptions:
   every length in the phone block is a token or a multiple of one. */
test('no phone rule invents a size, a step or a radius', () => {
  const SIZED =
    /(^|;|\s)(gap|padding|padding-block|padding-inline|margin|min-height|height|border-radius|font-size)\s*:\s*([^;]+)/g
  for (const rule of SETUP_RULES) {
    if (phoneQuery(rule.atRule) === null) continue
    for (const match of rule.body.matchAll(SIZED)) {
      const value = match[3].trim()
      if (/^(auto|0|100%|inherit|initial|unset)$/.test(value)) continue
      assert.match(
        value,
        /var\(--s\d\)|var\(--seg-h\)|var\(--r-\w+\)|calc\(\s*var\(--s\d\)/,
        `"${rule.selector}" sets ${match[2]} to ${value}, which is not a step from the scale`,
      )
    }
  }
  /* No bare length at all. The `2px solid transparent` left rule
     .setup-choice[aria-current='true'] uses is deliberately NOT copied here:
     the forced-colors block in styles.css records that a transparent border is
     painted in the system colour, which marked every row. */
  for (const rule of SEG_RULES) {
    assert.doesNotMatch(
      rule.body,
      /border(-\w+)?\s*:\s*[^;]*transparent/,
      `"${rule.selector}" leans on a transparent border, which forced colors paints on every row`,
    )
  }
})

/* THE OTHER HALF OF THE MARK, and it is inherited rather than written: forced
   colors flattens both the desktop chip and this fill to the same system pair,
   and styles.css already answers that for `.seg > button.on` with an underline.
   The phone row is that same element, so it is covered by that same rule -- but
   only for as long as the rule stays keyed on `.on` rather than on the
   indicator, which is what this pins. */
test('the chosen option keeps a mark when forced colors flattens the fill', () => {
  const forced = cssRules(STYLES_CSS).filter(rule => /forced-colors\s*:\s*active/.test(rule.atRule))
  const underline = forced.find(rule => /(^|,)\s*\.seg > button\.on(\s*,|$)/.test(rule.selector))
  assert.ok(underline, 'forced colors no longer marks the chosen seg option')
  assert.match(underline.body, /text-decoration\s*:\s*underline/)
  assert.ok(
    forced.some(rule => rule.selector === '.seg-ind' && /display\s*:\s*none/.test(rule.body)),
    'the indicator is no longer stood down in forced colors',
  )
})
