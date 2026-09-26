/* THE TWO APPEARANCE CHOICES THAT WERE NEVER WRITTEN DOWN.
 *
 * Glow intensity and Reduce motion are offered on every page (the gear drawer,
 * src/quick-settings.js) and again on the settings page's Motion & Effects
 * section. Both applied instantly and neither survived closing the window.
 *
 * MEASURED on the shipped installer, 1.0.20, driving the packaged app with a
 * real mouse: 98 of the 100 rows on the settings page came back exactly as they
 * were set after a restart. These two came back at their defaults, and nothing
 * had been written under either name. The reason is one line long in each case
 * -- src/views/settings.js read glow back off the `--glow` custom property and
 * reduce motion off `document.body.classList`, so the DOM was the only copy,
 * and applyValue() never reached its writeStored() branch for either.
 *
 * WHY THIS IS A MODULE AND NOT TWO LINES IN THE SETTINGS PAGE. There are two
 * surfaces, and only one of them is the settings page. The drawer is built per
 * page and applies these two directly, so a rule that lived inside the settings
 * view would keep the drawer's copy of the same control forgetful -- which is
 * the more common way a person meets it. Both surfaces now write through here,
 * which is the same shape src/font-choice.js already gives the font.
 *
 * THE KEYS ARE THE ONES THE SETTINGS PAGE ALREADY USES (`mc.set.<id>`), so a
 * value written by either surface is the value that page reads, and there is no
 * second vocabulary to keep in step.
 */

export const GLOW_SETTING_ID = 'glow'
export const REDUCE_MOTION_SETTING_ID = 'reduce_motion'

export const GLOW_KEY = `mc.set.${GLOW_SETTING_ID}`
export const REDUCE_MOTION_KEY = `mc.set.${REDUCE_MOTION_SETTING_ID}`

/* The shipped values, and the range of the slider that sets the first one.
   They match the row definitions in src/views/settings.js; a mismatch would
   show up as a key written for a value that is actually the default. */
export const DEFAULT_GLOW = 100
export const GLOW_MIN = 0
export const GLOW_MAX = 200
export const DEFAULT_REDUCE_MOTION = false

export const APPEARANCE_STORAGE_UNAVAILABLE = 'ERR_APPEARANCE_STORAGE_UNAVAILABLE'

function storageUnavailable(operation, cause) {
  const error = new Error(
    `Appearance storage could not be ${operation}; this does not mean the setting is absent.`,
    { cause },
  )
  error.code = APPEARANCE_STORAGE_UNAVAILABLE
  return error
}

const browserStorage = () => {
  try { return globalThis.localStorage || null } catch (error) {
    throw storageUnavailable('accessed', error)
  }
}

const read = (storage, key) => {
  if (!storage) throw storageUnavailable('read', new Error('localStorage is unavailable'))
  try { return storage.getItem(key) } catch (error) {
    throw storageUnavailable('read', error)
  }
}

const write = (storage, key, value) => {
  if (!storage) throw storageUnavailable('written', new Error('localStorage is unavailable'))
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, String(value))
  } catch (error) {
    throw storageUnavailable('written', error)
  }
}

function normalizeGlow(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.round(Math.min(GLOW_MAX, Math.max(GLOW_MIN, number)))
}

/**
 * Write down a choice one of the two surfaces has just applied.
 *
 * Returns the value as it was stored, or null when this module does not own
 * the setting or the value could not be read as one. A value equal to the
 * shipped default REMOVES the key rather than writing it, which is the rule
 * every other row on the settings page already follows: an untouched install
 * carries no appearance keys, and a future change of default is not pinned by
 * a write nobody asked for.
 */
export function rememberAppearance(settingId, value, storage = browserStorage()) {
  if (settingId === GLOW_SETTING_ID) {
    const glow = normalizeGlow(value)
    if (glow === null) return null
    write(storage, GLOW_KEY, glow === DEFAULT_GLOW ? null : glow)
    return glow
  }
  if (settingId === REDUCE_MOTION_SETTING_ID) {
    const on = Boolean(value)
    write(storage, REDUCE_MOTION_KEY, on === DEFAULT_REDUCE_MOTION ? null : on)
    return on
  }
  return null
}

/**
 * What was chosen, or null for each one nobody has chosen.
 *
 * null is not the default dressed up: "no choice was made" and "the default was
 * chosen" have to stay different here, because applying an unset custom
 * property is not the same as leaving it alone.
 */
export function storedAppearance(storage = browserStorage()) {
  const rawGlow = read(storage, GLOW_KEY)
  const rawMotion = read(storage, REDUCE_MOTION_KEY)
  const glow = rawGlow === null ? null : normalizeGlow(rawGlow)
  const reduceMotion = rawMotion === 'true' ? true : rawMotion === 'false' ? false : null
  return { glow, reduceMotion }
}

/**
 * Put the stored choices back on the page, at launch, before the first view.
 *
 * Only what was actually stored is applied. A copy nobody has touched leaves
 * the document byte-identical to the one that shipped -- `--glow` unset and
 * `--glow: 1` are different to a stylesheet with its own fallback, and a class
 * toggled off is not the same as a class never added.
 */
export function applyAppearance({ documentRef = globalThis.document, storage = browserStorage() } = {}) {
  const applied = { glow: null, reduceMotion: null }
  if (!documentRef) return applied
  const chosen = storedAppearance(storage)
  if (chosen.glow !== null) {
    documentRef.documentElement?.style?.setProperty('--glow', String(chosen.glow / 100))
    applied.glow = chosen.glow
  }
  if (chosen.reduceMotion !== null) {
    documentRef.body?.classList?.toggle('reduce-motion', chosen.reduceMotion)
    applied.reduceMotion = chosen.reduceMotion
  }
  return applied
}

/** Reapply account-scoped effects after the durable store has changed scope.
 * Missing choices must clear the preceding account's effects; this changes the
 * document only and never saves a default into either preference partition.
 */
export function bindAppearanceAccountChanges({ windowRef = globalThis.window, documentRef = globalThis.document, storage = browserStorage() } = {}) {
  const reapply = () => {
    const chosen = applyAppearance({ documentRef, storage })
    if (chosen.glow === null) documentRef?.documentElement?.style?.removeProperty('--glow')
    if (chosen.reduceMotion === null) documentRef?.body?.classList?.toggle('reduce-motion', false)
  }
  windowRef?.addEventListener('mc:account-storage-rehydrated', reapply)
  return () => windowRef?.removeEventListener('mc:account-storage-rehydrated', reapply)
}
