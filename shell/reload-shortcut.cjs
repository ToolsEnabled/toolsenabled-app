'use strict'

/* T1584: Electron's before-input-event owns the reload accelerator. It has no
 * synchronous DOM-focus information, so the safe boundary behavior is to
 * cancel Ctrl/Cmd+R before it can reload and leave draft-bearing renderers
 * intact. F12 remains the shell's developer-tools accelerator; other keys are
 * passed through unchanged. */

function isReloadShortcut(input) {
  if (!input || input.type !== 'keyDown' || !(input.control || input.meta)) return false
  return String(input.key || '').toLowerCase() === 'r'
}

function preventReloadShortcut(event, input) {
  if (!isReloadShortcut(input)) return false
  event.preventDefault()
  return true
}

/* Register the exact handler used by main.cjs so the accelerator policy is
 * testable without loading Electron. The callback deliberately has no reload
 * side effect: preventing the event is synchronous and works for text, image,
 * and uncertain focus states alike. */
function attachShellInputHandler(webContents, { toggleDevTools = () => {} } = {}) {
  const handler = (event, input) => {
    if (input?.type !== 'keyDown') return
    if (input.key === 'F12') { toggleDevTools(); event.preventDefault(); return }
    preventReloadShortcut(event, input)
  }
  webContents.on('before-input-event', handler)
  return handler
}

module.exports = { attachShellInputHandler, isReloadShortcut, preventReloadShortcut }
