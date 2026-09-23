#!/usr/bin/env node

/* CAN EITHER INSTRUMENT COUNT A LEAK IT IS SHOWN? A POSITIVE CONTROL FOR BOTH.
 *
 * WHY THIS EXISTS. Two instruments disagree about this product's memory.
 * tools/performance-budget-qa.mjs's memory scenario reports either about -400
 * DOM nodes per lap of the ring or about +15,500, on identical bytes.
 * tools/dom-retention-probe.mjs, watching the same navigation, reports a flat
 * census. Before another hour goes into asking WHICH IS TRUE OF THE PRODUCT, the
 * question has to be asked of the instruments: shown a leak of a size nobody is
 * guessing about, does each of them report it, at the right magnitude? And shown
 * a page that is genuinely clean, does each read zero?
 *
 * A per-lap figure that comes back NEGATIVE is the reason this is not optional.
 * A count of retained nodes cannot fall below where it started unless the thing
 * being counted is not retention -- it is occupancy, which mixes retention with
 * whatever has not been collected yet. That is a statement about the metric, and
 * a metric that can go negative can also go positive for reasons that have
 * nothing to do with a leak.
 *
 * WHAT IT MEASURES, on a page with NO product in it:
 *
 *   leak     each lap builds a subtree of a known size, takes it out of the
 *            document, and KEEPS a reference to it in a module-scope array,
 *            plus a known number of listeners on nodes inside it. This is a
 *            leak by construction: nothing can collect it.
 *   clean    each lap builds the same subtree, puts it in the document, takes
 *            it out again, and drops every reference. Nothing retains it, so a
 *            retention instrument must read zero.
 *   churn    each lap allocates the same subtree and drops it immediately
 *            WITHOUT a collection between laps. Nothing is retained; an
 *            occupancy metric that does not force a collection will still
 *            report growth. This is the control that separates "retained" from
 *            "not yet collected".
 *
 * BOTH INSTRUMENTS ARE RUN OVER THE SAME LAPS, in the same window, so the two
 * numbers describe one thing: Chromium's Performance.getMetrics `Nodes` (what
 * the budget gate asserts on) and the weak-reference census
 * (tools/dom-retention-probe.mjs's PROBE, what the retention probe reports).
 *
 * THE PAGE IS NOT THIS PRODUCT. It is a few hundred bytes written into a
 * scratch directory and loaded by a bare Electron window with `show: false`, so
 * nothing here can be explained by the application, and nothing appears on the
 * owner's desktop.
 *
 *   node tools/retention-instrument-check.mjs
 *   node tools/retention-instrument-check.mjs --laps 5 --per-lap 1000
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROBE } from './dom-retention-probe.mjs'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name, fallback) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const LAPS = Number(argument('--laps', 4))
const PER_LAP = Number(argument('--per-lap', 1000))
const LISTENERS_PER_LAP = Number(argument('--listeners-per-lap', 20))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const say = line => process.stdout.write(`${line}\n`)

/* The fixture. Three modes, one function, so the only difference between a leak
   and a clean lap is whether the reference is kept -- not the amount of work,
   not the shape of the tree, not the number of listeners. */
const FIXTURE = `<!doctype html>
<meta charset="utf-8">
<title>retention fixture</title>
<body>
<div id="host"></div>
<script>
  const kept = []
  window.__fixture = {
    kept,
    lap(mode, nodes, listeners) {
      const tree = document.createElement('div')
      tree.className = 'fixture-tree'
      for (let index = 0; index < nodes; index += 1) {
        const leaf = document.createElement('span')
        leaf.textContent = String(index)
        tree.appendChild(leaf)
      }
      document.getElementById('host').appendChild(tree)
      const targets = [...tree.children].slice(0, listeners)
      for (const target of targets) target.addEventListener('click', function fixtureHandler() { return tree })
      tree.remove()
      if (mode === 'leak') kept.push(tree)
      return { built: nodes, kept: kept.length }
    },
  }
</script>
</body>`

const MAIN = `'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.commandLine.appendSwitch('remote-debugging-port', process.env.FIXTURE_PORT)
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700 })
  window.loadFile(path.join(__dirname, 'fixture.html'))
})
app.on('window-all-closed', () => app.quit())
`

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function createSession(port, child) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open(budgetMs = 30_000) {
      const until = Date.now() + budgetMs
      while (Date.now() < until) {
        if (child.exitCode !== null) throw new Error(`the fixture window exited with code ${child.exitCode}`)
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
          const page = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true })
              socket.addEventListener('error', reject, { once: true })
            })
            socket.addEventListener('message', event => {
              const packet = JSON.parse(event.data)
              if (packet.id === undefined) return
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            return
          }
        } catch { /* not listening yet */ }
        await delay(120)
      }
      throw new Error('the fixture window never offered a debuggable page')
    },
    send(method, params = {}) {
      const id = nextId += 1
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

async function run(mode, scratch) {
  const port = await freePort()
  const appDir = path.join(scratch, `app-${mode}`)
  mkdirSync(appDir, { recursive: true })
  writeFileSync(path.join(appDir, 'fixture.html'), FIXTURE, 'utf8')
  writeFileSync(path.join(appDir, 'main.cjs'), MAIN, 'utf8')
  writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'retention-fixture', main: 'main.cjs' }), 'utf8')

  const electron = require_(path.join(REPO_ROOT, 'node_modules', 'electron'))
  /* ELECTRON_RUN_AS_NODE IS DELETED, NOT SET TO undefined.
     Under an agent harness the variable is exported as 1, and a spawn env that
     merely carries the key with an undefined value still passes it through on
     some paths -- the Electron binary then starts as plain Node, reads stdin,
     hits EOF and exits 0 with no window, which reads exactly like a product
     crash. tools/test/electron-run-as-node-harness-guard.test.mjs enforces the
     delete idiom across every harness for that reason, and it caught this file. */
  /* The fixture is not the product and reads no machine record, but it IS an
     Electron launch from tools/, and the harness guard holds every one of
     those to the same shared environment rather than judging each case. */
  const environment = {
    ...sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(scratch, `homes-${mode}`)))),
    FIXTURE_PORT: String(port),
  }
  const child = spawn(electron, [appDir, `--user-data-dir=${path.join(scratch, `profile-${mode}`)}`], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const session = createSession(port, child)
  const laps = []
  try {
    await session.open()
    await session.send('Performance.enable', {})
    await session.send('Page.enable', {})
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    /* The census only describes a document it watched from the first line. */
    await evaluate(session, 'location.reload()')
    await delay(1600)
    const installed = await evaluate(session, 'Boolean(window.__retention && window.__fixture)')
    if (installed !== true) throw new Error('the fixture or the census did not survive the reload')

    const baseline = await counters(session)
    for (let lap = 0; lap < LAPS; lap += 1) {
      await evaluate(session, `window.__fixture.lap(${JSON.stringify(mode)}, ${PER_LAP}, ${LISTENERS_PER_LAP})`)
      /* The churn control is the one that is NOT collected, on purpose. */
      const collected = mode === 'churn' ? 'not asked for' : await collect(session)
      const metrics = await counters(session)
      const census = await evaluate(session, '(window.__retention ? window.__retention.census() : null)')
      laps.push({
        lap: lap + 1,
        nodes: metrics.nodes,
        listeners: metrics.listeners,
        collected,
        censusRetained: census ? census.detachedNodesHeldByListeners : null,
        censusListeners: census ? census.listeners.onDetachedNodes : null,
      })
    }
    return { baseline, laps }
  } finally {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt += 1) await delay(150)
  }
}

async function evaluate(session, expression) {
  const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (packet?.result?.exceptionDetails) {
    throw new Error(String(packet.result.exceptionDetails.exception?.description || 'the fixture expression threw'))
  }
  return packet?.result?.result?.value
}

async function counters(session) {
  const packet = await session.send('Performance.getMetrics', {})
  const metrics = Object.fromEntries((packet?.result?.metrics || []).map(entry => [entry.name, entry.value]))
  return { nodes: metrics.Nodes ?? 0, listeners: metrics.JSEventListeners ?? 0 }
}

async function collect(session) {
  const packet = await session.send('HeapProfiler.collectGarbage')
  await delay(400)
  return packet && packet.error ? `refused: ${packet.error.message}` : 'collected'
}

function slope(laps, key) {
  if (laps.length < 2) return 0
  return Math.round((laps.at(-1)[key] - laps[0][key]) / (laps.length - 1))
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'retention-fixture-'))
  try {
    say(`fixture: ${PER_LAP} nodes and ${LISTENERS_PER_LAP} listeners built per lap, ${LAPS} laps\n`)
    const results = {}
    for (const mode of ['leak', 'clean', 'churn']) {
      const measured = await run(mode, scratch)
      results[mode] = measured
      say(`== ${mode} ==`)
      for (const lap of measured.laps) {
        say(`   lap ${lap.lap}: Nodes ${String(lap.nodes).padStart(6)}  JSEventListeners ${String(lap.listeners).padStart(4)}  `
          + `census retained ${String(lap.censusRetained).padStart(6)} nodes / ${lap.censusListeners} listeners  (${lap.collected})`)
      }
      say(`   PER LAP: gate metric ${slope(measured.laps, 'nodes')} nodes, ${slope(measured.laps, 'listeners')} listeners; `
        + `census ${slope(measured.laps, 'censusRetained')} nodes, ${slope(measured.laps, 'censusListeners')} listeners\n`)
    }

    /* THE VERDICT IS ABOUT THE INSTRUMENTS, NOT THE PRODUCT. */
    const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance
    const tolerance = Math.max(50, Math.round(PER_LAP * 0.2))
    const findings = []
    const gateLeak = slope(results.leak.laps, 'nodes')
    const gateClean = slope(results.clean.laps, 'nodes')
    const gateChurn = slope(results.churn.laps, 'nodes')
    const censusLeak = slope(results.leak.laps, 'censusRetained')
    const censusClean = slope(results.clean.laps, 'censusRetained')
    const censusChurn = slope(results.churn.laps, 'censusRetained')

    /* WHAT A LAP ACTUALLY BUILDS, counted rather than assumed. Each leaf is a
       <span> AND the text node inside it, plus the one container: Chromium's
       `Nodes` metric counts every Node, not every Element. The first version of
       this file expected PER_LAP + 1 and reported both instruments as wrong by
       a factor of two -- an instrument check that mis-states the answer is
       worse than none, because it condemns a sound instrument. */
    const builtPerLap = (PER_LAP * 2) + 1
    findings.push(['the gate metric SEES a real leak, at the right size', near(gateLeak, builtPerLap, tolerance), `${gateLeak}/lap against ${builtPerLap} built`])
    findings.push(['the gate metric reads 0 on a clean page', near(gateClean, 0, tolerance), `${gateClean}/lap`])
    findings.push(['the census SEES a real leak, at the right size', near(censusLeak, builtPerLap, tolerance), `${censusLeak}/lap against ${builtPerLap} built`])
    findings.push(['the census reads 0 on a clean page', near(censusClean, 0, tolerance), `${censusClean}/lap`])
    /* THE COLLECTION IS LOAD-BEARING, AND THIS IS WHERE THAT IS PROVED.
       `churn` retains NOTHING -- it drops every reference on the same line it
       makes it -- and it is the one mode that is never asked to collect. Both
       instruments report it as a leak of exactly the leak's size. So neither
       number means 'retained' on its own; each means 'still here', and only a
       collection before the sample turns the second into the first. A run whose
       collection did not happen is not evidence of a leak, and a gate that does
       not say whether it collected cannot be read at all. */
    findings.push(['skipping the collection manufactures a leak on BOTH instruments (so a collection is mandatory)',
      near(gateChurn, builtPerLap, tolerance) && near(censusChurn, builtPerLap, tolerance),
      `gate ${gateChurn}/lap, census ${censusChurn}/lap, against ${builtPerLap} built and 0 retained`])

    say('== what each instrument can be trusted to say ==')
    let failed = 0
    for (const [what, ok, detail] of findings) {
      if (!ok) failed += 1
      say(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}  -- ${detail}`)
    }
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10 }) } catch { /* the copy outlives the run */ }
  }
}

main().catch(error => {
  console.error(`the instrument check itself failed, which is a statement about this file: ${error?.stack || error}`)
  process.exitCode = 2
})
