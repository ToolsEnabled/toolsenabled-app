'use strict'

const path = require('node:path')
const crypto = require('node:crypto')
const { validRequest } = require('./remote-workspace-client.cjs')

const refused = (code = 'REMOTE_CONNECTION_CHANGED', outcome = 'not-sent') => ({ ok: false, code, outcome })

// This window is deliberately not the application's local `win`. All existing
// native IPC therefore continues to reject it, even though its assets are local.
function installRemoteWorkspace({ ipcMain, BrowserWindow, client, owns, origin, identity, enrolled }) {
  const records = new Set()
  const ownerEpochs = new WeakMap()
  function identityNow() { try { return identity() } catch { return null } }
  function captureOwner(event) {
    if (!owns(event) || !enrolled() || !event.sender || !event.senderFrame) return null
    let document = ownerEpochs.get(event.sender)
    if (!document) {
      document = { epoch: 0 }
      ownerEpochs.set(event.sender, document)
      event.sender.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
        const main = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame
        const same = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace
        if (main === true && same !== true) document.epoch += 1
      })
    }
    const captured = identityNow()
    return captured === null ? null : { event, document, epoch: document.epoch, identity: captured }
  }
  function sameOwner(ticket) {
    return ticket && owns(ticket.event) && enrolled() && ticket.document.epoch === ticket.epoch
      && identityNow() === ticket.identity
  }
  function stillBound(record) {
    const state = client.snapshot()
    return !record.closed && sameOwner(record.ownerTicket) && enrolled() === true && identityNow() === record.identity
      && state.peer?.id === record.peer.id && state.peer?.selection === record.peer.selection
  }
  function invalidate(record) {
    if (record.closed) return
    record.closed = true
    clearInterval(record.timer)
    records.delete(record)
    if (!record.window.isDestroyed()) record.window.destroy()
  }
  function validate(event) {
    const record = [...records].find(item => item.contents === event.sender)
    if (!record || event.senderFrame !== record.contents.mainFrame) return null
    if (!stillBound(record)) {
      if (record) invalidate(record)
      return null
    }
    try {
      const url = new URL(event.senderFrame.url)
      if (url.origin !== record.origin || url.pathname !== '/' || url.search !== '') return null
    } catch { return null }
    return record
  }
  client.subscribe(state => {
    for (const record of [...records]) {
      if (!stillBound(record)) invalidate(record)
      else record.contents.send('mc-remote:state', { state: state.state })
    }
  })
  ipcMain.handle('mc-remote:status', async event => {
    const ticket = captureOwner(event)
    if (!ticket) return { state: 'unavailable', peer: null }
    const answer = await client.status()
    return sameOwner(ticket) ? answer : { state: 'unavailable', peer: null }
  })
  ipcMain.handle('mc-remote:inspect', async (event, selection) => {
    const ticket = captureOwner(event)
    if (!ticket) return refused()
    const answer = await client.request(selection, 'agent:remote-status', {})
    if (!sameOwner(ticket)) return refused('REMOTE_OUTCOME_UNKNOWN', 'unavailable')
    return answer
  })
  ipcMain.handle('mc-remote:open', async (event, request) => {
    const ticket = captureOwner(event)
    if (!ticket || request?.consent !== true
      || typeof request?.selection !== 'string' || Object.keys(request).some(key => !['selection', 'consent'].includes(key))) return refused()
    const state = await client.status()
    if (!sameOwner(ticket) || state.peer?.selection !== request.selection) return refused()
    const ownerIdentity = ticket.identity
    const status = await client.request(request.selection, 'agent:remote-status', {})
    if (!sameOwner(ticket)
      || client.snapshot().peer?.selection !== request.selection) return refused()
    if (status.ok !== true || status.status !== 200 || status.value?.ok !== true || status.value?.facade !== 'ready') {
      return status.ok === false ? status : refused('REMOTE_NOT_READY')
    }
    for (const record of records) {
      if (stillBound(record) && record.peer.selection === request.selection) { record.window.focus(); return { ok: true } }
    }
    const site = origin()
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(site || '')) return refused('REMOTE_NOT_READY')
    const window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 760, minHeight: 560,
      title: `ToolsEnabled — paired computer ${state.peer.id.slice(0, 8)}`,
      webPreferences: {
        preload: path.join(__dirname, 'remote-workspace-preload.cjs'),
        partition: `remote-workspace-${crypto.randomBytes(16).toString('hex')}`,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false,
      },
    })
    const contents = window.webContents
    const record = { window, contents, peer: { ...state.peer }, ownerTicket: ticket, identity: ownerIdentity, origin: site, loaded: false, navigationStarted: false, closed: false, timer: null }
    records.add(record)
    window.setMenuBarVisibility(false)
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    // Independent memory partition: never inherit local projection capabilities,
    // cookies, durable preferences, account sessions or media permissions.
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      let allow = false
      try {
        const url = new URL(details.url)
        allow = details.method === 'GET' && url.origin === site && url.search === ''
          && (url.pathname === '/' || /^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname))
      } catch {}
      callback({ cancel: !allow })
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-navigate', (event, target) => {
      const address = typeof event.url === 'string' ? event.url : target
      let same = false
      try { const url = new URL(address); same = url.origin === site && url.pathname === '/' && url.search === '' } catch {}
      if (!same) { event.preventDefault(); invalidate(record) }
    })
    contents.on('will-redirect', event => { event.preventDefault(); invalidate(record) })
    contents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const main = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame
      const inPlace = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace
      if (main === true && inPlace !== true) {
        if (record.loaded || record.navigationStarted) invalidate(record)
        else record.navigationStarted = true
      }
    })
    contents.once('did-finish-load', () => { record.loaded = true })
    contents.once('render-process-gone', () => invalidate(record))
    window.once('closed', () => { record.closed = true; clearInterval(record.timer); records.delete(record) })
    record.timer = setInterval(() => { if (!stillBound(record)) invalidate(record) }, 1000)
    try { await window.loadURL(`${site}/#/computers`) } catch {
      invalidate(record); return refused('REMOTE_NOT_READY')
    }
    if (!stillBound(record)) { invalidate(record); return refused() }
    return { ok: true }
  })
  ipcMain.handle('mc-remote:context', event => {
    const record = validate(event)
    return record ? { ok: true, peerId: record.peer.id } : refused()
  })
  ipcMain.handle('mc-remote:request', async (event, request) => {
    const record = validate(event)
    if (!record || !request || Object.keys(request).some(key => !['operation', 'params'].includes(key))
      || !validRequest(request.operation, request.params)) return refused('REMOTE_REQUEST_REFUSED')
    const answer = await client.request(record.peer.selection, request.operation, request.params)
    if (!validate(event) || !stillBound(record)) return refused('REMOTE_OUTCOME_UNKNOWN', 'unknown')
    return answer
  })
  return { close() { for (const record of [...records]) invalidate(record) } }
}

module.exports = { installRemoteWorkspace }
