/* A MEDIA QUERY IS NOT A PRIORITY, AND THE NARROW RAIL IS WHERE THAT COST
 * SOMETHING.
 *
 * `@media` adds no specificity. So the moment the settings page grew its own
 * desktop rail treatment -- `.settings-page .settings-rail`, two classes --
 * every declaration in it outranked the narrow-window block above it, which is
 * written as `.settings-rail`, one class. THE NARROW RAIL IS NOT A CARD. It is
 * the full-width bar across the top of the page, one scrolling line carrying
 * every category, and the sheet draws it as a bar on purpose: opaque, square,
 * flat, ruled off underneath, with room between the categories so they can be
 * told apart and hit. It silently became a translucent, rounded, shadowed card
 * with tighter gaps, stretched across the whole window. The compact-width
 * "overlap" that showed up in review was that leak, seen.
 *
 * WHAT THIS FILE HOLDS is the cascade itself, resolved the way a browser
 * resolves it: every rule in src/settings.css that names this element, filtered
 * by whether its `@media` condition holds at a given window width, then ranked
 * by specificity and source order. That is the model that was gotten wrong, so
 * that is the model asserted -- a later rule that re-introduces the leak by
 * out-specifying the bar fails here by name, in whichever block it is written.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD is `position`. At this width the layout is
 * a single column, so the rail's grid area is exactly its own height and a
 * sticky rail has no distance to travel inside it. Sticky or relative, the bar
 * scrolls away with the page, and a test asserting either would be pinning a
 * behaviour this page does not have.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const SHEET = readFileSync(path.join(SRC, 'settings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Every style rule in the sheet, in source order, each carrying the `@media`
 *  condition it is nested in (`null` at the top level). */
function parse(css, media = null, out = []) {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const prelude = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    const body = css.slice(open + 1, j - 1)
    if (/^@media\b/.test(prelude)) parse(body, prelude.replace(/^@media\s*/, ''), out)
    else if (!prelude.startsWith('@')) out.push({ selector: prelude, media, body })
    i = j
  }
  return out
}

const RULES = parse(SHEET)

/* The two selectors in this sheet that name the rail element itself. Anything
   deeper (a button inside it) is a different element and not this file's
   subject. */
const SPECIFICITY = new Map([
  ['.settings-rail', 10],
  ['.settings-page .settings-rail', 20],
])

/** Does this rule's `@media` condition hold in a window this wide? */
function appliesAt(width, media) {
  if (!media) return true
  const max = media.match(/max-width:\s*(\d+)px/)
  return max ? width <= Number(max[1]) : false
}

/** The last declaration of one longhand property in a rule body. */
function declaration(body, property) {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g')
  let value = null
  let match
  while ((match = pattern.exec(body)) !== null) value = match[1].trim()
  return value
}

/** What a browser computes for one property on the rail, in a window this
 *  wide: highest specificity wins, and source order breaks the tie. */
function computed(property, width) {
  let best = null
  RULES.forEach((rule, order) => {
    const specificity = SPECIFICITY.get(rule.selector)
    if (specificity === undefined) return
    if (!appliesAt(width, rule.media)) return
    const value = declaration(rule.body, property)
    if (value === null) return
    if (!best || specificity > best.specificity || (specificity === best.specificity && order > best.order)) {
      best = { specificity, order, value }
    }
  })
  return best ? best.value : null
}

/* The parse has to be trusted before anything read out of it means anything. */
test('the sheet parses into rules that name the rail at both widths', () => {
  const named = RULES.filter(rule => SPECIFICITY.has(rule.selector))
  assert.ok(named.length >= 2, `only ${named.length} rules name the rail; the parse is wrong`)
  assert.ok(named.some(rule => rule.media === null), 'no unconditional rule names the rail')
  assert.ok(named.some(rule => /max-width:\s*760px/.test(rule.media || '')),
    'no narrow-window rule names the rail')
})

/* ---------- the narrow window is a bar, not a card ---------- */

test('the narrow-window rail is opaque, so it is a surface rather than a tint over the page', () => {
  const background = computed('background', 700)
  assert.ok(background, 'nothing gives the narrow rail a background at all')
  assert.doesNotMatch(background, /\btransparent\b/,
    `the page shows through the full-width menu bar: background is ${background}`)
})

test('the narrow-window rail keeps the one-line treatment the bar is drawn as', () => {
  assert.equal(computed('flex-direction', 700), 'row',
    'the narrow rail stacked its categories instead of running them along one line')
  assert.equal(computed('overflow-x', 700), 'auto',
    'the narrow rail can no longer be scrolled to the categories past its edge')
  assert.equal(computed('border-radius', 700), '0',
    'the desktop card\'s rounding is still on the full-width bar')
  assert.equal(computed('box-shadow', 700), 'none',
    'the desktop card\'s shadow is still under the full-width bar')
  assert.equal(computed('gap', 700), 'var(--s4)',
    'the desktop card\'s tighter gap crowded the categories along the scrolling line')
})

/* ---------- the wide window is unchanged ---------- */

test('the wide-window rail is still the card the settings page gave it', () => {
  assert.equal(computed('position', 1200), 'sticky',
    'the desktop rail no longer follows the category beside it')
  assert.match(computed('background', 1200) || '', /color-mix/,
    'the desktop rail lost its own surface')
  assert.match(computed('border-radius', 1200) || '', /var\(--r-lg\)/,
    'the desktop rail lost its rounding')
  assert.equal(computed('gap', 1200), 'var(--s2)',
    'the desktop rail lost its own spacing')
})

/* FIX-C 8: the row a link lands on (`.is-landed`, settings.css) is a 2px rule
   AND a --s3 inset. The row anatomy in settings-refine.css sets `padding:
   var(--s4) 0` with an :is(*, :has(...)) argument that lifts it to (0,7,0),
   which silently zeroed the inset. The inset must be restated at a
   specificity that wins, later in the cascade. */
function specificity(selector) {
  let a = 0, b = 0, c = 0
  let rest = selector
  // :where() contributes nothing; :is()/:not()/:has() contribute their most specific argument.
  rest = rest.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '')
  const nested = /:(?:is|not|has)\(((?:[^()]|\([^()]*\))*)\)/
  let match
  while ((match = nested.exec(rest)) !== null) {
    const best = match[1].split(',').map(part => specificity(part.trim())).sort((x, y) => y.join() < x.join() ? -1 : 1)[0]
    a += best[0]; b += best[1]; c += best[2]
    rest = rest.slice(0, match.index) + rest.slice(match.index + match[0].length)
  }
  a += (rest.match(/#[\w-]+/g) || []).length
  b += (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length
  c += (rest.match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length
  return [a, b, c]
}
const outranks = (x, y) => x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] >= y[2]

test('FIX-C 8: the landed settings row keeps its --s3 inset beside its 2px rule', () => {
  assert.deepEqual(specificity('.view-pad.settings-page .settings-shell .settings-layout .settings-row:is(*, :has(> .settings-disclosure .guided-summary))'), [0, 7, 0], 'the helper counts the :is(:has()) argument the way a browser does')
  assert.deepEqual(specificity('.settings-row.is-landed'), [0, 2, 0])
  const refine = readFileSync(path.join(SRC, 'settings-refine.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = parse(refine).filter(rule => !rule.media)
  const anatomyAt = rules.findIndex(rule => /\.settings-row:is\(\*, :has\(/.test(rule.selector) && /(?:^|;)\s*padding\s*:\s*var\(--s4\)\s+0\s*(?:;|$)/.test(rule.body))
  assert.notEqual(anatomyAt, -1, 'the row anatomy rule that zeroes the side padding is no longer where this test expects it; re-derive the cascade')
  const anatomy = specificity(rules[anatomyAt].selector)
  const landed = rules.map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => /\.settings-row\.is-landed/.test(rule.selector) && declaration(rule.body, 'padding-left') === 'var(--s3)')
  assert.ok(landed.length > 0, 'no rule in settings-refine.css restores the landed row inset (padding-left: var(--s3))')
  assert.ok(landed.some(({ rule, index }) => index > anatomyAt && outranks(specificity(rule.selector), anatomy)),
    `the landed inset rule loses to the row anatomy at ${anatomy.join(',')}: the text sits flush against the 2px rule`)
})
