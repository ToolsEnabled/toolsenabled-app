/* A REFUSAL BANNER AND A LIVE QUEUE MAY NEVER BE ON SCREEN TOGETHER.
 *
 * This is deliberately a DOM drive. The view's stylesheet imports are made
 * inert by the repository's CSS loader, and the small document stand-in below
 * lets the real polling and reconciliation code run. That matters here: a
 * source-text description of the repair would reject an equivalent, better
 * implementation while making reinstating the defect the shortest fix.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as defer } from 'node:timers/promises'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

class FakeStyle {
  constructor() { this.values = new Map() }
  setProperty(name, value) { this.values.set(name, String(value)) }
}

class FakeElement {
  constructor(documentRef, tagName = 'div') {
    this.ownerDocument = documentRef
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = new FakeStyle()
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.offsetParent = {}
    this.listeners = new Map()
    this._text = ''
  }
  get firstElementChild() { return this.children[0] || null }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : false }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this._text = String(value); this.children = [] }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node) } }
  appendChild(node) { this.append(node); return node }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes) }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener)) }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  getBoundingClientRect() { return { width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400 } }
  querySelector(selector) { return walk(this).find(node => node !== this && matches(node, selector)) || null }
  querySelectorAll(selector) { return walk(this).filter(node => node !== this && matches(node, selector)) }
}

function walk(root) { return [root, ...root.children.flatMap(walk)] }

function matches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
  const data = /^\[data-([a-z-]+)(?:="([^"]+)")?\]$/.exec(selector)
  if (data) {
    const key = data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    return Object.hasOwn(node.dataset, key) && (data[2] === undefined || node.dataset[key] === data[2])
  }
  if (selector === 'button') return node.tagName === 'BUTTON'
  return false
}

function node(documentRef, className = '', dataset = {}) {
  const element = new FakeElement(documentRef)
  element.className = className
  Object.assign(element.dataset, dataset)
  return element
}

function approvalsRoot(documentRef) {
  const root = node(documentRef, 'view-pad ledger-prompt-queue')
  root.append(
    node(documentRef, 'approvals-list owner-popup-root'),
    node(documentRef, '', { approvalsBadge: '' }),
    node(documentRef, '', { approvalsSource: '' }),
    node(documentRef, '', { summary: 'waiting' }),
    node(documentRef, '', { summary: 'purchases' }),
    node(documentRef, '', { purchaseNote: '' }),
    node(documentRef, '', { visibleCount: '' }),
    node(documentRef, '', { summary: 'deadline' }),
    node(documentRef, '', { deadlineNote: '' }),
    node(documentRef, '', { changes: '' }),
    node(documentRef, '', { changesList: '' }),
    node(documentRef, '', { changesNote: '' }),
  )
  return root
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html')
    this.documentElement.dataset.theme = 'white'
    this.documentElement.parentNode = { isConnected: true }
    this.activeElement = null
    this.defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }
  }
  createElement(tagName) {
    if (tagName !== 'template') return new FakeElement(this, tagName)
    const template = new FakeElement(this, 'template')
    template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', { set: markup => {
      if (markup.includes('ledger-prompt-queue')) template.content.firstElementChild = approvalsRoot(this)
      else {
        const element = new FakeElement(this)
        element.className = /class="([^"]*)"/.exec(markup)?.[1] || ''
        template.content.firstElementChild = element
      }
    } })
    return template
  }
  hasFocus() { return true }
}

function themeManifest() {
  const palette = suffix => ({
    bg: `bg-${suffix}`, bg2: `bg2-${suffix}`, surface: `surface-${suffix}`, sheet: `sheet-${suffix}`,
    ink: `ink-${suffix}`, ink2: `ink2-${suffix}`, ink25: `ink25-${suffix}`, ink3: `ink3-${suffix}`,
    line: `line-${suffix}`, line2: `line2-${suffix}`, good: `good-${suffix}`, serious: `serious-${suffix}`,
  })
  return {
    schemaVersion: 1,
    defaultTheme: 'white',
    fonts: { ui: 'Fixture UI', mono: 'Fixture Mono', nativeUiFamilies: ['Fixture UI'], nativeMonoFamilies: ['Fixture Mono'] },
    metrics: { radiusSmall: 2, radiusMedium: 3, radiusLarge: 4, space1: 4, space2: 8, space3: 12, space4: 16, space5: 24 },
    common: { accent: 'accent', accentFloor: 'accent-floor', focus: 'focus', onAccent: 'on-accent' },
    roles: { coordinator: 'coordinator', helper: 'helper', shadow: 'shadow', manager: 'manager' },
    themes: { white: palette('white'), tan: palette('tan'), black: palette('black') },
  }
}

function successfulSnapshot() {
  return {
    ok: true,
    schemaVersion: 1,
    generatedAt: '2026-08-25T12:00:00.000Z',
    theme: themeManifest(),
    prompts: [{
      id: 'notice-1', kind: 'notice', title: 'Review finished', message: 'The requested review is ready.',
      createdAt: '2026-08-25T11:55:00.000Z', expiresAt: '2026-08-26T12:00:00.000Z',
      state: 'pending', defaultDecision: 'acknowledge',
    }],
  }
}

async function settle() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); await defer() }

test('a recovered queue replaces the refusal banner rather than appearing beneath it', async () => {
  const originals = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  }
  const documentRef = new FakeDocument()
  const proof = 'approvals-banner-proof'.padEnd(43, '0')
  const ticks = []
  let reads = 0
  globalThis.document = documentRef
  globalThis.window = {
    document: documentRef,
    location: { search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610', hostname: '127.0.0.1' },
    mcShell: { getBridgeProof: async () => ({ ok: true, proof }) },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.setInterval = callback => { ticks.push(callback); return ticks.length }
  globalThis.clearInterval = () => {}
  globalThis.requestAnimationFrame = callback => { queueMicrotask(callback); return 1 }
  globalThis.fetch = async url => {
    if (String(url).includes('/v1/bootstrap')) return { ok: true, status: 200, json: async () => ({ ok: true, token: 'fixture-token' }) }
    if (String(url).endsWith('/v1/owner-prompts')) {
      reads += 1
      return reads === 1
        ? { ok: false, status: 503, json: async () => ({ error: { message: 'fixture outage' } }) }
        : { ok: true, status: 200, json: async () => successfulSnapshot() }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  let view
  try {
    const [{ ledgerPromptQueue }, { resetBridgeSession }] = await Promise.all([
      import('../../src/ledger-prompt-queue.js'), import('../../src/mission-bridge.js'),
    ])
    resetBridgeSession()
    view = ledgerPromptQueue()
    view.el.parentNode = { isConnected: true }
    await settle()
    const list = view.el.querySelector('.approvals-list')
    assert.match(list.textContent, /approvals service is unavailable/i, 'the fixture must reach the refusal state before recovery')

    ticks[0]()
    await settle()
    assert.equal(list.children.length, 1,
      'after recovery the approvals list must contain only the live card, not the stale refusal banner')
    assert.equal(list.children[0].dataset.promptId, 'notice-1',
      'after recovery the sole child must be the card returned by the successful queue reading')
    assert.doesNotMatch(list.textContent, /service is unavailable|nothing here is a decision/i,
      'after recovery no refusal banner may remain alongside a live approval card')
  } finally {
    view?.destroy()
    Object.assign(globalThis, originals)
  }
})
