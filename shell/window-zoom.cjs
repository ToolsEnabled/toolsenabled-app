'use strict'

/* ZOOM, WHICH REMOVING THE MENU TOOK AWAY (T1567).
 *
 * The shell removes the application menu for clean chrome, and Electron's
 * zoom accelerators live in that menu: Ctrl+Plus, Ctrl+Minus, Ctrl+0 and
 * Ctrl+wheel did nothing, and the largest Text size is 112%, so a low-vision
 * customer could not enlarge the app (WCAG 1.4.4 expects 200%). This puts the
 * browser's own zoom back: the same keys, the same steps as a desktop browser,
 * Ctrl+wheel, and the level remembered for the next launch. The narrow-window
 * layouts already hold at the widths a 200% zoom produces.
 */

const ZOOM_STEPS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3])
const EPSILON = 0.001

/* Which zoom a key press asks for: 'in', 'out', 'reset' or null. Ctrl (or
   Command) with Plus or Equals (with or without Shift), Minus, or 0, on the
   main row or the numeric keypad. Alt combinations are left alone. */
function zoomIntent(input) {
  if (!input || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null
  const key = String(input.key || '')
  const code = String(input.code || '')
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return 'in'
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out'
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset'
  return null
}

/* The next step from `current` in the asked direction, clamped to the ends. */
function nextZoom(current, intent) {
  const factor = Number.isFinite(current) && current > 0 ? current : 1
  if (intent === 'reset') return 1
  if (intent === 'in') return ZOOM_STEPS.find(step => step > factor + EPSILON) ?? ZOOM_STEPS.at(-1)
  if (intent === 'out') return [...ZOOM_STEPS].reverse().find(step => step < factor - EPSILON) ?? ZOOM_STEPS[0]
  return factor
}

/* A saved level is used only if it is one of the steps; anything else is 1. */
function savedZoom(value) {
  return ZOOM_STEPS.some(step => Math.abs(step - value) < EPSILON) ? Number(value) : 1
}

/* Wires zoom into one window's webContents. `initial` is the saved factor,
   `save(factor)` records a change. */
function attachWindowZoom(webContents, { initial = 1, save = () => {} } = {}) {
  let factor = savedZoom(initial)
  const current = () => {
    try { const live = webContents.getZoomFactor?.(); return Number.isFinite(live) && live > 0 ? live : factor } catch { return factor }
  }
  const apply = next => {
    factor = next
    try { webContents.setZoomFactor(factor) } catch { /* a closing window has nothing to zoom */ }
    save(factor)
  }
  webContents.on('did-finish-load', () => {
    if (factor !== 1) { try { webContents.setZoomFactor(factor) } catch { /* see apply */ } }
  })
  webContents.on('before-input-event', (event, input) => {
    const intent = zoomIntent(input)
    if (!intent) return
    event.preventDefault()
    apply(nextZoom(current(), intent))
  })
  webContents.on('zoom-changed', (_event, direction) => {
    apply(nextZoom(current(), direction === 'in' ? 'in' : 'out'))
  })
  return { get factor() { return factor } }
}

module.exports = { ZOOM_STEPS, zoomIntent, nextZoom, savedZoom, attachWindowZoom }
