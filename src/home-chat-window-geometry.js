// Window placement is independent of conversation state. All coordinates are
// in the workspace's CSS pixels, including when the app is zoomed.
const clamp = (value, low, high) => Math.min(Math.max(value, low), high)
export function fitChatWindow(rect, area) {
  const width = clamp(Number(rect.width) || 760, Math.min(360, area.width), area.width)
  const height = clamp(Number(rect.height) || 600, Math.min(300, area.height), area.height)
  return { x: clamp(Number(rect.x) || 0, 0, area.width - width),
    y: clamp(Number(rect.y) || 0, 0, area.height - height), width, height }
}
export function initialChatWindow(area, index = 0) {
  return fitChatWindow({ x: 24 * (index % 7), y: 24 * (index % 7),
    width: Math.min(940, area.width * .8), height: area.height * .88 }, area)
}
export function chatPanelRects(area, count, gap = 12) {
  const columns = count === 1 ? 1 : 2, rows = count === 4 ? 2 : 1
  const width = (area.width - gap * (columns - 1)) / columns
  const height = (area.height - gap * (rows - 1)) / rows
  return Array.from({ length: count }, (_, index) => ({
    x: (index % columns) * (width + gap), y: Math.floor(index / columns) * (height + gap), width, height,
  }))
}
export function moveChatWindow(rect, dx, dy, area) {
  return fitChatWindow({ ...rect, x: rect.x + dx, y: rect.y + dy }, area)
}
export function resizeChatWindow(rect, edge, dx, dy, area) {
  let left = rect.x, top = rect.y, right = left + rect.width, bottom = top + rect.height
  const minWidth = Math.min(360, area.width), minHeight = Math.min(300, area.height)
  if (edge.includes('w')) left = clamp(left + dx, 0, right - minWidth)
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, area.width)
  if (edge.includes('n')) top = clamp(top + dy, 0, bottom - minHeight)
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, area.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}
