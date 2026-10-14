// Shared by appearance controls and renderers. The classic pre-paint scripts
// mirror these stable IDs so a saved dark theme never flashes white.
export const THEME_CHOICES = Object.freeze([
  { id: 'white', label: 'White' },
  { id: 'tan', label: 'Tan' },
  { id: 'black', label: 'Black' },
  { id: 'ember', label: 'Ember', description: 'Dark, warm red tint' },
  { id: 'cobalt', label: 'Cobalt', description: 'Dark, blue tint' },
].map(Object.freeze))

export const normalizeThemeId = id => THEME_CHOICES.some(choice => choice.id === id) ? id : 'white'
export const isDarkTheme = id => ['black', 'ember', 'cobalt'].includes(id)
export const currentTheme = () => normalizeThemeId(document.documentElement.dataset.theme)
