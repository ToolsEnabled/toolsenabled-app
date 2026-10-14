// Three semantic colors; preferences affect appearance, never ledger status.
import { normalizeThemeId } from './theme-choice.js'
export const HOME_STATUS_COLORS_EVENT = 'mc:home-status-colors-changed'
export const HOME_STATUS_COLOR_SETTINGS = Object.freeze([
  Object.freeze({ id: 'home_circle_clear_color', status: 'clear', name: 'Home: nothing waiting', desc: 'No owner asks, proposals or blockers are waiting. The default color complements your theme.' }),
  Object.freeze({ id: 'home_circle_attention_color', status: 'attention', name: 'Ledger: owner requests', desc: 'An unanswered ask, proposal or purchase decision needs review. Yellow by default.' }),
  Object.freeze({ id: 'home_circle_blocked_color', status: 'blocked', name: 'Ledger: blocked', desc: 'The ledger explicitly marks work blocked, waiting for help. Red by default; takes priority over requests.' }),
])
// A clean, bright yellow on every sheet (owner, 2026-09-23: yellow is fine,
// a gold, mustard or brown yellow is not). The light sheets used to darken it
// to ochre so the Ledger's ask glyph could pass as text; the glyph is now ink
// on a chip of this colour on White and Tan (src/ledger.css), so the colour
// itself is only ever a mark, a fill or the circle, and can stay yellow.
const PALETTES = Object.freeze({
  white: Object.freeze({ clear: '#6a6a6f', attention: '#f4c81c', blocked: '#c9172a' }),
  tan: Object.freeze({ clear: '#6a6a6f', attention: '#f2c50e', blocked: '#c31629' }),
  black: Object.freeze({ clear: '#b1b1b8', attention: '#e3b341', blocked: '#ff908c' }),
  ember: Object.freeze({ clear: '#afafb5', attention: '#e3b341', blocked: '#ff8e8d' }),
  cobalt: Object.freeze({ clear: '#b2b2b8', attention: '#e3b341', blocked: '#ff918f' }),
})
const keyFor = status => {
  const setting = HOME_STATUS_COLOR_SETTINGS.find(item => item.status === status)
  if (!setting) throw new RangeError('Choose a Home ledger status.')
  return `mc.set.${setting.id}`
}
const storageNow = () => { try { return globalThis.localStorage || null } catch { return null } }
const activeTheme = () => normalizeThemeId(globalThis.document?.documentElement?.dataset?.theme)
export const normalizeHomeStatusColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : 'auto'
export function defaultHomeStatusColors(theme) {
  return PALETTES[normalizeThemeId(theme)]
}
export function currentHomeStatusColor(status, storage = storageNow(), theme = activeTheme()) {
  const key = keyFor(status)
  // Keep an earlier global choice until this theme has its own saved answer.
  try { return normalizeHomeStatusColor(storage?.getItem(`${key}.${normalizeThemeId(theme)}`) ?? storage?.getItem(key)) } catch { return 'auto' }
}
export function resolvedHomeStatusColor(status, theme, value = currentHomeStatusColor(status, storageNow(), theme)) {
  keyFor(status)
  return normalizeHomeStatusColor(value) === 'auto' ? defaultHomeStatusColors(theme)[status] : normalizeHomeStatusColor(value)
}
export function setHomeStatusColor(status, value, { storage = storageNow(), events = globalThis.window, theme = activeTheme() } = {}) {
  const legacyKey = keyFor(status), scheme = normalizeThemeId(theme)
  const key = `${legacyKey}.${scheme}`, color = normalizeHomeStatusColor(value)
  if (color === 'auto' && value !== 'auto') throw new RangeError('Choose a six-digit hex color or the theme default.')
  if (!storage) throw new Error('The Home color could not be saved.')
  // A default for this theme must also override a legacy global preference.
  if (color === 'auto' && storage.getItem(legacyKey) === null) storage.removeItem(key)
  else storage.setItem(key, color)
  if (events?.dispatchEvent && typeof globalThis.CustomEvent === 'function') events.dispatchEvent(new CustomEvent(HOME_STATUS_COLORS_EVENT, { detail: { status, value: color, theme: scheme } }))
  return color
}

export function mountHomeStatusColors(host, { root = document.documentElement, events = window, storage = storageNow() } = {}) {
  const paint = () => {
    for (const { status } of HOME_STATUS_COLOR_SETTINGS) {
      const color = resolvedHomeStatusColor(status, root.dataset.theme, currentHomeStatusColor(status, storage, root.dataset.theme))
      if (host.style.getPropertyValue(`--home-ledger-${status}`) !== color) host.style.setProperty(`--home-ledger-${status}`, color)
    }
  }
  const stored = event => { if (event.key === null || HOME_STATUS_COLOR_SETTINGS.some(item => event.key === `mc.set.${item.id}` || event.key === `mc.set.${item.id}.${normalizeThemeId(root.dataset.theme)}`)) paint() }
  const observer = new MutationObserver(paint)
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  events.addEventListener(HOME_STATUS_COLORS_EVENT, paint)
  events.addEventListener('storage', stored)
  paint()
  return { destroy() { observer.disconnect(); events.removeEventListener(HOME_STATUS_COLORS_EVENT, paint); events.removeEventListener('storage', stored) } }
}
