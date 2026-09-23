import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTheme, withAlpha } from '../../src/echarts-theme.js'

const ROOT = { kind: 'root', dataset: {} }
const BODY = { kind: 'body' }
const METRICS = { kind: 'metrics' }

function installStyles({ root = {}, metrics = {}, body = {}, theme = '' } = {}) {
  ROOT.dataset = theme ? { theme } : {}
  globalThis.document = { documentElement: ROOT, body: BODY }
  globalThis.getComputedStyle = element => {
    const values = element === ROOT ? root : element === METRICS ? metrics : body
    return {
      fontFamily: element === BODY ? (values.fontFamily || '') : '',
      getPropertyValue(name) { return values[name] || '' },
    }
  }
}

test('buildTheme snapshots root and metrics-scope tokens from the elements callers mount', () => {
  installStyles({
    root: {
      '--ink': '  root ink  ',
      '--ink-3': 'root neutral',
      '--chart-grid': 'root grid',
    },
    metrics: {
      '--heat-0': ' scoped heat ',
      '--prov-codex': ' scoped provider ',
      '--pool-accent': 'scoped pool',
      '--sev-good': 'scoped good',
    },
    body: { fontFamily: 'Fixture Sans', '--font-mono': ' Fixture Mono ' },
  })

  const theme = buildTheme(METRICS)
  assert.equal(theme.ink, 'root ink', 'root-only chart ink is read and whitespace-normalized')
  assert.equal(theme.grid, 'root grid', 'root-only chart structure is read from the root')
  assert.equal(theme.heat[0], 'scoped heat', 'the heat ramp uses the mounted metrics scope')
  assert.equal(theme.prov.codex, 'scoped provider', 'provider colors use the mounted metrics scope')
  assert.equal(theme.poolAccent, 'scoped pool', 'pool color uses the mounted metrics scope')
  assert.equal(theme.good, 'scoped good', 'severity marks use the mounted metrics scope')
  assert.equal(theme.font, 'Fixture Sans', 'chart text uses the body computed font')
  assert.equal(theme.mono, 'Fixture Mono', 'chart numbers use the resolved body mono token')
})

test('buildTheme preserves the documented fallback hierarchy for missing computed tokens', () => {
  installStyles({ root: { '--ink-3': 'root neutral', '--s-warn': 'root warning' } })

  const theme = buildTheme(METRICS)
  assert.equal(theme.prov.gemini, 'root neutral', 'a missing scoped provider remains visible with the root neutral')
  assert.equal(theme.warn, 'root warning', 'a missing scoped severity uses its root severity token')
  assert.equal(theme.heat[5], '#888888', 'a missing heat step has a visible neutral fallback')
  assert.equal(theme.font, 'system-ui, sans-serif', 'a missing computed font uses a readable system stack')
})

test('Metrics activity follows the selected interface accent and leaves zero activity faint', () => {
  installStyles({ metrics: { '--metric-heat-ink': '#4c625b', '--heat-0': '#0000ff' } })
  const tan = buildTheme(METRICS)
  assert.equal(tan.heat[0], 'rgba(76,98,91,0.05)', 'zero activity does not become a blue block on Tan')
  assert.equal(tan.heat.at(-1), 'rgba(76,98,91,1)')
  installStyles({ theme: 'black', metrics: { '--metric-heat-ink': '#a8c8c0' } })
  const black = buildTheme(METRICS)
  assert.equal(black.heat.at(-1), 'rgba(168,200,192,1)', 'the snapshot follows the newly selected theme')
  assert.notDeepEqual(black.heat, tan.heat)
})

test('buildTheme reports the active black surface and its stronger Sankey opacities', () => {
  installStyles({ theme: 'black' })

  const theme = buildTheme(METRICS)
  assert.equal(theme.dark, true, 'the black page theme is reported as dark to chart builders')
  assert.ok(theme.sankeyRest > 0.24, 'dark Sankey links are stronger than the light resting opacity')
  assert.ok(theme.sankeyMid > 0.31, 'dark Sankey links are stronger than the light midpoint opacity')
  assert.ok(theme.sankeyHover > 0.58, 'dark Sankey links are stronger than the light hover opacity')
})

test('both glow themes use the dark chart treatment', () => {
  for (const id of ['ember', 'cobalt']) {
    installStyles({ theme: id })
    const theme = buildTheme(METRICS)
    assert.equal(theme.dark, true)
    assert.ok(theme.sankeyRest > 0.24)
  }
})

test('buildTheme does not turn a failed style read into a seemingly definite theme', () => {
  ROOT.dataset = {}
  globalThis.document = { documentElement: ROOT, body: BODY }
  const failure = new Error('computed styles unavailable')
  globalThis.getComputedStyle = () => { throw failure }

  assert.throws(
    () => buildTheme(METRICS),
    error => error === failure,
    'a could-not-read result must stay a failure rather than becoming fallback colors',
  )
})

test('withAlpha converts the hex colors chart callers pass, including compact hex', () => {
  assert.equal(withAlpha('#1a2B3c', 0.31), 'rgba(26,43,60,0.31)', 'six-digit hex becomes the same RGB color at the requested alpha')
  assert.equal(withAlpha('#abc', 0), 'rgba(170,187,204,0)', 'compact hex expands each channel and preserves a zero alpha')
})

test('withAlpha leaves already-usable non-hex chart colors untouched', () => {
  const color = 'rgba(10, 20, 30, 0.4)'
  assert.equal(withAlpha(color, 0.9), color, 'a non-hex CSS color passes through instead of being corrupted')
})
