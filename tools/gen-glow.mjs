/**
 * Glow token generator — run with `node tools/gen-glow.mjs`, writes src/glow.css.
 *
 * Why this exists rather than hand-written rgba(): a convincing glow is a
 * physical falloff, not one blurred copy of a colour. Real light loses
 * intensity roughly with the square of distance while *gaining* apparent
 * lightness and losing saturation toward the source, so a premium glow is
 * several stacked layers whose radius grows geometrically, whose alpha
 * decays faster than linearly, and whose colour walks toward white as it
 * tightens. Doing that in sRGB muddies the hue (sRGB interpolation drifts
 * through grey); culori lets each step be placed in OKLCH, which is
 * perceptually uniform, so every role hue keeps its identity at every
 * intensity and the ramps are consistent with each other.
 *
 * Output is static CSS custom properties — culori stays a devDependency and
 * never ships to the browser.
 */
import { formatRgb, formatHex, oklch, converter } from 'culori'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const toOklch = converter('oklch')
const here = dirname(fileURLToPath(import.meta.url))

// the site's role palette — MUST match --c-* in src/styles.css (where the
// derivation, the measured contrasts and the dE2000 separations are written
// out) and ROLES[].hex in src/vocab.js. Regenerate after any change there,
// or a selected bubble blooms in the previous palette's hue.
const ROLES = {
  coordinator: '#008dab',
  helper: '#c85900',
  shadow: '#00956c',
  manager: '#3e63f0',
  default: '#9d7900',
  accent: '#008dab',      // the shared interactive accent IS the coordinator cyan
}

/** One layer of the falloff. `t` is 0 (core) → 1 (outermost halo). */
function layer(baseHex, t, { spread, alpha }) {
  const c = toOklch(baseHex)
  // toward the core the light reads brighter and less saturated (it is
  // approaching the emitter); outward it settles back to the true hue
  const L = Math.min(0.98, c.l + (1 - t) * 0.22)
  const C = Math.max(0.02, c.c * (0.62 + t * 0.38))
  const col = oklch({ mode: 'oklch', l: L, c: C, h: c.h })
  return { blur: spread, alpha, color: formatRgb({ ...col, alpha: 1 }) }
}

/** A full glow: geometric radii, super-linear alpha decay. */
function glow(baseHex, { steps = 3, base = 6, growth = 2.6, peak = 0.5 } = {}) {
  const out = []
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1)
    const spread = Math.round(base * Math.pow(growth, i))
    // inverse-square-ish: each ring is markedly fainter than the last
    const alpha = +(peak / Math.pow(1.9, i)).toFixed(3)
    out.push(layer(baseHex, t, { spread, alpha }))
  }
  return out
}

/* Sequential heatmap ramps, one per theme. Each runs from a step that is
   barely distinguishable from that theme's own background up to a fully
   saturated accent, so "more" always reads as "more contrast" — the light
   ramp inverted on the dark theme when it was a single hardcoded list. */
function heatRamp(bgHex, hueHex, steps = 6) {
  const bg = toOklch(bgHex), hue = toOklch(hueHex)
  const out = []
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    const L = bg.l + (hue.l - bg.l) * (0.18 + 0.82 * t)
    const C = hue.c * (0.06 + 0.94 * Math.pow(t, 0.85))
    out.push(formatHex(oklch({ mode: 'oklch', l: L, c: C, h: hue.h })))
  }
  return out
}

const css = (layers, { inset = false } = {}) =>
  layers
    .map(l => `${inset ? 'inset ' : ''}0 0 ${l.blur}px ${l.color.replace('rgb(', 'rgba(').replace(')', `, ${l.alpha})`)}`)
    .join(',\n    ')

const blocks = []
for (const [name, hex] of Object.entries(ROLES)) {
  // three intensities, so a surface can pick how loud it is allowed to be
  const soft = glow(hex, { steps: 3, base: 5, growth: 2.4, peak: 0.30 })
  const mid = glow(hex, { steps: 3, base: 6, growth: 2.6, peak: 0.46 })
  const loud = glow(hex, { steps: 4, base: 6, growth: 2.5, peak: 0.62 })
  blocks.push(
    `  --glow-${name}-soft:\n    ${css(soft)};\n` +
    `  --glow-${name}:\n    ${css(mid)};\n` +
    `  --glow-${name}-loud:\n    ${css(loud)};`,
  )
}

const header = `/* ============================================================
   GENERATED — do not edit by hand.
   Source: tools/gen-glow.mjs   Regenerate: node tools/gen-glow.mjs

   Perceptual glow ramps (OKLCH, via culori). Each token is a stack of
   layers with geometrically growing radii and super-linear alpha decay —
   physical light falloff rather than one blurred copy of a colour — and
   each layer's colour is placed in OKLCH so the hue holds at every
   intensity instead of drifting toward grey through sRGB.

   Three intensities per hue: -soft (a whisper, safe at rest on a small
   accent), default (a deliberate highlight), -loud (a momentary event).
   Every use is still gated by --glow so the Settings slider governs it.
   ============================================================ */
:root {
`

// heatmap ramps: [theme background, the theme's saturated end]
// (the :root --heat-* set these emit currently has no consumer — metrics.css
// declares its own Carbon blue ramp scoped to .metrics — but the anchors
// follow the palette so a future reader does not inherit a dead hue)
const THEMES = {
  white: ['#f7f8fa', '#008dab'],
  tan:   ['#f2e5bc', '#0b7285'],
  black: ['#0d0f12', '#45d6ff'],
}
const heatBlocks = Object.entries(THEMES).map(([name, [bg, hue]]) => {
  const vars = heatRamp(bg, hue).map((c, i) => `  --heat-${i}: ${c};`).join('\n')
  return name === 'white'
    ? `:root,\n:root[data-theme="white"] {\n${vars}\n}`
    : `:root[data-theme="${name}"] {\n${vars}\n}`
}).join('\n')

writeFileSync(
  join(here, '..', 'src', 'glow.css'),
  header + blocks.join('\n') + '\n}\n\n/* heatmap ramps — per theme, always low→high contrast\n   against that theme\'s own background */\n' + heatBlocks + '\n',
)
console.log(`wrote src/glow.css — ${Object.keys(ROLES).length} hues x 3 intensities + ${Object.keys(THEMES).length} heat ramps`)
