/* Opaque first-frame colors, shared by the native window and static refusal
   page. Keep these aligned with the renderer's five persisted theme IDs. */
const THEME_SEED = {
  white: { bg: '#f5f5f7', ink: '#1d1d1f' },
  tan: { bg: '#f2e5bc', ink: '#282828' },
  black: { bg: '#1c1c1e', ink: '#f5f5f7' },
  ember: { bg: '#201a1b', ink: '#f7f1f1' },
  cobalt: { bg: '#191c22', ink: '#f1f4fa' },
}

function themeSeed(theme) {
  return Object.hasOwn(THEME_SEED, theme) ? THEME_SEED[theme] : THEME_SEED.white
}

module.exports = { THEME_SEED, themeSeed }
