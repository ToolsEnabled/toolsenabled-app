/* WINDOWS HIGH CONTRAST (forced colors): CONTROLS THAT MUST NOT VANISH.
 *
 * Forced colors replaces every author colour with the person's system palette:
 * backgrounds become Canvas, background images and box shadows are dropped.
 * Anything drawn only with those disappears. The bug hunt measured five such
 * places with forced colors emulated (bughunt-rig hunt-crosscut c19, c23, c26,
 * c33 and c35):
 *
 *   T1592  every on/off switch: no track, no knob, no state;
 *   T1593  the chosen Theme in Quick settings and the active computer tab:
 *          HighlightText on Canvas, white on white, because the forced rule
 *          lost the cascade to a more specific selection fill;
 *   T1595  the rail's current page: its plate and bar were backgrounds;
 *   T1596  Home Full view's Coordinator | Everything and the activity filters:
 *          chosen and not chosen drew the same;
 *   T1597  sliders outside Settings: the gradient track was dropped.
 *
 * Node cannot paint, so this reads the sheets the way the cascade does: the
 * forced-colors blocks must hold a rule that draws each control in system
 * colours, and where a more specific resting rule competes, the forced rule
 * must be able to win it (!important, as styles.css's own block explains).
 * The painted proof is the rig hand test with the hunters' scripts.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sheet = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/* The rules inside every `@media (forced-colors: active)` block of a sheet. */
function forcedRules(name) {
  const text = sheet(name)
  const rules = []
  let from = 0
  for (;;) {
    const at = text.indexOf('@media (forced-colors: active)', from)
    if (at < 0) break
    let depth = 0, i = text.indexOf('{', at), start = i + 1
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) break
    }
    const block = text.slice(start, i)
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ selectors: match[1].split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, ' ')), body: match[2] })
    }
    from = i
  }
  return rules
}
const declares = (body, property, value) => new RegExp(`(^|;|\\s)${property}\\s*:\\s*${value}`, 'i').test(body)
const find = (rules, selector) => rules.filter(rule => rule.selectors.includes(selector))

test('on/off switches keep a track, a knob and a visible on state (T1592)', () => {
  const rules = forcedRules('styles.css')
  const track = find(rules, '.toggle i')
  assert.ok(track.length, 'no forced-colors rule draws the switch track: it becomes Canvas on Canvas')
  assert.ok(track.some(rule => declares(rule.body, 'border', '1px solid (CanvasText|ButtonText)')), 'the track has no border in system colours')
  const knob = find(rules, '.toggle i::after')
  assert.ok(knob.some(rule => declares(rule.body, 'border', '1px solid (CanvasText|ButtonText)')), 'the knob has no border in system colours')
  assert.ok(knob.some(rule => declares(rule.body, 'box-shadow', 'none')))
  const on = find(rules, '.toggle input:checked + i')
  assert.ok(on.some(rule => declares(rule.body, 'background', 'Highlight')), 'on and off switches still draw the same')
})

test('the chosen theme and the active computer tab read HighlightText on Highlight (T1593)', () => {
  const rules = forcedRules('theme-refinements.css')
  const chosen = rules.find(rule => rule.selectors.includes(':root :is(.theme-seg button.on, .seg > button.on, .tab.active)'))
  assert.ok(chosen, 'the forced-colors selection rule is gone')
  /* The resting fill is :root :is(... .seg:not(:has(> .seg-ind.ready)) >
     button.on ...), specificity (0,5,1) for every argument it matches through;
     a (0,3,1) forced rule can only win it with !important. */
  const resting = sheet('theme-refinements.css').includes(':root :is(.theme-seg button.on, .seg-ind, .seg:not(:has(> .seg-ind.ready)) > button.on, .tab.active) {')
  assert.ok(resting, 'the resting selection fill changed; re-check which rule wins the background')
  assert.ok(declares(chosen.body, 'background', 'Highlight !important'), 'the forced background loses to the more specific resting fill: white text on white')
  assert.ok(declares(chosen.body, 'color', 'HighlightText !important'))
})

test('the rail marks the current page with the highlight pair (T1595)', () => {
  const rules = forcedRules('app-navigation.css')
  const current = find(rules, '.tb-nav a.active')
  assert.ok(current.length, 'no forced-colors rule marks the current rail item: its plate and bar become Canvas')
  assert.ok(current.some(rule => declares(rule.body, 'background', 'Highlight !important') && declares(rule.body, 'color', 'HighlightText !important')),
    'the current item is not drawn in the highlight pair, or cannot outrank the (1,2,1) resting rule')
})

test('Full view\'s chosen view and the chosen activity filter stay marked (T1596)', () => {
  const rules = forcedRules('home-chat.css')
  for (const selector of ['.home-takeover-views [aria-pressed="true"]', '.activity-filters [aria-pressed="true"]']) {
    const rule = find(rules, selector)
    assert.ok(rule.some(r => declares(r.body, 'background', 'Highlight') && declares(r.body, 'color', 'HighlightText')),
      `${selector} draws the same as an unpressed button in forced colors`)
  }
})

test('every slider falls back to the native one, not only those on the Settings page (T1597)', () => {
  const rules = forcedRules('styles.css')
  const range = find(rules, 'input[type="range"]')
  assert.ok(range.some(rule => declares(rule.body, 'appearance', 'auto')), 'sliders outside Settings keep their gradient track, which forced colors drops')
})
