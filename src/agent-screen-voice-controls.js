import { attachPersistentVoice } from './voice-coordinator.js'
import { createScreenAccessControls } from './screen-access-controls.js'

export function mountAgentScreenVoiceControls({ sample = false, getComputerId = () => null, onMarks = () => {} } = {}) {
  const root = document.createElement('details')
  root.className = 'agent-screen-voice-controls'
  root.innerHTML = '<summary>Voice &amp; screen access <span data-control-count></span></summary><div class="agent-control-body"></div>'
  const voice = attachPersistentVoice({ sample })
  let voiceSessionId = voice.getContact().sessionId, voiceState = voice.getContact().state,
    destroyed = false, selectionOperation = 0
  function mark({ state, rows }) {
    if (destroyed) return
    root.querySelector('[data-control-count]').textContent = state?.grants?.length ? `· ${state.grants.length} with screen access` : ''
    onMarks({ voiceNodeId: rows.find(row => row.sessionId === voiceSessionId)?.nodeId || null, voiceState,
      screenNodeIds: (state?.grants || []).map(grant => rows.find(row => row.sessionId === grant.sessionId)?.nodeId).filter(Boolean) })
  }
  const screen = createScreenAccessControls({ sample, getComputerId, onChange: mark })
  root.querySelector('.agent-control-body').append(voice.el, screen.el)
  const voiceChanged = event => { voiceSessionId = event.detail.sessionId; voiceState = event.detail.state; mark({ rows: screen.getRows(), state: screen.getState() }) }
  window.addEventListener('mc-voice-contact-change', voiceChanged)
  root.addEventListener('toggle', () => { if (root.open) void screen.refresh() })
  return { el: root, refresh: screen.refresh,
    async selectAgent(agent) {
      const operation = ++selectionOperation
      const isCurrent = () => !destroyed && operation === selectionOperation
      root.open = true
      const row = await screen.selectAgent(agent, { isCurrent })
      if (!isCurrent() || !row) return false
      return voice.selectTarget(row.sessionId, { isCurrent })
    },
    destroy() { destroyed = true; selectionOperation++; window.removeEventListener('mc-voice-contact-change', voiceChanged); screen.destroy(); voice.destroy(); root.remove() },
  }
}
