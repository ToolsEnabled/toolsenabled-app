import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')
const { createScreenControlAdapter } = require('../../shell/screen-control-adapter.cjs')
const { createScreenControlIndicator, STOP_SHORTCUT } = require('../../shell/screen-control-indicator.cjs')
const { createScreenControlQuitGuard } = require('../../shell/screen-control-quit.cjs')
const { createAppShutdownCoordinator } = require('../../shell/research-shutdown.cjs')
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 900 }, workArea: { x: 0, y: 0, width: 1280, height: 900 } }
const screen = { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
  getCursorScreenPoint: () => ({ x: 500, y: 500 }), getDisplayNearestPoint: () => display }

// These fake windows and the shared shortcut registry test the real host and
// indicator state machines; they are not a claim of native desktop proof.
function desktopFixture() {
  const shortcuts = new Map(), calls = [], windows = []
  function indicator(label, { loadURL = async () => {} } = {}) {
    class Window extends EventEmitter {
      constructor(options) {
        super(); this.options = options; this.destroyed = false
        this.webContents = new EventEmitter()
        this.webContents.mainFrame = {}
        this.webContents.setWindowOpenHandler = () => {}
        this.webContents.executeJavaScript = async () => {}
        windows.push(this)
      }
      loadURL(url) { return loadURL(url) }
      setAlwaysOnTop() {}
      setIgnoreMouseEvents() {}
      setPosition() {}
      showInactive() { this.visible = true }
      hide() { this.visible = false }
      isVisible() { return this.visible === true }
      isDestroyed() { return this.destroyed }
      getBounds() { return { x: 0, y: 0, width: this.options.width, height: this.options.height } }
      destroy() { this.destroyed = true; this.emit('closed') }
    }
    return createScreenControlIndicator({ BrowserWindow: Window, screen, ipcMain: new EventEmitter(),
      globalShortcut: {
        register(key, stop) {
          calls.push(['register', label])
          if (shortcuts.has(key)) return false
          shortcuts.set(key, { label, stop }); return true
        },
        unregister(key) {
          assert.equal(shortcuts.get(key)?.label, label, 'one app may never release a peer reservation')
          calls.push(['unregister', label]); shortcuts.delete(key)
        },
      } })
  }
  /* Bind to the chord the product arms rather than respelling the choice here:
     Windows' shell owns Control+Alt+Escape, so a literal in this fixture would
     have made every desktop-lease assertion below read an empty map and pass
     for the wrong reason. STOP_SHORTCUT is one value per platform on purpose --
     holding it IS the cross-process lease these rows are about. */
  return { indicator, calls, windows, owner: () => shortcuts.get(STOP_SHORTCUT)?.label,
    stop: () => shortcuts.get(STOP_SHORTCUT)?.stop() }
}
function hostFixture(desktop, label, overrides = {}) {
  const owner = { isDestroyed: () => false }
  const sessions = new Map(['a', 'b'].map(id => [id, { owner, ownerKind: 'window', agentId: id, state: 'running' }]))
  const host = createScreenControlHost({ sessions,
    readBinding: () => ({ enabled: true, roleId: 'worker', revision: 1 }),
    permissionLevel: () => 'unrestricted', audit: async () => {}, indicator: desktop.indicator(label),
    adapter: { supported: () => true, geometry: () => ({}), validate: value => value,
      execute: async () => ({ cleanupConfirmed: true }) }, ...overrides })
  return { host, owner,
    grant: (ids = ['a']) => host.grant(owner, { sessionIds: ids }),
    control: (action = { action: 'move', x: 4, y: 5 }, id = 'a') => host.control({ kind: 'agent-session', sessionId: id,
      agentId: id, roleId: 'worker', expectedRoleRevision: 1 }, action) }
}
function nativeFixture() {
  const children = [], actions = []
  const adapter = createScreenControlAdapter({ screen, platform: 'linux', environment: { DISPLAY: ':synthetic' },
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/python3')
      assert.equal(options.shell, false)
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.kill = signal => { child.killSignal = signal || 'SIGTERM' }
      let input = ''
      child.stdin.on('data', bytes => { input += bytes })
      child.stdin.on('finish', () => actions.push(JSON.parse(input)))
      children.push(child); queueMicrotask(() => child.emit('spawn'))
      return child
    } })
  function close(index, ok) {
    if (ok) children[index].stdout.write('{"ok":true}')
    children[index].emit('close', ok ? 0 : 1)
  }
  return { adapter, children, actions, close }
}

test('the real indicator reserves on demand, retains multiple grants and releases the last one to a peer', async () => {
  const desktop = desktopFixture(), first = hostFixture(desktop, 'first'), peer = hostFixture(desktop, 'peer')
  assert.deepEqual(desktop.calls, [], 'opening two app hosts does not reserve desktop input')
  await first.grant(['a', 'b'])
  assert.equal(desktop.owner(), 'first')
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  first.host.revokeSession('a')
  assert.equal(desktop.owner(), 'first')
  first.host.revokeSession('b')
  assert.equal(desktop.owner(), undefined)
  await peer.grant()
  assert.equal(desktop.owner(), 'peer')
  desktop.stop()
  assert.equal(desktop.owner(), undefined)
  assert.deepEqual(desktop.calls.filter(([event]) => event === 'unregister'), [['unregister', 'first'], ['unregister', 'peer']])
})

test('stop during grant admission retains the reservation until all pending grants have settled', async () => {
  const desktop = desktopFixture(), admission = deferred()
  const first = hostFixture(desktop, 'first', { audit: event => event.event === 'screen-access-granted' ? admission.promise : undefined })
  const peer = hostFixture(desktop, 'peer')
  const one = first.grant(['a']), two = first.grant(['b'])
  const checked = Promise.all([assert.rejects(one, { code: 'SCREEN_ACCESS_CHANGED' }), assert.rejects(two, { code: 'SCREEN_ACCESS_CHANGED' })])
  await flush()
  desktop.stop()
  assert.equal(desktop.owner(), 'first')
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  admission.resolve()
  await checked
  assert.equal(desktop.owner(), undefined)
  await peer.grant(); peer.host.close(peer.owner)
})

test('indicator preparation or admission audit failure releases only this app reservation', async () => {
  for (const kind of ['indicator', 'audit']) {
    const desktop = desktopFixture()
    const first = hostFixture(desktop, 'first', kind === 'indicator'
      ? { indicator: desktop.indicator('first', { loadURL: async () => { throw new Error('indicator preparation failed') } }) }
      : { audit: async () => { throw new Error('audit unavailable') } })
    await assert.rejects(first.grant(), kind === 'indicator' ? /preparation failed/ : /audit unavailable/)
    assert.equal(first.host.state(first.owner).cleanup, 'confirmed')
    assert.equal(desktop.owner(), undefined)
    const peer = hostFixture(desktop, 'peer')
    await peer.grant(); peer.host.revokeAll()
  }
})

test('quit and peer admission wait for the original native process, fallback cleanup and revoked queue', async () => {
  const desktop = desktopFixture(), native = nativeFixture()
  const first = hostFixture(desktop, 'first', { adapter: native.adapter }), peer = hostFixture(desktop, 'peer')
  await first.grant(['a', 'b'])
  const action = first.control({ action: 'drag', x: 4, y: 5, toX: 6, toY: 7 })
  const queued = first.control({ action: 'click', x: 8, y: 9 }, 'a')
  const checked = Promise.all([assert.rejects(action, { code: 'SCREEN_ACTION_INTERRUPTED' }), assert.rejects(queued, { code: 'SCREEN_ACCESS_OFF' })])
  await flush()
  let shut = false
  const shutdown = first.host.shutdown().then(result => { assert.equal(result.cleanupConfirmed, true); shut = true })
  await assert.rejects(first.grant(), { code: 'SCREEN_HOST_CLOSING' })
  assert.equal(native.children[0].killSignal, 'SIGTERM')
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  assert.equal(shut, false); assert.equal(native.children.length, 1)
  native.close(0, false)
  await flush()
  assert.equal(native.children.length, 2)
  assert.equal(desktop.owner(), 'first')
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  assert.equal(shut, false)
  native.close(1, true)
  await checked; await shutdown
  assert.equal(native.children.length, 2, 'the revoked queued click never launches')
  assert.equal(desktop.owner(), undefined)
  await peer.grant(); peer.host.revokeAll()
})

test('a new indicator preparation failure cannot release an older action still cleaning up', async () => {
  const desktop = desktopFixture(), native = nativeFixture(), preparing = deferred()
  const indicator = desktop.indicator('first')
  let attempts = 0
  const first = hostFixture(desktop, 'first', { adapter: native.adapter,
    indicator: { ...indicator, ready(stop) { return ++attempts === 1 ? indicator.ready(stop) : preparing.promise } } })
  const peer = hostFixture(desktop, 'peer')
  await first.grant()
  const grant = first.grant(['b'])
  const refused = assert.rejects(grant, /indicator preparation failed/)
  const action = first.control({ action: 'drag', x: 4, y: 5, toX: 6, toY: 7 })
  const checked = assert.rejects(action, { code: 'SCREEN_ACTION_INTERRUPTED' })
  await flush()
  preparing.reject(new Error('indicator preparation failed'))
  await refused
  assert.equal(native.children[0].killSignal, 'SIGTERM')
  assert.equal(desktop.owner(), 'first')
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  native.close(0, false); await flush()
  assert.equal(desktop.owner(), 'first')
  native.close(1, true); await checked
  assert.equal(desktop.owner(), undefined)
  await peer.grant(); peer.host.revokeAll()
})

test('a failed native release revokes every grant and retains desktop ownership through repeated quit requests', async () => {
  const desktop = desktopFixture(), native = nativeFixture()
  const first = hostFixture(desktop, 'first', { adapter: native.adapter }), peer = hostFixture(desktop, 'peer')
  await first.grant(['a', 'b'])
  const action = first.control({ action: 'drag', x: 4, y: 5, toX: 6, toY: 7 })
  const checked = assert.rejects(action, { code: 'SCREEN_INPUT_RELEASE_FAILED', cleanupConfirmed: false })
  await flush()
  first.host.revokeAll(); native.close(0, false)
  await flush(); native.close(1, false)
  await checked
  assert.equal(first.host.state(first.owner).cleanup, 'unconfirmed')
  assert.equal(first.host.state(first.owner).grants.length, 0)
  await assert.rejects(first.grant(), { code: 'SCREEN_INPUT_RELEASE_FAILED' })
  await assert.rejects(peer.grant(), /stop shortcut is unavailable/)
  let prevented = 0, quits = 0, blocked = 0
  const guard = createScreenControlQuitGuard({ host: first.host, quit: () => quits++, onBlocked: () => blocked++ })
  const event = { preventDefault() { prevented++ } }
  const pending = guard(event)
  assert.equal(guard(event), pending)
  await pending
  await guard(event)
  assert.equal(prevented, 3); assert.equal(quits, 0); assert.equal(blocked, 1)
  assert.equal(desktop.owner(), 'first')
  assert.deepEqual(desktop.calls.filter(([event]) => event === 'unregister'), [])
})

test('a failed ordinary key or typing helper cannot claim full cleanup from the modifiers-only fallback', async () => {
  for (const action of [{ action: 'key', key: 'Control+A' }, { action: 'type', text: 'café λ' }]) {
    const desktop = desktopFixture(), native = nativeFixture()
    const first = hostFixture(desktop, 'first', { adapter: native.adapter })
    await first.grant()
    const pending = first.control(action)
    const checked = assert.rejects(pending, { code: 'SCREEN_INPUT_RELEASE_FAILED', cleanupConfirmed: false })
    await flush(); native.close(0, false)
    await flush(); native.close(1, true)
    await checked
    assert.equal(first.host.state(first.owner).cleanup, 'unconfirmed')
    await assert.rejects(first.host.shutdown(), { code: 'SCREEN_INPUT_RELEASE_FAILED' })
    assert.equal(desktop.owner(), 'first')
  }
})

test('a completed keyboard receipt is sufficient even when stop races process close', async () => {
  const desktop = desktopFixture(), native = nativeFixture()
  const first = hostFixture(desktop, 'first', { adapter: native.adapter })
  await first.grant()
  const pending = first.control({ action: 'key', key: 'Control+A' })
  const checked = assert.rejects(pending, { code: 'SCREEN_ACTION_INTERRUPTED', cleanupConfirmed: true })
  await flush()
  first.host.revokeAll()
  native.close(0, true)
  await checked
  assert.equal(native.children.length, 1, 'a confirmed original cleanup needs no later global key-up process')
  assert.equal(first.host.state(first.owner).cleanup, 'confirmed')
  assert.equal(desktop.owner(), undefined)
})

test('failure before native spawn and failure in result auditing do not poison safe desktop handoff', async () => {
  for (const kind of ['spawn-throw', 'spawn-error', 'audit']) {
    const desktop = desktopFixture()
    const adapter = createScreenControlAdapter({ screen, platform: 'linux', environment: { DISPLAY: ':synthetic' },
      spawnProcess: () => {
        if (kind === 'spawn-throw') throw new Error('spawn refused')
        const child = new EventEmitter()
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}
        queueMicrotask(() => { child.emit('error', new Error('ENOENT')); child.emit('close', -2) })
        return child
      } })
    const first = hostFixture(desktop, 'first', kind === 'audit'
      ? { audit: async event => { if (event.event === 'screen-action-result') throw new Error('result audit failed') } }
      : { adapter })
    const peer = hostFixture(desktop, 'peer')
    await first.grant()
    await assert.rejects(first.control(), kind === 'audit' ? /result audit failed/ : kind === 'spawn-throw' ? /spawn refused/ : /could not start/)
    assert.equal(first.host.state(first.owner).cleanup, 'confirmed')
    first.host.revokeAll()
    assert.equal(desktop.owner(), undefined)
    await peer.grant(); peer.host.revokeAll()
  }
})

test('shared-session marker presence refuses grant, capture and input before any global side effect', async () => {
  for (const name of ['TOOLSENABLED_SHARED_HOST_SESSION', 'toolsenabled_shared_host_session', 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT', 'ToolsEnabled_Provider_Isolation_Root']) {
    for (const value of ['', '0', 'false', '/private/profile']) {
      for (const platform of ['linux', 'win32']) {
        const desktop = desktopFixture()
        const adapter = createScreenControlAdapter({ screen, platform,
          environment: { DISPLAY: ':synthetic', [name]: value, TOOLSENABLED_INDEPENDENT_DESKTOP: 'true' },
          desktopCapturer: { getSources: () => assert.fail('shared DEV may not capture the owner desktop') },
          spawnProcess: () => assert.fail('shared DEV may not send owner-desktop input') })
        const shared = hostFixture(desktop, 'shared', { adapter })
        assert.equal(shared.host.state(shared.owner).supported, false)
        await assert.rejects(shared.grant(), /independently owned desktop/)
        for (const action of [{ action: 'screenshot' }, { action: 'move', x: 4, y: 5 }]) {
          await assert.rejects(adapter.execute(action), { code: 'SCREEN_SHARED_DESKTOP_UNAVAILABLE' })
        }
        assert.deepEqual(desktop.calls, [])
        assert.equal((await shared.host.shutdown()).cleanupConfirmed, true)
        const live = hostFixture(desktop, 'live')
        await live.grant(); assert.equal(desktop.owner(), 'live'); live.host.revokeAll()
      }
    }
  }
})

test('a reconstructed environment cannot remove the real process shared-session provenance', async () => {
  for (const name of ['ToOlSeNaBlEd_ShArEd_HoSt_SeSsIoN', 'ToOlSeNaBlEd_PrOvIdEr_IsOlAtIoN_RoOt']) {
    const prior = process.env[name]
    process.env[name] = 'false'
    try {
      const desktop = desktopFixture()
      const adapter = createScreenControlAdapter({ screen, platform: 'linux', environment: { DISPLAY: ':synthetic' },
        spawnProcess: () => assert.fail('ambient shared provenance forbids native input'),
        desktopCapturer: { getSources: () => assert.fail('ambient shared provenance forbids screen capture') } })
      const shared = hostFixture(desktop, 'shared', { adapter })
      await assert.rejects(shared.grant(), /independently owned desktop/)
      await assert.rejects(adapter.execute({ action: 'screenshot' }), { code: 'SCREEN_SHARED_DESKTOP_UNAVAILABLE' })
      await assert.rejects(adapter.execute({ action: 'move', x: 4, y: 5 }), { code: 'SCREEN_SHARED_DESKTOP_UNAVAILABLE' })
      assert.deepEqual(desktop.calls, [])
      assert.equal((await shared.host.shutdown()).cleanupConfirmed, true)
    } finally {
      if (prior === undefined) delete process.env[name]
      else process.env[name] = prior
    }
  }
})

test('actual shell quit registration joins both screen and research cleanup in either completion order', async () => {
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  // MEASURED 2026-09-17 at app 5c7798a3: the anchor used to be the literal
  // "app.on('before-quit', require('./screen-control-quit.cjs')". T180 hoisted
  // the guard to `const screenControlQuitGuard` and registered a handler that
  // writes a durable exit record before delegating, so indexOf returned -1 and
  // this row failed on `start > 0` rather than on anything about quit joining.
  // Anchor on the guard's construction instead; the slice below is now strictly
  // larger and runs the registration and the exit-record write as well.
  const start = source.indexOf("const screenControlQuitGuard = require('./screen-control-quit.cjs')")
  const end = source.indexOf('const accessibilityApp =', start)
  assert.ok(start > 0 && end > start)
  assert.match(source.slice(start, end), /app\.on\('before-quit'/,
    'the sliced region must still contain the registration this row drives')
  for (const order of ['screen-first', 'research-first']) {
    const listeners = [], screenDone = deferred(), researchDone = deferred()
    let exits = 0, sealed = 0
    const app = { on: (event, listener) => { assert.equal(event, 'before-quit'); listeners.push(listener) },
      quit() {
        let prevented = false
        const event = { preventDefault() { prevented = true } }
        for (const listener of listeners) listener(event)
        if (!prevented) exits++
      } }
    const exitRecords = []
    vm.runInNewContext(source.slice(start, end), { require: () => ({ createScreenControlQuitGuard }), app,
      screenControlHost: { shutdown() { sealed++; return screenDone.promise } }, console,
      exitRecord: { writeExitRecord: (...written) => exitRecords.push(written) },
      dialog: { showMessageBox: () => assert.fail('successful cleanup may not report failure') } })
    assert.deepEqual(exitRecords, [], 'nothing is recorded until a quit is actually asked for')
    const coordinator = createAppShutdownCoordinator({ quit: () => app.quit(), closeAgents: () => researchDone.promise })
    app.on('before-quit', coordinator.beforeQuit)
    app.quit(); app.quit()
    // T180: both attempts are recorded even though only the first seals, so a
    // machine that died mid-quit still says which path asked and how often.
    assert.deepEqual(exitRecords, [['before-quit', 'screen-control-quit-guard'], ['before-quit', 'screen-control-quit-guard']])
    assert.equal(sealed, 1, 'screen admission is sealed synchronously and only once')
    assert.equal(coordinator.started, true)
    const first = order === 'screen-first' ? screenDone : researchDone
    const second = order === 'screen-first' ? researchDone : screenDone
    first.resolve({ cleanupConfirmed: true }); await flush()
    assert.equal(exits, 0, 'one shutdown join cannot authorize exit for another')
    second.resolve({ cleanupConfirmed: true }); await flush()
    assert.equal(exits, 1)
  }
})

test('an unrelated shutdown timeout never releases a pending or failed screen reservation', async () => {
  for (const failure of [false, true]) {
    const ending = deferred(), callbacks = [], timers = []
    let exits = 0, blocked = 0
    const quit = () => {
      let prevented = false
      for (const callback of callbacks) callback({ preventDefault() { prevented = true } })
      if (!prevented) exits++
    }
    callbacks.push(createScreenControlQuitGuard({ host: { shutdown: () => ending.promise }, quit, onBlocked: () => blocked++ }))
    const coordinator = createAppShutdownCoordinator({ quit, closeAgents: () => new Promise(() => {}),
      schedule: callback => { timers.push(callback); return callback }, unschedule() {} })
    callbacks.push(coordinator.beforeQuit)
    quit()
    timers[0]()
    assert.equal(coordinator.complete, true); assert.equal(exits, 0)
    if (failure) ending.reject(new Error('native cleanup unknown'))
    else ending.resolve({ cleanupConfirmed: true })
    await flush()
    assert.equal(exits, failure ? 0 : 1)
    assert.equal(blocked, failure ? 1 : 0)
  }
})
