/* The composed preload is executable boundary code, not a declaration to parse.
 * Drive it with Electron's two narrow objects stubbed: no Electron process or
 * BrowserWindow is started by this suite. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require_ = createRequire(import.meta.url)
const PRELOAD = fileURLToPath(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url))

function loadPreload({ fleetBootstrap = { ok: true, profile: { name: 'Home fleet' } }, fireDomReady = false } = {}) {
  const exposed = new Map()
  const calls = []
  const ipcRenderer = {
    sendSync(channel, ...args) {
      calls.push({ kind: 'sync', channel, args })
      if (channel === 'mc-fleet-profile:bootstrap') return fleetBootstrap
      if (channel === 'mc-prefs:bootstrap') return { ok: false, code: 'NOT_AVAILABLE' }
      if (channel === 'mc-setup:bootstrap') return { available: false, code: 'NOT_AVAILABLE' }
      if (channel === 'mc-fleet-profile:migrate-legacy') {
        return args[0]?.broken
          ? { ok: false, code: 'FLEET_PROFILE_READ_FAILED', reason: 'The saved profile could not be read.' }
          : { ok: true, migrated: true, profile: args[0] }
      }
      return { ok: true }
    },
    invoke(channel, ...args) {
      calls.push({ kind: 'async', channel, args })
      if (args[0]?.refuse) return Promise.resolve({ ok: false, code: 'FLEET_PROFILE_REFUSED', reason: 'The profile was refused.' })
      return Promise.resolve({ ok: true, channel, received: args })
    },
    on() {},
    removeListener() {},
    send() {},
  }
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value) } },
    ipcRenderer,
  }
  /* document/window are stubbed only far enough to let injectTitlebar() and
     reportTheme() run for real when a test explicitly fires DOMContentLoaded
     -- neither runs on its own here, same as a plain require would leave
     them, since the stub's addEventListener only records the listener. */
  const appended = []
  const prepended = []
  const htmlClasses = new Set()
  const bodyClasses = new Set()
  const listeners = new Map()
  const document = {
    documentElement: { classList: { add: value => htmlClasses.add(value) }, dataset: {} },
    body: { classList: { add: value => bodyClasses.add(value) }, prepend: value => prepended.push(value) },
    head: { appendChild: value => appended.push(value) },
    createElement: tag => ({ tag, textContent: '', id: '' }),
    getElementById: id => prepended.find(element => element.id === id) || null,
  }
  // reportTheme() also runs off the same DOMContentLoaded listener; these let
  // it complete without throwing, though no test here reads what it sends.
  class MutationObserver { constructor(callback) { this.callback = callback } observe() {} }

  const originalLoad = Module._load
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalGetComputedStyle = globalThis.getComputedStyle
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalMutationObserver = globalThis.MutationObserver
  const originalSetTimeout = globalThis.setTimeout
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === PRELOAD) return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { addEventListener: (name, callback) => listeners.set(name, callback) },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: document,
  })
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    writable: true,
    value: () => ({ backgroundColor: 'rgb(0, 0, 0)', color: 'rgb(0, 0, 0)' }),
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: () => {},
  })
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: MutationObserver,
  })
  // reportTheme()'s settle pass is a REAL setTimeout(send, 600) against the
  // real clock. Left real, it fires 600ms after this function has already
  // returned and torn the stubs above back down -- send() then throws
  // "getComputedStyle is not defined" as an uncaught exception in whatever
  // test happens to be running next. No test here reads what reportTheme()
  // sends, so the settle pass is simply never scheduled.
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    writable: true,
    value: () => 0,
  })
  try {
    delete require_.cache[PRELOAD]
    require_(PRELOAD)
    // Fired here, still inside the stubbed globals -- injectTitlebar() and
    // reportTheme() both read document/window/getComputedStyle et al, and
    // those stubs are torn back down the moment this try block ends.
    if (fireDomReady) listeners.get('DOMContentLoaded')?.()
  } finally {
    Module._load = originalLoad
    if (originalWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow })
    if (originalDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: originalDocument })
    if (originalGetComputedStyle === undefined) delete globalThis.getComputedStyle
    else Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true, value: originalGetComputedStyle })
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame
    else Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, writable: true, value: originalRequestAnimationFrame })
    if (originalMutationObserver === undefined) delete globalThis.MutationObserver
    else Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, writable: true, value: originalMutationObserver })
    if (originalSetTimeout === undefined) delete globalThis.setTimeout
    else Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: originalSetTimeout })
  }
  return { bridge: exposed.get('mcFleetProfile'), account: exposed.get('mcAccount'), nativeStop: exposed.get('mcNativeStop'), calls, listeners, appended, prepended, htmlClasses, bodyClasses }
}

test('shell/fleet-profile-preload.cjs preserves both a ready bootstrap and a read failure with its reason', () => {
  const ready = { ok: true, profile: { name: 'Ready fleet' }, source: 'userData' }
  const unavailable = { ok: false, code: 'FLEET_PROFILE_READ_FAILED', reason: 'The saved profile could not be read.' }

  assert.strictEqual(loadPreload({ fleetBootstrap: ready }).bridge.bootstrap, ready)
  const failedBootstrap = loadPreload({ fleetBootstrap: unavailable }).bridge.bootstrap
  assert.strictEqual(failedBootstrap, unavailable)
  assert.equal(failedBootstrap.ok, false)
  assert.equal(failedBootstrap.code, 'FLEET_PROFILE_READ_FAILED')
  assert.match(failedBootstrap.reason, /could not be read/i)
})

test('shell/fleet-profile-preload.cjs synchronously migrates the caller profile and preserves a refusal', () => {
  const { bridge, calls } = loadPreload()
  const profile = { version: 1, machines: [{ id: 'desk' }] }
  const migrated = bridge.migrateLegacy(profile)
  assert.equal(migrated.ok, true)
  assert.strictEqual(migrated.profile, profile)
  assert.deepEqual(calls.at(-1), {
    kind: 'sync', channel: 'mc-fleet-profile:migrate-legacy', args: [profile],
  })

  const refusal = bridge.migrateLegacy({ broken: true })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'FLEET_PROFILE_READ_FAILED')
  assert.match(refusal.reason, /could not be read/i)
})

test('shell/fleet-profile-preload.cjs exposes the caller-used async operations on fixed channels without losing inputs or refusals', async () => {
  const { bridge, calls } = loadPreload()
  const profile = { version: 2, name: 'Work fleet' }
  const operations = [
    ['save', 'mc-fleet-profile:save', [profile]],
    ['reset', 'mc-fleet-profile:reset', []],
    ['importFile', 'mc-fleet-profile:import-file', []],
    ['exportFile', 'mc-fleet-profile:export-file', [profile]],
    ['chooseDirectory', 'mc-fleet-profile:choose-directory', []],
    ['probe', 'mc-fleet-profile:probe', [profile]],
  ]
  for (const [method, channel, args] of operations) {
    const result = await bridge[method](...args)
    assert.deepEqual(calls.at(-1), { kind: 'async', channel, args }, `${method} did not forward its caller input on its fixed channel`)
    assert.equal(result.ok, true, `${method} did not preserve main's available result`)
  }

  const refusal = await bridge.probe({ refuse: true })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'FLEET_PROFILE_REFUSED')
  assert.match(refusal.reason, /refused/i)
})

test('the account bridge forwards only a supplied account comparison fence verbatim', async () => {
  const { account, calls } = loadPreload()
  await account.getSetting('research_queue')
  assert.deepEqual(calls.at(-1), { kind: 'async', channel: 'mc-account:setting-get', args: [{ key: 'research_queue' }] })
  await account.getSetting('research_queue', { expectedAccountId: 7 })
  assert.deepEqual(calls.at(-1), { kind: 'async', channel: 'mc-account:setting-get',
    args: [{ key: 'research_queue', expectedAccountId: 7 }] })
  await account.putSetting('research_queue', 'fixture', { expectedAccountId: null })
  assert.deepEqual(calls.at(-1), { kind: 'async', channel: 'mc-account:setting-put',
    args: [{ key: 'research_queue', value: 'fixture', expectedAccountId: null }] })
})

test('the injected titlebar strip pushes the home takeover clear too, not only #stage/.topbar/.drawer', () => {
  // main.cjs loads exactly this file for its window (see
  // preload-namespace-parity.test.mjs), so this is the boundary a real
  // install runs -- not shell/preload.cjs, which no window ever loads.
  const harness = loadPreload({ fireDomReady: true })
  assert.equal(typeof harness.listeners.get('DOMContentLoaded'), 'function',
    'DOMContentLoaded was never registered -- injectTitlebar() would never run on a real page')

  assert.deepEqual([...harness.htmlClasses], ['in-shell'])
  assert.equal(harness.prepended[0]?.id, 'shell-titlebar', 'the shell drag strip must be installed')
  assert.equal(harness.appended.length, 1, 'exactly one stylesheet carries every in-shell offset')

  const css = harness.appended[0].textContent
  // The strip is 36px; #stage/.topbar/.drawer each already clear it. The
  // home takeover (src/home.css: position:fixed; inset:0; z-index:80) is
  // the one fixed surface under the strip (z-index:200) that this list used
  // to leave uncovered -- its first child is the "Show" subject-picker bar,
  // which used to paint (and, for its label text specifically, receive
  // drag-region clicks meant for the window) inside the strip's own band.
  assert.match(css, /html\.in-shell \.home-takeover\s*\{\s*top:\s*36px;\s*\}/,
    'the injected stylesheet no longer clears .home-takeover by the strip height -- the "Show" picker submerges under the titlebar again')

  // Same clearance number as every sibling rule, read from the same source
  // rather than restated, so the two cannot silently drift apart.
  const stageOffset = css.match(/#stage\s*\{\s*height:\s*calc\(100vh - (\d+)px\);\s*margin-top:\s*(\d+)px;/)
  assert.ok(stageOffset, 'could not find the #stage offset to compare against')
  const takeoverOffset = css.match(/\.home-takeover\s*\{\s*top:\s*(\d+)px;/)
  assert.ok(takeoverOffset, 'could not find the .home-takeover offset to compare against')
  assert.equal(takeoverOffset[1], stageOffset[1], '.home-takeover must clear the same strip height #stage does')
  assert.equal(takeoverOffset[1], stageOffset[2], '.home-takeover must clear the same strip height #stage does')
})

test('shell/preload.cjs and shell/fleet-profile-preload.cjs stay in lockstep on the home-takeover clearance', () => {
  // The two files duplicate injectTitlebar() on purpose (a sandboxed preload
  // cannot require a sibling -- see both files' own header comments). This
  // is the same trap preload-namespace-parity.test.mjs guards for mcShell:
  // a fix landed in the unloaded file alone is a fix nobody's install gets.
  const UNLOADED = fileURLToPath(new URL('../../shell/preload.cjs', import.meta.url))
  const loaded = readFileSync(PRELOAD, 'utf8')
  const unloaded = readFileSync(UNLOADED, 'utf8')
  assert.match(loaded, /html\.in-shell \.home-takeover \{ top: \$\{TITLEBAR_HEIGHT\}px; \}/,
    'shell/fleet-profile-preload.cjs (the loaded boundary) is missing the .home-takeover clearance rule')
  assert.match(unloaded, /html\.in-shell \.home-takeover \{ top: \$\{TB\}px; \}/,
    'shell/preload.cjs (kept in lockstep by convention) is missing the .home-takeover clearance rule')
})


test('the loaded native preload exposes only the private Stop readiness and one-use receipt channels', async () => {
  const { nativeStop, calls } = loadPreload()
  assert.deepEqual(Object.keys(nativeStop).sort(), ['close', 'complete', 'onRequest', 'ready'])
  assert.throws(() => nativeStop.onRequest(null), TypeError)
  const remove = nativeStop.onRequest(() => {})
  assert.equal(typeof remove, 'function'); remove()
  await nativeStop.ready(true)
  assert.deepEqual(calls.at(-1), { kind: 'async', channel: 'mc-native-stop:ready', args: [true] })
  const key = { requestId: 'request-a', token: 'one-use-token' }
  await nativeStop.close(key)
  assert.deepEqual(calls.at(-1), { kind: 'async', channel: 'mc-native-stop:close', args: [key] })
  await nativeStop.complete({ ...key, savedState: 'recorded' })
  assert.equal(calls.at(-1).channel, 'mc-native-stop:complete')
  assert.equal(Object.hasOwn(nativeStop, 'start'), false)
})
