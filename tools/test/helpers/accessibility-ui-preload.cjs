'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mcVoice', { targets: () => Promise.resolve([{ sessionId: 'fixture-session', agentId: 'custom-helper' }]) })
contextBridge.exposeInMainWorld('mcAccessibility', Object.fromEntries([
  ...['status', 'prepareEnable', 'confirm', 'reject', 'disable'].map(name => [name, value => ipcRenderer.invoke('accessibility-test:' + name, value)]),
  ['onEvent', callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('accessibility-test:event', listener)
    return () => ipcRenderer.removeListener('accessibility-test:event', listener)
  }],
]))
