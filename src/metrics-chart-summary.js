/* WHAT A METRICS CHART SAYS, IN WORDS (T1591).
 *
 * The charts are SVG drawn by ECharts with no role, no name and nothing
 * focusable, so a screen reader read whatever text nodes happened to be in
 * them: Token flow was its axis ticks ('0 / 3,000 / ... / 06:00') and Run
 * activity its day and hour labels, with none of the amounts. A sighted person
 * got the shape of the day; a screen-reader user got tick marks.
 *
 * Each drawn chart's host becomes one image with a short text alternative
 * built from the same option the chart was drawn from: per series its total
 * and its peak, the busiest cell of a heatmap, the largest flows of a routing
 * diagram. The words come from the data, so they cannot disagree with the
 * picture.
 */

const number = value => Math.round(value).toLocaleString('en-US')
const listOf = value => (Array.isArray(value) ? value : value == null ? [] : [value])

function valueOf(item) {
  if (typeof item === 'number') return item
  if (Array.isArray(item)) return Number(item.at(-1))
  if (item && typeof item === 'object') return valueOf(item.value)
  return Number.NaN
}

function categories(axis) {
  const first = listOf(axis)[0]
  return Array.isArray(first?.data) ? first.data.map(entry => (entry && typeof entry === 'object' ? entry.value : entry)) : []
}

function seriesLine(series, xLabels, named) {
  const values = listOf(series.data).map(valueOf)
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return null
  const total = finite.reduce((sum, value) => sum + value, 0)
  const name = String(series.name || '').trim()
  if (finite.length === 1) return `${named && name ? `${name} ` : ''}${number(total)}`
  let peakAt = 0
  values.forEach((value, index) => { if (Number.isFinite(value) && value > values[peakAt]) peakAt = index })
  const label = xLabels[peakAt]
  const peak = `highest ${number(values[peakAt])}${label !== undefined && label !== '' ? ` at ${label}` : ''}`
  return `${named && name ? `${name}: ` : ''}${number(total)} in all, ${peak}`
}

function heatmapLine(series, xLabels, yLabels) {
  const cells = listOf(series.data).map(item => (Array.isArray(item) ? item : item?.value)).filter(Array.isArray)
  if (!cells.length) return null
  let total = 0, best = null
  for (const [x, y, value] of cells) {
    const amount = Number(value)
    if (!Number.isFinite(amount)) continue
    total += amount
    if (!best || amount > best.amount) best = { x, y, amount }
  }
  if (!best) return null
  const where = [yLabels[best.y], xLabels[best.x] !== undefined ? `hour ${xLabels[best.x]}` : ''].filter(Boolean).join(', ')
  return `${number(total)} in all, busiest ${number(best.amount)}${where ? ` (${where})` : ''}`
}

function sankeyLine(series) {
  const nodes = new Map(listOf(series.data ?? series.nodes).map(node => [node?.name, String(node?.label2 || node?.name || '')]))
  const links = listOf(series.links ?? series.edges).filter(link => Number.isFinite(Number(link?.value)))
  if (!links.length) return null
  const top = [...links].sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 3)
    .map(link => `${nodes.get(link.source) || link.source} to ${nodes.get(link.target) || link.target} ${number(Number(link.value))}`)
  return `${links.length} ${links.length === 1 ? 'flow' : 'flows'}, largest ${top.join(', ')}`
}

/** The text alternative for one chart: its title, then what its data says. */
export function chartSummary(title, option) {
  const name = String(title || 'Chart').trim() || 'Chart'
  const series = listOf(option?.series)
  const xLabels = categories(option?.xAxis), yLabels = categories(option?.yAxis)
  const named = series.filter(entry => entry?.type === 'line' || entry?.type === 'bar').length > 1
  const lines = []
  for (const entry of series) {
    if (!entry) continue
    const line = entry.type === 'heatmap' ? heatmapLine(entry, xLabels, yLabels)
      : entry.type === 'sankey' ? sankeyLine(entry)
        : seriesLine(entry, xLabels, named)
    if (line) lines.push(line)
  }
  return lines.length ? `${name}. ${lines.join('; ')}.` : `${name}. Nothing is drawn yet.`
}

/** Give a chart's host its role and text alternative. */
export function labelChart(host, option) {
  if (!host?.setAttribute) return ''
  const heading = host.getAttribute('data-chart-title')
    || host.closest?.('section, article, figure, [data-panel], [data-instrument]')?.querySelector?.('h2, h3, h4, figcaption')?.textContent
    || host.getAttribute('aria-label')?.split('.')[0]
  const words = chartSummary(String(heading || '').replace(/\s+/g, ' ').trim(), option)
  host.setAttribute('role', 'img')
  host.setAttribute('aria-label', words)
  return words
}
