import { isDarkTheme } from './theme-choice.js'
// ECharts theme bridge — a SNAPSHOT of the page's computed design tokens.
//
// WHY a snapshot instead of `var(--…)` strings: the SVG renderer resolves
// every colour into inline attributes and <linearGradient> stop definitions,
// where CSS custom properties are never evaluated — a var() string would
// paint black. So the tokens are read via getComputedStyle once per theme and
// handed to the option builders as literals. On a theme flip the metrics view
// rebuilds this snapshot and re-issues full options: one code path for boot,
// filter, sim drift AND theme, always animated. (v6 does ship setTheme(), but
// re-optioning is the same merge without leaning on the younger API — and we
// would still need this snapshot to build the theme object anyway.)
//
// The provider, status and activity-accent aliases are scoped to `.metrics`
// in metrics.css, not :root — read
// them off the mounted .metrics element or they come back empty strings /
// the site-wide values. Custom properties inherit, so scope reads still
// resolve root-declared tokens (--ink, --chart-grid…) correctly; everything
// below therefore reads through scopeCS first where a metrics re-step can
// exist, and rootCS only for tokens that are root-only by design.

const PROV_IDS = ['codex', 'claude', 'gemini', 'local']

const read = (cs, name, fallback) => {
  const v = cs.getPropertyValue(name).trim()
  return v || fallback
}

export function buildTheme(metricsEl) {
  const rootCS = getComputedStyle(document.documentElement)
  const scopeCS = getComputedStyle(metricsEl)
  const dark = isDarkTheme(document.documentElement.dataset.theme)

  // Metrics shades the current interface accent. In particular, an empty
  // hour is a faint mark on the current background, not a colored block.
  // Other chart surfaces keep their existing inherited sequential ramp.
  const heatInk = read(scopeCS, '--metric-heat-ink', '')
  const heatAlpha = [.05, .18, .34, .52, .75, 1]
  const heat = []
  for (let i = 0; i < 6; i++) heat.push(heatInk ? withAlpha(heatInk, heatAlpha[i]) : read(scopeCS, `--heat-${i}`, '#888888'))

  const prov = {}
  for (const id of PROV_IDS) {
    prov[id] = read(scopeCS, `--prov-${id}`, read(rootCS, '--ink-3', '#64727f'))
  }

  return {
    ink: read(rootCS, '--ink', '#0e1726'),
    ink2: read(rootCS, '--ink-2', '#4f5f70'),
    // the Sankey's pool nodes wear the same single neutral the pool columns
    // wear — pools are deliberately NOT categorical (see metrics.css), and
    // the routing diagram must not re-introduce a hue the pools gave up
    poolAccent: read(scopeCS, '--pool-accent', '#5c6b7a'),
    signal: read(scopeCS, '--heartbeat-ink', dark ? '#b8c4d1' : '#34495e'),
    ink25: read(rootCS, '--ink-25', '#5a6876'),
    ink3: read(rootCS, '--ink-3', '#64727f'),
    grid: read(rootCS, '--chart-grid', 'rgba(14,23,38,0.07)'),
    cross: read(rootCS, '--chart-cross', 'rgba(14,23,38,0.24)'),
    track: read(rootCS, '--chart-track', 'rgba(14,23,38,0.05)'),
    // Severity marks use the shared theme through aliases on .metrics. DOM
    // legend chips read the same --sev-* through the cascade, so a chip and
    // the bar/strip/segment it explains therefore use the same status color.
    good: read(scopeCS, '--sev-good', read(rootCS, '--s-good', '#0a6d3c')),
    warn: read(scopeCS, '--sev-warn', read(rootCS, '--s-warn', '#8f5902')),
    serious: read(scopeCS, '--sev-serious', read(rootCS, '--s-serious', '#b23811')),
    bg: read(rootCS, '--bg', '#f7f8fa'),
    sheet: read(rootCS, '--sheet', '#ffffff'),
    heat,
    prov,
    // the resolved stack, so chart text measures with the face it renders in
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    mono: read(getComputedStyle(document.body), '--font-mono', 'ui-monospace, monospace'),
    dark,
    // Sankey links carry their opacity in explicit gradient stops rather
    // than a blanket series alpha. The dark surface needs a little more
    // body at rest; light/tan need less ink to stay airy.
    sankeyRest: dark ? 0.34 : 0.24,
    sankeyMid: dark ? 0.42 : 0.31,
    sankeyHover: dark ? 0.72 : 0.58,
  }
}

/** Hex → rgba() at the given alpha. Non-hex tokens pass through untouched
 *  (they are only ever fully-opaque fills where alpha 1 is meant). */
export function withAlpha(color, a) {
  if (!color.startsWith('#')) return color
  let h = color.slice(1)
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}
