/* A hierarchy is a union of rounded routes. Painting each route separately
   repeatedly covers its shared trunk; even a compound path can do that with
   non-scaling strokes at fractional zoom. Merge collinear intervals and keep
   each curve once, without changing any route's coordinates or corner shape. */
export function mergeTreeStrokeRoutes(paths) {
  const axes = new Map()
  const curves = new Map()
  const other = new Set()
  for (const path of paths) {
    let x = 0, y = 0
    for (const match of path.matchAll(/([MLQ])\s*([^MLQ]*)/g)) {
      const values = match[2].trim().split(/[\s,]+/).map(Number)
      const [a, b, c, d] = values
      if (match[1] === 'M') { x = a; y = b; continue }
      if (match[1] === 'Q') {
        const forward = `${x} ${y} ${a} ${b} ${c} ${d}`
        const reverse = `${c} ${d} ${a} ${b} ${x} ${y}`
        curves.set(forward < reverse ? forward : reverse, `M ${x} ${y} Q ${a} ${b} ${c} ${d}`)
        x = c; y = d
        continue
      }
      if (x !== a || y !== b) {
        if (x === a || y === b) {
          const vertical = x === a
          const fixed = vertical ? x : y
          const start = vertical ? y : x, end = vertical ? b : a
          const key = `${vertical ? 'v' : 'h'}:${fixed}`
          if (!axes.has(key)) axes.set(key, { vertical, fixed, intervals: [] })
          axes.get(key).intervals.push([Math.min(start, end), Math.max(start, end)])
        } else {
          const forward = `${x} ${y} L ${a} ${b}`, reverse = `${a} ${b} L ${x} ${y}`
          other.add(`M ${forward < reverse ? forward : reverse}`)
        }
      }
      x = a; y = b
    }
  }
  const result = []
  for (const { vertical, fixed, intervals } of axes.values()) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const merged = []
    for (const interval of intervals) {
      const previous = merged.at(-1)
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
      else merged.push([...interval])
    }
    for (const [start, end] of merged) result.push(vertical
      ? `M ${fixed} ${start} L ${fixed} ${end}`
      : `M ${start} ${fixed} L ${end} ${fixed}`)
  }
  return [...result, ...curves.values(), ...other].join(' ')
}
