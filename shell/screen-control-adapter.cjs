'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const KEYS = /^(?:(?:Control|Alt|Shift|Meta)\+){0,3}(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Backspace|Delete|Insert|Space|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/

function createScreenControlAdapter({ screen, desktopCapturer, platform = process.platform,
  environment = process.env, spawnProcess = spawn }) {
  const sharedDesktop = [environment, process.env].some(source => Object.keys(source).some(name =>
    /^(TOOLSENABLED_SHARED_HOST_SESSION|TOOLSENABLED_PROVIDER_ISOLATION_ROOT)$/i.test(name)))
  const unavailableReason = () => sharedDesktop
    ? 'Screen takeover in a shared DEV session requires an independently owned desktop. Private profiles do not isolate the mouse, keyboard or screen.'
    : 'Screen control requires Windows or a Linux X11 desktop session.'
  const supported = () => !sharedDesktop && (platform === 'win32' || (platform === 'linux' && Boolean(environment.DISPLAY)
    && environment.XDG_SESSION_TYPE !== 'wayland' && !environment.WAYLAND_DISPLAY))
  function geometry() {
    return { displays: screen.getAllDisplays().map(display => ({ id: String(display.id),
      bounds: display.bounds, scaleFactor: display.scaleFactor })) }
  }
  function point(x, y) {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
        || !screen.getAllDisplays().some(({ bounds: b }) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height)) {
      fail('SCREEN_COORDINATES_INVALID', 'Use coordinates inside a display returned by screen.status or the latest screenshot.')
    }
    return platform === 'win32' ? screen.dipToScreenPoint({ x, y }) : { x, y }
  }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SCREEN_ACTION_INVALID', 'Provide one screen action.')
    const fields = { screenshot: ['displayId'], move: ['x', 'y'], click: ['x', 'y', 'button', 'clickCount'],
      drag: ['x', 'y', 'toX', 'toY'], scroll: ['x', 'y', 'direction', 'amount'], type: ['text'], key: ['key'] }[input.action]
    if (!fields || Object.keys(input).some(key => key !== 'action' && !fields.includes(key))) fail('SCREEN_ACTION_INVALID', 'Choose one documented screen action and its fields.')
    const value = { ...input }
    if (['move', 'click', 'drag', 'scroll'].includes(value.action)) Object.assign(value, point(value.x, value.y))
    if (value.action === 'drag') { const end = point(value.toX, value.toY); value.toX = end.x; value.toY = end.y }
    if (value.action === 'click') {
      value.button ??= 'left'; value.clickCount ??= 1
      if (!['left', 'middle', 'right'].includes(value.button) || ![1, 2].includes(value.clickCount)) fail('SCREEN_ACTION_INVALID', 'Choose left, middle or right and one or two clicks.')
    }
    if (value.action === 'scroll') {
      value.amount ??= 3
      if (!['up', 'down', 'left', 'right'].includes(value.direction) || !Number.isInteger(value.amount) || value.amount < 1 || value.amount > 20) fail('SCREEN_ACTION_INVALID', 'Choose a scroll direction and one through 20 steps.')
    }
    if (value.action === 'type' && (typeof value.text !== 'string' || value.text.length > 4000 || value.text.includes('\0'))) fail('SCREEN_ACTION_INVALID', 'Text must contain at most 4000 characters and no nulls.')
    if (value.action === 'key' && (typeof value.key !== 'string' || !KEYS.test(value.key))) fail('SCREEN_ACTION_INVALID', 'Use a named key, optionally preceded by Control, Alt, Shift or Meta.')
    if (value.action === 'screenshot' && value.displayId !== undefined && !geometry().displays.some(display => display.id === value.displayId)) fail('SCREEN_DISPLAY_INVALID', 'Choose a display from screen.status.')
    return Object.freeze(value)
  }
  function native(action, signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Screen control was stopped.'),
      { code: 'SCREEN_ACTION_INTERRUPTED', cleanupConfirmed: true }))
    const windows = platform === 'win32'
    const helperRoot = __dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
    const command = windows ? path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/usr/bin/python3'
    const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(helperRoot, 'screen-control-native.ps1')]
      : ['-I', '-S', '-B', path.join(helperRoot, 'screen-control-native.py')]
    return new Promise((resolve, reject) => {
      let output = '', settled = false, interruption = null, forceTimer = null, didSpawn = false, child
      try {
        child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: windows ? environment : { PATH: '/usr/bin:/bin', DISPLAY: environment.DISPLAY, XAUTHORITY: environment.XAUTHORITY || '', LANG: 'C.UTF-8' } })
      } catch (error) { error.cleanupConfirmed = true; reject(error); return }
      const finish = async (error, originalCleanupConfirmed = false) => {
        if (settled) return
        settled = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort)
        // Wait for the old process to exit AND release input before the host
        // lets another agent start. A late release must never hit its action.
        if (error && didSpawn && !originalCleanupConfirmed && action.action !== 'release') {
          try { await native({ action: 'release' }) }
          catch { error = Object.assign(new Error('Input could not be released. Screen access was stopped; check the mouse and keyboard before granting it again.'), { code: 'SCREEN_INPUT_RELEASE_FAILED' }) }
          // The fallback resets buttons and modifiers. It cannot certify an
          // ordinary key's release or restore a typing helper's X11 keymap.
          if (action.action === 'key' || action.action === 'type') {
            error = Object.assign(new Error('The keyboard helper did not confirm cleanup. Desktop ownership is retained.'), { code: 'SCREEN_INPUT_RELEASE_FAILED' })
          }
        }
        if (error) {
          error.code ||= 'SCREEN_ACTION_UNCERTAIN'
          error.cleanupConfirmed = !didSpawn || originalCleanupConfirmed
            || (error.code !== 'SCREEN_INPUT_RELEASE_FAILED' && action.action !== 'release')
          reject(error)
        } else resolve({ status: 'completed', action: action.action, cleanupConfirmed: true })
      }
      const interrupt = error => {
        if (settled || interruption) return
        interruption = error
        child.kill()
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 1500)
      }
      const abort = () => interrupt(Object.assign(new Error('Screen control stopped. Inspect before repeating an action that may have completed.'), { code: 'SCREEN_ACTION_INTERRUPTED' }))
      const timer = setTimeout(abort, 12000)
      signal?.addEventListener('abort', abort, { once: true })
      child.once('spawn', () => { didSpawn = true })
      child.on('error', () => { interruption ||= new Error('The screen input helper could not start.') })
      child.stdout.on('data', bytes => { output += bytes; if (output.length > 4096) interrupt(new Error('Invalid screen helper response.')) })
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => {})
      child.on('close', code => {
        const confirmed = code === 0 && output.trim() === '{"ok":true}'
        void finish(interruption || (confirmed ? null : new Error('Screen input failed. Inspect the screen before retrying.')), confirmed)
      })
      child.stdin.end(JSON.stringify(action))
    })
  }
  async function execute(action, signal) {
    if (!supported()) fail(sharedDesktop ? 'SCREEN_SHARED_DESKTOP_UNAVAILABLE' : 'SCREEN_PLATFORM_UNAVAILABLE', unavailableReason())
    if (signal?.aborted) throw Object.assign(new Error('Screen control was stopped before input began.'),
      { code: 'SCREEN_ACTION_INTERRUPTED', cleanupConfirmed: true })
    if (action.action !== 'screenshot') return native(action, signal)
    const display = screen.getAllDisplays().find(item => String(item.id) === action.displayId) || screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 }, fetchWindowIcons: false })
    if (signal?.aborted) fail('SCREEN_ACTION_INTERRUPTED', 'Screen control was stopped before capture completed.')
    const source = sources.find(item => item.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) fail('SCREEN_CAPTURE_UNAVAILABLE', 'The selected screen could not be captured.')
    let thumbnail = source.thumbnail, bytes = thumbnail.toPNG()
    while (bytes.length > 1024 * 1024 && thumbnail.getSize().width > 320) {
      thumbnail = thumbnail.resize({ width: Math.floor(thumbnail.getSize().width * 0.75) }); bytes = thumbnail.toPNG()
    }
    if (bytes.length > 1024 * 1024) fail('SCREEN_CAPTURE_TOO_LARGE', 'Screen capture exceeded the image limit.')
    const result = { status: 'completed', displayId: String(display.id), bounds: display.bounds,
      imageSize: thumbnail.getSize(), coordinateMapping: 'x = bounds.x + imageX * bounds.width / imageSize.width; y likewise. Round to an integer.', untrusted: true }
    Object.defineProperty(result, '__mcpImage', { value: bytes })
    return result
  }
  return { supported, unavailableReason, geometry, validate, execute }
}
module.exports = { createScreenControlAdapter }
