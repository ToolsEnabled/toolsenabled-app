import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { setBridgeTransport, bridgeTransportAvailable } from '../../src/mission-bridge.js'

let sequence = 0
const cleanups = []
afterEach(() => { setBridgeTransport(null); for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function fixture({ current = async () => ({ signedIn: true }), offer = async () => null, example = false } = {}) {
  const priorWindow = globalThis.window, priorStorage = globalThis.localStorage
  const values = new Map(example ? [['mc.example', 'on']] : [])
  const listeners = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const scope = {
    mcAccount: { current }, mcShell: { getBridgeTransport: offer },
    addEventListener(type, fn) { const entries = listeners.get(type) || []; entries.push(fn); listeners.set(type, entries) },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true },
  }
  globalThis.window = scope
  setBridgeTransport(null)
  const source = await import(new URL(`../../src/data-source.js?hosted-recovery=${++sequence}`, import.meta.url).href)
  cleanups.push(() => { globalThis.window = priorWindow; globalThis.localStorage = priorStorage })
  return { scope, source, change(why) { setBridgeTransport(null); scope.dispatchEvent({ type: source.DATA_SOURCE_EVENT, detail: { why } }) } }
}

test('signed-in hosted source remains real when its first transport offer fails', async () => {
  let calls = 0
  const f = await fixture({ offer: async () => { calls++; throw new Error('temporary handshake failure') } })
  assert.equal(await f.source.resolveDataSource(), 'relay')
  assert.equal(f.source.currentDataSource(), 'relay')
  assert.equal(f.source.isExampleMode(), false)
  assert.equal(f.source.sourceIsBadged(), false)
  assert.equal(calls, 1)
})

test('an unavailable account and relay do not become invented example agents', async () => {
  const f = await fixture({ current: async () => { throw new Error('account unavailable') } })
  assert.equal(await f.source.resolveDataSource(), 'relay')
  assert.equal(f.source.isExampleMode(), false)
})

test('a later normal source read can adopt a recovered transport without reloading the page', async () => {
  let calls = 0
  const realTransport = async () => ({ ok: true })
  const f = await fixture({ offer: async () => ++calls === 1 ? null : realTransport })
  assert.equal(await f.source.resolveDataSource(), 'relay')
  assert.equal(await f.source.resolveDataSource(), 'relay')
  assert.equal(await bridgeTransportAvailable(), true)
  assert.equal(calls, 2)
})

test('a host seam that arrives after the first ask can still be adopted', async () => {
  const f = await fixture()
  delete f.scope.mcShell.getBridgeTransport
  assert.equal(await bridgeTransportAvailable(), false)
  f.scope.mcShell.getBridgeTransport = async () => async () => ({ ok: true })
  assert.equal(await bridgeTransportAvailable(), true)
})

test('a deliberately chosen Example stays a demo without opening a real transport', async () => {
  let calls = 0
  const f = await fixture({ example: true, offer: async () => { calls++; return null } })
  assert.equal(await f.source.resolveDataSource(), 'mock')
  assert.equal(f.source.exampleWasChosen(), true)
  assert.equal(calls, 0)
})

test('a confirmed signed-out visitor still receives the default demo', async () => {
  let calls = 0
  const f = await fixture({ current: async () => ({ signedIn: false }), offer: async () => { calls++; return null } })
  assert.equal(await f.source.resolveDataSource(), 'mock')
  assert.equal(f.source.exampleIsSignedOutDefault(), true)
  assert.equal(calls, 0)
})

test('late signed-out account answer cannot seed a demo after a newer sign-in event', async () => {
  const gate = deferred()
  let first = true
  const f = await fixture({ current: async () => { if (first) { first = false; return gate.promise } return { signedIn: true } } })
  const reading = f.source.resolveDataSource()
  f.change('signed-in')
  gate.resolve({ signedIn: false })
  assert.equal(await reading, 'relay')
  assert.equal(f.source.isExampleMode(), false)
})

test('late remote result cannot override a newer sign-out or explicit Example', async () => {
  for (const boundary of ['signout', 'example']) {
    const gate = deferred()
    let signedIn = true
    const f = await fixture({ current: async () => ({ signedIn }), offer: async () => gate.promise })
    const reading = f.source.resolveDataSource()
    await new Promise(resolve => setImmediate(resolve))
    if (boundary === 'signout') { signedIn = false; f.change('signed-out') }
    else f.source.setExampleMode(true)
    gate.resolve(async () => ({ ok: true }))
    assert.equal(await reading, 'mock')
    assert.equal(f.source.currentDataSource(), 'mock')
  }
})

test('concurrent recovery readers share one handshake and stale source cannot adopt it', async () => {
  const gate = deferred()
  let calls = 0
  const f = await fixture({ offer: async () => { calls++; return gate.promise } })
  const one = bridgeTransportAvailable(), two = bridgeTransportAvailable()
  f.change('account-session-changed')
  gate.resolve(async () => ({ ok: true }))
  assert.deepEqual(await Promise.all([one, two]), [false, false])
  assert.equal(calls, 1)
})
