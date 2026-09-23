import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { createRemoteComputerSettings } from '../../src/remote-computer-settings.js'
const require = createRequire(import.meta.url)
const { createRemoteWorkspaceClient, validRequest } = require('../../shell/remote-workspace-client.cjs')
const { installRemoteWorkspace } = require('../../shell/remote-workspace.cjs')
const selection = 'a'.repeat(32)
const state = () => ({ state: 'ready', expiresAtMs: Date.now() + 60000, peer: { id: 'peer-b', selection } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
function child() {
  const process = new EventEmitter()
  Object.assign(process, { connected: true, sent: [], send(packet) { this.sent.push(packet) },
    reply(packet, value) { this.emit('message', { type: 'fra:reply', id: packet.id, value }) } })
  return process
}
function attached(t) {
  const client = createRemoteWorkspaceClient(), process = child()
  client.attach(process); process.emit('message', { type: 'fra:state', value: state() })
  t.after(() => client.detach())
  return { client, process }
}
test('main allowlist excludes dialogs, account credentials, arbitrary URLs and oversized requests', () => {
  assert.equal(validRequest('org:ensure-seat', { id: 'check' }), true)
  for (const operation of ['agent:pick-attachment', 'agent:profile-create', 'bridge:dispatch', 'account:sign-in', 'https://bad.invalid',
    'workspace:snapshot', 'bridge:workspace', 'host:read_file', 'repo:read_file']) {
    assert.equal(validRequest(operation, {}), false)
  }
  assert.equal(validRequest('agent:send', { sessionId: 'owned-session', text: 'Continue this conversation' }), true)
  assert.equal(validRequest('agent:send', { text: 'x'.repeat(65536) }), false)
  assert.equal(validRequest('org:read', []), false)
})
test('main client sends only to its selected child and projects a bounded reply', async t => {
  const { client, process } = attached(t)
  const pending = client.request(selection, 'agent:remote-status')
  const packet = process.sent[0]
  assert.deepEqual(Object.keys(packet).sort(), ['id', 'operation', 'params', 'selection', 'type'])
  process.reply(packet, { ok: true, selection, status: 200, value: { ok: true, mayWrite: false }, secret: 'not-forwarded' })
  assert.deepEqual(await pending, { ok: true, status: 200, value: { ok: true, mayWrite: false } })
  assert.equal((await client.request('b'.repeat(32), 'org:read')).outcome, 'not-sent')
  assert.equal(process.sent.length, 1)
})
test('child death, replacement and stale successful replies leave writes unknown without retransmission', async t => {
  for (const action of ['detach', 'replace', 'peer-change']) {
    const { client, process } = attached(t)
    const pending = client.request(selection, 'org:ensure-seat', { id: 'check' })
    const old = process.sent[0]
    if (action === 'detach') client.detach()
    if (action === 'replace') client.attach(child())
    if (action === 'peer-change') process.emit('message', { type: 'fra:state', value: { ...state(), peer: { id: 'peer-c', selection: 'b'.repeat(32) } } })
    process.reply(old, { ok: true, selection, status: 200, value: { ok: true } })
    assert.equal((await pending).outcome, 'unknown', action)
    assert.equal(process.sent.length, 1)
  }
})
test('deadline reports an unknown write; invalid/expired descriptors grant no authority', async () => {
  let deadline
  const client = createRemoteWorkspaceClient({ setTimeout: fn => { deadline = fn; return 1 }, clearTimeout: () => {} })
  const process = child(); client.attach(process); process.emit('message', { type: 'fra:state', value: state() })
  const pending = client.request(selection, 'org:ensure-seat', {})
  deadline()
  assert.deepEqual(await pending, { ok: false, code: 'REMOTE_OUTCOME_UNKNOWN', outcome: 'unknown' })
  for (const value of [null, { ...state(), expiresAtMs: Date.now() - 1 }, { ...state(), peer: { id: '../bad', selection } }]) {
    process.emit('message', { type: 'fra:state', value })
    assert.deepEqual(client.snapshot(), { state: 'unavailable', peer: null })
    assert.equal((await client.request(selection, 'org:read')).outcome, 'not-sent')
  }
  assert.equal(process.sent.length, 1); client.detach()
})
function manager(t) {
  const handlers = new Map(), windows = [], requests = []
  let identity = 'account-a:session-a', current = state(), listener, loading = null
  const client = { snapshot: () => current, status: async () => current, subscribe: fn => { listener = fn },
    request: async (...args) => { requests.push(args); return { ok: true, status: 200, value: { ok: true, facade: 'ready', mayWrite: false } } } }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.webContents = new EventEmitter()
      Object.assign(this.webContents, { mainFrame: { url: 'http://127.0.0.1:4600/' }, send: () => {},
        setWindowOpenHandler: fn => { this.newWindow = fn },
        session: { setPermissionRequestHandler: fn => { this.permission = fn }, setPermissionCheckHandler: fn => { this.permissionCheck = fn },
          webRequest: { onBeforeRequest: fn => { this.network = fn } } } })
      windows.push(this)
    }
    setMenuBarVisibility() {} focus() {} isDestroyed() { return this.dead }
    destroy() { this.dead = true; this.emit('closed') }
    async loadURL(url) { this.url = url; if (loading) await loading; this.webContents.emit('did-finish-load') }
  }
  const owner = { sender: new EventEmitter(), senderFrame: {} }
  const installed = installRemoteWorkspace({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: Window,
    client, owns: event => event === owner, origin: () => 'http://127.0.0.1:4600', identity: () => identity, enrolled: () => true })
  t.after(() => installed.close())
  return { handlers, windows, requests, client, owner,
    open: (request = { selection, consent: true }) => handlers.get('mc-remote:open')(owner, request),
    event: window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }),
    holdLoad: promise => { loading = promise }, identity: value => { identity = value }, replace: value => { current = value; listener(value) } }
}
test('opening requires local owner, exact peer, explicit consent and isolated sandbox', async t => {
  const f = manager(t)
  assert.equal((await f.handlers.get('mc-remote:open')({}, { selection, consent: true })).ok, false)
  assert.equal((await f.open({ selection, consent: false })).ok, false)
  assert.equal((await f.open({ selection: 'b'.repeat(32), consent: true })).ok, false)
  assert.equal(f.windows.length, 0)
  assert.deepEqual(await f.open(), { ok: true })
  const window = f.windows[0], prefs = window.options.webPreferences
  assert.equal(window.url, 'http://127.0.0.1:4600/#/computers')
  assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true)
  assert.ok(!prefs.partition.startsWith('persist:')); assert.match(prefs.preload, /remote-workspace-preload\.cjs$/)
  assert.deepEqual(window.newWindow(), { action: 'deny' }); assert.equal(window.permissionCheck(), false)
})
test('consent cannot move to a different account or owner document while status is pending', async t => {
  for (const change of ['account', 'document']) {
    const f = manager(t), pendingStatus = deferred()
    f.client.status = () => pendingStatus.promise
    const open = f.open()
    if (change === 'account') f.identity('account-b:session-b')
    else f.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    pendingStatus.resolve(state())
    assert.equal((await open).ok, false, change)
    assert.equal(f.windows.length, 0, change)
  }
})
test('renderer may load bundled assets but no local projections, remote origins or mutations', async t => {
  const f = manager(t); await f.open(); const window = f.windows[0]
  for (const [url, method, expected] of [
    ['http://127.0.0.1:4600/assets/index-test.js', 'GET', false], ['http://127.0.0.1:4600/data/fleet.json', 'GET', true],
    ['http://127.0.0.1:4601/', 'GET', true], ['http://127.0.0.1:4600/assets/index.js?x=1', 'GET', true],
    ['https://toolsenabled.ai/v1/sessions', 'GET', true], ['http://127.0.0.1:4600/', 'POST', true],
  ]) { let answer; window.network({ url, method }, value => { answer = value }); assert.equal(answer.cancel, expected, url) }
})
test('invoke/result reject foreign frames and changed account or paired connection', async t => {
  const f = manager(t); await f.open(); const window = f.windows[0], event = f.event(window), invoke = f.handlers.get('mc-remote:request')
  assert.equal((await invoke({ ...event, senderFrame: { url: event.senderFrame.url } }, { operation: 'org:read', params: {} })).ok, false)
  assert.equal((await invoke(event, { operation: 'org:read', params: {} })).ok, true)
  const response = deferred(); f.client.request = () => response.promise
  const pending = invoke(event, { operation: 'org:ensure-seat', params: {} })
  f.identity('account-b:session-b'); response.resolve({ ok: true, status: 200, value: { ok: true } })
  assert.equal((await pending).outcome, 'unknown'); assert.equal(window.dead, true)
  const second = manager(t); await second.open(); second.replace({ ...state(), peer: { id: 'peer-c', selection: 'b'.repeat(32) } })
  assert.equal(second.windows[0].dead, true)
})
test('full navigation destroys remote authority while hash routing remains usable', async t => {
  const f = manager(t); await f.open(); const window = f.windows[0]
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }); assert.equal(window.dead, false)
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); assert.equal(window.dead, true)
  const next = manager(t); await next.open(); const other = next.windows[0]; let prevented = false
  other.webContents.emit('will-navigate', { url: 'https://attacker.invalid/', preventDefault: () => { prevented = true } })
  assert.equal(prevented, true); assert.equal(other.dead, true)
})
test('owner document replacement invalidates an existing viewer and one still loading', async t => {
  const f = manager(t); await f.open(); const window = f.windows[0]
  f.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  const answer = await f.handlers.get('mc-remote:request')(f.event(window), { operation: 'org:read', params: {} })
  assert.equal(answer.ok, false); assert.equal(window.dead, true)
  const other = manager(t), loading = deferred(); other.holdLoad(loading.promise)
  const open = other.open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(other.windows.length, 1)
  other.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  loading.resolve()
  assert.equal((await open).ok, false); assert.equal(other.windows[0].dead, true)
})
test('a second full remote navigation cannot replace the initial document while loading', async t => {
  const f = manager(t), loading = deferred(); f.holdLoad(loading.promise)
  const open = f.open(); await new Promise(resolve => setImmediate(resolve))
  const window = f.windows[0]
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(window.dead, false)
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(window.dead, true)
  loading.resolve(); assert.equal((await open).ok, false)
})
test('actual remote preload has existing agent/org controls, no local authority and no bridge fallback', async () => {
  const globals = {}, invoked = []
  vm.runInNewContext(fs.readFileSync(new URL('../../shell/remote-workspace-preload.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { globals[name] = value } },
      ipcRenderer: { invoke: async (channel, value) => { invoked.push({ channel, value }); return { ok: true, status: 200, value: { ok: true } } }, on: () => {} } } },
    window: { addEventListener: () => {} }, setTimeout, clearTimeout,
  })
  assert.deepEqual(Object.keys(globals).sort(), ['mcAgent', 'mcOrg', 'mcShell'])
  for (const name of ['getBridgeProof', 'deviceClaim', 'remoteWorkspace']) assert.equal(globals.mcShell[name], undefined)
  assert.equal(globals.mcAgent.pickAttachment, undefined); assert.equal(globals.mcAgent.profileCreate, undefined)
  await globals.mcOrg.ensureSeat({ id: 'owned-check', role: 'worker', provider: 'none' }); await globals.mcOrg.releaseSeat({ id: 'owned-check' })
  assert.equal(invoked[0].value.operation, 'org:ensure-seat'); assert.equal(invoked[1].value.operation, 'org:release-seat')
  await globals.mcAgent.send({ sessionId: 's', text: 'hello', images: [{ path: '/private' }] })
  assert.equal(Object.hasOwn(invoked[2].value.params, 'images'), false)
  const transport = await globals.mcShell.getBridgeTransport(); assert.equal(typeof transport, 'function')
  assert.equal((await transport('/v1/runtime', { method: 'GET' })).ok, true)
  assert.equal((await transport('/v1/dispatch', { method: 'POST', body: {} })).ok, false); assert.equal(invoked.length, 4)
})
test('native connection panel requires its exact host bridge and starts without action consent', () => {
  assert.equal(createRemoteComputerSettings({ shell: {} }).markup(), '')
  const controller = createRemoteComputerSettings({ shell: { remoteWorkspace: { status() {}, inspect() {}, open() {} } } })
  const html = controller.markup(); assert.match(html, /Open remote workspace/); assert.match(html, /data-remote-consent/)
  assert.match(html, /data-remote-action="open" disabled/); controller.destroy()
})
