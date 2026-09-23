// Chart only the displayed rows. Grouping never changes, aggregates or infers
// the underlying table schema.
export function chartTableData(rows, fields, { x, y, kind = 'line', series = 'auto', compare = 'actual' }) {
  const xField = fields[x], yField = fields[y]
  const empty = { groups: [], count: 0, requiresSeries: [] }
  if (!xField || !yField) return empty
  const temporal = ['date', 'datetime'].includes(xField.type), numeric = ['number', 'integer'].includes(xField.type)
  if (series === 'auto' && kind !== 'scatter') {
    const mixed = fields.filter((field, index) => index !== x && index !== y && ['string', 'boolean'].includes(field.type) && new Set(rows.map(row => row.values[index]).filter(value => value != null)).size > 1)
    if (mixed.length) return { ...empty, requiresSeries: mixed.map(field => field.title || field.name) }
  }
  const seriesIndex = Number.isInteger(series) && fields[series] ? series : null
  const groups = new Map()
  let count = 0
  for (const row of rows) {
    const rawX = row.values[x], value = row.values[y], group = seriesIndex === null ? '' : row.values[seriesIndex]
    if (rawX == null || typeof rawX === 'bigint' || typeof value !== 'number' || !Number.isFinite(value) || group == null) continue
    const coordinate = temporal ? Date.parse(rawX) : rawX
    if ((temporal || numeric) && (typeof coordinate !== 'number' || !Number.isFinite(coordinate))) continue
    // Typed keys keep numeric identifiers exact, including integers beyond the
    // precision of chart coordinates, without conflating them with text.
    const key = `${typeof group}:${String(group)}`
    if (!groups.has(key)) groups.set(key, { name: seriesIndex === null ? yField.title || yField.name : String(group), data: [] })
    groups.get(key).data.push([coordinate, value]); count++
  }
  if (temporal || numeric) for (const group of groups.values()) group.data.sort((a, b) => a[0] - b[0])
  // A line says "these points are one continuous reading". When several rows in
  // a series share an X the line draws a vertical jump between records that are
  // merely simultaneous, not successive. Report it so the page can say so; the
  // person's explicit choice is still drawn, never silently overridden.
  let sharedX = 0
  for (const group of groups.values()) {
    const seen = new Map()
    for (const [coordinate] of group.data) seen.set(coordinate, (seen.get(coordinate) || 0) + 1)
    for (const times of seen.values()) if (times > 1) sharedX += times
  }
  // Nobody has answered for the default path. The grouping prompt already
  // refuses here when categories are mixed; a line through records that merely
  // share an X is the same dishonesty, so it refuses the same way and names the
  // way out. An explicit choice -- a chosen series column, or "all rows in one
  // series" -- has been answered once, and is drawn with the collision named.
  if (series === 'auto' && kind === 'line' && sharedX) return { ...empty, requiresScatter: true, sharedX, temporal, numeric }
  const result = { groups: [...groups.values()], count, requiresSeries: [], temporal, numeric, sharedX, seriesField: seriesIndex === null ? null : fields[seriesIndex] }
  // One shared value axis flattens every series whose level differs. Measured on
  // the research folder's own stock-prices sheet: seven symbols sitting between
  // 105 and 396 force an axis spanning 290.67, on which each symbol's actual
  // movement occupies 0.0% to 0.4% -- seven flat lines. Plotting each series as
  // the change from its own first point puts them on a comparable footing. It
  // subtracts, so it keeps the column's units and a baseline of zero or a
  // negative one is ordinary; it is never applied unasked, and the baselines are
  // returned so the page can say exactly what was taken off.
  if (compare !== 'change' || !result.groups.length) return result
  result.baselines = result.groups.map(group => ({ name: group.name, base: group.data.length ? group.data[0][1] : null }))
  for (const group of result.groups) {
    if (!group.data.length) continue
    const base = group.data[0][1]
    group.data = group.data.map(([coordinate, value]) => [coordinate, value - base])
  }
  result.compare = 'change'
  return result
}

// Choose the first axes a person is shown. Column position and declared type
// alone cannot tell a key apart from a measurement, so the choice is measured
// from the rows on the page: a column holding one value there cannot separate
// the points, whatever its type. Bound: distinct counts cover the loaded page,
// which is also all the chart draws.
const PLOTTABLE = ['number', 'integer'], TEMPORAL = ['date', 'datetime']
export function chooseChartAxes(fields, rows = []) {
  const type = index => fields[index]?.type
  const temporal = index => TEMPORAL.includes(type(index))
  const numeric = fields.map((field, index) => index).filter(index => PLOTTABLE.includes(type(index)))
  const candidates = fields.map((field, index) => index).filter(index => temporal(index) || PLOTTABLE.includes(type(index)))
  const distinct = index => {
    const seen = new Set()
    // Typed keys keep 1 and '1' apart, matching how the chart itself groups.
    for (const row of rows) { const value = row?.values?.[index]; if (value != null) seen.add(`${typeof value}:${String(value)}`) }
    return seen.size
  }
  const varies = index => distinct(index) > 1
  const separating = candidates.filter(varies)
  const forX = separating.length ? separating : candidates
  // A time axis is how people read a chart, so a datetime that separates the
  // points still wins over a numeric column with more distinct values.
  const x = forX.length ? forX.filter(temporal)[0] ?? forX.reduce((best, index) => distinct(index) > distinct(best) ? index : best) : 0
  const others = numeric.filter(index => index !== x)
  const measured = others.filter(varies), pool = measured.length ? measured : others
  // Prefer a declared measurement over an integer, which is more often a key.
  const y = pool.filter(index => type(index) === 'number')[0] ?? pool[0] ?? -1
  return { x, y }
}
