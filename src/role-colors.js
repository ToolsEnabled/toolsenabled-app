import { isDarkTheme } from './theme-choice.js'
// Cosmetic preferences only. Keys are stable role IDs, never role names,
// providers, seats, capabilities, or positions in a menu.
export const ROLE_COLORS_KEY = 'mc.role-colors.v1'
export const ROLE_COLORS_EVENT = 'mc:role-colors-changed'
export const ROLE_COLOR_DEFAULTS = Object.freeze({
  controller: '#287f9b',
  'shadow-manager': '#2b876c',
  planner: '#426ab0',
  manager: '#855fb0',
  'coordinator-assistant': '#b6673f',
  builder: '#8a7a2f',
  reviewer: '#af527d',
  worker: '#637e41',
  observer: '#657687',
  coordinator: '#287f9b',
  helper: '#b6673f',
  shadow: '#2b876c',
  default: '#637e41',
  spawned: '#657687',
})
export const ROLE_COLOR_NAMES = Object.freeze({
  controller: 'Controller', 'shadow-manager': 'Shadow manager', planner: 'Planner',
  manager: 'Manager', 'coordinator-assistant': 'Coordinator assistant', builder: 'Builder',
  reviewer: 'Reviewer', worker: 'Worker', observer: 'Observer', coordinator: 'Coordinator',
  helper: "Coordinator’s helper", shadow: 'Shadow manager (legacy)', default: 'Default', spawned: 'Agent spawned',
})
export const ROLE_COLOR_THEMES = Object.freeze({
  white: ['#f7f8fa', '#eef1f5', '#ffffff'],
  tan: ['#f2e5bc', '#ebdbb2', '#fbf1c7'],
  black: ['#212327', '#292b30', '#2e3136'],
  ember: ['#170d13', '#25141d', '#301b25'],
  cobalt: ['#0b1223', '#131e35', '#1b2943'],
})
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
export const validRoleColorId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
export function normalizeRoleColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(text)) return text
  if (/^#[0-9a-f]{3}$/.test(text)) return '#' + [...text.slice(1)].map(c => c + c).join('')
  return null
}
export function defaultRoleColor(id) {
  if (has(ROLE_COLOR_DEFAULTS, id)) return ROLE_COLOR_DEFAULTS[id]
  if (!validRoleColorId(id)) return ROLE_COLOR_DEFAULTS.worker
  // Custom roles keep a stable hue across tree moves, ordering and themes.
  // They must not all inherit the same Worker color or its saved override.
  let hash = 2166136261
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  const hue = (hash % 360) / 30
  const channel = offset => {
    const k = (offset + hue) % 12
    return Math.round(255 * (0.44 - 0.22 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}
const colorNodeId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null
// Twelve OKLCH hues at even perceptual spacing, skipping the amber-to-olive
// band. Neighbouring hues alternate a lighter and a deeper tone (one pair of
// tones for light themes, one for dark) so they never read as one color.
const AGENT_HUES = [140, 164, 188, 212, 236, 260, 284, 308, 332, 356, 20, 44]
const AGENT_TONES = { light: [[0.55, 0.13], [0.45, 0.12]], dark: [[0.8, 0.11], [0.7, 0.12]] }
const srgbHex = value => Math.round(255 * Math.min(1, Math.max(0, value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')
function oklchHex(lightness, chroma, hue) {
  // Reduce chroma until the color fits sRGB; lightness and hue stay.
  for (let c = chroma; ; c = Math.max(0, c - 0.005)) {
    const a = c * Math.cos(hue * Math.PI / 180), b = c * Math.sin(hue * Math.PI / 180)
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    if (c === 0 || rgb.every(value => value >= -1e-4 && value <= 1 + 1e-4)) return '#' + rgb.map(srgbHex).join('')
  }
}
// A node's own default accent. It depends only on the node's id -- never on
// its role, siblings, order or position -- so it survives every tree change.
// Ids minted by src/fleet-trees.js carry a counter (node-12-<uuid>); stepping
// it five hues at a time gives any twelve agents created one after another
// (a manager's workers, usually) twelve different colors. Other ids hash.
export function defaultAgentColor(id, theme = 'white') {
  if (!colorNodeId(id)) return ROLE_COLOR_DEFAULTS.worker
  const counter = /^[a-z][a-z-]*?-(\d{1,9})(?=-|$)/.exec(id)
  let slot = counter ? Number(counter[1]) * 5 % 12 : 2166136261
  if (!counter) {
    for (const character of id) slot = Math.imul(slot ^ character.charCodeAt(0), 16777619) >>> 0
    slot %= 12
  }
  const [lightness, chroma] = AGENT_TONES[isDarkTheme(theme) ? 'dark' : 'light'][slot % 2]
  return oklchHex(lightness, chroma, AGENT_HUES[slot])
}
const browserStorage = () => globalThis.localStorage

export function readRoleColors(storage) {
  try {
    storage ??= browserStorage()
    if (!storage) throw new Error('Settings storage is unavailable.')
    const raw = storage.getItem(ROLE_COLORS_KEY)
    if (raw === null) return { ok: true, colors: Object.create(null) }
    const record = JSON.parse(raw)
    if (!record || record.version !== 1 || !record.colors || typeof record.colors !== 'object' || Array.isArray(record.colors)) throw new Error('The saved role colors could not be read.')
    const colors = Object.create(null)
    for (const [id, value] of Object.entries(record.colors)) {
      const color = normalizeRoleColor(value)
      if (!validRoleColorId(id) || !color) throw new Error('A saved role color is invalid.')
      colors[id] = color
    }
    return { ok: true, colors }
  } catch (error) {
    return { ok: false, colors: Object.create(null), reason: `${error?.message || 'Role colors could not be read.'} Try again, or reset role colors to restore the defaults.` }
  }
}

export function saveRoleColor(id, value, storage) {
  if (!validRoleColorId(id)) return { ok: false, reason: 'This role has no valid saved ID. Reload the Role library and try again.' }
  const color = value === null ? null : normalizeRoleColor(value)
  if (value !== null && !color) return { ok: false, reason: 'Enter a hex color such as #41859c.' }
  const previous = readRoleColors(storage)
  if (!previous.ok) return previous
  if (color === null) delete previous.colors[id]
  else previous.colors[id] = color
  try {
    storage ??= browserStorage()
    if (Object.keys(previous.colors).length) storage.setItem(ROLE_COLORS_KEY, JSON.stringify({ version: 1, colors: previous.colors }))
    else storage.removeItem(ROLE_COLORS_KEY)
    return previous
  } catch {
    return { ok: false, reason: 'That color could not be saved. Your previous colors are unchanged. Try again.' }
  }
}

export function resetRoleColors(storage) {
  try {
    storage ??= browserStorage()
    if (!storage) throw new Error('Settings storage is unavailable.')
    storage.removeItem(ROLE_COLORS_KEY)
    return { ok: true, colors: Object.create(null) }
  } catch {
    return { ok: false, reason: 'Role colors could not be reset. Try again.' }
  }
}

const rgb = hex => hex.slice(1).match(/../g).map(part => parseInt(part, 16))
const luminance = hex => rgb(hex).map(value => {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
export function colorContrast(a, b) {
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
// Keep the chosen hue; move only as far toward the theme's ink as needed.
// A saved white/yellow/black swatch must not erase a ring or a small label.
export function roleColorTone(color, theme = 'white', minimum = 3.5) {
  const chosen = normalizeRoleColor(color) || ROLE_COLOR_DEFAULTS.worker
  const grounds = ROLE_COLOR_THEMES[theme] || ROLE_COLOR_THEMES.white
  if (grounds.every(ground => colorContrast(chosen, ground) >= minimum)) return chosen
  const channels = rgb(chosen), target = isDarkTheme(theme) ? 255 : 0
  for (let step = 1; step <= 100; step += 1) {
    const candidate = '#' + channels.map(c => Math.round(c + (target - c) * step / 100).toString(16).padStart(2, '0')).join('')
    if (grounds.every(ground => colorContrast(candidate, ground) >= minimum)) return candidate
  }
  return isDarkTheme(theme) ? '#ffffff' : '#000000'
}

let currentColors = Object.create(null)
let currentTheme = 'white'
let appliedIds = new Set()
export function chosenRoleColor(id) { return has(currentColors, id) ? currentColors[id] : defaultRoleColor(id) }
export function roleColorHex(id) { return roleColorTone(chosenRoleColor(id), currentTheme) }
export function roleColorCss(id, kind = 'accent', nodeId = null) {
  const key = validRoleColorId(id) ? id : 'default'
  if (colorNodeId(nodeId)) {
    const minimum = kind === 'text' ? 4.5 : 3.5
    const tone = theme => roleColorTone(defaultAgentColor(nodeId, theme), theme, minimum)
    // Only an explicit saved role choice overrides a node's own default.
    // CSS variables let existing circles follow Save/Reset and theme changes;
    // tan and charcoal are the most demanding light and dark grounds.
    return `var(--role-chosen-${kind === 'text' ? 'text' : 'accent'}-${key}, light-dark(${tone('tan')}, ${tone('black')}))`
  }
  // Separate prefixes, not suffixes: a valid custom ID such as "worker-text"
  // must not overwrite the worker's label tone. Unconfigured custom roles
  // also keep their own default, independent of the legacy Default override.
  if (!has(ROLE_COLOR_DEFAULTS, key)) {
    const color = defaultRoleColor(key), minimum = kind === 'text' ? 4.5 : 3.5
    // Tan and charcoal are the most demanding light/dark surfaces. CSS
    // follows color-scheme immediately, including existing painted circles.
    const fallback = `light-dark(${roleColorTone(color, 'tan', minimum)}, ${roleColorTone(color, 'black', minimum)})`
    return `var(--role-${kind === 'text' ? 'text' : 'accent'}-${key}, ${fallback})`
  }
  return kind === 'text'
    ? `var(--role-text-${key}, var(--role-fallback-text, var(--ink-2)))`
    : `var(--role-accent-${key}, var(--role-fallback-accent, var(--c-default)))`
}
export function roleColorStyle(id, nodeId = null) {
  return `--rc:${roleColorCss(id, 'accent', nodeId)};--gc:${roleColorCss(id, 'accent', nodeId)};--role-ink:${roleColorCss(id, 'text', nodeId)}`
}
const paintedRoleIds = new WeakMap()
export function paintRoleColor(element, id, nodeId = null) {
  if (!element?.style) return
  const key = validRoleColorId(id) ? id : 'default'
  const identity = colorNodeId(nodeId)
  const previous = paintedRoleIds.get(element)
  if (previous?.key === key && previous.nodeId === identity) return
  element.style.setProperty('--rc', roleColorCss(key, 'accent', identity))
  element.style.setProperty('--gc', roleColorCss(key, 'accent', identity))
  element.style.setProperty('--role-ink', roleColorCss(key, 'text', identity))
  paintedRoleIds.set(element, { key, nodeId: identity })
}

export function applyRoleColors({ documentRef = globalThis.document, storage } = {}) {
  const saved = readRoleColors(storage)
  currentColors = saved.colors
  const root = documentRef?.documentElement
  currentTheme = has(ROLE_COLOR_THEMES, root?.dataset?.theme) ? root.dataset.theme : 'white'
  const ids = new Set([...Object.keys(ROLE_COLOR_DEFAULTS), ...Object.keys(currentColors)])
  for (const old of appliedIds) {
    if (!ids.has(old)) {
      root?.style?.removeProperty(`--role-accent-${old}`)
      root?.style?.removeProperty(`--role-text-${old}`)
    }
    if (!has(currentColors, old)) {
      root?.style?.removeProperty(`--role-chosen-accent-${old}`)
      root?.style?.removeProperty(`--role-chosen-text-${old}`)
    }
  }
  root?.style?.setProperty('--role-fallback-accent', roleColorTone(ROLE_COLOR_DEFAULTS.worker, currentTheme))
  root?.style?.setProperty('--role-fallback-text', roleColorTone(ROLE_COLOR_DEFAULTS.worker, currentTheme, 4.5))
  for (const id of ids) {
    root?.style?.setProperty(`--role-accent-${id}`, roleColorHex(id))
    root?.style?.setProperty(`--role-text-${id}`, roleColorTone(chosenRoleColor(id), currentTheme, 4.5))
    if (has(currentColors, id)) {
      root?.style?.setProperty(`--role-chosen-accent-${id}`, roleColorHex(id))
      root?.style?.setProperty(`--role-chosen-text-${id}`, roleColorTone(currentColors[id], currentTheme, 4.5))
    }
  }
  /* Every declared key, not the six the fleet page's own legacy vocabulary
     used to stop at -- src/vocab.js ROLES now carries all of these too, and
     src/tree-graph.css's .role-<id> rules (below) read --c-<id> for each one,
     so a role missing here would draw a ring with no colour of its own. */
  for (const id of Object.keys(ROLE_COLOR_DEFAULTS)) {
    root?.style?.setProperty(`--c-${id}`, `var(--role-accent-${id})`)
    root?.style?.setProperty(`--g-${id}`, `var(--role-accent-${id})`)
  }
  appliedIds = ids
  return saved
}

export function initializeRoleColors({ documentRef = globalThis.document, storage, windowRef = globalThis.window } = {}) {
  const apply = () => applyRoleColors({ documentRef, storage })
  apply()
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(apply) : null
  if (documentRef?.documentElement) observer?.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const changed = event => { if (!event || event.type !== 'storage' || event.key === ROLE_COLORS_KEY || event.key === null) apply() }
  windowRef?.addEventListener(ROLE_COLORS_EVENT, changed)
  windowRef?.addEventListener('storage', changed)
  return () => { observer?.disconnect(); windowRef?.removeEventListener(ROLE_COLORS_EVENT, changed); windowRef?.removeEventListener('storage', changed) }
}
