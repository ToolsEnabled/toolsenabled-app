/* Executable contract for the metrics view.
 *
 * The CSS hook is registered before the view is imported.  The deliberately
 * small DOM below is a browser stand-in, not a source-code parser: the real
 * metricsView factory mounts, reads its record, handles clicks, and paints the
 * nodes on which these tests assert.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as defer } from 'node:timers/promises'
import test from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

class Classes {
  constructor(node) { this.node = node }
  names() { return new Set(this.node.className.split(/\s+/).filter(Boolean)) }
  contains(name) { return this.names().has(name) }
  add(...names) { const all = this.names(); names.forEach(name => all.add(name)); this.node.className = [...all].join(' ') }
  remove(...names) { const all = this.names(); names.forEach(name => all.delete(name)); this.node.className = [...all].join(' ') }
  toggle(name, force) { const on = force === undefined ? !this.contains(name) : force; on ? this.add(name) : this.remove(name); return on }
}

class Node {
  constructor(documentRef, tag = 'div') {
    this.ownerDocument = documentRef; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.dataset = {}; this.className = ''; this.style = { setProperty() {}, removeProperty() {} }
    this.classList = new Classes(this); this.listeners = new Map(); this._text = ''; this.hidden = false
  }
  get firstElementChild() { return this.children[0] || null }
  get childElementCount() { return this.children.length }
  get options() { return this.children.filter(child => child.tagName === 'OPTION') }
  get selectedIndex() { return this.options.findIndex(option => option.value === this.value) }
  set selectedIndex(index) { this.value = this.options[index]?.value ?? '' }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected !== false : false }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this.replaceChildren(); this._text = String(value) }
  get innerHTML() { return this.textContent }
  set innerHTML(markup) { this.replaceChildren(...parse(this.ownerDocument, String(markup))) }
  append(...nodes) { for (const value of nodes) { const node = typeof value === 'string' ? this.ownerDocument.createTextNode(value) : value; node.remove?.(); node.parentNode = this; this.children.push(node) } }
  appendChild(node) { this.append(node); return node }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove?.(); node.parentNode = this; this.children.unshift(node) } }
  after(node) { const at = this.parentNode.children.indexOf(this); node.remove?.(); node.parentNode = this.parentNode; this.parentNode.children.splice(at + 1, 0, node) }
  insertBefore(node, before) { node.remove?.(); node.parentNode = this; const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, node); return node }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes) }
  remove() { if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  setAttribute(name, value) { const text = String(value); this.attributes.set(name, text); if (name === 'class') this.className = text; if (name === 'id') this.id = text; if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = text }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]) }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) {
    if (typeof selector !== 'string') return []
    if (selector.startsWith(':scope > ')) return this.children.filter(node => matches(node, selector.slice(9)))
    return descendants(this).filter(node => matches(node, selector))
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null }
  contains(node) { return node === this || descendants(this).includes(node) }
  getBoundingClientRect() { return { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300 } }
  focus() { this.ownerDocument.activeElement = this }
}

const camel = value => value.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)])
function matches(node, selector) {
  if (!node?.tagName) return false
  if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()))
  const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/)
  if (attr && (!node.hasAttribute(attr[1]) || (attr[2] !== undefined && node.getAttribute(attr[1]) !== attr[2]))) return false
  const id = selector.match(/#([\w-]+)/); if (id && node.id !== id[1]) return false
  for (const name of [...selector.matchAll(/\.([\w-]+)/g)].map(hit => hit[1])) if (!node.classList.contains(name)) return false
  const tag = selector.match(/^[a-z][\w-]*/i); if (tag && node.tagName !== tag[0].toUpperCase()) return false
  return Boolean(attr || id || tag || selector.startsWith('.'))
}

function parse(documentRef, html) {
  const holder = new Node(documentRef, 'fragment'); const stack = [holder]
  for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) { if (token.trim()) stack.at(-1).append(documentRef.createTextNode(token)); continue }
    if (/^<!/.test(token)) continue
    const found = /^<([\w-]+)([^>]*)>/.exec(token); if (!found) continue
    const node = new Node(documentRef, found[1])
    for (const hit of found[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(hit[1], hit[2] ?? '')
    stack.at(-1).append(node)
    if (!/\/>$/.test(token) && !/^(input|br|hr|img|path|circle)$/i.test(found[1])) stack.push(node)
  }
  return holder.children
}

class Document {
  constructor() {
    this.documentElement = new Node(this, 'html'); this.documentElement.parentNode = { isConnected: true }
    this.body = new Node(this, 'body'); this.documentElement.append(this.body); this.activeElement = null
  }
  createElement(tag) {
    if (tag !== 'template') return new Node(this, tag)
    const template = new Node(this, tag); template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', { set: html => { template.content.firstElementChild = parse(this, html)[0] || null } })
    return template
  }
  createElementNS(_namespace, tag) { return new Node(this, tag) }
  createTextNode(text) { const node = new Node(this, '#text'); node._text = String(text); return node }
  addEventListener() {}; removeEventListener() {}
}

const documentRef = new Document()
const windowListeners = new Map()
globalThis.document = documentRef
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'metrics-view-test' } })
globalThis.window = {
  document: documentRef,
  location: { hostname: 'desktop.test', search: '' },
  matchMedia: () => ({ matches: false }),
  mcShell: { getBridgeProof: async () => ({ ok: true }) },
  addEventListener: (type, fn) => windowListeners.set(type, [...(windowListeners.get(type) || []), fn]),
  removeEventListener: (type, fn) => windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== fn)),
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.MutationObserver = class { observe() {}; disconnect() {} }
globalThis.ResizeObserver = class { observe() {}; disconnect() {} }
globalThis.requestAnimationFrame = () => 41 // keep the chart engine outside this DOM-sized contract
globalThis.cancelAnimationFrame = () => {}

const { metricsView } = await import('../../src/views/metrics.js')
const { selectMetricsRecords } = await import('../../shell/metrics-record-query.cjs')
const { sampleSessionsRaw } = await import('../../src/sample-activity.js')
const { sampleUsageRaw } = await import('../../src/sample-usage.js')

async function settle() { for (let n = 0; n < 16; n += 1) await Promise.resolve(); await defer() }
function click(view, button) {
  const filter = view.el.querySelector('#m-filter')
  for (const listener of filter.listeners.get('click') || []) listener({ target: button })
}

test('range buttons expose the selected reading and reselect on a person click', async () => {
  globalThis.mcAgent = Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ metrics }) => ({ ok: true, entries: [], total: 0, metrics: { v: 1, ...metrics, head: 0, count: 0, principal: 'unauthenticated', nextBefore: null } })]))
  const view = metricsView(); await settle()
  try {
    const buttons = view.el.querySelector('[data-group="range"]').querySelectorAll('.pill')
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['true', 'false', 'false'],
      'the rendered range control must identify 24 hours, and only 24 hours, as selected initially')
    click(view, buttons[1])
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'true', 'false'],
      'pressing 7 days must move the rendered selection from 24 hours to 7 days')
    assert.match(view.el.querySelector('#heat-sub').textContent, /last\s+(?:seven|7)\s+days/i,
      'the activity reading must be reprojected to the selected seven-day window')
  } finally { view.destroy() }
})

test('an absent record reaches the reader as an ordinary empty state with a next step', async () => {
  globalThis.mcAgent = Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ metrics }) => ({ ok: true, entries: [], total: 0, metrics: { v: 1, ...metrics, head: 0, count: 0, principal: 'unauthenticated', nextBefore: null } })]))
  const view = metricsView(); await settle()
  try {
    const note = view.el.querySelector('#mf-note')
    assert.match(note.textContent, /no run attempts recorded in the last 24 hours/i, 'an empty period must name its scope rather than claim there have never been runs')
    assert.doesNotMatch(note.textContent, /everything ever|all time|nothing has been started/i)
    assert.match(note.textContent, /start an agent/i, 'the empty state must tell the reader what action will populate it')
    assert.doesNotMatch(note.textContent, /could not (?:open|read)/i, 'an empty record must not be painted as a read failure')
    assert.match(view.el.querySelector('#m-refresh-status').textContent, /Updated/)
    assert.equal(view.el.querySelector('#m-history-status').textContent, 'No runs recorded in the last 24 hours')
  } finally { view.destroy() }
})

test('a record that could not be read never collapses into a definite zero or empty answer', async () => {
  globalThis.mcAgent = { history: async () => ({ ok: false, error: 'fixture unreadable' }), usage: async () => ({ ok: false, error: 'fixture unreadable' }) }
  const view = metricsView(); await settle()
  try {
    const note = view.el.querySelector('#mf-note').textContent
    assert.match(note, /could not open|cannot read/i, 'a failed read must be disclosed as a failure to read')
    assert.doesNotMatch(note, /nothing has been started|nothing to measure/i,
      'a failed read must not be rendered as the definite answer that no runs exist')
    assert.doesNotMatch(note, /\b0\s+runs?\b/i, 'a failed read must not invent a zero-run measurement')
  } finally { view.destroy() }
})

function send(node, type, value) {
  if (value !== undefined) node.value = value
  for (const listener of node.listeners.get(type) || []) listener({ target: node })
}

function sampleAgent() {
  const now = Date.UTC(2026, 8, 8, 5, 55)
  const principal = 'unauthenticated'
  return Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ limit, metrics }) => ({ ok: true, verified: true, ...selectMetricsRecords((channel === 'history' ? sampleSessionsRaw(now) : sampleUsageRaw(now)).entries.map(entry => ({ ...entry, principal, sessionId: entry.sessionId || sampleSessionsRaw(now).entries.find(start => start.sequence === entry.outcome?.resolves)?.sessionId })), { ...metrics, principal }, limit, channel === 'usage') })]))
}

test('run history explains its selected period and returned account scope without querying excluded runs', async () => {
  const now = Date.now(), day = 86400000
  for (const [principal, scope] of [
    [`account:${'a'.repeat(32)}`, 'for your signed-in account on this computer'],
    ['unauthenticated', 'on this computer without an account'],
  ]) {
    const calls = []
    const entries = [2, 10].map((days, index) => ({
      sequence: index + 1, action: 'agent_session_start', sessionId: `scoped-${index}`,
      at: new Date(now - days * day).toISOString(), principal,
    }))
    const agent = Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ limit, metrics }) => {
      calls.push({ channel, metrics })
      return { ok: true, ...selectMetricsRecords(channel === 'history' ? entries : [], { ...metrics, principal }, limit, channel === 'usage') }
    }]))
    globalThis.mcAgent = agent
    const view = metricsView(); await settle()
    const q = selector => view.el.querySelector(selector)
    try {
      assert.equal(q('#m-history-status').textContent, 'No runs recorded in the last 24 hours')
      /* T1448: this pinned the caption with its count missing; it now says there were none. */
      assert.equal(q('#table-sub').textContent, 'No run attempts · last 24 hours')
      assert.equal(q('#agent-table').textContent, `No run attempts recorded ${scope} in the last 24 hours. Start an agent to add activity.`)
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope} · 0 runs in the last 24 hours`)
      assert.equal(calls.length, 2, 'the existing history and usage reads supply the scope')
      assert.ok(calls.every(call => Number.isSafeInteger(call.metrics?.fromMs) && Number.isSafeInteger(call.metrics?.toMs)), 'all reads retain the existing bounded metrics query')

      click(view, q('[data-v="7d"]'))
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope} · 1 run in the last 7 days`)
      assert.match(q('#table-sub').textContent, /^1 run attempts · last 7 days$/)
      send(q('#m-history-search'), 'input', 'no-such-run')
      assert.match(q('#m-history-status').textContent, /^No matching runs · 1 loaded$/)
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope} · 1 run in the last 7 days`, 'search does not redefine the period count')
      send(q('#m-history-search'), 'input', '')

      click(view, q('[data-v="30d"]'))
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope} · 2 runs in the last 30 days`)
      assert.equal(q('#agent-table').querySelector('tbody').children.length, 2)
      click(view, q('[data-v="24h"]'))
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope} · 0 runs in the last 24 hours`)
      assert.equal(q('#m-history-status').textContent, 'No runs recorded in the last 24 hours')
      assert.equal(calls.length, 2, 'range and search changes must not add record queries')

      globalThis.mcAgent = { ...agent, history: async () => ({ ok: false }) }
      send(q('#m-refresh'), 'click'); await settle()
      assert.equal(q('#m-history-status').textContent, 'No readable run history')
      assert.match(q('#agent-table').textContent, /could not open/i)
      assert.equal(q('#table-sub').textContent, 'last 24 hours', 'an unreadable record claims no count in the caption either')
      assert.equal(q('#m-account-scope').textContent, `Runs recorded ${scope}`, 'an unreadable run record must not claim a zero count')
    } finally { view.destroy() }
  }
})

test('run history paginates loaded rows and filters unknown outcomes without changing whole-record totals', async () => {
  globalThis.mcAgent = sampleAgent()
  const view = metricsView(); await settle()
  click(view, view.el.querySelector('[data-v="30d"]'))
  const q = selector => view.el.querySelector(selector)
  try {
    const caption = q('#table-sub').textContent
    assert.match(caption, /27 run attempts · last 30 days/)
    assert.equal(q('#agent-table').querySelector('tbody').children.length, 12)
    send(q('#m-history-next'), 'click')
    assert.equal(q('#m-history-page').textContent, 'Page 2 of 3')
    send(q('#m-history-outcome'), 'change', 'unrecorded')
    assert.equal(q('#agent-table').querySelector('tbody').children.length, 3)
    assert.equal(q('#m-history-page').textContent, 'Page 1 of 1')
    assert.equal(q('#table-sub').textContent, caption)
    assert.match(q('#agent-table').textContent, /Not recorded/)
    assert.doesNotMatch(q('#agent-table').querySelector('tbody').textContent, /started/)
  } finally { view.destroy() }
})

test('search with no matches offers a recovery and disables pagination and export', async () => {
  globalThis.mcAgent = sampleAgent()
  const view = metricsView(); await settle()
  click(view, view.el.querySelector('[data-v="30d"]'))
  const q = selector => view.el.querySelector(selector)
  try {
    send(q('#m-history-search'), 'input', 'no-such-agent-or-reason')
    assert.match(q('#agent-table').textContent, /No runs match these filters/)
    assert.equal(q('#m-history-export').disabled, true)
    assert.equal(q('#m-history-prev').disabled, true)
    assert.equal(q('#m-history-next').disabled, true)
    send(q('#m-history-search'), 'input', '')
    assert.equal(q('#m-history-export').disabled, false)
    assert.equal(q('#agent-table').querySelector('tbody').children.length, 12)
  } finally { view.destroy() }
})

test('refresh reports progress, keeps filters, and replaces unreadable data without asserting zero runs', async () => {
  globalThis.mcAgent = sampleAgent()
  const view = metricsView(); await settle()
  click(view, view.el.querySelector('[data-v="30d"]'))
  const q = selector => view.el.querySelector(selector)
  try {
    send(q('#m-history-outcome'), 'change', 'refused')
    let finish
    globalThis.mcAgent = { history: () => new Promise(resolve => { finish = resolve }), usage: async () => ({ ok: false }) }
    send(q('#m-refresh'), 'click')
    await settle()
    assert.equal(q('#m-refresh').disabled, true)
    assert.equal(q('#m-refresh-status').textContent, 'Reading records')
    finish({ ok: false })
    await settle()
    assert.equal(q('#m-refresh').disabled, false)
    assert.equal(q('#m-refresh-status').textContent, 'Could not read records. Try Refresh data.')
    assert.equal(q('#m-history-outcome').value, 'refused')
    assert.match(q('#mf-note').textContent, /could not open|cannot read/i)
    assert.equal(q('#m-history-export').disabled, true)
  } finally { view.destroy() }
})

test('a user can show this computer, change period and search, then reopen the saved scope', async () => {
  const oldStorage = globalThis.localStorage, values = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const principal = `account:${'a'.repeat(32)}`, now = Date.now(), day = 86400000
  const entries = [principal, `account:${'b'.repeat(32)}`, 'unauthenticated'].map((owner, index) => ({
    sequence: index + 1, action: 'agent_session_start', sessionId: `scope-${index}`, principal: owner,
    at: new Date(now - (index === 0 ? 2 * day : 3600000)).toISOString(),
  }))
  const calls = []
  globalThis.mcAgent = Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ limit, metrics }) => {
    calls.push({ channel, metrics })
    return { ok: true, ...selectMetricsRecords(channel === 'history' ? entries : [], { ...metrics, principal }, limit, channel === 'usage') }
  }]))
  let view = metricsView(); await settle()
  let q = selector => view.el.querySelector(selector)
  try {
    assert.equal(q('#m-record-scope').value, 'account')
    assert.match(q('#m-account-scope').textContent, /0 runs in the last 24 hours/)
    send(q('#m-record-scope'), 'change', 'computer'); await settle()
    assert.match(q('#m-account-scope').textContent, /across all accounts and without an account · 2 runs in the last 24 hours/)
    assert.equal(calls.length, 4)
    assert.ok(calls.slice(2).every(call => call.metrics.scope === 'computer'))
    click(view, q('[data-v="7d"]'))
    assert.match(q('#m-account-scope').textContent, /3 runs in the last 7 days/)
    send(q('#m-history-search'), 'input', 'no-such-run')
    assert.match(q('#m-history-status').textContent, /No matching runs/)
    assert.match(q('#m-account-scope').textContent, /3 runs in the last 7 days/)
    assert.equal(calls.length, 4, 'period/search reproject the current scope without new reads')
    send(q('#m-history-search'), 'input', '')
    send(q('#m-refresh'), 'click'); await settle()
    assert.equal(q('#m-record-scope').value, 'computer')
    view.destroy(); view = metricsView(); await settle(); q = selector => view.el.querySelector(selector)
    assert.equal(q('#m-record-scope').value, 'computer')
    assert.match(q('#m-account-scope').textContent, /3 runs in the last 7 days/)
    send(q('#m-record-scope'), 'change', 'account'); await settle()
    assert.match(q('#m-account-scope').textContent, /for your signed-in account.*1 run in the last 7 days/)
  } finally { view.destroy(); globalThis.localStorage = oldStorage }
})

const emitWindow = (type, detail = {}) => {
  for (const listener of [...(windowListeners.get(type) || [])]) listener({ type, detail })
}
const emptyPageFor = request => ({ ok: true, verified: true, entries: [],
  metrics: { v: 1, ...request.metrics, head: 0, count: 0, principal: 'unauthenticated', nextBefore: null } })

test('a stalled Metrics read becomes a retryable read error rather than an empty or permanent loading screen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.mcAgent = { history: () => new Promise(() => {}), usage: () => new Promise(() => {}) }
  const view = metricsView(), q = selector => view.el.querySelector(selector)
  try {
    await settle()
    assert.equal(q('#m-refresh').disabled, true)
    t.mock.timers.tick(15001); await settle()
    assert.equal(q('#m-refresh').disabled, false, 'an unanswered host must not leave Refresh disabled forever')
    assert.match(q('#m-refresh-status').textContent, /too long.*Refresh data/)
    assert.equal(q('#m-history-status').textContent, 'No readable run history')
    assert.doesNotMatch(q('#m-account-scope').textContent, /0 runs/)
    assert.equal(q('#m-record-scope').value, 'account')
    globalThis.mcAgent = { history: async request => emptyPageFor(request), usage: async request => emptyPageFor(request) }
    send(q('#m-refresh'), 'click'); await settle()
    assert.match(q('#m-refresh-status').textContent, /Updated/)
    assert.equal(q('#m-history-status').textContent, 'No runs recorded in the last 24 hours')
  } finally { view.destroy() }
})

test('available history remains readable when the usage request times out, with an explicit partial-read status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.mcAgent = { history: async request => emptyPageFor(request), usage: () => new Promise(() => {}) }
  const view = metricsView(), q = selector => view.el.querySelector(selector)
  try {
    await settle(); t.mock.timers.tick(15001); await settle()
    assert.equal(q('#m-refresh').disabled, false)
    assert.equal(q('#m-history-status').textContent, 'No runs recorded in the last 24 hours')
    assert.match(q('#m-refresh-status').textContent, /too long/)
    assert.doesNotMatch(q('#m-refresh-status').textContent, /Updated/)
    assert.equal(q('#m-record-scope').value, 'account')
  } finally { view.destroy() }
})

test('account transition retires a pending Metrics read and only the newly settled account can repaint', async () => {
  const replies = []
  globalThis.mcAgent = Object.fromEntries(['history', 'usage'].map(channel => [channel, request =>
    new Promise(resolve => replies.push(() => resolve(emptyPageFor(request))))]))
  const view = metricsView(), q = selector => view.el.querySelector(selector)
  try {
    await settle()
    emitWindow('mc:account-storage-changing'); await settle()
    assert.match(q('#m-refresh-status').textContent, /Waiting for account/)
    assert.equal(q('#m-refresh').disabled, true)
    globalThis.mcAgent = { history: async request => emptyPageFor(request), usage: async request => emptyPageFor(request) }
    emitWindow('mc:account-storage-rehydrated'); await settle()
    assert.match(q('#m-refresh-status').textContent, /Updated/)
    const settled = q('#m-history-status').textContent
    replies.forEach(reply => reply()); await settle()
    assert.equal(q('#m-history-status').textContent, settled)
    assert.equal(q('#m-refresh').disabled, false)
  } finally { view.destroy(); replies.forEach(reply => reply()); await settle() }
})
