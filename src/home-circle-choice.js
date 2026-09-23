// Saved circle preferences for Settings and every mounted Home view.
// These choices never alter the circle's health/readiness state or its colors.
export const HOME_CIRCLE_STYLE_SETTING_ID = 'home_circle_style'
export const HOME_CIRCLE_STYLE_KEY = 'mc.set.home_circle_style'
export const HOME_CIRCLE_STYLE_EVENT = 'mc:home-circle-style-changed'
export const DEFAULT_HOME_CIRCLE_STYLE = 'simple'
export const HOME_CIRCLE_STYLES = Object.freeze([
  Object.freeze({ id: 'simple', label: 'Classic' }),
  Object.freeze({ id: 'standard', label: 'Blob' }),
])
export const HOME_CIRCLE_MOTION_SETTING_ID = 'home_circle_motion'
export const HOME_CIRCLE_MOTION_KEY = 'mc.set.home_circle_motion'
export const HOME_CIRCLE_MOTION_EVENT = 'mc:home-circle-motion-changed'
export const DEFAULT_HOME_CIRCLE_MOTION = 'system'
export const HOME_CIRCLE_MOTIONS = Object.freeze([
  Object.freeze({ id: 'system', label: 'System' }),
  Object.freeze({ id: 'animate', label: 'Animate' }),
  Object.freeze({ id: 'still', label: 'Still' }),
])

export function normalizeHomeCircleStyle(value) {
  // Keep the saved Simple ID for Classic. The former animated Classic and
  // Pinstripe choices both become Blob; reading never rewrites a preference.
  if (value === 'classic' || value === 'glass') return 'standard'
  return HOME_CIRCLE_STYLES.some(choice => choice.id === value) ? value : DEFAULT_HOME_CIRCLE_STYLE
}

export function normalizeHomeCircleMotion(value) {
  return HOME_CIRCLE_MOTIONS.some(choice => choice.id === value) ? value : DEFAULT_HOME_CIRCLE_MOTION
}

function browserStorage() {
  try { return globalThis.localStorage || null } catch { return null }
}

export function currentHomeCircleStyle(storage = browserStorage()) {
  // Appearance may fall back if preferences cannot be read, but a read must
  // never overwrite an inaccessible preference with that fallback.
  try { return normalizeHomeCircleStyle(storage?.getItem(HOME_CIRCLE_STYLE_KEY)) } catch { return DEFAULT_HOME_CIRCLE_STYLE }
}

export function setHomeCircleStyle(value, { storage = browserStorage(), events = globalThis.window } = {}) {
  if (!HOME_CIRCLE_STYLES.some(choice => choice.id === value)) throw new RangeError('Choose Classic or Blob for the Home circle.')
  if (!storage) throw new Error('The Home circle setting could not be saved.')
  // Persist before announcing. A failed write remains in Settings' existing
  // pending draft and must not change the appearance behind that page.
  if (value === DEFAULT_HOME_CIRCLE_STYLE) storage.removeItem(HOME_CIRCLE_STYLE_KEY)
  else storage.setItem(HOME_CIRCLE_STYLE_KEY, value)
  if (events?.dispatchEvent && typeof globalThis.CustomEvent === 'function') {
    events.dispatchEvent(new CustomEvent(HOME_CIRCLE_STYLE_EVENT, { detail: { value } }))
  }
  return value
}

export function currentHomeCircleMotion(storage = browserStorage()) {
  try { return normalizeHomeCircleMotion(storage?.getItem(HOME_CIRCLE_MOTION_KEY)) } catch { return DEFAULT_HOME_CIRCLE_MOTION }
}

export function setHomeCircleMotion(value, { storage = browserStorage(), events = globalThis.window } = {}) {
  if (!HOME_CIRCLE_MOTIONS.some(choice => choice.id === value)) throw new RangeError('Choose System, Animate or Still for Home circle motion.')
  if (!storage) throw new Error('The Home circle motion setting could not be saved.')
  // As with style, a failed write must leave the Settings draft pending and
  // the mounted circle unchanged. System removes only this circle's override.
  if (value === DEFAULT_HOME_CIRCLE_MOTION) storage.removeItem(HOME_CIRCLE_MOTION_KEY)
  else storage.setItem(HOME_CIRCLE_MOTION_KEY, value)
  if (events?.dispatchEvent && typeof globalThis.CustomEvent === 'function') {
    events.dispatchEvent(new CustomEvent(HOME_CIRCLE_MOTION_EVENT, { detail: { value } }))
  }
  return value
}
