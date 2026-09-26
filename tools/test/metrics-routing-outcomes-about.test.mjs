/*
 * Metrics regressions for T1297 (Token routing figures clipped), T1301 (the
 * Outcome column mixed lower-case sentence words with badges) and T1331
 * (About these numbers saved a layout change).
 *
 * The routing case drives the real ECharts SVG renderer at both desktop widths
 * the report measured. SVG/SSR cannot establish browser font metrics or CSS
 * layout, so the rig hand test still owns visual clipping.
 *
 * The mounted Metrics cases use the real metricsView, a bridge-shaped
 * history/usage reply and stateful localStorage. The requestAnimationFrame
 * shim leaves chart instances out of this DOM-sized contract; the renderer
 * case above owns the chart output. No product copy or persistence is
 * substituted by this suite.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as defer } from 'node:timers/promises'
import test from 'node:test'

import * as echarts from 'echarts/core'
import { SankeyChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

import { routingFlows, routingOption } from '../../src/metrics-live-charts.js'
import { runHistoryCsv } from '../../src/metrics-history.js'
import { COPY, describeRun } from '../../src/local-activity.js'
import { ACTIVITY_LABELS, activityStatus } from '../../src/home-activity.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

echarts.use([SankeyChart, GridComponent, TooltipComponent, VisualMapComponent, SVGRenderer])

class Classes {
  constructor(node) { this.node = node }
  names() { return new Set(this.node.className.split(/\s+/).filter(Boolean)) }
  contains(name) { return this.names().has(name) }
  add(...names) {
    const all = this.names()
    names.forEach(name => all.add(name))
    this.node.className = [...all].join(' ')
  }
  remove(...names) {
    const all = this.names()
    names.forEach(name => all.delete(name))
    this.node.className = [...all].join(' ')
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : force
    on ? this.add(name) : this.remove(name)
    return on
  }
}

const camel = value => value.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)])

function matchesSimple(node, selector) {
  if (!node?.tagName) return false
  let rest = selector.trim()
  if (rest === '*') return true

  for (const hit of rest.matchAll(/\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g)) {
    const expected = hit[2] ?? hit[3]
    if (!node.hasAttribute(hit[1]) || (expected !== undefined && node.getAttribute(hit[1]) !== expected)) return false
  }
  rest = rest.replace(/\[[^=\]]+(?:=(?:"[^"]*"|'[^']*'))?\]/g, '')

  const id = rest.match(/#([\w-]+)/)
  if (id && node.id !== id[1]) return false
  rest = rest.replace(/#[\w-]+/g, '')
  for (const name of [...rest.matchAll(/\.([\w-]+)/g)].map(hit => hit[1])) {
    if (!node.classList.contains(name)) return false
  }
  rest = rest.replace(/\.[\w-]+/g, '')
  const tag = rest.match(/^[a-z][\w-]*/i)
  if (tag && node.tagName !== tag[0].toUpperCase()) return false
  return Boolean(id || tag || selector.includes('[') || selector.includes('.') || selector === '*')
}

function matches(node, selector) {
  if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()))
  const parts = selector.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1) return matchesSimple(node, parts[0])
  if (!matchesSimple(node, parts.at(-1))) return false
  let ancestor = node.parentNode
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentNode
    if (!ancestor) return false
    ancestor = ancestor.parentNode
  }
  return true
}

function parse(documentRef, html) {
  const holder = new Node(documentRef, 'fragment')
  const stack = [holder]
  for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) {
      if (token.trim()) stack.at(-1).append(documentRef.createTextNode(token))
      continue
    }
    if (/^<!/.test(token)) continue
    const found = /^<([\w-]+)([^>]*)>/.exec(token)
    if (!found) continue
    const node = new Node(documentRef, found[1])
    for (const hit of found[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) {
      node.setAttribute(hit[1], hit[2] ?? '')
    }
    stack.at(-1).append(node)
    if (!/\/>$/.test(token) && !/^(input|br|hr|img|path|circle)$/i.test(found[1])) stack.push(node)
  }
  return holder.children
}

class Node {
  constructor(documentRef, tag = 'div') {
    this.ownerDocument = documentRef
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this.classList = new Classes(this)
    this.listeners = new Map()
    this.style = { setProperty() {}, removeProperty() {} }
    this._text = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.id = ''
    this.clientWidth = 800
    this.clientHeight = 300
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
  append(...nodes) {
    for (const value of nodes) {
      const node = typeof value === 'string' ? this.ownerDocument.createTextNode(value) : value
      node.remove?.()
      node.parentNode = this
      this.children.push(node)
    }
  }
  appendChild(node) { this.append(node); return node }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove?.()
      node.parentNode = this
      this.children.unshift(node)
    }
  }
  after(node) {
    if (!this.parentNode?.children) return
    const at = this.parentNode.children.indexOf(this)
    node.remove?.()
    node.parentNode = this.parentNode
    this.parentNode.children.splice(at + 1, 0, node)
  }
  insertBefore(node, before) {
    node.remove?.()
    node.parentNode = this
    const at = this.children.indexOf(before)
    this.children.splice(at < 0 ? this.children.length : at, 0, node)
    return node
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this._text = ''
    this.append(...nodes)
  }
  remove() {
    if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
  setAttribute(name, value) {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.className = text
    if (name === 'id') this.id = text
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = text
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn])
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn))
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) {
    if (typeof selector !== 'string') return []
    if (selector.startsWith(':scope > ')) {
      return this.children.filter(node => matches(node, selector.slice(9)))
    }
    return descendants(this).filter(node => matches(node, selector))
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node
    return null
  }
  contains(node) { return node === this || descendants(this).includes(node) }
  getBoundingClientRect() {
    return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight }
  }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this }
  click() {
    for (const listener of this.listeners.get('click') || []) listener({ target: this })
  }
}

class Document {
  constructor() {
    this.documentElement = new Node(this, 'html')
    this.documentElement.parentNode = { isConnected: true }
    this.body = new Node(this, 'body')
    this.documentElement.append(this.body)
    this.activeElement = null
  }
  createElement(tag) {
    // zrender measures text through a canvas when a document exists. This
    // stand-in has none, so zrender falls back to its own width table.
    if (tag === 'canvas') return Object.assign(new Node(this, tag), { getContext: () => null })
    if (tag !== 'template') return new Node(this, tag)
    const template = new Node(this, tag)
    template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', {
      set: html => { template.content.firstElementChild = parse(this, html)[0] || null },
    })
    return template
  }
  createElementNS(_namespace, tag) { return new Node(this, tag) }
  createTextNode(text) {
    const node = new Node(this, '#text')
    node._text = String(text)
    return node
  }
  addEventListener() {}
  removeEventListener() {}
}

const documentRef = new Document()
const windowListeners = new Map()
const storageValues = new Map()
const layoutWrites = []

globalThis.document = documentRef
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'metrics-routing-outcomes-about' },
})
globalThis.window = {
  document: documentRef,
  location: { hostname: 'desktop.test', search: '' },
  matchMedia: () => ({ matches: false }),
  mcShell: { getBridgeProof: async () => ({ ok: true }) },
  addEventListener: (type, fn) => windowListeners.set(type, [...(windowListeners.get(type) || []), fn]),
  removeEventListener: (type, fn) => windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== fn)),
}
globalThis.localStorage = {
  getItem: key => storageValues.get(key) ?? null,
  setItem: (key, value) => {
    const text = String(value)
    if (key === 'mc.metrics.layout') layoutWrites.push({ operation: 'setItem', key, value: text })
    storageValues.set(key, text)
  },
  removeItem: key => {
    if (key === 'mc.metrics.layout') layoutWrites.push({ operation: 'removeItem', key })
    storageValues.delete(key)
  },
  clear: () => storageValues.clear(),
}
globalThis.MutationObserver = class { observe() {}; disconnect() {} }
globalThis.ResizeObserver = class { observe() {}; disconnect() {} }
globalThis.requestAnimationFrame = () => 41
globalThis.cancelAnimationFrame = () => {}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { metricsView } = await import('../../src/views/metrics.js')
const { selectMetricsRecords } = await import('../../shell/metrics-record-query.cjs')

async function settle() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
  await defer()
}

function fire(node, type, extra = {}) {
  assert.ok(node, 'the mounted fixture must expose ' + type + ' control')
  for (const listener of node.listeners.get(type) || []) {
    listener({ target: node, ...extra })
  }
}

const THEME = {
  ink: '#0e1726',
  ink2: '#4f5f70',
  ink25: '#5a6876',
  ink3: '#64727f',
  grid: '#eeeeee',
  cross: '#cccccc',
  track: '#f0f0f0',
  good: '#0a6d3c',
  warn: '#8f5902',
  serious: '#b23811',
  bg: '#ffffff',
  sheet: '#ffffff',
  poolAccent: '#5c6b7a',
  signal: '#34495e',
  heat: ['#f4f4f4', '#d0e2ff', '#a6c8ff', '#78a9ff', '#4589ff', '#0f62fe'],
  prov: { codex: '#0f62fe', claude: '#8a3ffc', gemini: '#007d79', local: '#6f6f6f' },
  font: 'sans-serif',
  mono: 'monospace',
  dark: false,
  sankeyRest: 0.24,
  sankeyMid: 0.31,
  sankeyHover: 0.58,
}

const LONG_ACCOUNT = 'Sign-in account with a deliberately long real-world name'
const BRIDGE_ACCOUNT = 'account-with-a-long-sign-in-name@example.invalid'

function metricsBridge() {
  // Replies are shaped by the shell's own record query, as the real bridge does.
  const principal = 'unauthenticated'
  const base = Date.now() - 60 * 60 * 1000
  const at = offset => new Date(base + offset * 1000).toISOString()
  const records = [
    { sequence: 1, action: 'agent_session_start', sessionId: 's-started', at: at(1), principal },
    { sequence: 2, action: 'agent_session_outcome', sessionId: 's-started', at: at(2), principal, outcome: { resolves: 1, result: 'started' } },
    { sequence: 3, action: 'agent_session_start', sessionId: 's-refused', at: at(3), principal },
    { sequence: 4, action: 'agent_session_outcome', sessionId: 's-refused', at: at(4), principal, outcome: { resolves: 3, result: 'refused' } },
    { sequence: 5, action: 'agent_session_start', sessionId: 's-unrecorded', at: at(5), principal },
    {
      sequence: 6, action: 'agent_turn_usage', sessionId: 's-refused', at: at(6), principal,
      usage: { tier: 'claude-sonnet', account: BRIDGE_ACCOUNT, totalTokens: 18900, inputTokens: 9000, outputTokens: 9900, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    {
      sequence: 7, action: 'agent_turn_usage', sessionId: 's-started', at: at(7), principal,
      usage: { tier: 'luna', account: BRIDGE_ACCOUNT, totalTokens: 21330, inputTokens: 10000, outputTokens: 11330, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
  ]
  return Object.fromEntries(['history', 'usage'].map(channel => [channel, async ({ limit, metrics }) => ({
    ok: true, verified: true, ...selectMetricsRecords(records, { ...metrics, principal }, limit, channel === 'usage'),
  })]))
}

const ROUTING_CANVAS_WIDTHS = [1440, 1920]

function renderRoutingAt(width) {
  const turns = [
    {
      sequence: 1,
      atMs: Date.UTC(2026, 8, 22, 10),
      sessionId: 'unknown-sign-in',
      tier: 'claude-sonnet',
      account: null,
      basis: 'turn',
      totalTokens: 21330,
      derivedTotal: false,
    },
    {
      sequence: 2,
      atMs: Date.UTC(2026, 8, 22, 10, 1),
      sessionId: 'sample-claude',
      tier: 'claude-fable',
      account: 'sample-claude-seat',
      basis: 'turn',
      totalTokens: 18900,
      derivedTotal: false,
    },
    {
      sequence: 3,
      atMs: Date.UTC(2026, 8, 22, 10, 2),
      sessionId: 'local-assistant',
      tier: 'local',
      account: 'sample-local-seat',
      basis: 'turn',
      totalTokens: 7654,
      derivedTotal: false,
    },
    {
      sequence: 4,
      atMs: Date.UTC(2026, 8, 22, 10, 3),
      sessionId: 'long-sign-in',
      tier: 'luna',
      account: LONG_ACCOUNT,
      basis: 'turn',
      totalTokens: 42001,
      derivedTotal: false,
    },
  ]
  const conversations = new Map([
    ['unknown-sign-in', { role: 'Unknown sign-in agent' }],
    ['sample-claude', { role: 'Claude agent' }],
    ['local-assistant', { role: 'Local assistant' }],
    ['long-sign-in', { role: 'Long-name agent' }],
  ])
  const flows = routingFlows(turns, { conversations })
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height: 320 })
  try {
    chart.setOption(routingOption({ flows, theme: THEME, reduced: true }))
    return { flows, svg: chart.renderToSVGString() }
  } finally {
    chart.dispose()
  }
}

function svgText(value) {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

/* ECharts draws each rich-text line of a label as its own <text> element; the
   lines of one node label share the label's anchor transform and differ in y. */
function renderedGraphicLabels(svg) {
  const groups = new Map()
  for (const match of String(svg).matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attributes = match[1]
    const anchor = /transform="([^"]*)"/.exec(attributes)?.[1] ?? ''
    const y = Number(/\sy="([^"]*)"/.exec(attributes)?.[1] ?? 0)
    if (!groups.has(anchor)) groups.set(anchor, [])
    groups.get(anchor).push({ y, text: svgText(match[2]).trim() })
  }
  return [...groups.values()].map(lines => lines.sort((a, b) => a.y - b.y))
}

function assertRenderedNodeFigure(svg, labelFragment, figure, width) {
  const label = renderedGraphicLabels(svg).find(lines => lines.some(line => line.text.includes(labelFragment)))
  assert.ok(label, 'rendered ECharts graphic must draw the node label ' + labelFragment + ' at canvas width ' + width)
  const nameLine = label.findIndex(line => line.text.includes(labelFragment))
  const figureLine = label.findIndex(line => line.text === figure)
  assert.notEqual(figureLine, -1, 'the node figure ' + figure + ' must be drawn whole, on a line of its own, for ' + labelFragment + ' at canvas width ' + width + ' (drawn: ' + JSON.stringify(label.map(line => line.text)) + ')')
  assert.ok(figureLine > nameLine, 'the figure line sits under the name at canvas width ' + width)
}

function mountMetrics() {
  globalThis.mcAgent = metricsBridge()
  return metricsView()
}

function csvHasRunOutcome(csv, sequence, outcome) {
  const prefix = '"' + String(sequence)
  const expected = String(outcome)
  return String(csv).split(/\r?\n/).some(line => {
    const fields = line.split('","')
    return fields[0] === prefix && fields[3] === expected
  })
}

test('Token routing SVG canvas preserves node-bound figures at 1440px and 1920px', () => {
  for (const width of ROUTING_CANVAS_WIDTHS) {
    const { svg } = renderRoutingAt(width)
    assertRenderedNodeFigure(svg, 'Sign-in not recorded', '21,330', width)
    assertRenderedNodeFigure(svg, 'sample-claude-seat', '18,900', width)
    assertRenderedNodeFigure(svg, 'On the computer you are', '7,654', width)
    assertRenderedNodeFigure(svg, 'Sign-in account', '42,001', width)
  }
  const { flows } = renderRoutingAt(1440)
  assert.ok(flows.height >= flows.tallest * 64 + 48, 'each node in the tallest column gets at least 64px for its label lines')
})

test('Home sentence vocabulary stays lower-case while Home badges remain title-cased', () => {
  const conversations = new Map([['run-started', { asked: 'Read the metrics', reply: 'Done' }]])
  const runs = [
    { sequence: 1, sessionId: 'run-started', result: 'started', atMs: 1 },
    { sequence: 2, sessionId: 'run-refused', result: 'refused', atMs: 2 },
    { sequence: 3, sessionId: 'run-unknown', result: null, atMs: 3 },
  ]
  const words = runs.map(run => describeRun(run, conversations, 4).resultWord)
  assert.deepEqual(words, [
    COPY.runResult('started'),
    COPY.runResult('refused'),
    COPY.runResult(null),
  ])
  assert.deepEqual(words, ['started', 'did not start', ''])
  assert.deepEqual(
    runs.map(run => activityStatus(run, null, null).label),
    [ACTIVITY_LABELS.started, ACTIVITY_LABELS.refused, ACTIVITY_LABELS.unrecorded],
  )
  assert.deepEqual(
    runs.map(run => activityStatus(run, null, null).label),
    ['Started', 'Did not start', 'Not recorded'],
  )
})

test('mounted Metrics badges and CSV use Started, Did not start and Not recorded', async () => {
  const view = mountMetrics()
  await settle()
  let capturedBlob = null
  const oldURL = globalThis.URL
  globalThis.URL = {
    createObjectURL(blob) { capturedBlob = blob; return 'blob:metrics-history' },
    revokeObjectURL() {},
  }
  try {
    const rows = view.el.querySelectorAll('#agent-table tbody tr')
    assert.equal(rows.length, 3, 'the mounted table must show all three outcome states')
    const rowOutcomes = rows.map(row => ({
      sequence: row.children[0].textContent,
      outcome: row.children[3].textContent,
    }))
    assert.deepEqual(
      rowOutcomes.map(row => row.outcome),
      ['Not recorded', 'Did not start', 'Started'],
    )

    fire(view.el.querySelector('#m-history-export'), 'click')
    assert.ok(capturedBlob, 'the real Metrics export handler must create a CSV blob')
    const csv = await capturedBlob.text()
    for (const row of rowOutcomes) {
      assert.ok(csvHasRunOutcome(csv, row.sequence, row.outcome),
        'CSV Outcome must stay bound to Run ' + row.sequence)
    }
    assert.match(csv, /"Recorded activity"/)
  } finally {
    view.destroy()
    globalThis.URL = oldURL
  }
})

test('About these numbers explains coverage without changing layout, while explicit editing persists', async () => {
  storageValues.delete('mc.metrics.layout')
  const before = storageValues.get('mc.metrics.layout') ?? null
  const view = mountMetrics()
  await settle()
  try {
    fire(view.el.querySelector('#m-about-numbers'), 'click')
    const explanation = view.el.querySelector('[data-mc="coverage"]').textContent.trim()
    assert.ok(explanation.length > 20, 'About must expose the real coverage explanation')
    assert.equal(storageValues.get('mc.metrics.layout') ?? null, before, 'reading an explanation must not save a layout')
  } finally {
    view.destroy()
  }

  const remounted = mountMetrics()
  await settle()
  try {
    assert.equal(storageValues.get('mc.metrics.layout') ?? null, before, 'remount must retain the untouched layout')
    fire(remounted.el.querySelector('#m-edit'), 'click')
    const chip = remounted.el.querySelector('[data-chip="coverage"]')
    assert.ok(chip, 'explicit Edit layout must expose the optional coverage component')
    fire(chip, 'keydown', { key: 'Enter', preventDefault() {} })
    fire(remounted.el.querySelector('#m-edit'), 'click')
    const saved = JSON.parse(storageValues.get('mc.metrics.layout'))
    assert.ok(saved.rows.flat().includes('coverage'), 'an explicit placement must be saved')
  } finally {
    remounted.destroy()
  }

  const reopened = mountMetrics()
  await settle()
  try {
    const saved = JSON.parse(storageValues.get('mc.metrics.layout'))
    assert.ok(saved.rows.flat().includes('coverage'), 'an explicitly saved placement must survive remount')
  } finally {
    reopened.destroy()
  }
})
