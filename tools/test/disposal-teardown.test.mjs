import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const savedDescriptor = (key) => Object.getOwnPropertyDescriptor(globalThis, key)
const restoreDescriptor = (key, descriptor) => descriptor
  ? Object.defineProperty(globalThis, key, descriptor)
  : delete globalThis[key]

function installSurfaceDom() {
  const dom = installDomStandIn(globalThis)
  const descriptors = new Map(['localStorage', 'location', 'CustomEvent', 'fetch', 'mcAgent', 'mcShell'].map(key => [key, savedDescriptor(key)]))
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
  globalThis.location = { hash: '', search: '', hostname: 'localhost' }
  globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
  globalThis.window.document = globalThis.document
  globalThis.document.defaultView = globalThis.window
  globalThis.window.localStorage = globalThis.localStorage
  globalThis.window.location = globalThis.location
  globalThis.window.innerWidth = 390
  globalThis.window.innerHeight = 664
  globalThis.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  globalThis.document.querySelector = selector => globalThis.document.documentElement.querySelector(selector) || globalThis.document.body.querySelector(selector)
  globalThis.document.querySelectorAll = selector => [...globalThis.document.documentElement.querySelectorAll(selector), ...globalThis.document.body.querySelectorAll(selector)]
  globalThis.document.getElementById = id => globalThis.document.querySelector('#' + id)
  globalThis.document.createElementNS = (_namespace, tag) => globalThis.document.createElement(tag)
  return { ...dom, values, restore() {
    dom.restore()
    for (const [key, descriptor] of descriptors) restoreDescriptor(key, descriptor)
  } }
}

test('approvals destroy cancels its pending presentation frame (bad value: no cancelled handle)', { concurrency: false }, async () => {
  const dom = installSurfaceDom()
  try {
    dom.values.set('mc.example', 'on')
    const cancelled = []
    globalThis.requestAnimationFrame = () => 41
    globalThis.cancelAnimationFrame = handle => cancelled.push(handle)
    const { ledgerPromptQueue } = await import('../../src/ledger-prompt-queue.js')
    const view = ledgerPromptQueue()
    view.el.dispatch('scroll')
    view.destroy()
    assert.deepEqual(cancelled, [41], 'bad value [] means destroy forgot the queued approvals frame')
  } finally { dom.restore() }
})

test('settings destroy cancels its pending landing frame (bad value: no cancelled handle)', { concurrency: false }, async () => {
  const dom = installSurfaceDom()
  try {
    const pending = new Map()
    const cancelled = []
    let nextHandle = 52
    globalThis.requestAnimationFrame = callback => {
      const handle = nextHandle++
      pending.set(handle, callback)
      return handle
    }
    globalThis.cancelAnimationFrame = handle => {
      assert.ok(pending.delete(handle), 'cancel must identify a distinct pending frame')
      cancelled.push(handle)
    }
    const { settingsView } = await import('../../src/views/settings.js')
    const view = settingsView({ query: new URLSearchParams({ category: 'write', setting: 'write_agent-session' }) })
    const scheduled = [...pending.keys()]
    assert.ok(scheduled.length >= 2, 'category reveal and targeted landing must both be queued')
    view.destroy()
    assert.equal(pending.size, 0, 'destroy left a settings frame pending')
    assert.deepEqual(cancelled.toSorted((a, b) => a - b), scheduled.toSorted((a, b) => a - b),
      'destroy must cancel every distinct settings frame exactly once')
  } finally { dom.restore() }
})

test('phone canvas destroy cancels its pending sheet frame (bad value: no cancelled handle)', { concurrency: false }, async () => {
  const dom = installSurfaceDom()
  try {
    dom.document.documentElement.setAttribute('data-phone-canvas', 'on')
    const root = dom.document.createElement('main')
    for (const className of ['rail', 'graph-tools', 'comp-body', 'tabs']) {
      const node = dom.document.createElement('div'); node.className = className; root.append(node)
    }
    const cancelled = []
    globalThis.window.requestAnimationFrame = () => 63
    globalThis.window.cancelAnimationFrame = handle => cancelled.push(handle)
    const { mountPhoneCanvas } = await import('../../src/phone-canvas.js')
    const surface = mountPhoneCanvas({ root, doc: dom.document })
    surface.open()
    surface.destroy()
    assert.deepEqual(cancelled, [63], 'bad value [] means destroy forgot the queued phone sheet frame')
  } finally { dom.restore() }
})

test('computers destroy disconnects every mounted graph observer exactly once', { concurrency: false }, async () => {
  const dom = installSurfaceDom()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = new Set()
  globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args)
    intervals.add(handle)
    return handle
  }
  globalThis.clearInterval = handle => { intervals.delete(handle); realClearInterval(handle) }
  try {
    dom.values.set('mc.example', 'on')
    const observers = []
    globalThis.ResizeObserver = class {
      constructor() { this.targets = []; this.disconnects = 0; observers.push(this) }
      observe(target) { this.targets.push(target) }
      disconnect() { this.disconnects += 1 }
    }
    const { computersView } = await import('../../src/views/computers.js')
    const view = computersView({ navigate() {} })
    for (let attempt = 0; attempt < 20 && !view.el.querySelector('.computer-tree-canvas'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const canvas = view.el.querySelector('.computer-tree-canvas')
    assert.ok(canvas, 'the example graph must actually mount before teardown is measured')
    assert.ok(observers.some(observer => observer.targets.includes(canvas)), 'the mounted graph must install a resize observer')
    // The preview fitter owns a reusable observer before cards are shown.
    // It must also be disposed even when this view has no preview targets.
    assert.ok(observers.every(observer => observer.disconnects === 0),
      'no observer may be disposed before the mounted view is destroyed')
    assert.ok(intervals.size > 0, 'the mounted example must start its simulation clock')
    view.destroy()
    assert.equal(intervals.size, 0, 'destroy must stop the example clock immediately, before another view mounts')
    assert.ok(observers.every(observer => observer.disconnects === 1),
      'destroy must disconnect every observer created by the mounted view, including any added later')
  } finally {
    for (const handle of intervals) realClearInterval(handle)
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    dom.restore()
  }
})

test('home destroy leaves no recurring read scheduled (bad value: one timer still live)', { concurrency: false }, async () => {
  /* EVERY RECURRING READ ON HOME IS NOW A SELF-RESCHEDULING TIMEOUT rather than
     a fixed interval -- that is what lets each one carry its own phase and the
     approvals row carry its own back-off. A self-rescheduling loop is exactly
     the shape that survives a teardown when one re-arm is missed, and a home
     view left polling would go on asking the action bridge for the life of the
     window with nothing on screen to show for it. */
  const dom = installSurfaceDom()
  const savedTimers = new Map(['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, savedDescriptor(key)]))
  /* NO FRAMES, ON PURPOSE. installSurfaceDom runs a requestAnimationFrame
     callback SYNCHRONOUSLY, and home's uptime digits re-arm a frame from inside
     their own callback -- so a frame served here recurses until the stack ends.
     Frames are not what this test measures, and home already treats a window
     that is served none as the ordinary covered-window case. */
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const live = new Map()
  let nextHandle = 1
  /* A REAL yield, kept from before the stubs go in. The view's first reads only
     settle on a macrotask turn, and a test that tore the window down while they
     were still in flight would leave them to land on a restored global -- which
     is a failure of the harness, reported against the product. */
  const realYield = () => new Promise(resolve => savedTimers.get('setTimeout').value(resolve, 0))
  const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await realYield() }
  let missionBridge
  try {
    const requests = [], unexpectedFetches = []
    // The view's actual host transport seam returns an owned refusal. The
    // teardown assertion needs mounted polling, without live bridge discovery.
    globalThis.mcShell = { getBridgeTransport: async () => async (...args) => {
      requests.push(args)
      return { ok: false, code: 'BRIDGE_TEST_UNAVAILABLE', reason: 'Owned teardown fixture has no live bridge.' }
    } }
    globalThis.window.mcShell = globalThis.mcShell
    globalThis.fetch = async url => { unexpectedFetches.push(String(url)); throw Error('Teardown fixture must use its declared host transport') }
    missionBridge = await import('../../src/mission-bridge.js')
    missionBridge.setBridgeTransport(null)
    assert.equal(await missionBridge.bridgeTransportAvailable({ reask: true }), true,
      'The owned view must install its explicit host transport before mounting')
    globalThis.setTimeout = (fn, ms) => { const handle = nextHandle++; live.set(handle, { fn, ms }); return handle }
    globalThis.setInterval = (fn, ms) => { const handle = nextHandle++; live.set(handle, { fn, ms }); return handle }
    globalThis.clearTimeout = handle => { live.delete(handle) }
    globalThis.clearInterval = handle => { live.delete(handle) }
    globalThis.mcAgent = { history: async () => ({ ok: true, entries: [] }), availability: async () => ({ ok: true, available: true }), onEvent: () => () => {} }
    globalThis.window.mcAgent = globalThis.mcAgent
    const { resolveDataSource } = await import('../../src/data-source.js')
    await resolveDataSource({ reask: true })
    const { homeView } = await import('../../src/views/home.js')
    const view = homeView()
    dom.document.body.append(view.el)
    await settle()
    assert.ok(live.size > 0, 'the mounted view must have scheduled at least one recurring read for this to prove anything')
    view.destroy()
    await settle()
    assert.deepEqual([...live.values()].map(timer => timer.ms), [],
      'bad value [20000] means the approvals poll re-armed itself after the view was torn down')
    assert.ok(requests.length > 0, 'The mounted home must exercise its actual declared bridge transport')
    assert.deepEqual(unexpectedFetches, [], 'No pending read may fall back to live network discovery before or after teardown')
  } finally {
    missionBridge?.setBridgeTransport(null)
    for (const [key, descriptor] of savedTimers) restoreDescriptor(key, descriptor)
    dom.restore()
  }
})
