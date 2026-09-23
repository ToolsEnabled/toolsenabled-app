/* The product's mark: the TE monogram, as geometry.
 *
 * tools/brand/te-monogram.svg is the owner's artwork, vendored byte-for-byte,
 * and it is the authority. This module restates its six rectangles and its
 * transform as data so both build-time consumers draw the same mark from the
 * same numbers:
 *
 *   - tools/brand-mark.mjs, which rasterizes it into shell/icon.ico
 *   - tools/gen-brand-icons.mjs, which emits public/brand-icon.svg
 *
 * One definition, and tools/test/brand-mark.test.mjs parses the owner's SVG
 * and asserts these numbers still describe it, so the mark cannot drift from
 * the file he supplied. Nothing here is a design choice about the mark itself
 * — the mark is not ours to change.
 *
 * BUILD-TIME ONLY, and it lives under tools/ for two reasons. The renderer
 * does not draw the mark: an in-window mark was tried in the topbar and
 * withdrawn, because the native title bar is hidden and that strip IS the
 * window frame — adding a child to it shifted the chrome the owner reads as
 * the border. Identity is carried by the app icon, the installer icon and the
 * favicon instead. Second, the reference SVG carries the company name in its
 * <title>, and that string is barred from src/ and shell/ by the guard in
 * tools/test/chat-agent-bridge-gated.test.mjs.
 */

export const VIEWBOX = Object.freeze({ width: 1024, height: 590 })
export const TRANSLATE_X = 65
export const SKEW_X_DEGREES = -14
export const RECTS = Object.freeze([
  Object.freeze({ x: 35, y: 30, width: 425, height: 110, rx: 20 }),
  Object.freeze({ x: 180, y: 120, width: 140, height: 440, rx: 22 }),
  Object.freeze({ x: 480, y: 30, width: 140, height: 530, rx: 22 }),
  Object.freeze({ x: 480, y: 30, width: 430, height: 110, rx: 20 }),
  Object.freeze({ x: 540, y: 225, width: 330, height: 100, rx: 18 }),
  Object.freeze({ x: 540, y: 450, width: 330, height: 110, rx: 20 }),
])

const DEGREES_TO_RADIANS = Math.PI / 180
const SKEW_K = Math.tan(SKEW_X_DEGREES * DEGREES_TO_RADIANS)

/** Local artwork coords -> final SVG user coords. */
export function transformPoint(x, y) {
  return { x: x + y * SKEW_K + TRANSLATE_X, y }
}

/** Final SVG user coords -> local artwork coords. */
export function untransformPoint(x, y) {
  return { x: x - TRANSLATE_X - y * SKEW_K, y }
}

/** Exact signed distance to one rounded rect: negative inside. */
export function roundedRectDistance(px, py, rect) {
  const radius = Math.min(rect.rx, rect.width / 2, rect.height / 2)
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  const qx = Math.abs(px - (rect.x + halfWidth)) - (halfWidth - radius)
  const qy = Math.abs(py - (rect.y + halfHeight)) - (halfHeight - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

/** True when a point in final SVG user space lands on the inked mark. */
export function markCoversPoint(x, y) {
  const local = untransformPoint(x, y)
  for (const rect of RECTS) {
    if (roundedRectDistance(local.x, local.y, rect) <= 0) return true
  }
  return false
}

/* The DRAWN extent of the mark, which is not the viewBox.
 *
 * The artwork's viewBox is 1024x590 but the ink inside it runs x 69.5..963.1,
 * y 30..560 — a wider margin on the left than the right. Anything that centres
 * the mark has to centre THIS, not the viewBox, or it hangs visibly off-centre.
 * Walks each rounded rect's outline through the transform, because that is
 * where the extremes are. */
let cachedBounds = null
export function markBounds({ arcSteps = 256 } = {}) {
  if (arcSteps === 256 && cachedBounds) return cachedBounds

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (localX, localY) => {
    const point = transformPoint(localX, localY)
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  for (const rect of RECTS) {
    const radius = Math.min(rect.rx, rect.width / 2, rect.height / 2)
    const left = rect.x
    const right = rect.x + rect.width
    const top = rect.y
    const bottom = rect.y + rect.height
    const corners = [
      { cx: left + radius, cy: top + radius, start: 180, end: 270 },
      { cx: right - radius, cy: top + radius, start: 270, end: 360 },
      { cx: right - radius, cy: bottom - radius, start: 0, end: 90 },
      { cx: left + radius, cy: bottom - radius, start: 90, end: 180 },
    ]
    for (const corner of corners) {
      for (let step = 0; step <= arcSteps; step += 1) {
        const angle = (corner.start + ((corner.end - corner.start) * step) / arcSteps) * DEGREES_TO_RADIANS
        consider(corner.cx + radius * Math.cos(angle), corner.cy + radius * Math.sin(angle))
      }
    }
  }

  const bounds = Object.freeze({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY })
  if (arcSteps === 256) cachedBounds = bounds
  return bounds
}

const round = (value) => Number(value.toFixed(4))
const rectMarkup = (rect) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${rect.rx}"/>`

/* The plated treatment, shared with the application icon.
 *
 * A favicon lands in browser chrome whose colour this app does not control and
 * cannot read, exactly like a taskbar. The owner's mark is black on
 * transparent, which disappears on a dark tab strip — so the favicon gets the
 * same plate the .ico gets, and for the same measured reason. See the
 * treatment note in tools/brand-mark.mjs. Values kept in sync there. */
export const PLATE_COLOR = '#f2e5bc'
export const PLATE_RADIUS_RATIO = 0.18
const FAVICON_MARK_WIDTH_RATIO = 0.8

/** A self-contained plated mark, sized to a square canvas. */
export function platedMonogramSvg({ size = 100 } = {}) {
  const bounds = markBounds()
  const markWidth = size * FAVICON_MARK_WIDTH_RATIO
  const scale = markWidth / bounds.width
  const markHeight = bounds.height * scale
  const offsetX = (size - markWidth) / 2
  const offsetY = (size - markHeight) / 2
  const radius = size * PLATE_RADIUS_RATIO

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" rx="${round(radius)}" fill="${PLATE_COLOR}"/>`
    + `<g transform="translate(${round(offsetX)} ${round(offsetY)}) scale(${round(scale)}) translate(${round(-bounds.minX)} ${round(-bounds.minY)})">`
    + `<g fill="#000000" transform="translate(${TRANSLATE_X} 0) skewX(${SKEW_X_DEGREES})">`
    + RECTS.map(rectMarkup).join('')
    + '</g></g></svg>'
}
