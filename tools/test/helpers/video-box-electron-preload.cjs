'use strict'
// The video channels of shell/fleet-profile-preload.cjs mcVideoBox, for tools/test/helpers/video-box-electron.cjs.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mcVideoBox', Object.freeze({
  sources: () => ipcRenderer.invoke('mc-video-box:sources'),
  arm: request => ipcRenderer.invoke('mc-video-box:arm', request),
  forget: request => ipcRenderer.invoke('mc-video-box:forget', request),
}))
