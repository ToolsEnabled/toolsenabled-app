'use strict'

// Read-only evidence for this exact owner window. No environment, credentials,
// caller paths or execution controls cross this surface. In particular it is
// not a main-process debugger used to bypass the packaged inspector fuse.
function createRuntimeIdentityReader({ app, runtime, windowForSender, trustedSender, shellOrigin }) {
  if (!app || !runtime || typeof windowForSender !== 'function'
      || typeof trustedSender !== 'function' || typeof shellOrigin !== 'function') {
    throw new TypeError('Runtime identity dependencies are incomplete')
  }
  return function runtimeIdentity(event, ...arguments_) {
    const refused = code => Object.freeze({ ok: false, code })
    if (arguments_.length) return refused('RUNTIME_IDENTITY_ARGUMENTS_REFUSED')
    try {
      const sender = event?.sender
      if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame
          || trustedSender(event) !== true) return refused('RUNTIME_IDENTITY_SENDER_REFUSED')
      const window = windowForSender(sender)
      if (!window || window.isDestroyed() || window.webContents !== sender) {
        return refused('RUNTIME_IDENTITY_SENDER_REFUSED')
      }
      const preferences = sender.getLastWebPreferences()
      if (!preferences) return refused('RUNTIME_IDENTITY_UNAVAILABLE')
      const value = {
        ok: true, isPackaged: app.isPackaged === true,
        platform: runtime.platform, pid: runtime.pid,
        execPath: runtime.execPath, resourcesPath: runtime.resourcesPath,
        appPath: app.getAppPath(), userData: app.getPath('userData'),
        version: app.getVersion(), shellOrigin: shellOrigin(),
        noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
        window: Object.freeze({ url: sender.getURL(), visible: window.isVisible(),
          sandbox: preferences.sandbox === true,
          contextIsolation: preferences.contextIsolation === true,
          nodeIntegration: preferences.nodeIntegration === true }),
      }
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0
          || ['platform', 'execPath', 'resourcesPath', 'appPath', 'userData', 'version', 'shellOrigin']
            .some(key => typeof value[key] !== 'string' || !value[key])
          || sender.isDestroyed() || window.isDestroyed() || trustedSender(event) !== true
          || event.senderFrame !== sender.mainFrame) return refused('RUNTIME_IDENTITY_UNAVAILABLE')
      return Object.freeze(value)
    } catch { return refused('RUNTIME_IDENTITY_UNAVAILABLE') }
  }
}

module.exports = { createRuntimeIdentityReader }
