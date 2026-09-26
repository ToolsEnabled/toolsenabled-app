#!/usr/bin/env node

/*
 * WHAT THIS WINDOW COSTS WHEN NOBODY IS TOUCHING IT.
 *
 * Every recurring timer in the renderer is a wake: the process cannot sleep,
 * the compositor cannot park, and on a laptop the difference is measurable in
 * battery. A timer whose answer never changes is pure loss, and a timer is the
 * one kind of cost that does not show up in a profile of a click -- nobody
 * clicked.
 *
 * So this instrument mounts the idle window under a RECORDING VIRTUAL CLOCK and
 * counts, per scheduling site, how many times it fires per minute. It reports
 * only what it observed; it encodes no expectation of what the answer should
 * be, so it measures the tree it is run against rather than the tree it was
 * written against.
 *
 * IT IS NOT A GATE. `tools/test/renderer-idle-poll.test.mjs` is where the
 * behaviour is pinned; this prints the table a person reads.
 *
 * THE TWO FACES ARE MEASURED IN SEPARATE PROCESSES. src/fleet-profile.js
 * resolves once, at import, and caches; "is a fleet configured" therefore
 * cannot be changed inside one run, and a harness that pretended otherwise
 * would report the first face twice.
 *
 *   node tools/renderer-idle-poll-inventory.mjs [--minutes N] [--face sample|configured]
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* A REAL yield, captured before the virtual clock replaces the timer names.
   Draining microtasks alone is not enough: a view's first reads go through
   promises that only settle on a macrotask turn, and a harness that skipped
   them would report a window that had not finished waking up. */
const realSetImmediate = globalThis.setImmediate
const yieldToHost = () => new Promise(resolve => realSetImmediate(resolve))
const settle = async (turns = 12) => { for (let turn = 0; turn < turns; turn += 1) await yieldToHost() }

register('./test/helpers/css-stub-loader.mjs', import.meta.url)

const flagValue = (name, fallback) => {
  const prefixed = process.argv.find(argument => argument.startsWith(`--${name}=`))
  if (prefixed) return prefixed.slice(name.length + 3)
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

const MINUTES = (() => {
  const value = Number(flagValue('minutes', '10'))
  return Number.isFinite(value) && value > 0 ? value : 10
})()
const WINDOW_MS = MINUTES * 60_000
const FACE = flagValue('face', '')

/* ---------------------------------------------------------------------------
   The recording virtual clock.

   Real time never advances here. Each scheduled callback is filed under the
   first stack frame that lives in src/, so the table names the LINE that
   scheduled the wake rather than the closure that ran.
   --------------------------------------------------------------------------- */

function createRecordingClock() {
  let nowMs = 0
  let nextHandle = 1
  const pending = new Map()
  const sites = new Map()
  /* Which sites fired at each virtual instant, so "do they all wake together"
     is a count rather than an argument. */
  const wakes = new Map()

  const siteOf = () => {
    const stack = String(new Error('site').stack || '').split('\n').slice(2)
    for (const line of stack) {
      const found = /\(?(?:file:\/\/\/)?([A-Za-z]:[^):]*[\\/]src[\\/][^):]+|\/[^):]*\/src\/[^):]+):(\d+):\d+\)?/.exec(line)
      if (!found) continue
      const relative = path.relative(REPO_ROOT, found[1].replace(/\//g, path.sep)).replace(/\\/g, '/')
      if (relative.startsWith('src/')) return `${relative}:${found[2]}`
    }
    return 'harness'
  }

  const file = (site, kind, delayMs) => {
    let entry = sites.get(site)
    if (!entry) { entry = { site, kind, delays: new Set(), fires: 0, scheduled: 0 }; sites.set(site, entry) }
    entry.scheduled += 1
    entry.delays.add(Math.round(Number(delayMs) || 0))
    return entry
  }

  const schedule = (kind, fn, delayMs) => {
    const entry = file(siteOf(), kind, delayMs)
    const handle = nextHandle
    nextHandle += 1
    pending.set(handle, { kind, fn, entry, dueAtMs: nowMs + Math.max(0, Number(delayMs) || 0), everyMs: Math.max(1, Number(delayMs) || 1) })
    return handle
  }

  return {
    now: () => nowMs,
    sites,
    sharedWakes: () => [...wakes.entries()].filter(([, set]) => set.size > 1).length,
    install(target) {
      const saved = {}
      for (const key of ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) saved[key] = target[key]
      target.setInterval = (fn, ms) => schedule('interval', fn, ms)
      target.setTimeout = (fn, ms) => schedule('timeout', fn, ms)
      target.clearInterval = handle => { pending.delete(handle) }
      target.clearTimeout = handle => { pending.delete(handle) }
      return () => { for (const [key, value] of Object.entries(saved)) target[key] = value }
    },
    /* Fires every due callback in time order, then stops at the horizon. The
       loop is bounded so a runaway zero-delay reschedule reports rather than
       hangs the instrument. */
    async run(horizonMs) {
      let guard = 0
      for (;;) {
        let due = null
        for (const [handle, timer] of pending) {
          if (timer.dueAtMs > horizonMs) continue
          if (!due || timer.dueAtMs < due.timer.dueAtMs) due = { handle, timer }
        }
        if (!due) break
        guard += 1
        if (guard > 200_000) throw new Error('virtual clock did not settle')
        nowMs = due.timer.dueAtMs
        due.timer.entry.fires += 1
        const already = wakes.get(nowMs)
        if (already) already.add(due.timer.entry.site)
        else wakes.set(nowMs, new Set([due.timer.entry.site]))
        if (due.timer.kind === 'interval') due.timer.dueAtMs = nowMs + due.timer.everyMs
        else pending.delete(due.handle)
        try { due.timer.fn() } catch { /* a view's own failure is not this instrument's to raise */ }
        await settle(3)
      }
      nowMs = horizonMs
    },
  }
}

/* ---------------------------------------------------------------------------
   The window stand-in. Deliberately the same shape the view suites use.
   --------------------------------------------------------------------------- */

class Classes {
  constructor(node) { this.node = node }
  names() { return this.node.className.split(/\s+/).filter(Boolean) }
  contains(name) { return this.names().includes(name) }
  add(...names) { this.node.className = [...new Set([...this.names(), ...names])].join(' ') }
  remove(...names) { this.node.className = this.names().filter(name => !names.includes(name)).join(' ') }
  toggle(name, force) { const on = force ?? !this.contains(name); if (on) this.add(name); else this.remove(name); return on }
}

class FakeElement {
  constructor(documentRef, tagName = 'div') {
    this.ownerDocument = documentRef
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = { setProperty() {}, getPropertyValue() { return '' }, background: '' }
    this.className = ''
    this.classList = new Classes(this)
    this.hidden = false
    this.disabled = false
    this.listeners = new Map()
    this._text = ''
  }
  get firstElementChild() { return this.children[0] || null }
  get lastElementChild() { return this.children.at(-1) || null }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected !== false : false }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value) }
  set innerHTML(value) { this.replaceChildren(...parse(this.ownerDocument, String(value))) }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'string') this._text += node; else { node.parentNode = this; this.children.push(node) } } }
  appendChild(node) { this.append(node); return node }
  insertBefore(node, before) { const at = this.children.indexOf(before); if (at < 0) return this.appendChild(node); node.parentNode = this; this.children.splice(at, 0, node); return node }
  insertAdjacentElement(position, node) { if (position !== 'afterend' || !this.parentNode) return node; const at = this.parentNode.children.indexOf(this); node.parentNode = this.parentNode; this.parentNode.children.splice(at + 1, 0, node); return node }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes) }
  remove() { if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  setAttribute(name, value) {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.className = text
    if (name === 'id') this.id = text
    if (name === 'disabled') this.disabled = true
    if (name === 'hidden') this.hidden = true
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = text
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) { return descendants(this).filter(node => selector.split(',').some(part => matches(node, part.trim()))) }
  contains(node) { return node === this || descendants(this).includes(node) }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null }
  getBoundingClientRect() { return { width: 600, height: 400, top: 0, bottom: 400, left: 0, right: 600 } }
  focus() { this.ownerDocument.activeElement = this }
  getContext() { return null }
}

const descendants = root => root.children.flatMap(child => [child, ...descendants(child)])

function matches(node, selector) {
  const attribute = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/)
  const classNames = [...selector.matchAll(/\.([\w-]+)/g)].map(found => found[1])
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0]
  if (tag && node.tagName !== tag.toUpperCase()) return false
  if (classNames.some(name => !node.classList.contains(name))) return false
  if (attribute) {
    const [, name, value] = attribute
    if (!node.hasAttribute(name)) return false
    if (value !== undefined && node.getAttribute(name) !== value) return false
  }
  return Boolean(tag || classNames.length || attribute)
}

function parse(documentRef, markup) {
  const holder = new FakeElement(documentRef, 'fragment')
  const stack = [holder]
  const tokens = markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) {
      const closing = /^<\/\s*([\w-]+)/.exec(token)?.[1]
      if (!/^(?:input|path|circle|rect|stop|br|img|i)$/i.test(closing || '')) stack.pop()
      continue
    }
    if (token.startsWith('<')) {
      const found = /^<\s*([\w-]+)([^>]*)>/.exec(token)
      if (!found) continue
      const node = new FakeElement(documentRef, found[1])
      for (const attr of found[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '')
      stack.at(-1).append(node)
      if (!/\/$/.test(found[2]) && !/^(?:input|path|circle|rect|stop|br|img|i)$/i.test(found[1])) stack.push(node)
    } else if (token.trim()) stack.at(-1)._text += token.replace(/\s+/g, ' ')
  }
  return holder.children
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html')
    this.body = new FakeElement(this, 'body')
    this.documentElement.append(this.body)
    this.documentElement.parentNode = { isConnected: true }
    this.fonts = { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() }
    this.activeElement = null
  }
  createElement(tagName) {
    if (tagName !== 'template') return new FakeElement(this, tagName)
    const template = new FakeElement(this, 'template')
    template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', { set: markup => { template.content.firstElementChild = parse(this, markup)[0] || null } })
    return template
  }
  createElementNS(_namespace, tagName) { return this.createElement(tagName) }
  querySelector(selector) { return this.documentElement.querySelector(selector) }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector) }
  addEventListener() {}
  removeEventListener() {}
}

/* A profile that satisfies src/fleet-profile.js's own validator, which is what
   turns isSampleFleet() off and lets the fleet-health poll exist at all. */
const CONFIGURED_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'idle-poll-probe',
  label: 'Idle poll probe fleet',
  machines: [{ id: 'probe-one', name: 'Probe one', role: 'host', ip: '127.0.0.1' }],
  transports: [{ id: 'probe-local', label: 'Local', kind: 'local' }],
})

function installWindow({ configuredFleet = false } = {}) {
  const saved = {}
  const keys = ['document', 'window', 'localStorage', 'ResizeObserver', 'MutationObserver',
    'requestAnimationFrame', 'cancelAnimationFrame', 'mcAgent', 'mcProviders', 'mcShell',
    'mcFleetProfile', 'CustomEvent', 'location']
  for (const key of keys) saved[key] = globalThis[key]

  const documentRef = new FakeDocument()
  globalThis.document = documentRef
  globalThis.location = { hash: '', search: '', hostname: 'localhost' }
  globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
  globalThis.window = {
    document: documentRef,
    innerWidth: 1280,
    innerHeight: 800,
    location: globalThis.location,
    mcAgent: null,
    mcShell: { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }) },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  }
  const store = new Map()
  globalThis.localStorage = {
    get length() { return store.size },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  globalThis.mcFleetProfile = configuredFleet
    ? { bootstrap: { ok: true, configured: true, profile: CONFIGURED_PROFILE } }
    : undefined
  if (!configuredFleet) delete globalThis.mcFleetProfile
  globalThis.ResizeObserver = globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  globalThis.mcShell = globalThis.window.mcShell

  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } }
}

/* The bridge answers, immediately and unchangingly. An idle window whose reads
   all FAIL is a different measurement -- failure has its own slower retry -- so
   the reads succeed here and the answer never moves, which is exactly the case
   a back-off is supposed to notice. */
function installAnsweringBridge(setBridgeTransport) {
  setBridgeTransport(async (pathname) => {
    if (pathname.startsWith('/v1/owner-prompts')) return { ok: true, prompts: [] }
    if (pathname.startsWith('/v1/status')) {
      return {
        ok: true,
        health: { available: true, observedAtMs: 0, total: 1, counts: { OK: 1, DOWN: 0, STOPPED: 0, UNKNOWN: 0, OTHER: 0 } },
        peerLink: { outbound: { available: false } },
      }
    }
    return { ok: false, reason: 'not part of this measurement', code: 'PROBE_UNHANDLED' }
  })
}

/* ---------------------------------------------------------------------------
   Scenario 1: the process clock.

   It belongs to no view. Whatever schedules it runs for the whole life of the
   window, so its cost is charged to every screen including the empty one.
   --------------------------------------------------------------------------- */

async function measureProcessClock() {
  const mainSource = readFileSync(path.join(REPO_ROOT, 'src', 'main.js'), 'utf8')
  const unconditional = /setInterval\(\s*\(\)\s*=>\s*tickRuntimes\([^)]*\)\s*,\s*(\d+)\s*\)/.exec(mainSource)
  const runtimeClock = await import('../src/runtime-clock.js')
  const selfScheduling = typeof runtimeClock.startRuntimeClock === 'function'

  /* Two readings: an empty registry, which is every screen but two, and one
     with a readout on it, which is what the cadence guarantee is about. */
  const reading = async ({ readouts }) => {
    const clock = createRecordingClock()
    const restoreTimers = clock.install(globalThis)
    const release = []
    try {
      for (let index = 0; index < readouts; index += 1) {
        const node = { isConnected: true, textContent: '' }
        release.push(runtimeClock.bindRuntime(node, () => 0))
      }
      let stop = () => {}
      if (selfScheduling) stop = runtimeClock.startRuntimeClock()
      else if (unconditional) {
        const handle = globalThis.setInterval(
          () => runtimeClock.tickRuntimes(runtimeClock.fmtRuntime), Number(unconditional[1]))
        stop = () => globalThis.clearInterval(handle)
      }
      await clock.run(WINDOW_MS)
      stop()
      let fires = 0
      for (const entry of clock.sites.values()) fires += entry.fires
      return fires / MINUTES
    } finally {
      for (const off of release) off()
      restoreTimers()
    }
  }

  return {
    scheduling: selfScheduling
      ? 'runtime-clock.js, only while a readout is registered'
      : unconditional ? `src/main.js unconditional setInterval(${unconditional[1]}ms)` : 'unknown',
    unconditionalInMain: Boolean(unconditional),
    periodMs: unconditional ? Number(unconditional[1]) : null,
    firesPerMinute: await reading({ readouts: 0 }),
    firesPerMinuteWithReadout: await reading({ readouts: 1 }),
  }
}

/* ---------------------------------------------------------------------------
   Scenario 2: the idle home window.
   --------------------------------------------------------------------------- */

async function measureHome({ configuredFleet }) {
  const restoreWindow = installWindow({ configuredFleet })
  const clock = createRecordingClock()
  const restoreTimers = clock.install(globalThis)
  try {
    const agent = {
      history: async () => ({ ok: true, entries: [] }),
      availability: async () => ({ ok: true, available: true }),
      onEvent: () => () => {},
    }
    globalThis.mcAgent = agent
    globalThis.window.mcAgent = agent
    const { setBridgeTransport } = await import('../src/mission-bridge.js')
    installAnsweringBridge(setBridgeTransport)
    const { homeView } = await import('../src/views/home.js')
    const view = homeView()
    view.el.parentNode = { isConnected: true }
    await settle()
    await clock.run(WINDOW_MS)
    const rows = [...clock.sites.values()]
      .filter(entry => entry.fires > 0 || entry.kind === 'interval')
      .map(entry => ({
        site: entry.site,
        kind: entry.kind,
        delaysMs: [...entry.delays].sort((left, right) => left - right),
        firesPerMinute: entry.fires / MINUTES,
      }))
      .sort((left, right) => right.firesPerMinute - left.firesPerMinute)
    const sharedWakes = clock.sharedWakes()
    view.destroy()
    return { rows, sharedWakes }
  } finally { restoreTimers(); restoreWindow() }
}

/* ------------------------------------------------------------------------- */

function table(rows) {
  const headers = ['site', 'kind', 'period (ms)', 'ticks/min']
  const body = rows.map(row => [row.site, row.kind, row.delaysMs.join(', ') || '-', row.firesPerMinute.toFixed(2)])
  const widths = headers.map((header, column) => Math.max(header.length, ...body.map(line => line[column].length)))
  const line = cells => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...body.map(line)].join('\n')
}

if (!FACE) {
  /* Both faces, each in its own process, then the process clock once. */
  console.log(`RENDERER IDLE POLL INVENTORY -- ${MINUTES} virtual minutes, nothing touched`)
  const processClock = await measureProcessClock()
  console.log('')
  console.log('THE PROCESS CLOCK (charged to every screen, for the life of the window)')
  console.log(`  scheduling             : ${processClock.scheduling}`)
  console.log(`  unconditional in main  : ${processClock.unconditionalInMain ? `yes (${processClock.periodMs}ms)` : 'no'}`)
  console.log(`  ticks/min, no readouts : ${processClock.firesPerMinute.toFixed(2)}`)
  console.log(`  ticks/min, one readout : ${processClock.firesPerMinuteWithReadout.toFixed(2)}  (the cadence guarantee)`)
  for (const face of ['sample', 'configured']) {
    const out = execFileSync(process.execPath,
      [fileURLToPath(import.meta.url), `--minutes=${MINUTES}`, `--face=${face}`],
      { cwd: REPO_ROOT, encoding: 'utf8' })
    process.stdout.write(out)
    const subtotal = Number(/SUBTOTAL ([\d.]+)/.exec(out)?.[1] || 0)
    console.log(`  with the process clock : ${(subtotal + processClock.firesPerMinute).toFixed(2)} ticks/min`)
  }
} else {
  const { rows, sharedWakes } = await measureHome({ configuredFleet: FACE === 'configured' })
  const homeTotal = rows.reduce((sum, row) => sum + row.firesPerMinute, 0)
  console.log('')
  console.log(`THE IDLE HOME WINDOW -- ${FACE === 'configured' ? 'a configured fleet' : 'the bundled example, no fleet configured'}`)
  console.log(table(rows))
  console.log(`  view subtotal          : SUBTOTAL ${homeTotal.toFixed(2)} ticks/min`)
  console.log(`  shared wakes           : ${sharedWakes}  (instants where two of this view's polls fired together)`)
}
