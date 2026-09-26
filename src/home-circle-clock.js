// The Home circle's clock: the person's own local time, in the face of every
// circle style (centred on Classic and Launch, at the foot on Blob). One saved
// choice, set from quick settings: Off, On (hours and minutes) or With seconds.
// On is the default, so only a stored 'off' or 'seconds' changes it.
export const HOME_CIRCLE_CLOCK_KEY = 'mc.set.home_circle_clock'
export const HOME_CIRCLE_CLOCK_EVENT = 'mc:home-circle-clock-changed'

function browserStorage() {
  try { return globalThis.localStorage || null } catch { return null }
}

export const HOME_CIRCLE_CLOCK_MODES = Object.freeze([
  Object.freeze({ id: 'off', label: 'Off' }),
  Object.freeze({ id: 'on', label: 'On' }),
  Object.freeze({ id: 'seconds', label: 'With seconds' }),
])

export function homeCircleClockMode(storage = browserStorage()) {
  try {
    const value = storage?.getItem(HOME_CIRCLE_CLOCK_KEY)
    return value === 'off' || value === 'seconds' ? value : 'on'
  } catch { return 'on' }
}

export function homeCircleClockEnabled(storage = browserStorage()) {
  return homeCircleClockMode(storage) !== 'off'
}

export function setHomeCircleClockMode(mode, { storage = browserStorage(), events = globalThis.window } = {}) {
  if (!HOME_CIRCLE_CLOCK_MODES.some(choice => choice.id === mode)) throw new RangeError('Choose Off, On or With seconds for the clock.')
  if (!storage) throw new Error('The clock setting could not be saved.')
  if (mode === 'on') storage.removeItem(HOME_CIRCLE_CLOCK_KEY)
  else storage.setItem(HOME_CIRCLE_CLOCK_KEY, mode)
  if (events?.dispatchEvent && typeof globalThis.CustomEvent === 'function') {
    events.dispatchEvent(new CustomEvent(HOME_CIRCLE_CLOCK_EVENT, { detail: { mode } }))
  }
  return mode
}

// Hours, minutes and (where the locale uses one) the day period, in the
// person's locale and time zone.
let format = null
export function clockParts(date = new Date()) {
  format ||= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const parts = format.formatToParts(date)
  const part = type => parts.find(item => item.type === type)?.value || ''
  return { hour: part('hour'), minute: part('minute'), second: String(date.getSeconds()).padStart(2, '0'), period: part('dayPeriod') }
}
