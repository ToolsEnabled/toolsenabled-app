'use strict'

import { textZoom } from './text-size.js'

/* A SHARED DRAG-TO-RESIZE PRIMITIVE.
 *
 * src/views/comms.js (onBoxPointerDown) and src/metrics-layout.js
 * (onGripPointerDown) already carry a pointer lifecycle for drag-and-DROP: an
 * element changes which container it belongs to, so both track a ghost node
 * and a drop target. Resizing changes one NUMBER, not which container
 * something is in, so it does not need either -- this is its own small
 * module rather than a third copy of theirs bent to fit.
 *
 * WHY A CALLBACK RATHER THAN A DOM RULE. A resize handle can sit inside a
 * CSS grid whose real size came from `minmax()`/`clamp()`, a plain inline
 * style, or (a floating chat card on the fleet-tree canvas) numbers computed
 * in a pan/zoom coordinate space -- there is no one CSS property this module
 * could set that would be correct at every call site. `apply(px)` and
 * `getSize()` let each caller own that decision; this module owns only the
 * pointer math, the clamp and the persisted number.
 *
 * EVERY NUMBER HERE IS IN CSS PX -- THE UNITS `apply()` WRITES -- AND THE
 * POINTER IS NOT.
 *
 * A pointer event's clientX/clientY are in the window's pixels. A length in a
 * style, and the size a caller reads back with offsetWidth/offsetHeight, are
 * in the element's own pixels. The Text size setting is `zoom` on <body>
 * (src/text-size.js), and those two spaces then differ by exactly that zoom.
 * MEASURED 2026-09-03, electron 43.3.0: a 300px-tall box under zoom 1.12
 * reports offsetHeight 300 and getBoundingClientRect().height 336. So a drag
 * that moved the pointer 112 window px used to change the size by 112 element
 * px, which paints 125 -- the edge ran 12% ahead of the finger holding it,
 * every time, at Large, and stopped 10% short of it at Small. Dividing the
 * pointer delta by the zoom is what makes the edge follow the pointer.
 *
 * The `min`/`max` clamp and the number in storage are in the same CSS px, so
 * they mean one thing at every text size -- a stored width does not grow 12%
 * because the person who saved it was reading at Large.
 */

export function attachResizeHandle(handle, {
  axis = 'x',
  getSize,
  apply,
  min = 0,
  max = Infinity,
  storageKey = null,
  invert = false,
} = {}) {
  if (!handle || typeof apply !== 'function' || typeof getSize !== 'function') return () => {}

  const clamp = (n) => Math.min(max, Math.max(min, n))

  const restored = readSize(storageKey)
  if (restored !== null) apply(clamp(restored))

  let drag = null
  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const pos = axis === 'x' ? event.clientX : event.clientY
    const delta = (pos - drag.startPos) / drag.zoom * (invert ? -1 : 1)
    apply(clamp(drag.startSize + delta))
  }
  const endDrag = () => {
    if (!drag) return
    handle.classList.remove('is-dragging')
    handle.removeEventListener('pointermove', onPointerMove)
    handle.removeEventListener('pointerup', onPointerUp)
    handle.removeEventListener('pointercancel', onPointerCancel)
    drag = null
  }
  const onPointerUp = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    writeSize(storageKey, clamp(getSize()))
    endDrag()
  }
  const onPointerCancel = (event) => { if (drag && event.pointerId === drag.pointerId) endDrag() }
  const onPointerDown = (event) => {
    if (event.button !== 0 || drag) return
    event.preventDefault()
    /* Capture routes every further pointer event to this element regardless
       of where the cursor is, so a fast drag that outruns the handle's own
       bounds (or leaves the window) keeps working -- the reason this can
       listen on the handle itself instead of the window the way the two
       drag-and-drop lifecycles above have to. */
    handle.setPointerCapture?.(event.pointerId)
    /* Read once per drag, not per move: the text size cannot change while a
       pointer is down (the control that changes it is in the drawer, which
       takes the pointer), and this runs on every pointermove. */
    drag = {
      startSize: getSize(),
      startPos: axis === 'x' ? event.clientX : event.clientY,
      pointerId: event.pointerId,
      zoom: textZoom(handle.ownerDocument),
    }
    handle.classList.add('is-dragging')
    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', onPointerUp)
    handle.addEventListener('pointercancel', onPointerCancel)
  }
  handle.addEventListener('pointerdown', onPointerDown)

  /* KEYBOARD REACHES THE SAME NUMBER A DRAG DOES. A handle with only a
     pointer path is a mouse-only control wearing role="separator", which
     fails the one part of that role a screen-reader or keyboard user
     actually depends on. */
  const onKeyDown = (event) => {
    const step = event.shiftKey ? 40 : 10
    let delta = 0
    if (axis === 'x' && event.key === 'ArrowLeft') delta = -step
    else if (axis === 'x' && event.key === 'ArrowRight') delta = step
    else if (axis === 'y' && event.key === 'ArrowUp') delta = -step
    else if (axis === 'y' && event.key === 'ArrowDown') delta = step
    else return
    event.preventDefault()
    const next = clamp(getSize() + (invert ? -delta : delta))
    apply(next)
    writeSize(storageKey, next)
  }
  handle.addEventListener('keydown', onKeyDown)

  return () => {
    endDrag()
    handle.removeEventListener('pointerdown', onPointerDown)
    handle.removeEventListener('keydown', onKeyDown)
  }
}

function readSize(key) {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

function writeSize(key, px) {
  if (!key) return
  try { localStorage.setItem(key, String(Math.round(px))) } catch { /* session-only is still a real change */ }
}
