import * as echarts from 'echarts/core'
import { LineChart, ScatterChart, BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
echarts.use([LineChart, ScatterChart, BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer])

export function createDataChart(host, model, fields, { x, y, kind }) {
  const xField = fields[x], yField = fields[y]
  if (!xField || !yField || !model.count) return null
  const { temporal, numeric, groups, count } = model
  const grouped = Boolean(model.seriesField)
  const chart = echarts.init(host, null, { renderer: 'svg' })
  chart.setOption({
    animation: false, useUTC: true, grid: { left: 68, right: 28, top: grouped ? 74 : 24, bottom: 58 },
    legend: { show: grouped, type: 'scroll', top: 0, left: 0, right: 0 },
    tooltip: { trigger: 'item', confine: true },
    xAxis: { type: temporal ? 'time' : numeric ? 'value' : 'category', name: xField.title || xField.name, nameLocation: 'middle', nameGap: 35, axisLabel: { hideOverlap: true } },
    // The axis has to say what it is showing. Labelling a change axis with the
    // plain column name reads, at a glance, as the measured value.
    yAxis: { type: 'value', name: (yField.title || yField.name) + (model.compare === 'change' ? ' — change from first point' : ''), scale: true },
    series: groups.map(group => ({ name: group.name, type: kind, data: group.data, symbolSize: 5, showSymbol: group.data.length < 80, connectNulls: false, lineStyle: { width: 2 } })),
  })
  const paintTheme = () => {
    const css = getComputedStyle(host), ink = css.color
    const accent = css.getPropertyValue('--rd-accent').trim() || '#175e68'
    const grid = css.getPropertyValue('--rd-chart-grid').trim() || '#b7c1cb'
    const panel = css.getPropertyValue('--rd-panel').trim() || '#fff'
    const palette = [accent, ...Array.from({ length: 5 }, (_, i) => css.getPropertyValue(`--rd-chart-color-${i + 2}`).trim())].filter(Boolean)
    const axis = { axisLabel: { color: ink, fontSize: 13 }, nameTextStyle: { color: ink, fontSize: 13 }, axisLine: { lineStyle: { color: grid } }, splitLine: { lineStyle: { color: grid, opacity: .5 } } }
    chart.setOption({ color: palette, textStyle: { color: ink, fontFamily: css.fontFamily }, legend: { textStyle: { color: ink, fontSize: 13 }, pageTextStyle: { color: ink }, pageIconColor: ink }, tooltip: { backgroundColor: panel, borderColor: grid, textStyle: { color: ink } }, xAxis: axis, yAxis: axis })
  }
  paintTheme()
  const themeObserver = new MutationObserver(paintTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  host.setAttribute('role', 'img')
  host.setAttribute('aria-label', `${yField.name} by ${xField.name}; ${count} points from the displayed sheet page; ${groups.length} ${groups.length === 1 ? 'series' : 'separate series'}${grouped ? ` grouped by ${model.seriesField.name}` : ''}.`)
  const observer = new ResizeObserver(() => chart.resize()); observer.observe(host)
  return { count, seriesCount: groups.length, destroy() { observer.disconnect(); themeObserver.disconnect(); chart.dispose(); host.removeAttribute('role'); host.removeAttribute('aria-label') } }
}
