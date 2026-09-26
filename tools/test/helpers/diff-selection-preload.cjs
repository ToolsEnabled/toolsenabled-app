'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mcDiff', Object.freeze({
  readChange: filePath => ipcRenderer.invoke('fixture:read-change', { path: filePath }),
  pick: () => ipcRenderer.invoke('fixture:pick'),
}))
contextBridge.exposeInMainWorld('selectionInputs', Object.freeze({ read: () => ipcRenderer.invoke('fixture:inputs') }))
