import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PRELOAD = resolve(ROOT, 'shell', 'preload.cjs')
const preloadRequire = createRequire(PRELOAD)
const plain = value => JSON.parse(JSON.stringify(value))

function loadPreload({ invoke = (channel, ...args) => ({ channel, args }) } = {}) {
  const exposed = new Map()
  const invokes = []
  const sends = []
  const listeners = new Map()
  const frames = []
  const timers = []
  const appended = []
  const prepended = []
  const htmlClasses = new Set()
  const bodyClasses = new Set()
  const documentElement = {
    dataset: {},
    classList: { add: value => htmlClasses.add(value) },
  }
  const body = {
    classList: { add: value => bodyClasses.add(value) },
    prepend: value => prepended.push(value),
  }
  const document = {
    documentElement,
    body,
    head: { appendChild: value => appended.push(value) },
    createElement: tag => ({ tag, textContent: '', id: '' }),
  }
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push({ channel, args })
      return invoke(channel, ...args)
    },
    send: (channel, payload) => sends.push({ channel, payload }),
  }
  const contextBridge = {
    exposeInMainWorld: (name, value) => exposed.set(name, value),
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe(target, options) { this.target = target; this.options = options }
  }
  const context = {
    clearTimeout() {},
    document,
    getComputedStyle: () => ({ backgroundColor: 'rgb(10, 32, 255)', color: 'rgba(1, 2, 3, 0.8)' }),
    MutationObserver,
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
  }
  const source = readFileSync(PRELOAD, 'utf8')
  vm.runInNewContext(`(function (require) { ${source}\n})`, context, { filename: PRELOAD })(
    id => id === 'electron' ? { contextBridge, ipcRenderer } : preloadRequire(id),
  )
  return { exposed, invokes, sends, listeners, frames, timers, appended, prepended, htmlClasses, bodyClasses, documentElement }
}

test('shell/preload.cjs exposes a bounded main-process bridge with the caller contracts intact', async () => {
  const harness = loadPreload()
  const bridge = harness.exposed.get('mcShell')
  assert.notEqual(bridge, undefined, 'mcShell was not exposed to the renderer')
  assert.equal(bridge.titlebarHeight, 36)

  const request = { displayName: 'Workstation' }
  const calls = [
    ['getBridgeProof', [], 'mc-bridge-proof', []],
    ['getBridgeEndpoint', [], 'mc-bridge-endpoint', []],
    ['checkoutSurface', [], 'mc-checkout:surface', []],
    ['deviceClaim.status', [], 'mc-device-claim:status', []],
    ['deviceClaim.begin', [request], 'mc-device-claim:begin', [request]],
    ['deviceClaim.poll', [], 'mc-device-claim:poll', []],
    ['deviceClaim.cancel', [], 'mc-device-claim:cancel', []],
    ['deviceClaim.disconnect', [], 'mc-device-claim:disconnect', []],
  ]
  for (const [name, args, channel, forwarded] of calls) {
    const method = name.split('.').reduce((value, key) => value[key], bridge)
    assert.deepEqual(await method(...args), { channel, args: forwarded }, `${name} did not return main's answer`)
  }
  assert.deepEqual(harness.invokes, calls.map(([, , channel, args]) => ({ channel, args })),
    'renderer calls must use fixed channels and preserve only the documented arguments')
  assert.equal(Object.isFrozen(bridge.deviceClaim), true, 'the security-sensitive device-claim verb table must be immutable')
})

test('shell/preload.cjs preserves main-process refusals instead of inventing a successful answer', async () => {
  const refusal = new Error('DEVICE_CLAIM_STATUS_UNREADABLE: credential store could not be read')
  const bridge = loadPreload({ invoke: () => Promise.reject(refusal) }).exposed.get('mcShell')

  await assert.rejects(bridge.deviceClaim.status(), error => {
    assert.equal(error, refusal, 'a could-not-read result must remain the main process refusal, including its reason')
    return true
  })
  await assert.rejects(bridge.getBridgeEndpoint(), error => {
    assert.equal(error, refusal, 'an unavailable endpoint must not collapse into a definite endpoint')
    return true
  })
})

test('shell/preload.cjs reports both explicit and default theme states after paint and settle', () => {
  const harness = loadPreload()
  harness.documentElement.dataset.theme = 'dark'
  harness.listeners.get('DOMContentLoaded')()

  assert.deepEqual([...harness.htmlClasses], ['in-shell'])
  assert.deepEqual([...harness.bodyClasses], ['in-shell'])
  assert.equal(harness.prepended[0].id, 'shell-titlebar', 'the shell drag surface must be installed')
  assert.equal(harness.frames.length, 1, 'theme colour must be sampled after the next paint')
  assert.equal(harness.timers[0].delay, 600, 'a settle pass must heal a transition-time sample')

  harness.frames[0]()
  harness.timers[0].callback()
  assert.deepEqual(plain(harness.sends), [
    { channel: 'mc-theme', payload: { theme: 'dark', bg: '#0a20ff', ink: '#010203' } },
    { channel: 'mc-theme', payload: { theme: 'dark', bg: '#0a20ff', ink: '#010203' } },
  ])

  harness.documentElement.dataset.theme = ''
  harness.listeners.get('focus')()
  harness.frames.at(-1)()
  assert.deepEqual(plain(harness.sends.at(-1)), {
    channel: 'mc-theme',
    payload: { theme: 'white', bg: '#0a20ff', ink: '#010203' },
  }, 'absence of a theme selection must report the renderer default rather than stale dark state')
})
