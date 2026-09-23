#!/usr/bin/env node

// THE FIRST-RUN CONTRACT, MEASURED ON THE PACKAGED WINDOW FROM A STERILE PROFILE.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. This tree already drives the packaged
// window well -- agent-route-reachability.mjs walks first run to the agent page,
// prefs-origin-proof.mjs proves a setting survives a port change,
// checkout-privacy-packaged-qa.mjs proves the operator's purchase list is gone,
// example-page-write-fence-qa.mjs proves the demonstration page carries no live
// control. Each of those asks ONE question of ONE screen. The defects that got
// through were the ones nobody asked of EVERY screen:
//
//   1. THE RING. Every stop a copy offers must render and must be reachable by
//      the only navigation the app has. The ring is computed at runtime
//      (src/main.js ringOrder() filters RING by stopIsOffered), so which stops
//      exist is a property of the BUILD AND THE PROFILE, not of the source list.
//      Nothing walked it. A stop that renders blank, throws, or is advertised by
//      a chevron that lands somewhere else was invisible.
//   2. OPERATOR-INTERNAL CONTENT ANYWHERE. The checkout leak was found by hand
//      and pinned with a list of the exact strings that leaked. That list cannot
//      see the NEXT leak on a different screen. This asks the question by SHAPE
//      -- internal source paths, internal request ids, the developer's own
//      checkout directory, LAN addresses, the operator addressed in the second
//      person -- at every stop on the ring.
//   3. A CONTROL THAT RENDERS MUST BE WIRED. An entire Settings section rendered,
//      animated on click, and was bound to nothing; the animation is what made it
//      look like it worked. Asserting the element EXISTS is what let that ship.
//      This presses each control and requires OBSERVABLE STATE to move.
//   4. THE RECOMMENDED PATH, JOINED THROUGH THE DOM. Covered elsewhere by value
//      (`click assisted`), which cannot notice the label moving. This resolves
//      which answer is marked Recommended FROM THE GLASS and requires the
//      preselected answer to be that one -- the actual defect-9 regression.
//   5. THE CLICK BUDGET IS ASSERTED, NOT NOTED. "Eight clicks" was being printed
//      as a note by a harness that would have printed eighty just as calmly.
//
// WHAT IT DELIBERATELY DOES NOT COVER, because a sibling owns it and duplicating
// a check is how two lanes come to disagree about one fact:
//   settings surviving a relaunch on a different port, and the unreadable-record
//   case ..................... tools/prefs-origin-proof.mjs
//   the demonstration page's write fence ... tools/example-page-write-fence-qa.mjs
//   the purchase-list bytes and the checkout route .. tools/checkout-privacy-*.mjs
//   steering a running session ....... tools/recommended-path-packaged-qa.mjs
//
// NAVIGATION IS BY CLICKING, AND THE RULE IS ENFORCED AGAINST THIS FILE'S OWN
// SOURCE. auditSelf() below fails the run if a reachability claim is reached by
// assigning location.hash, the way a sibling harness once passed on a build where
// nothing routed to the page it "reached". The one deep link permitted is tagged
// and belongs to a check whose name says it is a state check.
//
// READ THE EXIT CODE. THREE VALUES, ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED -- a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured. A
//      statement about the probe or the machine, NEVER about the product.
// Never read it through a pipe: `node x.mjs | tail` reports TAIL's status.
//
// RUN IT:
//   node tools/first-run-contract-qa.mjs
//   node tools/first-run-contract-qa.mjs --scenario ring
//   node tools/first-run-contract-qa.mjs --explore     (measure, assert nothing)
//   --release <dir>   which packaged build to stage   (default release/win-unpacked)
//   --keep            keep the scratch copy
//   --click-budget <n>  the asserted ceiling for first run -> a running agent

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { machineRecordProductDirectory, userDataFor } from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const EXPLORE = process.argv.includes('--explore')
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
const ATTEMPTS = Number(argument('--attempts', 3))
/* THE CEILING IS A PRODUCT DECISION, SO IT IS NAMED HERE AND ASSERTED, NOT
   PRINTED. The measured path when this was written is 8 (7 to the agent surface,
   1 for Start). The budget is deliberately a little looser than the measurement:
   a ceiling equal to the current number turns any deliberate extra step into a
   red check, which trains people to raise the number rather than to think. A
   ceiling twice the measurement would not notice a route doubling in length. */
const CLICK_BUDGET = Number(argument('--click-budget', 12))
const SCENARIOS = argument('--scenario')
  ? [argument('--scenario')]
  : ['ring', 'privacy', 'wiring', 'recommended']

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ---------- the instrument audits itself ---------- */
const DEEP_LINK_MARKER = 'DEEP-LINK-STATE-CHECK'
export function offendingHashAssignments(source) {
  return source
    .split('\n')
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(=(?!=)|\+=)/.test(line))
    .filter(({ line }) => !line.includes(DEEP_LINK_MARKER))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
}

/* ---------- A FAILURE OF THE PROBE IS NOT A FINDING ABOUT THE PRODUCT ---------- */
class HarnessError extends Error {}

/* ---------- stage a real packaged copy ----------
 * Borrows the built binary and swaps in the CURRENT dist/ and shell/, so this
 * measures the working tree inside a real packaged artifact rather than whenever
 * release/ was last built. Writes nothing under release/. This is the answer to
 * "testing the tree, not the artifact": the tree under test, in the artifact. */
async function stage(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.resolve(argument('--dist', path.join(REPO_ROOT, 'dist'))) })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')

  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new HarnessError(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
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
  return appExecutable(app)
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  if (executables.length === 0) throw new HarnessError(`no .exe in the staged app at ${appRoot}`)
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new HarnessError(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

const ACTIVE_PORT_FILE = 'DevToolsActivePort'

async function publishedDebuggerPort(userDataDir, child, budgetMs) {
  const file = path.join(userDataDir, ACTIVE_PORT_FILE)
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (child.exitCode !== null) {
      throw new HarnessError(`the app exited with code ${child.exitCode} before it published a debugger port; a startup failure, not a slow paint`)
    }
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* not written yet */ }
    await delay(200)
  }
  throw new HarnessError(`the app never wrote ${ACTIVE_PORT_FILE} within ${Math.round(budgetMs / 1000)}s, so its debugger never started`)
}

function createSession(child, userDataDir, say) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  const events = []
  return {
    events,
    async open(budgetMs) {
      const started = Date.now()
      const port = await publishedDebuggerPort(userDataDir, child, budgetMs)
      say(`debugger published on 127.0.0.1:${port} after ${Date.now() - started}ms`)
      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered; a startup failure, not a slow paint`)
        }
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
              if (packet.id === undefined) { events.push(packet); return }
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            say(`attached to the window after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length
            ? `the endpoint answered with ${targets.length} target(s), none a debuggable page: ${targets.map(e => `${e.type}:${e.title || e.url || '?'}`).join(', ')}`
            : 'the endpoint answered with an EMPTY target list -- the process is up but no window opened; look for a modal error or a main-process throw below'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s and the app is still running -- ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* ---------- what is on the glass, and whether it has stopped moving ----------
 * STABILISATION 1 OF 3, and the reason it exists. Three "failures" in this
 * project were the harness rather than the product, and the first was a first-run
 * click that landed while the screen was still building: the control was in the
 * DOM, the click was dispatched, and the view replaced itself a frame later so
 * nothing downstream of the click ever happened. A fixed sleep is the usual
 * patch and it is the wrong one -- too short under load and it flakes, long
 * enough to be safe and the suite takes an hour.
 *
 * So quiescence is MEASURED. A MutationObserver counts DOM mutations; the page
 * is settled when a window passes with none, with the view-morph animation
 * (VIEW_MORPH_MS in src/main.js) as the floor. This returns how long it waited so
 * a route that never settles is reported as such rather than silently sampled
 * mid-build. */
const SETTLE = `((quietMs, budgetMs) => new Promise(resolve => {
  const started = Date.now()
  let mutations = 0
  let lastMutation = Date.now()
  const observer = new MutationObserver(records => { mutations += records.length; lastMutation = Date.now() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  const tick = () => {
    const quietFor = Date.now() - lastMutation
    if (quietFor >= quietMs) {
      observer.disconnect()
      resolve({ settled: true, waitedMs: Date.now() - started, mutations })
      return
    }
    if (Date.now() - started >= budgetMs) {
      observer.disconnect()
      resolve({ settled: false, waitedMs: Date.now() - started, mutations })
      return
    }
    setTimeout(tick, 50)
  }
  setTimeout(tick, 50)
}))`

/* The route's own account of itself. `visible` is measured -- text in the DOM is
   not text on the screen. */
const ROUTE_PROBE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const stage = document.getElementById('stage')
  const view = stage ? stage.querySelector(':scope > *') : null
  const next = document.getElementById('nav-next')
  const back = document.getElementById('nav-back')
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    title: document.title,
    viewPresent: Boolean(view),
    viewVisible: shown(view),
    viewClass: view ? view.className : '',
    /* innerText, not textContent: what a person can read, with hidden subtrees
       already excluded by the layout engine rather than by a guess of ours. */
    text: norm(document.body.innerText).slice(0, 20000),
    textLength: norm(document.body.innerText).length,
    nextDest: next ? next.dataset.dest || '' : '',
    backDest: back ? back.dataset.dest || '' : '',
    nextName: next ? next.getAttribute('aria-label') || '' : '',
  }
})()`

async function openApp(executable, scratch, label, { seedTier = null } = {}) {
  const profile = path.join(scratch, `profile-${label}`)
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  if (seedTier) seedMachineRecord(profile, path.join(scratch, 'app'), seedTier)

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })

  const userData = userDataFor(profile)
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    /* windowsHide kills the console flash only; the BrowserWindow is hidden by
       MC_SMOKE_HEADLESS=1 in the inherited environment (shell/window-options.cjs). */
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { noise.push(chunk); while (noise.length > 400) noise.shift() })
  }
  child.on('error', error => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData, message => console.log(`  ..    ${message}`))
  const teardown = async () => {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    if (child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* nothing left */ }
    }
    await delay(400)
  }

  try {
    await session.open(OPEN_BUDGET_MS)
  } catch (error) {
    if (error instanceof HarnessError) {
      const said = noise.join('').trim()
      error.message += said
        ? `\n  the app said:\n${said.split('\n').map(line => `    | ${line}`).join('\n')}`
        : '\n  the app said nothing on stdout or stderr'
    }
    await teardown()
    throw error
  }

  await session.send('Runtime.enable')
  /* A ROUTE THAT THROWS OFTEN STILL "RENDERS" -- an empty wrapper, no error on
     screen, nothing a DOM assertion can see. The page's own exceptions are the
     only witness, so they are collected and attributed to whichever route was on
     screen when they arrived. */
  const thrown = []
  session.events.push = function (packet) {
    if (packet?.method === 'Runtime.exceptionThrown') {
      const detail = packet.params?.exceptionDetails
      thrown.push({
        at: Date.now(),
        text: detail?.exception?.description || detail?.text || 'unknown exception',
      })
    }
    return Array.prototype.push.call(this, packet)
  }

  const evaluate = async expression => {
    const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (packet.result?.exceptionDetails) {
      throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
    }
    return packet.result?.result?.value
  }
  const until = async (label, expression, attempts = 60) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true
      await delay(250)
    }
    return false
  }
  /* Quiescence, with the view-morph animation as the floor. */
  const settle = async (quietMs = 450, budgetMs = 12000) =>
    evaluate(`${SETTLE}(${quietMs}, ${budgetMs})`)

  let clicks = 0
  /* CLICK BY SELECTOR, AND REFUSE TO CLICK WHAT A PERSON COULD NOT.
     STABILISATION 2 OF 3: the page is settled BEFORE the element is resolved,
     and the element is resolved and clicked in ONE evaluation, so nothing can
     replace it between the look and the press. The old shape -- read a handle,
     await, then click it -- is the race that produced a "failure" nobody could
     reproduce. */
  const clickVisible = async (selector, { settleFirst = true } = {}) => {
    if (settleFirst) await settle()
    const outcome = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return 'absent'
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      if (!(box.width > 0 && box.height > 0)) return 'zero-size'
      if (style.visibility === 'hidden' || style.display === 'none') return 'hidden'
      if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return 'disabled'
      node.click()
      return 'clicked'
    })()`)
    if (outcome === 'clicked') clicks += 1
    return outcome
  }
  const clickLastVisible = async selector => {
    await settle()
    const outcome = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0
          && style.visibility !== 'hidden' && style.display !== 'none'
          && node.disabled !== true && node.getAttribute('aria-disabled') !== 'true'
      })
      if (!nodes.length) return 'absent'
      nodes[nodes.length - 1].click()
      return 'clicked'
    })()`)
    if (outcome === 'clicked') clicks += 1
    return outcome
  }

  await until('the application origin',
    `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
  await settle()

  return {
    evaluate, until, settle, clickVisible, clickLastVisible, teardown,
    profile, thrown, clicked: () => clicks, resetClicks: () => { clicks = 0 },
  }
}

/* Written with the ENGINE'S OWN writer, so a record this harness creates is one
   the product would accept. Seeding also answers the permission question, which
   otherwise holds every route at #/setup. */
function seedMachineRecord(profile, appRoot, tier) {
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(REPO_ROOT, 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
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

/* ================= OPERATOR-INTERNAL CONTENT, BY SHAPE =================
 * The checkout leak was pinned with the exact strings that leaked, which is the
 * right way to stop THAT leak coming back and no way at all to catch the next
 * one. These are the SHAPES of the thing, so a screen that starts rendering a
 * different internal path fails without anyone having to have seen it first.
 *
 * EACH PATTERN IS NARROWED TO AVOID THE ONE FALSE POSITIVE THAT WOULD MATTER.
 * The product legitimately shows the PERSON'S OWN workspace folder, which is an
 * absolute path under C:\Users\. A naive /C:\\Users\\/ would fire on the setup
 * folder question and on Settings, and a suite that cries wolf on a correct
 * screen gets switched off. So the developer's checkout is matched by NAME
 * instead: those directory names can only come from a machine that built this. */
const INTERNAL_PATTERNS = Object.freeze([
  {
    name: 'an internal source or config path',
    // src/lib/providers/pay.js, config/toolsenabled.policy.json, tools/x.mjs
    pattern: /\b(?:src|tools|config|shell|capability|scripts)\/[A-Za-z0-9._/-]+\.(?:js|mjs|cjs|json|ts)\b/,
  },
  {
    name: 'an internal request id',
    // R1203, R171 -- the operator's own numbering, meaningless and revealing
    pattern: /\bR\d{3,4}\b/,
  },
  {
    name: "the developer's own checkout directory",
    pattern: /\b(?:wt-capability|toolsenabled-current|ToolsEnabled[\\/]+\.git)\b/,
  },
  {
    name: 'a private LAN address',
    pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    name: 'the operator addressed in the second person',
    pattern: /\b(?:WHY YOU WANTED IT|You asked (?:the price|for|me) |you personally asked)\b/i,
  },
  {
    /* Authoring leaks, not integration names. The first version of this
       pattern matched /claude|codex/ and fired on "Codex is installed but nobody
       is signed in" and "CODEX SESSIONS" -- the product's own supported agent
       engines, named on screen because a customer uses them (capability/
       package.json ships codex-adapter and claude-adapter). That is a FALSE
       FINDING of exactly the kind that gets a suite switched off, and it was
       caught by running this against the real window rather than reasoning about
       it. What must never reach a customer surface is how this software was
       BUILT and COORDINATED, which is a different vocabulary entirely. */
    name: 'an authoring or internal-coordination leak',
    pattern: /(?:Generated with \[?Claude Code|Co-Authored-By:|\bsubagent\b|\blane prompt\b|\bagent-coord\b|\bSTANDING-ORDERS\b|\bBUILD-QUEUE\b)/i,
  },
])

/* Owner-identifying names are checked separately: tools/check-no-owner-data.mjs
   owns the canonical list for the ARTIFACT, and this asks the same question of the GLASS.
   Read from that tool rather than spelled again, so the two cannot drift. */
export function ownerNameNeedles(readSource = readFileSync) {
  try {
    const source = readSource(path.join(REPO_ROOT, 'tools', 'check-no-owner-data.mjs'), 'utf8')
    const found = [...source.matchAll(/['"]([A-Z][a-z]+(?:ard|ckard))['"]/g)].map(m => m[1])
    return [...new Set(found)]
  } catch (error) {
    /* ENOENT is the one answer this lookup can translate to "absent". Resource
       pressure and unreadable-media errors mean the machine did not answer the
       question; turning those into [] makes the privacy check claim the needle
       list is absent. Throwing a HarnessError sends the run to its NO VERDICT
       path (exit 2), and this function deliberately keeps no cached result. */
    if (error?.code === 'ENOENT') return []
    const unavailable = new HarnessError(
      'OWNER_NAME_NEEDLES_UNREADABLE: could not read tools/check-no-owner-data.mjs; this is NOT claiming the owner-name needles are absent')
    unavailable.code = 'OWNER_NAME_NEEDLES_UNREADABLE'
    unavailable.cause = error
    throw unavailable
  }
}

function scanForInternals(text, ownerNeedles) {
  const hits = []
  for (const { name, pattern } of INTERNAL_PATTERNS) {
    const match = text.match(pattern)
    if (match) hits.push({ name, sample: match[0].slice(0, 80) })
  }
  for (const needle of ownerNeedles) {
    if (text.includes(needle)) hits.push({ name: "the owner's personal name", sample: needle })
  }
  return hits
}

/* ================= SCENARIO 1: THE RING ================= */
async function driveRing(executable, scratch, attempt) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  const app = await openApp(executable, scratch, `ring-${attempt}`, { seedTier: 'standard' })
  const { evaluate, settle, clickVisible, thrown } = app
  try {
    const start = await evaluate(ROUTE_PROBE)
    check('the app opens past the permission question when one is recorded',
      start.route !== 'setup', `route=${start.route || '(none)'}`)
    if (start.route === 'setup') return checks

    /* WALK THE RING THE COPY ACTUALLY HAS. Not the RING literal in src/main.js
       -- that is filtered by stopIsOffered at runtime, so the source list is a
       superset and asserting against it would demand stops this build hides.
       Clicking until the route repeats discovers the real one. */
    const visited = []
    const seen = new Set()
    let guard = 0
    let current = start
    const MAX_STOPS = 24
    while (guard < MAX_STOPS) {
      guard += 1
      visited.push({
        route: current.route,
        textLength: current.textLength,
        viewVisible: current.viewVisible,
        title: current.title,
        nextDest: current.nextDest,
        text: current.text,
      })
      if (seen.has(current.route)) break
      seen.add(current.route)

      const advertised = current.nextDest
      const pressed = await clickVisible('#nav-next')
      if (pressed !== 'clicked') {
        check(`the forward chevron can be pressed on "${current.route}"`, false, pressed)
        break
      }
      await settle()
      const landed = await evaluate(ROUTE_PROBE)
      /* THE CHEVRON'S PROMISE IS PART OF THE CONTRACT. src/main.js writes the
         caption and the accessible name from ringOrder(), and warns in a comment
         that a caption disagreeing with the destination is how a hidden surface
         comes back through the only navigation the app has. Nothing tested it. */
      check(`the forward chevron on "${current.route}" lands where it says ("${advertised}")`,
        advertised === '' || landed.route === advertised || (advertised === 'home' && landed.route === 'home'),
        `advertised="${advertised}" landed="${landed.route}"`)
      current = landed
    }

    const ring = visited.map(stop => stop.route)
    note(`the ring this copy offers: ${ring.join(' -> ')}`)

    /* IT MUST BE A RING. The arrows are the only navigation; if walking forward
       never returns you to where you began, some stop is a one-way door. */
    check('the ring closes -- walking forward returns to the starting stop',
      guard < MAX_STOPS && ring[ring.length - 1] === ring[0],
      `${ring.length - 1} stop(s), ended on "${ring[ring.length - 1]}", started on "${ring[0]}"`)

    /* EVERY STOP RENDERS. A stop that draws an empty wrapper is reachable and
       useless, and "reachable" was the only thing anyone was measuring. */
    for (const stop of visited.slice(0, -1)) {
      check(`the "${stop.route}" stop renders a visible view`,
        stop.viewVisible, `view visible=${stop.viewVisible}`)
      /* A THRESHOLD, NOT A NON-EMPTY TEST. The chrome alone (two chevrons, a
         title) puts a few dozen characters on the page, so `length > 0` passes
         on a completely blank view. 200 is comfortably above the chrome and
         comfortably below the smallest real screen measured here. */
      check(`the "${stop.route}" stop has readable content on it`,
        stop.textLength > 200, `${stop.textLength} characters of visible text`)
    }

    /* NO STOP THE COPY DOES NOT OFFER MAY BE REACHED BY WALKING. The checkout
       leak was reachable in exactly this way -- one press of the back chevron
       from home -- so the ring walk is where that class of defect shows up. */
    check('walking the ring never lands on the operator checkout surface',
      !ring.includes('checkout'), `ring=${ring.join(',')}`)

    /* THE RING IS SYMMETRIC. Forward then back must return you to where you
       were; an asymmetric ring strands people on stops they cannot leave the
       way they came. */
    const before = await evaluate(ROUTE_PROBE)
    await clickVisible('#nav-next')
    await settle()
    await clickVisible('#nav-back')
    await settle()
    const after = await evaluate(ROUTE_PROBE)
    check('forward then back returns to the same stop',
      after.route === before.route, `${before.route} -> forward -> back -> ${after.route}`)

    check('no route threw while it was on screen',
      thrown.length === 0,
      thrown.length ? thrown.map(entry => entry.text.split('\n')[0]).join(' | ').slice(0, 300) : 'no exceptions')

    return checks
  } finally {
    await app.teardown()
  }
}

/* ================= SCENARIO 2: OPERATOR-INTERNAL CONTENT ON EVERY STOP ======== */
async function drivePrivacy(executable, scratch, attempt) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  const ownerNeedles = ownerNameNeedles()
  note(`owner-name needles taken from tools/check-no-owner-data.mjs: ${ownerNeedles.length ? ownerNeedles.map(n => `${n[0]}***`).join(', ') : '(none found -- that tool may have moved)'}`)
  /* A SCANNER WITH NOTHING TO SCAN FOR IS A GREEN LIGHT WIRED TO NOTHING. If the
     needle list came back empty the guard cannot fail for its main reason, so
     say so as a failed check rather than passing quietly. */
  check('the owner-name needle list was actually found',
    ownerNeedles.length > 0, `${ownerNeedles.length} needle(s)`)

  const app = await openApp(executable, scratch, `privacy-${attempt}`, { seedTier: 'standard' })
  const { evaluate, settle, clickVisible } = app
  try {
    const seen = new Set()
    let current = await evaluate(ROUTE_PROBE)
    let guard = 0
    while (guard < 24 && !seen.has(current.route)) {
      guard += 1
      seen.add(current.route)
      const hits = scanForInternals(current.text, ownerNeedles)
      check(`the "${current.route}" stop shows no operator-internal content`,
        hits.length === 0,
        hits.length ? hits.map(hit => `${hit.name}: ${JSON.stringify(hit.sample)}`).join('; ') : 'clean')
      const pressed = await clickVisible('#nav-next')
      if (pressed !== 'clicked') break
      await settle()
      current = await evaluate(ROUTE_PROBE)
    }
    note(`scanned ${seen.size} stop(s): ${[...seen].join(', ')}`)

    /* THE SCANNER MUST BE ABLE TO SEE. A privacy scan that would pass on a page
       carrying the leak is worse than none, and the only way to know is to show
       it one. This injects a known-bad string into the live DOM, requires the
       scanner to catch it, and removes it -- so the instrument proves itself on
       every run instead of being trusted. */
    await evaluate(`(() => {
      const probe = document.createElement('div')
      probe.id = 'first-run-contract-selftest'
      probe.textContent = 'internal marker src/lib/providers/pay.js and request R1203'
      document.body.appendChild(probe)
      return true
    })()`)
    await settle(200, 3000)
    const withProbe = await evaluate(ROUTE_PROBE)
    const caught = scanForInternals(withProbe.text, ownerNeedles)
    check('SELF-TEST: the scanner catches a planted internal marker',
      caught.length >= 2,
      caught.length ? caught.map(hit => hit.name).join('; ') : 'THE SCANNER SAW NOTHING -- every green above is meaningless')
    await evaluate(`(() => { document.getElementById('first-run-contract-selftest')?.remove(); return true })()`)

    return checks
  } finally {
    await app.teardown()
  }
}

/* ================= SCENARIO 3: A CONTROL THAT RENDERS MUST BE WIRED ==========
 * THE DEFECT THIS IS FOR. An entire Settings section rendered, animated on
 * click, and was bound to nothing. The animation is what made it look like it
 * worked, and every test anyone had asserted the element EXISTED.
 *
 * So the question asked here is not "is the control there" but "does pressing it
 * MOVE anything". Observable state is read before and after each press: the
 * control's own aria-pressed, and the durable settings the renderer keeps. A
 * control that changes neither is dead, whatever it does on screen. */
/* TWO CONTROL FAMILIES, BECAUSE THE PRODUCT HAS TWO. The drawer (index.html)
   carries appearance controls keyed by `data-theme` / `data-text`; the full
   settings page (src/views/settings.js, route #/settings) groups options under
   `data-setting-id` with `data-setting-value`. A probe that knew only one family
   reported "0 controls" and passed, which is the dead-guard shape this scenario
   exists to refuse -- so both are enumerated and the count is asserted. */
const SETTINGS_PROBE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const out = []
  for (const group of document.querySelectorAll('[data-setting-id]')) {
    if (!shown(group)) continue
    const options = [...group.querySelectorAll('[data-setting-value]')].filter(shown).map(option => ({
      value: option.dataset.settingValue || '',
      pressed: option.getAttribute('aria-pressed') === 'true',
      selector: '[data-setting-id="' + (group.dataset.settingId || '') + '"] [data-setting-value="' + (option.dataset.settingValue || '') + '"]',
    }))
    if (options.length > 1) out.push({ id: group.dataset.settingId || '', family: 'settings-page', options })
  }
  for (const family of ['theme', 'text']) {
    const options = [...document.querySelectorAll('[data-' + family + ']')].filter(shown).map(option => ({
      value: option.getAttribute('data-' + family) || '',
      pressed: option.getAttribute('aria-pressed') === 'true' || option.classList.contains('on'),
      selector: '[data-' + family + '="' + (option.getAttribute('data-' + family) || '') + '"]',
    }))
    if (options.length > 1) out.push({ id: 'drawer-' + family, family: 'drawer', options })
  }
  return out
})()`

/* Everything the renderer persists, as one comparable string. The wiring test
   does not care WHICH key moved, only that pressing a control moved something a
   relaunch would read back. */
const STORAGE_FINGERPRINT = `(() => {
  try {
    const out = {}
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      out[key] = localStorage.getItem(key)
    }
    return JSON.stringify(out)
  } catch (error) { return 'unreadable:' + error.message }
})()`

export async function availabilityReasons(importModule = specifier => import(specifier)) {
  try {
    const availabilityCopy = await importModule(new URL('../src/agent-availability-copy.js', import.meta.url))
    return {
      reasons: Object.values(availabilityCopy.UNAVAILABLE_TEXT || {})
        .filter(value => typeof value === 'string' && value.length > 0),
      copyLoadError: '',
    }
  } catch (error) {
    /* A missing copy module is a definite, failed product check. Every other
       loader failure is inability to measure, not evidence that the table is
       absent. Do not retain either outcome here: a retry must call the loader. */
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return { reasons: [], copyLoadError: error?.message || String(error) }
    }
    const unavailable = new HarnessError(
      'AVAILABILITY_COPY_UNREADABLE: could not load src/agent-availability-copy.js; this is NOT claiming the availability copy table is absent')
    unavailable.code = 'AVAILABILITY_COPY_UNREADABLE'
    unavailable.cause = error
    throw unavailable
  }
}

async function driveWiring(executable, scratch, attempt) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  const app = await openApp(executable, scratch, `wiring-${attempt}`, { seedTier: 'standard' })
  const { evaluate, until, settle, clickVisible } = app
  try {
    /* Reached by pressing the settings control, not by a deep link: if the
       drawer cannot be opened by clicking, that is itself the finding. */
    const opened = await clickVisible('#open-settings')
    check('the settings drawer opens by pressing its control', opened === 'clicked', `#open-settings: ${opened}`)
    if (opened !== 'clicked') return checks
    await settle()

    /* THE FULL SETTINGS PAGE IS NOT ON THE RING. #/settings is reachable only by
       opening the drawer and pressing "all settings" -- exactly the shape of the
       agent-page defect, where a real surface existed and no navigation led to
       it. The ring walk cannot see this route, so it is asserted here. */
    const toAll = await clickVisible('.drawer-all')
    check('the full settings page is reachable by clicking "all settings"',
      toAll === 'clicked', `.drawer-all: ${toAll}`)
    if (toAll === 'clicked') {
      const arrived = await until('the settings page', `document.body.dataset.route === 'settings'`)
      check('and pressing it lands on the settings page', arrived,
        `route=${await evaluate(`document.body.dataset.route || ''`)}`)
      await settle(700, 15000)
    }

    /* EVERY CATEGORY IS ITS OWN PAGE, so the probe walks them. It used to open
       the collapsed groups on one long page and read every control at once;
       reading only the page the address happens to land on would leave eleven
       unprobed, and the first version of this probe already proved what a sweep
       that finds nothing reports. The rail's groups ship collapsed, so they are
       opened first -- the same gesture, moved to where the groups now are. */
    const settingsCategories = await evaluate(`(() => {
      for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
      return [...document.querySelectorAll('.settings-rail button[data-category]')].map(node => node.dataset.category)
    })()`)
    const openCategory = async (category) => {
      /* The rail folds back to "what this person filed, plus the group the page
         is in" on every navigation, so the group holding the wanted category is
         opened again before the button is looked for. */
      await evaluate(`(() => {
        for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
        return true
      })()`)
      const selector = `.settings-rail button[data-category=${JSON.stringify(category)}]`
      const pressed = await clickVisible(selector)
      await settle(400, 6000)
      return pressed
    }
    const controls = []
    for (const category of settingsCategories || []) {
      if (await openCategory(category) !== 'clicked') { note(`${category}: the rail would not open it`); continue }
      for (const control of await evaluate(SETTINGS_PROBE)) controls.push({ ...control, category })
    }
    note(`${controls.length} visible multi-option control(s): ${controls.map(c => `${c.id}[${c.options.length}]`).join(', ') || 'none'}`)
    /* A WIRING TEST WITH NOTHING TO PRESS IS A GREEN LIGHT WIRED TO NOTHING.
       The first version of this probe knew only one of the product's two control
       families, found zero, and passed. */
    check('the settings surfaces offer controls to press', controls.length > 0, `${controls.length} found`)

    const dead = []
    let exercised = 0
    for (const control of controls) {
      /* Press an option that is NOT already selected -- pressing the active one
         is allowed to be a no-op and would report every control as dead. */
      const target = control.options.find(option => !option.pressed)
      if (!target) { note(`${control.id}: every option already active, nothing to press`); continue }
      /* Back to the page this control lives on: the sweep above left the last
         category open, and a control on any other one is not in the document. */
      if (control.category && await openCategory(control.category) !== 'clicked') {
        note(`${control.id}: could not reopen ${control.category}`)
        continue
      }
      const before = await evaluate(STORAGE_FINGERPRINT)
      const pressed = await clickVisible(target.selector)
      if (pressed !== 'clicked') { note(`${control.id}: could not press ${target.value} (${pressed})`); continue }
      await settle()
      const after = await evaluate(STORAGE_FINGERPRINT)
      const nowPressed = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(target.selector)})
        if (!node) return null
        return node.getAttribute('aria-pressed') === 'true' || node.classList.contains('on')
      })()`)
      exercised += 1
      /* EITHER witness is enough for "wired": the control adopted the press, or
         durable state moved. Requiring both would fail controls that legitimately
         act without persisting; requiring neither is the defect. */
      const wired = nowPressed === true || before !== after
      if (!wired) dead.push(`${control.id}=${target.value}`)
      check(`pressing "${control.id}" -> "${target.value}" changes observable state`,
        wired, `adopted=${nowPressed} storage-moved=${before !== after}`)
    }
    note(`exercised ${exercised} control(s); ${dead.length} bound to nothing`)
    check('at least one real control was actually exercised',
      exercised > 0, `${exercised} pressed -- zero means this scenario asserted nothing`)

    /* THE INSTRUMENT MUST BE ABLE TO RETURN A DEAD CONTROL. A wiring test that
       cannot tell a live control from a dead one is the exact failure it exists
       to prevent, so it is shown one: a control with the right shape and no
       handler at all. If this reports "wired", every green above is worthless. */
    const selfTest = await evaluate(`(() => {
      const host = document.createElement('div')
      host.setAttribute('data-setting-id', 'first-run-contract-deadcontrol')
      const option = document.createElement('button')
      option.setAttribute('data-setting-value', 'inert')
      option.setAttribute('aria-pressed', 'false')
      option.textContent = 'inert'
      option.style.cssText = 'width:40px;height:20px;display:block'
      host.appendChild(option)
      document.body.appendChild(host)
      return true
    })()`)
    if (selfTest) {
      const beforeSelf = await evaluate(STORAGE_FINGERPRINT)
      await clickVisible('[data-setting-id="first-run-contract-deadcontrol"] [data-setting-value="inert"]')
      await settle(200, 3000)
      const afterSelf = await evaluate(STORAGE_FINGERPRINT)
      const selfPressed = await evaluate(
        `document.querySelector('[data-setting-id="first-run-contract-deadcontrol"] [data-setting-value="inert"]')?.getAttribute('aria-pressed') === 'true'`)
      const selfWired = selfPressed === true || beforeSelf !== afterSelf
      check('SELF-TEST: a control bound to nothing is reported as dead',
        selfWired === false, `the planted inert control read as ${selfWired ? 'WIRED -- this instrument cannot detect the defect it exists for' : 'dead, correctly'}`)
      await evaluate(`(() => { document.querySelector('[data-setting-id="first-run-contract-deadcontrol"]')?.remove(); return true })()`)
    }

    return checks
  } finally {
    await app.teardown()
  }
}

/* ================= SCENARIO 4: THE RECOMMENDED PATH, JOINED THROUGH THE DOM ===
 * Covered elsewhere BY VALUE -- a sibling clicks `assisted` by name, which
 * cannot notice the Recommended label moving to a different answer. That is
 * defect 9 exactly: the label and what the walkthrough preselects drifted apart,
 * and the person who followed the product's own advice got an installation with
 * no control anywhere that starts an agent.
 *
 * So this resolves WHICH ANSWER IS MARKED RECOMMENDED FROM THE GLASS. In
 * src/views/setup.js the note is rendered into a descriptive row per choice
 * (`.setup-choice`), and that row carries aria-current="true" exactly when its
 * choice is the selected one. So "the selected answer's own row carries the
 * Recommended note" is a true label-to-selection join through the DOM, and it
 * goes red the moment they disagree. */
const RECOMMENDED_PROBE = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
  const rows = [...document.querySelectorAll('.setup-choice')].map(row => ({
    current: row.getAttribute('aria-current') === 'true',
    choice: row.dataset.setupChoice || '',
    name: norm(row.querySelector('.settings-name')?.textContent),
  }))
  const buttons = [...document.querySelectorAll('[data-setup-set="autonomy"]')].map(button => ({
    value: button.dataset.setupValue || '',
    label: norm(button.textContent),
    pressed: button.getAttribute('aria-pressed') === 'true',
  }))
  return { rows, buttons }
})()`

async function driveRecommended(executable, scratch, attempt) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  /* NO SEED. Nothing has answered anything -- this is the shipped-defaults run. */
  const app = await openApp(executable, scratch, `recommended-${attempt}`, {})
  const { evaluate, until, settle, clickVisible, clickLastVisible, clicked } = app
  try {
    const onSetup = await until('the permission question', `location.hash === '#/setup'`)
    check('a true first launch opens on the permission question', onSetup,
      `hash=${await evaluate('location.hash')}`)
    if (!onSetup) return checks
    await settle()

    /* THE TIER QUESTION. Its rows carry data-setup-choice, so the join is by
       value directly. Nothing is pressed: the walkthrough's own preselection is
       what a person following the advice accepts. */
    const tierRows = await evaluate(`(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
      return [...document.querySelectorAll('.setup-choice')].map(row => ({
        choice: row.dataset.setupChoice || '',
        current: row.getAttribute('aria-current') === 'true',
        name: norm(row.querySelector('.settings-name')?.textContent),
      }))
    })()`)
    const tierRecommended = tierRows.find(row => /Recommended/.test(row.name))
    const tierSelected = tierRows.find(row => row.current)
    note(`tier rows: ${tierRows.map(r => `${r.choice}${r.current ? '*' : ''}`).join(', ')}`)
    check('the permission question marks exactly one answer Recommended',
      tierRows.filter(row => /Recommended/.test(row.name)).length === 1,
      tierRows.filter(row => /Recommended/.test(row.name)).map(r => r.choice).join(',') || 'none')
    check('the permission answer the walkthrough preselects IS the one marked Recommended',
      Boolean(tierSelected) && Boolean(tierRecommended) && tierSelected.choice === tierRecommended.choice,
      `preselected=${tierSelected?.choice ?? 'none'} recommended=${tierRecommended?.choice ?? 'none'}`)

    const continued = await clickVisible('[data-setup-continue]')
    check('the permission question continues', continued === 'clicked', continued)
    const atFolder = await until('the folder question',
      `document.querySelector('[data-setup-section]')?.innerText.includes('Which folder')`)
    check('it reaches the folder question', atFolder)
    await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
    await clickLastVisible('[data-setup-next]')

    const atAccount = await until('the sign-in step',
      `document.querySelector('[data-setup-section]')?.innerText.includes('Who is using this copy') || document.querySelector('[data-setup-section]')?.innerText.includes('Signed in as')`)
    check('it reaches the sign-in step', atAccount)
    await clickLastVisible('[data-setup-next]')

    const atAutonomy = await until('the autonomy question',
      `document.querySelector('[data-setup-section]')?.innerText.includes('without asking')`)
    check('it reaches the autonomy question', atAutonomy)
    await settle()

    /* ---- THE JOIN THAT DEFECT 9 NEEDED AND NOBODY HAD ---- */
    const autonomy = await evaluate(RECOMMENDED_PROBE)
    const noteRows = autonomy.rows.filter(row => /Recommended/.test(row.name))
    check('the autonomy question marks exactly one answer Recommended',
      noteRows.length === 1, `${noteRows.length} row(s) carry the note`)
    const selectedRow = autonomy.rows.find(row => row.current)
    const pressedButton = autonomy.buttons.find(button => button.pressed)
    note(`preselected button=${pressedButton?.value ?? 'none'}; row marked Recommended=${JSON.stringify(noteRows[0]?.name ?? 'none')}`)
    /* The autonomy rows have no data-setup-choice (the tier rows do), so the row
       is joined to its value through the BUTTON LABEL, which the row's name
       begins with. Reported both ways so a failure names the mismatch. */
    const recommendedValue = noteRows.length === 1 && pressedButton
      ? autonomy.buttons.find(button => noteRows[0].name.startsWith(button.label))?.value ?? null
      : null
    check('THE PRESELECTED AUTONOMY ANSWER IS THE ONE MARKED RECOMMENDED',
      Boolean(selectedRow) && noteRows.length === 1 && selectedRow.name === noteRows[0].name,
      `preselected row=${JSON.stringify(selectedRow?.name ?? 'none')} recommended row=${JSON.stringify(noteRows[0]?.name ?? 'none')} (value=${recommendedValue ?? 'unresolved'})`)

    /* NOT ONE ANSWER IS PRESSED FROM HERE ON. Accepting the recommendation is
       pressing forward, and what that lands on is the whole question. */
    const toReview = await clickVisible('[data-setup-next="review"]')
    check('it reaches the review without changing an answer', toReview === 'clicked', toReview)
    await until('the review',
      `document.querySelector('[data-setup-section]')?.innerText.includes('what those answers set')`)
    await settle()
    const reviewText = await evaluate(`document.querySelector('[data-setup-section]')?.innerText || ''`)
    check('the review does not have to warn that nothing will start an agent',
      !/nothing here will start an agent/i.test(reviewText),
      'a recommended path that warns about itself is still the defect')

    const finished = await clickVisible('[data-setup-next="finish"]')
    check('the review can be accepted', finished === 'clicked', finished)
    const intoApp = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 120)
    check('setup ends in the app', intoApp, `hash=${await evaluate('location.hash')}`)
    await settle()

    /* ---- and on to a running agent, still only pressing forward ---- */
    const toComputers = await clickVisible('#nav-next')
    check('the forward chevron reaches the computers page', toComputers === 'clicked', toComputers)
    await until('the computers page', `document.body.dataset.route === 'computers'`)
    await settle(700, 15000)
    const nodes = await evaluate(`document.querySelectorAll('.computers .static-tree-node').length`)
    /* SAY WHAT IS ACTUALLY ON THE CANVAS WHEN THIS FAILS. `.static-tree-node`
       means "a running agent" and, by src/tree-graph.js:67-75, an empty slot
       deliberately does NOT wear it. So a fresh profile with no agents reports
       nodes=0 whether the page is genuinely bare or correctly showing a slot to
       press -- two very different verdicts behind one number. Measured
       2026-08-17: that ambiguity had a lane one step from "fix" a page that may
       be behaving exactly as designed. The slot count decides it, so it is
       printed beside the failure rather than left to be re-derived. */
    const slots = await evaluate(`document.querySelectorAll('.computers .tree-empty-node').length`)
    /* WHAT THIS PAGE OWES A STRANGER IS A WAY IN, NOT AN AGENT THAT ALREADY EXISTS.
     *
     * `nodes >= 1` demanded a RUNNING AGENT on a profile that has never started
     * one, which no clean machine can satisfy, so it reported correct behaviour
     * as a defect -- and it took the next three checks down with it, because they
     * drill into an agent that was never there. Measured 2026-08-17 on packaged
     * 1.0.18: nodes=0, slots=1, and the run's own closing check passed with a
     * startable agent SEVEN clicks from first paint. The product was fine.
     *
     * The empty slot is the designed way in: src/views/computers.js:749 creates
     * the drill-in door `hidden`, and src/tree-graph.css:189 keeps it hidden with
     * a comment saying why -- "the absent state renders as a visible button that
     * does nothing -- the exact defect this control exists to avoid making
     * worse". A harness that reads that deliberate absence as a failure is the
     * same false-finding class this file's own comments already record twice.
     *
     * So the contract is: SOMETHING on this canvas can be pressed. A genuinely
     * bare canvas -- no agent and no slot -- still fails, which is the regression
     * that mattered all along. */
    const wayIn = nodes >= 1 || slots >= 1
    check('the fleet page offers a way in -- an agent to open, or a slot to start one', wayIn,
      `agent nodes=${nodes}; empty slots on the canvas=${slots}`
      + (nodes === 0 && slots > 0 ? ' -- no agent yet, which is what a profile that has never started one looks like; the slot is the way in' : '')
      + (!wayIn ? ' -- NOTHING to press: this canvas is genuinely bare' : ''))

    /* The drill-in only exists once an agent does. Below, the three checks that
       read the agent page are reported as not-applicable rather than failed when
       there is no agent to open -- a not-applicable is not a pass, it is the
       absence of a measurement, and it is printed so nobody reads silence as
       coverage. */
    const canDrillIn = nodes >= 1
    if (canDrillIn) {
      const openedAgent = await clickVisible('.computers .graph-open-btn')
      check('the door into the agent page can be pressed', openedAgent === 'clicked', openedAgent)
      await until('the agent detail page', `Boolean(document.querySelector('.agentv'))`)
      await settle(700, 15000)
    } else {
      note('no agent exists yet, so the agent page and its Start control are not measured on this run -- the way in is the slot on the fleet page, and the clicks-to-Start check below is what proves a stranger can reach one')
    }

    const page = await evaluate(`(() => {
      const shown = node => {
        if (!node) return false
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const start = document.querySelector('[data-session-start]')
      const status = document.querySelector('[data-session-status]')
      const norm = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
      return {
        startPresent: Boolean(start),
        startVisible: shown(start),
        startDisabled: start ? Boolean(start.disabled) : null,
        statusText: norm(status),
        flag: (() => { try { return localStorage.getItem('mc.write.agent-session') } catch { return 'unreadable' } })(),
      }
    })()`)

    /* ================= WHAT THE RECOMMENDATION ACTUALLY GETS YOU ================= */
    if (canDrillIn) {
      check('THE RECOMMENDED PATH LEAVES A START CONTROL ON THE AGENT PAGE',
        page.startPresent && page.startVisible,
        `present=${page.startPresent} visible=${page.startVisible} mc.write.agent-session=${JSON.stringify(page.flag)}`)
    } else {
      note(`not measured: there is no agent to open, so this run never reached an agent page (mc.write.agent-session=${JSON.stringify(page.flag)})`)
    }

    /* A DISABLED START IS NOT AUTOMATICALLY A DEFECT, AND THE FIRST DRAFT OF THIS
       CHECK ASSUMED IT WAS. On a sterile profile nobody has run `codex login`, so
       the agent engine genuinely cannot start a session and src/agent-session.js
       leaves Start disabled on purpose. Asserting `disabled !== true` therefore
       demanded something no clean machine can satisfy and reported the product's
       own honesty as a fault -- a false finding, caught by running it.
       THE REAL CONTRACT is that a control a person cannot use must SAY WHY, in
       words that name the remedy. That is the same defect class as a dead
       control: the person is left in front of something that does not work with
       no account of it. So the reason is required to be one the product's own
       copy table produces -- not blank, not a raw error code, not a fallback. */
    /* THE COPY TABLE IS LOADED HERE, AND A FAILURE TO LOAD IT IS A CHECK RATHER
       THAN A CRASH. `availabilityCopy` was referenced without ever being bound,
       so this harness died with `ReferenceError: availabilityCopy is not
       defined` after eighteen green checks -- measured on this tree on
       2026-08-11, exit 1 at 71.4s, with the recommended-path verdict it had
       just computed thrown away. The module is loaded dynamically and its
       failure is folded into the check the author already wrote for exactly
       this ("so the next check can fail"): an empty table would let the
       comparison below match nothing and silently pass every status text. */
    const { reasons, copyLoadError } = await availabilityReasons()
    check('the availability copy table was loaded, so the next check can fail',
      reasons.length > 0, copyLoadError ? `could not load src/agent-availability-copy.js: ${copyLoadError}` : `${reasons.length} reason(s) known`)
    if (!canDrillIn) {
      /* No agent page was opened, so page.startDisabled is null and statusText is
         empty -- the `else` branch below would then demand the word "ready" from a
         status nothing ever rendered, and fail. That is measuring the harness's own
         absence, not the product. */
      note('not measured: a Start control\'s wording is only checkable on an agent page, and this run had no agent to open')
    } else if (page.startDisabled === true) {
      const named = reasons.find(reason => page.statusText.includes(reason))
      check('a Start a person cannot press states why, in the product\'s own words',
        Boolean(named),
        named
          ? `status names a known reason: ${JSON.stringify(named.slice(0, 80))}`
          : `status=${JSON.stringify(page.statusText.slice(0, 200))} matches NO entry in UNAVAILABLE_TEXT -- a disabled control with no account of itself`)
    } else {
      check('an enabled Start reports the engine as ready',
        /ready/i.test(page.statusText), `status=${JSON.stringify(page.statusText.slice(0, 120))}`)
    }

    /* ---- THE CLICK BUDGET, ASSERTED ---- */
    const total = clicked() + 1 // the press of Start the person still has to make
    note(`clicks from first paint to a startable agent: ${clicked()} (+1 for Start = ${total})`)
    check(`the recommended path reaches a startable agent within ${CLICK_BUDGET} clicks`,
      total <= CLICK_BUDGET,
      `${total} clicks including Start; budget ${CLICK_BUDGET}`)

    return checks
  } finally {
    await app.teardown()
  }
}

/* ================= EXPLORE: MEASURE, ASSERT NOTHING =================
 * For working out what a screen actually offers before writing a check against
 * it. Nothing here is a verdict and it never sets a failing exit code. */
async function explore(executable, scratch) {
  const app = await openApp(executable, scratch, 'explore', { seedTier: 'standard' })
  const { evaluate, settle, clickVisible } = app
  try {
    let current = await evaluate(ROUTE_PROBE)
    const seen = new Set()
    while (!seen.has(current.route) && seen.size < 24) {
      seen.add(current.route)
      console.log(`\n--- ${current.route} (${current.hash}) ---`)
      console.log(`  title: ${current.title}`)
      console.log(`  view: ${current.viewClass} visible=${current.viewVisible} text=${current.textLength} chars`)
      console.log(`  chevron forward says: "${current.nextDest}" / back: "${current.backDest}"`)
      console.log(`  first 300 chars: ${JSON.stringify(current.text.slice(0, 300))}`)
      if (await clickVisible('#nav-next') !== 'clicked') break
      await settle()
      current = await evaluate(ROUTE_PROBE)
    }
    console.log(`\nring: ${[...seen].join(' -> ')}`)
    await clickVisible('#open-settings')
    await settle()
    const controls = await evaluate(SETTINGS_PROBE)
    console.log(`\nsettings controls (${controls.length}):`)
    for (const control of controls) {
      console.log(`  ${control.id} [${control.tag}] options=${control.options.map(o => `${o.value}${o.pressed ? '*' : ''}`).join(',')}`)
    }
  } finally {
    await app.teardown()
  }
}

const SCENARIO_RUNNERS = {
  ring: driveRing,
  privacy: drivePrivacy,
  wiring: driveWiring,
  recommended: driveRecommended,
}

async function main() {
  const offenders = offendingHashAssignments(readFileSync(SELF, 'utf8'))
  if (offenders.length) {
    console.error('This suite assigns location.hash outside the tagged state check, so its')
    console.error('reachability claims are not reachability claims. Offending lines:')
    for (const { line, at } of offenders) console.error(`  ${at}: ${line.trim()}`)
    process.exitCode = 1
    return
  }
  console.log('self-audit ok: navigation for every reachability check is by click\n')

  const scratch = mkdtempSync(path.join(tmpdir(), 'first-run-contract-'))
  let failures = 0
  let total = 0
  let unmeasurable = null
  try {
    console.log(`staging a packaged copy from ${RELEASE}`)
    const executable = await stage(scratch)
    console.log(`staged: ${executable}`)
    console.log(`measuring: dist/ and shell/ as they are in ${REPO_ROOT} right now, in the binary from ${RELEASE}\n`)

    if (EXPLORE) {
      await explore(executable, scratch)
      console.log('\n(--explore measures only; no verdict)')
      return
    }

    for (const scenario of SCENARIOS) {
      const runner = SCENARIO_RUNNERS[scenario]
      if (!runner) {
        console.error(`unknown scenario "${scenario}"; known: ${Object.keys(SCENARIO_RUNNERS).join(', ')}`)
        process.exitCode = 1
        return
      }
      console.log(`--- ${scenario} ---`)
      let checks = null
      for (let attempt = 1; attempt <= ATTEMPTS && !checks; attempt += 1) {
        try {
          checks = await runner(executable, scratch, attempt)
        } catch (error) {
          if (!(error instanceof HarnessError) || attempt === ATTEMPTS) throw error
          console.log(`  ..    could not attach on attempt ${attempt} of ${ATTEMPTS}: ${error.message}`)
          console.log('  ..    retrying on a clean profile; nothing above is a statement about the product')
        }
      }
      failures += checks.filter(entry => !entry.ok).length
      total += checks.length
      console.log('')
    }
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    unmeasurable = error
  } finally {
    if (KEEP) {
      console.log(`scratch kept at ${scratch}`)
    } else {
      /* CLEANUP MUST NOT BE ABLE TO FAIL THE RUN. Windows holds the staged
         Electron's DLLs briefly after exit, so rm throws EPERM; letting that
         escape turns an all-green run into exit 1, which is the same class of
         lie as reading an exit code through a pipe. */
      let removed = false
      for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
        try { rmSync(scratch, { recursive: true, force: true }); removed = true } catch { await delay(600) }
      }
      if (!removed) console.log(`(could not remove the scratch copy at ${scratch}; it is safe to delete)`)
    }
  }

  if (unmeasurable) {
    console.error('')
    console.error('=================== NO VERDICT: THE HARNESS COULD NOT MEASURE ===================')
    console.error(unmeasurable.message)
    console.error('')
    console.error('THIS SAYS NOTHING ABOUT THE PRODUCT. It says this probe could not attach to')
    console.error('the app. Do not quote this run, or its exit code, as evidence either way.')
    console.error('Exit 2 is reserved for exactly this and is never used for a failed check.')
    console.error('================================================================================')
    process.exitCode = 2
    return
  }
  console.log(failures === 0 ? `ALL ${total} CHECKS PASSED` : `${failures} of ${total} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  await main()
}
