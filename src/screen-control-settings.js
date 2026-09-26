import { createScreenAccessControls } from './screen-access-controls.js'
import './agent-screen-voice-controls.css'

export function createScreenControlSettings() {
  let controls = null, host = null
  return {
    markup: () => '<section class="settings-section" data-settings-section="App permissions"><div data-screen-control-settings></div></section>',
    matches: query => query.trim().toLowerCase().split(/\s+/).every(word => 'full computer control screen mouse keyboard takeover agents allowed selection pointer one at a time'.includes(word)),
    afterRender(root) {
      const next = root.querySelector('[data-screen-control-settings]')
      if (next === host) return
      controls?.destroy(); controls = null; host = next
      if (host && !window.mcScreenControl) { host.textContent = 'Computer control is available in the local ToolsEnabled desktop app.'; return }
      if (host) { controls = createScreenAccessControls(); host.append(controls.el) }
    },
    destroy() { controls?.destroy(); controls = null; host = null },
  }
}
