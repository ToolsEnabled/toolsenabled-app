/* The checkout is a view, so exercise the controls and words its caller receives. */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.listeners = new Map()
    this._text = ''
  }
  get childElementCount() { return this.children.length }
  get isConnected() { return Boolean(this.parentNode?.isConnected) }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this._text = String(value); this.children = [] }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child) } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name) }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  click() { if (!this.disabled) for (const listener of this.listeners.get('click') || []) listener() }
  querySelector(selector) { return walk(this).find(element => element !== this && matches(element, selector)) || null }
  querySelectorAll(selector) { return walk(this).filter(element => element !== this && matches(element, selector)) }
}

function walk(root) { return [root, ...root.children.flatMap(walk)] }
function matches(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1))
  const data = /^\[data-([a-z-]+)(?:="([^"]+)")?\]$/.exec(selector)
  if (data) {
    const key = data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    return Object.hasOwn(element.dataset, key) && (data[2] === undefined || element.dataset[key] === data[2])
  }
  return element.tagName === selector.toUpperCase()
}

function checkoutRoot() {
  const root = new FakeElement('main')
  root.className = 'view-pad checkout-page'
  const lede = new FakeElement('p'); lede.className = 'checkout-lede'
  const provenance = new FakeElement('p'); provenance.dataset.provenance = ''
  const cap = new FakeElement('p'); cap.dataset.capSource = ''
  const stage = new FakeElement('div'); stage.dataset.stage = ''
  root.append(lede, provenance, cap, stage)
  root.parentNode = { isConnected: true }
  return root
}

globalThis.document = {
  createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node },
  createElement(tag) {
    if (tag !== 'template') return new FakeElement(tag)
    const template = { content: { firstElementChild: null } }
    Object.defineProperty(template, 'innerHTML', { set() { template.content.firstElementChild = checkoutRoot() } })
    return template
  },
}

const baseItem = {
  id: 'quoted-item', name: 'Quoted item', vendor: 'Fixture vendor', category: 'required-to-ship', cadence: 'one-off',
  firstYearUsd: 25, renewalUsd: null, priceVerified: true, priceVerifiedDate: '2026-08-25', quantityMax: 1,
  defaultSelected: false, whatItIs: 'A priced fixture.', whatBreaksWithout: 'The fixture cannot ship.',
  whyHeWantedIt: 'To prove checkout controls.', sourceUrl: null, warning: null, blockers: [], notes: null,
}

function catalog(items) {
  return {
    version: 2, generatedAt: '2026-08-25T12:00:00.000Z', currency: 'USD',
    spendPolicy: { dailyLimitUsd: 100, source: 'fixture policy', readAt: '2026-08-25T12:00:00.000Z' },
    categories: [{ id: 'required-to-ship', label: 'Required', blurb: 'Required fixture items.' }], items,
  }
}

async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve() }

const { checkoutView } = await import('../../src/views/checkout.js')

test('a catalogue read failure is reported as unknown rather than an empty or usable shop', async () => {
  globalThis.fetch = async url => {
    if (url === 'data/purchase-catalog.json') throw new Error('fixture catalogue outage')
    throw new Error('fixture service outage')
  }
  const view = checkoutView()
  await settle()
  const stage = view.el.querySelector('[data-stage]')
  assert.match(stage.textContent, /could not be read/i,
    'an unreadable catalogue must produce the view\'s explicit could-not-read state')
  assert.match(stage.textContent, /nothing is being shown rather than a partial list/i,
    'a failed read must refuse to imply that an empty result is a complete catalogue')
  assert.equal(stage.querySelectorAll('button').length, 0,
    'a failed catalogue read must not leave an actionable checkout control')
  view.destroy()
})

test('selectability controls both enabled readings and gives an impossible choice its reason', async () => {
  const unpriced = { ...baseItem, id: 'unpriced-item', name: 'Unpriced item', firstYearUsd: null,
    priceVerified: false, priceVerifiedDate: null }
  globalThis.fetch = async url => url === 'data/purchase-catalog.json'
    ? { ok: true, json: async () => catalog([baseItem, unpriced]) }
    : (() => { throw new Error('fixture service outage') })()
  const view = checkoutView()
  await settle()
  const pricedControl = view.el.querySelector('[data-item-id="quoted-item"]').querySelector('.checkout-pick')
  const impossibleControl = view.el.querySelector('[data-item-id="unpriced-item"]').querySelector('.checkout-pick')
  assert.equal(pricedControl.disabled, false, 'a quoted selectable item must remain available to choose')
  assert.equal(impossibleControl.disabled, true, 'an item with no definite price must not be choosable')
  assert.match(impossibleControl.title, /no quote yet.*cannot be added to a total/i,
    'the disabled choice must carry the producer-provided reason it cannot succeed')
  view.destroy()
})

test('a selected blocked item remains visibly refused through the running control and review', async () => {
  const reason = 'A verified legal name is required before this can be bought.'
  const blocked = { ...baseItem, id: 'blocked-item', name: 'Blocked item',
    blockers: [{ code: 'LEGAL_NAME', summary: reason, severity: 'blocking' }] }
  globalThis.fetch = async url => url === 'data/purchase-catalog.json'
    ? { ok: true, json: async () => catalog([blocked]) }
    : (() => { throw new Error('fixture service outage') })()
  const view = checkoutView()
  await settle()
  view.el.querySelector('.checkout-pick').click()
  const bar = view.el.querySelector('.checkout-bar')
  assert.equal(bar.dataset.blocked, 'true', 'the running checkout control must expose that a selected line is blocked')
  assert.match(bar.textContent, /1 of your 1 choice cannot safely be bought yet/i,
    'the running control must state the consequence of the refusal')
  const review = view.el.querySelectorAll('button').find(button => /review my choices/i.test(button.textContent))
  review.click()
  assert.match(view.el.querySelector('[data-stage]').textContent, new RegExp(reason),
    'review must preserve the producer-provided reason for every selected blocked line')
  view.destroy()
})
