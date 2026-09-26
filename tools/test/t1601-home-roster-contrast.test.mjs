import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ROLE_COLOR_DEFAULTS, roleColorTone } from '../../src/role-colors.js'

const read = relative => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const homeContext = read('src/home-context.css')
const rosterPolish = read('src/home-roster-polish.css')
const styles = read('src/styles.css')
const themeRefinements = read('src/theme-refinements.css')

function rulesWith(css, needle) {
  const rules = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes(needle)) rules.push({ selector: match[1].trim(), body: match[2] })
  }
  return rules
}

function blocksWith(css, needle) {
  return rulesWith(css, needle).map(rule => rule.body)
}

function declaration(block, name) {
  return block.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`))?.[1]?.trim() || ''
}

function hex(value) {
  const match = value.match(/^#([0-9a-f]{6})$/i)
  assert.ok(match, `expected a six-digit theme colour, got ${value}`)
  return [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
}

function mix(first, second, secondWeight) {
  return first.map((channel, index) => channel * (1 - secondWeight) + second[index] * secondWeight)
}

function linear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(value) {
  return 0.2126 * linear(value[0]) + 0.7152 * linear(value[1]) + 0.0722 * linear(value[2])
}

function contrast(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function mixWeight(value) {
  const match = value.match(/color-mix\(in srgb,\s*var\(--ink\)\s+([0-9.]+)%/i)
  assert.ok(match, `expected an ink color-mix declaration, got ${value}`)
  return Number(match[1]) / 100
}

const monoRules = blocksWith(homeContext, '.home-roster-mono')
const monoRefinement = monoRules.findLast(block => block.includes('var(--rc'))
const looseRefinement = homeContext.match(/\.home :is\(\.home-feed-wrap, \.home-chat-pane-body\) \.home-roster-mono\.is-loose \{([^}]*)\}/)?.[1] || ''
const rosterSurfaceRules = rulesWith(rosterPolish, ':has(.home-roster-readable)')
  .filter(rule => rule.selector.includes('.home :is(.home-feed-wrap, .home-chat-pane-body):has(.home-roster-readable)'))
  .filter(rule => declaration(rule.body, '--home-context-surface'))
const lightRosterSurface = rosterSurfaceRules.find(rule => !rule.selector.includes(':root:is('))
const darkRosterSurface = rosterSurfaceRules.find(rule => rule.selector.includes('[data-theme="black"]'))
const activeSurfaceRules = { light: lightRosterSurface, dark: darkRosterSurface }
const activeSurfaceWeights = Object.values(activeSurfaceRules).map(rule => mixWeight(declaration(rule.body, '--home-context-surface')))
const badgeWeight = Number(monoRefinement?.match(/var\(--rc, var\(--ink\)\)\s+([0-9.]+)%/)?.[1]) / 100
const looseWeight = Number(looseRefinement.match(/var\(--ink\)\s+([0-9.]+)%/)?.[1]) / 100
const foregroundDeclaration = declaration(monoRefinement || '', 'color')
const shippedRoleColors = [...new Set(Object.values(ROLE_COLOR_DEFAULTS))]
const darkThemes = new Set(['black', 'ember', 'cobalt'])

function activeSurfaceRule(theme) {
  return activeSurfaceRules[darkThemes.has(theme) ? 'dark' : 'light']
}

function rowPaper(theme, bg, ink) {
  const paper = declaration(activeSurfaceRule(theme).body, '--home-agent-paper')
  assert.ok(paper, `${theme} readable-roster row paper is not declared`)
  if (paper === 'var(--bg)') return hex(bg)
  return mix(hex(bg), hex(ink), mixWeight(paper))
}

function foregroundFor(theme, ink, accent) {
  if (/var\(--role-ink\b/.test(foregroundDeclaration)) {
    return hex(roleColorTone(accent, theme, 4.5))
  }
  assert.match(foregroundDeclaration, /var\(--ink\b/, 'roster monogram foreground is not a shipped theme token')
  return hex(ink)
}

function accentFor(theme, accent) {
  return roleColorTone(accent, theme)
}

function assertContrast(actual, label) {
  const ratio = contrast(actual.foreground, actual.background)
  assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1`)
}

const THEME_NAMES = ['white', 'tan', 'black', 'ember', 'cobalt']
const themeVars = name => {
  const base = blocksWith(styles, ':root').find(block => declaration(block, '--bg')) || ''
  const candidates = [
    ...blocksWith(styles, `[data-theme="${name}"]`),
    ...blocksWith(themeRefinements, `[data-theme="${name}"]`),
  ]
  const blocks = [base, ...candidates]
  const final = name => blocks.map(block => declaration(block, name)).filter(Boolean).at(-1)
  const bg = final('--bg')
  const ink = final('--ink')
  const ink2 = final('--ink-2')
  return { bg, ink, ink2 }
}

test('T1601 roster initials use theme ink over the shipped role tint', () => {
  assert.ok(monoRefinement, 'the final roster monogram rule is missing')
  assert.ok(foregroundDeclaration, 'the roster monogram foreground is missing')
  assert.ok(/var\(--ink\b|var\(--role-ink\b/.test(foregroundDeclaration), 'roster monogram foreground is not a supported source token')
  assert.match(monoRefinement, /background:\s*color-mix\(in srgb, var\(--rc, var\(--ink\)\)\s+[0-9.]+%\s*,\s*var\(--home-context-surface\)\)/,
    'the role tint was removed from the badge')
  assert.match(monoRefinement, /box-shadow:[^;]*var\(--rc, var\(--ink\)\)/, 'the role edge was removed from the badge')
  assert.match(looseRefinement, /color:\s*var\(--ink-2\)\s*;/, 'the loose-agent foreground changed without a contrast contract')
  assert.ok(Number.isFinite(looseWeight) && looseWeight > 0 && looseWeight < 1, 'loose-agent tint weight is not declared')
  assert.equal(rosterSurfaceRules.length, 2, 'readable-roster light/dark surface rules are not both declared')
  assert.ok(activeSurfaceRules.light && activeSurfaceRules.dark, 'readable-roster surface theme mapping is incomplete')
  assert.equal(activeSurfaceWeights.length, 2, 'active readable-roster surface mix weights are not declared')
  assert.ok(activeSurfaceWeights.every(weight => Number.isFinite(weight) && weight > 0 && weight < 1), 'active readable-roster surface weights are invalid')
  assert.ok(Number.isFinite(badgeWeight) && badgeWeight > 0 && badgeWeight < 1, 'badge tint weight is not declared')

  /* This is a deterministic CSS/token bound, not a browser-paint claim. The
     actual readable-roster surface is selected per theme, and its row paper
     is resolved before the badge mix. Normal role accents use the shipped
     role text/color pair when the selected CSS rule still reads --role-ink;
     the corrected rule uses the theme ink. */
  for (const name of THEME_NAMES) {
    const { bg, ink, ink2 } = themeVars(name)
    assert.ok(bg && ink && ink2, `${name} theme must declare --bg, --ink and --ink-2`)
    const surfaceWeight = activeSurfaceWeights[darkThemes.has(name) ? 1 : 0]
    const surface = mix(hex(bg), hex(ink), surfaceWeight)
    assert.ok(rowPaper(name, bg, ink).every(channel => Number.isFinite(channel)), `${name} row paper cannot be resolved`)
    for (const shippedAccent of shippedRoleColors) {
      const roleAccent = accentFor(name, shippedAccent)
      const badge = mix(surface, hex(roleAccent), badgeWeight)
      assertContrast({ foreground: foregroundFor(name, ink, shippedAccent), background: badge }, `${name} ${shippedAccent} normal role`)
    }
    const looseBadge = mix(surface, hex(ink), looseWeight)
    assertContrast({ foreground: hex(ink2), background: looseBadge }, `${name} loose state`)
  }

  /* Conservative envelope: cover both active surface weights and extreme
     owner-selected accents. These weights are not a claim about browser paint;
     they protect the token contract across the two shipped surface regimes. */
  for (const name of THEME_NAMES) {
    const { bg, ink } = themeVars(name)
    for (const surfaceWeight of activeSurfaceWeights) {
      const surface = mix(hex(bg), hex(ink), surfaceWeight)
      for (const shippedAccent of ['#000000', '#ffffff']) {
        const roleAccent = accentFor(name, shippedAccent)
        const badge = mix(surface, hex(roleAccent), badgeWeight)
        assertContrast({ foreground: foregroundFor(name, ink, shippedAccent), background: badge }, `${name} ${surfaceWeight} ${shippedAccent} envelope`)
      }
    }
  }

  assert.match(foregroundDeclaration, /^var\(--ink\)$/, 'role text can fail on its own tint')
})
