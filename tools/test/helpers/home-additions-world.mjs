import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fleetFetch, installWorld, seedTreeNode, settle } from '../lib/tree-command-real-mount.mjs'

register('./css-stub-loader.mjs', import.meta.url)
const { homeView } = await import('../../../src/views/home.js')
const { mountFirstUseGuidance } = await import('../../../src/first-use-guidance.js')
const { resolveDataSource, setExampleMode, currentDataSource } = await import('../../../src/data-source.js')
const { THIS_COMPUTER_ID, THIS_COMPUTER_LABEL } = await import('../../../src/declared-fleet.js')
const { fleetTreesStorageKey } = await import('../../../src/fleet-trees.js')
const { isSampleFleet } = await import('../../../src/fleet-profile.js')

// Real Home -> layout -> workspace -> Computers compose; bridge calls are inert.
// Geometry models visibility only: this suite is not browser/physical acceptance.
export async function homeFixture(t, { source = 'local' } = {}) {
  const world = await installWorld(fleetFetch())
  const held = [], views = new Set(), guides = new Set(), guideHosts = new Set()
  const replace = (object, key, descriptor) => {
    const previous = Object.getOwnPropertyDescriptor(object, key)
    held.push(() => previous ? Object.defineProperty(object, key, previous) : delete object[key])
    Object.defineProperty(object, key, { configurable: true, ...descriptor })
  }
  t.after(async () => {
    for (const guide of guides) guide.destroy()
    for (const host of guideHosts) host.remove()
    for (const view of views) { view.destroy(); view.el.remove() }
    await settle(8)
    for (const restore of held.reverse()) restore()
    world.restore()
  })
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const proto = Object.getPrototypeOf(document.createElement('div'))
  // The base stand-in bubbles events but omits currentTarget. Supply that
  // browser contract locally so stale-root protection is tested, not bypassed.
  const add = proto.addEventListener, remove = proto.removeEventListener
  const listeners = new WeakMap()
  replace(proto, 'addEventListener', { value(type, listener, ...options) {
    if (!listeners.has(listener)) listeners.set(listener, function (event) {
      const previous = event.currentTarget
      event.currentTarget = this
      try { return listener.call(this, event) } finally { event.currentTarget = previous }
    })
    return add.call(this, type, listeners.get(listener), ...options)
  } })
  replace(proto, 'removeEventListener', { value(type, listener, ...options) {
    return remove.call(this, type, listeners.get(listener) || listener, ...options)
  } })
  // Reflect the browser hidden property in attributes, so the production guide's
  // closest('[hidden]') and rect checks see actual ancestor visibility.
  replace(proto, 'hidden', {
    get() { return this.attributes.has('hidden') },
    set(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden') },
  })
  const exposed = element => {
    for (let node = element; node; node = node.parentNode) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.style?.display === 'none') return false
    }
    return element.isConnected
  }
  replace(proto, 'getClientRects', { value() { return exposed(this) ? [this.getBoundingClientRect()] : [] } })
  replace(proto, 'getBoundingClientRect', { value() {
    return this.classList.contains('first-use-layer')
      ? { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }
      : { x: 40, y: 100, left: 40, top: 100, right: 400, bottom: 250, width: 360, height: 150 }
  } })
  replace(proto, 'setSelectionRange', { value(start, end) { this.selectionStart = start; this.selectionEnd = end } })
  replace(globalThis, 'getComputedStyle', { value: element => ({
    display: element.style?.display || 'block', visibility: element.style?.visibility || 'visible', opacity: '1',
  }) })
  let accountId = 'a'.repeat(32)
  const account = { current: async () => ({ signedIn: true, account: { id: accountId }, session: { issuedAtMs: 100 } }) }
  replace(globalThis, 'mcAccount', { value: account, writable: true })
  window.mcAccount = account
  replace(globalThis, 'Event', { value: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options) } } })
  replace(proto, 'options', { get() { return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined } })
  const effects = { start: 0, send: 0 }
  world.bridge.start = async () => { effects.start++; return { ok: false, code: 'FIXTURE_START_REFUSED' } }
  world.bridge.send = async () => { effects.send++; return { ok: false, code: 'FIXTURE_SEND_REFUSED' } }
  world.bridge.history = async () => ({ ok: true, entries: [], total: 0, verified: true })
  replace(globalThis, 'mcAgent', { value: world.bridge, writable: true })
  world.storage.setItem('mc.write.agent-session', 'disabled')
  if (source === 'relay') {
    const remoteShell = { getBridgeTransport: async () => null }
    window.mcShell = remoteShell
    globalThis.mcShell = remoteShell
  }
  setExampleMode(source === 'mock')
  await resolveDataSource({ reask: true })
  assert.equal(currentDataSource(), source, 'fixture source must resolve before mounting Home')
  assert.equal(isSampleFleet(), true, 'no owner fleet profile participates in this fixture')
  location.hash = '#/home'
  async function mount() {
    const view = homeView()
    views.add(view); document.body.appendChild(view.el)
    await settle(16)
    return view
  }
  async function open(view) {
    view ||= await mount()
    view.el.querySelector('[data-chat-expand]').click()
    await settle(16)
    assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, false)
    return view
  }
  function guide(view) {
    const entryHost = document.createElement('div'); document.body.appendChild(entryHost); guideHosts.add(entryHost)
    const storage = { getItem: () => JSON.stringify({ version: 1, quiet: true, seen: {} }), setItem() {} }
    const controller = mountFirstUseGuidance({ entryHost, storage })
    guides.add(controller)
    const layer = document.querySelector('.first-use-layer')
    layer.clientWidth = 1280; layer.clientHeight = 800
    controller.visit('home', view.el)
    entryHost.querySelector('#page-guide').click()
    return { layer, next: () => layer.querySelector('.first-use-next').click() }
  }
  async function close(view) {
    view.destroy(); view.el.remove(); views.delete(view)
    await settle(8)
  }
  async function changeSource(next) {
    source = next
    if (source === 'relay') window.mcShell = { getBridgeTransport: async () => null }
    else window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }), getBridgeTransport: async () => null }
    globalThis.mcShell = window.mcShell
    setExampleMode(source === 'mock')
    await resolveDataSource({ reask: true })
    assert.equal(currentDataSource(), source)
  }
  return { world, mount, open, close, guide, effects, exposed, changeSource,
    changeAccount: id => { accountId = id } }

}

export function options(view) { return [...view.el.querySelectorAll('[data-chat-subject] option')] }
export function choose(view, value) {
  const picker = view.el.querySelector('[data-chat-subject]')
  assert.ok(options(view).some(option => option.value === value), 'requested subject is offered')
  picker.value = value; picker.dispatch('change')
}
export async function until(read, message) {
  // Bound: 500 event-loop turns, matching the existing real Home route fixture.
  for (let turn = 0; turn < 500; turn++) {
    const result = read()
    if (result) return result
    await settle(1)
  }
  assert.fail(message)
}


export { settle, THIS_COMPUTER_ID, THIS_COMPUTER_LABEL, fleetTreesStorageKey }
