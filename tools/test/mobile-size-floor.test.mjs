/* THE PHONE FLOOR, PINNED AT SOURCE.
 *
 * The owner's instruction: "we need to be mindful of all screen sizes and phone
 * types". The renderer is served on the public web at /app/, so a phone gets
 * exactly this code. The register these gates are written against:
 *
 *   320 x 568   the floor -- iPhone SE 1st gen, and the narrowest Android in use
 *   360 x 800   most Android
 *   390 x 844   iPhone 14/15
 *   430 x 932   Pro Max / Ultra
 *   844 x 390   the same phones, held sideways
 *
 * WHAT A SOURCE TEST CAN AND CANNOT DO HERE. This repository has no DOM in its
 * node tests, so nothing below measures a rendered box -- each gate pins the
 * DECLARATION that a measurement proved wrong, so that the same declaration
 * cannot come back. Findings that need a real browser to confirm are named in
 * the pass report that accompanied this file and are deliberately NOT asserted
 * here: a gate that claims coverage it does not have is worse than no gate.
 *
 * THE ONE GENERAL RULE, and it is the owner's, twice stated: a control that
 * vanishes on a phone is a path that exists on one device and not another. So
 * no narrow-width media query may switch a control off. State may (a size
 * switch has nothing to size when there are no tiles); width may not.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')

const read = (...parts) => readFileSync(path.join(SRC, ...parts), 'utf8')

/* Prose in this codebase quotes the very declarations it is explaining -- every
   fix below carries a comment naming the value it replaced -- so a gate that
   reads comments as rules would fail on its own explanation. */
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
      rules.push({
        atRule: stack.join(' '),
        selector,
        body: cleaned.slice(index + 1, end),
      })
      index = end + 1
      continue
    }
    if (character === '}') {
      stack.pop()
      head = ''
      index += 1
      continue
    }
    head += character
    index += 1
  }
  return rules
}

/* ------------------------------------------------------------------
   1. The topbar's chevrons and gear reach the screen at 320.
   ------------------------------------------------------------------ */
/* MEASURED before the fix: .topbar is min(--topbar-max, 100% - 2 * --page-gutter),
   so a 320px screen gives it a 288px box with 284px of content. .tb-side carried
   min-width: 200px -- the balance for a breadcrumb this markup no longer has --
   and two un-shrinkable 200px items in 284px overflow a space-between row to the
   right, landing the right-hand group at x=218..418 at EVERY width below 436px.
   At 320, 360 and 390 the gear and the forward chevron were off screen, and the
   chevrons plus that gear are the only navigation this product has. */
test('the topbar sides fit the 320px floor', () => {
  const rules = cssRules(read('styles.css')).filter(rule => /(^|,|\s)\.tb-side(\s|,|$|\.)/.test(rule.selector))
  assert.ok(rules.length > 0, '.tb-side must still be styled')
  for (const rule of rules) {
    const floor = /min-width\s*:\s*(\d+(?:\.\d+)?)px/.exec(rule.body)
    if (!floor) continue
    /* Two of these sit in one 284px row with an 8px gap between their contents,
       so neither may declare a floor that two of them cannot pay. */
    assert.ok(
      Number(floor[1]) * 2 <= 284,
      `.tb-side min-width ${floor[1]}px puts the topbar controls off a 320px screen`,
    )
  }
})

/* ------------------------------------------------------------------
   2. The quick-settings drawer stays inside the window.
   ------------------------------------------------------------------ */
/* Pinned at right: 14px, a literal 320px width hangs 14px off the LEFT edge of a
   320px screen. The cap must be conditional on the window, never a bare length. */
test('the settings drawer width is capped by the window', () => {
  const rule = cssRules(read('styles.css')).find(entry => entry.selector === '.drawer')
  assert.ok(rule, '.drawer must still be styled')
  const width = /(?:^|;|\s)width\s*:\s*([^;]+)/.exec(rule.body)
  assert.ok(width, '.drawer must declare a width')
  const value = width[1].trim()
  const bareLength = /^\d+(?:\.\d+)?px$/.test(value)
  assert.ok(
    !bareLength,
    `.drawer width ${value} overhangs a screen narrower than that plus its 28px of inset`,
  )
  assert.match(value, /min\s*\(/, '.drawer width must be a min() against the window')
})

/* ------------------------------------------------------------------
   3. The ledger/approvals figure strip folds instead of overflowing.
   ------------------------------------------------------------------ */
/* Five equal tracks of a 288px content box are 57.6px each; --s2 either side
   leaves 41.6px of text for 11px caps labels whose longest single WORD
   ("PURCHASES", on the approvals screen that shares this strip) is ~73px. A word
   that cannot fit its box does not wrap -- it hangs out of it, reaches .view-pad,
   and the page pans sideways. The strip must stop being a fixed count below the
   width where five across can hold that word (~477px). */
test('the ledger figure strip drops its fixed track count on a phone', () => {
  const rules = cssRules(read('ledger.css')).filter(rule => rule.selector === '.ledger-summary')
  assert.ok(rules.length >= 2, '.ledger-summary must carry a narrow-width rule as well as its base')
  const narrow = rules.filter(rule => /max-width\s*:\s*(\d+)px/.test(rule.atRule))
  assert.ok(narrow.length > 0, '.ledger-summary must be re-declared under a max-width query')
  for (const rule of narrow) {
    const breakpoint = Number(/max-width\s*:\s*(\d+)px/.exec(rule.atRule)[1])
    assert.ok(breakpoint >= 477, `the strip must fold at or above 477px, not ${breakpoint}px`)
    assert.match(
      rule.body,
      /auto-fit/,
      'the narrow strip must size itself from the track, not from a track count',
    )
  }
})

/* ------------------------------------------------------------------
   4. The metrics stat strip folds instead of overflowing.
   ------------------------------------------------------------------ */
/* .stat .tl is 11px caps at --track-caps and white-space: nowrap -- it must be,
   the tile is a four-row grid whose label row is a measured 14px -- and the
   longest labels ("DID NOT START", "LAST 24 HOURS") measure ~112px against the
   78.7px a third of a 320px page column gives them. Three across needs ~429px. */
test('the metrics stat strip has a step below three across', () => {
  const rules = cssRules(read('metrics.css')).filter(rule => rule.selector === '.m-strip')
  const steps = rules
    .map(rule => ({ rule, match: /max-width\s*:\s*(\d+)px/.exec(rule.atRule) }))
    .filter(entry => entry.match)
    .map(entry => ({ breakpoint: Number(entry.match[1]), body: entry.rule.body }))
  assert.ok(steps.length >= 2, '.m-strip must carry more than the one 1100px step')
  const phone = steps.filter(step => step.breakpoint <= 480)
  assert.ok(phone.length > 0, '.m-strip must have a step at or below 480px')
  for (const step of phone) {
    const columns = /repeat\(\s*(\d+)\s*,/.exec(step.body)
    assert.ok(columns, `the ${step.breakpoint}px step must state its track count`)
    assert.ok(
      Number(columns[1]) <= 2,
      `${columns[1]} tracks at ${step.breakpoint}px does not hold a 112px nowrap label`,
    )
  }
})

/* ------------------------------------------------------------------
   5. No control is switched off because the screen is narrow.
   ------------------------------------------------------------------ */
/* The owner's rule, and the reason .size-seg came back: S/M/L sets --pv-h, the
   tile height, which the same breakpoint family still applies once tiles stack.
   The control did something and only the phone was denied it.
   Scope: max-width queries at or below 720px (the widths only a phone or a
   phone held sideways reports) and selectors whose last compound names a
   control. State-based hides -- a control with nothing to act on -- are not
   width-based and are not caught, correctly. */
const CONTROL_WORD = /(seg|btn|button|toggle|control|action|chevron|switch)/i
test('no narrow-width media query hides a control', () => {
  const sheets = ['styles.css', 'ledger.css', 'metrics.css', 'comms.css', 'settings.css', 'setup.css',
    // Guide content now lives in Settings (included above); its shared
    // disclosure controls use guided-step.css, not the retired guide sheet.
    'research.css', 'guided-step.css', 'home.css', 'board.css', 'agent.css', 'tree-graph.css',
    'owner-popup.css', 'agent-compose-panel.css', 'metrics-layout.css', 'fleet-profile-settings.css']
  const offences = []
  for (const sheet of sheets) {
    for (const rule of cssRules(read(sheet))) {
      const query = /max-width\s*:\s*(\d+)px/.exec(rule.atRule)
      if (!query || Number(query[1]) > 720) continue
      if (!/(?:^|;|\s)display\s*:\s*none/.test(rule.body)) continue
      for (const part of rule.selector.split(',')) {
        const compound = part.trim().split(/[\s>+~]/).filter(Boolean).pop() || ''
        if (compound.includes('::')) continue          // a pseudo-element is decoration
        if (!CONTROL_WORD.test(compound)) continue
        offences.push(`${sheet} @${query[1]}px ${part.trim()}`)
      }
    }
  }
  assert.deepEqual(offences, [], 'a control hidden by width is a path one device has and another does not')
})
