// Keep native mouse and keyboard behavior. On touch, wait for a horizontal
// gesture or a tap: Chromium otherwise changes the value on touch-down even
// when that touch becomes a vertical page scroll.
const touchRanges = new WeakSet()

export function bindTouchRange(input) {
  if (touchRanges.has(input) || typeof input.addEventListener !== 'function') return
  touchRanges.add(input)
  input.style.setProperty('touch-action', 'pan-y')
  let gesture = null
  const emit = type => {
    const EventType = input.ownerDocument?.defaultView?.Event || Event
    input.dispatchEvent(new EventType(type, { bubbles: true }))
  }
  const move = x => {
    if (!gesture || input.disabled) return
    const rect = input.getBoundingClientRect()
    if (!rect.width) return
    const min = Number(input.min || 0), max = Number(input.max || 100)
    const step = input.step === 'any' ? 0 : Number(input.step || 1)
    let value = min + Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * (max - min)
    if (step > 0) value = min + Math.round((value - min) / step) * step
    const previous = input.value
    input.value = String(Number(Math.max(min, Math.min(max, value)).toPrecision(12)))
    if (input.value !== previous) { gesture.changed = true; emit('input') }
  }
  input.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || event.isPrimary === false || input.disabled) return
    event.preventDefault()
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, startValue: input.value, horizontal: false, vertical: false, changed: false }
    input.focus?.({ preventScroll: true })
    input.setPointerCapture?.(event.pointerId)
  })
  input.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id || gesture.vertical) return
    const dx = Math.abs(event.clientX - gesture.x), dy = Math.abs(event.clientY - gesture.y)
    if (!gesture.horizontal) {
      if (dy > 6 && dy > dx) { gesture.vertical = true; return }
      if (dx <= 6 || dx <= dy) return
      gesture.horizontal = true
    }
    move(event.clientX)
  })
  const finish = event => {
    if (!gesture || event.pointerId !== gesture.id) return
    if (event.type === 'pointerup' && !gesture.vertical) {
      gesture.horizontal = true // a completed tap is an intentional value change
      move(event.clientX)
    }
    const changed = gesture.changed
    gesture = null
    if (changed) emit('change')
  }
  input.addEventListener('pointerup', finish)
  input.addEventListener('pointercancel', finish)
  // Range controls can apply touch-start's native value even when pointerdown
  // was cancelled. Suppress that speculative input before any preference or
  // draft writer sees it. Horizontal movement and the final tap are explicit.
  const rejectSpeculativeChange = event => {
    if (!gesture || gesture.horizontal) return
    event.stopImmediatePropagation()
    input.value = gesture.startValue
  }
  input.addEventListener('input', rejectSpeculativeChange, true)
  input.addEventListener('change', rejectSpeculativeChange, true)
}
export function numericText(value, unit = '') {
  const singular = { seconds: 'second', minutes: 'minute', records: 'record', agents: 'agent' }
  const words = Number(value) === 1 ? singular[unit] || unit : unit
  return `${value}${words === '%' ? '%' : words ? ` ${words}` : ''}`
}

export function syncNumericRange(input, unit = '') {
  bindTouchRange(input)
  const min = Number(input.min), max = Number(input.max), value = Number(input.value)
  const fill = Math.max(0, Math.min(100, (value - min) / (max - min || 1) * 100))
  input.style.setProperty('--fill', `${fill}%`)
  input.setAttribute('aria-valuetext', numericText(input.value, unit))
}
