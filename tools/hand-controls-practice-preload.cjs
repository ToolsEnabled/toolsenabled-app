const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mcHandControls', Object.freeze({
  setEnabled: enabled => ipcRenderer.invoke('hand-practice:enabled', enabled),
}))
