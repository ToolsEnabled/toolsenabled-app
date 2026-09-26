'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../../..')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || !fs.existsSync(data)) throw new Error('An existing isolated user-data directory is required.')
app.setPath('userData', data)
app.commandLine.appendSwitch('disable-gpu')
const { createAccessibilityHost } = require('../../../shell/accessibility-host.cjs')
const { createAccessibilityAppAdapter } = require('../../../shell/accessibility-app.cjs')
const { createVoiceHost } = require('../../../shell/voice-host.cjs')
const { createScreenControlHost } = require('../../../shell/screen-control-host.cjs')
const adapter = createAccessibilityAppAdapter({
  profileRoot: process.env.USERPROFILE,
  trustedOrigin: owner => {
    const origin = 'http://127.0.0.1:' + server.address().port
    return owner === win.webContents && new URL(owner.mainFrame.url).origin === origin ? origin : null
  },
})
const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><body>
      <section><button id="press" onclick="window.presses=(window.presses||0)+1">Test button</button>
      <input id="search" aria-label="Search notes" value="old private value">
      <select id="choice" aria-label="Display style"><option value="dark">Dark</option><option value="light">Light</option></select>
      <input type="password" aria-label="Password" value="fixture-only-secret">
      <button style="visibility:hidden">Invisible</button><button disabled>Disabled</button>
      <a href="https://example.invalid">External</a></section>
      <section class="board-roles-box"><button>Role editor control</button></section>
      </body></html>`)
    return
  }
  const file = path.resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname)
  if (!file.startsWith(root + path.sep) || path.extname(file) !== '.js') { response.writeHead(404); response.end(); return }
  response.setHeader('Content-Type', 'text/javascript')
  fs.createReadStream(file).on('error', () => { response.writeHead(404); response.end() }).pipe(response)
})
let win, host
const principal = { kind: 'agent-session', sessionId: 'fixture-session', agentId: 'custom-helper', roleId: 'custom-role', expectedRoleRevision: 1 }
async function evalUI(code) { return win.webContents.executeJavaScript(code, true) }
async function waitFor(expression) {
  for (let i = 0; i < 200; i++) {
    if (await evalUI(expression)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('UI did not reach: ' + expression)
}
async function main() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'accessibility-ui-preload.cjs') } })
  const owner = win.webContents
  const sessions = new Map([[principal.sessionId, { owner, ownerKind: 'window', agentId: principal.agentId }]])
  host = createAccessibilityHost({ sessions,
    readBinding: () => ({ enabled: true, roleId: principal.roleId, revision: 1, functions: ['accessibility.propose'] }),
    permissionLevel: () => 'unrestricted', isDirectUserTurn: () => true,
    planAction: (input, mode) => adapter.plan(input, mode), inspect: (_input, mode) => adapter.inspect(mode),
    audit: async () => {}, emit: (target, state) => target.send('accessibility-test:event', state),
  })
  for (const name of ['status', 'prepareEnable', 'confirm', 'reject', 'disable']) {
    ipcMain.handle('accessibility-test:' + name, (event, value) => {
      assert.equal(event.sender, owner)
      return host[name === 'status' ? 'state' : name](owner, value)
    })
  }
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
  await evalUI("(async()=>{ const {mountAccessibilityControls}=await import('/src/accessibility-controls.js'); window.panel=mountAccessibilityControls(); })()")
  assert.equal(await evalUI("document.querySelector('[data-accessibility-summary]')"), null, 'no global accessibility entry point')
  assert.equal(await evalUI("document.querySelector('[data-accessibility-pending]').hidden"), true)
  await evalUI("window.settingsSlot=document.createElement('section'); document.body.append(settingsSlot); panel.attach(settingsSlot)")
  await waitFor("document.querySelector('[data-accessibility-target]').options.length===2")
  assert.equal(await evalUI("document.querySelector('[data-accessibility-scope] option[value=desktop]').disabled"), process.platform !== 'win32')
  if (process.platform !== 'win32') assert.match(await evalUI("document.querySelector('[data-accessibility-scope-status]').textContent"), /only on Windows/)
  assert.equal(host.state(owner).enabled, false)
  await evalUI("document.querySelector('.accessibility-controls').open=true; const t=document.querySelector('[data-accessibility-target]');t.value='fixture-session';t.dispatchEvent(new Event('change'));document.querySelector('[data-accessibility-enable]').click()")
  await waitFor("!document.querySelector('[data-accessibility-pending]').hidden")
  assert.equal(host.state(owner).enabled, false)
  await evalUI("document.querySelector('[data-accessibility-confirm]').click()")
  await waitFor("document.querySelector('[data-accessibility-summary]').textContent.includes('ON')")
  await evalUI("panel.release(settingsSlot)")
  assert.equal(await evalUI("document.querySelector('[data-accessibility-summary]')"), null, 'entry point leaves with Settings')
  assert.equal(host.state(owner).enabled, true, 'leaving Settings keeps the host session enabled')
  let inspection = await host.inspect(principal, {})
  assert.deepEqual(inspection.controls.map(row => row.label), ['Test button', 'Search notes', 'Display style'])
  assert.ok(!JSON.stringify(inspection).includes('old private value'))
  assert.ok(!JSON.stringify(inspection).includes('fixture-only-secret'))
  const control = label => inspection.controls.find(row => row.label === label).id
  await host.propose(principal, { kind: 'click', targetId: control('Test button') })
  assert.equal(await evalUI('window.presses || 0'), 0)
  await waitFor("document.querySelector('[data-accessibility-preview]').textContent==='Press Test button'")
  assert.equal(await evalUI("document.querySelector('[data-accessibility-summary]')"), null, 'a pending action does not restore the global entry point')
  await evalUI("document.querySelector('[data-accessibility-confirm]').click()")
  await waitFor('window.presses===1')
  await waitFor("document.querySelector('[data-accessibility-pending]').hidden")
  inspection = await host.inspect(principal, {})
  const type = await host.propose(principal, { kind: 'type', targetId: control('Search notes'), text: 'new notes' })
  assert.equal(type.status, 'awaiting-user-confirmation')
  const request = host.state(owner).pending
  await host.confirm(owner, { requestId: request.requestId, code: request.confirmationCode })
  assert.equal(await evalUI("document.querySelector('#search').value"), 'new notes')
  inspection = await host.inspect(principal, {})
  await host.propose(principal, { kind: 'select', targetId: control('Display style'), value: 'light' })
  const select = host.state(owner).pending
  await host.confirm(owner, { requestId: select.requestId, code: select.confirmationCode })
  assert.equal(await evalUI("document.querySelector('#choice').value"), 'light')
  inspection = await host.inspect(principal, {})
  const stale = control('Test button')
  await evalUI("document.querySelector('#press').textContent='Changed target'")
  await host.propose(principal, { kind: 'click', targetId: stale })
  const changed = host.state(owner).pending
  await assert.rejects(host.confirm(owner, { requestId: changed.requestId, code: changed.confirmationCode }))
  assert.equal(await evalUI('window.presses'), 1)
  await adapter.navigate(owner, '/settings')
  assert.equal(new URL(owner.getURL()).hash, '#/settings')
  await assert.rejects(adapter.navigate(owner, 'https://example.invalid'))
  await evalUI("panel.attach(settingsSlot); window.nextSettingsSlot=document.createElement('section'); document.body.append(nextSettingsSlot); panel.attach(nextSettingsSlot); panel.release(settingsSlot)")
  assert.equal(await evalUI("document.querySelectorAll('[data-accessibility-summary]').length"), 1, 'retiring the previous view preserves exactly one panel in the new Settings view')
  await evalUI("document.querySelector('[data-accessibility-stop]').click()")
  await waitFor("document.querySelector('[data-accessibility-summary]').textContent.endsWith('off')")
  assert.equal(host.state(owner).enabled, false)
  await assert.rejects(host.inspect(principal, {}), { code: 'ACCESSIBILITY_OFF' })
  // Navigate after main has validated the target but before the queued script
  // runs. Use real Electron documents, including a replacement at the same URL.
  // No external server is contacted, and no navigation-event revocation is
  // installed here: the isolated-world guard must independently refuse.
  const trustedUrl = 'http://127.0.0.1:' + server.address().port + '/'
  const execute = owner.executeJavaScriptInIsolatedWorld.bind(owner)
  let documentSwapsRefused = 0
  for (const replacement of [trustedUrl, 'data:text/html,<html><body>Untrusted fixture</body></html>']) {
    await owner.loadURL(trustedUrl)
    adapter.invalidateDocument(owner)
    const mode = { owner, controller: new AbortController() }
    await adapter.inspect(mode)
    const action = adapter.plan({ kind: 'navigate', route: '/settings' }, mode)
    owner.executeJavaScriptInIsolatedWorld = async (...args) => {
      owner.executeJavaScriptInIsolatedWorld = execute
      await owner.loadURL(replacement)
      return execute(...args)
    }
    try {
      await assert.rejects(action.execute(mode.controller.signal), /document|trusted/i)
      assert.equal(new URL(owner.getURL()).hash, '')
      documentSwapsRefused++
    } finally { owner.executeJavaScriptInIsolatedWorld = execute }
  }
  // First-use navigation is valid without inspection. Its document binding is
  // lazy, so also exercise the combined production boundary, not just an
  // already-bound private world. Register the exact production handler body
  // on real WebContents; a voice host with no active contact cannot revoke it
  // on our behalf. No owner app, microphone, or account service is started.
  const mainSource = fs.readFileSync(path.join(root, 'shell/main.cjs'), 'utf8')
  const navigationStart = mainSource.indexOf("  window.webContents.on('did-start-navigation', details => {")
  const navigationEnd = mainSource.indexOf("  window.webContents.on('did-finish-load'", navigationStart)
  assert.ok(navigationStart >= 0 && navigationEnd > navigationStart)
  let voiceContactsEnded = 0
  const voiceHost = createVoiceHost({ sessions, emit: () => {}, onEnd: (_owner, id) => {
    voiceContactsEnded++
    host.revokeSession(id)
  } })
  assert.equal(voiceHost.allowsMicrophone(owner), false)
  let desktopLease = false
  const screenHost = createScreenControlHost({
    sessions,
    readBinding: () => ({ enabled: true, roleId: principal.roleId, revision: 1, functions: ['screen.control'] }),
    permissionLevel: () => 'unrestricted', adapter: { supported: () => true },
    indicator: { ready: async () => { desktopLease = true }, show() {}, hide() {},
      release() { desktopLease = false } }, audit: async () => {},
  })
  vm.runInNewContext(mainSource.slice(navigationStart, navigationEnd), {
    window: win, inputOwner: owner, accessibilityApp: adapter, accessibilityHost: host, voiceHost,
    screenControlHost: screenHost,
    handCameraOwners: new Set([owner]), treeNodeCommandBroker: { rendererReloaded: async () => {} },
  })
  let fullDocumentStarts = 0
  owner.on('did-start-navigation', details => {
    if (details.isMainFrame === true && details.isSameDocument !== true) fullDocumentStarts++
  })
  const consent = () => {
    const pending = host.state(owner).pending
    return { requestId: pending.requestId, code: pending.confirmationCode }
  }
  async function enableCurrentDocument() {
    host.prepareEnable(owner, { sessionId: principal.sessionId, scope: 'application' })
    assert.equal((await host.confirm(owner, consent())).status, 'enabled')
    await screenHost.grant(owner, { sessionIds: [principal.sessionId] })
    assert.equal(desktopLease, true)
  }
  let productionDocumentSwapsRefused = 0, reenabledHashNavigations = 0
  for (const scenario of ['first-bind-action', 'bound-action', 'first-bind-route']) {
    await owner.loadURL(trustedUrl)
    await enableCurrentDocument()
    if (scenario === 'bound-action') await host.inspect(principal, {})
    const directRoute = scenario === 'first-bind-route'
    if (!directRoute) await host.propose(principal, { kind: 'navigate', route: '/settings' })
    const confirmation = directRoute ? null : consent()
    const beforeNavigation = fullDocumentStarts
    owner.executeJavaScriptInIsolatedWorld = async (...args) => {
      owner.executeJavaScriptInIsolatedWorld = execute
      await owner.loadURL(trustedUrl)
      return execute(...args)
    }
    try {
      await assert.rejects(directRoute ? adapter.navigate(owner, '/settings') : host.confirm(owner, confirmation),
        /document|trusted|stopped/i, scenario)
      assert.ok(fullDocumentStarts > beforeNavigation, 'the real full-document navigation event fired')
      assert.equal(new URL(owner.getURL()).hash, '', scenario)
      assert.equal(host.state(owner).enabled, false, scenario)
      assert.equal(host.state(owner).pending, null, scenario)
      assert.equal(screenHost.state(owner).grants.length, 0, scenario)
      assert.equal(desktopLease, false, 'full document navigation releases its idle desktop reservation')
      assert.throws(() => screenHost.control(principal, { action: 'click' }), { code: 'SCREEN_ACCESS_OFF' })
      assert.equal(voiceContactsEnded, 0, 'navigation revocation did not depend on an active voice contact')
      productionDocumentSwapsRefused++
    } finally { owner.executeJavaScriptInIsolatedWorld = execute }

    // Revocation is document-scoped, not a blanket loss of supported controls.
    // Explicit consent in the replacement works, and its SPA hash navigation
    // remains the same document and must preserve that new control session.
    await enableCurrentDocument()
    const sameDocumentNavigation = new Promise(resolve => {
      function observe(details) {
        if (details.isMainFrame !== true || details.isSameDocument !== true) return
        owner.off('did-start-navigation', observe)
        resolve()
      }
      owner.on('did-start-navigation', observe)
    })
    await host.propose(principal, { kind: 'navigate', route: '/settings' })
    assert.equal((await host.confirm(owner, consent())).status, 'completed')
    await sameDocumentNavigation
    assert.equal(new URL(owner.getURL()).hash, '#/settings')
    assert.equal(screenHost.state(owner).grants.length, 1, 'same-document navigation preserves the current screen grant')
    assert.equal(desktopLease, true)
    assert.equal(host.state(owner).enabled, true)
    reenabledHashNavigations++
    host.close(owner)
  }
  voiceHost.close(owner)
  console.log(JSON.stringify({ ok: true, controls: 3, clicks: 1, typed: true, selected: true, staleRefused: true,
    stopped: true, documentSwapsRefused, productionDocumentSwapsRefused, reenabledHashNavigations }))
}
main().then(() => { host?.close(win.webContents); win.destroy(); server.close(); app.exit(0) }).catch(error => {
  console.error(error.stack || error); server.close(); app.exit(1)
})
