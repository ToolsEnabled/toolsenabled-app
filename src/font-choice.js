/* All offered faces are bundled variable fonts, except the native System
 * stack. Both settings surfaces preview the actual selected font. Keep the
 * classic pre-paint register in index.html in step with these stacks. */

export const FONT_EVENT_ID = 'ui_font'
export const FONT_STORAGE_KEY = 'mc.font'
export const DEFAULT_FONT = 'plex'

export const FONT_CHOICES = Object.freeze([
  Object.freeze({
    id: 'plex',
    label: 'IBM Plex Sans',
    description: 'Balanced · current default',
    stack: '"IBM Plex Sans Variable", "IBM Plex Sans", "Segoe UI Variable", system-ui, sans-serif',
  }),
  Object.freeze({
    id: 'manrope',
    label: 'Manrope',
    description: 'Clean, rounded shapes',
    stack: '"Manrope Variable", "Segoe UI Variable", system-ui, sans-serif',
  }),
  Object.freeze({
    id: 'source',
    label: 'Source Sans 3',
    description: 'For longer reading',
    stack: '"Source Sans 3 Variable", "Segoe UI Variable", system-ui, sans-serif',
  }),
  Object.freeze({
    id: 'system',
    label: 'System',
    description: 'Familiar system lettering',
    stack: '"Segoe UI Variable", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  }),
  Object.freeze({
    id: 'grotesk',
    label: 'Space Grotesk',
    description: 'Distinctive, geometric',
    stack: '"Space Grotesk Variable", "Space Grotesk", "Segoe UI Variable", system-ui, sans-serif',
  }),
  Object.freeze({
    id: 'mono',
    label: 'JetBrains Mono',
    description: 'Fixed-width interface',
    stack: '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Consolas, monospace',
  }),
])

const byId = new Map(FONT_CHOICES.map(choice => [choice.id, choice]))

/* All text comes from the fixed catalogue above. Both choosers show the same
   glyph sample so letter shapes can be compared before changing the font. */
export function fontOptionMarkup(id) {
  const choice = byId.get(id) || byId.get(DEFAULT_FONT)
  return `<span class="font-choice-name">${choice.label}</span><span class="font-choice-sample" aria-hidden="true">Aa Il1 O0</span><span class="font-choice-description">${choice.description}</span>`
}

export function fontStack(id) {
  return (byId.get(id) || byId.get(DEFAULT_FONT)).stack
}

/** Normalise any stored/announced value to a real choice id. */
export function normalizeFontId(id) {
  return byId.has(id) ? id : DEFAULT_FONT
}

/* The applied value is read from where it actually lives — the root element
   the stylesheets obey — never from a private copy that could drift (same
   principle as currentTheme in src/quick-settings.js). No inline value means
   the stylesheet default is in force, which is DEFAULT_FONT's stack. */
export function currentFontChoice() {
  const applied = document.documentElement.style.getPropertyValue('--font-ui').trim()
  if (!applied) return DEFAULT_FONT
  return FONT_CHOICES.find(choice => choice.stack === applied)?.id || DEFAULT_FONT
}

/** Apply a choice app-wide, live. Returns the id that actually applied. */
export function applyFontChoice(id) {
  const choice = byId.get(id) || byId.get(DEFAULT_FONT)
  /* Setting the inline property even for the default keeps currentFontChoice
     and the pre-paint script trivially consistent: the inline value, when
     present, IS the truth. */
  document.documentElement.style.setProperty('--font-ui', choice.stack)
  /* CANVAS TEXT FOLLOWS, BY THE PATH THAT ALREADY EXISTS. Chart text is
     painted, not styled: every canvas surface snapshots the computed body
     font through buildTheme() and rebuilds that snapshot when data-theme is
     WRITTEN (metrics, computers, approvals, owner-popup each observe exactly
     that attribute). Re-asserting the current theme value is a same-value
     write, which still fires those observers — so one discrete font click
     re-fonts every live chart through the one rebuild path they all already
     have, instead of teaching four observers a second attribute (and the
     glow slider's style writes would then storm them). */
  const theme = document.documentElement.dataset.theme
  if (theme) document.documentElement.dataset.theme = theme
  return choice.id
}
