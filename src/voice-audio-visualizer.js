// Observe streams the voice session already owns. This module never acquires
// media, stops a track, or routes sound to an AudioContext destination.
export const VOICE_VISUALIZER_BAR_COUNT = 12
const SAMPLE_COUNT = 256
const FRAME_INTERVAL_MS = 34
const SILENCE_THRESHOLD = 0.003

export function createVoiceAudioVisualizer({
  onFrame = () => {},
  documentRef = globalThis.document,
  matchMedia = query => globalThis.matchMedia?.(query),
  createContext = () => {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext
    return AudioContext ? new AudioContext() : null
  },
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancel = handle => globalThis.clearTimeout(handle),
} = {}) {
  let context = null, transitionPending = null, frameHandle = null, loopVersion = 0
  let muted = false, playbackActive = false, destroyed = false
  let mediaQuery = null, observer = null, removeContextListener = null
  const sources = { input: null, output: null }
  const cleanupListeners = []

  function attempt(action) {
    try { return action() } catch { return undefined }
  }

  function emit(levels = Array(VOICE_VISUALIZER_BAR_COUNT).fill(0)) {
    attempt(() => onFrame(levels))
  }

  function cancelLoop() {
    loopVersion++
    if (frameHandle !== null) attempt(() => cancel(frameHandle))
    frameHandle = null
  }

  function listen(target, event, callback) {
    if (!target?.addEventListener) return () => {}
    target.addEventListener(event, callback)
    return () => attempt(() => target.removeEventListener(event, callback))
  }

  function detach(kind) {
    const source = sources[kind]
    sources[kind] = null
    if (!source) return
    for (const remove of source.listeners) remove()
    attempt(() => source.node?.disconnect())
    attempt(() => source.analyser?.disconnect())
  }

  function closeContext() {
    const previous = context
    context = null
    transitionPending = null
    removeContextListener?.()
    removeContextListener = null
    if (previous) attempt(() => Promise.resolve(previous.close()).catch(() => {}))
  }

  function releaseUnusedContext() {
    if (!sources.input && !sources.output) closeContext()
  }

  function failContext(failed) {
    if (context !== failed) return
    cancelLoop()
    detach('input')
    detach('output')
    closeContext()
    emit()
  }

  function motionAllowed() {
    return !documentRef?.hidden && documentRef?.visibilityState !== 'hidden'
      && !mediaQuery?.matches && !documentRef?.body?.classList?.contains('reduce-motion')
  }

  function sourceActive(kind) {
    const source = sources[kind]
    if (!source || (kind === 'input' ? muted : !playbackActive)) return false
    return source.tracks.some(track => track.readyState !== 'ended' && track.enabled !== false && !track.muted)
  }

  function canAnimate() {
    return !destroyed && motionAllowed() && (sourceActive('input') || sourceActive('output'))
  }

  function transitionContext(target) {
    const current = context
    if (!current || transitionPending || current.state === target) return
    const transition = { context: current, target }
    transitionPending = transition
    try {
      Promise.resolve(target === 'running' ? current.resume() : current.suspend()).then(() => {
        if (context !== current || transitionPending !== transition || destroyed) return
        transitionPending = null
        // Serialize browser operations, then honor the latest visibility and
        // audio gates. A late suspend must not strand newly visible audio.
        const desired = canAnimate() ? 'running' : 'suspended'
        if (desired !== target || current.state === target) reconcile()
        // An interrupted context may settle without reaching its target.
        // Wait for statechange instead of looping on resolved promises.
      }, () => failContext(current))
    } catch { failContext(current) }
  }

  function readLevels(source, levels) {
    source.analyser.getFloatTimeDomainData(source.samples)
    for (let bar = 0; bar < VOICE_VISUALIZER_BAR_COUNT; bar++) {
      const start = Math.floor(bar * SAMPLE_COUNT / VOICE_VISUALIZER_BAR_COUNT)
      const end = Math.floor((bar + 1) * SAMPLE_COUNT / VOICE_VISUALIZER_BAR_COUNT)
      let energy = 0
      for (let index = start; index < end; index++) {
        const value = source.samples[index]
        if (Number.isFinite(value)) energy += value * value
      }
      const rms = Math.sqrt(energy / (end - start))
      const level = rms > SILENCE_THRESHOLD ? Math.min(1, rms * 3) : 0
      levels[bar] = Math.max(levels[bar], level)
    }
  }

  function queueFrame() {
    const version = loopVersion
    try {
      frameHandle = schedule(() => {
        if (version !== loopVersion || destroyed) return
        frameHandle = null
        if (!canAnimate() || context?.state !== 'running') { reconcile(); return }
        const levels = Array(VOICE_VISUALIZER_BAR_COUNT).fill(0)
        for (const kind of ['input', 'output']) {
          if (!sourceActive(kind)) continue
          try { readLevels(sources[kind], levels) } catch { detach(kind) }
        }
        releaseUnusedContext()
        emit(levels)
        // onFrame may synchronously stop or destroy the owning voice widget.
        if (version !== loopVersion || destroyed) return
        if (canAnimate() && context?.state === 'running') queueFrame()
        else reconcile()
      }, FRAME_INTERVAL_MS)
    } catch { cancelLoop(); emit() }
  }

  function reconcile() {
    cancelLoop()
    if (!context || destroyed) { emit(); return }
    if (context.state === 'closed') { failContext(context); return }
    if (!canAnimate()) {
      emit()
      transitionContext('suspended')
      return
    }
    if (transitionPending || context.state !== 'running') {
      emit()
      transitionContext('running')
      return
    }
    queueFrame()
  }

  function setStream(kind, stream) {
    if (destroyed) return
    if (sources[kind]?.stream === stream) { reconcile(); return }
    detach(kind)
    const tracks = stream ? attempt(() => stream.getAudioTracks().filter(track => track.readyState !== 'ended')) : []
    if (tracks?.length) {
      let node = null, analyser = null
      try {
        if (!context) {
          context = createContext()
          if (context) removeContextListener = listen(context, 'statechange', reconcile)
        }
        if (context) {
          node = context.createMediaStreamSource(stream)
          analyser = context.createAnalyser()
          analyser.fftSize = SAMPLE_COUNT
          analyser.smoothingTimeConstant = 0
          node.connect(analyser)
          const source = { stream, tracks, node, analyser, samples: new Float32Array(SAMPLE_COUNT), listeners: [] }
          sources[kind] = source
          for (const track of tracks) {
            source.listeners.push(listen(track, 'ended', () => {
              if (sources[kind] !== source) return
              detach(kind)
              releaseUnusedContext()
              reconcile()
            }))
            source.listeners.push(listen(track, 'mute', reconcile), listen(track, 'unmute', reconcile))
          }
        }
      } catch {
        detach(kind)
        attempt(() => node?.disconnect())
        attempt(() => analyser?.disconnect())
      }
    }
    releaseUnusedContext()
    // Never retain levels from the stream that has just been replaced.
    emit()
    reconcile()
  }

  function stop() {
    cancelLoop()
    detach('input')
    detach('output')
    closeContext()
    muted = false
    playbackActive = false
    emit()
  }

  attempt(() => cleanupListeners.push(listen(documentRef, 'visibilitychange', reconcile)))
  attempt(() => {
    mediaQuery = matchMedia('(prefers-reduced-motion: reduce)')
    if (mediaQuery?.addEventListener) cleanupListeners.push(listen(mediaQuery, 'change', reconcile))
    else if (mediaQuery?.addListener) {
      mediaQuery.addListener(reconcile)
      cleanupListeners.push(() => attempt(() => mediaQuery.removeListener(reconcile)))
    }
  })
  attempt(() => {
    const MutationObserver = documentRef?.defaultView?.MutationObserver || globalThis.MutationObserver
    if (MutationObserver && documentRef?.body) {
      observer = new MutationObserver(reconcile)
      observer.observe(documentRef.body, { attributes: true, attributeFilter: ['class'] })
    }
  })

  return Object.freeze({
    setInputStream: stream => attempt(() => setStream('input', stream)),
    setOutputStream: stream => attempt(() => setStream('output', stream)),
    setMuted(value) {
      if (destroyed) return
      muted = Boolean(value)
      emit()
      attempt(reconcile)
    },
    setPlaybackActive(value) {
      if (destroyed) return
      playbackActive = Boolean(value)
      emit()
      attempt(reconcile)
    },
    stop,
    destroy() {
      if (destroyed) return
      destroyed = true
      stop()
      for (const remove of cleanupListeners) remove()
      cleanupListeners.length = 0
      attempt(() => observer?.disconnect())
      observer = null
    },
  })
}
