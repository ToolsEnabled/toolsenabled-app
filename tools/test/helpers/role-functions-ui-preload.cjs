'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// Only the organisation store is hosted by this isolated fixture. The full
// renderer sees a desktop, with no transport capable of starting an agent.
contextBridge.exposeInMainWorld('mcShell', {
  getBridgeProof: async () => ({ ok: false, reason: 'No agent transport in the role editor fixture.' }),
})
contextBridge.exposeInMainWorld('mcOrg', Object.fromEntries(
  ['read', 'createRole', 'editRole', 'resetRole'].map(name =>
    [name, value => ipcRenderer.invoke('role-functions-test:' + name, value)]),
))
