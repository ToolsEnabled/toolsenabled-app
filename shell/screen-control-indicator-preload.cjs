'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('stopScreenControl', () => ipcRenderer.send('mc-screen-control:emergency-stop'))
