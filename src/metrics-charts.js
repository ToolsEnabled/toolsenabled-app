// The engine charts of #/metrics.
//
// SCOPE — eight instances now: the command band (token-flow hero with zoom +
// its crosshair-synced failure strip), the token-routing Sankey, failure-rate
// h-bars, fleet activity heatmap, review-verdict split, machine heartbeat and
// pool burn. The KPI-tile and
// agent-table sparklines stay on components.js/sparkline() on purpose: they
// are glyphs, not charts, and an engine per glyph would be all cost.
//
// The library must be INVISIBLE as a library. Three mechanisms enforce that:
//   1. Tree-shaken imports only, and Legend/Title/Toolbox are never
//      registered — our DOM headers and legend chips stay the only chrome,
//      so the gallery-demo look physically cannot leak in.
//   2. No default palette anywhere: every series colour is an explicit token
//      from the buildTheme() snapshot (echarts-theme.js), so the charts wear
//      the page's exact inks, ramps and status colours on every theme.
//   3. The tooltip is our own skin (.mtip in metrics.css) rendered through a
//      transparent ECharts container — engine positioning, our surface.
//
// What the engine buys over the old hand-rolled SVG: shape-morphing
// transitions when the Range/Machine filters retarget the data (replacing
// the view's lerpData rAF for these charts), a real axis-pointer crosshair,
// and per-series emphasis/blur focus — with SVGRenderer so text stays real
// text nodes (the styles.css tabular-nums rule keeps applying).

import * as echarts from 'echarts/core'
import { LineChart, BarChart, HeatmapChart, SankeyChart } from 'echarts/charts'
// The INSIDE zoom is the only zoom on the page now: the slider strip was
// eliminated in the unboxed redesign (screenshots: even fully restyled it
// read as library chrome pinned under the hero — a grey slab at rest,
// because a full window means "everything selected"). Wheel/drag zooms;
// the band's sub-caption says so in words. Legend/Title/Toolbox stay
// unregistered on purpose (the demo look cannot physically leak in).
import {
  GridComponent, TooltipComponent, VisualMapComponent,
  DataZoomComponent, DataZoomInsideComponent, MarkAreaComponent,
} from 'echarts/components'
import { UniversalTransition } from 'echarts/features'
import { SVGRenderer } from 'echarts/renderers'
import { PROVIDERS } from './vocab.js'
import { withAlpha } from './echarts-theme.js'

echarts.use([
  LineChart, BarChart, HeatmapChart, SankeyChart,
  GridComponent, TooltipComponent, VisualMapComponent,
  DataZoomComponent, DataZoomInsideComponent, MarkAreaComponent,
  UniversalTransition, SVGRenderer,
])

/* Severity thresholds — the same numbers the failure card's legend chips
   print (<2 / 2–5 / >5) and the agent table's fail column uses. */
const sevColor = (r, th) => r < 2 ? th.good : r < 5 ? th.warn : th.serious
const bandWord = (r) => r < 2 ? 'within budget' : r < 5 ? 'watch' : 'serious'

const pad2 = (n) => String(n).padStart(2, '0')
const N = 24
const CATS = Array.from({ length: N }, (_, i) => String(i))

/* Every tooltip: transparent engine container, content wrapped in .mtip so
   the skin (3px radius, the page's glass surface + shadow token, 13px ink)
   is one CSS rule that follows the theme through the cascade. appendToBody +
   confine clamps against the VIEWPORT — the same semantics the view's old
   hand-rolled viewportTooltip wrapper existed to add, now for free. */
const tipBase = () => ({
  appendToBody: true,
  confine: true,
  transitionDuration: 0,
  padding: 0,
  borderWidth: 0,
  backgroundColor: 'transparent',
  extraCssText: 'box-shadow:none;',
})
const mtip = (html) => `<div class="mtip">${html}</div>`

/* Motion flags, restated on EVERY setOption: reduced() can flip at any time
   (Settings toggle or the OS query), so the gate is per-payload, not per-init.
   `entrance` gives the one-time build-in the old flattened() boot tween had. */
function anim({ entrance, dur, reduced }) {
  return {
    animation: !reduced,
    animationDuration: entrance && !reduced ? 900 : 0,
    animationEasing: 'cubicOut',
    animationDurationUpdate: reduced ? 0 : dur,
    animationEasingUpdate: 'cubicInOut',
  }
}

const axisText = (th, color) => ({
  color, fontSize: 12.5, fontFamily: th.font, fontWeight: 400,
})
const axisNumberText = (th, color) => ({
  color, fontSize: 12.5, fontFamily: th.mono, fontWeight: 450,
})

/* ================= option builders =================
   Each builder returns the COMPLETE option for its chart, every colour
   inlined from the theme snapshot. One builder serves boot, filter flips,
   sim drift and theme flips alike — setOption merges by series id, so a
   re-issue animates rather than rebuilds. */

/* Both command-band charts must plot on IDENTICAL horizontal extents or the
   shared crosshair lies about x — one constant, consumed by both grids. */
const BAND_L = 46
const BAND_R = 26

/* x-axis for the band: the base 24 buckets keep the range's own canonical
   labels; live-appended buckets past them are the stream's continuation and
   are labelled as exactly that ("live +n") rather than borrowing a clock
   stop the range vocabulary never issued for them. */
const bandCats = (len) => len === N ? CATS : Array.from({ length: len }, (_, i) => String(i))
const bandLabel = (R, i) => i >= N ? `live +${i - N + 1}` : R.xlab(i)

function heroOption(P) {
  const { d, R, theme: th, live = [] } = P
  // canonical ticks stay OURS: d3-array picked d.tokTicks (1/2/5×10ⁿ) and
  // RANGE_META picked R.ticks (clock/weekday/elapsed-days stops); the engine
  // is only allowed to draw them, never to choose them
  const tickSet = new Set(R.ticks.map(t => Math.round(t)))
  const step = d.tokTicks.length > 1 ? d.tokTicks[1] - d.tokTicks[0] : d.tokMax
  const len = N + live.length
  const top = PROVIDERS.length - 1
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: { left: BAND_L, right: BAND_R, top: 14, bottom: 28 },
    xAxis: {
      type: 'category', boundaryGap: false, data: bandCats(len),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: {
        ...axisNumberText(th, th.ink3), interval: 0, margin: 9,
        formatter: (_, i) => tickSet.has(i) ? R.xlab(i) : '',
      },
    },
    yAxis: {
      type: 'value', min: 0, max: d.tokMax, interval: step,
      splitLine: { lineStyle: { color: th.grid, width: 1 } },
      axisLabel: { ...axisNumberText(th, th.ink3), margin: 8, formatter: (v) => String(v) },
    },
    // wheel/drag zoom only — the slider strip is gone (see the import note);
    // connect() mirrors this window into the failure strip below
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
    tooltip: {
      ...tipBase(), trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: th.cross, width: 1, type: 'solid' } },
      formatter: (params) => {
        const i = params[0]?.dataIndex ?? 0
        let total = 0
        const rows = params.map(q => {
          total += q.value
          return `<div class="tt-row"><i class="tt-key" style="background:${th.prov[q.seriesId]}"></i>${q.seriesName} <b>${Math.round(q.value)}k</b></div>`
        }).join('')
        return mtip(`<div class="tt-title">${bandLabel(R, i)}</div>${rows}<div class="tt-row tt-total">Total <b>${Math.round(total)}k</b></div>`)
      },
    },
    /* TRUE stacked bands, rebuilt from zero (owner verdict on the old one:
       four independent translucent areas pouring to baseline = mud). Every
       band is a SOLID Carbon categorical fill — bands physically cannot
       overlap, so no boundary can muddy. A 1.5px --bg seam rides each
       band's top line: the page's own colour drawn between fills, which is
       what makes four saturated hues read as machined parts rather than a
       poster. The topmost band's line carries the page's one new glow —
       a ≤8px same-hue breath kept under 0.35 alpha. */
    series: PROVIDERS.map((p, bi) => ({
      id: p.id, name: p.label, type: 'line', stack: 'tok',
      data: d.tokens[p.id].map(v => +v.toFixed(2)).concat(live.map(e => +e.tok[p.id].toFixed(2))),
      symbol: 'none', smooth: 0.25,
      color: th.prov[p.id],
      z: 2 + bi,
      lineStyle: bi === top
        ? {
            width: 2, color: th.prov[p.id], join: 'round',
            shadowBlur: 8, shadowColor: withAlpha(th.prov[p.id], 0.32), shadowOffsetY: -2,
          }
        : { width: 1.5, color: th.bg, join: 'round' },
      areaStyle: { color: th.prov[p.id], opacity: 1 },
      // hovering one provider's band recedes the other three; blur strength
      // hand-set — the engine default fades to near-invisible, which reads
      // as data disappearing rather than receding
      emphasis: {
        focus: 'series',
        lineStyle: { width: bi === top ? 2.4 : 1.8, shadowBlur: 7, shadowColor: withAlpha(th.prov[p.id], 0.28) },
      },
      blur: { lineStyle: { opacity: 0.3 }, areaStyle: { opacity: 0.35 } },
      universalTransition: true,
    })),
  }
}

/* The companion strip: failure-% on the hero's exact time axis. Its own axis
   chrome is nearly silent (the hero directly above carries the time labels);
   what it adds is the severity story — a hidden piecewise visualMap splits
   the line at the same 2/5 thresholds the failure card's legend prints, so
   the strip and the bars speak one language. */
function stripOption(P) {
  const { d, theme: th, live = [] } = P
  const series = d.failSeries.concat(live.map(e => e.fail))
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: { left: BAND_L, right: BAND_R, top: 5, bottom: 5 },
    xAxis: {
      type: 'category', boundaryGap: false, data: bandCats(series.length),
      axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
    },
    yAxis: {
      type: 'value', min: 0, max: 10, interval: 5,
      splitLine: { lineStyle: { color: th.grid, width: 1 } },
      axisLabel: { ...axisNumberText(th, th.ink3), margin: 8, formatter: (v) => v === 10 ? '10%' : String(v) },
    },
    // no slider of its own: connect() mirrors the hero's zoom into this
    // inside component, and wheel/drag here mirrors back
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
    visualMap: {
      show: false, type: 'piecewise', seriesIndex: 0, dimension: 1,
      pieces: [
        { lt: 2, color: th.good },
        { gte: 2, lt: 5, color: th.warn },
        { gte: 5, color: th.serious },
      ],
    },
    tooltip: {
      ...tipBase(), trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: th.cross, width: 1, type: 'solid' } },
      formatter: (params) => {
        const q = params[0]
        if (!q) return ''
        const v = Array.isArray(q.value) ? q.value[1] : q.value
        return mtip(`<div class="tt-title">${bandLabel(P.R, q.dataIndex)}</div><b>${v.toFixed(1)}%</b> failure · ${bandWord(v)}`)
      },
    },
    series: [{
      id: 'fail-strip', type: 'line',
      data: series.map((v, i) => [i, +v.toFixed(2)]),   // pairs so the visualMap reads dim 1
      symbol: 'none', smooth: false,
      lineStyle: { width: 2 },
      // a whisper of area so the strip reads as a chart, not a stray wire;
      // neutral ink, not a severity wash — the LINE carries the judgement
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: withAlpha(th.ink, 0.05) },
            { offset: 1, color: withAlpha(th.ink, 0) },
          ],
        },
      },
      universalTransition: true,
    }],
  }
}

/* ---------- token routing sankey — THE HERO ----------
   The one chart with an explicit owner verdict ("cool"), promoted to the
   page's centerpiece: full column, 430px, bare on the page. The view
   derives the flows (metrics.js buildSankey — data stays with the data
   owner); this builder only dresses them. Centerpiece dress: slim 3px-
   cornered node bars, generous vertical rhythm, gradient links resting at
   0.28 that lift to 0.55 with a soft same-hue glow on hover — the place
   the page spends its "kind of glowy" budget at data scale. Provider
   nodes wear the Carbon categorical hues; pools stay the one neutral;
   roles keep their site-wide identity hexes. layoutIterations: 0 keeps
   OUR declared node order; the solver's reshuffles read as the library
   deciding the page. */
const fmtFlow = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'M' : Math.round(v) + 'k'

function sankeyOption(P) {
  const { d, theme: th } = P
  /* pool and provider node colours resolve from the THEME SNAPSHOT here (the
     --prov-* set re-steps on black, the pool neutral is the columns' own
     slate); role hexes are theme-constant and travel with the data. The map
     also feeds each link's hover glow — the glow is the target's hue, so a
     lifted link answers "flowing INTO what?" */
  const nodeColor = (n) => n.kind === 'pool' ? th.poolAccent
    : n.kind === 'prov' ? th.prov[n.ref] : n.color
  const cmap = new Map(d.sankey.nodes.map(n => [n.name, nodeColor(n)]))
  const linkGradient = (l, alpha, middle = alpha) => ({
    type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
    colorStops: [
      { offset: 0, color: withAlpha(cmap.get(l.source) || th.ink3, alpha) },
      { offset: 0.46, color: withAlpha(cmap.get(l.source) || th.ink3, middle) },
      { offset: 0.54, color: withAlpha(cmap.get(l.target) || th.ink3, middle) },
      { offset: 1, color: withAlpha(cmap.get(l.target) || th.ink3, alpha) },
    ],
  })
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    tooltip: {
      ...tipBase(), trigger: 'item',
      formatter: (q) => q.dataType === 'edge'
        ? mtip(`<div class="tt-title">${q.data.source} → ${q.data.target}</div><b>${fmtFlow(q.value)}</b> tokens`)
        : mtip(`<div class="tt-title">${q.name}</div><b>${fmtFlow(q.value)}</b> routed`),
    },
    series: [{
      id: 'routing', type: 'sankey',
      // Labels live OUTSIDE the outer columns, so the plot reserves their
      // width instead of gambling on clipping at narrow builder widths.
      left: 150, right: 160, top: 18, bottom: 14,
      nodeWidth: 12, nodeGap: 26,
      layoutIterations: 0,
      emphasis: { focus: 'adjacency' },
      data: d.sankey.nodes.map(n => ({
        name: n.name, depth: n.depth, kind: n.kind, routed: n.routed,
        itemStyle: { color: nodeColor(n), borderWidth: 0, borderRadius: 3 },
        label: {
          position: n.depth === 0 ? 'left' : 'right', distance: 7,
          formatter: n.kind === 'role'
            ? `{name|${n.name}}`
            : `{name|${n.name}}{value| · ${fmtFlow(n.routed)}}`,
          // A page-colour halo is functional: even the smallest pool flow
          // can no longer thread through a word at the middle column.
          textBorderColor: th.bg, textBorderWidth: 3,
        },
      })),
      links: d.sankey.links.map(l => ({
        source: l.source, target: l.target, value: +l.value.toFixed(1),
        lineStyle: { color: linkGradient(l, th.sankeyRest, th.sankeyMid), opacity: 1, curveness: 0.5 },
        emphasis: {
          lineStyle: {
            color: linkGradient(l, th.sankeyHover, th.sankeyHover), opacity: 1,
            shadowBlur: 10, shadowColor: withAlpha(cmap.get(l.target) || th.ink3, th.dark ? 0.46 : 0.34),
          },
        },
      })),
      label: {
        fontSize: 12.5, lineHeight: 16, color: th.ink2,
        fontFamily: th.font, fontWeight: 560,
        rich: {
          name: {
            fontSize: 12.5, lineHeight: 16, color: th.ink2,
            fontFamily: th.font, fontWeight: 560,
          },
          value: {
            fontSize: 12.5, lineHeight: 16, color: th.ink3,
            fontFamily: th.mono, fontWeight: 450,
          },
        },
      },
      blur: {
        itemStyle: { opacity: 0.35 },
        lineStyle: { opacity: 0.06 },
        label: { opacity: 0.4 },
      },
    }],
  }
}

/* ---------- measured live routing ----------
   REDUNDANT PRE-FENCE IMPLEMENTATION, NOT THE LIVE METRICS PATH. The measured
   view now uses routingOption() and createLiveCharts() from
   metrics-live-charts.js, whose import graph deliberately cannot reach this
   demonstration module. This block remains only until its export and private
   helpers can be removed together.

   It deliberately had a separate, tiny lifecycle from createCharts(). A live
   metrics view must never initialize the seven simulated instruments; only a
   complete measured usage observation gets an ECharts instance. */
const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

function measuredSankey(rows) {
  const nodes = new Map()
  const links = new Map()
  const node = (kind, value, depth) => {
    const name = `${kind}:${value}`
    if (!nodes.has(name)) nodes.set(name, { name, label: value, kind, depth, inbound: 0, outbound: 0, routed: 0 })
    return name
  }
  const link = (source, target, row) => {
    const key = `${source}\u0000${target}`
    const current = links.get(key) || { source, target, value: 0, rows: [] }
    current.value += row.tokens
    current.rows.push(row)
    links.set(key, current)
  }
  for (const row of rows) {
    const pool = node('pool', row.pool, 0)
    const provider = node('provider', row.provider, 1)
    const role = node('role', row.role, 2)
    link(pool, provider, row)
    link(provider, role, row)
  }
  for (const edge of links.values()) {
    nodes.get(edge.source).outbound += edge.value
    nodes.get(edge.target).inbound += edge.value
  }
  for (const entry of nodes.values()) entry.routed = Math.max(entry.inbound, entry.outbound)
  return {
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label)),
    links: [...links.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
  }
}

function measuredSankeyOption({ rows, theme: th, dur = 0, reduced = false }) {
  const data = measuredSankey(rows)
  const nodeColor = (n) => n.kind === 'pool' ? th.poolAccent
    : n.kind === 'provider' ? th.prov[n.label] || th.ink2 : th.ink2
  const cmap = new Map(data.nodes.map(n => [n.name, nodeColor(n)]))
  const gradient = (edge, alpha) => ({
    type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
    colorStops: [
      { offset: 0, color: withAlpha(cmap.get(edge.source) || th.ink3, alpha) },
      { offset: 1, color: withAlpha(cmap.get(edge.target) || th.ink3, alpha) },
    ],
  })
  return {
    ...anim({ entrance: true, dur, reduced }),
    backgroundColor: 'transparent',
    tooltip: {
      ...tipBase(), trigger: 'item',
      formatter: (q) => {
        if (q.dataType !== 'edge') return mtip(`<div class="tt-title">${escapeHtml(q.data.label)}</div><b>${q.data.routed.toLocaleString('en-US')}</b> measured tokens`)
        const exact = q.data.rows.map(row =>
          `<div class="tt-row">${escapeHtml(row.pool)} → ${escapeHtml(row.provider)} → ${escapeHtml(row.role)} <b>${row.tokens.toLocaleString('en-US')}</b> tokens · ${row.calls.toLocaleString('en-US')} calls · token ${row.tokenProvenance} · attribution ${row.attributionProvenance}</div>`
        ).join('')
        return mtip(`<div class="tt-title">measured tuple rows</div>${exact}`)
      },
    },
    series: [{
      id: 'live-measured-routing', type: 'sankey',
      left: 150, right: 160, top: 18, bottom: 14,
      nodeWidth: 12, nodeGap: 26, layoutIterations: 0,
      emphasis: { focus: 'adjacency' },
      data: data.nodes.map(n => ({
        ...n,
        itemStyle: { color: nodeColor(n), borderWidth: 0, borderRadius: 3 },
        label: {
          position: n.depth === 0 ? 'left' : 'right', distance: 7,
          formatter: `{name|${escapeHtml(n.label)}}{value| · ${n.routed.toLocaleString('en-US')}}`,
          textBorderColor: th.bg, textBorderWidth: 3,
        },
      })),
      links: data.links.map(edge => ({
        ...edge,
        lineStyle: { color: gradient(edge, th.sankeyRest), opacity: 1, curveness: 0.5 },
        emphasis: { lineStyle: { color: gradient(edge, th.sankeyHover), opacity: 1 } },
      })),
      label: {
        fontSize: 12.5, lineHeight: 16, color: th.ink2, fontFamily: th.font, fontWeight: 560,
        rich: {
          name: { fontSize: 12.5, lineHeight: 16, color: th.ink2, fontFamily: th.font, fontWeight: 560 },
          value: { fontSize: 12.5, lineHeight: 16, color: th.ink3, fontFamily: th.mono, fontWeight: 450, padding: [0, 0, 0, 8] },
        },
      },
    }],
  }
}

export function createLiveUsageSankey(host) {
  const instance = echarts.init(host, null, { renderer: 'svg' })
  return {
    update(payload) { instance.setOption(measuredSankeyOption(payload), { notMerge: true }) },
    resize() { if (!instance.isDisposed()) instance.resize() },
    dispose() { if (!instance.isDisposed()) instance.dispose() },
  }
}

function failOption(P) {
  const { d, R, theme: th, lanes } = P
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: { left: 118, right: 10, top: 6, bottom: 19 },
    xAxis: {
      // fixed 0–10 domain on purpose — bars must not rescale under the
      // reader when the filter changes; 10 is the sim's clamp ceiling
      type: 'value', min: 0, max: 10, interval: 2,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: th.grid, width: 1 } },
      axisLabel: { ...axisNumberText(th, th.ink3), formatter: (v) => v === 10 ? '10%' : String(v) },
    },
    yAxis: {
      type: 'category', inverse: true, data: lanes,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { ...axisText(th, th.ink2), fontWeight: 500, margin: 10 },
    },
    tooltip: {
      ...tipBase(), trigger: 'item',
      formatter: ({ name, value }) =>
        mtip(`<div class="tt-title">${name}</div><b>${value.toFixed(1)}%</b> failure · ${bandWord(value)} · ${R.failSub}`),
    },
    series: [{
      id: 'fail-rate', type: 'bar', barWidth: 14,
      // groupId per lane so a future reorder glides rows rather than swaps
      data: d.fail.map(f => {
        const c = sevColor(f.rate, th)
        const sel = P.selectedLane === f.lane
        return {
          value: +f.rate.toFixed(2), groupId: f.lane,
          /* selection is a state of the DATA, restated on every re-issue so
             sim drift / theme flips cannot wash it away: the chosen lane at
             full saturation with a soft same-hue glow, the others receded —
             the same figure/ground move the token bands make on hover */
          itemStyle: {
            color: c,
            opacity: P.selectedLane && !sel ? 0.35 : 1,
            ...(sel ? { shadowBlur: 9, shadowColor: withAlpha(c, 0.45) } : {}),
          },
        }
      }),
      showBackground: true,
      backgroundStyle: { color: th.track, borderRadius: 2 },
      itemStyle: { borderRadius: [0, 3, 3, 0] },   // square baseline, soft data end
      label: { show: false },
      emphasis: { focus: 'series', itemStyle: { opacity: 0.88 } },
      blur: { itemStyle: { opacity: 0.24 } },
      universalTransition: true,
    }, {
      /* A silent max-domain overlay makes the values a true right-aligned
         column. Labels used to trail each bar and form a jagged diagonal
         over the tracks, obscuring the quantity they were meant to clarify. */
      id: 'fail-labels', type: 'bar', silent: true, barWidth: 14, barGap: '-100%', z: 5,
      data: d.fail.map(f => ({ value: 10, rawRate: +f.rate.toFixed(2) })),
      itemStyle: { color: 'transparent' },
      label: {
        show: true, position: 'insideRight', distance: 0,
        color: th.ink2, fontSize: 12.5, fontWeight: 600, fontFamily: th.mono,
        formatter: ({ data }) => `${data.rawRate.toFixed(1)}%`,
      },
      emphasis: { disabled: true },
    }],
  }
}

function heatOption(P) {
  const { d, theme: th, days, hourTicks } = P
  const data = []
  for (let dd = 0; dd < 7; dd++) {
    for (let h = 0; h < N; h++) data.push([h, dd, +d.heat[dd][h].toFixed(3)])
  }
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: { left: 36, right: 8, top: 6, bottom: 20 },
    xAxis: {
      type: 'category', data: CATS,
      axisLine: { show: false }, axisTick: { show: false },
      // canonical 6-hour clock stops, not a generic tick picker (AXIS RULE
      // beside RANGE_META in metrics.js)
      axisLabel: {
        ...axisNumberText(th, th.ink3), interval: 0, margin: 8,
        formatter: (_, i) => hourTicks.includes(i) ? pad2(i) : '',
      },
    },
    yAxis: {
      type: 'category', data: days, inverse: true,   // Mon on top, like the page reads
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { ...axisText(th, th.ink3), margin: 8 },
    },
    // the sequential ramp rides visualMap but the CONTROL stays hidden — the
    // heat-key chips in the card header are the only legend this card gets
    visualMap: {
      show: false, type: 'continuous', min: 0, max: 1,
      inRange: { color: th.heat },
      seriesIndex: 0,
    },
    tooltip: {
      ...tipBase(), trigger: 'item',
      formatter: ({ data: [h, dd, v] }) =>
        mtip(`<div class="tt-title">${days[dd]} ${pad2(h)}:00</div><b>${Math.round(v * 100)}%</b> lane activity`),
    },
    series: [{
      id: 'heat', type: 'heatmap', data,
      // 1px --bg borders are the cell gutters: on flat cards the card IS the
      // page background, so the seams read as bare surface, not strokes
      itemStyle: { borderColor: th.bg, borderWidth: 1, borderRadius: 2 },
      emphasis: {
        itemStyle: {
          borderColor: th.ink, borderWidth: 2,
          shadowBlur: 7, shadowColor: withAlpha(th.ink, th.dark ? 0.38 : 0.20),
        },
      },
      universalTransition: true,
    }],
  }
}

function verdictOption(P) {
  const { d, theme: th, vsegs } = P
  const total = vsegs.reduce((s, v) => s + d.verdicts[v.key], 0)
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    // axes exist only as the coordinate frame; max = total makes the bar a
    // true 100% split, and animating max is what tweens the shares
    xAxis: { type: 'value', min: 0, max: Math.max(1, total), show: false },
    yAxis: { type: 'category', data: [''], show: false },
    tooltip: {
      ...tipBase(), trigger: 'item',
      formatter: ({ seriesId, value }) => {
        const s = vsegs.find(x => x.key === seriesId)
        const pct = total ? (value / total) * 100 : 0
        return mtip(`<div class="tt-title">${s.k}</div><b>${Math.round(value)}</b> of ${Math.round(total)} · <b>${pct.toFixed(1)}%</b>`)
      },
    },
    series: vsegs.map((s, i) => ({
      id: s.key, name: s.k, type: 'bar', stack: 'v', barWidth: 22,
      data: [+d.verdicts[s.key].toFixed(2)],
      // 1px --bg border per segment = the 2px bare-surface gap the DOM
      // version cut out of each trailing edge; radius matches --r-sm
      itemStyle: {
        color: th[s.tone], borderColor: th.bg, borderWidth: 1,
        borderRadius: i === 0 ? [3, 0, 0, 3] : i === vsegs.length - 1 ? [0, 3, 3, 0] : 0,
      },
      emphasis: { focus: 'series', itemStyle: { borderColor: th.sheet, borderWidth: 2 } },
      blur: { itemStyle: { opacity: 0.4 } },
      universalTransition: true,
    })),
  }
}

/* ---------- machine heartbeat ----------
   Two stacked scopes share one clinical register. The line is deliberately
   role-neutral: machine identity is written in the DOM label, while hue is
   reserved for state. Only the moving tip glows, so the effect remains at
   data scale and a held signal reads as a genuine flatline. */
const heartTime = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

const heartbeatHiccupBands = (points) => {
  const bands = []
  let start = -1
  for (let i = 0; i < points.length; i++) {
    if (points[i].hiccup && start < 0) start = i
    const closes = start >= 0 && (!points[i].hiccup || i === points.length - 1)
    if (!closes) continue
    const end = points[i].hiccup ? i : i - 1
    bands.push([{ xAxis: String(start) }, { xAxis: String(end) }])
    start = -1
  }
  return bands
}

function heartbeatOption(P) {
  const { heartbeat, theme: th } = P
  const machines = heartbeat.machines
  const cats = machines[0]?.points.map((_, i) => String(i)) || []
  const selected = (machine) => P.machine === 'all' || P.machine === machine.id
  const xAxis = machines.map((_, i) => ({
    type: 'category', gridIndex: i, boundaryGap: false, data: cats,
    axisLine: { show: true, onZero: true, lineStyle: { color: th.grid, width: 1 } },
    axisTick: { show: false }, axisLabel: { show: false },
    axisPointer: { show: true, label: { show: false }, lineStyle: { color: th.cross, width: 1 } },
  }))
  const yAxis = machines.map((_, i) => ({
    type: 'value', gridIndex: i, min: -0.42, max: 1.02,
    axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false },
  }))
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: [
      { left: 2, right: 2, top: 22, height: 60 },
      { left: 2, right: 2, top: 114, height: 60 },
    ],
    xAxis, yAxis,
    tooltip: {
      ...tipBase(), trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: th.cross, width: 1 } },
      formatter: (params) => {
        const q = params[0]
        if (!q?.data?.meta) return ''
        const point = q.data.meta
        const machine = machines[q.seriesIndex]
        const status = point.hiccup ? 'signal held · sim hiccup'
          : point.beat ? 'beat recorded' : 'within cadence'
        return mtip(`<div class="tt-title">${machine.name}</div><b>${heartTime.format(point.at)}</b> · ${status}`)
      },
    },
    series: machines.map((machine, i) => {
      const on = selected(machine)
      const hiccups = heartbeatHiccupBands(machine.points)
      return {
        id: `heartbeat-${machine.id}`, name: machine.name, type: 'line',
        xAxisIndex: i, yAxisIndex: i,
        data: machine.points.map(point => ({ value: point.value, meta: point })),
        showSymbol: false, symbol: 'none',
        smooth: false, connectNulls: true,
        lineStyle: { color: th.signal, width: 1.35, opacity: on ? 0.9 : 0.2 },
        itemStyle: { color: th.signal, opacity: on ? 1 : 0.25 },
        /* A flat span is an event, never the neutral operating pattern. The
           warning underlay is rebuilt from the actual held points on every
           option issue, and its literal theme snapshot cannot go stale on a
           white/tan/black flip. */
        markArea: {
          silent: true,
          animation: false,
          label: { show: false },
          itemStyle: {
            color: withAlpha(th.warn, on ? 0.12 : 0.045),
            borderColor: withAlpha(th.warn, on ? 0.32 : 0.12),
            borderWidth: 0.75,
          },
          data: hiccups,
        },
        emphasis: { focus: 'series', lineStyle: { width: 1.8, opacity: 1 }, scale: 1.35 },
        blur: { lineStyle: { opacity: 0.14 }, itemStyle: { opacity: 0.2 } },
        universalTransition: true,
      }
    }),
  }
}

/* ---------- pool burn ----------
   The DOM owns exact remaining/runway figures; these two quiet traces show
   the measured rate history behind them. No categorical pool colour is
   introduced — it follows the same neutral doctrine as the pool meters. */
function burnOption(P) {
  const { d, R, theme: th } = P
  const rows = d.burn.rows
  const cats = rows[0]?.series.map((_, i) => String(i)) || []
  return {
    ...anim(P),
    backgroundColor: 'transparent',
    grid: [
      { left: 2, right: 2, top: 30, height: 48 },
      { left: 2, right: 2, top: 118, height: 48 },
    ],
    xAxis: rows.map((_, i) => ({
      type: 'category', gridIndex: i, boundaryGap: false, data: cats,
      axisLine: { show: true, lineStyle: { color: th.grid, width: 1 } },
      axisTick: { show: false }, axisLabel: { show: false },
      axisPointer: { show: true, label: { show: false }, lineStyle: { color: th.cross, width: 1 } },
    })),
    yAxis: rows.map((_, i) => ({
      type: 'value', gridIndex: i, min: 0,
      max: ({ max }) => max ? max * 1.14 : 1,
      axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false },
    })),
    tooltip: {
      ...tipBase(), trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: th.cross, width: 1 } },
      formatter: (params) => {
        const q = params[0]
        if (!q) return ''
        const row = rows.find(x => x.id === q.seriesId)
        if (!row) return ''
        const value = Number(q.value)
        const rate = row.kind === 'currency' ? `$${value.toFixed(2)}` : `${value.toFixed(1)} pts`
        return mtip(`<div class="tt-title">${row.id} · ${R.word}</div><b>${rate}</b> / machine-day`)
      },
    },
    series: rows.map((row, i) => ({
      id: row.id, name: row.id, type: 'line', xAxisIndex: i, yAxisIndex: i,
      data: row.series,
      showSymbol: true, symbol: 'circle',
      symbolSize: (_, q) => q.dataIndex === row.series.length - 1 ? 3.5 : 0,
      smooth: 0.34,
      lineStyle: { color: th.signal, width: 1.4, opacity: i === 0 ? 0.78 : 0.62 },
      itemStyle: {
        color: th.signal, shadowBlur: 5,
        shadowColor: withAlpha(th.signal, th.dark ? 0.5 : 0.26),
      },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: withAlpha(th.signal, th.dark ? 0.10 : 0.055) },
            { offset: 1, color: withAlpha(th.signal, 0) },
          ],
        },
      },
      emphasis: { focus: 'series', lineStyle: { width: 1.9, opacity: 1 }, scale: 1.25 },
      blur: { lineStyle: { opacity: 0.18 }, areaStyle: { opacity: 0.25 } },
      universalTransition: true,
    })),
  }
}

/* ================= lifecycle ================= */

/**
 * Init the eight instances and return { update, updateHeartbeat, updateBurn, resize, dispose }.
 * `hosts` = { hero, strip, sankey, fail, heat, verdict, heartbeat, burn } — sized by CSS
 * (fixed heights for the band and sankey, aspect-ratio for the plots, 22px
 * for the verdict bar), so the engine only ever fills, never sizes.
 * Payload per update: { d, R, theme, dur, entrance, reduced, live,
 * selectedLane } plus the static vocab (lanes/days/hourTicks/vsegs) here.
 * `onLaneClick(lane)` fires when a failure bar is clicked — the view owns
 * what "select a lane" means (table filter + selectedLane round-trip).
 */
export function createCharts({ hosts, lanes, days, hourTicks, vsegs, onLaneClick }) {
  const opts = { renderer: 'svg' }        // crisp at any DPR, real text nodes
  const inst = {
    hero: echarts.init(hosts.hero, null, opts),
    strip: echarts.init(hosts.strip, null, opts),
    sankey: echarts.init(hosts.sankey, null, opts),
    fail: echarts.init(hosts.fail, null, opts),
    heat: echarts.init(hosts.heat, null, opts),
    verdict: echarts.init(hosts.verdict, null, opts),
    heartbeat: echarts.init(hosts.heartbeat, null, opts),
    burn: echarts.init(hosts.burn, null, opts),
  }
  const statics = { lanes, days, hourTicks, vsegs }

  /* the command band is ONE reading instrument in two panes: connect()
     mirrors axisPointer moves and dataZoom windows between them, so the
     crosshair draws on both charts at the same x and zooming either zooms
     both. The group id is constant — dispose() empties it and disconnects. */
  inst.hero.group = 'mc-band'
  inst.strip.group = 'mc-band'
  echarts.connect('mc-band')

  if (onLaneClick) {
    inst.fail.on('click', (q) => {
      if (q.componentType === 'series' && q.seriesId === 'fail-rate') onLaneClick(q.name)
    })
  }

  /* Probe hook, NOT app state: the Playwright verification scripts must
     assert zoom-window equality and live-append counts, and the tree-shaken
     module scope is unreachable from the page console. Nothing in the app
     reads this; dispose() removes it. */
  window.__mcCharts = inst

  return {
    update(payload) {
      const P = { ...payload, ...statics }
      inst.hero.setOption(heroOption(P))
      inst.strip.setOption(stripOption(P))
      inst.sankey.setOption(sankeyOption(P))
      inst.fail.setOption(failOption(P))
      inst.heat.setOption(heatOption(P))
      inst.verdict.setOption(verdictOption(P))
      // Tray-first instruments stay paint-cold while absent from the layout.
      // Their view-side onArrange callback issues the first complete option
      // the instant they are placed, so default-layout pulses do no hidden
      // SVG work in the off-screen stash.
      if (P.placed?.heartbeat) inst.heartbeat.setOption(heartbeatOption(P))
      if (P.placed?.burn) inst.burn.setOption(burnOption(P))
    },
    updateHeartbeat(payload) {
      inst.heartbeat.setOption(heartbeatOption({ ...payload, ...statics }))
    },
    updateBurn(payload) {
      inst.burn.setOption(burnOption({ ...payload, ...statics }))
    },
    resize() {
      for (const c of Object.values(inst)) if (!c.isDisposed()) c.resize()
    },
    dispose() {
      for (const c of Object.values(inst)) if (!c.isDisposed()) c.dispose()
      echarts.disconnect('mc-band')
      if (window.__mcCharts === inst) delete window.__mcCharts
    },
  }
}
