'use strict'
const path = require('node:path')
const { barHtml, haloHtml, agentAccent, actionLabels, shortcutLabel, STOP_SHORTCUT } = require('./screen-control-visuals.cjs')
function createScreenControlIndicator({ BrowserWindow, screen, globalShortcut, ipcMain }) {
  let bar = null, halo = null, timer = null, effectTimer = null, stop = null, preparing = null
  /* MEASURED 2026-09-17 on Windows 10 19045: the Windows shell permanently owns
     Control+Alt+Escape. RegisterHotKey refuses it with 1409,
     ERROR_HOTKEY_ALREADY_REGISTERED -- the same refusal it gives for the Task
     Manager chord Control+Shift+Escape -- while Control+Alt+Shift+Escape is
     granted, so the refusal is the chord itself, not the key and not this
     process. Arming the stop is a precondition of granting screen access, so
     the one hard-coded chord meant screen control could not be enabled on
     Windows AT ALL: every grant died in prepare() with "The screen-control stop
     shortcut is unavailable."

     ONE chord per platform, chosen up front -- never a list tried in order.
     Holding this chord is also the exclusive desktop-input lease BETWEEN app
     processes: a second instance is refused precisely because registration
     fails while the first still holds it. A fallback list would have let the
     second instance quietly take the next chord and drive the same desktop. */
  let shortcut = null
  const stopChannel = 'mc-screen-control:emergency-stop'
  const requestStop = event => {
    if (bar && !bar.isDestroyed() && event.sender === bar.webContents && event.senderFrame === bar.webContents.mainFrame) stop?.()
  }
  function ready(onStop) {
    stop = onStop
    if (preparing) return preparing
    // A failed preparation may overlap an older grant's native action. Only
    // the host knows when that action and its cleanup have finished.
    preparing = prepare().finally(() => { preparing = null })
    return preparing
  }
  async function prepare() {
    if (!shortcut) {
      if (!globalShortcut.register(STOP_SHORTCUT, () => stop?.())) {
        throw new Error('The screen-control stop shortcut is unavailable. Screen access was not enabled.')
      }
      shortcut = STOP_SHORTCUT
    }
    if (bar && !bar.isDestroyed() && halo && !halo.isDestroyed()) return
    const options = { frame: false, transparent: true, resizable: false, skipTaskbar: true,
      show: false, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }
    ipcMain.removeListener(stopChannel, requestStop)
    ipcMain.on(stopChannel, requestStop)
    bar = new BrowserWindow({ ...options, width: 360, height: 72, focusable: false,
      webPreferences: { ...options.webPreferences, preload: path.join(__dirname, 'screen-control-indicator-preload.cjs') } })
    halo = new BrowserWindow({ ...options, width: 76, height: 76, focusable: false })
    bar.setAlwaysOnTop(true, 'screen-saver'); halo.setAlwaysOnTop(true, 'screen-saver')
    halo.setIgnoreMouseEvents(true)
    for (const window of [bar, halo]) {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('render-process-gone', () => stop?.())
      window.on('closed', () => { clearInterval(timer); timer = null; stop?.() })
    }
    bar.webContents.on('will-navigate', event => event.preventDefault())
    await Promise.all([
      bar.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(barHtml)),
      halo.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(haloHtml)),
    ])
    /* barHtml ships a placeholder chord because the markup is a constant and
       the armed chord is not. Correct it before the window can ever paint --
       show() sets this again per action, but it does so without awaiting, so a
       first frame could otherwise name a chord this machine refused us. */
    await bar.webContents.executeJavaScript(
      `document.getElementById('detail').textContent=${JSON.stringify(shortcutLabel(shortcut) + ' · stop all agents')}`)
  }
  function show({ label, detail, agentId, action, moving = false }) {
    if (!bar || bar.isDestroyed() || !halo || halo.isDestroyed()) throw new Error('The screen-control indicator is unavailable.')
    const area = screen.getPrimaryDisplay().workArea
    bar.setPosition(Math.round(Math.max(area.x, area.x + area.width - 372)), Math.round(area.y + 12))
    const accent = agentAccent(agentId)
    // Name the chord that is actually armed. A fixed string would tell a person
    // to press something this machine never gave us, at the moment they most
    // need it to work.
    const description = (actionLabels[action] || detail || 'Has computer control') + ' · ' + shortcutLabel(shortcut)
    void bar.webContents.executeJavaScript(`document.getElementById('label').textContent=${JSON.stringify(String(label).slice(0, 100))};document.getElementById('detail').textContent=${JSON.stringify(description)};document.documentElement.style.setProperty('--accent',${JSON.stringify(accent)})`).catch(() => { stop?.() })
    void halo.webContents.executeJavaScript(`document.documentElement.style.setProperty('--accent',${JSON.stringify(accent)})`).catch(() => { stop?.() })
    if (action) {
      clearTimeout(effectTimer)
      void halo.webContents.executeJavaScript(`document.documentElement.dataset.action=${JSON.stringify(action)}`).catch(() => { stop?.() })
      // Keep brief click feedback visible after a fast native input returns.
      effectTimer = setTimeout(() => {
        if (halo && !halo.isDestroyed()) void halo.webContents.executeJavaScript('delete document.documentElement.dataset.action').catch(() => { stop?.() })
      }, 500)
      effectTimer.unref?.()
    }
    bar.showInactive()
    clearInterval(timer); timer = null
    if (moving) {
      const move = () => {
        try {
          const point = screen.getCursorScreenPoint(), bounds = bar.getBounds()
          // Keep the emergency control visible and directly clickable even on
          // window managers with imperfect transparent-window input handling.
          if (point.x >= bounds.x && point.x < bounds.x + bounds.width
              && point.y >= bounds.y && point.y < bounds.y + bounds.height) { if (halo.isVisible()) halo.hide(); return }
          // Keep the marker beside the hotspot. Some Linux window managers
          // ignore an input-transparent window's shape while it is moving.
          const display = screen.getDisplayNearestPoint(point).bounds
          const x = point.x + 88 < display.x + display.width ? point.x + 12 : point.x - 88
          const y = point.y + 88 < display.y + display.height ? point.y + 12 : point.y - 88
          const current = halo.getBounds()
          if (current.x !== x || current.y !== y) halo.setPosition(x, y)
          if (!halo.isVisible()) halo.showInactive()
        }
        catch { clearInterval(timer); timer = null; stop?.() }
      }
      move(); timer = setInterval(move, 16); timer.unref?.()
    } else halo.hide()
  }
  function hide() {
    clearInterval(timer); timer = null
    clearTimeout(effectTimer); effectTimer = null
    if (bar && !bar.isDestroyed()) bar.hide()
    if (halo && !halo.isDestroyed()) halo.hide()
  }
  function destroy() {
    hide()
    ipcMain.removeListener(stopChannel, requestStop)
    if (shortcut) globalShortcut.unregister(shortcut)
    shortcut = null
    if (bar && !bar.isDestroyed()) bar.destroy()
    if (halo && !halo.isDestroyed()) halo.destroy()
    bar = halo = null
  }
  // Only the host's confirmed-idle path may release desktop ownership.
  // stopShortcut() is the chord this process holds right now, or null when it
  // holds none; callers must not assume the first candidate was the one given.
  return { ready, show, hide, release: destroy, destroy, stopShortcut: () => shortcut }
}
module.exports = { createScreenControlIndicator, STOP_SHORTCUT }
