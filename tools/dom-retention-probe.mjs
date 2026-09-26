#!/usr/bin/env node

/* WHAT IS HOLDING ON TO THE PAGES THIS PRODUCT HAS ALREADY LEFT.
 *
 * THE MEASUREMENT THAT MADE THIS NECESSARY. tools/performance-budget-qa.mjs's
 * memory scenario walks the ring and reads Chromium's own counters after each
 * lap. It reported node growth per lap far over its 400-node budget, monotonic
 * across every lap, with the step concentrated on one move. A count is enough to
 * fail a build and useless for fixing one: "15,000 nodes are left behind" names
 * no code.
 *
 * SO THIS ASKS THE NEXT QUESTION, AND IT IS THE ONLY QUESTION THAT LEADS TO A
 * FIX: WHICH nodes, and WHAT is still pointing at them. A detached DOM tree is
 * collected the moment nothing in JavaScript references it, so a tree that
 * survives a collection is being held by something -- a listener on a global, an
 * observer nobody disconnected, a timer, a module-scope array. Each of those is
 * a specific line of code.
 *
 * HOW IT LOOKS, and why it is not a heap snapshot. A snapshot names retainers
 * but arrives as a 200MB graph of minified frames; on a bundle it answers with
 * `t.n` and a chunk offset. This instead instruments the four ways a page can
 * keep hold of a node, BEFORE the document is created, and asks each one
 * afterwards whether what it is holding is still in the document:
 *
 *   listeners   every addEventListener on a Node, kept as a weak reference with
 *               the call site that registered it. A node the collector could
 *               take is gone from this census by construction, so what remains
 *               is exactly the set that is still referenced.
 *   observers   ResizeObserver / MutationObserver / IntersectionObserver hold a
 *               strong reference to what they observe until they are
 *               disconnected. An observer left watching a torn-down view keeps
 *               that view alive whole.
 *   timers      setInterval keeps its closure alive for ever, and closures over
 *               a view root keep the view.
 *   frames      requestAnimationFrame loops that re-arm themselves.
 *
 * WEAK REFERENCES ARE THE WHOLE HONESTY OF IT. Nothing here holds a node it is
 * reporting on. A probe that kept the nodes it measured would manufacture the
 * leak it claims to find, which is the classic way this instrument goes wrong.
 *
 * IT DRIVES THE REAL PACKAGED WINDOW on a staged copy of the build with this
 * tree's renderer inside it, and it navigates by CLICKING the only navigation
 * the product has, so the transitions measured are the transitions a person
 * makes.
 *
 *   node tools/dom-retention-probe.mjs
 *   node tools/dom-retention-probe.mjs --laps 4
 *   node tools/dom-retention-probe.mjs --pair approvals,settings   just one move
 *   node tools/dom-retention-probe.mjs --json <file>
 *
 * IT IS NOT A GATE and deliberately matches neither naming family
 * tools/packaged-qa-suite.mjs discovers (`-qa` and, since 2026-08-23,
 * `-drive`). Because it imports the packaged-driver harness it would
 * otherwise look like a driver to tools/check-drivers-discovered.mjs, so it
 * is named in that suite's HELD_OUT_OF_DISCOVERY map with this same reason:
 * the budget is the gate; this is the instrument you reach for when the gate
 * goes red.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const LAPS = Number(argument('--laps', 3))
const PAIR = (argument('--pair', '') || '').split(',').map(value => value.trim()).filter(Boolean)
const JSON_OUT = argument('--json', null)

/* THE PROBE, INSTALLED BEFORE ANY OF THE PRODUCT'S CODE RUNS.
 *
 * Page.addScriptToEvaluateOnNewDocument is what makes that possible: the
 * renderer's own modules register listeners while they are being evaluated, so a
 * probe injected afterwards would miss precisely the registrations that live for
 * the whole session. The page is reloaded once after the probe is installed, so
 * what is measured is a document that has been watched since its first line. */
/* EXPORTED, because the gate that reports the NUMBER should be able to show
   WHAT is behind it on demand: tools/performance-budget-qa.mjs installs this
   under --census. Nothing about the census changes what is measured -- it
   holds only weak references -- and it is off by default there, so the
   budget's own answer is taken on an uninstrumented page. */
export const PROBE = `(() => {
  if (window.__retention) return
  const records = []
  const observers = []
  const intervals = new Map()
  const frames = new Map()

  const siteOf = () => {
    const stack = String(new Error().stack || '')
    for (const line of stack.split('\\n').slice(1)) {
      /* THE PROBE'S OWN FRAMES ARE SKIPPED BY WHERE THEY COME FROM, not by
         name. This script is injected, so every one of its frames reads as
         <anonymous> while the product's carry the bundle's url. Filtering on
         the function name alone reported the probe's own helper as the call
         site of everything, which is an instrument describing itself. */
      if (line.includes('<anonymous>')) continue
      return line.trim().replace(/^at\\s+/, '').slice(0, 200)
    }
    return '(no call site outside the probe)'
  }
  const describe = (target) => {
    try {
      if (target === window) return 'window'
      if (target === document) return 'document'
      if (target && target.nodeType === 1) {
        return target.tagName.toLowerCase() + (target.className && typeof target.className === 'string'
          ? '.' + target.className.trim().split(/\\s+/)[0] : '')
      }
      if (target && target.nodeType === 3) return '#text'
      return (target && target.constructor && target.constructor.name) || String(target)
    } catch { return '(undescribable)' }
  }

  const addRaw = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function __retentionProbeAdd(type, handler, options) {
    try {
      /* Only NODES are recorded. A listener on window or on an abort signal is
         a different question and would drown this one; what is being hunted is
         a listener still attached to markup that has left the document. */
      if (this && this.nodeType === 1) {
        records.push({
          ref: new WeakRef(this),
          handler: (typeof handler === 'object' || typeof handler === 'function') && handler !== null ? new WeakRef(handler) : null,
          type: String(type), site: siteOf(), tag: describe(this), removed: false,
        })
      }
    } catch { /* the probe never breaks the page it watches */ }
    return addRaw.call(this, type, handler, options)
  }

  /* A REGISTRATION THAT WAS TAKEN BACK MUST NOT READ AS A LEAK. Without this the
     census counts every listener ever added to a node that has since left the
     document -- including every one a view's own destroy() correctly removed --
     and a page that cleans up perfectly looks identical to one that does not.
     Matched on target, type and handler identity, which is what the platform
     itself matches on. */
  const removeRaw = EventTarget.prototype.removeEventListener
  EventTarget.prototype.removeEventListener = function __retentionProbeRemove(type, handler, options) {
    try {
      if (this && this.nodeType === 1) {
        for (const record of records) {
          if (record.removed || record.type !== String(type)) continue
          if (record.ref.deref() !== this) continue
          if (record.handler && record.handler.deref() !== handler) continue
          record.removed = true
          break
        }
      }
    } catch { /* the probe never breaks the page it watches */ }
    return removeRaw.call(this, type, handler, options)
  }

  for (const name of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver']) {
    const Original = window[name]
    if (typeof Original !== 'function') continue
    const Wrapped = function __retentionProbeObserver(...args) {
      const instance = new Original(...args)
      const record = { kind: name, site: siteOf(), targets: [], disconnected: false }
      observers.push(record)
      const observeRaw = instance.observe ? instance.observe.bind(instance) : null
      const disconnectRaw = instance.disconnect ? instance.disconnect.bind(instance) : null
      if (observeRaw) {
        instance.observe = (target, ...rest) => {
          try { if (target && target.nodeType === 1) record.targets.push(new WeakRef(target)) } catch {}
          return observeRaw(target, ...rest)
        }
      }
      if (disconnectRaw) {
        instance.disconnect = (...rest) => { record.disconnected = true; return disconnectRaw(...rest) }
      }
      return instance
    }
    Wrapped.prototype = Original.prototype
    window[name] = Wrapped
  }

  const setIntervalRaw = window.setInterval
  const clearIntervalRaw = window.clearInterval
  window.setInterval = function __retentionProbeInterval(...args) {
    const id = setIntervalRaw.apply(window, args)
    try { intervals.set(id, siteOf()) } catch {}
    return id
  }
  window.clearInterval = function __retentionProbeClearInterval(id) {
    intervals.delete(id)
    return clearIntervalRaw.call(window, id)
  }

  const rafRaw = window.requestAnimationFrame
  const cafRaw = window.cancelAnimationFrame
  window.requestAnimationFrame = function __retentionProbeFrame(callback) {
    const site = siteOf()
    const id = rafRaw.call(window, (...args) => {
      frames.delete(id)
      return callback(...args)
    })
    try { frames.set(id, site) } catch {}
    return id
  }
  window.cancelAnimationFrame = function __retentionProbeCancelFrame(id) {
    frames.delete(id)
    return cafRaw.call(window, id)
  }

  /* THE CENSUS. Everything below asks a weak reference whether it still points
     at anything, and whether that thing is still in the document. A reference
     the collector already took reads as gone, which is the correct answer: it
     was not retained. */
  const subtreeSize = (node) => {
    try {
      let count = 1
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ALL)
      while (walker.nextNode()) count += 1
      return count
    } catch { return 1 }
  }

  window.__retention = {
    census() {
      const bySite = new Map()
      const byLiveSite = new Map()
      let detachedListeners = 0
      let liveListeners = 0
      let collected = 0
      /* Detached ROOTS, counted once each: a torn-off view with two hundred
         listeners in it is ONE retained tree, and reporting two hundred would
         make a single fault look like two hundred faults. */
      const roots = []
      const rootSeen = []
      const kept = []
      for (const record of records) {
        const node = record.ref.deref()
        if (!node) { collected += 1; continue }
        kept.push(record)
        if (node.isConnected) {
          liveListeners += 1
          /* WHERE THE LIVE ONES ARE PILING UP, and why that is not a
             contradiction in terms. A listener on window, document or any
             node that never leaves the page is attached FOR EVER by
             definition -- so a page whose detached census is flat can still
             be leaking listeners, one more per visit, on targets nothing ever
             detaches. The gate counts every registered listener, so that is
             exactly the shape that keeps its number red while the node count
             falls. Counted per site so accumulation is visible; a site that
             registers once and stays at one is doing its job. */
          if (!record.removed) {
            const liveKey = record.site + '  <' + record.tag + ' ' + record.type + '>'
            byLiveSite.set(liveKey, (byLiveSite.get(liveKey) || 0) + 1)
          }
          continue
        }
        /* THE NODE IS RETAINED WHATEVER THE LISTENER DID. A weak reference that
           still answers is proof that SOMETHING in JavaScript holds this node,
           which is the finding. Whether THIS listener is that something is a
           separate claim, so a registration that was properly taken back still
           counts as a retained tree and is left out of the site tally. */
        let root = node
        while (root.parentNode) root = root.parentNode
        if (!rootSeen.includes(root)) { rootSeen.push(root); roots.push(root) }
        if (record.removed) continue
        detachedListeners += 1
        const key = record.site + '  <' + record.tag + ' ' + record.type + '>'
        bySite.set(key, (bySite.get(key) || 0) + 1)
      }
      /* The kept records replace the old ones so this census does not grow
         without bound over a long run. Nothing strong is retained either way --
         these are weak references -- but an array of a million dead ones costs
         real memory and would show up as the leak. */
      records.length = 0
      for (const record of kept) records.push(record)

      /* A DETACHED TREE HAS TO BE NAMEABLE OR THE REPORT CANNOT BE ACTED ON.
         '<div.view> 6356 nodes' describes every view this product has. The
         fingerprint is the first thing inside it that says which page it was. */
      const fingerprint = (root) => {
        try {
          const named = root.querySelector('[data-mc], [data-settings-section], main[class], section[class], h1, h2')
          if (!named) return (root.textContent || '').trim().replace(/s+/g, ' ').slice(0, 60)
          return (named.getAttribute('data-mc') || named.className || named.textContent || '').toString().trim().replace(/s+/g, ' ').slice(0, 60)
        } catch { return '' }
      }
      const detachedTrees = roots.map(root => ({ tag: describe(root), nodes: subtreeSize(root), what: fingerprint(root) }))
        .sort((left, right) => right.nodes - left.nodes)

      const liveObservers = []
      for (const record of observers) {
        if (record.disconnected) continue
        let detached = 0
        let alive = 0
        for (const ref of record.targets) {
          const target = ref.deref()
          if (!target) continue
          alive += 1
          if (!target.isConnected) detached += 1
        }
        if (alive === 0) continue
        liveObservers.push({ kind: record.kind, site: record.site, watching: alive, detached })
      }

      return {
        listeners: { onDetachedNodes: detachedListeners, onLiveNodes: liveListeners, collectedSinceLast: collected },
        listenerSites: [...bySite.entries()].map(([site, count]) => ({ site, count }))
          .sort((left, right) => right.count - left.count).slice(0, 20),
        liveListenerSites: [...byLiveSite.entries()].map(([site, count]) => ({ site, count }))
          .sort((left, right) => right.count - left.count).slice(0, 12),
        detachedTrees: detachedTrees.slice(0, 20),
        detachedNodesHeldByListeners: detachedTrees.reduce((sum, tree) => sum + tree.nodes, 0),
        observers: liveObservers.sort((left, right) => right.detached - left.detached).slice(0, 20),
        intervals: [...intervals.entries()].map(([id, site]) => ({ id, site })).slice(0, 20),
        /* FRAMES THE PAGE HAS PROMISED AND NOT YET RUN, counted per call site.
           A pending requestAnimationFrame callback is retained BY THE BROWSER
           (ScriptedAnimationController holds the callback, the callback's scope
           holds whatever it closed over), so on a page that never gets a frame
           it is a leak with a call site -- and the site is the fix's address.
           Counted rather than listed because the question is whether a site
           ACCUMULATES: one pending frame is a page mid-animation, five more of
           the same site per lap of the ring is a queue nothing will service. */
        pendingFrameSites: (() => {
          const bySite = new Map()
          for (const site of frames.values()) bySite.set(site, (bySite.get(site) || 0) + 1)
          return [...bySite.entries()].map(([site, count]) => ({ site, count }))
            .sort((left, right) => right.count - left.count).slice(0, 12)
        })(),
        pendingFrames: frames.size,
        documentNodes: document.getElementsByTagName('*').length,
      }
    },
  }
})()`

const ROUTE_NOW = `(() => ({ route: (location.hash || '#/').replace(/^#\\/?/, '') || 'home' }))()`
const CLICK_NEXT = `(() => { const b = document.getElementById('nav-next'); if (!b) return false; b.click(); return true })()`

async function settle(window, quietMs = 220, budgetMs = 20_000) {
  const until = Date.now() + budgetMs
  let last = -1
  let quietSince = Date.now()
  for (;;) {
    const count = await window.evaluate('document.getElementsByTagName("*").length')
    if (count !== last) { last = count; quietSince = Date.now() }
    if (Date.now() - quietSince >= quietMs) return { settled: true, nodes: last }
    if (Date.now() >= until) return { settled: false, nodes: last }
    await delay(80)
  }
}

async function counters(window) {
  const packet = await window.session.send('Performance.getMetrics', {})
  const metrics = Object.fromEntries((packet?.result?.metrics || []).map(entry => [entry.name, entry.value]))
  return { nodes: metrics.Nodes ?? 0, listeners: metrics.JSEventListeners ?? 0, documents: metrics.Documents ?? 0 }
}

async function collect(window) {
  try { await window.session.send('HeapProfiler.collectGarbage', {}) } catch { /* best effort */ }
  await delay(500)
}

const say = line => process.stdout.write(`${line}\n`)

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'retention-probe-'))
  let window = null
  const record = { measuredAt: new Date().toISOString(), laps: [], moves: [] }
  try {
    say('staging the packaged build with this tree inside it...')
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)

    await window.session.send('Page.enable', {})
    await window.session.send('Performance.enable', {})
    await window.session.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    /* The probe is only true of a document it was present for, so the page is
       reloaded once and everything below is measured on that document. */
    await window.evaluate('location.reload()')
    await delay(4200)
    const installed = await window.evaluate('Boolean(window.__retention)')
    if (installed !== true) throw new Error('the probe did not survive the reload, so nothing below would be a measurement')

    let route = (await window.evaluate(ROUTE_NOW)).route
    say(`starting at ${route}`)

    for (let lap = 0; lap < LAPS; lap += 1) {
      const seen = new Set([route])
      for (let step = 0; step < 14; step += 1) {
        const from = route
        const before = await counters(window)
        await window.evaluate(CLICK_NEXT)
        await settle(window)
        route = (await window.evaluate(ROUTE_NOW)).route
        await collect(window)
        const after = await counters(window)
        const move = {
          lap: lap + 1,
          from,
          to: route,
          nodes: after.nodes - before.nodes,
          listeners: after.listeners - before.listeners,
          totalNodes: after.nodes,
        }
        record.moves.push(move)
        if (PAIR.length !== 2 || (PAIR[0] === from && PAIR[1] === route)) {
          say(`  lap ${move.lap}  ${String(from).padEnd(12)} -> ${String(route).padEnd(12)} `
            + `nodes ${String(move.nodes).padStart(7)}  listeners ${String(move.listeners).padStart(5)}  (total ${move.totalNodes})`)
        }
        if (seen.has(route)) break
        seen.add(route)
      }
      await collect(window)
      const census = await window.evaluate('window.__retention.census()')
      const metrics = await counters(window)
      record.laps.push({ lap: lap + 1, metrics, census })
      say(`\nlap ${lap + 1}: ${metrics.nodes} nodes, ${metrics.listeners} listeners, ${metrics.documents} documents`)
      say(`  listeners still registered on nodes that have left the document: ${census.listeners.onDetachedNodes}`)
      say(`  nodes held alive by those listeners: ${census.detachedNodesHeldByListeners}`)
      for (const tree of census.detachedTrees.slice(0, 8)) say(`    ${String(tree.nodes).padStart(6)} nodes  <${tree.tag}>  ${tree.what || ''}`)
      say('  the call sites that registered them:')
      for (const site of census.listenerSites.slice(0, 10)) say(`    ${String(site.count).padStart(5)}x  ${site.site}`)
      if (census.observers.length) {
        say('  observers nobody disconnected:')
        for (const observer of census.observers.slice(0, 8)) {
          say(`    ${observer.kind} watching ${observer.watching} (${observer.detached} detached)  ${observer.site}`)
        }
      }
      if (census.intervals.length) {
        say('  repeating timers still running:')
        for (const timer of census.intervals.slice(0, 8)) say(`    ${timer.site}`)
      }
      say('')
    }
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    if (JSON_OUT) {
      writeFileSync(path.resolve(JSON_OUT), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      say(`measurement written to ${path.resolve(JSON_OUT)}`)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the copy outlives the run */ }
  }
}

/* RUN ONLY WHEN RUN, and this is not defensive decoration: the census source
 * above is exported, tools/performance-budget-qa.mjs imports it under --census,
 * and an unguarded main() at module scope meant that import DROVE A WHOLE
 * THREE-LAP SESSION before the gate had measured anything -- three extra app
 * instances, minutes of wall clock, and a census printed into the middle of
 * another tool's output. Measured the first time the two were joined. */
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  main().catch(error => {
    console.error(`the probe itself failed, which is not a product finding: ${error?.stack || error}`)
    process.exitCode = 2
  })
}
