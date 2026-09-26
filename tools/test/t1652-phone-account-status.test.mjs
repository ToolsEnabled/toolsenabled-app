/* T1616: an unavailable account is an unknown state, not signed out. Keep the
 * door and the mounted ledger on the same distinction that account-state.js
 * already returns for a hosted 503. */

import { strict as assert } from 'node:assert'
import { register } from 'node:module'
import { test } from 'node:test'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const { installWorld, mountView, settle, fleetFetch } = await import('./lib/tree-command-real-mount.mjs')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { resolveDataSource, setExampleMode } = await import('../../src/data-source.js')

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.textContent = ''
    this.href = ''
    this.tabIndex = undefined
    this.type = ''
    this.style = { setProperty() {}, removeProperty() {} }
    const node = this
    this.classList = {
      values: () => String(node.className || '').split(/\s+/).filter(Boolean),
      contains(name) { return this.values().includes(name) },
      add(...names) { node.className = [...new Set([...this.values(), ...names])].join(' ') },
      remove(...names) { node.className = this.values().filter(name => !names.includes(name)).join(' ') },
    }
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.append(...nodes)
  }
  remove() {
    if (!this.parentNode) return
    const index = this.parentNode.children.indexOf(this)
    if (index >= 0) this.parentNode.children.splice(index, 1)
    this.parentNode = null
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  matches(selector) {
    return selector.startsWith('.') && this.classList.contains(selector.slice(1))
  }
  querySelectorAll(selector) {
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function fakeDoc() {
  const documentElement = new FakeNode('html')
  documentElement.setAttribute('data-phone-canvas', 'on')
  return {
    documentElement,
    createElement: tag => new FakeNode(tag),
    defaultView: {
      location: { search: '' },
      localStorage: { getItem: () => null, setItem() {} },
    },
  }
}

function fakeRoot(doc) {
  const root = doc.createElement('div')
  root.className = 'computers'
  const slot = doc.createElement('div')
  slot.className = 'graph-canvas-slot'
  root.append(slot)
  return root
}

const unavailable = Object.freeze({
  available: false,
  signedIn: false,
  code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE',
  reason: 'The account service did not answer.',
})
/* This is the hosted bridge's actual 401 reply. `signedOut` below is the
 * already-normalized state used by the direct door test; mounted tests must
 * exercise the bridge boundary instead of feeding that projection back in. */
const signedOutReply = Object.freeze({ signedIn: false })
const signedOut = Object.freeze({ available: true, signedIn: false, code: null })

test('the shared account door distinguishes hosted unavailable from a confirmed 401 sign-out', async () => {
  const { buildSignInDoor, phoneLedgerNeedsSignIn } = await import('../../src/phone-ledger.js')
  assert.equal(phoneLedgerNeedsSignIn({ available: false, signedIn: false, source: 'mock', exampleChosen: true }), false,
    'an explicitly chosen mock remains available while the real account service is unknown')
  assert.equal(phoneLedgerNeedsSignIn({ available: false, signedIn: false, source: 'relay', exampleChosen: true }), true,
    'unavailable real data remains gated and is never treated as signed out')
  const doc = fakeDoc()
  let state = unavailable
  let retries = 0
  const door = buildSignInDoor(doc, {
    authStateFn: () => state,
    onRetryAuth: () => { retries += 1 },
  })

  door.refreshAuth()
  assert.match(door.querySelector('.phone-ledger-door-sentence').textContent, /could not be checked/i)
  assert.doesNotMatch(door.querySelector('.phone-ledger-door-sentence').textContent, /signed out|sign in/i)
  assert.equal(door.querySelector('.phone-ledger-door-signin').hidden, true)
  const retry = door.querySelector('.phone-ledger-door-retry')
  assert.ok(retry, 'unknown account state must offer a retry action')
  retry.listeners.get('click')[0]()
  assert.equal(retries, 1)

  state = signedOut
  door.refreshAuth()
  assert.match(door.querySelector('.phone-ledger-door-sentence').textContent, /sign in/i)
  assert.equal(door.querySelector('.phone-ledger-door-signin').hidden, false)
  assert.equal(retry.hidden, true, 'a confirmed signed-out state must not show the unavailable retry')
})

test('a mounted explicit mock stays read-only during 503 while real data remains gated', async () => {
  const { mountPhoneLedger } = await import('../../src/phone-ledger.js')
  const mockDoc = fakeDoc()
  const mockRoot = fakeRoot(mockDoc)
  const mockMounted = mountPhoneLedger({
    root: mockRoot,
    doc: mockDoc,
    computerFn: () => ({ agents: [{ id: 'demo', name: 'Demo agent', role: 'default', state: 'finished', parentId: null }] }),
    signedInFn: () => false,
    sourceFn: () => 'mock',
    exampleChosenFn: () => true,
    authStateFn: () => unavailable,
  })
  mockMounted.refresh()
  assert.equal(mockRoot.querySelectorAll('.phone-ledger-row').length, 1,
    'an explicitly chosen example remains visible when the account read is unavailable')
  assert.equal(mockRoot.querySelector('.phone-ledger-door'), null,
    'the read-only example must not show the account door during a hosted 503')
  mockMounted.destroy()

  const realDoc = fakeDoc()
  const realRoot = fakeRoot(realDoc)
  const realMounted = mountPhoneLedger({
    root: realRoot,
    doc: realDoc,
    computerFn: () => ({ agents: [{ id: 'real', name: 'Real agent', role: 'default', state: 'finished', parentId: null }] }),
    signedInFn: () => false,
    sourceFn: () => 'relay',
    exampleChosenFn: () => true,
    authStateFn: () => unavailable,
  })
  realMounted.refresh()
  assert.equal(realRoot.querySelectorAll('.phone-ledger-row').length, 0,
    'unavailable real data must remain gated even when the example flag is set')
  assert.ok(realRoot.querySelector('.phone-ledger-door'))
  realMounted.destroy()
})

const signedInReply = Object.freeze({
  ok: true,
  signedIn: true,
  account: { id: 'a'.repeat(32), username: 'owner', displayName: 'Owner', createdAt: '2026-09-14T00:00:00Z' },
})

function fleetReply() {
  return {
    ok: true,
    mayWrite: true,
    desktopTree: {
      version: 1,
      computerId: 'this-computer',
      trees: [{ id: 'tree-t1652', name: 'T1652' }],
      nodes: [{ id: 'node-t1652', treeId: 'tree-t1652', parentId: null, role: 'worker', name: 'Agent T1652', status: 'finished', sessionId: 'session-t1652' }],
    },
    sessions: [{ sessionId: 'session-t1652', nodeId: 'node-t1652', busy: false }],
    sessionsTruncated: false,
  }
}

async function mountedAccountSurface(t, { ledger, initialReply }) {
  const fleet = fleetFetch()
  const world = await installWorld({ fetch: fleet.fetch }, { asyncFrames: true })
  const priorAccount = Object.getOwnPropertyDescriptor(globalThis, 'mcAccount')
  const queuedCurrent = []
  let currentReply = initialReply
  let currentReads = 0
  globalThis.mcAccount = window.mcAccount = {
    signIn: async () => ({ ok: false }),
    availability: async () => ({ ok: true, accountCount: 1 }),
    current: async () => {
      currentReads += 1
      return queuedCurrent.length ? await queuedCurrent.shift() : currentReply
    },
  }
  document.documentElement.setAttribute('data-phone-canvas', 'on')
  window.location.search = ''
  world.storage.setItem('mc.phoneLedger', ledger ? 'on' : 'off')
  window.mcDesktopTree = { read: async () => fleetReply() }
  window.mcDesktopSessions = { list: async () => ({ ok: true, mayWrite: true, sessions: [], truncated: false }) }
  world.bridge.onEvent = () => () => {}
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  setBridgeTransport(async () => ({ ok: false, reason: 'No fleet fixture.' }))
  /* Prevent the data-source resolver from turning the deliberate 401 case into
   * its signed-out example seed. The mounted view still receives the real
   * account reply and must render its own 401 door. */
  setExampleMode(false)
  await resolveDataSource({ reask: true })
  const view = await mountView(world)
  t.after(async () => {
    view.destroy()
    view.el.remove()
    if (priorAccount) Object.defineProperty(globalThis, 'mcAccount', priorAccount)
    else delete globalThis.mcAccount
    delete window.mcAccount
    delete window.mcDesktopTree
    delete window.mcDesktopSessions
    setBridgeTransport(null)
    world.restore()
  })
  await settle()
  return {
    view,
    world,
    currentReads: () => currentReads,
    setReply: reply => { currentReply = reply },
    queueReply: reply => { queuedCurrent.push(reply) },
    resolveQueued: resolve => resolve(),
    settle: () => settle(),
  }
}

test('the mounted ledger keeps a hosted 503 distinct from 401 and retry recovers real rows', async t => {
  const f = await mountedAccountSurface(t, { ledger: true, initialReply: { ok: false, code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE' } })
  const door = f.view.el.querySelector('.phone-ledger-door')
  assert.ok(door, 'the real mounted ledger must show its account door')
  assert.match(door.querySelector('.phone-ledger-door-sentence').textContent, /could not be checked/i)
  assert.ok(door.querySelector('.phone-ledger-door-retry'))
  const readsBeforeRetry = f.currentReads()
  f.setReply(signedInReply)
  door.querySelector('.phone-ledger-door-retry').click()
  await f.settle()
  assert.equal(f.currentReads(), readsBeforeRetry + 1, 'Retry must re-read the authoritative account bridge')
  assert.equal(f.view.el.querySelectorAll('.phone-ledger-row').length, 1, 'a confirmed account read must recover the real ledger rows')

  f.setReply(signedOutReply)
  const readsBefore401 = f.currentReads()
  window.dispatchEvent(new CustomEvent('mc:data-source-changed', { detail: { why: 'signed-out' } }))
  await f.settle()
  assert.equal(f.currentReads(), readsBefore401 + 1, 'the signed-out transition must re-read the authoritative account bridge')
  const signedOutDoor = f.view.el.querySelector('.phone-ledger-door')
  assert.ok(signedOutDoor)
  assert.match(signedOutDoor.querySelector('.phone-ledger-door-sentence').textContent, /sign in/i)
  assert.equal(signedOutDoor.querySelector('.phone-ledger-door-retry').hidden, true, '401 must hide the unavailable retry on the retained door')
  assert.equal(signedOutDoor.querySelector('.phone-ledger-door-signin').hidden, false, '401 must show the sign-in action')
})

test('the mounted graph Retry re-reads the bridge and restores the real graph after 503', async t => {
  const f = await mountedAccountSurface(t, { ledger: false, initialReply: { ok: false, code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE' } })
  const door = f.view.el.querySelector('.phone-ledger-door')
  assert.ok(door, 'the real mounted graph must show its account door')
  const readsBeforeRetry = f.currentReads()
  f.setReply(signedInReply)
  door.querySelector('.phone-ledger-door-retry').click()
  await f.settle()
  assert.equal(f.currentReads(), readsBeforeRetry + 1, 'graph Retry must re-read the authoritative account bridge')
  assert.equal(f.view.el.classList.contains('phone-graph-auth-required'), false,
    'a confirmed account read must remove the graph account gate')
  assert.equal(door.hidden, true, 'the graph account door must hide after authenticated recovery')
  assert.ok(f.view.el.querySelector('.graph-canvas'), 'authenticated recovery must restore the real graph surface')
})

test('the mounted graph keeps the same 503/401 distinction and fences an older retry completion', async t => {
  let releaseOld
  const oldReply = new Promise(resolve => { releaseOld = resolve })
  const f = await mountedAccountSurface(t, { ledger: false, initialReply: { ok: false, code: 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE' } })
  const unavailableDoor = f.view.el.querySelector('.phone-ledger-door')
  assert.ok(unavailableDoor, 'the real mounted graph must show its account door')
  assert.ok(unavailableDoor.querySelector('.phone-ledger-door-retry'))
  t.after(() => { releaseOld?.(signedOutReply) })

  f.queueReply(oldReply)
  unavailableDoor.querySelector('.phone-ledger-door-retry').click()
  f.queueReply(signedOutReply)
  unavailableDoor.querySelector('.phone-ledger-door-retry').click()
  await f.settle()
  releaseOld(signedInReply)
  await f.settle()
  const signedOutDoor = f.view.el.querySelector('.phone-ledger-door')
  assert.ok(signedOutDoor, 'the newer 401 result must keep the graph gated')
  assert.match(signedOutDoor.querySelector('.phone-ledger-door-sentence').textContent, /sign in/i)
  assert.equal(signedOutDoor.querySelector('.phone-ledger-door-retry').hidden, true, 'the newer 401 must keep retry hidden')
  assert.equal(signedOutDoor.querySelector('.phone-ledger-door-signin').hidden, false, 'the stale authenticated completion must not hide sign-in')
})
