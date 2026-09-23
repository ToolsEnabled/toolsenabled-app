'use strict'
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createScreenControlHost } = require('../../../shell/screen-control-host.cjs')
const { createScreenControlAdapter } = require('../../../shell/screen-control-adapter.cjs')
const { createScreenControlIndicator } = require('../../../shell/screen-control-indicator.cjs')
const [dataRoot, url] = process.argv.slice(2)
if (!dataRoot || !path.isAbsolute(dataRoot) || new URL(url).hostname !== '127.0.0.1') throw new Error('An isolated profile and loopback fixture URL are required')
app.setPath('userData', dataRoot)
app.commandLine.appendSwitch('disable-gpu')
let window, indicator, host
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const pendingHostCalls = new Set(), hostFailures = []
async function observed(label, predicate, { timeoutMs = 10000, checkHostFailures = true } = {}) {
  console.error('screen-control-ui: observing ' + label)
  const deadline = performance.now() + timeoutMs
  do {
    if (checkHostFailures && hostFailures.length) throw hostFailures[0]
    if (await predicate()) return
    assert.ok(performance.now() < deadline, `Timed out observing ${label}`)
    await wait(20)
  } while (true)
}
async function painted(contents) {
  let timer
  try {
    await Promise.race([
      contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The fixture renderer did not paint a fresh frame')), 8000) }),
    ])
  } finally { clearTimeout(timer) }
}
async function run() {
  const preload = path.join(dataRoot, 'control-preload.cjs')
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');let deliveredEvents=0;
    contextBridge.exposeInMainWorld('screenControlFixture',{deliveredEvents:()=>deliveredEvents});
    contextBridge.exposeInMainWorld('mcScreenControl',{status:()=>ipcRenderer.invoke('fixture:status'),grant:v=>ipcRenderer.invoke('fixture:grant',v),revoke:v=>ipcRenderer.invoke('fixture:revoke',v),onEvent:fn=>{const cb=(_,v)=>{fn(v);deliveredEvents++};ipcRenderer.on('fixture:event',cb);return()=>ipcRenderer.removeListener('fixture:event',cb)}});
    contextBridge.exposeInMainWorld('mcVoice',{targets:()=>ipcRenderer.invoke('fixture:targets')});`)
  await app.whenReady()
  window = new BrowserWindow({ x: 0, y: 0, width: 1200, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload } })
  const owner = window.webContents
  const names = ['Aster · Research', 'Milo · Build', 'Nova · Review', 'Read-only helper']
  const sessions = new Map(names.map((agentId, index) => ['s' + index, { agentId, owner, ownerKind: 'window', state: 'running' }]))
  indicator = createScreenControlIndicator({ BrowserWindow, screen, globalShortcut, ipcMain })
  host = createScreenControlHost({ sessions, permissionLevel: () => 'unrestricted',
    readBinding: agentId => ({ enabled: true, roleId: 'test-worker', revision: 1, functions: agentId === names[3] ? [] : null }),
    adapter: createScreenControlAdapter({ screen, desktopCapturer }), indicator, audit: async () => {},
    emit: (bound, value) => { if (!bound.isDestroyed()) bound.send('fixture:event', value) } })
  for (const [channel, command] of [['status', 'state'], ['grant', 'grant'], ['revoke', 'revoke']]) ipcMain.handle('fixture:' + channel, async (event, value) => {
    assert.equal(event.sender, owner); assert.equal(event.senderFrame, owner.mainFrame)
    const operation = Promise.resolve().then(() => host[command](owner, value))
    pendingHostCalls.add(operation)
    try { return await operation }
    catch (error) { hostFailures.push(error); throw error }
    finally { pendingHostCalls.delete(operation) }
  })
  ipcMain.handle('fixture:targets', () => [...sessions].map(([sessionId, value]) => ({ sessionId, agentId: value.agentId })))
  const principal = index => ({ kind: 'agent-session', sessionId: 's' + index, agentId: names[index], roleId: 'test-worker', expectedRoleRevision: 1 })
  console.error('screen-control-ui: loading Settings fixture')
  await window.loadURL(url)
  const js = source => owner.executeJavaScript(source)
  await observed('the actual Settings route and agent roster', async () => {
    const error = await js('window.fixtureError || null')
    assert.equal(error, null, error)
    return js('Boolean(window.fixtureReady && document.querySelectorAll("[data-agent-session]").length === 4)')
  }, { timeoutMs: 20000 })
  assert.equal(await js('Boolean(window.fixtureReady)'), true, 'mount the real Settings view: ' + await js('window.fixtureError || document.title'))
  assert.equal(await js('document.querySelectorAll("[data-agent-session]").length'), 4)
  assert.equal(await js('document.querySelector("[data-agent-session=s3] input").disabled'), true)
  await js('document.querySelector("[data-agent-session=s0] input").click()')
  assert.equal(host.state(owner).grants.length, 0, 'selecting never enables access')
  await js('document.querySelector("[data-control-grant]").click()')
  // Grant awaits the real indicator/emergency-stop readiness and audit. A UI
  // click returning does not mean its IPC promise or the renderer has settled.
  await observed('the selected host grant and settled visible controls', async () =>
    pendingHostCalls.size === 0 && host.state(owner).grants.map(value => value.sessionId).join(',') === 's0'
    && await js('document.querySelector("[data-agent-session=s0]").dataset.allowed === "true" && document.querySelector("[data-control-badge]").textContent === "Ready" && !document.querySelector("[data-control-grant]").disabled'))
  assert.deepEqual(host.state(owner).grants.map(value => value.sessionId), ['s0'])
  const images = {}
  async function capture(name) {
    console.error('screen-control-ui: capturing ' + name)
    await painted(owner)
    const file = path.join(dataRoot, name + '.png')
    fs.writeFileSync(file, (await owner.capturePage()).toPNG()); images[name] = file
  }
  await capture('settings-control-light')
  await js('document.documentElement.dataset.theme="black"')
  await capture('settings-control-dark')
  await js('delete document.documentElement.dataset.theme; document.querySelector("input[value=any-running]").click(); document.querySelector("[data-control-grant]").click()')
  await observed('all eligible running agents granted in the host and visible UI', async () => {
    const state = host.state(owner)
    return pendingHostCalls.size === 0 && state.mode === 'any-running' && state.grants.map(value => value.sessionId).sort().join(',') === 's0,s1,s2'
      && await js('document.querySelector("input[value=any-running]").checked && !document.querySelector("input[value=any-running]").disabled && document.querySelectorAll("[data-agent-session][data-allowed=true]").length === 3')
  })
  assert.equal(host.state(owner).mode, 'any-running'); assert.equal(host.state(owner).grants.length, 3)
  await host.control(principal(0), { action: 'acquire' })
  await observed('the visible acquired turn', async () => host.state(owner).holderSessionId === 's0' && await js('document.querySelector("[data-control-badge]").textContent === "In use"'))
  assert.equal(await js('document.querySelector("[data-control-badge]").textContent'), 'In use')
  assert.throws(() => host.control(principal(1), { action: 'acquire' }), { code: 'SCREEN_BUSY' })
  await capture('settings-control-active')
  const bar = BrowserWindow.getAllWindows().find(value => value.getBounds().width === 360)
  const halo = BrowserWindow.getAllWindows().find(value => value.getBounds().width === 76)
  assert.equal(bar.isVisible(), true); assert.equal(halo.isVisible(), true)
  indicator.show({ label: names[0], agentId: names[0], action: 'click', moving: true })
  await observed('the named indicator and pointer feedback', async () =>
    await bar.webContents.executeJavaScript(`document.getElementById("label").textContent === ${JSON.stringify(names[0])}`)
    && await halo.webContents.executeJavaScript('document.documentElement.dataset.action === "click"'))
  for (const [name, target] of [['control-bar', bar], ['control-pointer', halo]]) {
    const file = path.join(dataRoot, name + '.png'); fs.writeFileSync(file, (await target.webContents.capturePage()).toPNG()); images[name] = file
  }
  halo.webContents.debugger.attach('1.3')
  await halo.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await halo.webContents.executeJavaScript('getComputedStyle(document.querySelector(".ripple")).animationName'), 'none')
  halo.webContents.debugger.detach()
  await host.control(principal(0), { action: 'release' })
  await host.control(principal(1), { action: 'acquire' })
  await observed('the next holder in the host and indicator', async () => host.state(owner).holderSessionId === 's1'
    && await bar.webContents.executeJavaScript(`document.getElementById("label").textContent === ${JSON.stringify(names[1])}`))
  assert.equal(await bar.webContents.executeJavaScript('document.getElementById("label").textContent'), names[1])
  /* Read the chord the indicator actually armed. Asserting a hard-coded
     'Control+Alt+Escape' went vacuous the moment the platform could hand back a
     different one -- and on Windows it always does, because the shell owns that
     chord. Captured before Stop all, because after the release there is nothing
     left to name. */
  const armed = indicator.stopShortcut()
  assert.ok(typeof armed === 'string' && armed.length > 0, 'a grant must hold a real stop chord, not an assumed one')
  assert.equal(globalShortcut.isRegistered(armed), true, 'the reported stop chord must be the one this process holds')
  await js('document.querySelector("[data-control-stop]").click()')
  // The current host releases its desktop lease on Stop all. That destroys
  // both indicator windows and unregisters the emergency shortcut; querying
  // visibility on the retired window throws instead of observing that cleanup.
  await observed('Stop all releases desktop custody and settles visible controls', async () => pendingHostCalls.size === 0
    && host.state(owner).grants.length === 0 && bar.isDestroyed() && halo.isDestroyed()
    && !globalShortcut.isRegistered(armed)
    && await js('document.querySelector("[data-control-badge]").textContent === "Off" && !document.querySelector("input[value=selected]").disabled'))
  assert.equal(host.state(owner).grants.length, 0)
  assert.equal(bar.isDestroyed(), true); assert.equal(halo.isDestroyed(), true)
  assert.equal(globalShortcut.isRegistered(armed), false)
  assert.equal(indicator.stopShortcut(), null, 'a released lease may not keep naming a chord it no longer holds')
  // Draft search/checkbox focus survives live host events without rebuilding rows.
  await js('document.querySelector("input[value=selected]").click(); const input=document.querySelector("[data-control-search]"); input.value="Nova"; input.dispatchEvent(new Event("input")); input.focus()')
  const eventsBefore = await js('window.screenControlFixture.deliveredEvents()')
  owner.send('fixture:event', host.state(owner))
  await observed('the host event delivered to the mounted surface', () => js(`window.screenControlFixture.deliveredEvents() > ${eventsBefore}`))
  assert.equal(await js('document.activeElement.matches("[data-control-search]")'), true)
  assert.equal(await js('[...document.querySelectorAll("[data-agent-session]")].filter(row=>!row.hidden).length'), 1)
  window.setSize(420, 900)
  await capture('settings-control-narrow')
  assert.equal(await js('document.querySelector(".screen-access-controls").scrollWidth <= document.querySelector(".screen-access-controls").clientWidth'), true)
  await js('window.settingsFixture.destroy()')
  const duplicate = await js(`(async()=>{ const {createScreenAccessControls}=await import('/src/screen-access-controls.js'); const first=createScreenAccessControls(),second=createScreenAccessControls();document.body.append(first.el,second.el);await Promise.all([first.refresh(),second.refresh()]);const distinct=first.el.querySelector('input[type=radio]').name!==second.el.querySelector('input[type=radio]').name;first.destroy();second.destroy();return distinct})()`)
  assert.equal(duplicate, true, 'multiple mounted surfaces never share a radio group')
  console.log(JSON.stringify({ ok: true, images, checks: ['actual Settings route', 'selection is not consent', 'selected grants', 'all eligible running agents', 'exclusive turn', 'release and handoff', 'live named indicator', 'Stop all', 'reduced motion', 'search focus survives events', 'narrow layout', 'independent radio groups'] }))
}
async function cleanup(code) {
  // Do not destroy the owner underneath a still-pending grant and replace the
  // original assertion failure with a teardown-created SCREEN_ACCESS_CHANGED.
  try { await observed('pending fixture host calls to settle before cleanup', () => pendingHostCalls.size === 0, { checkHostFailures: false }) }
  catch (error) { console.error(error); code = 1 }
  host?.revokeAll(); indicator?.destroy(); window?.destroy(); app.exit(code)
}
run().then(() => cleanup(0)).catch(error => { console.error(error); cleanup(1) })
