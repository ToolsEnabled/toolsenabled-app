/* PALETTE LAB — build-time only, nothing here ships.
   Derives and checks the role palette that lives in src/styles.css (--c-*)
   and src/vocab.js (ROLES[].hex). Method, in order:

   1. BALANCED-LUMINANCE BAND. One hex per role serves all three themes (the
      identity system is theme-constant on purpose: half its consumers write
      the hex into an inline style at view-build time and never re-render on
      a theme flip). Against the white page #f7f8fa and the black page
      #0d0f12 the two contrast ratios multiply to a constant 18.1, so a hue
      that clears 3:1 on white (Y <= 0.285) and 3:1 on black (Y >= 0.116)
      exists in exactly one band, and Y = 0.186 is the balance point (4.26:1
      both ways). Every role hue below is inside that band.
   2. SEPARATION. dE2000 between every pair, measured three times: as the
      solid 6px dot, as the composited node rim, and as the graph link
      (0.52 alpha under the canvas's saturate(0.72)).
   3. TEXT. Each recipe that folds a role hue into ink, composited per theme.

   Run: node tools/hue-lab.mjs [dump|check] */
import { differenceCiede2000, converter, parse, formatHex, wcagContrast } from 'culori'
import carbon from '@carbon/colors'

const dE = differenceCiede2000()
const rgb = converter('rgb')
const oklab = converter('oklab')
/* accept a hex/CSS string OR an already-parsed culori object */
const P = (c) => (typeof c === 'string' ? parse(c) : c)

/* color-mix(in oklab, A p%, B) — premultiplied, exactly as CSS resolves it */
export function mix(a, b, p) {
  const A = oklab(P(a)), B = oklab(P(b))
  const aA = A.alpha ?? 1, aB = B.alpha ?? 1
  const wa = p * aA, wb = (1 - p) * aB
  const al = wa + wb
  if (al === 0) return { mode: 'rgb', r: 0, g: 0, b: 0, alpha: 0 }
  return {
    mode: 'oklab',
    l: (A.l * wa + B.l * wb) / al, a: (A.a * wa + B.a * wb) / al, b: (A.b * wa + B.b * wb) / al,
    alpha: p * aA + (1 - p) * aB,
  }
}
export function over(fg, bg) {
  const F = rgb(P(fg)), B = rgb(P(bg))
  const a = F.alpha ?? 1
  return { mode: 'rgb', r: F.r * a + B.r * (1 - a), g: F.g * a + B.g * (1 - a), b: F.b * a + B.b * (1 - a) }
}
export const alpha = (c, a) => ({ ...rgb(P(c)), alpha: a })
/* CSS filter: saturate(s) — the feColorMatrix saturate matrix, sRGB */
export function saturate(c, s) {
  const C = rgb(P(c))
  const l = [0.213, 0.715, 0.072]
  const f = (i) => {
    const base = [l[0], l[1], l[2]]
    const v = base.map((k, j) => k + (i === j ? s * (1 - k) : -s * k))
    return Math.min(1, Math.max(0, v[0] * C.r + v[1] * C.g + v[2] * C.b))
  }
  return { mode: 'rgb', r: f(0), g: f(1), b: f(2), alpha: C.alpha ?? 1 }
}
export const Y = (c) => {
  const C = rgb(P(c))
  const s = [C.r, C.g, C.b].map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
}
export const cr = (fg, bg) => +wcagContrast(over(fg, bg), P(bg)).toFixed(2)
export const de = (a, b) => +dE(parse(formatHex(P(a))), parse(formatHex(P(b)))).toFixed(1)
export const hex = (c) => formatHex(P(c))
export { carbon, rgb, oklab }

const PAGE = { white: '#f7f8fa', black: '#0d0f12', tan: '#f2e5bc' }
const INK = { white: '#0e1726', black: '#eef2f6', tan: '#282828' }
const INK2 = { white: '#4f5f70', black: '#b7c0ca', tan: '#3c3836' }
const INK3 = { white: '#64727f', black: '#8f99a5', tan: '#665c54' }
const LINE2 = { white: 'rgba(14,23,38,0.12)', black: 'rgba(255,255,255,0.14)', tan: 'rgba(40,40,40,0.17)' }
export { PAGE, INK, INK2, INK3, LINE2 }

if (process.argv[2] === 'dump') {
  const band = []
  for (const f of ['cyan', 'blue', 'teal', 'green', 'orange', 'yellow', 'purple', 'magenta', 'coolGray', 'gray']) {
    for (const [k, v] of Object.entries(carbon[f])) {
      const y = Y(v)
      if (y >= 0.10 && y <= 0.33) band.push(`${f}${k} ${v}  Y=${y.toFixed(3)}  w=${cr(v, PAGE.white)}  b=${cr(v, PAGE.black)}  t=${cr(v, PAGE.tan)}`)
    }
  }
  console.log(band.join('\n'))
}
