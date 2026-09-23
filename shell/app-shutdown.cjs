'use strict'

/* Electron emits before-quit before a window's beforeunload. Request the
   normal close first: a renderer may still be saving, or the person may keep
   an unsaved draft. No app-owned service may be sealed in that case. Once
   every window closes, window-all-closed retries app.quit and the existing
   bounded runtime coordinator owns the irreversible shutdown. */
function createAppQuitGate({ getWindows, shutdown } = {}) {
  if (typeof getWindows !== 'function' || typeof shutdown?.beforeQuit !== 'function') {
    throw new TypeError('The app quit gate needs its windows and shutdown coordinator.')
  }
  return function beforeQuit(event) {
    if (!shutdown.started) {
      const windows = getWindows().filter(window => !window.isDestroyed())
      if (windows.length) {
        event.preventDefault()
        for (const window of windows) if (!window.isDestroyed()) window.close()
        return
      }
    }
    return shutdown.beforeQuit(event)
  }
}

module.exports = Object.freeze({ createAppQuitGate })
