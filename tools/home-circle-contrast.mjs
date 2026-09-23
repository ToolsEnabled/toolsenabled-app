#!/usr/bin/env node
// Measures the production Home ledger palette against its sheet and frame.
//
// Clear is green, owner requests yellow, and blockers red. Theme defaults
// are read from the same module as the actual controls and circle.
// Each colour is then checked against BOTH surfaces it touches: the sheet
// (--bg) and the band it sits on (--core-frame). Refuses a default below the
// 3:1 non-text floor.
//
// THE BAND IS READ OUT OF THE STYLESHEET, NOT DECLARED HERE. It used to be a
// constant, `FRAME_INK = .11`, with a comment saying the band was 11% --ink-3
// over --surface. src/home-circle.css draws it at 7%, and has done since the
// casing was quietened. So this gate was checking a band that is not on the
// screen -- a guard measuring its own model rather than the product, which is
// the failure it exists to prevent. Parsing the real declaration means the two
// cannot drift again: change the stylesheet and this follows it, and if the
// declaration is ever written in a shape this cannot read, it refuses by name
// instead of falling back to a number nobody drew.
// Run it to reprint the measured values and ratios:
//   node tools/home-circle-contrast.mjs
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defaultHomeStatusColors } from '../src/home-status-colors.js'
export const HUES = { clear: 165, attention: 85, blocked: 20 }
export const SHEETS = {
  white: { bg: '#f7f8fa', surface: '#ffffff', ink3: '#5c6b7b', L: .58, C: .12, dark: false },
  tan:   { bg: '#f2e5bc', surface: '#f6ebcb', ink3: '#62584e', L: .55, C: .12, dark: false },
  black: { bg: '#212327', surface: '#292b30', ink3: '#b3a39a', L: .78, C: .14, dark: true },
  ember: { bg: '#170d13', surface: '#25141d', ink3: '#cbabb5', dark: true },
  cobalt: { bg: '#0b1223', surface: '#131e35', ink3: '#acbcd2', dark: true },
}
const CIRCLE_CSS = readFileSync(new URL('../src/home-circle.css', import.meta.url), 'utf8')
/* EVERY --core-frame the stylesheet declares, WITH THE SELECTOR THAT DECLARES
   IT. Source order is not the discriminator: the dark-theme block wins on
   specificity wherever it sits in the file, and reading the two by position
   assigned them backwards -- this gate briefly measured the light sheets
   against the dark band and the dark sheets against the light one, which is the
   same class of fault as the constant it replaced. So the rule's own selector
   decides, and a declaration whose polarity cannot be told is refused by name
   rather than guessed at. */
export function frameInkFromStylesheet(css = CIRCLE_CSS) {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) || []
  const found = { light: null, dark: null }
  for (const block of blocks) {
    const declared = block.match(/--core-frame:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--ink-3\)\s*([\d.]+)%\s*,\s*var\(--surface\)\s*\)/)
    if (!declared) continue
    const selector = block.slice(0, block.indexOf('{'))
    const polarity = /data-theme="(black|ember|cobalt)"/.test(selector) ? 'dark' : 'light'
    found[polarity] = Number(declared[1]) / 100
  }
  if (found.light === null) {
    throw new Error('home-circle-contrast: cannot read --core-frame out of src/home-circle.css, '
      + 'so the band this gate measures would be a guess. Keep the declaration as '
      + 'color-mix(in srgb, var(--ink-3) N%, var(--surface)) or teach this reader the new shape.')
  }
  // No dark override means the dark sheets show the same band as the light ones.
  return { light: found.light, dark: found.dark === null ? found.light : found.dark }
}
let frameInkCache = null
/** The band, read on first use. Never at import time -- see above. */
export function frameInk() {
  if (frameInkCache === null) frameInkCache = frameInkFromStylesheet()
  return frameInkCache
}
/* Kept as a live view rather than a value so existing readers of FRAME_INK.light
   and FRAME_INK.dark still work, and still refuse by name, without the refusal
   happening while the module loads. */
export const FRAME_INK = {
  get light() { return frameInk().light },
  get dark() { return frameInk().dark },
}
// The band a given sheet actually shows.
export const frameInkFor = sheet => (sheet.dark ? frameInk().dark : frameInk().light)

export const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
const lin = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
const gam = c => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055
const lum = rgb => { const [r, g, b] = rgb.map(lin); return .2126 * r + .7152 * g + .0722 * b }
export const contrast = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + .05) / (l + .05) }
export function oklchToRgb(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180)
  const l_ = L + .3963377774 * a + .2158037573 * b
  const m_ = L - .1055613458 * a - .0638541728 * b
  const s_ = L - .0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.7076147010 * s,
  ].map(gam)
}
const inGamut = rgb => rgb.every(v => v >= -.0005 && v <= 1.0005)
// color-mix(in srgb, ink3 N%, surface): a straight sRGB blend, as Chromium does.
export const mix = (a, b, pa) => a.map((v, i) => v * pa + b[i] * (1 - pa))

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
let failed = false
for (const [sheet, s] of Object.entries(SHEETS)) {
  const bg = hex(s.bg), ink = frameInkFor(s), frame = mix(hex(s.ink3), hex(s.surface), ink)
  console.log(`\n${sheet}: bg ${s.bg}  band ${toHex(frame)} (${(ink * 100).toFixed(0)}% ${s.ink3} over ${s.surface})`)
  for (const [name, value] of Object.entries(defaultHomeStatusColors(sheet))) {
    const vsBg = contrast(hex(value), bg), vsBand = contrast(hex(value), frame)
    console.log(`  ${name.padEnd(9)} ${value}  sheet ${vsBg.toFixed(2)}:1  band ${vsBand.toFixed(2)}:1`)
    if (vsBg < 3 || vsBand < 3) failed = true
  }
}
if (failed) process.exit(1)
}
