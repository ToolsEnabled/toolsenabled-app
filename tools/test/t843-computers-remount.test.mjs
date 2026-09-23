import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')
const { WRITE_FLAGS_EVENT } = await import('../../src/write-flags.js')

const MAIN = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const listenerStart = MAIN.indexOf('window.addEventListener(DATA_SOURCE_EVENT, event => {')
const listenerEnd = MAIN.indexOf('\nconst hashFor', listenerStart)
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'the main data-source listener must be present')
const routerListener = MAIN.slice(listenerStart, listenerEnd)

async function fixture(t) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  seedTreeNode(world.storage, { nodeId: 'worker-remount', sessionId: 'session-remount', status: 'running' })

  let current = await mountView(world)
  const mounted = [current]
  const pending = []
  const router = {
    route: { name: 'computers' },
    view: current,
  }
  const render = () => {
    const old = router.view
    old.destroy()
    old.el.remove()
    pending.push(mountView(world).then(next => {
      mounted.push(next)
      router.view = next
    }))
  }

  Function(
    'window',
    'DATA_SOURCE_EVENT',
    'WRITE_FLAGS_EVENT',
    'syncPhoneExampleNotice',
    'isExampleMode',
    'currentDataSource',
    'resetPersistentVoice',
    'accessibilityControls',
    'resetCartChanges',
    'current',
    'render',
    routerListener,
  )(
    window,
    DATA_SOURCE_EVENT,
    WRITE_FLAGS_EVENT,
    () => {},
    () => false,
    () => 'local',
    () => {},
    {},
    () => {},
    router,
    render,
  )

  t.after(async () => {
    await Promise.all(pending)
    router.view.destroy()
    router.view.el.remove()
    world.restore()
  })

  await settle()
  return {
    world,
    router,
    mounted,
    async announce(why) {
      window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why } }))
      await settle()
      await Promise.all(pending)
    },
  }
}

test('a host re-announce keeps the mounted Computers surface and its active work', async t => {
  const f = await fixture(t)
  const original = f.router.view
  await f.announce('host')
  assert.equal(f.mounted.length, 1, 'a same-world host re-announce must not rebuild Computers')
  assert.equal(f.router.view, original, 'the active Computers view must remain the same mounted surface')
  assert.equal(f.router.view.el.isConnected, true, 'the active Computers surface must remain connected')
  assert.ok(f.router.view.el.classList.contains('computers'), 'the real Computers DOM must remain mounted')
})

test('an agent-events gap refreshes the mounted surface without a route remount', async t => {
  const f = await fixture(t)
  const original = f.router.view
  await f.announce('agent-events-gap')
  assert.equal(f.mounted.length, 1, 'an event-stream gap must not rebuild Computers')
  assert.equal(f.router.view, original, 'the stream recovery must stay on the active surface')
  assert.equal(f.router.view.el.isConnected, true)
})


/* T1163: run the production router's render/makeView/swapView/retireView
 * bodies, not a scheduling counter or a replacement render implementation.
 * Only the surrounding shell services and animation clock are inert. Home
 * itself is imported and mounted, and its bridge-backed run rows are read
 * again on remount. These announcements are synthetic inputs: this suite
 * does not establish that a desktop or external web host produces them. */
function mainSection(startMarker, endMarker) {
  const start = MAIN.indexOf(startMarker)
  const end = MAIN.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, 'the production router section must be available')
  return MAIN.slice(start, end)
}
const routeFactory = mainSection('function makeView(route)', 'function crumbFor(route)')
const routeMount = mainSection('function render()', '\nconst hashFor')

async function homeFixture(t) {
  const world = await installWorld(fleetFetch())
  // Home's graphics are outside the route lifecycle proof; do not animate.
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const heldAgent = Object.getOwnPropertyDescriptor(globalThis, 'mcAgent')
  const retirements = []
  let router = null
  const flushRetirements = () => {
    for (const retire of retirements.splice(0)) retire()
  }
  t.after(async () => {
    try {
      flushRetirements()
      router?.dispose()
      await settle(8)
    } finally {
      if (heldAgent) Object.defineProperty(globalThis, 'mcAgent', heldAgent)
      else delete globalThis.mcAgent
      world.restore()
    }
  })

  let entries = [{
    sequence: 1,
    at: '2026-09-06T04:51:00.000Z',
    action: 'agent_session_start',
    sessionId: 'home-before-announcement',
  }]
  let historyReads = 0
  world.bridge.history = async () => {
    historyReads += 1
    return { ok: true, verified: true, total: entries.length, entries: entries.slice() }
  }
  world.bridge.availability = async () => ({ ok: true, available: true })
  world.bridge.onEvent = () => () => {}
  globalThis.mcAgent = world.bridge
  location.hash = '#/'

  const source = await import('../../src/data-source.js')
  const { setRunsMode } = await import('../../src/chatbox-feed.js')
  const { homeView } = await import('../../src/views/home.js')
  const { createHistoryEntries } = await import('../../src/history-entries.js')
  setRunsMode('only')
  await source.resolveDataSource()

  const stage = document.createElement('main')
  stage.id = 'stage'
  document.body.appendChild(stage)
  for (const id of ['nav-back', 'nav-next', 'route-status']) {
    const node = document.createElement(id === 'route-status' ? 'div' : 'button')
    node.id = id
    document.body.appendChild(node)
  }
  document.getElementById = id => document.querySelector('#' + id)

  const bindings = {
    window, document, location, stage, homeView,
    DATA_SOURCE_EVENT, WRITE_FLAGS_EVENT,
    parse: () => ({ name: 'home' }),
    resolve: route => route,
    checkoutSurfaceSettled: () => true,
    syncFirstRunChrome: () => {},
    // main.js's module-level history tracker (src/history-entries.js, T1412)
    historyEntries: createHistoryEntries(),
    shouldOpenSetup: () => false,
    SETUP_RESOLUTION: {},
    takeViewMorph: () => null,
    supportsViewTransition: false,
    motionReduced: () => true,
    pageCanDraw: () => false,
    nativeStopSurface: null,
    markTreeNodeCommandSurfaceMounted: () => {},
    drainTreeNodeCommands: () => {},
    crumb: null,
    navEl: null,
    ringOrder: () => ['home', 'computers'],
    RING_EXIT: {},
    firstUseGuidance: { visit() {} },
    syncPhoneExampleNotice: () => {},
    isExampleMode: source.isExampleMode,
    currentDataSource: source.currentDataSource,
    resetPersistentVoice: () => {},
    accessibilityControls: {},
    resetCartChanges: () => {},
    // Keep the real router's retirement callback; drain it deterministically.
    // Home's own timers still belong to Home and are cancelled by destroy().
    setTimeout: callback => { retirements.push(callback); return retirements.length },
  }
  router = Function(...Object.keys(bindings), `
    let current = null
    ${routeFactory}
    ${routeMount}
    return {
      render,
      get current() { return current },
      dispose() {
        if (current) retireView(current.el, current.view)
        current = null
      },
    }
  `)(...Object.values(bindings))
  router.render()
  await settle(12)

  return {
    router, stage,
    get historyReads() { return historyReads },
    addUnannouncedRun() {
      entries = [{
        sequence: 2,
        at: '2026-09-06T04:52:00.000Z',
        action: 'agent_session_start',
        sessionId: 'home-after-announcement',
      }, ...entries]
    },
    async announce(why) {
      window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why } }))
      await settle(12)
      flushRetirements()
      await settle(4)
    },
  }
}

async function assertHomeRemount(t, why) {
  const f = await homeFixture(t)
  const original = f.router.current
  assert.equal(original.route.name, 'home')
  assert.equal(original.view.el.isConnected, true)
  assert.ok(original.view.el.classList.contains('home'), 'mount the real Home DOM')
  const runSequences = view => Array.from(view.el.querySelectorAll('.home-run'),
    row => Number(row.dataset.runSequence))
  assert.deepEqual(runSequences(original.view), [1], 'Home must render the initial bridge record')
  const initialReads = f.historyReads

  f.addUnannouncedRun()
  assert.deepEqual(runSequences(original.view), [1], 'a changed fixture record does not repaint Home by itself')
  await f.announce(why)

  const next = f.router.current
  assert.notEqual(next.view, original.view, 'the announcement must rebuild the active Home view')
  assert.equal(next.route.name, 'home')
  assert.notEqual(next.el, original.el, 'the actual router must replace the page wrapper')
  assert.equal(original.el.isConnected, false, 'retire the outgoing wrapper')
  assert.equal(original.view.el.isConnected, false, 'retire the outgoing Home DOM')
  assert.equal(next.view.el.isConnected, true)
  assert.ok(next.view.el.classList.contains('home'), 'the replacement must be the real Home view')
  assert.equal(f.stage.children.length, 1, 'leave exactly one mounted route')
  assert.equal(document.body.dataset.route, 'home')
  assert.ok(f.historyReads > initialReads, 'Home must re-read the run record')
  assert.deepEqual(runSequences(next.view), [2, 1], 'the previously unannounced run must reach the new Home DOM')
}

test('a host announcement remounts real Home through main and refreshes its run rows', async t => {
  await assertHomeRemount(t, 'host')
})

test('an agent-events gap remounts real Home through main and refreshes its run rows', async t => {
  await assertHomeRemount(t, 'agent-events-gap')
})
