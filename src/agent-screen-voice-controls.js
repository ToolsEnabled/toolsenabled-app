import { attachPersistentVoice } from './voice-coordinator.js'
import { createScreenAccessControls } from './screen-access-controls.js'
import { createAgentVideoControls } from './agent-video-controls.js'
import { VIDEO_BOX_CHANGE_EVENT } from './video-box-broker.js'

/* VOICE, SCREEN & VIDEO for the agent whose mic button was pressed. Voice on
   the left; on the right one column holds the Computer control card and,
   directly under it, the Video section (1.0.49). Video is its own component,
   never part of createScreenAccessControls, which Settings > App permissions
   reuses. */
export function mountAgentScreenVoiceControls({ sample = false, getComputerId = () => null, onMarks = () => {},
  videoBroker = null, getTreeView = undefined, isSavedTreeAgent = undefined } = {}) {
  const root = document.createElement('details')
  root.className = 'agent-screen-voice-controls'
  root.innerHTML = '<summary>Voice, screen &amp; video <span data-control-count></span></summary><div class="agent-control-body"></div>'
  const voice = attachPersistentVoice({ sample })
  let voiceSessionId = voice.getContact().sessionId, voiceState = voice.getContact().state,
    destroyed = false, selectionOperation = 0, screen = null
  function mark({ state, rows }) {
    if (destroyed) return
    // Panels for every chosen video; "with video" and "video on" only for ones started in this run.
    const videoNodeIds = video.getNodeIds()
    const videoStartedNodeIds = video.getStartedNodeIds()
    const counts = [state?.grants?.length ? `${state.grants.length} with screen access` : '',
      videoStartedNodeIds.length ? `${videoStartedNodeIds.length} with video` : ''].filter(Boolean)
    root.querySelector('[data-control-count]').textContent = counts.length ? `· ${counts.join(' · ')}` : ''
    onMarks({ voiceNodeId: rows.find(row => row.sessionId === voiceSessionId)?.nodeId || null, voiceState,
      screenNodeIds: (state?.grants || []).map(grant => rows.find(row => row.sessionId === grant.sessionId)?.nodeId).filter(Boolean),
      videoNodeIds, videoStartedNodeIds })
  }
  // A video started, stopped or was forgotten: the tree's panels follow.
  const videoChanged = () => { if (screen) mark({ rows: screen.getRows(), state: screen.getState() }) }
  const video = createAgentVideoControls({ sample, getComputerId, broker: videoBroker,
    ...(getTreeView ? { getTreeView } : {}), ...(isSavedTreeAgent ? { isSavedTreeAgent } : {}), onChange: videoChanged, onReveal: () => { root.open = true } })
  screen = createScreenAccessControls({ sample, getComputerId, onChange: mark })
  const column = document.createElement('div')
  column.className = 'agent-control-column'
  column.append(screen.el, video.el)
  root.querySelector('.agent-control-body').append(voice.el, column)
  const voiceChanged = event => { voiceSessionId = event.detail.sessionId; voiceState = event.detail.state; mark({ rows: screen.getRows(), state: screen.getState() }) }
  window.addEventListener('mc-voice-contact-change', voiceChanged)
  window.addEventListener(VIDEO_BOX_CHANGE_EVENT, videoChanged)
  root.addEventListener('toggle', () => {
    if (root.open) { void screen.refresh(); void video.refresh() } else video.closePicker()
  })
  return { el: root,
    async refresh() { await Promise.all([screen.refresh(), video.refresh()]) },
    async selectAgent(agent) {
      const operation = ++selectionOperation
      const isCurrent = () => !destroyed && operation === selectionOperation
      // First, and synchronously: video needs no running session, and the
      // screen lookup below returns early for an agent that is not running.
      video.setAgent(agent)
      root.open = true
      const row = await screen.selectAgent(agent, { isCurrent })
      if (!isCurrent() || !row) return false
      return voice.selectTarget(row.sessionId, { isCurrent })
    },
    destroy() {
      destroyed = true; selectionOperation++
      window.removeEventListener('mc-voice-contact-change', voiceChanged)
      window.removeEventListener(VIDEO_BOX_CHANGE_EVENT, videoChanged)
      screen.destroy(); video.destroy(); voice.destroy(); root.remove()
    },
  }
}
