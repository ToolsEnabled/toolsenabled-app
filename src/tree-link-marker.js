// Move the marker along its existing straight link, leaving the line itself
// untouched. Rectangle intersections become blocked intervals on t = 0..1.
export function clearLinkMarkerPoint(start, end, boxes = [], clearance = 13) {
  const finite = value => Number.isFinite(value) ? value : 0
  const a = { x: finite(start?.x), y: finite(start?.y) }
  const b = { x: finite(end?.x), y: finite(end?.y) }
  const midpoint = { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 }
  const dx = b.x - a.x, dy = b.y - a.y
  if ((!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return midpoint
  const pad = Number.isFinite(clearance) ? Math.max(0, clearance) : 13
  const blocked = []
  for (const box of Array.isArray(boxes) ? boxes : []) {
    if (!box || ![box.left, box.right, box.top, box.bottom].every(Number.isFinite)) continue
    let enter = 0, exit = 1, intersects = true
    for (const [origin, delta, low, high] of [
      [a.x, dx, Math.min(box.left, box.right) - pad, Math.max(box.left, box.right) + pad],
      [a.y, dy, Math.min(box.top, box.bottom) - pad, Math.max(box.top, box.bottom) + pad],
    ]) {
      if (!delta) {
        if (origin < low || origin > high) { intersects = false; break }
      } else {
        const first = (low - origin) / delta, last = (high - origin) / delta
        enter = Math.max(enter, Math.min(first, last))
        exit = Math.min(exit, Math.max(first, last))
        if (enter > exit) { intersects = false; break }
      }
    }
    if (intersects) blocked.push([enter, exit])
  }
  if (!blocked.some(([enter, exit]) => enter <= 0.5 && exit >= 0.5)) return midpoint
  blocked.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const interval of blocked) {
    const previous = merged.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else merged.push([...interval])
  }
  let best = null, distance = Infinity
  const consider = (low, high, openLow, openHigh) => {
    if (high <= low) return
    // Stay just beyond a padded edge; do not choose a point still on it.
    const epsilon = Math.min(1e-9, (high - low) / 4)
    const candidate = Math.max(low + (openLow ? epsilon : 0),
      Math.min(high - (openHigh ? epsilon : 0), 0.5))
    const nextDistance = Math.abs(candidate - 0.5)
    if (nextDistance < distance - 1e-12) { best = candidate; distance = nextDistance }
  }
  let cursor = 0, openCursor = false
  for (const [enter, exit] of merged) {
    consider(cursor, enter, openCursor, true)
    cursor = exit; openCursor = true
  }
  consider(cursor, 1, openCursor, false)
  if (best === null) return midpoint
  return { x: a.x * (1 - best) + b.x * best, y: a.y * (1 - best) + b.y * best }
}
