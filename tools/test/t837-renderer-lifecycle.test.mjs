import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { createFleetTreeStore } from '../../src/fleet-trees.js'

const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const nativeMain = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const helper = new URL('../../src/page-diagnostics.js', import.meta.url)
const lifecycle = existsSync(helper) ? await import(helper.href) : {}
// Run the real router functions; only DOM/animation and the view constructors
// are inert. This is lifecycle behavior, not a physical repaint measurement.
function routerFixture() {
  const events = [], timers = [], nodes = new Map()
  const element = () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {} },
    appendChild() {}, remove() {}, setAttribute() {}, toggleAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) })
  const context = {
    nativeStopSurface: null, current: null,
    makeView: () => ({ el: element(), destroy() {} }),
    document: { createElement: element, body: { dataset: {} },
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id) } },
    stage: { appendChild() {}, offsetWidth: 10 }, pageCanAnimate: () => true,
    requestAnimationFrame: fn => fn(), setTimeout: fn => timers.push(fn),
    VIEW_MORPH_MS: 500, location: { hash: '#/' }, crumb: null, navEl: null,
    markTreeNodeCommandSurfaceMounted() {}, drainTreeNodeCommands() {},
    ringOrder: () => ['home', 'computers', 'ledger', 'settings'], RING_EXIT: {},
    COMMS_NAME: 'Messages', firstUseGuidance: { visit() {} },
    pageDiagnostics: lifecycle.createPageDiagnostics?.({ send: ({ route, phase }) => events.push({ route, phase }) })
      || { mount() {}, unmount() {} },
  }
  const retireStart = main.indexOf('function retireView(')
  const swapEnd = main.indexOf("\nwindow.addEventListener('hashchange', render)", retireStart)
  assert.ok(retireStart >= 0 && swapEnd > retireStart)
  vm.runInNewContext(main.slice(retireStart, swapEnd), context)
  return { events, mount(route, snapshotted = true, zoom = false) { context.swapView({ name: route }, { x: 2, y: 2 }, zoom, snapshotted) },
    retire() { for (const callback of timers.splice(0)) callback() } }
}
test('T837 actual SPA swaps emit one mount and unmount marker with the resolved route', () => {
  const f = routerFixture()
  for (const route of ['home', 'computers', 'ledger', 'settings', 'computers']) f.mount(route)
  assert.deepEqual(f.events, [
    { route: 'home', phase: 'mount' },
    { route: 'computers', phase: 'mount' }, { route: 'home', phase: 'unmount' },
    { route: 'ledger', phase: 'mount' }, { route: 'computers', phase: 'unmount' },
    { route: 'settings', phase: 'mount' }, { route: 'ledger', phase: 'unmount' },
    { route: 'computers', phase: 'mount' }, { route: 'settings', phase: 'unmount' },
  ])
  const normal = routerFixture()
  normal.mount('home'); normal.mount('computers', false)
  assert.deepEqual(normal.events, [{ route: 'home', phase: 'mount' }, { route: 'computers', phase: 'mount' }])
  normal.retire()
  assert.deepEqual(normal.events.at(-1), { route: 'home', phase: 'unmount' })
  normal.mount('ledger', false, true)
  assert.deepEqual(normal.events.at(-1), { route: 'ledger', phase: 'mount' })
  normal.retire(); normal.retire()
  assert.deepEqual(normal.events.at(-1), { route: 'computers', phase: 'unmount' })
  assert.equal(normal.events.length, 5, 'normal and zoom retirement each close the actual helper exactly once')
})
test('T837 lifecycle bridge deduplicates mounts and closes each retiring view on unload', () => {
  assert.equal(typeof lifecycle.createPageDiagnostics, 'function')
  const events = [], first = {}, next = {}
  const diagnostics = lifecycle.createPageDiagnostics({ send: event => events.push(event) })
  diagnostics.mount(first, 'computers'); diagnostics.mount(first, 'computers')
  diagnostics.mount(next, 'ledger'); diagnostics.unmount(first); diagnostics.unmount(first)
  diagnostics.close(); diagnostics.close()
  assert.deepEqual(events, [
    { route: 'computers', phase: 'mount', mountId: 1 },
    { route: 'ledger', phase: 'mount', mountId: 2 },
    { route: 'computers', phase: 'unmount', mountId: 1 },
    { route: 'ledger', phase: 'unmount', mountId: 2 },
  ])
  assert.match(main, /beforeunload[^\n]*pageDiagnostics\.close\(\)/)
  const refusing = lifecycle.createPageDiagnostics({ send() { throw new Error('inert IPC refusal') } })
  assert.doesNotThrow(() => { refusing.mount({}, 'computers'); refusing.close() })
})
test('T837 preload carries only page lifecycle fields through the existing diagnostics channel', () => {
  const exposed = new Map(), sent = []
  const context = {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value) } },
        ipcRenderer: { sendSync: () => ({ ok: false }), invoke: async () => ({ ok: true }),
          on() {}, removeListener() {}, send(...args) { sent.push(args) } } }
    },
    window: { addEventListener() {} }, document: {}, console,
    process: { platform: process.platform, env: {}, argv: [] },
    setTimeout: () => 0, clearTimeout() {},
  }
  vm.runInNewContext(preload, context)
  const settings = exposed.get('mcSettings')
  assert.equal(typeof settings?.diagnosticsPage, 'function')
  settings.diagnosticsPage({ route: 'computers', phase: 'mount', mountId: 1 })
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ['mc-settings:diagnostics-page', { route: 'computers', phase: 'mount', mountId: 1 }],
  ])
})
test('T837 native diagnostics route rejects other senders and remains sealed after privacy erase', () => {
  assert.ok(nativeMain.indexOf('mainLagMonitor.instrument(ipcMain)') < nativeMain.indexOf("ipcMain.on('mc-settings:tree-slots'"), 'the real slot handler registers after instrumentation')
  const channel = 'mc-settings:diagnostics-page', handlers = new Map(), calls = []
  const at = nativeMain.indexOf("ipcMain.on('" + channel + "'")
  const end = nativeMain.indexOf("\nipcMain.", at + 1)
  assert.ok(at >= 0 && end > at, 'the real main process must register the route sink')
  const context = { ipcMain: { on: (name, fn) => handlers.set(name, fn) },
    trustedFleetProfileSender: event => event.trusted === true, localDataErased: false,
    mainLagMonitor: { pageLifecycle: (...args) => calls.push(args) } }
  vm.runInNewContext(nativeMain.slice(at, end), context)
  const receive = handlers.get(channel), request = { route: 'computers', phase: 'mount', mountId: 1 }
  receive({ trusted: false, sender: { id: 8 } }, request)
  assert.equal(calls.length, 0)
  receive({ trusted: true, sender: { id: 8 } }, request)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), [request, { senderId: 8 }])
  context.localDataErased = true
  receive({ trusted: true, sender: { id: 8 } }, request)
  assert.equal(calls.length, 1)
})
test('T837 slot reader avoids per-tick IPC while fresh snapshots see changed limits', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reads = 0, bounds = { maxChildren: 4, maxDepth: 3 }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { mcSettings: {
    treeSlots: () => { reads++; return { ok: true, bounds } },
  } } })
  try {
    const cells = new Map(), store = createFleetTreeStore({ computerId: 'rate-fixture',
      storage: { read: key => cells.get(key) ?? null, write: (key, value) => { cells.set(key, value); return true } } })
    for (let tick = 0; tick < 200; tick++) assert.equal(store.snapshot().nodes.length, 0)
    assert.equal(reads, 0, '200 ordinary renderer tick snapshots must not issue 200 synchronous reads')
    const before = store.snapshot()
    assert.deepEqual(before.slotBounds, bounds); assert.deepEqual(before.slotBounds, bounds)
    assert.equal(reads, 1, 'a snapshot reads its bounds exactly once')
    bounds = { maxChildren: 2, maxDepth: 1 }
    assert.deepEqual(store.snapshot().slotBounds, bounds)
    assert.equal(reads, 2, 'a fresh bounds decision sees the changed setting')
    bounds = null
    assert.equal(store.snapshot().slotBounds, null, 'unreadable settings do not reuse a stale allowance')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  }
})
