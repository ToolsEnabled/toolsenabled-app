// Geometry only. Palm motion aims; a thumb/index pinch presses once per release.
const clamp = value => Math.max(0, Math.min(1, value))
export function createHandPointer({ releaseMs = 140, pressMs = 80 } = {}) {
  let point, lastAt, openAt, pinchAt, locked, armed = false, fired = false, identity
  function reset() {
    point = lastAt = openAt = pinchAt = locked = identity = undefined
    armed = fired = false
  }
  function update(landmarks, at, { aspect = 4 / 3, hand = '' } = {}) {
    if (!Array.isArray(landmarks) || landmarks.length !== 21 || !Number.isFinite(at)
      || !Number.isFinite(aspect) || aspect <= 0
      || landmarks.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      reset(); return null
    }
    const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y)
    const width = distance(landmarks[5], landmarks[17])
    if (width < 0.025) { reset(); return null }
    const palm = [0, 5, 9, 13, 17].map(i => landmarks[i])
    const position = {
      x: clamp((1 - palm.reduce((n, p) => n + p.x, 0) / palm.length - 0.15) / 0.7),
      y: clamp((palm.reduce((n, p) => n + p.y, 0) / palm.length - 0.15) / 0.7),
    }
    if (lastAt !== undefined && (at <= lastAt || at - lastAt > 250 || identity !== hand
      || (point && Math.hypot(position.x - point.x, position.y - point.y) > 0.4))) reset()
    const dt = lastAt === undefined ? 50 : at - lastAt
    lastAt = at; identity = hand
    const ratio = distance(landmarks[4], landmarks[8]) / width
    let click = false
    if (ratio >= 0.48) {
      pinchAt = locked = undefined; fired = false
      openAt ??= at
      if (at - openAt >= releaseMs) armed = true
    } else if (ratio <= 0.30) {
      openAt = undefined
      if (pinchAt === undefined) { pinchAt = at; locked = point || position }
      if (armed && !fired && at - pinchAt >= pressMs) {
        click = true; fired = true; armed = false
      }
    } else {
      openAt = undefined
      if (!fired) pinchAt = locked = undefined
    }
    // Freeze aim as fingers close. Smoothing is time-based, independent of FPS.
    const alpha = 1 - Math.exp(-dt / 65)
    point = locked || (!point ? position : {
      x: point.x + alpha * (position.x - point.x),
      y: point.y + alpha * (position.y - point.y),
    })
    return { ...point, click, pinching: locked !== undefined, armed, ratio }
  }
  return { update, reset }
}
