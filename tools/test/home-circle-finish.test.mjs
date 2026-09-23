import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homeCircleMarkup } from '../../src/home-circle.js'
import { defaultHomeStatusColors } from '../../src/home-status-colors.js'
import { SHEETS, frameInk, frameInkFor, hex, contrast, mix } from '../home-circle-contrast.mjs'

/* WHAT THIS FILE OWES. Checked at the end against what actually ran, because
   the way this gate failed on 2026-09-18 was by not running at all: the
   contrast reader threw while importing and every assertion below vanished
   from the output. A count that has to be met turns that into a red. */
const CHECKS_OWED = 5
let checksRan = 0
const gate = (name, body) => test(name, t => { body(t); checksRan += 1 })

const css = readFileSync(new URL('../../src/home-circle.css', import.meta.url), 'utf8')

gate('the contrast reader can still read the casing out of the stylesheet', () => {
  /* If this is red, the three checks below are measuring nothing, and before
     this check existed they would not have appeared in the output at all. */
  let band
  assert.doesNotThrow(() => { band = frameInk() },
    'the band could not be read; frameInkFromStylesheet refuses by name rather than guessing')
  for (const polarity of ['light', 'dark']) {
    assert.equal(typeof band[polarity], 'number', `no ${polarity}-sheet band was found in src/home-circle.css`)
    assert.ok(band[polarity] > 0 && band[polarity] < 1, `the ${polarity}-sheet band is ${band[polarity]}, which is not a dose`)
  }
  assert.notEqual(band.light, band.dark,
    'the dark sheets carry a heavier band than the light ones; one number for both means the polarities were read backwards')
})

gate('both borders are decorative and have no SVG or CSS animation loop', () => {
  const markup = homeCircleMarkup()
  assert.match(markup, /aria-hidden="true"/)
  assert.match(markup, /focusable="false"/)
  assert.match(markup, /home-core-standard-design/)
  assert.match(markup, /home-core-simple-design/)
  assert.doesNotMatch(markup, /<animate|<canvas/)
  assert.doesNotMatch(css, /@keyframes|animation:/)
})

gate('two mounted circles do not share filter ids', () => {
  const ids = m => [...m.matchAll(/\bid="([\w-]+)"/g)].map(x => x[1])
  const a = ids(homeCircleMarkup()), b = ids(homeCircleMarkup())
  assert.ok(a.length > 0)
  assert.deepEqual(a.filter(id => b.includes(id)), [])
  const markup = homeCircleMarkup()
  const definitions = ids(markup)
  for (const [, ref] of markup.matchAll(/url\(#([\w-]+)\)/g)) assert.ok(definitions.includes(ref), `filter ${ref} resolves within its own view`)
})

gate('the glow follows --glow and is off at zero', () => {
  assert.match(css, /\.home-core-halo \{[^}]*opacity: calc\(var\(--core-glow-lip\) \* var\(--glow, 1\)\)/)
  // The fluid reads --core-glow-trail as its light dose (home-circle-fluid.js readPalette), so it stays declared.
  assert.match(css, /--core-glow-trail: \.5;/)
  assert.match(css, /--core-glow-trail: \.75;/)
})

gate('every lip colour clears 3:1 against its sheet and its band', () => {
  for (const [sheet, s] of Object.entries(SHEETS)) {
    /* The band this sheet actually shows. The dark themes carry a heavier
       --core-frame than the light ones, so one number cannot stand for both;
       frameInkFor reads each polarity out of the stylesheet. */
    const band = mix(hex(s.ink3), hex(s.surface), frameInkFor(s))
    for (const colour of Object.values(defaultHomeStatusColors(sheet))) {
      assert.ok(contrast(hex(colour), hex(s.bg)) >= 3, `${sheet} ${colour} vs sheet`)
      assert.ok(contrast(hex(colour), band) >= 3, `${sheet} ${colour} vs band`)
    }
  }
})

/* THE COUNT GUARD -- R1228. Every check above increments only if it ran to
   completion, and node:test runs this last because it is declared last. If the
   file is half-imported, a check is deleted, or one throws before its body
   finishes, the number will not match and this reds by name. It is the one
   assertion here whose job is the GATE rather than the product. */
test('every check this gate owes actually ran', () => {
  assert.equal(checksRan, CHECKS_OWED,
    `${checksRan} of ${CHECKS_OWED} checks ran. A gate that does not run is not a gate: `
    + 'if a check was deliberately removed, lower CHECKS_OWED in the same change and say why.')
})
