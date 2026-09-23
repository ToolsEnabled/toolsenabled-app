// The Visualization | Data switch the Research builder's Composition and
// Nesting steps share. One control, one stored preference per page
// (mc.research.<page>.view), and the page root carries data-view so the
// stylesheet decides what each view shows. The editors re-render with
// innerHTML, so they append `el` again after every render; the element and
// its listener survive because they are never rebuilt here.
import './research-view-switch.css'

export const VIEW_VALUES = Object.freeze(['visual', 'data'])
const NAMES = { visual: 'Visualization', data: 'Data' }

export function readView(key, fallback = 'visual') {
  try {
    const stored = globalThis.localStorage?.getItem(key)
    return VIEW_VALUES.includes(stored) ? stored : fallback
  } catch { return fallback }
}

export function createViewSwitch({ key, label = 'View', onChange = () => {} }) {
  const el = document.createElement('div')
  el.className = 'research-view-switch'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', label)
  let value = readView(key)
  el.innerHTML = `<span class="research-view-switch-label">${label}</span>`
    + VIEW_VALUES.map(view => `<button type="button" data-view-choice="${view}" aria-pressed="${view === value}">${NAMES[view]}</button>`).join('')
  const paint = () => {
    for (const button of el.querySelectorAll('[data-view-choice]')) button.setAttribute('aria-pressed', String(button.dataset.viewChoice === value))
  }
  function set(next, { silent = false } = {}) {
    if (!VIEW_VALUES.includes(next) || next === value) return
    value = next
    try { globalThis.localStorage?.setItem(key, value) } catch {}
    paint()
    if (!silent) onChange(value)
  }
  el.addEventListener('click', event => {
    const button = event.target.closest('[data-view-choice]')
    if (!button || button.disabled) return
    event.stopPropagation()
    set(button.dataset.viewChoice)
  })
  return { el, get value() { return value }, set }
}
