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

/* ------------------------------------------------------------------
   6. The home hero is sized by the window, in both axes.
   ------------------------------------------------------------------ */
/* The ring's 380px floor is a floor on the DIAMETER and knew nothing about
   width, so below the 900px stack it asked for a circle wider than the screen at
   every phone size in the register (380 into 280 at 320x568; 520 into 350 at
   390x844). .view is overflow: hidden, so nothing scrolls to the missing part --
   the hero is simply cut off. Held sideways the same floor overran the height
   instead: 380 into the 308px the stage leaves at 844x390. */
/* CALLED WITH VALUES, not read as text. This gate used to require the strings
   `window.innerWidth` and `window.innerHeight - 120` inside the ringSize
   expression, which is a test of how the view is WRITTEN: it failed the moment
   the same arithmetic was given a name (and it would have passed a version that
   mentioned innerWidth and ignored it). src/views/home.js now exports the
   arithmetic as a pure function, so every claim below is an answer the product
   actually gives. home.js itself cannot be imported here -- it carries
   `import '../home.css'` -- so the function is sliced out by name and
   evaluated, the technique tools/test/agent-chat-floor-drag-wiring.test.mjs
   uses on this same kind of helper. */
function extractFunction(name, source) {
  const start = source.indexOf(`export function ${name}`)
  assert.ok(start >= 0, `${name} was not found in home.js -- renamed, removed, or no longer exported`)
  const bodyOpen = source.indexOf('{', start)
  let depth = 0
  let end = bodyOpen
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    else if (source[end] === '}') { depth -= 1; if (depth === 0) { end += 1; break } }
  }
  return source.slice(start, end).replace(/^export\s+/, '')
}

const homeSource = readFileSync(path.join(SRC, 'views', 'home.js'), 'utf8')
const homeRingSize = new Function(`${extractFunction('homeRingSize', homeSource)}\nreturn homeRingSize;`)()

test('the home ring is bounded by the window it has to fit in', () => {
  /* Every phone in the register, upright and sideways: the circle must fit
     between the gutters and inside the height the stage leaves it. */
  for (const [width, height] of [[320, 568], [360, 800], [390, 844], [430, 932], [844, 390]]) {
    const gutter = Math.min(60, Math.max(20, width * 0.04))
    const size = homeRingSize(width, height)
    assert.ok(size <= width - 2 * gutter + 1e-9,
      `${width}x${height}: a ${size}px ring does not fit between the gutters of a ${width}px screen`)
    assert.ok(size <= height - 120 + 1e-9,
      `${width}x${height}: a ${size}px ring overruns the height the stage leaves`)
  }
})

test('the home ring fits the window at every offered text size', () => {
  /* The ring is written as a CSS px size inside the zoomed body, so at Large it
     paints 1.12x this number. MEASURED (electron 43.3.0): a 300px box under
     zoom 1.12 reports offsetHeight 300 and a 336px rect. The painted circle is
     what has to fit the window, so the window has to be divided before it is
     spent. */
  for (const zoom of [0.9, 1, 1.12]) {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1024, 768]]) {
      const painted = homeRingSize(width, height, zoom) * zoom
      const gutter = Math.min(60, Math.max(20, (width / zoom) * 0.04)) * zoom
      assert.ok(painted <= width - 2 * gutter + 1e-9,
        `zoom ${zoom} at ${width}x${height}: a ring painted ${painted}px wide does not fit a ${width}px window`)
      assert.ok(painted <= height - 120 * zoom + 1e-9,
        `zoom ${zoom} at ${width}x${height}: a ring painted ${painted}px tall overruns the window`)
    }
  }
  assert.equal(homeRingSize(1440, 900, 1), homeRingSize(1440, 900),
    'the zoom argument defaults to 1, so an untouched window is the untouched number')
})

/* THE DESKTOP IS UNTOUCHED, and this is the arithmetic rather than a promise.
   The ring's expression may only ever SHRINK the old value, and it must return
   the old value unchanged for every window a desktop can be. */
test('the home ring change cannot move a desktop window', () => {
  const before = (width, height) => Math.min(560, Math.max(380, height - 300))
  let moved = 0
  let grew = 0
  for (let width = 240; width <= 2560; width += 1) {
    for (let height = 300; height <= 1600; height += 1) {
      const a = before(width, height)
      const b = homeRingSize(width, height)
      if (b > a) grew += 1
      // 610: the narrowest width whose gutters still leave the 560px cap its full size (600 at the old 520 cap).
      if (width >= 610 && height >= 500 && Math.abs(a - b) > 1e-9) moved += 1
    }
  }
  assert.equal(grew, 0, 'the new bound may only ever shrink the ring')
  assert.equal(moved, 0, 'no window of at least 610x500 may change size')
})
