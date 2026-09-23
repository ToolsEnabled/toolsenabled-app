#!/usr/bin/env node

// CAN A PERSON GET TO THE AGENT DETAIL PAGE? DRIVEN BY CLICKS, IN A REAL WINDOW.
//
// WHAT CHANGED, AND WHY THE FRESH-INSTALL CHECKS BELOW ARE NOT THE ONES THIS
// FILE SHIPPED WITH.
//
// This suite was written against a fresh install that drew NO computers at all,
// and it pinned that: `nodeCount === 0`, an explanation panel, and one door
// leading to the DEMONSTRATION copy of the drill-in. Every one of those checks
// passed, and a customer still could not open a real agent on their own machine
// — because the page's only source of computers was /data/fleet.json, a
// BUILD-TIME file that ships `ok:false` on every install and can never say
// anything else. Measured on this build, fresh profile: fleet.json ok:false,
// agents.json ok:false, and `window.mcOrg.read()` ok:true with a declared
// organisation sitting right there unread. See src/declared-fleet.js.
//
// So the machine now appears, drawn from the organisation this copy declares,
// and these checks assert THAT. The suite's rules are unchanged and are the
// reason the old pass was not worth much: reachability is claimed only for
// navigation performed by clicking a visible, named control, and a control that
// leads nowhere is a defect rather than a pass. What moved is the destination —
// the drill-in a fresh install can reach is now the LIVE page for an agent this
// machine really declares, not a labelled demonstration whose controls are
// deliberately inert.
//
// The empty state did not disappear and is not untested: it is now the answer
// for a copy with no organisation store behind it (a plain browser), and
// `declaredFleetData()` returning null for that case is pinned by name in
// tools/test/declared-fleet.test.mjs. What cannot be produced in a packaged
// window is not asserted here as though it had been.
//
// WHY THIS EXISTS AND WHY IT IS NOT tools/agent-subpage-qa.mjs. That harness
// checks the agent page renders correctly, and it reaches the page by doing
//     location.hash = '#/agent/c1/codex'
// which is the one thing a customer cannot do. It therefore passes in full on a
// build where NOTHING ROUTES TO THAT PAGE AT ALL -- which is exactly the state
// this tree was in: `agent` is not on the nav ring (it cannot be; the ring is
// parameterless and this route needs a computer id and an agent id), and the
// shipped public/data/fleet.json is `{"ok": false, "data": null}`, so a fresh
// install drew an empty page with no node to click and no control naming the
// drill-in. Three lanes had just finished rebuilding that page. Every one of
// those fixes sat behind a door that did not exist.
//
// So this suite asserts REACHABILITY, and it earns the word:
//   * It never assigns location.hash to satisfy a reachability check. Navigation
//     happens by clicking elements, the way a person does. There is a self-audit
//     below that reads this file's own source and fails if that rule is broken,
//     so the instrument cannot quietly start cheating. The ONE state check that
//     needs a deep link says so in its name and is not a reachability claim.
//   * Every control it clicks must first be VISIBLE (a real box, not
//     display:none, not visibility:hidden) and NAMED (a non-empty accessible
//     name). A control you cannot see or cannot read is not a way in.
//   * A control that leads nowhere counts as a defect, not a pass. The empty
//     state is checked for the ABSENCE of a dead button as well as the presence
//     of an explanation.
//
// ISOLATION -- each mechanism for a measured reason, taken from
// tools/agent-subpage-qa.mjs which learned them the hard way:
//   --user-data-dir  Electron resolves userData through the Windows known-folder
//                    API, not the environment; this is the supported override and
//                    it moves the single-instance lock so this runs alongside a
//                    copy someone is using.
//   LOCALAPPDATA     our OWN code (resolveServicesRoot) reads the environment, so
//                    the machine record lands in scratch. Load-bearing: without
//                    it this harness reads the OWNER'S recorded permission level.
//                    A lane that isolated only the user-data dir measured
//                    `unrestricted` on this machine and concluded from it that
//                    the tier was not enforced at all. It was wrong, and the
//                    wrong answer was repeated to the owner for hours.
//   USERPROFILE      so the Codex-home probe reads scratch, not a real profile.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node, exits
// 0, and is indistinguishable from a crash.
//
// RUN IT:
//   node tools/agent-route-reachability.mjs                 (all three tiers)
//   node tools/agent-route-reachability.mjs --tier guided
//   node tools/agent-route-reachability.mjs --keep          (keep the scratch dir)
//   --open-timeout-ms <n>   how long to wait for the window (default 120000)
//   --attempts <n>          attach retries per tier, clean profile each (default 3)
//
// READ THE EXIT CODE, IT HAS THREE VALUES AND ONLY TWO OF THEM ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED -- this is a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured. This is
//      a statement about the probe or the machine, never about the product.
// The third code exists because this suite once died at startup, exited 1, and
// that 1 was quoted for hours as "the agent page is unreachable on a fresh
// install" -- a claim it had in fact failed to test. Never read this tool's
// status through a pipe, either: `node x.mjs | tail` reports TAIL's status.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { resolveMachineServicesRoot } from './lib/qa-services-root.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', path.join(REPO_ROOT, 'release', 'win-unpacked')))
const KEEP = process.argv.includes('--keep')
const TIERS = argument('--tier') ? [argument('--tier')] : ['guided', 'standard', 'unrestricted']
/* 30s was the old budget and it is not a safe one here. Ten lanes share this
   machine and one of them can be running a full `npm run dist` while this
   starts a packaged Electron from a freshly written asar; the first window has
   been measured taking over 20s under that load. A budget tight enough to trip
   on load manufactures exactly the false report this suite was quoted for. */
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
/* An attach that fails is an environment event far more often than a product
   event, so try again on a clean profile before declaring the run unmeasurable.
   Bounded, and every attempt is printed, so a retry can never be silent. */
const ATTEMPTS = Number(argument('--attempts', 3))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ---------- the instrument audits itself ----------
 * A reachability suite that reaches the page by assigning the hash is not a
 * reachability suite, and the failure mode is silent: it goes green and reports
 * that a missing door is present. The only navigation this file is allowed to do
 * for a reachability claim is a click, so the rule is enforced against the
 * source rather than trusted. The single permitted deep link is tagged with the
 * marker below and is used by a check whose NAME says it is a state check. */
const DEEP_LINK_MARKER = 'DEEP-LINK-STATE-CHECK'
/* ASSIGNMENT IS NAVIGATION; COMPARISON IS OBSERVATION. The first version of
 * this guard tested /location\.hash\s*=/, which cannot tell the two apart: it
 * fired on `location.hash === '#/setup'`, a READ that navigates nowhere. That
 * is not a harmless over-catch. It made the suite structurally unable to CHECK
 * where it had arrived, which is the one thing a reachability suite must be
 * able to do -- so the first-launch measurement below could not be written at
 * all until this was fixed. The rule is unchanged and this is strictly
 * narrower: `=` not followed by `=`, plus `+=`, both of which move the window;
 * `==`, `===` and `!==` do not.
 * PROVEN, not asserted: tools/test/agent-route-self-audit.test.mjs feeds this
 * function both forms and fails if either verdict flips. */
export function offendingHashAssignments(source) {
  return source
    .split('\n')
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(=(?!=)|\+=)/.test(line))
    .filter(({ line }) => !line.includes(DEEP_LINK_MARKER))
    /* prose ABOUT the rule is not a breach of it */
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
}
function auditSelf() {
  return offendingHashAssignments(readFileSync(SELF, 'utf8'))
}

/* ---------- stage a real packaged copy ----------
 * Borrows the built binary and the capability payload and swaps in the CURRENT
 * dist/ and shell/, so this measures the working tree rather than whenever
 * release/ was last built. Writes nothing under release/. */
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
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    /* ~10 lanes share this worktree, so `shell/` or `dist/` can be mid-edit and
       fail to boot for reasons that have nothing to do with what is under test.
       --dist/--shell point the stage at a copy of your own; the DEFAULT is still
       the working tree, so an unqualified run measures what is actually here. */
    const from = path.resolve(argument(`--${directory}`, path.join(REPO_ROOT, directory)))
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
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

/* Pick the launcher by SHAPE, not by spelling: the product is mid-rename, so a
   hardcoded executable name is guaranteed to be wrong for somebody. */
function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  if (executables.length === 0) throw new Error(`no .exe in the staged app at ${appRoot}`)
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

/* ---------- A FAILURE OF THE PROBE IS NOT A FINDING ABOUT THE PRODUCT ----------
 * This suite once died before reaching a single check -- "no debuggable page
 * appeared within 30s" -- and exited 1. Exit 1 is also what a real reachability
 * failure looks like, so for hours that sentence was quoted as the measurement
 * it had failed to take: "the agent page is unreachable on a fresh install".
 * Everything a harness cannot attach to must therefore be raised as this type,
 * reported under a banner that says NO VERDICT, and exited with a code that
 * cannot be mistaken for a red check. */
class HarnessError extends Error {}

/* ---------- finding the debugger, without a race ----------
 * The first version asked the OS for a free port, closed the listener, then
 * handed the number to Electron. Between that close and Electron's bind the
 * port belongs to nobody, and roughly ten lanes on this machine run packaged
 * harnesses that also ask the OS for ephemeral ports. When one of them wins
 * that race Electron cannot bind, the app starts perfectly, no debugger ever
 * answers, and the harness reports a sentence about itself in words that read
 * like a sentence about the product.
 * Chromium already solved this: with --remote-debugging-port=0 it chooses the
 * port and writes it to <user-data-dir>/DevToolsActivePort. Asking the app
 * which port it got, instead of telling it which port to want, removes the
 * window in which the race can happen at all. */
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

async function publishedDebuggerPort(userDataDir, child, budgetMs) {
  const file = path.join(userDataDir, ACTIVE_PORT_FILE)
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (child.exitCode !== null) {
      throw new HarnessError(`the app exited with code ${child.exitCode} before it published a debugger port; this is a startup failure, not a slow paint`)
    }
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* Electron has not written it yet */ }
    await delay(200)
  }
  throw new HarnessError(`the app never wrote ${ACTIVE_PORT_FILE} into its profile within ${Math.round(budgetMs / 1000)}s, so its debugger never started`)
}

function createSession(child, userDataDir, say) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open(budgetMs) {
      const started = Date.now()
      const port = await publishedDebuggerPort(userDataDir, child, budgetMs)
      say(`debugger published on 127.0.0.1:${port} after ${Date.now() - started}ms`)
      /* Say WHICH of the several different things went wrong. "No page
         appeared" covers a refused connection, an empty target list and a
         window that is not a page, and those have nothing in common. */
      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered; this is a startup failure, not a slow paint`)
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
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            say(`attached to the window after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length
            ? `the endpoint answered with ${targets.length} target(s) and none was a debuggable page: ${targets.map(entry => `${entry.type}:${entry.title || entry.url || '?'}`).join(', ')}`
            : 'the endpoint answered with an EMPTY target list, so the process is up but no window ever opened -- look for a modal error dialog or a main-process throw in the app output below'
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

/* Written with the ENGINE'S OWN writer, so a record this harness creates is one
   the product would accept, and a schema change breaks the harness rather than
   letting it seed something the app quietly ignores. Seeding it also clears the
   first-run permission question, which otherwise holds every route at #/setup
   and would time this suite out on a screen that is not the one under test. */
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

/* ---------- what is on the glass ----------
 * `visible` is MEASURED. Text in the DOM is not text on the screen, and a
 * control in the DOM is not a control a person can press. */
const PROBE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return false
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const norm = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  /* The accessible name a screen reader would announce, in the order the
     accname spec resolves it. A button with a box but no name is not a door
     anyone can find. */
  const name = node => (node
    ? (node.getAttribute('aria-label') || norm(node) || node.getAttribute('title') || '')
    : '')
  const one = selector => document.querySelector(selector)
  const read = selector => {
    const node = one(selector)
    return { present: Boolean(node), visible: shown(node), name: name(node), text: norm(node) }
  }
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    title: document.title,
    empty: read('.computers .graph-empty'),
    emptyHeading: read('.computers .graph-empty-h'),
    emptyReason: read('.computers .graph-empty-reason'),
    emptyBody: read('.computers .graph-empty-body'),
    emptyAction: read('.computers .graph-empty-action'),
    emptyNote: read('.computers .graph-empty-note'),
    openButton: read('.computers .graph-open-btn'),
    railUnavailable: read('.computers .stats-page .projection-unavailable'),
    projectionState: (document.querySelector('.computers') || {}).dataset?.projectionState || '',
    nodeCount: document.querySelectorAll('.computers .static-tree-node').length,
    agentView: read('.agentv'),
    agentLiveMode: (document.querySelector('.agentv') || {}).dataset?.liveMode || '',
    provenance: read('.agent-provenance'),
    cardCount: document.querySelectorAll('.ar-card').length,
    stateOut: read('.projection-state-out'),
    stateTitle: read('.projection-state strong'),
  }
})()`

/* ---------- one packaged window, however it is going to be driven ----------
 * Extracted so the SEEDED walk below and the TRUE first launch further down
 * are the same instrument pointed at two different starting states. The second
 * measurement exists because the first one cannot make the claim people were
 * quoting from it: seedMachineRecord deliberately answers the permission
 * question before the window opens, so every check below starts on a machine
 * that has ALREADY been set up. That is a fair way to measure the three tiers
 * against each other, and it is not "from first launch with shipped defaults". */
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

  const userData = path.join(profile, 'userdata')
  /* THE APP'S OWN WORDS ARE THE FIRST THING A STARTUP FAILURE NEEDS, and the
     previous version threw them away with stdio:'ignore'. A main-process throw
     puts up a modal dialog and leaves the process alive with no window, which
     is indistinguishable from a slow paint unless you kept the message. */
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      noise.push(chunk)
      while (noise.length > 400) noise.shift()
    })
  }
  child.on('error', error => noise.push(`[spawn error] ${error.message}\n`))

  const session = createSession(child, userData, message => console.log(`  ..    ${message}`))
  const teardown = async () => {
    session.close()
    /* child.kill() reaches the main process only; Electron's GPU, utility and
       renderer processes survive it and accumulate. Seven of them were still
       resident from earlier runs when this lane started, on the same machine
       whose load is one of the candidate explanations for a slow start. Kill
       the tree -- every process in it was started by this harness. */
    try { child.kill() } catch { /* already gone */ }
    if (child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* nothing left */ }
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
  /* CLICKS ARE COUNTED BY THE INSTRUMENT, NEVER BY HAND. "Seven clicks" was
     being quoted from a hand count nobody could re-derive; a tally kept by the
     thing doing the clicking cannot drift from what was actually pressed, and
     it counts only presses that LANDED. */
  let clicks = 0
  /* Click by SELECTOR, and refuse to click what a person could not.
     Returns why it refused, so a failure names the reason rather than just
     reporting that nothing happened. */
  const clickVisible = async selector => {
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
  /* Some setup steps render the forward control LAST, with an earlier match on
     the same screen being a back or secondary control. Same visibility rules,
     same tally -- a press counted here is a press a person made. */
  const clickLastVisible = async selector => {
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
  await delay(900)

  return { evaluate, until, clickVisible, clickLastVisible, teardown, profile, clicked: () => clicks }
}

async function drive(executable, scratch, tier, attempt = 1) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }

  const app = await openApp(executable, scratch, `${tier}-${attempt}`, { seedTier: tier })
  const { evaluate, until, clickVisible } = app
  try {

    /* ---------- 1. THE FRESH INSTALL, WALKED FROM FIRST PAINT ---------- */
    const first = await evaluate(PROBE)
    check(`${tier}: a fresh install opens past the permission question`,
      first.route !== 'setup', `route=${first.route || '(none)'}`)

    /* home -> computers is one press of the forward chevron. This is the only
       navigation chrome the app has, so it is also the only way a person
       reaches this page at all. */
    const toComputers = await clickVisible('#nav-next')
    check(`${tier}: the computers page is reached by clicking the forward chevron`,
      toComputers === 'clicked', `#nav-next: ${toComputers}`)
    await until('the computers page', `document.body.dataset.route === 'computers'`)
    await delay(1400)

    const empty = await evaluate(PROBE)

    /* THE CHECK THAT WOULD HAVE CAUGHT IT. A fresh install has no fleet host and
       never will have one from a build-time file, so this is the state every
       customer opens on. The machine in front of the person must be ON their own
       fleet page. `0` here is the exact defect this repair closes. */
    check(`${tier}: a fresh install draws this computer on the fleet page`,
      empty.nodeCount >= 1, `tree nodes on screen = ${empty.nodeCount}`)
    check(`${tier}: and says the graph is the declared one, not an observed fleet`,
      empty.projectionState === 'declared', `data-projection-state=${JSON.stringify(empty.projectionState)}`)

    /* ---------- 2. DRAWING SOMETHING MUST NOT HIDE ANYTHING ----------
       The fleet projection's own refusal is a fact the customer is entitled to,
       and the easiest way to make this page look healthy would be to drop it.
       It has to survive, verbatim, beside the graph. */
    check(`${tier}: the page still states the fleet projection's own reason verbatim`,
      empty.railUnavailable.visible && /no local agent fleet host detected/i.test(empty.railUnavailable.text),
      JSON.stringify(empty.railUnavailable.text.slice(0, 140)))
    /* ...and says what a declared agent is, so a configured agent is never read
       as a running one. */
    check(`${tier}: and distinguishes declared agents from observed ones`,
      /not agents observed running/i.test(empty.railUnavailable.text),
      JSON.stringify(empty.railUnavailable.text.slice(0, 160)))

    /* ---------- 3. NO DEAD CONTROLS, AND NO EMPTY PANEL OVER A GRAPH ---------- */
    check(`${tier}: the "no computers are reporting" panel is gone now that one is`,
      !empty.empty.visible, `.graph-empty visible=${empty.empty.visible}`)

    /* ---------- 4. THE DOOR IS VISIBLE AND NAMED ---------- */
    check(`${tier}: the fleet page offers a visible, named way into the drill-in`,
      empty.openButton.visible && empty.openButton.name.trim().length > 0,
      `visible=${empty.openButton.visible} name=${JSON.stringify(empty.openButton.name)}`)

    /* ---------- 5. IT ACTUALLY GOES THERE, AND WHAT IT REACHES IS REAL ---------- */
    const opened = await clickVisible('.computers .graph-open-btn')
    check(`${tier}: the door can be pressed`, opened === 'clicked', `.graph-open-btn: ${opened}`)
    const arrived = await until('the agent detail page', `Boolean(document.querySelector('.agentv'))`)
    await delay(900)
    const detail = await evaluate(PROBE)
    check(`${tier}: pressing it lands on the agent detail page`,
      arrived && detail.agentView.visible, `hash=${detail.hash} agentv=${detail.agentView.visible}`)
    /* Reaching a page that renders nothing is the defect one layer along again. */
    check(`${tier}: the page it lands on has agents on it`,
      detail.cardCount >= 1, `roster cards = ${detail.cardCount}`)
    /* THE POINT OF THE WHOLE REPAIR. The drill-in a fresh install can reach must
       be the LIVE page for an agent this machine declares — not the labelled
       demonstration, whose controls are deliberately inert and which therefore
       cannot be a route to using the product. */
    check(`${tier}: what it reaches is this machine's own agent, not a demonstration`,
      detail.agentLiveMode === 'live' && !/\/example$/.test(detail.hash),
      `hash=${detail.hash} data-live-mode=${JSON.stringify(detail.agentLiveMode)}`)
    check(`${tier}: and the page says whose data it is`,
      detail.provenance.visible && /declared topology read from this computer/i.test(detail.provenance.text),
      JSON.stringify(detail.provenance.text.slice(0, 110)))

    /* ---------- 6. THE DEEP-LINK STATE IS NOT TERMINAL ---------- */
    /* NAMED AS A STATE CHECK, NOT A REACHABILITY CHECK. This is the one place a
       hash is assigned, and it is deliberate: the state under test is what a
       RESTORED WINDOW or a bookmark lands on when the projection has nothing,
       which is by definition arrived at without a click. What is asserted is
       that the state offers a way out, not that anything routes to it. */
    await evaluate(`location.hash = '#/agent/nobody/nobody'`) // DEEP-LINK-STATE-CHECK
    /* Wait for the RESOLVED state, not merely for a state: the loading state is
       also a .projection-state and deliberately carries no way out, so waiting
       on the class alone would sample the one case exempt from this check and
       report a defect that is not there. */
    await until('the resolved projection state',
      `Boolean(document.querySelector('.projection-state:not(.is-loading)'))`)
    await delay(400)
    const stranded = await evaluate(PROBE)
    check(`${tier}: a deep link into an empty projection is not a dead end (state check)`,
      stranded.stateOut.visible && stranded.stateOut.name.trim().length > 0,
      `out=${JSON.stringify(stranded.stateOut.name)} title=${JSON.stringify(stranded.stateTitle.text)}`)
    const escaped = await clickVisible('.projection-state-out')
    await until('the computers page again', `document.body.dataset.route === 'computers'`)
    const back = await evaluate(PROBE)
    check(`${tier}: and the way out actually returns to the computers page`,
      escaped === 'clicked' && back.route === 'computers', `${escaped}, route=${back.route}`)

    return checks
  } finally {
    await app.teardown()
  }
}

/* ---------- what a person with the shipped defaults actually faces ----------
 * THE MEASUREMENT THAT DID NOT EXIST. Everything above starts on a machine that
 * has already answered the permission question, because seedMachineRecord
 * answers it before the window opens. So the suite could say "a fresh install
 * opens past the permission question" while never having met the question. The
 * numbers people were quoting at each other -- "seven clicks", "no route at
 * all" -- were about this path, and nothing was driving it.
 *
 * Here the walkthrough is walked, by clicking, from the screen a real first
 * launch actually opens on, and the click count is kept by the clicker.
 *
 * BOTH SHIPPED ROUTES ARE MEASURED, because a person meets one or the other and
 * they do not end in the same place: answering the questions applies a profile
 * (src/setup-profile.js), and SKIPPING deliberately applies nothing at all --
 * by design, so that skipping is byte-identical to never running setup. The
 * agent page is downstream of both. Whether the control that RUNS an agent is
 * on the page is downstream of which one you took, and that is the finding. */
const SESSION_PROBE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const surface = document.querySelector('.agent-session-surface')
  const start = document.querySelector('[data-session-start]')
  const status = document.querySelector('[data-session-status]')
  const norm = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    agentVisible: shown(document.querySelector('.agentv')),
    liveMode: (document.querySelector('.agentv') || {}).dataset?.liveMode || '',
    surfacePresent: Boolean(surface),
    surfaceVisible: shown(surface),
    startPresent: Boolean(start),
    startVisible: shown(start),
    startDisabled: start ? Boolean(start.disabled) : null,
    startName: norm(start),
    statusText: norm(status),
    agentSessionFlag: (() => { try { return localStorage.getItem('mc.write.agent-session') } catch { return 'unreadable' } })(),
  }
})()`

async function driveFirstLaunch(executable, scratch, tier, route, attempt = 1) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  /* NO seedTier. This is the whole point: nothing has answered anything. */
  const app = await openApp(executable, scratch, `firstrun-${tier}-${route}-${attempt}`, {})
  const { evaluate, until, clickVisible, clickLastVisible, clicked } = app
  try {
    const onSetup = await until('the permission question', `location.hash === '#/setup'`)
    check(`${tier}/${route}: a true first launch opens on the permission question`,
      onSetup, `hash=${await evaluate('location.hash')}`)
    if (!onSetup) return checks

    /* The level is chosen by pressing it -- unless the walkthrough already
       offers it, in which case a person presses nothing and the honest count
       for that level is one lower. Measured, not assumed. */
    const alreadyChosen = await evaluate(
      `Boolean(document.querySelector('[data-setup-tier=${JSON.stringify(tier)}][aria-pressed="true"]'))`)
    if (!alreadyChosen) {
      const picked = await clickVisible(`[data-setup-tier=${JSON.stringify(tier)}]`)
      check(`${tier}/${route}: the permission level can be chosen by pressing it`,
        picked === 'clicked', `[data-setup-tier=${tier}]: ${picked}`)
    } else {
      note(`${tier} is the level the walkthrough already offers; choosing it costs no press`)
    }

    /* Both routes pass through the permission question: the level is the one
       thing setup will not let you decline. "Skip the rest for now" is offered
       on the QUESTION steps that follow it (src/views/setup.js actionsMarkup),
       not on this screen -- a first draft of this harness looked for it here,
       found nothing, and was one edit away from reporting the product's own
       skip control as missing. */
    const continued = await clickVisible('[data-setup-continue]')
    check(`${tier}/${route}: the permission question continues`, continued === 'clicked', `${continued}`)

    const atFolder = await until('the folder question',
      `document.querySelector('[data-setup-section]')?.innerText.includes('Which folder')`)
    check(`${tier}/${route}: it reaches the folder question`, atFolder)

    if (route === 'skip') {
      const skipped = await clickVisible('[data-setup-skip]')
      check(`${tier}/skip: the remaining questions can be skipped, as the screen offers`,
        skipped === 'clicked', `[data-setup-skip]: ${skipped}`)
    } else {
      await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
      const nextFrom = async label => {
        const outcome = await clickLastVisible('[data-setup-next]')
        check(`${tier}/walkthrough: ${label}`, outcome === 'clicked', outcome)
        return outcome
      }
      await nextFrom('the folder step moves on')

      const atAccount = await until('the sign-in step',
        `document.querySelector('[data-setup-section]')?.innerText.includes('Who is using this copy') || document.querySelector('[data-setup-section]')?.innerText.includes('Signed in as')`)
      check(`${tier}/walkthrough: it reaches the sign-in step`, atAccount)
      await nextFrom('a person can carry on without an account')

      const atAutonomy = await until('the autonomy question',
        `document.querySelector('[data-setup-section]')?.innerText.includes('without asking')`)
      check(`${tier}/walkthrough: it reaches the autonomy question`, atAutonomy)
      /* `assisted` is the MIDDLE answer of three, not the most permissive. The
         cautious answer `observe` is measured as its own route below. */
      const chose = await clickVisible('[data-setup-set="autonomy"][data-setup-value="assisted"]')
      check(`${tier}/walkthrough: the middle autonomy answer can be chosen`, chose === 'clicked', chose)
      const toReview = await clickVisible('[data-setup-next="review"]')
      check(`${tier}/walkthrough: it reaches the review`, toReview === 'clicked', toReview)
      await until('the review',
        `document.querySelector('[data-setup-section]')?.innerText.includes('what those answers set')`)
      const finished = await clickVisible('[data-setup-next="finish"]')
      check(`${tier}/walkthrough: the review can be accepted`, finished === 'clicked', finished)
    }

    const intoApp = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 120)
    check(`${tier}/${route}: setup ends in the app`, intoApp, `hash=${await evaluate('location.hash')}`)
    const clicksThroughSetup = clicked()
    note(`clicks to get through first-run setup: ${clicksThroughSetup}`)
    await delay(900)

    /* ---------- and now the same two presses the seeded suite measures ---------- */
    const toComputers = await clickVisible('#nav-next')
    check(`${tier}/${route}: the forward chevron reaches the computers page`,
      toComputers === 'clicked', `#nav-next: ${toComputers}`)
    const atComputers = await until('the computers page', `document.body.dataset.route === 'computers'`)
    check(`${tier}/${route}: the computers page draws`, atComputers)
    await delay(1400)

    const nodes = await evaluate(`document.querySelectorAll('.computers .static-tree-node').length`)
    check(`${tier}/${route}: a true first launch draws this computer on the fleet page`,
      nodes >= 1, `tree nodes on screen = ${nodes}`)

    const opened = await clickVisible('.computers .graph-open-btn')
    check(`${tier}/${route}: the door into the agent page is visible and can be pressed`,
      opened === 'clicked', `.graph-open-btn: ${opened}`)
    const arrived = await until('the agent detail page', `Boolean(document.querySelector('.agentv'))`)
    await delay(1200)
    const detail = await evaluate(SESSION_PROBE)

    /* ================= THE ANSWER THE PROJECT HAS BEEN ARGUING ABOUT ================= */
    check(`${tier}/${route}: THE AGENT PAGE IS REACHABLE FROM A TRUE FIRST LAUNCH`,
      arrived && detail.agentVisible, `hash=${detail.hash} agentv=${detail.agentVisible}`)
    check(`${tier}/${route}: and it is this machine's own agent, not a demonstration`,
      detail.liveMode === 'live', `data-live-mode=${JSON.stringify(detail.liveMode)}`)
    const totalClicks = clicked()
    note(`TOTAL CLICKS from first paint to the agent page: ${totalClicks} (${clicksThroughSetup} of them are first-run setup)`)

    /* ---------- reaching the page is not the same as being able to use it ----------
       The owner's requirement is running a fleet FROM this software, and the
       control that starts an agent is fenced by BOTH a live page and the
       `agent-session` write flag. Which route the person took decides whether
       that flag is on, so this is REPORTED for both and asserted only where the
       product intends it. */
    note(`mc.write.agent-session = ${JSON.stringify(detail.agentSessionFlag)}`)
    note(`agent-session surface present=${detail.surfacePresent} visible=${detail.surfaceVisible}; ` +
      `Start present=${detail.startPresent} visible=${detail.startVisible} disabled=${detail.startDisabled}`)
    note(`session status row: ${JSON.stringify(detail.statusText.slice(0, 160))}`)
    if (route === 'walkthrough') {
      /* Answering the questions with the MIDDLE autonomy answer switches
         agent-session on at every tier (setup-profile.js: AUTONOMY_WRITE_FLAGS
         .assisted, and every TIER_CEILINGS entry permits it). So on this route
         the run control must actually be on the page. */
      check(`${tier}/walkthrough: the control that RUNS an agent is on the page it reached`,
        detail.surfaceVisible && detail.startPresent && detail.startVisible,
        `surface=${detail.surfaceVisible} start=${detail.startVisible}`)
    } else {
      /* Skipping applies nothing, deliberately. The page must still be reachable
         -- asserted above -- and the run control must be ABSENT rather than
         present-and-dead, because a dead control is the defect this whole suite
         was written to refuse. */
      check(`${tier}/skip: skipping the questions leaves no dead run control behind`,
        !detail.startPresent, `Start present=${detail.startPresent}`)
    }

    return checks
  } finally {
    await app.teardown()
  }
}

async function main() {
  const offenders = auditSelf()
  if (offenders.length) {
    console.error('This suite assigns location.hash outside the tagged state check, so its')
    console.error('reachability claims are not reachability claims. Offending lines:')
    for (const { line, at } of offenders) console.error(`  ${at}: ${line.trim()}`)
    process.exitCode = 1
    return
  }
  console.log('self-audit ok: navigation for every reachability check is by click\n')

  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-route-'))
  let failures = 0
  let unmeasurable = null
  try {
    console.log(`staging a packaged copy from ${RELEASE}`)
    const executable = await stage(scratch)
    console.log(`staged: ${executable}`)
    /* A measurement that does not name the build it measured is a number
       waiting to be quoted against a different tree. */
    console.log(`measuring: dist/ and shell/ as they are in ${REPO_ROOT} right now, in the binary from ${RELEASE}\n`)
    for (const tier of TIERS) {
      console.log(`--- permission level: ${tier} ---`)
      let checks = null
      for (let attempt = 1; attempt <= ATTEMPTS && !checks; attempt += 1) {
        try {
          checks = await drive(executable, scratch, tier, attempt)
        } catch (error) {
          if (!(error instanceof HarnessError) || attempt === ATTEMPTS) throw error
          console.log(`  ..    could not attach on attempt ${attempt} of ${ATTEMPTS}: ${error.message}`)
          console.log('  ..    retrying on a clean profile; nothing above is a statement about the product')
        }
      }
      failures += checks.filter(entry => !entry.ok).length
      console.log('')
    }

    /* ---------- and the same question asked without the seed ---------- */
    for (const tier of TIERS) {
      for (const route of ['walkthrough', 'skip']) {
        console.log(`--- TRUE FIRST LAUNCH, nothing seeded: ${tier}, ${route} ---`)
        let checks = null
        for (let attempt = 1; attempt <= ATTEMPTS && !checks; attempt += 1) {
          try {
            checks = await driveFirstLaunch(executable, scratch, tier, route, attempt)
          } catch (error) {
            if (!(error instanceof HarnessError) || attempt === ATTEMPTS) throw error
            console.log(`  ..    could not attach on attempt ${attempt} of ${ATTEMPTS}: ${error.message}`)
            console.log('  ..    retrying on a clean profile; nothing above is a statement about the product')
          }
        }
        failures += checks.filter(entry => !entry.ok).length
        console.log('')
      }
    }
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    unmeasurable = error
  } finally {
    /* CLEANUP MUST NOT BE ABLE TO FAIL THE RUN.
       Windows holds the staged Electron's DLLs for a moment after the process
       exits, so `rm -rf` on scratch throws EPERM on d3dcompiler_47.dll. The
       first version of this let that escape the finally: 45 of 45 checks passed
       and the suite still exited 1, which is the same class of lie as reading an
       exit code through a pipe -- a green run reported as a failure, and next
       time a red run would be indistinguishable from it. Retry briefly, then say
       what was left behind and carry on; the verdict below is the checks. */
    if (KEEP) {
      console.log(`scratch kept at ${scratch}`)
    } else {
      let removed = false
      for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
        try { rmSync(scratch, { recursive: true, force: true }); removed = true } catch { await delay(600) }
      }
      if (!removed) console.log(`(could not remove the scratch copy at ${scratch}; it is safe to delete)`)
    }
  }
  /* THREE OUTCOMES, THREE EXIT CODES. The middle one is the reason this block
     exists: a run that never attached has measured NOTHING, and saying so with
     the same exit 1 a red check uses is how "the harness could not start the
     app" became "the customer cannot reach the agent page" on this board. */
  if (unmeasurable) {
    console.error('')
    console.error('=================== NO VERDICT: THE HARNESS COULD NOT MEASURE ===================')
    console.error(unmeasurable.message)
    console.error('')
    console.error('THIS SAYS NOTHING ABOUT WHETHER THE AGENT PAGE IS REACHABLE. It says this')
    console.error('probe could not attach to the app. Do not quote this run, or its exit code,')
    console.error('as evidence either way. Exit 2 is reserved for exactly this and never used')
    console.error('for a failed check.')
    console.error('================================================================================')
    process.exitCode = 2
    return
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

/* Run only when this file IS the command. The self-audit predicate above is
   exported so a test can point both forms of `location.hash` at it, and an
   unguarded `await main()` would have made importing it launch three packaged
   Electron windows instead. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  await main()
}
