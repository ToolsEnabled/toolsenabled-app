import assert from 'node:assert/strict'
import test from 'node:test'

// Values for the actual profile renderer; this fixture models logical geometry
// and lifecycle only. Rendered Setup layout is measured separately in-browser.
const preferences = new Map([['mc.example', 'on']]), rootStyles = new Map()
const resizeListeners = new Set(), fontListeners = new Set(), observers = []
let height = 95, bottom = 16, gap = 8, display = 'flex', visibility = 'visible'
function element() {
  const attrs = new Map(), classes = new Set()
  return { dataset: {}, children: [], handlers: new Map(), parentNode: null,
    get isConnected() { return Boolean(this.parentNode) }, get offsetHeight() { return display === 'none' ? 0 : height },
    getClientRects() { return display === 'none' ? [] : [{}] },
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, contains: name => classes.has(name) },
    setAttribute(name, value) { attrs.set(name, value) }, getAttribute: name => attrs.get(name) ?? null,
    set textContent(value) { this.text = value; this.children = [] },
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text || '' },
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; for (const child of children) this.appendChild(child) },
    appendChild(child) { child.parentNode = this; this.children.push(child) },
    addEventListener(type, callback) { this.handlers.set(type, callback) },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null },
  }
}
const root = { getAttribute: () => 'on', style: { setProperty: (name, value) => rootStyles.set(name, value), removeProperty: name => rootStyles.delete(name) } }
globalThis.document = { documentElement: root, body: element(),
  querySelector: () => document.body.children.find(child => child.dataset.fleetProfileNotice) || null,
  createElement: element, fonts: { addEventListener: (_, callback) => fontListeners.add(callback), removeEventListener: (_, callback) => fontListeners.delete(callback) } }
globalThis.window = { addEventListener: (_, callback) => resizeListeners.add(callback), removeEventListener: (_, callback) => resizeListeners.delete(callback) }
globalThis.localStorage = { getItem: key => preferences.get(key) ?? null }
globalThis.getComputedStyle = target => target === root ? { getPropertyValue: () => `${gap}px` } : { display, visibility, bottom: `${bottom}px` }
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.connected = false; observers.push(this) }
  observe(target) { this.target = target; this.connected = true }
  disconnect() { this.connected = false }
}
const profile = await import('../../src/fleet-profile.js')
const clearance = () => rootStyles.get('--fleet-profile-notice-clearance') || ''
const active = () => observers.filter(observer => observer.connected)
const resize = () => active().forEach(observer => observer.callback([{ target: observer.target }]))

test('the actual profile notice reserves logical height, actual inset and spacing', () => {
  assert.equal(clearance(), '119px')
  height = 137; bottom = 8; gap = 12; resize()
  assert.equal(clearance(), '157px', 'changed actual values update the reservation')
  assert.equal(active().length, 1)
})
test('font and window resize refresh the same live notice measurement', () => {
  height = 180; for (const callback of fontListeners) callback()
  assert.equal(clearance(), '200px')
  bottom = 20; for (const callback of resizeListeners) callback()
  assert.equal(clearance(), '212px')
  assert.equal(active().length, 1, 'refresh does not allocate another observer')
})
test('hidden and visible notices reserve zero and measured space respectively', () => {
  display = 'none'; resize(); assert.equal(clearance(), '0px')
  display = 'flex'; visibility = 'hidden'; resize(); assert.equal(clearance(), '0px')
  visibility = 'visible'; resize(); assert.equal(clearance(), '212px')
})
test('ordinary close and example removal disconnect measurement and release all listeners', () => {
  const notice = document.querySelector('[data-fleet-profile-notice]')
  notice.children.find(child => child.type === 'button').handlers.get('click')()
  assert.equal(document.querySelector('[data-fleet-profile-notice]'), null)
  assert.equal(clearance(), ''); assert.equal(active().length, 0)
  assert.equal(resizeListeners.size, 0); assert.equal(fontListeners.size, 0)
  assert.equal(preferences.get('mc.example'), 'on')
  profile.syncPhoneExampleNotice(); assert.equal(active().length, 1)
  const same = document.querySelector('[data-fleet-profile-notice]')
  profile.syncPhoneExampleNotice(); assert.equal(document.querySelector('[data-fleet-profile-notice]'), same)
  assert.equal(active().length, 1); assert.equal(resizeListeners.size, 1); assert.equal(fontListeners.size, 1)
  preferences.delete('mc.example'); profile.syncPhoneExampleNotice()
  assert.equal(clearance(), ''); assert.equal(active().length, 0)
  assert.equal(resizeListeners.size, 0); assert.equal(fontListeners.size, 0)
})
