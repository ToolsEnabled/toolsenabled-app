import { THEME_CHOICES, currentTheme } from './theme-choice.js'
import { HOME_STATUS_COLOR_SETTINGS, currentHomeStatusColor, resolvedHomeStatusColor, setHomeStatusColor } from './home-status-colors.js'

const LABELS = Object.freeze({ clear: 'Clear', attention: 'Needs review', blocked: 'Blocked' })
const DESCRIPTIONS = Object.freeze({ clear: 'No owner requests waiting', attention: 'Owner asks and proposals', blocked: 'Work waiting on a blocker' })
const themeLabel = () => THEME_CHOICES.find(theme => theme.id === currentTheme()).label

export function homeStatusQuickMarkup() {
  return `<div class="home-quick-colors" data-home-quick-colors>
    <p class="home-quick-colors-caption">Ledger colors · <span data-home-colors-theme>${themeLabel()}</span></p>
    ${HOME_STATUS_COLOR_SETTINGS.map(({ status }) => {
      const value = currentHomeStatusColor(status), color = resolvedHomeStatusColor(status, currentTheme(), value)
      return `<div class="home-quick-color-row">
        <label for="quick-home-${status}">${LABELS[status]}<small>${DESCRIPTIONS[status]}</small></label>
        <input id="quick-home-${status}" type="color" data-home-color="${status}" value="${color}" aria-describedby="quick-home-colors-help quick-home-colors-error">
        <button type="button" class="ctl-btn" data-home-color-reset="${status}" aria-label="Use theme default for ${LABELS[status].toLowerCase()}" aria-pressed="${value === 'auto'}">Default</button>
      </div>`
    }).join('')}
    <p class="home-quick-colors-help" id="quick-home-colors-help">Saved for this theme. Other themes keep their own colors.</p>
    <p class="home-quick-colors-error" id="quick-home-colors-error" role="status" aria-live="polite" hidden></p>
  </div>`
}

// Listeners belong only to this drawer's nodes. Reopening builds a fresh view
// of saved preferences; no global observer or frame work survives the drawer.
export function bindHomeStatusQuickSettings(body, announce) {
  const root = body.querySelector('[data-home-quick-colors]')
  if (!root) return () => {}
  const error = root.querySelector('#quick-home-colors-error')
  const sync = () => {
    root.querySelector('[data-home-colors-theme]').textContent = themeLabel()
    for (const { status } of HOME_STATUS_COLOR_SETTINGS) {
      const value = currentHomeStatusColor(status)
      root.querySelector(`[data-home-color="${status}"]`).value = resolvedHomeStatusColor(status, currentTheme(), value)
      root.querySelector(`[data-home-color-reset="${status}"]`).setAttribute('aria-pressed', String(value === 'auto'))
    }
  }
  const save = (status, value) => {
    const setting = HOME_STATUS_COLOR_SETTINGS.find(item => item.status === status)
    if (!setting) return
    try {
      const saved = setHomeStatusColor(status, value)
      error.textContent = ''; error.hidden = true
      announce(setting.id, saved)
    } catch {
      error.textContent = 'The color could not be saved. Try again.'; error.hidden = false
    }
    sync()
  }
  root.addEventListener('change', event => {
    const input = event.target.closest('input[data-home-color]')
    if (input) save(input.dataset.homeColor, input.value)
  })
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-home-color-reset]')
    if (button) save(button.dataset.homeColorReset, 'auto')
  })
  return sync
}
