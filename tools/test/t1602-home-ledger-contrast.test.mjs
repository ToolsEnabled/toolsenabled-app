import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { colorContrast } from '../../src/role-colors.js'

const THEMES = ['white', 'tan', 'black', 'ember', 'cobalt']
const DARK_THEMES = new Set(['black', 'ember', 'cobalt'])

const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')

function rules(css) {
  return [...withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1].trim(), body: match[2] }))
}

function declaration(rule, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`).exec(rule)
  assert.ok(match, `the CSS rule keeps a ${name} declaration`)
  return match[1].trim()
}

function themeTokens(css, theme) {
  const tokens = Object.create(null)
  const needle = new RegExp(`\\[data-theme=[\"']${theme}[\"']\\]`)
  for (const rule of rules(css)) {
    if (!needle.test(rule.selector)) continue
    for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)) {
      tokens[match[1]] = match[2].toLowerCase()
    }
  }
  return tokens
}

/* THE WARN CHIP GROUND IS A PER-THEME TOKEN: --s-warn-wash
   is a color-mix declared in theme-refinements.css, on :root for the dark sheets and
   again on White and Tan. Resolve it the way the cascade does: :root first, then the
   theme's own block. */
function themeExpressions(css, theme) {
  const expressions = Object.create(null)
  const needle = new RegExp(`\\[data-theme=[\"']${theme}[\"']\\]`)
  const blocks = [...rules(css).filter(rule => rule.selector === ':root'), ...rules(css).filter(rule => needle.test(rule.selector))]
  for (const rule of blocks) {
    for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*(color-mix\([^;]+\))/gi)) expressions[match[1]] = match[2].trim()
  }
  return expressions
}

function hexColor(value) {
  const text = value.trim()
  assert.match(text, /^#[0-9a-f]{6}$/i, `the CSS color is a supported six-digit sRGB value: ${text}`)
  return { r: Number.parseInt(text.slice(1, 3), 16), g: Number.parseInt(text.slice(3, 5), 16), b: Number.parseInt(text.slice(5, 7), 16), a: 1 }
}

function mix(first, second, firstPercent) {
  const firstShare = firstPercent / 100
  const secondShare = 1 - firstShare
  const alpha = first.a * firstShare + second.a * secondShare
  assert.ok(alpha > 0, 'a visible CSS color-mix result is required')
  return {
    r: (first.r * first.a * firstShare + second.r * second.a * secondShare) / alpha,
    g: (first.g * first.a * firstShare + second.g * second.a * secondShare) / alpha,
    b: (first.b * first.a * firstShare + second.b * second.a * secondShare) / alpha,
    a: alpha,
  }
}

/* CSS color-mix(in oklab, ...): premultiplied interpolation in OKLab. */
function toOklab({ r, g, b }) {
  const linear = value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [red, green, blue] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
}

function fromOklab([lightness, a, b]) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const encode = value => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
  return { r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) }
}

function mixOklab(first, second, firstPercent) {
  const firstShare = firstPercent / 100
  const secondShare = 1 - firstShare
  const alpha = first.a * firstShare + second.a * secondShare
  assert.ok(alpha > 0, 'a visible CSS color-mix result is required')
  const [one, two] = [toOklab(first), toOklab(second)]
  return { ...fromOklab(one.map((value, index) => (value * first.a * firstShare + two[index] * second.a * secondShare) / alpha)), a: alpha }
}

function over(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a)
  assert.ok(alpha > 0, 'a visible composited CSS background is required')
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  }
}

function toHex(color) {
  const channel = value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

function resolveColor(value, tokens, expressions = Object.create(null)) {
  const text = value.trim()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (/^#[0-9a-f]{6}$/i.test(text)) return hexColor(text)
  const variable = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(text)
  if (variable) {
    if (tokens[variable[1]]) return hexColor(tokens[variable[1]])
    assert.ok(expressions[variable[1]], `the CSS color resolves ${variable[1]} for the selected theme`)
    return resolveColor(expressions[variable[1]], tokens, expressions)
  }
  const colorMix = /^color-mix\(\s*in\s+(srgb|oklab)\s*,\s*(.*?)\s+([0-9.]+)%\s*,\s*(.*?)\s*\)$/is.exec(text)
  assert.ok(colorMix, `the CSS color uses a supported sRGB or OKLab color-mix expression: ${text}`)
  const [first, second] = [resolveColor(colorMix[2], tokens, expressions), resolveColor(colorMix[4], tokens, expressions)]
  return colorMix[1].toLowerCase() === 'oklab' ? mixOklab(first, second, Number(colorMix[3])) : mix(first, second, Number(colorMix[3]))
}

function activeSurfaceExpression(contextCss, rosterCss, theme) {
  const base = rules(contextCss).filter(rule => rule.body.includes('--home-context-surface:')).at(-1)
  assert.ok(base, 'home-context.css keeps the base --home-context-surface declaration')
  const overrides = rules(rosterCss).filter(rule => rule.selector.includes(':has(.home-roster-readable)')
    && rule.body.includes('--home-context-surface:'))
  const themed = overrides.find(rule => DARK_THEMES.has(theme)
    ? /\[data-theme="black"\]/.test(rule.selector)
    : !/\[data-theme=/.test(rule.selector))
  assert.ok(themed, `${theme} keeps the actual Home roster --home-context-surface override`)
  return declaration(themed.body, '--home-context-surface')
}

function isLedgerChipSelector(selector, hover) {
  const suffix = hover ? '.home-agents-ledger:hover' : '.home-agents-ledger'
  return selector.endsWith(suffix) && !selector.includes('::')
}

function activeLedgerBackground(contextCss, hover) {
  const matches = rules(contextCss).filter(rule => isLedgerChipSelector(rule.selector, hover)
    && rule.body.includes('background:'))
  const rule = matches.at(-1)
  assert.ok(rule, `Home keeps a ${hover ? 'hover' : 'normal'} ledger-chip background declaration`)
  return declaration(rule.body, 'background')
}

test('Home blocked-ledger chip label clears AA on CSS-declared five-theme normal and hover grounds', t => {
  const contextCss = readFileSync(new URL('../../src/home-context.css', import.meta.url), 'utf8')
  const rosterCss = readFileSync(new URL('../../src/home-roster-polish.css', import.meta.url), 'utf8')
  const stylesCss = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
  const refinementsCss = readFileSync(new URL('../../src/theme-refinements.css', import.meta.url), 'utf8')
  const normalBackground = activeLedgerBackground(contextCss, false)
  const hoverBackground = activeLedgerBackground(contextCss, true)
  const normalRule = rules(contextCss).filter(rule => isLedgerChipSelector(rule.selector, false)
    && rule.body.includes('color:')).at(-1)
  assert.ok(normalRule, 'the final Home ledger-chip rule keeps its label color')
  const label = declaration(normalRule.body, 'color')

  for (const theme of THEMES) {
    const tokens = { ...themeTokens(stylesCss, theme), ...themeTokens(refinementsCss, theme) }
    const expressions = { ...themeExpressions(stylesCss, theme), ...themeExpressions(refinementsCss, theme) }
    for (const required of ['--bg', '--ink', '--s-warn']) assert.ok(tokens[required], `${theme} defines ${required}`)
    const surface = resolveColor(activeSurfaceExpression(contextCss, rosterCss, theme), tokens, expressions)
    const foreground = resolveColor(label, tokens, expressions)
    const normalGround = over(resolveColor(normalBackground, tokens, expressions), surface)
    const hoverGround = over(resolveColor(hoverBackground, tokens, expressions), surface)
    const normalRatio = colorContrast(toHex(foreground), toHex(normalGround))
    const hoverRatio = colorContrast(toHex(foreground), toHex(hoverGround))
    t.diagnostic(`${theme}: normal ${normalRatio.toFixed(2)}:1; hover ${hoverRatio.toFixed(2)}:1`)
    assert.ok(normalRatio >= 4.5, `${theme} normal label ${toHex(foreground)} on ${toHex(normalGround)} is ${normalRatio.toFixed(2)}:1`)
    assert.ok(hoverRatio >= 4.5, `${theme} hover label ${toHex(foreground)} on ${toHex(hoverGround)} is ${hoverRatio.toFixed(2)}:1`)
  }
})
