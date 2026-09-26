import { handControls } from './hand-controls.js'
import { matchesSettingQuery } from './product-settings-layout.js'

export function createHandControlSettings({ stageWrite = null, draft = null, getControl = handControls } = {}) {
  let root, unsubscribe
  const markup = () => `<section class="hand-settings settings-section" data-hand-settings>
    <h2 class="settings-section-title">Hand controls</h2>
    <p>Move your palm to aim at a button. Pinch your thumb and index finger to press it, then release.</p>
    <label class="settings-row settings-check-row"><span>Enable hand controls</span><input type="checkbox" data-hand-enabled /></label>
    <p>Off by default. When enabled, this app uses your camera and graphics processor. Camera frames are processed on this computer and are not recorded or sent to an agent. Tracking pauses when this window is in the background.</p>
    <p data-hand-status role="status"></p><output data-hand-stats></output>
    <p>Press Escape or use “Turn off hand controls” to stop the camera and unload the tracker.</p>
  </section>`
  function paint() {
    const control = getControl()
    const value = control?.getState()
    for (const node of root?.querySelectorAll('[data-hand-settings]') || []) {
      const input = node.querySelector('[data-hand-enabled]')
      input.checked = draft ? draft.value('hand:enabled', value?.enabled === true) : value?.enabled === true; input.disabled = !control
      node.querySelector('[data-hand-status]').textContent = value?.message || 'Open the ToolsEnabled desktop app on the computer with your camera to use hand controls.'
      const stats = value?.stats
      node.querySelector('[data-hand-stats]').textContent = stats
        ? `${stats.fps.toFixed(1)} tracking frames/sec · Processing p95 ${stats.inferenceP95.toFixed(1)} ms · ${stats.cameraWidth} × ${stats.cameraHeight} camera`
        : ''
    }
  }
  function change(event) {
    if (event.target.matches('[data-hand-enabled]')) {
      if (stageWrite) stageWrite('hand:enabled', event.target.checked, async next => {
        const control = getControl()
        if (!control) return { ok: false, reason: 'Hand controls are unavailable in this window. Open the main window to use them.' }
        const result = await control.setEnabled(next)
        if (result?.ok === false) return result
        const state = control.getState()
        if (state.enabled !== next) return { ok: false, reason: state.message || 'Hand controls could not apply this choice.' }
        return { ok: true }
      })
      else void getControl()?.setEnabled(event.target.checked)
    }
  }
  return {
    markup,
    matches: query => matchesSettingQuery(query, 'hand controls camera palm pinch gesture pointer webcam'),
    afterRender(nextRoot) { root = nextRoot; paint() },
    bind(nextRoot) { root = nextRoot; root.addEventListener('change', change); unsubscribe = getControl()?.subscribe(paint); paint() },
    destroy() { unsubscribe?.(); root?.removeEventListener('change', change) },
  }
}
