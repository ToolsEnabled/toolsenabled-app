// The one research chart: a declared numeric result column, bar-per-row,
// labelled by the run's axis values. It follows the metrics-charts doctrine
// to the letter — tree-shaken engine imports, no Legend/Title/Toolbox so the
// gallery-demo look physically cannot leak in, every colour from the page's
// own computed tokens, and the tooltip wearing our .mtip skin through a
// transparent engine container.

import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer])

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

function readToken(name, fallback) {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * Build the rows the chart plots: one entry per table row that carries a
 * number in the chartable column, labelled by its axis values. Pure, so the
 * decision "is there anything to plot" is testable without a DOM.
 */
export function chartRows(model, column) {
  const rows = []
  /* Label by the run's AXES, which is what the doctrine above says and what a
     reader assumes. Labelling by "every column except the charted one" put a
     SECOND measurement in the label: charting mean printed sd_of_mean beside
     the bar, so the number next to a bar was not the bar's number (measured on
     the installed build, 2026-08-15). A model that does not name its axes
     falls back to the old behaviour rather than losing its labels. */
  const labelNames = (Array.isArray(model.axisNames) && model.axisNames.length
    ? model.axisNames
    : model.columns
  ).filter(name => name !== column.name)
  const labelIndexes = Array.isArray(model.columnMeta)
    ? model.columnMeta.flatMap((item, index) => item.kind === 'input' ? [index] : [])
    : labelNames.map(name => model.columns.indexOf(name))
  for (const row of model.rows) {
    const value = row.cells[column.index]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const label = labelIndexes
      .map(index => row.cells[index])
      .filter(cell => cell !== null && cell !== undefined)
      .map(cell => String(cell))
      .join(' · ')
    rows.push({ label: label || row.runId, value })
  }
  return rows
}

/**
 * Mount the value-by-axis bar into `host`. Returns { resize, destroy } or
 * null when there is nothing numeric to plot — the caller then renders no
 * chart rather than an empty frame.
 */
export function createResultChart(host, { model, column }) {
  const rows = chartRows(model, column)
  if (rows.length === 0) return null
  const instance = echarts.init(host, null, { renderer: 'svg' })
  const ink2 = readToken('--ink-2', '#4f5f70')
  const grid = readToken('--chart-grid', 'rgba(14,23,38,0.07)')
  const bar = readToken('--chart-cross', 'rgba(14,23,38,0.24)')
  instance.setOption({
    animation: false,
    grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      appendToBody: true, confine: true, transitionDuration: 0, padding: 0, borderWidth: 0,
      backgroundColor: 'transparent', extraCssText: 'box-shadow:none;',
      formatter: params => `<div class="mtip">${esc(params.name)} — ${esc(column.label || column.name)} ${esc(params.value)}</div>`,
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: ink2, fontSize: 12 },
      splitLine: { lineStyle: { color: grid } },
    },
    yAxis: {
      type: 'category',
      data: rows.map(row => row.label),
      axisLabel: { color: ink2, fontSize: 12 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      data: rows.map(row => row.value),
      itemStyle: { color: bar },
      barMaxWidth: 18,
    }],
  })
  // Expose the chart as one named image with the same values as its bars.
  // ECharts' SVG text alone only exposes axis ticks to assistive technology.
  const previousAttributes = ['role', 'aria-label', 'aria-description']
    .map(name => [name, host.getAttribute(name)])
  const omitted = model.rows.length - rows.length
  host.setAttribute('role', 'img')
  host.setAttribute('aria-label', `${column.label || column.name} by run`)
  host.setAttribute('aria-description', [
    `Bar chart with ${rows.length} plotted ${rows.length === 1 ? 'result' : 'results'}.`,
    ...rows.map(row => `${row.label}: ${row.value}.`),
    ...(omitted > 0 ? [`${omitted} ${omitted === 1 ? 'row is' : 'rows are'} not plotted because the value is missing or not a finite number.`] : []),
  ].join(' '))
  return {
    resize: () => instance.resize(),
    destroy: () => {
      instance.dispose()
      for (const [name, value] of previousAttributes) {
        if (value === null) host.removeAttribute(name)
        else host.setAttribute(name, value)
      }
    },
  }
}
