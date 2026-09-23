import { createVoiceController } from './voice-controller.js'
import * as queue from './session-outbox.js'
import { readSessionRoles, roleForSessionTarget } from './session-roles.js'
import { createTranscriptStore } from './session-transcript-store.js'
import { safeTreeStorage } from './fleet-trees.js'
import { createVoiceAudioVisualizer } from './voice-audio-visualizer.js'
import { publishVoiceHeard, publishVoiceLevel } from './voice-signal.js'
import './home-voice.css'

let voiceControlsId = 0

const ERRORS = {
  cloud_quota_exhausted: 'Your speech API account has run out of quota. Add credit with your provider or select local speech. Typed chat still works.',
  cloud_rate_limited: 'Your speech account is rate-limited. Try again later; no other account was charged.',
  cloud_key_rejected: 'Your speech API key was rejected. Check the key and its permissions.',
  gpu_unavailable: 'No supported speech GPU is available. CPU fallback is disabled.',
  gpu_initialization_failed: 'Speech could not load on the GPU. Free GPU memory and try again.',
  gpu_dependencies_unavailable: 'GPU speech files could not load on the computer running ToolsEnabled. Repair its local speech installation, then retry.',
  models_missing: 'Local speech models are missing on the computer running ToolsEnabled. Complete local speech setup there, then retry.',
  VOICE_RUNTIME_NOT_INSTALLED: 'Local speech is missing from the computer running ToolsEnabled. Install its local speech runtime, then retry.',
  VOICE_RUNTIME_BUNDLE_INVALID: 'The bundled Windows speech files are incomplete. Run the ToolsEnabled Windows installer again on the computer running ToolsEnabled to repair speech, then retry.',
  VOICE_RUNTIME_START_FAILED: 'The speech service could not start on the computer running ToolsEnabled. Retry voice; if it still fails, check the local speech installation there.',
  VOICE_TARGET_UNAVAILABLE: 'That agent is no longer available. Choose another contact.',
  VOICE_ALREADY_ACTIVE: 'Voice is already active. End that voice connection first.',
  VOICE_OWNED_BY_ANOTHER_WINDOW: 'Voice is active in another window.',
  VOICE_API_KEY_REQUIRED: 'Enter your own speech API key. Provider charges belong to your account.',
  VOICE_RATE_LIMITED: 'Your speech provider is rate-limiting requests. Voice is paused.',
  VOICE_CONNECT_TIMEOUT: 'An audio connection to your computer could not be established. Check its network connection and try again.',
  VOICE_EVENTS_LOST: 'The speech connection fell behind. Voice has paused; reconnect to continue.',
  VOICE_MICROPHONE_ENDED: 'Microphone stopped. Check this site’s microphone permission, then start voice again.',
  VOICE_SECURE_CONTEXT_REQUIRED: 'Open this app over HTTPS to use the microphone.',
  MC_AGENT_PRINCIPAL_READ_ONLY: 'Turn on web control in the connected computer’s Settings to use voice.',
}
function errorCopy(error, remote = false) {
  const raw = [error?.code, error?.name, error?.message].filter(value => typeof value === 'string').join(' ') || String(error)
  return Object.entries(ERRORS).find(([code]) => raw.toUpperCase().includes(code.toUpperCase()))?.[1]
    || (raw.includes('NotAllowedError') ? (remote ? 'Allow microphone access for this site in your browser and phone settings.' : 'Allow microphone access for this app in your computer’s privacy settings.') : 'Voice could not connect. Typed chat still works.')
}

export function voiceCoordinator({ sample = false, ring = null, onState = () => {} } = {}) {
  const root = document.createElement('section')
  root.className = 'voice-contact voice-contact-panel'
  root.setAttribute('aria-label', 'Voice contact')
  root.dataset.expanded = 'false'
  const controlsId = `voice-contact-controls-${++voiceControlsId}`
  root.innerHTML = `
    <div class="voice-widget-bar">
      <button type="button" class="voice-widget-toggle" data-voice-expand aria-expanded="false" aria-controls="${controlsId}" aria-label="Show voice controls">
        <span class="voice-wave" aria-hidden="true">${'<i></i>'.repeat(12)}</span>
        <span class="voice-widget-label"><span class="voice-widget-heading"><span class="voice-contact-title">Voice</span><span class="voice-contact-state" data-voice-state>Off</span></span><span class="voice-widget-contact" data-voice-contact-name>Choose a running agent</span></span>
        <svg class="voice-widget-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
      </button>
      <div class="voice-widget-live" data-voice-live hidden>
        <button type="button" data-voice-compact-mute aria-label="Mute mic" title="Mute mic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6"/><path class="voice-mute-slash" d="m4 4 16 16"/></svg></button>
        <button type="button" data-voice-compact-end>End voice</button>
      </div>
    </div>
    <div class="voice-widget-controls" data-voice-controls id="${controlsId}" hidden>
    <label class="voice-contact-target"><span>Talk to</span><select data-voice-target aria-label="Voice contact agent"><option value="">Choose a running agent</option></select></label>
    <div class="voice-controls"><button type="button" data-voice-start>Start voice</button><button type="button" data-voice-mute disabled>Mute mic</button><button type="button" data-voice-quiet disabled>Stop reply</button><button type="button" data-voice-resume hidden>Play voice</button></div>
    <p data-voice-status role="status">One agent speaks for your tree. Start voice when you’re ready.</p>
    <p data-voice-heard class="voice-heard" aria-live="polite"></p>
    <details class="voice-contact-connection"><summary>Speech connection</summary>
      <label><span>Speech runs on</span><select data-voice-provider><option value="local">This computer · GPU</option><option value="openai">OpenAI · my API key</option></select></label>
      <label data-voice-key-wrap hidden><span>API key</span><input data-voice-key type="password" autocomplete="off" spellcheck="false" placeholder="For this session only" /></label>
      <p data-voice-privacy>Local speech stays on this computer. Your selected agent keeps its own provider and permissions.</p>
      <p>You are hearing an AI-generated voice. You can speak over it. Speaking interrupts this agent’s current turn. It continues with your combined instruction after you finish.</p>
      <p class="voice-visual-privacy">The bars read audio from this voice connection on this screen. They do not record or send it.</p>
    </details>
    </div>`
  const get = name => root.querySelector(`[data-voice-${name}]`)
  const target = get('target'), startButton = get('start'), muteButton = get('mute'), quietButton = get('quiet')
  const provider = get('provider'), key = get('key')
  const voice = window.mcVoice, agent = window.mcAgent
  const localPrivacy = voice?.remote || !voice
    ? 'Speech processing runs on your computer running ToolsEnabled. This screen sends microphone audio and plays its replies. Your selected agent keeps its own provider and permissions.'
    : 'Local speech stays on this computer. Your selected agent keeps its own provider and permissions.'
  get('privacy').textContent = localPrivacy
  if (!voice) provider.querySelector('[value="local"]').textContent = 'Your computer · GPU'
  if (voice?.remote) {
    provider.querySelector('[value="local"]').textContent = 'Connected computer · GPU'
    provider.querySelector('[value="openai"]').remove()
    get('privacy').textContent = localPrivacy
  }
  let destroyed = false, connecting = false, binding = null, peer = null, stream = null, muted = false, operation = 0
  let sessionKey = null
  const pendingWaits = new Set()
  let pollTimer = null, targetRows = new Map(), selectionQueue = Promise.resolve(), selectionOperation = 0,
    selectionRestart = false
  const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); root.appendChild(audio)
  const bars = [...root.querySelectorAll('.voice-wave i')]
  const visualizer = createVoiceAudioVisualizer({ onFrame: levels => {
    for (let index = 0; index < bars.length; index++) bars[index].style.transform = `scaleY(${0.08 + (levels[index] || 0) * 0.92})`
    // The Home circle's voice-mode animations follow the same on-screen level (voice-signal.js).
    publishVoiceLevel(levels)
  } })
  const playbackEvents = ['playing', 'pause', 'waiting', 'ended', 'emptied', 'volumechange']
  let replyPlaying = false
  function syncVisualPlayback(event) {
    if (event?.type === 'playing') replyPlaying = true
    if (['pause', 'waiting', 'ended', 'emptied'].includes(event?.type)) replyPlaying = false
    visualizer.setPlaybackActive(replyPlaying && !audio.paused && !audio.muted && audio.volume > 0)
  }
  for (const event of playbackEvents) audio.addEventListener(event, syncVisualPlayback)
  function expandControls(expanded) {
    root.dataset.expanded = String(expanded)
    get('controls').hidden = !expanded
    get('expand').setAttribute('aria-expanded', String(expanded))
    refreshCompact()
  }
  get('expand').addEventListener('click', () => expandControls(get('controls').hidden))
  get('controls').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation(); expandControls(false); get('expand').focus()
  })
  get('compact-end').addEventListener('click', () => { if (binding || connecting) { startButton.click(); get('expand').focus() } })
  get('compact-mute').addEventListener('click', () => { if (binding) muteButton.click() })
  function refreshCompact() {
    const label = target.selectedOptions?.[0]?.textContent || 'Choose a running agent'
    get('contact-name').textContent = label
    get('contact-name').title = label
    get('expand').setAttribute('aria-label', `${get('controls').hidden ? 'Show' : 'Hide'} voice controls. ${get('state').textContent}. ${label}.`)
    get('live').hidden = !(binding || connecting)
    get('compact-mute').disabled = !binding
    get('compact-mute').setAttribute('aria-label', muted ? 'Unmute mic' : 'Mute mic')
    get('compact-mute').title = muted ? 'Unmute mic' : 'Mute mic'
    get('compact-mute').setAttribute('aria-pressed', String(muted))
  }
  function notify(message) { if (!destroyed) get('status').textContent = message }
  function setState(state) {
    root.dataset.state = state
    if (ring) ring.dataset.voice = state
    get('state').textContent = state.charAt(0).toUpperCase() + state.slice(1)
    refreshCompact()
    onState(state)
    window.dispatchEvent(new CustomEvent('mc-voice-contact-change', { detail: {
      sessionId: binding?.targetAgentId || target.value || null, state,
    } }))
  }
  function record(sessionId, who, text) {
    const info = roleForSessionTarget(targetRows.get(sessionId) || { sessionId }, readSessionRoles())
    if (!info?.computerId || !info.nodeId) return
    const store = createTranscriptStore({ computerId: info.computerId, storage: safeTreeStorage(window.localStorage) })
    const lines = store.get(info.nodeId)?.lines || []
    if (!store.save(info.nodeId, { lines: [...lines, { who, text, at: Date.now() }], keepUnknown: true })) notify('Conversation storage is full. Your agent still received the message.')
  }
  const controller = createVoiceController({ voice, agent, queue, record, notify })
  function refreshButtons() {
    startButton.textContent = binding || connecting ? 'End voice' : 'Start voice'
    startButton.disabled = !voice || sample || (!binding && !connecting && !target.value)
    provider.disabled = Boolean(binding || connecting)
    key.disabled = Boolean(binding || connecting)
    muteButton.disabled = !binding; quietButton.disabled = !binding
    refreshCompact()
  }
  async function refreshTargets(isCurrent = () => true) {
    clearTimeout(pollTimer)
    try {
      const rows = await voice.targets()
      if (destroyed || !isCurrent()) return
      targetRows = new Map(rows.map(row => [row.sessionId, row]))
      const roles = readSessionRoles()
      const selected = target.value
      const labeled = rows.map(row => {
        const info = roleForSessionTarget(row, roles)
        return { id: row.sessionId, label: info?.displayName || info?.role || row.agentId || row.tier || 'Agent',
          coordinator: info?.role === 'coordinator-assistant' || /coordinator.*assistant/i.test(row.agentId || '') }
      }).sort((a, b) => Number(b.coordinator) - Number(a.coordinator) || a.label.localeCompare(b.label))
      target.replaceChildren(new Option(labeled.length ? 'Choose a running agent' : 'Start an agent on the Computers page first', ''))
      for (const row of labeled) target.add(new Option(row.label, row.id))
      target.value = targetRows.has(selected) ? selected : (!binding && !connecting ? labeled[0]?.id || '' : '')
      if (binding && !targetRows.has(binding.targetAgentId)) { await stop(); notify('Your voice contact has ended. Choose another running agent.') }
      refreshButtons()
    } catch { if (isCurrent()) notify('Could not read running agents. Typed chat is unchanged.') }
    finally { if (!destroyed) pollTimer = setTimeout(refreshTargets, 10000) }
  }
  async function stop({ keepKey = false } = {}) {
    operation += 1; connecting = false; binding = null; controller.unbind()
    replyPlaying = false
    visualizer.stop()
    if (!keepKey) { sessionKey = null; key.value = '' }
    for (const cancel of pendingWaits) cancel()
    stream?.getTracks().forEach(track => track.stop()); stream = null
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); peer = null }
    if (audio.srcObject) audio.pause()
    audio.srcObject = null; muted = false; muteButton.textContent = 'Mute mic'
    get('resume').hidden = true
    setState('off'); refreshButtons()
    try { await voice?.stop() } catch { /* ownership refusal must not affect another window */ }
  }
  function waitFor(connection, eventName, predicate, timeout) {
    return new Promise((resolve, reject) => {
      if (predicate()) { resolve(); return }
      function cleanup() { clearTimeout(timer); connection.removeEventListener(eventName, changed); pendingWaits.delete(cancel) }
      function changed() { if (predicate()) { cleanup(); resolve() } }
      function cancel() { cleanup(); reject(new Error('VOICE_CONNECTION_CANCELED')) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('VOICE_CONNECT_TIMEOUT')) }, timeout)
      pendingWaits.add(cancel); connection.addEventListener(eventName, changed)
    })
  }
  async function start() {
    if (!target.value || connecting || binding) return
    const attempt = ++operation
    connecting = true; setState('connecting'); refreshButtons()
    notify(provider.value === 'local' ? 'Preparing GPU speech. The first start can take a few minutes; later starts are faster.' : 'Preparing speech on your selected connection…')
    async function acquireMicrophone() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('VOICE_SECURE_CONTEXT_REQUIRED')
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (destroyed || attempt !== operation) { acquired.getTracks().forEach(track => track.stop()); return false }
      stream = acquired
      const audioTracks = acquired.getAudioTracks()
      if (!audioTracks.length || audioTracks.some(track => track.readyState === 'ended')) throw new Error('VOICE_MICROPHONE_ENDED')
      visualizer.setInputStream(acquired)
      visualizer.setMuted(muted)
      for (const track of audioTracks) track.addEventListener('ended', () => {
        if (destroyed || attempt !== operation || stream !== acquired) return
        void stop()
        notify('Microphone stopped. Check this site’s microphone permission, then start voice again.')
      }, { once: true })
      return true
    }
    try {
      // On phones ask from the person's Start gesture, before a slow computer
      // startup. Desktop keeps its host reservation before microphone access.
      if (voice.remote && !await acquireMicrophone()) return
      if (provider.value === 'openai' && key.value) sessionKey = key.value
      const connected = await voice.start({ targetAgentId: target.value, provider: provider.value, ...(provider.value === 'openai' ? { apiKey: sessionKey } : {}) })
      key.value = ''
      if (destroyed || attempt !== operation) return
      binding = connected; controller.bind(binding, { ready: false })
      if (!voice.remote && !await acquireMicrophone()) return
      const connection = new window.RTCPeerConnection({ iceServers: [] }); peer = connection
      connection.ontrack = event => {
        if (peer !== connection) return
        const replyStream = event.streams[0] || new window.MediaStream([event.track])
        audio.srcObject = replyStream
        replyPlaying = false
        get('resume').hidden = true
        visualizer.setOutputStream(replyStream)
        visualizer.setPlaybackActive(false)
        void audio.play().then(() => { if (peer === connection && audio.srcObject === replyStream && !destroyed) syncVisualPlayback() }).catch(() => {
          if (peer !== connection || audio.srcObject !== replyStream || destroyed) return
          replyPlaying = false
          visualizer.setPlaybackActive(false)
          get('resume').hidden = false; notify('Tap Play voice to hear your computer’s reply.')
        })
      }
      connection.onconnectionstatechange = () => {
        if (peer === connection && ['failed', 'disconnected', 'closed'].includes(connection.connectionState)) { void stop(); notify('Speech connection ended. Typed chat still works.') }
      }
      for (const track of stream.getTracks()) connection.addTrack(track, stream)
      connection.createDataChannel('voice')
      await connection.setLocalDescription(await connection.createOffer())
      await waitFor(connection, 'icegatheringstatechange', () => connection.iceGatheringState === 'complete', 10000)
      if (attempt !== operation) return
      const answer = await voice.offer({ ...binding, type: 'offer', sdp: connection.localDescription.sdp })
      if (attempt !== operation) return
      await connection.setRemoteDescription(answer)
      await waitFor(connection, 'connectionstatechange', () => connection.connectionState === 'connected', 20000)
      if (attempt !== operation) return
      controller.ready()
      connecting = false; setState('listening'); refreshButtons()
      notify(get('resume').hidden ? 'Listening. Speak naturally; you can interrupt the voice.' : 'Listening. Tap Play voice to hear replies.')
    } catch (error) {
      key.value = ''
      if (attempt !== operation) return
      await stop(); notify(errorCopy(error, voice.remote))
    }
  }
  startButton.addEventListener('click', () => {
    selectionOperation++; selectionRestart = false
    if (binding || connecting) { void stop(); notify('Voice is off. The tree can keep working. Queued messages stay with their agent.') } else void start()
  })
  target.addEventListener('change', async () => {
    const restart = Boolean(binding || connecting || selectionRestart)
    selectionOperation++; selectionRestart = false
    if (restart) await stop({ keepKey: true })
    refreshButtons()
    if (restart && target.value) await start()
  })
  provider.addEventListener('change', () => {
    const cloud = provider.value === 'openai'; get('key-wrap').hidden = !cloud
    get('privacy').textContent = cloud ? 'Audio and reply text go to OpenAI. Your account pays speech charges. If quota runs out, voice pauses; typed chat stays available. The key is not saved.' : localPrivacy
    if (!cloud) { key.value = ''; sessionKey = null }
  })
  muteButton.addEventListener('click', () => {
    muted = !muted; stream?.getAudioTracks().forEach(track => { track.enabled = !muted })
    visualizer.setMuted(muted)
    muteButton.textContent = muted ? 'Unmute mic' : 'Mute mic'; setState(muted ? 'muted' : 'listening')
    notify(muted ? 'Microphone is muted. You can still hear replies.' : 'Listening. Speak naturally; you can interrupt the voice.')
  })
  quietButton.addEventListener('click', () => { void controller.interrupt().catch(() => notify('Could not stop speech. End voice to disconnect.')); setState(muted ? 'muted' : 'listening') })
  get('resume').addEventListener('click', () => {
    if (!binding || !audio.srcObject) return
    const attempt = operation, connection = peer, replyStream = audio.srcObject
    const current = () => !destroyed && attempt === operation && peer === connection && audio.srcObject === replyStream
    void audio.play().then(() => {
      if (!current()) return
      syncVisualPlayback()
      get('resume').hidden = true
      notify(muted ? 'Microphone is muted. You can still hear replies.' : 'Listening. Speak naturally; you can interrupt the voice.')
    }).catch(() => { if (!current()) return; replyPlaying = false; visualizer.setPlaybackActive(false); notify('Playback is still blocked. Check this site’s audio permission and tap Play voice again.') })
  })
  const detachVoice = voice?.onEvent?.(packet => {
    if (!binding || packet.sessionId !== binding.sessionId || packet.generation !== binding.generation) return
    controller.onVoice(packet)
    if (packet.type === 'transcript.partial' || packet.type === 'transcript.final') get('heard').textContent = typeof packet.text === 'string' ? packet.text.slice(0, 8192) : ''
    if (packet.type === 'transcript.final' && typeof packet.text === 'string') publishVoiceHeard(packet.text)
    if (packet.type === 'playback.started') setState('speaking')
    if (packet.type === 'playback.stopped' || packet.type === 'speech.started') setState(muted ? 'muted' : 'listening')
    if (packet.type === 'error') { void stop(); notify('Speech paused: ' + errorCopy(packet, voice.remote)) }
  })
  const detachAgent = agent?.onEvent?.(packet => controller.onAgent(packet))
  if (sample || !voice || !agent) notify(sample ? 'Voice is off in the demonstration.' : 'Voice requires the desktop app.')
  else void refreshTargets()
  refreshButtons(); setState('off')
  const onPageHide = () => { if (voice?.remote) void stop() }
  window.addEventListener('pagehide', onPageHide)
  // Hiding ToolsEnabled releases the microphone: an active voice session ends as End voice ends it. A window that is
  // only unfocused, or a different screen of the app, keeps it.
  const onHidden = () => {
    if (!document.hidden || !(binding || connecting)) return
    void stop(); notify('Voice ended while ToolsEnabled was hidden. Start voice again when you’re back.')
  }
  document.addEventListener('visibilitychange', onHidden)
  return { el: root,
    getContact() { return { sessionId: binding?.targetAgentId || target.value || null, state: root.dataset.state } },
    selectTarget(sessionId, { isCurrent = () => true } = {}) {
      if (destroyed || !isCurrent()) return Promise.resolve(false)
      const request = ++selectionOperation
      const current = () => !destroyed && request === selectionOperation && isCurrent()
      const selection = selectionQueue.then(async () => {
        if (!current()) return false
        await refreshTargets(current)
        if (!current()) return false
        if (!targetRows.has(sessionId)) { notify('Start this agent before selecting it for voice.'); return false }
        const restart = Boolean(binding || connecting || selectionRestart)
        selectionRestart = restart
        if (binding || connecting) await stop({ keepKey: true })
        if (!current()) return false
        target.value = sessionId
        refreshButtons(); setState('off')
        if (restart) await start()
        else { notify('Voice contact selected. Press Start voice when you’re ready.'); expandControls(true); startButton.focus() }
        return current()
      }).finally(() => {
        // A newer queued selection inherits the active call's restart intent,
        // including when it superseded this request during the stop bridge.
        if (request === selectionOperation) selectionRestart = false
      })
      selectionQueue = selection.catch(() => {})
      return selection
    },
    setRing(value) { if (ring) delete ring.dataset.voice; ring = value; if (ring) ring.dataset.voice = root.dataset.state },
    destroy() { destroyed = true; window.removeEventListener('pagehide', onPageHide); document.removeEventListener('visibilitychange', onHidden); clearTimeout(pollTimer); detachVoice?.(); detachAgent?.(); for (const event of playbackEvents) audio.removeEventListener(event, syncVisualPlayback); void stop(); visualizer.destroy(); root.remove() },
  }
}

// A page owns placement, not the microphone lifetime. Keep the existing
// controller and audio element when a requested screen replaces Home.
let persistent = null, dock = null, lease = 0
export function resetPersistentVoice() {
  lease++
  persistent?.destroy(); persistent = null
  dock?.remove(); dock = null
}
export function attachPersistentVoice({ sample = false, ring = null } = {}) {
  if (sample) { resetPersistentVoice(); return voiceCoordinator({ sample, ring }) }
  if (!persistent) {
    dock = document.createElement('div')
    dock.className = 'voice-screen-dock voice-widget-dock'
    dock.hidden = true
    dock.setAttribute('aria-label', 'Voice connection across screens')
    document.body.append(dock)
    persistent = voiceCoordinator({ ring, onState: state => {
      if (dock) {
        dock.hidden = state === 'off' || !dock.contains(persistent?.el)
      }
    } })
  }
  const currentLease = ++lease, contact = persistent
  dock.hidden = true
  contact.setRing(ring)
  return { el: contact.el, getContact: () => contact.getContact(),
    selectTarget: (sessionId, { isCurrent = () => true } = {}) => contact.selectTarget(sessionId, {
      isCurrent: () => currentLease === lease && persistent === contact && isCurrent(),
    }), destroy() {
    if (currentLease !== lease || persistent !== contact) return
    lease++
    contact.setRing(null)
    dock.append(contact.el)
    dock.hidden = contact.el.dataset.state === 'off'
  } }
}
