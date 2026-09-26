import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SOURCE = new URL('../../src/metrics-charts.js', import.meta.url)
let loadId = 0

async function loadModule() {
  const instances = []
  const engine = {
    use() {}, connectCalls: [], disconnectCalls: [],
    connect(group) { this.connectCalls.push(group) },
    disconnect(group) { this.disconnectCalls.push(group) },
    init(host, theme, options) {
      const instance = {
        host, theme, options, group: null, disposed: false, optionsSet: [], handlers: {},
        setOption(option, flags) { this.optionsSet.push({ option, flags }) },
        on(event, handler) { this.handlers[event] = handler },
        isDisposed() { return this.disposed },
        resize() { this.resizeCount = (this.resizeCount || 0) + 1 },
        dispose() { this.disposed = true; this.disposeCount = (this.disposeCount || 0) + 1 },
      }
      instances.push(instance)
      return instance
    },
  }
  globalThis.__metricsChartsTest = { engine, instances }
  globalThis.window = {}

  let source = await readFile(SOURCE, 'utf8')
  source = source.replace(/^import[\s\S]*?from 'echarts\/core'\n/m, "const echarts = globalThis.__metricsChartsTest.engine\n")
  source = source.replace(/^import[\s\S]*?from 'echarts\/charts'\n/m, 'const LineChart = {}, BarChart = {}, HeatmapChart = {}, SankeyChart = {}\n')
  source = source.replace(/^import \{[\s\S]*?\} from 'echarts\/components'\n/m, 'const GridComponent = {}, TooltipComponent = {}, VisualMapComponent = {}, DataZoomComponent = {}, DataZoomInsideComponent = {}, MarkAreaComponent = {}\n')
  source = source.replace(/^import \{ UniversalTransition \} from 'echarts\/features'\n/m, 'const UniversalTransition = {}\n')
  source = source.replace(/^import \{ SVGRenderer \} from 'echarts\/renderers'\n/m, 'const SVGRenderer = {}\n')
  source = source.replace(/^import \{ PROVIDERS \} from '.\/vocab\.js'\n/m, "const PROVIDERS = [{ id: 'openai', label: 'OpenAI' }, { id: 'anthropic', label: 'Anthropic' }]\n")
  source = source.replace(/^import \{ withAlpha \} from '.\/echarts-theme\.js'\n/m, "const withAlpha = (color, alpha) => `${color}@${alpha}`\n")
  source += `\n// isolated test load ${loadId += 1}`
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return { module, engine, instances }
}

const theme = {
  poolAccent: '#pool', prov: { OpenAI: '#openai', openai: '#openai', Anthropic: '#anthropic', anthropic: '#anthropic' },
  ink2: '#ink2', ink3: '#ink3', bg: '#bg', sankeyRest: 0.2, sankeyHover: 0.7,
  font: 'sans', mono: 'mono', good: '#good', warn: '#warn', serious: '#serious',
  grid: '#grid', cross: '#cross', signal: '#signal', track: '#track', dark: false,
}

test('measured routing preserves totals and provenance while making supplied labels inert', async () => {
  const { module, instances } = await loadModule()
  const chart = module.createLiveUsageSankey({ id: 'routing' })
  chart.update({ theme, rows: [
    { pool: '<paid&pool>', provider: 'OpenAI', role: 'writer', tokens: 1200, calls: 2, tokenProvenance: 'meter', attributionProvenance: 'receipt' },
    { pool: '<paid&pool>', provider: 'OpenAI', role: 'writer', tokens: 300, calls: 1, tokenProvenance: 'meter', attributionProvenance: 'receipt' },
  ] })

  const issued = instances[0].optionsSet[0]
  const series = issued.option.series[0]
  const pool = series.data.find(node => node.kind === 'pool')
  assert.equal(pool.routed, 1500, 'a routing node must show the sum of every measured tuple that passes through it')
  assert.equal(series.links[0].value, 1500, 'equal tuple paths must aggregate instead of hiding one paid measurement')
  assert.equal(issued.flags?.notMerge, true, 'a complete measured observation must replace, not merge with, the previous reading')

  const edgeTip = issued.option.tooltip.formatter({ dataType: 'edge', data: series.links[0] })
  assert.match(edgeTip, /&lt;paid[^<]*pool&gt;/, 'operator-supplied routing labels must be escaped before tooltip markup')
  assert.ok(!edgeTip.includes('<paid&pool>'), 'operator-supplied routing labels must not become active tooltip markup')
  assert.match(edgeTip, /1,200[\s\S]*2[\s\S]*meter[\s\S]*receipt/, 'each measured tuple must retain its token, call, and provenance evidence')
})

test('chart lifecycles do not operate on an instance after it is disposed', async () => {
  const { module, instances } = await loadModule()
  const chart = module.createLiveUsageSankey({ id: 'routing' })
  assert.equal(instances[0].options.renderer, 'svg', 'the public chart must request the SVG renderer used by real callers')
  chart.resize()
  chart.dispose()
  chart.resize()
  chart.dispose()
  assert.equal(instances[0].resizeCount, 1, 'resize must become a no-op after the engine instance is disposed')
  assert.equal(instances[0].disposeCount, 1, 'dispose must be safe to call more than once')
})

test('the dashboard routes only failure-series lane clicks and cleans up every chart', async () => {
  const { module, engine, instances } = await loadModule()
  const selected = []
  const hosts = Object.fromEntries(['hero', 'strip', 'sankey', 'fail', 'heat', 'verdict', 'heartbeat', 'burn'].map(key => [key, { key }]))
  const charts = module.createCharts({ hosts, lanes: [], days: [], hourTicks: [], vsegs: [], onLaneClick: lane => selected.push(lane) })
  const fail = instances.find(instance => instance.host === hosts.fail)
  fail.handlers.click({ componentType: 'series', seriesId: 'fail-labels', name: 'overlay' })
  fail.handlers.click({ componentType: 'series', seriesId: 'fail-rate', name: 'review' })
  assert.deepEqual(selected, ['review'], 'only a click on the interactive failure-rate series may select a lane')
  assert.equal(window.__mcCharts?.hero?.host, hosts.hero, 'the documented probe must expose the active chart set')

  charts.dispose()
  assert.ok(instances.every(instance => instance.disposed), 'disposing the dashboard must dispose all eight engine instances')
  assert.deepEqual(engine.disconnectCalls, ['mc-band'], 'disposing the dashboard must disconnect its shared crosshair group')
  assert.equal('__mcCharts' in window, false, 'disposing the active dashboard must remove its probe rather than expose stale readings')
})
