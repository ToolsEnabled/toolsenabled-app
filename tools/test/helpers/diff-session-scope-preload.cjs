const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mcDiff', Object.freeze({
  readChange: (filePath, context) => ipcRenderer.invoke('audit:read-change', { path: filePath, ...(context?.sessionId ? { sessionId: context.sessionId } : {}) }),
  pick: () => ipcRenderer.invoke('audit:pick'),
}))
contextBridge.exposeInMainWorld('auditInputs', Object.freeze({ read: () => ipcRenderer.invoke('audit:inputs') }))
