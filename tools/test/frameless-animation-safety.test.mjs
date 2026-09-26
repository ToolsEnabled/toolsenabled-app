// AN ANIMATION MAY NOT OWN A RESTING STATE THE STYLESHEET DOES NOT.
//
// WHY THIS TEST EXISTS. src/styles.css suppresses keyframe animations while
// body.frameless is set, because a page that gets no rendering frames can
// never finish or release one -- measured 2026-08-18 on a packaged build, a
// CSSAnimation on a retired pane holding that pane and the whole sheet under
// it, one more per lap of the ring. Suppressing CREATION is the only variant
// that worked (collapsing the duration to 0s left the retained trees exactly
// where they were).
//
// THAT GUARD IS SAFE ONLY WHILE EVERY ANIMATION ENDS WHERE THE ELEMENT WOULD
// HAVE BEEN ANYWAY. Every animation in this product does today: they are
// `from`-only or 0%->100% entrances whose last keyframe restores the neutral
// value (opacity 1, no transform), which is what the element renders with when
// nothing animates. An animation that ended somewhere else -- faded something
// OUT and left it out, moved something and left it moved -- would, under the
// guard, leave that element in the WRONG state on a covered window, and the
// person would find it wrong when they came back.
//
// A written warning cannot hold that line; the next animation is written by
// someone who never read this file. So the rule is mechanical -- and narrower
// than "every animation", for a reason worth stating because the first version
// of this test flagged twelve innocent ones.
//
// AN ANIMATION WITHOUT FILL LEAVES NO TRACE. When it ends, the element renders
// from its own rules again, so its last keyframe is a moment, not a state, and
// suppressing it cannot change where anything comes to rest. The animations
// that CAN own a resting state are exactly those used with `forwards` or
// `both` fill -- for those, and only those, the final keyframe must restore a
// neutral value. Anything else must put its resting state in the rule itself,
// where the guard cannot reach it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/* Values that mean "as if nothing animated". A final keyframe made only of
   these leaves the element exactly where the base rule already puts it. */
const NEUTRAL = [
  /^1$/,                                   // opacity: 1
  /^none$/,                                // transform: none, filter: none
  /^normal$/,
  /^initial$/,
  /^unset$/,
  /^0$/,                                   // translate offsets written bare
  /^scale\(\s*1\s*\)$/,
  /^scale3d\(\s*1\s*,\s*1\s*,\s*1\s*\)$/,
  /^translate[XYZ]?\(\s*0(px|%|em|rem)?\s*(,\s*0(px|%|em|rem)?\s*)?\)$/,
  /^translate3d\(\s*0[a-z%]*\s*,\s*0[a-z%]*\s*,\s*0[a-z%]*\s*\)$/,
  /^rotate[XYZ]?\(\s*0(deg|rad|turn)?\s*\)$/,
  /^blur\(\s*0(px)?\s*\)$/,
]
const isNeutral = (value) => NEUTRAL.some((pattern) => pattern.test(value.trim()))

/** Every @keyframes block in a sheet, as name -> [{ stop, declarations }]. */
function keyframeBlocks(css) {
  const blocks = []
  const opener = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g
  let match
  while ((match = opener.exec(css))) {
    /* Brace-count to the matching close: keyframes contain nested blocks, so a
       lazy regex to the first `}` would read one stop and call it the whole
       animation -- which would silently pass an animation it never looked at. */
    let depth = 1
    let index = opener.lastIndex
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') depth -= 1
      index += 1
    }
    const body = css.slice(opener.lastIndex, index - 1)
    const stops = []
    const stopPattern = /([^{}]+)\{([^{}]*)\}/g
    let stopMatch
    while ((stopMatch = stopPattern.exec(body))) {
      stops.push({ stop: stopMatch[1].trim(), declarations: stopMatch[2].trim() })
    }
    blocks.push({ name: match[1], stops })
    opener.lastIndex = index
  }
  return blocks
}

const sheets = readdirSync(SRC).filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(path.join(SRC, name), 'utf8') }))

test('the frameless guard exists and suppresses animation creation, not merely its duration', () => {
  const styles = sheets.find((sheet) => sheet.name === 'styles.css')
  assert.ok(styles, 'src/styles.css must exist')
  assert.match(styles.css, /body\.frameless[^{]*\{[^}]*animation-name:\s*none\s*!important/s,
    'body.frameless must set animation-name: none — a duration of 0s was measured and does NOT release the animation')
  assert.match(styles.css, /body\.frameless[^{]*\{[^}]*transition-property:\s*none\s*!important/s,
    'body.frameless must also suppress transitions, which is the holder this guard was built for')
})

/** Animation names used with a fill that outlives the animation's own run. */
function persistingNames(all) {
  const names = new Set()
  for (const sheet of all) {
    for (const match of sheet.css.matchAll(/animation:\s*([^;]+);/g)) {
      const shorthand = match[1]
      if (!/(^|\s)(both|forwards)(\s|$)/.test(shorthand)) continue
      const name = shorthand.trim().split(/\s+/)[0]
      if (name) names.add(name)
    }
  }
  return names
}

/* ANIMATIONS THAT END SOMEWHERE ELSE ON PURPOSE, because the thing they are
   animating is LEAVING. A departure animation's final keyframe (faded out,
   moved away) is not a resting state anybody sees: the element is removed by
   the router when the timer fires, and a view-transition pseudo-element ceases
   to exist with the transition. Suppressing these on a frameless page strands
   nothing, because there is nothing left to strand.
   THE EXEMPTION IS NOT TAKEN ON TRUST. Each name below must actually be used
   on a leaving selector, and the test proves that before honouring it -- so a
   future animation cannot be waved through by adding its name here. */
const LEAVING = new Map([
  ['mcRailOut', 'rail content on its way out (.rail-page.mc-out)'],
  ['mcRouteOut', 'the OLD half of a route view transition (::view-transition-old)'],
  ['mcZoomExit', 'the outgoing view wrapper, which retireView removes'],
])
const LEAVING_SELECTOR = /\.mc-out|::view-transition-old|\.mc-zoom-exit|\bmc-exit\b/

test('an exempt animation really is used only on something that is leaving', () => {
  /* Rules are split on their braces rather than matched with a regex: a
     hand-built pattern here was silently wrong once already, and a parser
     that cannot express the wrong thing is better than one that can. */
  const rulesUsing = (name) => {
    const found = []
    for (const sheet of sheets) {
      for (const chunk of sheet.css.split('}')) {
        const brace = chunk.indexOf('{')
        if (brace === -1) continue
        const selector = chunk.slice(0, brace).trim().split(String.fromCharCode(10)).pop().trim()
        const declarations = chunk.slice(brace + 1)
        for (const declaration of declarations.split(';')) {
          const [property, ...rest] = declaration.split(':')
          if (property.trim() !== 'animation') continue
          if (rest.join(':').trim().split(/\s+/)[0] === name) found.push(selector)
        }
      }
    }
    return found
  }
  for (const [name, why] of LEAVING) {
    const users = rulesUsing(name)
    assert.ok(users.length > 0, `${name} is exempt but nothing uses it - remove the exemption (${why})`)
    for (const selector of users) {
      assert.match(selector, LEAVING_SELECTOR,
        `${name} is exempt because it animates something leaving, but it is used on "${selector}", which is not a leaving selector`)
    }
  }
})

test('every animation that OUTLIVES its own run ends at a neutral resting state', () => {
  const persisting = persistingNames(sheets)
  assert.ok(persisting.size > 0, 'the sheets must still use fill-mode somewhere, or this test is watching nothing')
  const offenders = []
  for (const sheet of sheets) {
    for (const block of keyframeBlocks(sheet.css)) {
      if (!persisting.has(block.name)) continue
      if (LEAVING.has(block.name)) continue
      /* No 100%/to stop at all means the animation ENDS at the base rule,
         which is the safest shape there is. */
      const final = block.stops.find((entry) => /(^|,\s*)(100%|to)\s*$/.test(entry.stop) || /(^|,\s*)(100%|to)(\s*,|$)/.test(entry.stop))
      if (!final) continue
      for (const declaration of final.declarations.split(';')) {
        const [property, ...rest] = declaration.split(':')
        const value = rest.join(':').trim()
        if (!property.trim() || !value) continue
        if (isNeutral(value)) continue
        offenders.push(`${sheet.name} @keyframes ${block.name} ends with ${property.trim()}: ${value}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    'An animation used with both/forwards fill, whose LAST keyframe sets a non-neutral value, owns a\n'
    + 'resting state its rule does not. While body.frameless suppresses animations (a covered window),\n'
    + 'that element would be left in the wrong state and a person would find it wrong on their return.\n'
    + 'Put the resting state in the rule itself, or the guard must learn about this animation.')
})
