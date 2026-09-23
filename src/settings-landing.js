/* LANDING ON THE ROW A LINK NAMED, in Settings (#/settings?setting=<id>).
 *
 * Two things went wrong with the old one-frame landing, both measured on the
 * rig:
 *
 *   T1411  Every row was centred. The Assistant programs row (the Guide door,
 *          #/guide and every empty screen's 'Open Settings') is about 2,100 px
 *          tall, so centring it scrolled its heading and the whole Codex block
 *          above the window, and focus went to 'Install Codex' at top -407 px:
 *          a keyboard user saw nothing focused, and Enter would press an
 *          install they could not see.
 *   T1594  Focus was tried once, on the first frame. Rows that fill in their
 *          controls a moment later (Join this computer, Assistant programs)
 *          had nothing usable yet, and the landing was then marked done, so
 *          focus stayed on the page body and the next Tab went to the search
 *          box at the top.
 *
 * So: a row taller than the visible page is scrolled to its START, not its
 * middle; focus goes only to a usable control that is fully on screen; and a
 * row whose controls are still arriving is given a short wait, after which the
 * row itself takes focus so the reader is at least taken there. Nothing here
 * takes focus back from a person who has already moved it somewhere else.
 */

const CONTROLS = 'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])'
export const LANDING_FOCUS_WAIT_MS = 3000
const LANDING_FOCUS_STEP_MS = 100

/* A row that does not fit in the visible part of the page is shown from its
   start: centring it would hide its heading and first control above the fold. */
export function landingScrollBlock(rowHeight, visibleHeight) {
  return Number(rowHeight) > Number(visibleHeight) - 24 ? 'start' : 'center'
}

function usable(node) {
  if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false
  if (node.closest?.('[hidden], [inert]')) return false
  return !!node.getClientRects?.().length
}

/* The first usable control of the row that is wholly inside the visible box. */
export function landingControl(row, view) {
  for (const node of row?.querySelectorAll?.(CONTROLS) || []) {
    if (!usable(node)) continue
    const box = node.getBoundingClientRect()
    if (box.top >= view.top && box.bottom <= view.bottom) return node
  }
  return null
}

/* The part of a scrolling page a person can see: the scroller's box, cut to
   the window. */
export function visibleBoxOf(scroller, win = globalThis.window) {
  const box = scroller.getBoundingClientRect()
  const height = Number(win?.innerHeight) || box.bottom
  return { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, height) }
}

/* Scrolls the named row into view and puts focus on it, waiting a little for
   controls that arrive late. Returns false when the row is not drawn yet (the
   caller tries again on its next render), otherwise a cancel function.
     findRow()    the row's node now (renders may replace it)
     visibleBox() { top, bottom } of the part of the page a person can see
     doc          the document (activeElement, body)
     ownsFocus(n) true for nodes that do not count as the person's own place
                  (the page's scroller, the stage) */
export function landOnRow({ findRow, visibleBox, doc, ownsFocus = () => false,
  wait = globalThis.setTimeout, stopWaiting = globalThis.clearTimeout, now = Date.now,
  waitMs = LANDING_FOCUS_WAIT_MS, stepMs = LANDING_FOCUS_STEP_MS } = {}) {
  const first = findRow()
  if (!first || !first.getClientRects?.().length) return false
  const view = visibleBox()
  first.scrollIntoView({ behavior: 'auto', block: landingScrollBlock(first.getBoundingClientRect().height, view.bottom - view.top) })
  const started = now()
  let timer = null
  let cancelled = false
  const unclaimed = active => !active || active === doc.body || active === doc.documentElement || ownsFocus(active)
  /* Best effort by design: a page torn down between two tries must end the
     wait quietly rather than throw from a timer nobody is listening to. */
  const attempt = () => {
    timer = null
    if (cancelled) return
    try { tryFocus() } catch { cancelled = true }
  }
  const tryFocus = () => {
    const row = findRow()
    if (!row) { if (now() - started < waitMs) timer = wait(attempt, stepMs); return }
    const active = doc.activeElement
    if (active && row.contains?.(active) && active !== row) return
    if (!unclaimed(active) && active !== row) return
    const control = landingControl(row, visibleBox())
    if (control) { control.focus?.({ preventScroll: true }); return }
    if (now() - started < waitMs) { timer = wait(attempt, stepMs); return }
    if (!row.hasAttribute?.('tabindex')) row.setAttribute?.('tabindex', '-1')
    row.focus?.({ preventScroll: true })
  }
  attempt()
  return () => { cancelled = true; if (timer !== null) stopWaiting(timer); timer = null }
}
