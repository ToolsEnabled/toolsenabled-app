import { createHandPointer } from './hand-pointer.js'
import { createHandPress } from './hand-press.js'

export const HAND_CONTROLS_KEY = 'mc.hand-controls.enabled'
export const HAND_CONTROLS_EVENT = 'mc-hand-controls-state'
const TARGETS = 'button, a[href], input:not([type="hidden"]):not([type="file"]), textarea, select, summary, [role="button"]'
const listeners = new Set()
let instance
export function handControls() { return instance }
export function readHandChoice(storage) {
  try { return storage?.getItem(HAND_CONTROLS_KEY) === 'true' } catch { return false }
}

/* mcSetup.platform is the preload's local process platform. A missing or unknown
 * value stays neutral; this copy never guesses a remote machine's platform. */
function cameraErrorMessage(name, platform) {
  if (name === 'NotFoundError') {
    return platform === 'win32'
      ? 'No camera is available. Connect a webcam and check Windows Camera, then try again.'
      : 'No camera is available. Connect a webcam, check that no other program is using it, and check camera permission on this computer, then try again.'
  }
  if (name === 'NotAllowedError') {
    return platform === 'win32'
      ? 'Camera access was denied. Allow camera access for desktop apps in Windows settings, then try again.'
      : 'Camera access was denied. Allow camera access for this computer, then try again.'
  }
  if (name === 'NotReadableError') return 'The camera could not be opened. Check whether another application is using it.'
  if (name === 'OverconstrainedError') return 'This camera does not support the requested capture mode.'
  return 'Hand controls could not start. Check the camera connection and try again.'
}

export function startHandControls({ doc = document, win = window, storage,
  camera = win.mcHandControls, createWorker = url => new Worker(url),
  getMedia = options => navigator.mediaDevices.getUserMedia(options),
  createFrame = video => win.createImageBitmap(video),
  isActive = () => doc.visibilityState === 'visible' && doc.hasFocus(),
  assetRoot,
  platform = win?.mcSetup?.platform,
} = {}) {
  if (instance) return instance
  if (storage === undefined) { try { storage = win.localStorage } catch { storage = null } }
  const pointer = createHandPointer()
  const presses = createHandPress(doc)
  let enabled = readHandChoice(storage), destroyed = false, generation = 0, active = null
  let target = null, lockedTarget = null, wasPinching = false, cursor = null, hud = null
  let state = { enabled, phase: 'off', message: 'Off. The camera and hand tracker are stopped.', stats: null }
  function publish(patch) {
    state = { ...state, ...patch, enabled }
    for (const listener of listeners) listener(state)
    win.dispatchEvent(new CustomEvent(HAND_CONTROLS_EVENT, { detail: state }))
  }
  function clearAim() {
    pointer.reset(); target?.classList.remove('hand-control-target')
    target = lockedTarget = null; wasPinching = false
    if (cursor) cursor.hidden = true
  }
  function eligible(element) {
    return Boolean(element?.isConnected && !element.matches(':disabled')
      && !element.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"], [data-hand-ignore]')
      && element.getClientRects().length && win.getComputedStyle(element).visibility === 'visible')
  }
  function hit(x, y) {
    const top = doc.elementFromPoint(x, y)
    const element = top?.closest(TARGETS) || top?.closest('label')?.control
    return eligible(element) ? element : null
  }
  function mark(next) {
    if (target !== next) { target?.classList.remove('hand-control-target'); target = next; target?.classList.add('hand-control-target') }
  }
  function teardown() {
    presses.close()
    generation++
    const previous = active; active = null
    if (previous) {
      clearTimeout(previous.timer); clearTimeout(previous.watchdog)
      previous.worker?.terminate()
      previous.stream?.getTracks().forEach(track => track.stop())
      previous.video.pause(); previous.video.srcObject = null; previous.video.remove()
    }
    clearAim(); cursor?.remove(); hud?.remove(); cursor = hud = null
    // The IPC owner separately revokes camera admission on blur and navigation.
    void camera?.setEnabled(false).catch(() => {})
  }
  function fail(message) {
    teardown(); enabled = false
    try { storage?.setItem(HAND_CONTROLS_KEY, 'false') } catch { /* stopped even if persistence fails */ }
    publish({ phase: 'error', message, stats: null })
  }
  function showControls() {
    cursor = doc.createElement('div'); cursor.className = 'hand-control-pointer'; cursor.hidden = true
    cursor.setAttribute('aria-hidden', 'true'); doc.body.append(cursor)
    hud = doc.createElement('aside'); hud.className = 'hand-control-hud'
    const label = doc.createElement('span'); label.textContent = 'Hand controls on · Pinch to press'
    const stop = doc.createElement('button'); stop.type = 'button'; stop.textContent = 'Turn off hand controls'
    stop.addEventListener('click', () => { void api.setEnabled(false) })
    hud.append(label, stop); doc.body.append(hud)
  }
  async function start() {
    if (destroyed || active || !enabled) return
    if (!isActive()) { publish({ phase: 'paused', message: 'Paused while this window is in the background.' }); return }
    if (!camera || !win.Worker || !win.createImageBitmap || !navigator.mediaDevices?.getUserMedia) {
      fail('Hand controls need a supported desktop app, graphics driver, and camera.'); return
    }
    const run = { generation: ++generation, video: doc.createElement('video'), stream: null, worker: null,
      timer: null, watchdog: null, busy: false, ready: false, lastFrame: -1, samples: [], frames: 0,
      startedAt: 0, lastReport: 0, captureAt: 0, interval: 50 }
    active = run
    const current = () => active === run && run.generation === generation && enabled && !destroyed
    run.video.muted = true; run.video.playsInline = true
    run.video.className = 'hand-control-video'; run.video.setAttribute('aria-hidden', 'true')
    doc.body.append(run.video)
    publish({ phase: 'starting', message: 'Opening the camera and preparing hand tracking…', stats: null })
    run.watchdog = setTimeout(() => { if (current()) fail('The camera or tracker took too long to start. Check your camera and graphics driver, then try again.') }, 30000)
    try {
      // Optional controls must not resolve or load tracker assets while off.
      // Resolve before granting camera access; an unusable base fails locally.
      const trackerUrl = new URL('tracker.js', assetRoot === undefined
        ? new URL('./hand-controls/', doc.baseURI) : assetRoot)
      await camera.setEnabled(true)
      if (!current()) return
      const stream = await getMedia({ audio: false, video: {
        width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 20, max: 20 },
      } })
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return }
      run.stream = stream
      for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (current()) fail('The camera disconnected. Reconnect it, then turn hand controls on again.') }, { once: true })
      run.video.srcObject = stream
      await run.video.play()
      if (!current()) return
      run.worker = createWorker(trackerUrl)
      run.worker.onerror = () => { if (current()) fail('Hand tracking could not load. Check the installation and graphics driver.') }
      run.worker.onmessage = ({ data }) => {
        if (!current()) return
        if (data.type === 'error') { fail('Hand tracking could not run on the graphics processor. Update its driver and try again.'); return }
        if (data.type === 'ready') {
          clearTimeout(run.watchdog); run.ready = true; run.startedAt = performance.now(); run.lastReport = run.startedAt
          showControls(); publish({ phase: 'running', message: 'Move your palm to aim. Pinch to press; release to press again. Escape turns hand controls off.' })
          schedule(); return
        }
        if (data.type !== 'result' || !run.busy || data.at !== run.captureAt) return
        clearTimeout(run.watchdog); run.busy = false
        if (!isActive()) { reconcile(); return }
        const now = performance.now(), age = now - data.at
        run.frames++; run.samples.push({ inference: data.ms, age }); if (run.samples.length > 120) run.samples.shift()
        // Drop stale camera results rather than delivering a delayed click.
        if (age > 250) clearAim()
        else {
          const value = pointer.update(data.landmarks, data.at, { aspect: run.video.videoWidth / run.video.videoHeight, hand: data.hand })
          if (!value) clearAim()
          else {
            const x = value.x * win.innerWidth, y = value.y * win.innerHeight
            const zoom = cursor.currentCSSZoom || 1
            cursor.hidden = false; cursor.style.left = (x / zoom) + 'px'; cursor.style.top = (y / zoom) + 'px'
            cursor.dataset.pinching = String(value.pinching)
            const under = hit(x, y)
            if (value.pinching && !wasPinching) lockedTarget = target
            if (!value.pinching) lockedTarget = null
            mark(value.pinching ? (eligible(lockedTarget) ? lockedTarget : null) : under)
            wasPinching = value.pinching
            // Re-hit-test: a modal, disabled control, or moved/removed target cancels the press.
            if (value.click && target && target === under && target === lockedTarget) presses.press(target)
          }
        }
        if (!current()) return
        if (now - run.lastReport >= 1000) {
          const sorted = run.samples.map(sample => sample.inference).sort((a, b) => a - b)
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
          // Modest, bounded adaptation; no backlog and no CPU fallback competing with speech.
          run.interval = p95 > 45 ? 83 : 50
          publish({ stats: { frames: run.frames, fps: run.frames * 1000 / (now - run.startedAt),
            inferenceP95: p95, frameAge: age, delegate: 'GPU', cameraWidth: run.video.videoWidth, cameraHeight: run.video.videoHeight } })
          run.lastReport = now
        }
        schedule()
      }
      run.worker.postMessage({ type: 'init' })
    } catch (error) {
      if (!current()) return
      fail(cameraErrorMessage(error.name, platform))
    }
    function schedule() {
      if (current()) run.timer = setTimeout(frame, Math.max(0, run.interval - (performance.now() - run.captureAt)))
    }
    async function frame() {
      if (!current()) return
      if (!isActive()) { reconcile(); return }
      if (run.busy) return
      if (run.video.readyState < 2 || run.video.currentTime === run.lastFrame) { run.timer = setTimeout(frame, run.interval); return }
      run.lastFrame = run.video.currentTime; run.busy = true; run.captureAt = performance.now()
      run.watchdog = setTimeout(() => { if (current()) fail('Camera tracking stopped responding. Hand controls are off; you can try again.') }, 5000)
      try {
        const bitmap = await createFrame(run.video)
        if (!current()) { bitmap.close(); return }
        run.worker.postMessage({ type: 'frame', frame: bitmap, at: run.captureAt }, [bitmap])
      } catch { if (current()) fail('A camera frame could not be read. Hand controls are off.') }
    }
  }
  function reconcile() {
    if (!enabled || destroyed) return
    if (!isActive()) { teardown(); publish({ phase: 'paused', message: 'Paused while this window is in the background.', stats: null }) }
    else void start()
  }
  function key(event) { if (event.key === 'Escape' && enabled) void api.setEnabled(false) }
  function resetAim() { clearAim(); presses.close() }
  const api = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) },
    async setEnabled(value) {
      if (destroyed) return { ok: false, reason: 'Hand controls are no longer available in this window.' }
      if (value !== true && value !== false) throw new TypeError('Hand control choice must be boolean')
      enabled = value
      let saved = true
      try { storage?.setItem(HAND_CONTROLS_KEY, String(value)) }
      catch {
        saved = false
        if (value) {
          enabled = false; teardown(); publish({ phase: 'error', message: 'Could not save this setting. Hand controls remain off.' })
          return { ok: false, reason: state.message }
        }
      }
      if (!value) { teardown(); publish({ phase: 'off', message: 'Off. The camera and hand tracker are stopped.', stats: null }) }
      else await start()
      if (!saved) return { ok: false, reason: 'Hand controls are stopped, but the choice could not be saved. Save again to keep them off after restarting.' }
      if (enabled !== value) return { ok: false, reason: state.message }
      return { ok: true }
    },
    destroy() {
      destroyed = true; teardown()
      win.removeEventListener('focus', reconcile); win.removeEventListener('blur', reconcile)
      doc.removeEventListener('visibilitychange', reconcile); win.removeEventListener('keydown', key, true)
      win.removeEventListener('hashchange', resetAim); win.removeEventListener('resize', resetAim)
      win.removeEventListener('pagehide', api.destroy); listeners.clear(); instance = undefined
    },
  }
  instance = api
  win.addEventListener('focus', reconcile); win.addEventListener('blur', reconcile)
  doc.addEventListener('visibilitychange', reconcile); win.addEventListener('keydown', key, true)
  win.addEventListener('hashchange', resetAim); win.addEventListener('resize', resetAim)
  win.addEventListener('pagehide', api.destroy)
  if (enabled) void start()
  return api
}
