import '../../../src/styles.css'
import '../../../src/settings.css'
import '../../../src/fleet-profile-settings.css'
import '../../../src/setup.css'
import { setupAccountStepMarkup } from '../../../src/account-markup.js'

const state = { available: true, signedIn: false }
const actions = '<div class="setup-actions"></div>'
window.setupAccountFieldsFixture = {
  render({ mode, theme, busy = false }) {
    document.documentElement.dataset.theme = theme
    document.body.innerHTML = '<div class="view-pad setup-page"><div class="settings-shell setup-shell"><section class="settings-section setup-section"></section></div></div>'
    const section = document.querySelector('.setup-section')
    section.innerHTML = setupAccountStepMarkup({ accountState: state, mode, busy, actions })
    return section
  },
  measure() {
    const section = document.querySelector('.setup-section')
    const fields = [...section.querySelectorAll('[data-setup-account-field]')]
    const page = document.querySelector('.setup-page')
    const initialActiveElement = document.activeElement
    const initialFocus = fields.map(input => input === initialActiveElement)
    const values = fields.map(input => {
      const style = getComputedStyle(input)
      const rect = input.getBoundingClientRect()
      return {
        width: rect.width, height: rect.height, left: rect.left, right: rect.right,
        borderWidth: parseFloat(style.borderTopWidth), borderStyle: style.borderTopStyle,
        borderColor: style.borderTopColor, background: style.backgroundColor,
        color: style.color, outline: style.outlineStyle, value: input.value,
        disabled: input.disabled, opacity: parseFloat(style.opacity),
      }
    })
    const focused = fields[0]
    focused.focus()
    const focusStyle = getComputedStyle(focused)
    return {
      ids: fields.map(input => input.dataset.setupAccountField),
      width: innerWidth, height: innerHeight,
      pageWidth: page.scrollWidth, clientWidth: page.clientWidth,
      fields: values,
      theme: document.documentElement.dataset.theme,
      initialFocus,
      focus: { outline: focusStyle.outlineStyle, outlineWidth: parseFloat(focusStyle.outlineWidth) },
    }
  },
}
