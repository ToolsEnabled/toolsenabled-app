// Display density only. Modes never write a product setting or grant a permission.
//
// BASIC IS THE DEFAULT (owner direction, 2026-09-20, T782): "for most users
// we dont want to save everything forever or audit or verify everything. We
// should have it default to genuinely basic user settings ... These advanced
// things should need to be enabled and setup in advanced/expert/enterprise
// rather than be auto enabled". A fresh copy, an unreadable preference or a
// value this version does not know all open Basic. A saved Advanced or
// Enterprise choice is the person's and is kept. Expert is never remembered:
// it is opened for one visit behind its own confirmation.
//
// The Basic view's id stays 'simple' so a preference saved by an earlier
// version still selects it; only its name changed.
import { productSettingPresentation } from './product-settings-layout.js'
export const SETTINGS_MODE_KEY = 'mc.settings.mode'
export const DEFAULT_SETTINGS_MODE = 'simple'
export const SETTINGS_MODES = Object.freeze([
  { id: 'simple', label: 'Basic', detail: 'Essential tools, approvals, appearance and setup. Detailed activity auditing, long-term archives and enforced resource limits stay off until you set them up in Advanced.' },
  { id: 'advanced', label: 'Advanced', detail: 'Everyday controls plus delegation, research, audit and resource setup. Showing them turns nothing on.' },
  { id: 'expert', label: 'Expert', detail: 'Detailed personal controls, including access policies. Open for this visit.' },
  { id: 'enterprise', label: 'Enterprise', detail: 'Business policies for this installation. Opening this view changes no policy or permission.' },
])

const SIMPLE_SETTINGS = new Set([
  'theme', 'ui_font', 'text_size', 'reduce_motion', 'uninstall_data',
  'this_computer_programs',
  'notify_agent_finished', 'notify_agent_error', 'example_mode',
  'write_dispatch', 'write_agent-session', 'write_decision',
])

export function settingMode(id) {
  return productSettingPresentation(id).mode || (SIMPLE_SETTINGS.has(id) ? 'simple' : 'advanced')
}

/* The browsing preference lives in window storage, and reaching for that
   storage can itself throw: a document with storage disabled answers its
   localStorage getter with a SecurityError. So the default is resolved here,
   inside a guard, and never in a parameter list -- a default parameter runs
   before the function body's try and would rethrow. An explicit storage
   (including null) is used as given. */
function windowStorage() {
  try { return globalThis.localStorage } catch { return null }
}

export function readSettingsMode(storage) {
  // Expert entry requires a fresh local confirmation, including after reload.
  try {
    const store = storage === undefined ? windowStorage() : storage
    const saved = store?.getItem(SETTINGS_MODE_KEY)
    return ['simple', 'advanced', 'enterprise'].includes(saved) ? saved : DEFAULT_SETTINGS_MODE
  }
  catch { return DEFAULT_SETTINGS_MODE }
}

/** Keep asynchronously repainted controller content inside the same mode gate. */
export function settingsModePanel(content, label, mode = 'advanced') {
  const title = String(label).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const modeLabel = SETTINGS_MODES.find(item => item.id === mode)?.label || 'Advanced'
  return `<div class="settings-mode-panel" data-settings-panel-mode="${mode}">
    <div class="settings-mode-content">${content}</div>
    <section class="settings-mode-gate">
      <h2 class="settings-section-title">${title}</h2>
      <p class="settings-desc">${mode === 'expert' ? 'Open Expert to change this setting.' : `These options are available in ${modeLabel} mode.`} Showing them changes no setting; your saved choices stay in effect in every mode.</p>
      <button type="button" class="ctl-btn" data-settings-show-mode="${mode}">Show ${modeLabel} settings</button>
    </section>
  </div>`
}

export function createSettingsMode({ root, onChange, storage }) {
  const store = storage === undefined ? windowStorage() : storage
  let mode = readSettingsMode(store), dialog = null
  const sync = () => {
    root.dataset.settingsMode = mode
    for (const button of root.querySelectorAll('[data-settings-mode-choice]')) {
      const selected = button.dataset.settingsModeChoice === mode
      button.setAttribute('aria-pressed', String(selected))
      button.classList.toggle('on', selected)
    }
    // The view's own sentence beside the switch. The standing reminder that a
    // view changes what is shown, never what is saved, is the switch's title
    // and part of its description (see the settings-shell template).
    root.querySelector('[data-settings-mode-description]').textContent = SETTINGS_MODES.find(item => item.id === mode).detail
  }
  const apply = next => {
    mode = next
    if (mode !== 'expert') {
      try { store?.setItem(SETTINGS_MODE_KEY, mode) } catch { /* The view still works for this visit. */ }
    }
    sync()
    onChange(mode)
  }
  const close = () => { dialog?.close(); dialog?.remove(); dialog = null }
  function choose(next) {
    if (!SETTINGS_MODES.some(item => item.id === next)) return
    if (next === mode) { onChange(mode); return }
    if (next !== 'expert') { apply(next); return }
    if (dialog) return
    const challengeCode = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0')
    const previousFocus = document.activeElement
    dialog = document.createElement('dialog')
    dialog.className = 'settings-expert-dialog'
    dialog.setAttribute('aria-labelledby', 'settings-expert-title')
    dialog.setAttribute('aria-describedby', 'settings-expert-description')
    dialog.innerHTML = `<form>
      <h2 id="settings-expert-title">Open Expert settings</h2>
      <p id="settings-expert-description">Expert includes detailed permission profiles and function rules. Opening this view does not change any setting.</p>
      <label for="settings-expert-code">Enter <strong>${challengeCode}</strong> to open Expert for this visit.</label>
      <input id="settings-expert-code" inputmode="numeric" autocomplete="off" pattern="[0-9]{4}" maxlength="4" required autofocus>
      <p data-expert-error role="status"></p>
      <div class="settings-dialog-actions"><button type="button" class="ctl-btn" data-expert-cancel>Cancel</button><button type="submit" class="ctl-btn armed">Open Expert</button></div>
    </form>`
    const finish = accepted => {
      close()
      // A gate button disappears when its panel opens; the persistent mode
      // selector is a reliable focus destination after either outcome.
      if (accepted) {
        apply('expert')
        root.querySelector('[data-settings-mode-choice="expert"]')?.focus()
      } else previousFocus?.focus?.()
    }
    dialog.querySelector('[data-expert-cancel]').addEventListener('click', () => finish(false))
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault()
      if (dialog.querySelector('input').value !== challengeCode) {
        dialog.querySelector('[data-expert-error]').textContent = 'Enter the four digits shown above.'
        dialog.querySelector('input').focus()
        return
      }
      finish(true)
    })
    document.body.appendChild(dialog)
    dialog.showModal()
  }
  function click(event) {
    const button = event.target.closest('[data-settings-mode-choice], [data-settings-show-mode]')
    if (button && !button.closest('[inert]')) {
      choose(button.dataset.settingsModeChoice || button.dataset.settingsShowMode)
      // Inline gates disappear on entry. Keep keyboard navigation on the
      // persistent selector, just as the confirmed Expert entry does.
      if (button.dataset.settingsShowMode && mode === button.dataset.settingsShowMode) {
        root.querySelector(`[data-settings-mode-choice="${mode}"]`)?.focus()
      }
    }
  }
  root.addEventListener('click', click)
  sync()
  return { get mode() { return mode }, destroy() { close(); root.removeEventListener('click', click) } }
}
