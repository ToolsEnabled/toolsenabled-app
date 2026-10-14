#!/usr/bin/env node

// WHAT THIS PRODUCT COSTS THE MACHINE IT RUNS ON, MEASURED ON THE PACKAGED WINDOW.
//
// WHY IT EXISTS. The owner's requirement, in his words: "make sure the software
// performs at a high level as in there is no lag. This could potentially be
// being used to have many cloud agents work on a very weak pc, the last thing we
// want is to be the reason that system [struggles]." That names a worst case --
// a WEAK machine running MANY agents -- and nothing in this tree measured it.
// Every existing packaged driver asks whether a thing WORKS. None asks what it
// COSTS. A product that works perfectly and burns a core doing nothing is the
// exact failure he described.
//
// FOUR COSTS, EACH MEASURED WHERE A PERSON WOULD FEEL IT:
//
//   coldstart  Process spawn -> the window is READABLE and SETTLED. Not
//              "the port answered" (smoke-packaged.mjs owns that) and not
//              loadEventEnd, which fires while the router is still building the
//              first view. Measured from OUR spawn clock through the renderer's
//              performance.timeOrigin, so the number includes Electron start,
//              the port scan, the HTTP serve and the bundle's parse+execute --
//              all of it, the way a person's wait includes all of it.
//
//   routes     Every stop on the ring, entered by CLICKING the only navigation
//              the app has, timed from the click to the DOM going quiet. The
//              renderer's own Performance counters (script, style, layout) are
//              read either side of each move, so a slow route can be attributed
//              rather than merely noticed.
//
//   idle      What the product consumes doing NOTHING, per route, over a >=30s
//             window: whole-process-tree CPU from the OS, and renderer script/
//             layout duration from Chromium. The engine tree has an idle-CPU
//             ceiling for the MCP server (tools/idle-cpu-check.js, 1% of one
//             core); this is the same question asked of the desktop product,
//             which is the process that is actually open all day.
//
//             THE WINDOW IS VISIBLE ON PURPOSE. MC_SMOKE_HEADLESS=1 gives the
//             BrowserWindow show:false, and Chromium throttles or stops
//             requestAnimationFrame in a hidden window -- so a headless idle
//             measurement would report a clean 0% for a page burning a frame
//             loop forever. That is the defect class this scenario exists to
//             find, so it must be measured on a window that is genuinely shown.
//
//             AND "SHOWN" IS NOT THE SAME AS "DRAWING", which is the trap this
//             file fell into. Measured 2026-08-18: this harness spawns with
//             windowsHide:true, and a window created that way reports
//             IsWindowVisible=False; even spawned with windowsHide:false and
//             genuinely shown, a second copy of the product lands at the SAME
//             default bounds and covers it. Either way the page reports
//             document.visibilityState === 'hidden' and rAF stops. So the API
//             is not lying to you -- ask the PAGE what it thinks it is, never
//             the window handle, and treat an idle number taken on a page that
//             reports hidden as softer than this scenario claims.
//
//   memory    Repeated laps of the ring, reading the JS heap, the DOM node
//             count and the live listener count after each lap. A product left
//             open all day on a weak PC must not creep; a per-lap slope is what
//             says whether it does.
//
// EXIT CODES -- THREE VALUES, ONLY TWO ARE VERDICTS:
//   0  every measured budget held
//   1  a budget was EXCEEDED -- a statement about the product
//   2  NO VERDICT: the harness never attached or never measured. A statement
//      about the probe or the machine, NEVER about the product.
// Never read it through a pipe: `node x.mjs | tail` reports TAIL's status.
//
// RUN IT:
//   node tools/performance-budget-qa.mjs                    (all scenarios)
//   node tools/performance-budget-qa.mjs --scenario coldstart
//   node tools/performance-budget-qa.mjs --explore          (measure, assert nothing)
//   --release <dir>   which packaged build to borrow   (default release/win-unpacked)
//   --stage <dir>     reuse a staged copy from an earlier run (skips a 350MB copy)
//   --keep            keep the staged copy and print its path for reuse
//   --runs <n>        cold-start repetitions (default 3)
//   --idle-ms <n>     idle sample window (default 35000)
//   --laps <n>        ring laps for the memory scenario (default 3)
//   --json <file>     write the full measurement record for a before/after diff

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { createSteadinessTracker, unmeasurableLine } from './machine-steadiness.mjs'
import { resolveMachineServicesRoot } from './lib/qa-services-root.mjs'
/* WHAT is being retained, on demand. The budget answers 'how much', which is
   the right thing for a gate to assert and the wrong thing to hand somebody
   who has to fix it. --census installs the retention probe's own instrument
   in the memory scenario and prints its answer beside each lap. */
import { PROBE as RETENTION_PROBE } from './dom-retention-probe.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const execFile = promisify(execFileCallback)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const flag = (name) => process.argv.includes(name)

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const REUSE_STAGE = argument('--stage', null)
const KEEP = flag('--keep')
const EXPLORE = flag('--explore')
const RUNS = Number(argument('--runs', 3))
const IDLE_MS = Number(argument('--idle-ms', 35_000))
const LAPS = Number(argument('--laps', 3))
const JSON_OUT = argument('--json', null)
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120_000))
/* Which product state the everyday scenarios measure. `standard` is the middle
   permission level; the number this harness reports must not depend on which
   answer a person gave, so if that ever stops being true the difference is a
   finding rather than a knob. */
const SEED_TIER = argument('--seed-tier', 'standard')
/* Print the sampled call frames behind a measurement. Off by default: the
   numbers are the verdict, the frames are the investigation. */
const PROFILE = flag('--profile')
const CENSUS = flag('--census')
/* HOW MANY TIMES TO ASK FOR A COLLECTION BEFORE READING THE COUNT.
   One is what this file has always asked for. Whether one is ENOUGH for a
   detached DOM tree is a question about Blink, not about the product, and it
   is the difference between 'retained' and 'not collected yet' -- so it is a
   knob that can be turned in an experiment rather than an assumption baked in.
   tools/retention-instrument-check.mjs is the fixture that says what each
   setting can be trusted to report. */
const COLLECT_PASSES = Number(argument('--collect-passes', 1))
/* WHO HOLDS THE DEAD VIEWS. The census (--census) names WHAT is retained per
   lap; it cannot name the object that keeps it reachable. --snapshot <dir>
   writes a full V8 heap snapshot (with retainer edges) into <dir> after each
   memory lap, taken through the same session the gate measures with, AFTER the
   gate's own forced collection -- so anything in the snapshot is retained by
   the product, not awaiting a sweep. Investigation only, never part of the
   verdict: tools/heap-snapshot-retainers.mjs is the reader that walks a
   detached view back to the GC root and names the holder. */
const SNAPSHOT_DIR = argument('--snapshot', null)
/* THE MODE-B DIAL. The memory scenario on this tree was BIMODAL on identical
   bytes: ~-400 nodes/lap on a quiet machine, the same +15,5xx to the digit on
   a loaded one. The heap snapshots settled what the second mode is: the
   window had been covered, Chromium stopped giving the page rendering frames,
   and every retirement step that only completes on a rendering lifecycle
   update (the exit transition's cancellation, the removed wrapper's layout
   teardown) was deferred forever -- the DocumentTimeline then holds a
   CSSTransition per retired wrapper and the wrapper holds the whole dead
   view. --occluded turns that machine state into a switch: the window is
   minimised after it settles, which is exactly what a taskbar or another
   window does to a real person's copy all day long. A leak that only needs a
   covered window is still a leak; this flag is what makes it a reproducible
   one instead of weather. */
const OCCLUDED = flag('--occluded')
const SCENARIOS = argument('--scenario')
  ? argument('--scenario').split(',')
  /* `scale` and `weakpc` are investigations rather than gates -- they answer
     "how big" and "how slow a machine", which are curves, not thresholds -- so
     they are opt-in. `bridge` is in the default set because it is an assertion
     about correctness that the cold-start work made necessary. */
  : ['coldstart', 'bridge', 'routes', 'idle', 'memory']
const KNOWN_SCENARIOS = new Set(['coldstart', 'bridge', 'routes', 'idle', 'memory', 'scale', 'weakpc'])

function validateSelection() {
  const unknown = SCENARIOS.filter((scenario) => !KNOWN_SCENARIOS.has(scenario))
  if (unknown.length) {
    throw new HarnessError(`--scenario selected unknown name(s): ${unknown.map(JSON.stringify).join(', ')}`)
  }
  /* An explicit empty route enumeration used to call measureIdle with [], make
     no idle assertion, and then report success. A selected measurement with no
     targets is absence of evidence, never evidence that its budgets held. */
  if (SCENARIOS.includes('idle')) {
    const targets = (argument('--idle-routes', 'home,computers') || '').split(',').filter(Boolean)
    if (targets.length === 0) throw new HarnessError('--idle-routes selected no routes')
  }
}

/* THE BUDGETS ARE PRODUCT DECISIONS, SO THEY ARE NAMED HERE AND ASSERTED.
   Each is set from the measured reality on this machine with headroom for a
   weaker one, and each says what it is protecting. A budget equal to today's
   measurement turns any deliberate change red and trains people to raise the
   number; a budget ten times the measurement notices nothing. */
const BUDGETS = Object.freeze({
  // Spawn -> settled first view. The reference machine here is not weak; a
  // weak one is materially slower at exactly the parse/execute step this
  // number is dominated by, so the ceiling carries that multiple.
  coldStartMs: 6_000,
  // Click -> the view has stopped changing. Above roughly a fifth of a second
  // a navigation stops feeling like a response and starts feeling like a wait.
  routeSettleMs: 900,
  // Doing nothing, per route, whole process tree, sustained. The engine's MCP
  // ceiling is 1% of one core; a desktop window legitimately costs more than a
  // headless server (compositor, blinking caret), and this is still an order
  // of magnitude below "you can hear the fan".
  idleCpuPercentOfOneCore: 6.0,
  // Renderer script time while idle, per second of wall clock. A page that is
  // truly at rest spends ~0 here; this catches a frame loop that the OS number
  // might hide behind a busy machine.
  idleScriptMsPerSecond: 12,
  // JS heap growth per completed lap of the ring, after the first lap (which
  // is module warm-up, not a leak).
  heapGrowthPerLapMb: 4,
  // DOM nodes left behind per lap. A view that tears down cleanly returns to
  // roughly the count it started at.
  nodeGrowthPerLap: 400,
  // LISTENERS left behind per lap, and it is here because the number was already
  // being computed and thrown away -- measured, reported in the line above the
  // verdict, and asserted against nothing, which is the same defect class as a
  // settings row nothing reads.
  //
  // WHAT IT CAN AND CANNOT SEE, stated so nobody reads more into a green than is
  // there. Measured on this machine across two builds, the lap-to-lap figure at
  // this measurement point ranges over about ten either side of zero, because a
  // lap ends immediately after the move that collects the previous page. So this
  // catches a view that leaks a handful of listeners per visit within a few laps
  // and CANNOT see a creep of a few per lap; tools/dom-retention-probe.mjs is
  // the instrument for that, and it is what found the corona this budget could
  // not (its census is exact because it asks weak references rather than
  // subtracting two totals).
  listenerGrowthPerLap: 20,
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------- a failure of the probe is not a finding about the product ---------- */
class HarnessError extends Error {}

const say = (line) => process.stdout.write(`${line}\n`)

/* WHETHER THIS COMPUTER CAN BE TIMED AT ALL, sampled through the whole run.
 *
 * Every budget below is a fixed number of milliseconds. On 2026-08-16 identical
 * fixed CPU work on this machine ran anywhere from 356ms to 5408ms, and the
 * product's own account create took 3.3s one day and 13.7s the next on
 * byte-identical builds. Against that, a fixed budget measures the machine, not
 * the product -- and a red that means "your computer was busy" teaches everyone
 * to ignore reds.
 *
 * The sample rides `note` deliberately. Steadiness cannot be established by one
 * reading before the run: the slowdown is a state change that sustained work
 * BRINGS ON, so a pre-flight probe reads a cool machine and then the scenarios
 * do the heating. `note` is called once per measurement line, which spreads the
 * samples across the entire run for about 20ms each. */
const steadiness = createSteadinessTracker()
const note = (line) => {
  steadiness.sample()
  process.stdout.write(`  ..    ${line}\n`)
}

/* ---------- stage a real packaged copy, with the CURRENT tree inside it ----------
 * Borrows the built binary and swaps in the working tree's dist/ and shell/, so
 * this measures the code as it is now inside a real packaged artifact rather
 * than whenever release/ was last built. Writes nothing under release/.
 * The 350MB copy is the slow part and only the asar changes between rounds, so
 * --stage lets a before/after pair share one copy. */
async function stageApp(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.resolve(argument('--dist', path.join(REPO_ROOT, 'dist'))) })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = REUSE_STAGE ? path.resolve(REUSE_STAGE) : path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')

  if (!REUSE_STAGE) {
    if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
      throw new HarnessError(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
    }
    const copyStarted = Date.now()
    cpSync(RELEASE, app, { recursive: true, dereference: true })
    note(`copied the packaged build in ${Date.now() - copyStarted}ms -> ${app}`)
  } else if (!existsSync(path.join(app, 'resources', 'app.asar'))) {
    throw new HarnessError(`--stage ${app} is not a staged packaged build (no resources/app.asar).`)
  }

  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    /* --dist / --shell name a DIFFERENT copy of one half of the product, which
       is what makes an honest A/B possible on a machine that is doing other
       work: the same binary, the same profile, the same minute, one variable.
       Comparing a measurement taken now against one taken twenty minutes ago is
       comparing two machine loads, not two builds. */
    const from = path.resolve(argument(`--${directory}`, path.join(REPO_ROOT, directory)))
    if (!existsSync(from)) throw new HarnessError(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.resolve(argument('--dist', path.join(REPO_ROOT, 'dist'))),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  rmSync(unpacked, { recursive: true, force: true })
  return { app, executable: appExecutable(app) }
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter((entry) => entry.toLowerCase().endsWith('.exe'))
  const launcher = executables.find((entry) => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (!launcher) throw new HarnessError(`cannot tell which of these is the launcher: ${executables.join(', ') || 'none'}`)
  return path.join(appRoot, launcher)
}

/* ---------- the OS's account of what the whole application costs ----------
 * Every Electron process (browser, renderer, GPU, utility) runs from the same
 * executable, so the tree is exactly the set of processes whose image is the
 * staged binary. Summed, because a person's machine feels the sum -- charging a
 * renderer's frame loop to "only the renderer" is how a 4-process product
 * reports a quarter of its own cost. */
async function processTreeCpuSeconds(executable) {
  const quoted = executable.replace(/'/g, "''")
  const { stdout } = await execFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${quoted}' }); ` +
    "if ($p.Count -eq 0) { [Console]::Out.Write('none') } else { " +
    "[Console]::Out.Write((($p | Measure-Object -Property CPU -Sum).Sum).ToString() + '|' + $p.Count + '|' + " +
    "(($p | Measure-Object -Property WorkingSet64 -Sum).Sum).ToString()) }",
  ], { windowsHide: true, timeout: 30_000 })
  const raw = stdout.trim()
  if (raw === 'none' || !raw) return null
  const [cpu, count, workingSet] = raw.split('|')
  const seconds = Number(cpu)
  if (!Number.isFinite(seconds)) return null
  return { seconds, processes: Number(count), workingSetBytes: Number(workingSet) }
}

/* ---------- attach to the real window ---------- */
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

async function publishedDebuggerPort(userDataDir, child, budgetMs) {
  const file = path.join(userDataDir, ACTIVE_PORT_FILE)
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (child.exitCode !== null) {
      throw new HarnessError(`the app exited with code ${child.exitCode} before it published a debugger port`)
    }
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* not written yet */ }
    await delay(50)
  }
  throw new HarnessError(`the app never wrote ${ACTIVE_PORT_FILE} within ${Math.round(budgetMs / 1000)}s`)
}

function createSession(child, userDataDir) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  /* Replies carry an id; EVENTS do not, and until --snapshot existed every
     event was dropped on the floor. HeapProfiler.takeHeapSnapshot delivers its
     entire payload as addHeapSnapshotChunk events before the reply, so a
     session that ignores events can ask for a snapshot and receive an empty
     acknowledgement of it. One handler per method is all the file needs. */
  const eventHandlers = new Map()
  return {
    async open(budgetMs) {
      const started = Date.now()
      const port = await publishedDebuggerPort(userDataDir, child, budgetMs)
      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered`)
        }
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
          const page = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true })
              socket.addEventListener('error', reject, { once: true })
            })
            socket.addEventListener('message', (event) => {
              const packet = JSON.parse(event.data)
              if (packet.id === undefined) {
                const handler = eventHandlers.get(packet.method)
                if (handler) handler(packet.params)
                return
              }
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            return
          }
          lastSeen = targets.length
            ? `${targets.length} target(s), none a debuggable page`
            : 'the endpoint answered with an EMPTY target list -- the process is up but no window opened'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(100)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s -- ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve) => pending.set(id, resolve))
    },
    on(method, handler) { eventHandlers.set(method, handler) },
    off(method) { eventHandlers.delete(method) },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* THE PAGE MOVES OUT FROM UNDER THE PROBE, AND THAT IS NORMAL.
 *
 * The debugger attaches to the target before it has navigated anywhere, so the
 * very first evaluations race the about:blank -> http://127.0.0.1:<port>/
 * navigation. Chromium answers those with an error packet and no result, which
 * a naive reader turns into `undefined` and then into a TypeError three frames
 * later -- a harness failure wearing the costume of a product failure. A
 * destroyed context is a retry; anything else is reported with the reason
 * Chromium gave, never swallowed. */
async function evaluate(session, expression, { attempts = 30 } = {}) {
  let lastReason = 'no reason was reported'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const packet = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (packet.result?.exceptionDetails) {
      throw new HarnessError(`the page threw evaluating a probe: ${packet.result.exceptionDetails.text} ${packet.result.exceptionDetails.exception?.description || ''}`)
    }
    if (packet.result?.result) return packet.result.result.value
    lastReason = packet.error?.message || JSON.stringify(packet).slice(0, 200)
    if (!/context|destroyed|Inspected target navigated|not found/i.test(lastReason)) break
    await delay(100)
  }
  throw new HarnessError(`the debugger would not evaluate a probe: ${lastReason}`)
}

/* Chromium's own counters, so a slow route can be attributed rather than merely
   noticed: which of script, style recalculation and layout the time went to. */
async function counters(session) {
  const packet = await session.send('Performance.getMetrics')
  const out = {}
  for (const metric of packet.result?.metrics || []) out[metric.name] = metric.value
  return out
}
const countersDelta = (before, after) => ({
  scriptMs: Math.max(0, ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000),
  layoutMs: Math.max(0, ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000),
  styleMs: Math.max(0, ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000),
  taskMs: Math.max(0, ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000),
  layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
  styleRecalcs: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
  nodes: after.Nodes ?? 0,
  listeners: after.JSEventListeners ?? 0,
  heapMb: (after.JSHeapUsedSize ?? 0) / 1024 / 1024,
})

/* ---------- what is on the glass, and whether it has stopped moving ----------
 * A fixed sleep is the usual patch and it is the wrong one: too short under
 * load and it flakes, long enough to be safe and every number it produces is
 * that sleep. So quiescence is MEASURED -- a MutationObserver counts DOM
 * mutations and the page is settled when a window passes with none. The wait is
 * returned so a route that never settles is reported as such rather than
 * silently sampled mid-build. */
const SETTLE = `((quietMs, budgetMs) => new Promise(resolve => {
  const started = performance.now()
  let mutations = 0
  let lastMutation = performance.now()
  const observer = new MutationObserver(records => { mutations += records.length; lastMutation = performance.now() })
  /* THE ATTACH CAN WIN THE RACE AGAINST THE DOCUMENT. The debugger answers as
     soon as the target exists, which on a cold start is before the first byte
     of index.html has been parsed -- documentElement is then null and observe()
     throws. A document that does not exist yet is the least settled state
     there is, so wait for it rather than treating the race as a failure. */
  const observeWhenThereIsSomethingToObserve = () => {
    const root = document.documentElement
    if (!root) {
      if (performance.now() - started >= budgetMs) { resolve({ settled: false, waitedMs: performance.now() - started, mutations, reason: 'no document' }); return false }
      setTimeout(observeWhenThereIsSomethingToObserve, 25)
      return false
    }
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
    lastMutation = performance.now()
    setTimeout(tick, 25)
    return true
  }
  const tick = () => {
    if (performance.now() - lastMutation >= quietMs) {
      observer.disconnect()
      resolve({ settled: true, waitedMs: performance.now() - started, mutations })
      return
    }
    if (performance.now() - started >= budgetMs) {
      observer.disconnect()
      resolve({ settled: false, waitedMs: performance.now() - started, mutations })
      return
    }
    setTimeout(tick, 25)
  }
  observeWhenThereIsSomethingToObserve()
}))`

const settle = (session, quietMs = 220, budgetMs = 15_000) =>
  evaluate(session, `${SETTLE}(${quietMs}, ${budgetMs})`)

/* THE FIRST VIEW, NOT THE FIRST DOCUMENT. The debugger attaches while the page
   is still about:blank -- which has a documentElement, is perfectly quiet, and
   would let a settle-only wait declare a cold start finished before the product
   had loaded a single byte. "Interactive" here means the router has mounted a
   view into #stage and stamped the route it belongs to; anything less is a
   blank window, which is exactly what a person waiting for this product sees as
   NOT started. */
const FIRST_VIEW = `((budgetMs) => new Promise(resolve => {
  const started = performance.now()
  const ready = () => {
    const stage = document.getElementById('stage')
    return Boolean(stage && stage.firstElementChild && (document.body?.dataset?.route || '').length)
  }
  const tick = () => {
    if (ready()) { resolve({ arrived: true, waitedMs: performance.now() - started, route: document.body.dataset.route }); return }
    if (performance.now() - started >= budgetMs) { resolve({ arrived: false, waitedMs: performance.now() - started, route: document.body?.dataset?.route || '' }); return }
    setTimeout(tick, 20)
  }
  tick()
}))`

/* The two waits in the order a person experiences them: the view appears, then
   it stops changing. Reported separately so "slow to appear" and "appears then
   thrashes" are never confused for one another. */
async function firstViewThenSettle(session, quietMs, budgetMs) {
  const arrival = await evaluate(session, `${FIRST_VIEW}(${budgetMs})`)
  if (!arrival.arrived) throw new HarnessError(`no view was mounted into #stage within ${budgetMs}ms; the window is blank, so nothing about its speed can be said`)
  const settled = await evaluate(session, `${SETTLE}(${quietMs}, ${budgetMs})`)
  return { ...settled, arrival }
}

/* The cold-start account the page keeps of itself. performance.timeOrigin is an
   absolute epoch millisecond, which is what lets a renderer-relative number be
   joined to OUR spawn clock -- without it, "1.2s to first paint" silently omits
   everything Electron did before the renderer existed. */
const BOOT_PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {}
  const paints = {}
  for (const entry of performance.getEntriesByType('paint')) paints[entry.name] = entry.startTime
  const resources = performance.getEntriesByType('resource').map(entry => ({
    name: entry.name.split('/').pop(),
    kind: entry.initiatorType,
    startMs: Math.round(entry.startTime * 10) / 10,
    durationMs: Math.round(entry.duration * 10) / 10,
    bytes: entry.encodedBodySize || 0,
  }))
  return {
    timeOrigin: performance.timeOrigin,
    /* THE WHOLE NAVIGATION, PHASE BY PHASE. A single "cold start is 4 seconds"
       cannot be acted on; it can only be worried about. These are the seams a
       fix has to land between: how long the shell took to answer for the
       document at all, how long the head's blocking work held the parser, when
       the application bundle was even REQUESTED, and how long it then ran. */
    requestStart: nav.requestStart || 0,
    responseStart: nav.responseStart || 0,
    responseEnd: nav.responseEnd || 0,
    domInteractive: nav.domInteractive || 0,
    domContentLoaded: nav.domContentLoadedEventEnd || 0,
    loadEventEnd: nav.loadEventEnd || 0,
    firstPaint: paints['first-paint'] || 0,
    firstContentfulPaint: paints['first-contentful-paint'] || 0,
    resources,
    route: document.body.dataset.route || '',
    nodes: document.getElementsByTagName('*').length,
  }
})()`

/* Navigation is by CLICKING the only navigation the app has. A harness that
   assigns location.hash measures a router, not a product; the arrow is what a
   person presses and it is what has to be fast. */
const CLICK_NEXT = `(() => {
  const button = document.getElementById('nav-next')
  if (!button) return { clicked: false, reason: 'no #nav-next on the page' }
  const from = document.body.dataset.route || ''
  button.click()
  return { clicked: true, from, dest: button.dataset.dest || '' }
})()`

const ROUTE_NOW = `(() => ({ route: document.body.dataset.route || '', hash: location.hash }))()`

/* THE EVERYDAY STATE, NOT ONLY THE FIRST MINUTE.
 *
 * A sterile profile opens on `setup`, which is correct product behaviour and
 * the wrong thing to measure for everything except the very first launch: the
 * ring has one stop, so a route walk never leaves it and an idle sample
 * describes a screen nobody looks at twice. Seeding the machine record is the
 * same mechanism tools/first-run-contract-qa.mjs uses to reach the configured
 * product, so the two harnesses agree about what "already set up" means. */
function seedMachineRecord(profile, appRoot, tier) {
  const workspace = path.join(profile, 'home', 'ToolsEnabled')
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
  mkdirSync(servicesRoot, { recursive: true })
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
  return servicesRoot
}

/* MANY AGENTS, WHICH IS THE OWNER'S ACTUAL WORST CASE.
 *
 * "Many cloud agents on a very weak pc" is a statement about SCALE, and every
 * other measurement in this file is taken on a copy that declares one seat. The
 * declared organisation is where an agent count comes from on a real install
 * (src/declared-fleet.js turns it into the fleet the computers page draws), and
 * the store reads an overlay at <LOCALAPPDATA>/ToolsEnabled/agent-org.json --
 * so writing that file is how this harness asks the product to be big.
 *
 * The shape is the store's own: exactly one enabled controller (the store
 * asserts it), roles from the declared vocabulary, and a `manages` relationship
 * per agent so the tree has a real hierarchy to lay out rather than a flat row
 * the layout can shortcut. */
/* Leaves get a spread of roles so the tree is not one uniform colour; anything
   that MANAGES gets `manager`, because the engine refuses an organisation where
   a role without authority owns a subtree -- a refusal that reads, from the
   renderer, as an org that does not exist at all. */
const SEED_LEAF_ROLES = ['builder', 'reviewer', 'worker', 'observer']
/* THE PRODUCT'S OWN CEILING, DISCOVERED BY MEASURING RATHER THAN BY READING.
 * capability/src/lib/agent-org.js refuses a declared org of more than 64 agents
 * ("The declared org is bounded to 64 agents."), and the refusal surfaces to the
 * renderer as an org that does not exist at all rather than as a truncated one.
 * So 64 -- one controller and 63 others -- is the largest fleet this surface can
 * ever be asked to draw through the declared path, and a scale curve past it is
 * measuring a refusal, not a product. Named here so a seed above it is reported
 * instead of silently producing an empty window. */
const DECLARED_ORG_AGENT_CEILING = 64
function seedDeclaredFleet(servicesRoot, agentCount) {
  mkdirSync(servicesRoot, { recursive: true })
  const agents = [{
    id: 'controller',
    displayName: 'Controller',
    role: 'controller',
    provider: 'none',
    enabled: true,
    assignedPhase: null,
    phasePriority: [],
  }]
  const relationships = []
  // Who ends up with children under the fan-out below, computed before the
  // roles are assigned so a parent is never given a role that cannot manage.
  const parentIndexes = new Set()
  for (let index = 5; index < agentCount; index += 1) parentIndexes.add(Math.floor(index / 5) - 1)
  for (let index = 0; index < agentCount; index += 1) {
    const id = `seeded-agent-${String(index).padStart(4, '0')}`
    agents.push({
      id,
      displayName: `Seeded agent ${index}`,
      role: parentIndexes.has(index) ? 'manager' : SEED_LEAF_ROLES[index % SEED_LEAF_ROLES.length],
      provider: 'none',
      enabled: true,
      assignedPhase: null,
      phasePriority: [],
    })
    // A shallow tree with real branching: the controller manages the first
    // five, each of those manages the rest in turn.
    const parent = index < 5 ? 'controller' : `seeded-agent-${String(Math.floor(index / 5) - 1).padStart(4, '0')}`
    relationships.push({ from: parent, to: id, type: 'manages' })
  }
  /* The overlay's own envelope: `{ schemaVersion, org }`. Writing the org at the
     top level produces a file the store politely calls "a format this build
     does not understand" and then ignores -- which is how the first version of
     this scenario measured one agent while believing it had four hundred. */
  writeFileSync(
    path.join(servicesRoot, 'agent-org.json'),
    JSON.stringify({ schemaVersion: 1, org: { schemaVersion: 1, revision: 2, agents, relationships } }, null, 2),
  )
}

async function openApp(executable, scratch, label, { seedTier = null, seedAgents = 0 } = {}) {
  const profile = path.join(scratch, `profile-${label}`)
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  const servicesRoot = seedTier ? seedMachineRecord(profile, path.dirname(executable), seedTier) : null
  if (seedAgents > 0) {
    if (!servicesRoot) throw new Error('a declared-fleet performance run requires a payload-resolved machine record')
    seedDeclaredFleet(servicesRoot, seedAgents)
  }

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  /* NOT headless. See the file header: a hidden BrowserWindow has its frame
     loop throttled by Chromium, which would make an idle measurement lie. */
  delete environment.MC_SMOKE_HEADLESS
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })

  const userData = path.join(profile, 'userdata')
  const spawnedAt = Date.now()
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { noise.push(chunk); while (noise.length > 200) noise.shift() })
  }
  child.on('error', (error) => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData)
  const teardown = async () => {
    session.close()
    if (child.pid) {
      try {
        await execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 })
      } catch { /* already gone */ }
    }
    await delay(500)
  }
  try {
    await session.open(OPEN_BUDGET_MS)
  } catch (error) {
    await teardown()
    throw new HarnessError(`${error.message}\n--- app output ---\n${noise.join('').slice(-3000)}`)
  }
  await session.send('Performance.enable')
  return { child, session, spawnedAt, teardown, noise }
}

/* ---------- scenario: cold start ---------- */
async function measureColdStart(executable, scratch, { seedTier = null, tag = 'cold' } = {}) {
  const runs = []
  for (let attempt = 0; attempt < RUNS; attempt += 1) {
    const app = await openApp(executable, scratch, `${tag}-${attempt}`, { seedTier })
    try {
      const settled = await firstViewThenSettle(app.session, 260, 30_000)
      const boot = await evaluate(app.session, BOOT_PROBE)
      const settledAtEpoch = Date.now()
      const paintEpoch = boot.timeOrigin + boot.firstContentfulPaint
      const loadEpoch = boot.timeOrigin + boot.loadEventEnd
      const run = {
        spawnToRendererStartMs: Math.round(boot.timeOrigin - app.spawnedAt),
        spawnToFirstContentfulPaintMs: Math.round(paintEpoch - app.spawnedAt),
        spawnToLoadEventMs: Math.round(loadEpoch - app.spawnedAt),
        spawnToSettledMs: Math.round(settledAtEpoch - app.spawnedAt),
        settled: settled.settled,
        settleWaitMs: Math.round(settled.waitedMs),
        route: boot.route,
        nodes: boot.nodes,
        /* Renderer-relative, so the phases add up against each other rather
           than against our spawn clock. */
        phases: {
          documentAnsweredMs: Math.round(boot.responseEnd),
          domInteractiveMs: Math.round(boot.domInteractive),
          bundleRequestedMs: Math.round(boot.resources.find((entry) => entry.kind === 'script' && entry.bytes > 200_000)?.startMs ?? 0),
          bundleDownloadMs: Math.round(boot.resources.find((entry) => entry.kind === 'script' && entry.bytes > 200_000)?.durationMs ?? 0),
          domContentLoadedMs: Math.round(boot.domContentLoaded),
          loadEventEndMs: Math.round(boot.loadEventEnd),
        },
        blockingHeadScripts: boot.resources
          .filter((entry) => entry.kind === 'script' && entry.bytes <= 200_000)
          .map((entry) => `${entry.name} start=${entry.startMs}ms dl=${entry.durationMs}ms`),
        heaviestResources: boot.resources
          .filter((entry) => entry.bytes > 40_000)
          .sort((left, right) => right.bytes - left.bytes)
          .slice(0, 5),
      }
      runs.push(run)
      note(`run ${attempt + 1}/${RUNS}: spawn->renderer ${run.spawnToRendererStartMs}ms, ` +
        `->FCP ${run.spawnToFirstContentfulPaintMs}ms, ->load ${run.spawnToLoadEventMs}ms, ` +
        `->settled ${run.spawnToSettledMs}ms, route=${run.route || '(none)'}, ${run.nodes} nodes`)
      note(`         renderer phases: document answered ${run.phases.documentAnsweredMs}ms, ` +
        `bundle requested ${run.phases.bundleRequestedMs}ms (download ${run.phases.bundleDownloadMs}ms), ` +
        `DOMContentLoaded ${run.phases.domContentLoadedMs}ms, load ${run.phases.loadEventEndMs}ms` +
        (run.blockingHeadScripts.length ? ` | head scripts: ${run.blockingHeadScripts.join('; ')}` : ''))
    } finally {
      await app.teardown()
    }
  }
  if (!runs.length) throw new HarnessError('no cold-start run completed')
  const median = (key) => {
    const values = runs.map((run) => run[key]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }
  return {
    runs,
    medianSpawnToSettledMs: median('spawnToSettledMs'),
    medianSpawnToFirstContentfulPaintMs: median('spawnToFirstContentfulPaintMs'),
    medianSpawnToRendererStartMs: median('spawnToRendererStartMs'),
    bestSpawnToSettledMs: Math.min(...runs.map((run) => run.spawnToSettledMs)),
    heaviestResources: runs[0].heaviestResources,
  }
}

/* ---------- scenario: route to route ---------- */
async function measureRoutes(executable, scratch) {
  const app = await openApp(executable, scratch, 'routes', { seedTier: SEED_TIER })
  try {
    await firstViewThenSettle(app.session, 260, 30_000)
    const start = await evaluate(app.session, ROUTE_NOW)
    const moves = []
    const seen = new Set()
    let route = start.route
    for (let step = 0; step < 14; step += 1) {
      const before = await counters(app.session)
      const clickedAt = Date.now()
      const clicked = await evaluate(app.session, CLICK_NEXT)
      if (!clicked.clicked) throw new HarnessError(`the ring arrow was not clickable: ${clicked.reason}`)
      const settled = await settle(app.session, 200, 20_000)
      const after = await counters(app.session)
      const now = await evaluate(app.session, ROUTE_NOW)
      const move = {
        from: clicked.from || route,
        to: now.route,
        settleMs: Math.round(Date.now() - clickedAt),
        settled: settled.settled,
        ...countersDelta(before, after),
      }
      move.scriptMs = Math.round(move.scriptMs)
      move.layoutMs = Math.round(move.layoutMs)
      move.styleMs = Math.round(move.styleMs)
      move.taskMs = Math.round(move.taskMs)
      move.heapMb = Math.round(move.heapMb * 10) / 10
      moves.push(move)
      note(`${move.from} -> ${move.to}: ${move.settleMs}ms settle ` +
        `(script ${move.scriptMs}ms, style ${move.styleMs}ms/${move.styleRecalcs}, layout ${move.layoutMs}ms/${move.layouts}, ` +
        `${move.nodes} nodes, ${move.listeners} listeners, heap ${move.heapMb}MB)`)
      route = now.route
      if (seen.has(route)) break
      seen.add(route)
    }
    return { moves, worst: [...moves].sort((left, right) => right.settleMs - left.settleMs)[0] }
  } finally {
    await app.teardown()
  }
}

/* ---------- scenario: idle ---------- */
async function measureIdle(executable, scratch, routes) {
  const results = []
  for (const target of routes) {
    const app = await openApp(executable, scratch, `idle-${target}`, { seedTier: SEED_TIER })
    try {
      await firstViewThenSettle(app.session, 260, 30_000)
      // Walk to the route by clicking, so the state under measurement is the
      // state a person would have reached.
      let route = (await evaluate(app.session, ROUTE_NOW)).route
      for (let step = 0; step < 12 && route !== target; step += 1) {
        await evaluate(app.session, CLICK_NEXT)
        await settle(app.session, 200, 20_000)
        route = (await evaluate(app.session, ROUTE_NOW)).route
      }
      if (route !== target) throw new HarnessError(`could not reach route ${target} by clicking; stopped at ${route}`)

      /* THE PAGE HAS TO SAY IT CAN DRAW, OR THIS SCENARIO HAS NO VERDICT.
       *
       * This file's header has always argued that idle is only meaningful on a
       * genuinely shown window, because Chromium throttles or stops
       * requestAnimationFrame in one that is hidden -- a page burning a frame
       * loop for ever, the exact defect this scenario exists to find, reports a
       * clean 0%. What the header did NOT say is that the harness never checked
       * whether it GOT such a window -- and measured 2026-08-18, it varies from
       * one spawn to the next on the same machine and the same command: in a
       * single run of this scenario the home window reported 'visible' and a
       * later route's window reported 'hidden'. The variable is occlusion, not
       * a flag: sibling copies of this product open at the SAME default bounds
       * and cover each other, and a covered page is a page without frames. So
       * the number this scenario printed was sometimes a product fact and
       * sometimes a machine fact, with nothing on the page to tell them apart.
       *
       * THAT IS ALSO WHAT MADE THE RETENTION GATE LOOK BIMODAL for days: the
       * runs that reported +15,500 nodes per lap were the ones whose window was
       * covered, and the runs that reported a flat page were the ones that were
       * not. Same bytes, different window.
       *
       * ASKING THE PAGE IS THE ONLY HONEST TEST. A window handle can be visible
       * while the page behind it is not being drawn; document.visibilityState is
       * the renderer's own account of whether frames are coming.
       *
       * AND THE COST OF GETTING THIS WRONG JUST WENT UP. The product now
       * suppresses its own motion while it cannot draw (body.frameless, see
       * src/page-frames.js), which is a real fix and makes a hidden window do
       * genuinely LESS work. So an idle number taken on a hidden window would
       * IMPROVE because the measurement got more wrong -- a metric that rewards
       * the measurement being broken is worse than no metric, which is why this
       * refuses instead of reporting. */
      const drawable = await evaluate(app.session, 'document.visibilityState')
      if (drawable !== 'visible') {
        throw new HarnessError(
          `the idle scenario cannot measure this window: the page reports visibilityState="${drawable}", `
          + 'so Chromium is not giving it frames and an idle cost read here would describe the MACHINE, not the product. '
          + 'Close other copies of the app (a sibling at the same default bounds covers this one) and run it again.')
      }

      // Let anything the arrival kicked off finish before the window opens.
      await delay(2_000)

      const cpuBefore = await processTreeCpuSeconds(executable)
      if (!cpuBefore) throw new HarnessError('the OS reported no processes for the staged executable')
      const countersBefore = await counters(app.session)
      const startedAt = Date.now()
      await delay(IDLE_MS)
      const elapsedSeconds = (Date.now() - startedAt) / 1000
      const cpuAfter = await processTreeCpuSeconds(executable)
      if (!cpuAfter) throw new HarnessError('the application vanished during the idle window')
      const countersAfter = await counters(app.session)
      const quiet = await evaluate(app.session, `${SETTLE}(400, 2000)`)

      const delta = countersDelta(countersBefore, countersAfter)
      const record = {
        route: target,
        elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
        processes: cpuAfter.processes,
        cpuSeconds: Math.round((cpuAfter.seconds - cpuBefore.seconds) * 1000) / 1000,
        percentOfOneCore: Math.round(((cpuAfter.seconds - cpuBefore.seconds) / elapsedSeconds) * 100 * 1000) / 1000,
        workingSetMb: Math.round(cpuAfter.workingSetBytes / 1024 / 1024),
        scriptMsPerSecond: Math.round((delta.scriptMs / elapsedSeconds) * 10) / 10,
        layoutMsPerSecond: Math.round((delta.layoutMs / elapsedSeconds) * 10) / 10,
        styleMsPerSecond: Math.round((delta.styleMs / elapsedSeconds) * 10) / 10,
        taskMsPerSecond: Math.round((delta.taskMs / elapsedSeconds) * 10) / 10,
        layoutsPerSecond: Math.round((delta.layouts / elapsedSeconds) * 10) / 10,
        styleRecalcsPerSecond: Math.round((delta.styleRecalcs / elapsedSeconds) * 10) / 10,
        domMutationsWhileIdle: quiet.mutations,
      }
      results.push(record)
      note(`${target}: ${record.percentOfOneCore}% of one core over ${record.elapsedSeconds}s ` +
        `(${record.processes} processes, ${record.workingSetMb}MB working set), ` +
        `renderer script ${record.scriptMsPerSecond}ms/s, layout ${record.layoutMsPerSecond}ms/s ` +
        `(${record.layoutsPerSecond}/s), style ${record.styleMsPerSecond}ms/s (${record.styleRecalcsPerSecond}/s), ` +
        `${record.domMutationsWhileIdle} DOM mutations in a 400ms quiet probe`)
    } finally {
      await app.teardown()
    }
  }
  return { routes: results, worst: [...results].sort((left, right) => right.percentOfOneCore - left.percentOfOneCore)[0] }
}

/* ---------- scenario: the bridge, asked before it can possibly be ready ----------
 *
 * THE ABSENCE CASE THAT THE COLD-START FIX CREATES, TESTED FROM THE GLASS.
 *
 * Making the window open while the capability layer is still booting means the
 * renderer can now ask "where is my bridge?" during a window in which the
 * honest answer is "not yet". The failure mode is this codebase's signature
 * defect: a NOT-STARTED read as an ABSENT, which turns a healthy install into a
 * BRIDGE_UNREACHABLE surface for the first half-second of every launch, and
 * every write action offered in that window into one that refuses.
 *
 * So the question is asked the way the renderer asks it -- window.mcShell
 * .getBridgeEndpoint() -- from the earliest instant the probe can attach, over
 * and over, and the run FAILS if a single answer is a refusal while the layer
 * goes on to come up. There is no "eventually correct" here: a refusal handed
 * out once has already been acted on.
 *
 * It also fails if the endpoint never becomes ok, because a permanently absent
 * bridge is the OTHER way to make every answer non-contradictory. */
async function measureBridgeHonesty(executable, scratch) {
  const app = await openApp(executable, scratch, 'bridge', { seedTier: SEED_TIER })
  try {
    const answers = []
    const deadline = Date.now() + 60_000
    let sawOk = false
    while (Date.now() < deadline) {
      const answer = await evaluate(app.session, `(async () => {
        if (!window.mcShell || typeof window.mcShell.getBridgeEndpoint !== 'function') return { probe: 'no-preload' }
        try { return { probe: 'asked', ...(await window.mcShell.getBridgeEndpoint()) } }
        catch (error) { return { probe: 'threw', reason: String(error && error.message || error) } }
      })()`)
      answers.push({ atMs: Date.now(), ...answer })
      if (answer.probe === 'asked' && answer.ok === true) { sawOk = true; break }
      await delay(60)
    }
    const asked = answers.filter((answer) => answer.probe === 'asked')
    const refusals = asked.filter((answer) => answer.ok !== true)
    const notStarted = refusals.filter((answer) => /has not been started yet/i.test(String(answer.reason || '')))
    note(`asked the bridge endpoint ${asked.length} time(s) from first attach; ` +
      `${refusals.length} refusal(s), ${notStarted.length} of them "not started yet"; ` +
      `became ok: ${sawOk ? 'yes' : 'NO'}`)
    for (const refusal of refusals.slice(0, 3)) note(`   refusal: source=${refusal.source} reason=${refusal.reason}`)
    return {
      asks: asked.length,
      refusals: refusals.length,
      notStartedRefusals: notStarted.length,
      becameOk: sawOk,
      firstAnswer: asked[0] || null,
    }
  } finally {
    await app.teardown()
  }
}

/* ---------- who is asking the browser to measure, and how often ----------
 *
 * Chromium's counters say "52 style recalculations"; they do not say who caused
 * them. Every one of them is provoked by JS reading geometry after writing to
 * the DOM, so counting the READS -- grouped by the call site that made them --
 * turns an unattributable number into a line of code. Installed by the probe on
 * the live page and removed afterwards: it changes nothing about the build under
 * test except that the reads are counted on the way through. */
const INSTALL_REFLOW_COUNTER = `(() => {
  if (window.__reflowCounter) return 'already installed'
  const counts = new Map()
  const record = (kind) => {
    /* The first frame belonging to the APPLICATION, not to this counter. The
       wrapper's own frames have no URL (they were injected by evaluate, so they
       report as <anonymous>), and reporting those names the probe instead of
       the caller -- which is what the first version of this did. */
    const stack = (new Error().stack || '').split('\\n')
      .map(line => line.trim().replace(/^at /, ''))
      .filter(line => line && line.includes('.js:'))
    const site = stack[0] || '(unknown)'
    const key = kind + ' <- ' + site
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const wrap = (owner, name, kind) => {
    const original = owner[name]
    if (typeof original !== 'function') return
    owner[name] = function (...args) { record(kind); return original.apply(this, args) }
  }
  wrap(Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect')
  wrap(Element.prototype, 'getClientRects', 'getClientRects')
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  if (heightDescriptor?.get) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      ...heightDescriptor,
      get() { record('offsetHeight'); return heightDescriptor.get.call(this) },
    })
  }
  const originalComputed = window.getComputedStyle
  window.getComputedStyle = function (...args) { record('getComputedStyle'); return originalComputed.apply(this, args) }
  window.__reflowCounter = {
    reset() { counts.clear() },
    read() { return [...counts.entries()].map(([site, count]) => ({ site, count })).sort((a, b) => b.count - a.count).slice(0, 16) },
  }
  return 'installed'
})()`

/* ---------- naming the function, not just the millisecond ----------
 *
 * A counter that says "207ms of style recalculation" tells you the page is
 * expensive and not which line to change. V8's sampling profiler attributes the
 * time of a forced style/layout flush to the JS frame that provoked it, so a CPU
 * profile taken across the navigation points at the function doing the
 * write-then-read interleave rather than at Chromium's internals. Self time,
 * summed per function, most expensive first. */
async function profileDuring(session, action, { limit = 14 } = {}) {
  await session.send('Profiler.enable')
  await session.send('Profiler.setSamplingInterval', { interval: 200 })
  await session.send('Profiler.start')
  const result = await action()
  const stopped = await session.send('Profiler.stop')
  const profile = stopped.result?.profile
  await session.send('Profiler.disable')
  if (!profile?.nodes?.length) return { result, frames: [], totalMs: 0 }

  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const hits = new Map()
  const samples = profile.samples || []
  const deltas = profile.timeDeltas || []
  for (let index = 0; index < samples.length; index += 1) {
    const node = byId.get(samples[index])
    if (!node) continue
    const microseconds = Math.max(0, deltas[index] ?? 0)
    const frame = node.callFrame || {}
    const where = frame.url ? `${frame.url.split('/').pop()}:${(frame.lineNumber ?? 0) + 1}` : '(native)'
    const key = `${frame.functionName || '(anonymous)'}  ${where}`
    hits.set(key, (hits.get(key) || 0) + microseconds)
  }
  const frames = [...hits.entries()]
    .map(([name, microseconds]) => ({ name, selfMs: Math.round(microseconds / 1000) }))
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, limit)
  const totalMs = Math.round([...hits.values()].reduce((sum, value) => sum + value, 0) / 1000)
  return { result, frames, totalMs }
}

/* ---------- scenario: scale ----------
 *
 * WHERE THE PRODUCT STOPS BEING COMFORTABLE, AND AT WHAT N. Reported as a curve
 * rather than a pass/fail, because the useful answer to "how many agents can
 * this hold" is a number, and a budget can only ever say "not this many". Each
 * N gets its own window from its own profile: an app that has already drawn 20
 * agents has warm code paths a fresh one does not, and measuring 400 after 20
 * in the same window would flatter the 400. */
async function measureScale(executable, scratch, counts, { cpuRate = 1 } = {}) {
  const results = []
  for (const count of counts) {
    if (count + 1 > DECLARED_ORG_AGENT_CEILING) {
      throw new HarnessError(
        `${count} declared agents is past this product's own ceiling of ${DECLARED_ORG_AGENT_CEILING} ` +
        '(capability/src/lib/agent-org.js: "The declared org is bounded to 64 agents."). An org above it is ' +
        'refused outright, so the window draws nothing and any timing taken from it describes a refusal.',
      )
    }
    const app = await openApp(executable, scratch, `scale-${count}`, { seedTier: SEED_TIER, seedAgents: count })
    try {
      await firstViewThenSettle(app.session, 260, 60_000)
      /* A SCALE TEST THAT DID NOT ACTUALLY SCALE IS THE WORST POSSIBLE RESULT.
         The first version of this scenario seeded 400 agents, drew one node at
         every N, and reported a beautifully flat curve -- "no degradation" read
         off a product that had never been given the agents. So the count is
         read back FROM THE RUNNING APP and a mismatch is a NO VERDICT about the
         probe, never a finding about the product. */
      const declared = await evaluate(app.session, `(async () => {
        try {
          const read = await window.mcOrg?.read?.()
          return { ok: read?.ok === true, agents: Array.isArray(read?.org?.agents) ? read.org.agents.length : null, source: read?.source ?? null, reason: read?.reason ?? null }
        } catch (error) { return { ok: false, agents: null, source: null, reason: String(error && error.message || error) } }
      })()`)
      const expected = count + 1 // the controller the store insists on
      if (declared.agents !== expected) {
        throw new HarnessError(
          `seeded ${count} agents but the running app declares ${declared.agents ?? 'nothing'} ` +
          `(source ${declared.source ?? 'none'}${declared.reason ? `, ${declared.reason}` : ''}). ` +
          'Nothing about scale can be said from a copy that never received the fleet.',
        )
      }
      if (cpuRate > 1) await app.session.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
      let route = (await evaluate(app.session, ROUTE_NOW)).route
      if (PROFILE) {
        await evaluate(app.session, INSTALL_REFLOW_COUNTER)
        await evaluate(app.session, `(window.__reflowCounter?.reset(), true)`)
      }
      const before = await counters(app.session)
      const clickedAt = Date.now()
      // The computers page is the next stop after home, so this is one click.
      const profiled = await profileDuring(app.session, async () => {
        await evaluate(app.session, CLICK_NEXT)
        return settle(app.session, 250, 120_000)
      })
      const settled = profiled.result
      const settleMs = Date.now() - clickedAt
      const after = await counters(app.session)
      route = (await evaluate(app.session, ROUTE_NOW)).route
      const delta = countersDelta(before, after)
      const drawn = await evaluate(app.session, `(() => {
        const nodes = document.querySelectorAll('.tree-node, .static-tree-node, [data-node-id]')
        const visible = [...nodes].filter(node => {
          const box = node.getBoundingClientRect()
          return box.width > 0 && box.height > 0
        })
        return { nodeElements: nodes.length, visibleNodeElements: visible.length, totalElements: document.getElementsByTagName('*').length }
      })()`)
      // Does it still respond? A page that renders in 3s and then ignores a
      // click is worse than one that is merely slow, so the interaction is
      // measured separately from the build.
      const interactionAt = Date.now()
      await evaluate(app.session, `(() => { const b = document.getElementById('nav-back'); if (b) b.click(); return true })()`)
      const interactionSettled = await settle(app.session, 200, 60_000)
      const record = {
        declaredAgents: count,
        cpuThrottleRate: cpuRate,
        route,
        buildMs: settleMs,
        buildSettled: settled.settled,
        scriptMs: Math.round(delta.scriptMs),
        styleMs: Math.round(delta.styleMs),
        layoutMs: Math.round(delta.layoutMs),
        layouts: delta.layouts,
        styleRecalcs: delta.styleRecalcs,
        heapMb: Math.round(delta.heapMb * 10) / 10,
        domNodes: delta.nodes,
        listeners: delta.listeners,
        ...drawn,
        backMs: Date.now() - interactionAt,
        backSettled: interactionSettled.settled,
        hottestFrames: profiled.frames,
        profiledMs: profiled.totalMs,
      }
      results.push(record)
      note(`${String(count).padStart(4)} declared agents -> ${record.route}: build ${record.buildMs}ms ` +
        `(script ${record.scriptMs}ms, style ${record.styleMs}ms/${record.styleRecalcs}, layout ${record.layoutMs}ms/${record.layouts}), ` +
        `${record.nodeElements} node elements (${record.visibleNodeElements} visible), ` +
        `${record.totalElements} DOM elements, heap ${record.heapMb}MB, back ${record.backMs}ms`)
      if (PROFILE) {
        for (const frame of record.hottestFrames.filter((entry) => entry.selfMs > 0)) {
          note(`         ${String(frame.selfMs).padStart(5)}ms  ${frame.name}`)
        }
        const reflows = await evaluate(app.session, `(window.__reflowCounter?.read() || [])`)
        record.geometryReads = reflows
        for (const entry of reflows) note(`         ${String(entry.count).padStart(5)}x  ${entry.site}`)
      }
    } finally {
      await app.teardown()
    }
  }
  return { counts: results }
}

/* ---------- scenario: the weak PC ----------
 *
 * THE NAMED WORST CASE, ACTUALLY SIMULATED. Every other number in this file is
 * measured on a fast development machine, which is the one machine the owner's
 * requirement is not about. Chromium can slow its own main thread by an exact
 * factor (Emulation.setCPUThrottlingRate), and that is the honest way to ask
 * what a person on a cheap laptop experiences -- far better than multiplying a
 * fast number by a guess.
 *
 * WHAT IS AND IS NOT SIMULATED. The throttle slows the RENDERER's main thread:
 * script parse, compile and execution, style, layout. It does not slow the
 * disk, the OS, Electron's own start, or the capability layer's boot -- so this
 * is a floor, not a ceiling, and the real weak machine is worse than what this
 * reports. The renderer half is the right half to measure this way because it
 * is the part that is single-threaded and CPU-bound, which is exactly the part
 * a weak machine is worst at.
 *
 * The reload is what makes the bundle's cost visible: it re-runs the entire
 * renderer boot -- 1.3MB of application parsed, compiled and executed -- with
 * the throttle already in force, which an attach-after-launch probe cannot do
 * for the original navigation. */
async function measureWeakPc(executable, scratch, rates) {
  const app = await openApp(executable, scratch, 'weakpc', { seedTier: SEED_TIER })
  try {
    await firstViewThenSettle(app.session, 260, 30_000)
    await app.session.send('Page.enable')
    const results = []
    for (const rate of rates) {
      await app.session.send('Emulation.setCPUThrottlingRate', { rate })
      const reloadedAt = Date.now()
      await app.session.send('Page.reload', { ignoreCache: false })
      const settled = await firstViewThenSettle(app.session, 300, 120_000)
      const wallMs = Date.now() - reloadedAt
      const boot = await evaluate(app.session, BOOT_PROBE)
      /* A FULL LAP, NOT ONE MOVE. "Navigation costs 1.1s on a weak machine" is
         not actionable; "the computers page costs 1.1s and the ledger costs
         200ms" is, because it names the screen to fix. */
      const moves = []
      const seen = new Set()
      for (let step = 0; step < 12; step += 1) {
        const beforeMove = await counters(app.session)
        const at = Date.now()
        const clicked = await evaluate(app.session, CLICK_NEXT)
        const moveSettle = await settle(app.session, 250, 60_000)
        const afterMove = await counters(app.session)
        const now = await evaluate(app.session, ROUTE_NOW)
        const delta = countersDelta(beforeMove, afterMove)
        moves.push({
          from: clicked.from,
          to: now.route,
          settleMs: Date.now() - at,
          settled: moveSettle.settled,
          scriptMs: Math.round(delta.scriptMs),
          styleMs: Math.round(delta.styleMs),
          layoutMs: Math.round(delta.layoutMs),
          layouts: delta.layouts,
          styleRecalcs: delta.styleRecalcs,
        })
        if (seen.has(now.route)) break
        seen.add(now.route)
      }
      const worstMove = [...moves].sort((left, right) => right.settleMs - left.settleMs)[0]
      const move = { scriptMs: worstMove.scriptMs, styleMs: worstMove.styleMs, layoutMs: worstMove.layoutMs }
      const moveMs = worstMove.settleMs
      const moveSettled = { settled: worstMove.settled }
      const record = {
        ringMoves: moves,
        worstMove,
        cpuThrottleRate: rate,
        reloadToSettledMs: wallMs,
        documentAnsweredMs: Math.round(boot.responseEnd),
        domContentLoadedMs: Math.round(boot.domContentLoaded),
        loadEventEndMs: Math.round(boot.loadEventEnd),
        firstContentfulPaintMs: Math.round(boot.firstContentfulPaint),
        bundleExecuteMs: Math.round(boot.domContentLoaded - (boot.resources.find((entry) => entry.kind === 'script' && entry.bytes > 200_000)?.startMs ?? 0)),
        settledAfterLoadMs: Math.round(settled.waitedMs),
        oneRouteMoveMs: moveMs,
        oneRouteMoveSettled: moveSettled.settled,
        oneRouteScriptMs: Math.round(move.scriptMs),
        oneRouteStyleMs: Math.round(move.styleMs),
        oneRouteLayoutMs: Math.round(move.layoutMs),
        route: boot.route,
      }
      results.push(record)
      note(`${rate}x slower CPU: reload -> settled ${record.reloadToSettledMs}ms ` +
        `(document ${record.documentAnsweredMs}ms, bundle parse+execute ${record.bundleExecuteMs}ms, ` +
        `DOMContentLoaded ${record.domContentLoadedMs}ms, load ${record.loadEventEndMs}ms)`)
      for (const item of record.ringMoves) {
        note(`      ${String(item.from).padEnd(10)} -> ${String(item.to).padEnd(10)} ${String(item.settleMs).padStart(5)}ms ` +
          `script ${String(item.scriptMs).padStart(4)}ms  style ${String(item.styleMs).padStart(4)}ms/${item.styleRecalcs}  layout ${String(item.layoutMs).padStart(4)}ms/${item.layouts}`)
      }
      // Back to the top of the ring for the next rate, so each rate measures the
      // same journey rather than wherever the last one left off.
      await app.session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await settle(app.session, 200, 20_000)
    }
    return { rates: results }
  } finally {
    try { await app.session.send('Emulation.setCPUThrottlingRate', { rate: 1 }) } catch { /* the window is going away anyway */ }
    await app.teardown()
  }
}

/* ---------- scenario: memory over a long session ---------- */
async function measureMemory(executable, scratch) {
  const app = await openApp(executable, scratch, 'memory', { seedTier: SEED_TIER })
  try {
    if (CENSUS) {
      await app.session.send('Page.enable', {})
      await app.session.send('Page.addScriptToEvaluateOnNewDocument', { source: RETENTION_PROBE })
      /* The probe is only true of a document it watched from the first line,
         so the page is reloaded once and every lap below is that document. */
      await evaluate(app.session, 'location.reload()')
      await delay(4000)
    }
    await firstViewThenSettle(app.session, 260, 30_000)
    if (OCCLUDED) {
      /* Minimised AFTER the first view settles, so what is being measured is a
         working page that loses its rendering frames -- the state the heap
         snapshots caught -- not a page that booted blind. */
      let state = ''
      let asked = ''
      for (let attempt = 0; attempt < 40 && state !== 'hidden'; attempt += 1) {
        asked = await minimizeAppWindow(app.child)
        if (asked.startsWith('failed')) throw new HarnessError(`--occluded: the window could not be minimised (${asked})`)
        await delay(250)
        state = await evaluate(app.session, 'document.visibilityState')
      }
      if (state !== 'hidden') throw new HarnessError(`--occluded: the page never reported visibilityState=hidden (last minimise pass: ${asked}), so the occluded state cannot be claimed`)
      note(`    the window is occluded (${asked}); the page reports visibilityState=hidden`)
    }
    const laps = []
    for (let lap = 0; lap < LAPS; lap += 1) {
      const seen = new Set()
      let route = (await evaluate(app.session, ROUTE_NOW)).route
      for (let step = 0; step < 14; step += 1) {
        await evaluate(app.session, CLICK_NEXT)
        await settle(app.session, 180, 20_000)
        route = (await evaluate(app.session, ROUTE_NOW)).route
        if (seen.has(route)) break
        seen.add(route)
      }
      // Ask for a collection so what is reported is retained, not merely
      // uncollected. Without this a "leak" is often only a lazy collector --
      // which is exactly why the outcome is now kept rather than discarded.
      const collected = await session_collect(app.session)
      const alive = await foreignInstancesAlive()
      const metrics = await counters(app.session)
      const record = {
        lap: lap + 1,
        stops: seen.size,
        heapMb: Math.round(((metrics.JSHeapUsedSize ?? 0) / 1024 / 1024) * 100) / 100,
        nodes: metrics.Nodes ?? 0,
        listeners: metrics.JSEventListeners ?? 0,
        documents: metrics.Documents ?? 0,
        collected,
        alive,
      }
      laps.push(record)
      if (SNAPSHOT_DIR) {
        const file = path.join(path.resolve(SNAPSHOT_DIR), `memory-lap${record.lap}.heapsnapshot`)
        const bytes = await writeHeapSnapshot(app.session, file)
        note(`    heap snapshot (${Math.round(bytes / 1024 / 1024)}MB) -> ${file}`)
      }
      if (CENSUS) {
        const census = await evaluate(app.session, '(window.__retention ? window.__retention.census() : null)')
        /* WHICH CORONA THIS WINDOW GOT. The ring mounts a WebGL corona when
           WebGL2 is available and a CPU fallback when it is not, and the two
           paths have different teardown. A window that could not obtain a
           context is a different product to measure, so the mode is read
           rather than assumed. */
        const ring = await evaluate(app.session, `(() => {
          const node = document.querySelector('.uring')
          return {
            present: Boolean(node),
            mode: node ? (node.crescentMode || null) : null,
            canvases: document.querySelectorAll('canvas').length,
          }
        })()`)
        note(`    ring: ${JSON.stringify(ring)}`)
        if (!census) note('    the census did not install, so nothing below names a retainer')
        else {
          note(`    ${census.listeners.onDetachedNodes} listener(s) still registered on nodes that left the document; `
            + `${census.detachedNodesHeldByListeners} node(s) in ${census.detachedTrees.length} retained tree(s)`)
          for (const tree of census.detachedTrees.slice(0, 6)) note(`      ${String(tree.nodes).padStart(6)} nodes  <${tree.tag}>  ${tree.what || ''}`)
          for (const site of census.listenerSites.slice(0, 8)) note(`      ${String(site.count).padStart(5)}x  ${site.site}`)
          for (const observer of census.observers.slice(0, 6)) note(`      ${observer.kind} watching ${observer.watching} (${observer.detached} detached)  ${observer.site}`)
          for (const site of (census.liveListenerSites || []).slice(0, 8)) note(`      ${String(site.count).padStart(5)}x  still-attached listener  ${site.site}`)
          note(`      ${census.pendingFrames} animation frame callback(s) queued and not yet run`)
          for (const frame of (census.pendingFrameSites || []).slice(0, 8)) note(`      ${String(frame.count).padStart(5)}x  pending frame  ${frame.site}`)
        }
      }
      note(`lap ${record.lap}: ${record.stops} stops, heap ${record.heapMb}MB, ` +
        `${record.nodes} nodes, ${record.listeners} listeners, collection ${record.collected}, ${record.alive} app process group(s) alive`)
    }
    const first = laps[0]
    const last = laps.at(-1)
    const spans = Math.max(1, laps.length - 1)
    return {
      laps,
      /* Every lap has to have been collected for the growth figures to mean
         'retained'. One that was not makes them mean 'not yet collected',
         which is a different sentence and not a defect. */
      collected: laps.every((entry) => entry.collected === 'collected'),
      collectionOutcomes: [...new Set(laps.map((entry) => entry.collected))],
      heapGrowthPerLapMb: Math.round(((last.heapMb - first.heapMb) / spans) * 100) / 100,
      nodeGrowthPerLap: Math.round((last.nodes - first.nodes) / spans),
      listenerGrowthPerLap: Math.round((last.listeners - first.listeners) / spans),
    }
  } finally {
    await app.teardown()
  }
}

/* Minimise the app's window the way the OS would -- user32's own verb, not a
   CDP emulation, because the state under investigation IS the real occluded
   window. The handle comes from enumerating the process's own top-level
   windows: Get-Process.MainWindowHandle is 0 for a window that was never
   shown, and "never shown" is one of the two ways this product's window ends
   up frameless in the wild (spawned with a hidden STARTUPINFO, or covered by
   another window at the same default bounds -- both measured on this machine,
   2026-08-18). Returns what happened rather than asserting: the caller owns
   the verdict, and it verifies through the page's own visibilityState. */
async function minimizeAppWindow(child) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Occl {
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
  public static int MinimizeAll(uint pid) {
    var asked = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint winPid;
      GetWindowThreadProcessId(h, out winPid);
      if (winPid == pid) {
        var t = new System.Text.StringBuilder(64);
        GetWindowText(h, t, 64);
        if (t.Length > 0) { ShowWindowAsync(h, 6); asked += 1; }
      }
      return true;
    }, IntPtr.Zero);
    return asked;
  }
}
'@
[Console]::Out.Write("asked=" + [Occl]::MinimizeAll(${child.pid}))`
  try {
    const { stdout } = await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 })
    return String(stdout).trim()
  } catch (error) {
    return `failed: ${error?.message || error}`
  }
}

/* A FULL HEAP SNAPSHOT, STREAMED TO DISK AS IT ARRIVES.
 *
 * The chunks are written to a stream rather than joined, because a renderer
 * heap of tens of MB serialises to hundreds of MB of JSON and a single joined
 * string of that size is over V8's own string ceiling -- the instrument would
 * die of the very thing it measures. The protocol delivers every chunk before
 * the takeHeapSnapshot reply, but that ordering is Chromium's habit rather
 * than its contract, so after the reply the writer waits for the chunk stream
 * to go quiet before closing the file.
 *
 * takeHeapSnapshot forces a full collection of its own, on top of the lap's
 * session_collect -- so a detached view present in this file is RETAINED,
 * with its retainer edges recorded, which is the one thing the census cannot
 * see. */
async function writeHeapSnapshot(session, file) {
  mkdirSync(path.dirname(file), { recursive: true })
  const stream = createWriteStream(file)
  let lastChunkAt = Date.now()
  session.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
    lastChunkAt = Date.now()
    stream.write(params.chunk)
  })
  try {
    await session.send('HeapProfiler.enable')
    const reply = await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    if (reply && reply.error) {
      throw new HarnessError(`the renderer refused a heap snapshot: ${reply.error.message || JSON.stringify(reply.error)}`)
    }
    while (Date.now() - lastChunkAt < 600) await delay(150)
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk')
    await new Promise((resolve) => stream.end(resolve))
  }
  return statSync(file).size
}

/* A COLLECTION THAT DID NOT HAPPEN MUST NOT BE REPORTED AS A LEAK.
 *
 * This was `try { await session.send(...) } catch {}` -- and createSession's
 * send() never rejects, it resolves with whatever packet came back, so an
 * error reply was swallowed twice over. That matters more here than anywhere
 * else in the file: every number the memory scenario reports is 'what is still
 * alive AFTER a collection', and with the collection quietly skipped the same
 * healthy build reports ordinary uncollected garbage as a monotonic leak of a
 * whole page per lap. Measured on this tree 2026-08-18: the memory scenario
 * run alone answered -625 nodes/lap and the same scenario run after the others
 * answered +15,531, on the same bytes.
 *
 * So the reply is READ, the outcome travels with the lap, and a lap whose
 * collection did not happen is a NO VERDICT about the probe rather than a
 * finding about the product. */
async function session_collect(session, passes = COLLECT_PASSES) {
  let outcome = `collected x${passes}`
  for (let pass = 0; pass < passes; pass += 1) {
    try {
      const packet = await session.send('HeapProfiler.collectGarbage')
      if (packet && packet.error) outcome = `refused: ${packet.error.message || JSON.stringify(packet.error)}`
    } catch (error) {
      outcome = `threw: ${error?.message || error}`
    }
    await delay(400)
  }
  return outcome
}

/* HOW MANY COPIES OF THIS PRODUCT ARE ALIVE WHILE A NUMBER IS BEING TAKEN.
 *
 * REPORTED, NEVER ASSERTED, and the difference is the whole point. The memory
 * scenario on this tree is BIMODAL on the same bytes: repeated runs answer
 * either ~-400 nodes/lap (the page returns to below where it started) or
 * ~+15,500 nodes/lap, and the census under --census shows the second mode
 * retaining whole detached views -- three entire settings pages at 6,356 nodes
 * each. Which mode a run lands in is NOT yet explained.
 *
 * "Another copy was running" was the first candidate and it is DISPROVED: a run
 * with six app process groups alive throughout its laps answered 2228 / 2118 /
 * 966. It is printed anyway because it is one of the few facts about the
 * machine that can be taken at the moment of measurement, and the next person
 * to look at this needs the conditions each number was taken under -- not a
 * refusal keyed on a correlate that does not hold. */
async function foreignInstancesAlive() {
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Name ToolsEnabled -ErrorAction SilentlyContinue | Measure-Object).Count',
    ], { windowsHide: true, timeout: 20_000 })
    const count = Number(String(stdout).trim())
    return Number.isFinite(count) ? count : 0
  } catch {
    /* A machine this cannot be asked about is measured anyway: refusing on an
       unanswered question would make the probe unusable wherever the question
       cannot be put, which is a worse failure than the one it guards. */
    return 0
  }
}

/* ---------- run ---------- */
async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'toolsenabled-perf-'))
  const record = { measuredAt: new Date().toISOString(), budgets: BUDGETS, scenarios: {} }
  let staged
  const failures = []
  /* The subset of `failures` that counts things rather than timing things, and
     so still means something on a computer that could not be timed. */
  const countedFailures = []
  try {
    /* Refuse empty/unknown enumerations before staging or launching anything:
       otherwise a typo can execute zero assertions and masquerade as green. */
    validateSelection()
    say('== staging the packaged product with the current tree inside it ==')
    staged = await stageApp(scratch)
    record.executable = staged.executable
    say(`   ${staged.executable}`)

    if (SCENARIOS.includes('coldstart')) {
      say('\n== cold start, FIRST RUN (a machine that has never seen this product) ==')
      const firstRun = await measureColdStart(staged.executable, scratch, { tag: 'cold-first' })
      say(`   MEDIAN spawn -> settled: ${firstRun.medianSpawnToSettledMs}ms (best ${firstRun.bestSpawnToSettledMs}ms)`)
      say('\n== cold start, EVERY OTHER DAY (already set up) ==')
      const configured = await measureColdStart(staged.executable, scratch, { seedTier: SEED_TIER, tag: 'cold-set' })
      say(`   MEDIAN spawn -> settled: ${configured.medianSpawnToSettledMs}ms ` +
        `(best ${configured.bestSpawnToSettledMs}ms, budget ${BUDGETS.coldStartMs}ms)`)
      record.scenarios.coldstart = { firstRun, configured }
      for (const [name, measured] of [['first run', firstRun], ['configured', configured]]) {
        if (measured.medianSpawnToSettledMs > BUDGETS.coldStartMs) {
          failures.push(`cold start (${name}) ${measured.medianSpawnToSettledMs}ms exceeds the ${BUDGETS.coldStartMs}ms budget`)
        }
      }
    }

    if (SCENARIOS.includes('bridge')) {
      say('\n== the bridge, asked from the first instant the window exists ==')
      record.scenarios.bridge = await measureBridgeHonesty(staged.executable, scratch)
      const bridge = record.scenarios.bridge
      if (!bridge.becameOk) {
        failures.push('the supervised bridge never reported ok, so nothing can be concluded about what it says while starting')
      }
      if (bridge.notStartedRefusals > 0) {
        failures.push(`the bridge answered "has not been started yet" ${bridge.notStartedRefusals} time(s) to a renderer that asked before it was up -- a NOT-YET handed out as an ABSENT`)
      }
    }

    if (SCENARIOS.includes('routes')) {
      say('\n== route to route, entered by clicking the ring arrow ==')
      record.scenarios.routes = await measureRoutes(staged.executable, scratch)
      const worst = record.scenarios.routes.worst
      say(`   WORST move: ${worst.from} -> ${worst.to} at ${worst.settleMs}ms (budget ${BUDGETS.routeSettleMs}ms)`)
      for (const move of record.scenarios.routes.moves) {
        if (move.settleMs > BUDGETS.routeSettleMs) {
          failures.push(`route ${move.from} -> ${move.to} settles in ${move.settleMs}ms, over the ${BUDGETS.routeSettleMs}ms budget`)
        }
      }
    }

    if (SCENARIOS.includes('idle')) {
      const targets = (argument('--idle-routes', 'home,computers') || '').split(',').filter(Boolean)
      say(`\n== idle: what the product costs doing nothing, ${Math.round(IDLE_MS / 1000)}s per route ==`)
      record.scenarios.idle = await measureIdle(staged.executable, scratch, targets)
      for (const route of record.scenarios.idle.routes) {
        if (route.percentOfOneCore > BUDGETS.idleCpuPercentOfOneCore) {
          failures.push(`idle on ${route.route} costs ${route.percentOfOneCore}% of one core, over the ${BUDGETS.idleCpuPercentOfOneCore}% budget`)
        }
        if (route.scriptMsPerSecond > BUDGETS.idleScriptMsPerSecond) {
          failures.push(`idle on ${route.route} runs ${route.scriptMsPerSecond}ms of script per second, over the ${BUDGETS.idleScriptMsPerSecond}ms/s budget`)
        }
      }
    }

    if (SCENARIOS.includes('scale')) {
      const counts = (argument('--agent-counts', '1,25,100,400') || '').split(',').map(Number).filter((value) => value >= 0)
      const rate = Number(argument('--scale-cpu-rate', 1))
      say(`\n== scale: the fleet surface at ${counts.join(', ')} declared agents${rate > 1 ? ` (CPU ${rate}x slower)` : ''} ==`)
      record.scenarios.scale = await measureScale(staged.executable, scratch, counts, { cpuRate: rate })
      for (const measured of record.scenarios.scale.counts) {
        if (measured.buildMs > BUDGETS.routeSettleMs * Math.max(1, rate)) {
          failures.push(`the fleet surface takes ${measured.buildMs}ms to build at ${measured.declaredAgents} declared agents, over the ${BUDGETS.routeSettleMs * Math.max(1, rate)}ms budget`)
        }
      }
    }

    if (SCENARIOS.includes('weakpc')) {
      const rates = (argument('--cpu-rates', '1,4,6') || '').split(',').map(Number).filter((value) => value >= 1)
      say(`\n== the weak PC: the renderer's main thread slowed ${rates.join('x, ')}x ==`)
      record.scenarios.weakpc = await measureWeakPc(staged.executable, scratch, rates)
      for (const measured of record.scenarios.weakpc.rates) {
        if (measured.oneRouteMoveMs > BUDGETS.routeSettleMs * measured.cpuThrottleRate) {
          failures.push(`at ${measured.cpuThrottleRate}x slower CPU one ring move takes ${measured.oneRouteMoveMs}ms, worse than ${measured.cpuThrottleRate}x the ${BUDGETS.routeSettleMs}ms budget`)
        }
      }
    }

    if (SCENARIOS.includes('memory')) {
      say(`\n== memory: ${LAPS} full laps of the ring ==`)
      record.scenarios.memory = await measureMemory(staged.executable, scratch)
      say(`   heap ${record.scenarios.memory.heapGrowthPerLapMb}MB/lap, ` +
        `${record.scenarios.memory.nodeGrowthPerLap} nodes/lap, ` +
        `${record.scenarios.memory.listenerGrowthPerLap} listeners/lap`)
      /* COUNTS, NOT CLOCKS. Leaked nodes, listeners and heap are the same
         number on a busy computer as on an idle one, so these two survive an
         unsteady machine while every millisecond budget above does not. */
      if (record.scenarios.memory.heapGrowthPerLapMb > BUDGETS.heapGrowthPerLapMb) {
        const line = `the JS heap grows ${record.scenarios.memory.heapGrowthPerLapMb}MB per lap, over the ${BUDGETS.heapGrowthPerLapMb}MB budget`
        failures.push(line); countedFailures.push(line)
      }
      if (record.scenarios.memory.listenerGrowthPerLap > BUDGETS.listenerGrowthPerLap) {
        const line = `${record.scenarios.memory.listenerGrowthPerLap} event listeners are left behind per lap, over the ${BUDGETS.listenerGrowthPerLap} budget`
        failures.push(line)
        countedFailures.push(line)
      }
      if (record.scenarios.memory.nodeGrowthPerLap > BUDGETS.nodeGrowthPerLap) {
        const line = `${record.scenarios.memory.nodeGrowthPerLap} DOM nodes are left behind per lap, over the ${BUDGETS.nodeGrowthPerLap} budget`
        failures.push(line); countedFailures.push(line)
      }
    }

    record.failures = failures
    record.steadiness = steadiness.read()
    if (JSON_OUT) {
      writeFileSync(path.resolve(JSON_OUT), JSON.stringify(record, null, 2))
      say(`\nmeasurement record written to ${path.resolve(JSON_OUT)}`)
    }

    say('\n== verdict ==')
    if (EXPLORE) {
      say('EXPLORE: measured, asserted nothing.')
      process.exitCode = 0
      return
    }
    /* A BUDGET IS A CONSTANT, AND IT CAN ONLY JUDGE A COMPUTER THAT HELD ONE.
       When this machine changed speed while measuring, the millisecond budgets
       above tested the weather; saying FAIL there blames the product for it,
       which is exactly how the account failure spent three days attributed to
       DPAPI. So they are reported as observations and the run declares itself
       unmeasurable. The counted budgets -- leaked nodes, listeners, heap -- are
       unaffected by how busy the machine was, so they still fail on their own. */
    const reading = record.steadiness
    if (reading.steady === false) {
      say(`  ${unmeasurableLine(reading)}`)
      for (const failure of failures) {
        if (!countedFailures.includes(failure)) say(`  ..    over budget, but not measurable here: ${failure}`)
      }
      if (countedFailures.length) {
        for (const failure of countedFailures) say(`  FAIL  ${failure}`)
        process.exitCode = 1
        return
      }
      /* Keep the machine-steadiness waiver, but return the documented
         NO VERDICT status as well as its suite-readable declaration. */
      process.exitCode = 2
      return
    }

    if (failures.length) {
      for (const failure of failures) say(`  FAIL  ${failure}`)
      process.exitCode = 1
      return
    }
    /* One suite-recognised closing convention. packaged-qa-suite.mjs does not
       infer PASS from exit zero, because silence or an unfinished driver must
       not become release evidence. */
    say(`  ALL 1 CHECKS PASSED: every measured budget held. (fixed work stayed within ${reading.ratio}x over ${reading.count} samples)`)
    process.exitCode = 0
  } catch (error) {
    if (error instanceof HarnessError) {
      process.stderr.write(`\nNO VERDICT: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  } finally {
    if (KEEP && !REUSE_STAGE) {
      say(`\nstaged copy kept at ${staged?.app || scratch} (reuse with --stage "${staged?.app || ''}")`)
    } else {
      /* When --stage was given, the staged app lives OUTSIDE scratch and is the
         caller's to keep; scratch holds only this run's profiles and the asar
         staging directory, and removing it must never take the reused copy. */
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* a leftover temp directory is not a finding */ }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`\nNO VERDICT: the harness itself failed: ${error?.stack || error}\n`)
  process.exitCode = 2
})
