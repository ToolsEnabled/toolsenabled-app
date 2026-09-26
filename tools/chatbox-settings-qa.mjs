#!/usr/bin/env node

// THE TWO SETTINGS ON THE FIRST SETTINGS PAGE, DRIVEN IN A REAL PACKAGED BUILD.
//
// WHY THIS EXISTS ALONGSIDE tools/test/chatbox-feed.test.mjs.
//
// That suite proves the DECISION: given these two settings and this machine,
// what the box is allowed to contain, walked over every combination. What it
// cannot see is whether a person can reach the controls, whether clicking one
// reaches the setting, and whether the box on the glass re-reads it. Source
// text cannot see reachability -- planting `return ''` at the top of a markup
// builder, with the real builder still below it, renders the settings section
// EMPTY while every source assertion in that suite stays true. Three surfaces
// in this product have shipped fully built and fully tested with nothing routed
// to them; this file is the instrument that would have caught all three.
//
// So this launches the packaged application, clicks the real controls with a
// real pointer event, walks back to the home screen, and reads the words in the
// box. The claim it supports is exactly one sentence: changing the setting
// changes what the chat box shows.
//
// RUN IT:
//   node tools/chatbox-settings-qa.mjs
//   node tools/chatbox-settings-qa.mjs --release <dir>   (borrow another build)
//   node tools/chatbox-settings-qa.mjs --keep            (leave the scratch copy)
//
// ISOLATION, and every mechanism is the one it is for a measured reason:
//   staging      It borrows the packaged binary and the capability payload from
//                an existing build, swaps in the current dist/ and shell/, and
//                writes NOTHING under release/. electron-builder is deliberately
//                not run: three lanes had node_modules damaged by it writing
//                through this worktree's junction in a single day, and six other
//                ToolsEnabled windows are open on this machine right now.
//   --user-data-dir   Electron resolves userData through the Windows known-folder
//                API, not the environment, and this switch also changes the
//                single-instance lock key -- so this runs happily beside every
//                copy somebody else is using.
//   LOCALAPPDATA / USERPROFILE   our own code reads these, so a machine record
//                and any created folder land in scratch.
// ELECTRON_RUN_AS_NODE is stripped: with it set the binary runs headless as
// Node, exits 0, and is indistinguishable from a crash.
//
// IT KILLS ONLY WHAT IT STARTED, matched by executable path under its own
// scratch copy.

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { UNMEASURABLE_MARK } from './machine-steadiness.mjs'
import { machineRecordProductDirectory, userDataFor } from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

/* ---------- stage a real packaged copy ---------- */
async function stage(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  /* THE EXECUTABLE IS DISCOVERED, NOT NAMED. This product is being renamed
     while it is being built, and a rename sweep walked through this file and
     changed a hardcoded executable name to one that did not exist in the build
     it points at -- three runs died on it. The staged copy has exactly one
     top-level program in it, and that is the one to start. */
  /* The rule moved to tools/lib/packaged-platform.mjs, which keeps exactly the
     discovery this comment asks for on Windows and adds the ELF answer this
     one had no way to give: `.exe` is not a shape a Linux candidate has. */
  return appExecutable(app)
}

/* ---------- a bounded CDP client ----------
   The port is asked for rather than guessed: a fixed one was measured at one
   failure in four consecutive runs here, because the previous run's Electron had
   not released it yet, and "the app never painted" is indistinguishable from a
   real startup crash. An instrument that is flaky one run in four does not
   report a defect, it reports a coin toss. */
/* Wait until a TCP port is genuinely refusing connections again.
 *
 * THIS IS NOT PATIENCE, IT IS ISOLATING ONE VARIABLE. The application serves
 * itself from a loopback port it picks at launch, advancing to the next
 * candidate when its first choice is still held. A relaunch that happens while
 * the previous instance is still releasing therefore lands on a DIFFERENT
 * ORIGIN, and everything a browser keeps is keyed by origin -- so the second
 * window opens with none of the first window's settings, and a persistence
 * check reads that as the setting failing to persist. Measured here: first run
 * on 4601, relaunch on 4602, every stored preference gone. Waiting for the port
 * makes this check measure persistence rather than port allocation, and the
 * check still prints both addresses so the other failure remains visible if it
 * ever happens for real. */
async function waitForPortFree(port, budgetMs = 45_000) {
  const net = await import('node:net')
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const inUse = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
      socket.setTimeout(1500, () => { socket.destroy(); resolve(false) })
    })
    if (!inUse) return true
    await delay(500)
  }
  return false
}

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
    async open() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered; this is a startup failure, not a slow paint`)
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`)
          const targets = await response.json()
          /* THE PAGE THIS APP SERVES, not merely the first page the debugger
             lists. The shell starts its own local server and loads the window
             from it, and for the first moment of a launch the only target is a
             blank document with no origin -- attaching to that one and reading
             localStorage fails with a security error that reads exactly like a
             product defect. Measured here on the first run of this harness. */
          const page = targets.find(entry => entry.type === 'page'
            && entry.webSocketDebuggerUrl
            && /^https?:/.test(String(entry.url)))
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
            return
          }
        } catch { /* not listening yet */ }
        await delay(500)
      }
      throw new Error('no debuggable page appeared within 30s, and the app is still running')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* Read what is actually in the box. Taken from rendered nodes, and every claim
   about what a person can READ is gated on a real box: text in the DOM is not
   text on the glass, and a stylesheet that hides a slot leaves every string
   exactly where a textContent read finds it. */
const READ_BOX = `(() => {
  const home = document.querySelector('.home')
  if (!home) return { present: false }
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'
  }
  const turns = [...home.querySelectorAll('.log-turns .turn')].filter(shown)
  return {
    present: true,
    mode: home.dataset.mode,
    title: text(home.querySelector('[data-panel-title]')),
    speakers: turns.map(node => text(node.querySelector('.turn-who'))),
    turnCount: turns.length,
    turnText: turns.map(node => text(node.querySelector('.turn-text'))).join(' \\u241F '),
    runRows: [...home.querySelectorAll('.log-runs .home-run')].filter(shown).length,
    notices: [...home.querySelectorAll('.log-notices .projection-state')].filter(shown).map(node => text(node.querySelector('strong'))),
    noticeBodies: [...home.querySelectorAll('.log-notices .projection-state')].filter(shown).map(node => text(node)),
    footer: home.querySelector('[data-panel-foot]')?.hidden ? '' : text(home.querySelector('[data-panel-foot]')),
    logText: text(home.querySelector('.session-log')),
  }
})()`

async function drive(executable, scratch) {
  const port = await freePort()
  const profile = path.join(scratch, 'profile')
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')

  /* THE FIRST-RUN QUESTION IS NOT THIS HARNESS'S SUBJECT, so it is answered
     before the window opens rather than clicked through. Not for speed: the
     router sends every route back to that question until a level is recorded,
     so a walkthrough click that lands while the screen is busy leaves this
     instrument stuck on a screen it is not testing and reports it as the chat
     box failing to appear. That is a manufactured kill, and it happened here
     three times before this seed replaced it. tools/setup-walkthrough-qa.mjs
     owns the walkthrough itself.
     Written with the ENGINE'S OWN writer, into this run's scratch services
     root, so what the app reads back is a record the engine produced. */
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const machineRecord = require_(path.join(REPO_ROOT, 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const workspaceRoot = path.join(profile, 'home', productDirectory)
  mkdirSync(workspaceRoot, { recursive: true })
  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier: 'guided',
    installRoot: path.dirname(executable),
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspaceRoot],
  }), { servicesRoot })

  const launch = () => spawn(executable, [
    `--user-data-dir=${userDataFor(profile)}`,
    `--remote-debugging-port=${port}`,
    /* windowsHide kills the console flash only; the BrowserWindow is hidden by
       MC_SMOKE_HEADLESS=1 in the inherited environment (shell/window-options.cjs). */
  ], { env: environment, stdio: 'ignore', windowsHide: true })

  /* CLOSE IT THE WAY A PERSON DOES, and only then force it.
   *
   * A forced kill is not a close: the browser engine writes what a page stores
   * to disk on its own schedule, and killing the process throws away whatever
   * had not been flushed. Measured here -- with a forced kill the relaunched
   * window came back with NOTHING stored, at the same address, which reads
   * exactly like a setting that does not persist and is in fact the harness
   * destroying the evidence. The force path stays as the fallback, because a
   * window that will not close must not leave a process behind. */
  const stop = async (child, session = null) => {
    if (session) {
      try {
        await session.send('Runtime.evaluate', { expression: 'window.close()' })
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (child.exitCode !== null) break
          await delay(250)
        }
      } catch { /* the page is already gone */ }
    }
    try {
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${path.basename(executable)}'" | Where-Object { $_.ExecutablePath -like '${path.join(scratch, 'app').replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', windowsHide: true })
    } catch { /* nothing of ours left to stop */ }
    try { child.kill() } catch { /* already gone */ }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (child.exitCode !== null) break
      await delay(250)
    }
    /* The debugger port has to be genuinely released before the next launch, or
       the relaunch reads as a startup crash. */
    await delay(1200)
  }

  /* WAIT FOR THE FIRST ADDRESS IN THE RANGE BEFORE STARTING AT ALL.
   *
   * The shell serves itself from the first free port in a fixed range, and
   * everything a browser stores is keyed by ORIGIN. So a run that starts while
   * the range's first port is briefly held lands one port along, the relaunch
   * later in this file lands back on the first, and the second window opens
   * with none of the settings the first one saved. Measured: one run in five
   * failed exactly that way, reporting a persistence defect that was an address
   * change. Starting from a known address makes both launches use the same one.
   * If it never frees this run still goes ahead and the relaunch check reports
   * the addresses it actually saw. */
  await waitForPortFree(machineRecord.SHELL_PORT_RANGE.first, 30_000)

  let child = launch()
  let session = createSession(port, child)
  try {
    await session.open()
    await session.send('Runtime.enable')

    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const until = async (label, expression, attempts = 60) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return true
        await delay(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }
    const box = () => evaluate(READ_BOX)
    const settleBox = async (label, predicate, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const reading = await box()
        if (reading?.present && predicate(reading)) return reading
        await delay(250)
      }
      return box().then(reading => {
        console.log(`      (${label} never settled; last reading ${JSON.stringify(reading)})`)
        return reading
      })
    }

    /* ---------- past the first-run question, the way a person goes ---------- */
    await until('the window', 'document.readyState === "complete"')
    /* Anything the page throws is captured, so a view that fails to mount is
       reported as the exception it is rather than as a screen that never
       appeared. A silent throw and a slow paint look identical from out here. */
    await evaluate('window.__mcQaErrors = window.__mcQaErrors || []; window.addEventListener("error", e => window.__mcQaErrors.push(String(e.message))); window.addEventListener("unhandledrejection", e => window.__mcQaErrors.push("rejected: " + String(e.reason && e.reason.message || e.reason))); true')
    check('the seeded level is read back, so the app opens on the product',
      await evaluate('location.hash === "#/"'),
      await evaluate('location.hash'))
    await until('the home screen', '!!document.querySelector(".home") && location.hash !== "#/setup"')

    /* ---------- give the box a conversation to filter ----------
       The demonstration is the one conversation available on a computer with
       nothing connected, and its cast is a real set of named agents, so it is
       what makes "which agents" testable here at all. Chosen through the same
       stored preference the Settings control writes, then the view is remounted
       the way the router remounts it. */
    await evaluate('localStorage.setItem("mc.example", "on"); location.hash = "#/settings"; location.hash = "#/"')
    const first = await settleBox('the demonstration', reading => reading.turnCount > 0)
    check('the box shows a conversation to begin with', first.turnCount > 0, `${first.turnCount} turns`)
    const speakersAtStart = [...new Set(first.speakers.filter(Boolean))]
    check('and more than one agent is talking in it', speakersAtStart.length > 1, JSON.stringify(speakersAtStart))
    check('and the run record is not mixed into a box badged as an example', first.runRows === 0)

    /* ---------- the controls are on the first settings page ---------- */
    await evaluate('location.hash = "#/settings?category=home-screen"')
    await until('the settings page', 'document.querySelector(".settings-page") !== null')
    await until('the first section', 'document.querySelector("[data-chatbox-settings]") !== null')

    /* THIS BOX HAS ITS OWN PAGE IN SETTINGS, and the three questions worth
       asking about it are that the rail offers it, that it is in the first
       group, and that choosing it draws that category alone. The page used to
       draw all twelve categories at once, so the same questions were asked as
       "which is first"; they are asked as "which arrives" now. */
    const railFirstGroup = await evaluate('document.querySelector(".settings-rail [data-rail-group]")?.textContent.trim()')
    check('the first group on the settings page starts with this box',
      String(railFirstGroup).startsWith('Start here'), String(railFirstGroup))
    const railCategories = JSON.parse(await evaluate(
      'JSON.stringify([...document.querySelectorAll(".settings-rail button[data-category]")].map(node => node.dataset.category))'))
    check('the rail offers this box a category of its own',
      railCategories.includes('Home screen'), railCategories.join(', '))
    check('and it is in the first group, which holds the first four categories',
      railCategories.slice(0, 4).includes('Home screen'), railCategories.slice(0, 4).join(', '))
    const drawn = JSON.parse(await evaluate(
      'JSON.stringify([...document.querySelectorAll(".settings-sections .settings-section")].map(node => node.dataset.settingsSection))'))
    check('choosing it draws that category and no other', drawn.length === 1 && drawn[0] === 'Home screen',
      JSON.stringify(drawn))

    const rows = await evaluate('[...document.querySelectorAll("[data-chatbox-settings] [data-chatbox-row]")].map(node => node.dataset.chatboxRow).join()')
    check('both controls are present, and so is the agent list', rows === 'agents,agent-list,runs', String(rows))

    await until('the discovered agents', 'document.querySelectorAll("[data-chatbox-agent]").length > 0')
    const listed = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("[data-chatbox-agent]")].map(node => node.dataset.chatboxAgent))'))
    check('the agent list is discovered rather than written down', listed.length > 1, JSON.stringify(listed))

    /* ---------- CONTROL ONE: which agents' context appears ---------- */
    const target = listed.find(id => first.speakers.some(label => label.includes(id))) || listed[0]
    const linesFromTarget = first.turnText.includes(target)
    await evaluate(`document.querySelector('[data-chatbox-agent="${target}"]').click()`)
    check('unticking an agent is recorded', JSON.parse(await evaluate('localStorage.getItem("mc.chat.agents") || "null"'))?.includes(target) === false)

    await evaluate('location.hash = "#/"')
    const narrowed = await settleBox('the narrowed box', reading => reading.turnCount !== first.turnCount || !reading.speakers.some(label => label.includes(target)))
    check('THE BOX CHANGED: the unticked agent is gone from it',
      !narrowed.speakers.some(label => label.includes(target)) && narrowed.turnCount < first.turnCount,
      `${first.turnCount} turns before, ${narrowed.turnCount} after; ${JSON.stringify([...new Set(narrowed.speakers.filter(Boolean))])}`)
    check('and every other agent is still there',
      speakersAtStart.filter(label => !label.includes(target)).every(label => narrowed.speakers.includes(label)),
      JSON.stringify([...new Set(narrowed.speakers.filter(Boolean))]))
    check('and the box says how many agents it is holding back', /kept out of this box/i.test(narrowed.footer), narrowed.footer)
    void linesFromTarget

    /* ---------- CONTROL TWO: runs too, not at all, or only ---------- */
    await evaluate('location.hash = "#/settings?category=home-screen"')
    await until('the runs control', 'document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="only"]\') !== null')
    await evaluate('document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="only"]\').click()')
    check('choosing runs-only is recorded', await evaluate('localStorage.getItem("mc.chat.runs")') === 'only')

    await evaluate('location.hash = "#/"')
    /* SETTLE ON THE WHOLE REPAINT, NOT ON ITS FIRST HALF. This settled on
       turnCount alone and then read the title, and on the 2026-08-19 final
       confirming suite -- machine churning under the whole run -- the read
       landed between the log emptying and the header landing: title "" over a
       box that titles itself correctly a moment later (src/local-activity.js,
       untouched by the window under test; this same check was green solo and
       in the 12:06 suite the same day). The equality below is unchanged and
       exact; a box that genuinely loses its title still exhausts the settle
       and fails with whatever was really on the glass. */
    const runsOnly = await settleBox('the runs-only box', reading => reading.turnCount === 0 && reading.title.length > 0)
    check('THE BOX CHANGED: with runs only, no conversation is left in it', runsOnly.turnCount === 0, `${runsOnly.turnCount} turns`)
    /* The box is still badged as the example here (mc.example is on), and the
       example's list is the example fleet's, not this computer's -- so the
       title says so beside the badge rather than borrowing the live one
       (src/local-activity.js panelTitle). The live box reads "Activity on
       this computer". */
    check('and the box says what it is showing instead', runsOnly.title === 'Activity in this example fleet', runsOnly.title)

    /* Hiding the runs on a computer whose conversation is also switched off is a
       box the person asked to be empty. It has to SAY that, with the way back,
       rather than quietly putting one of the halves back. */
    await evaluate('location.hash = "#/settings?category=home-screen"')
    await until('the hide control', 'document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="hidden"]\') !== null')
    await evaluate('document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="hidden"]\').click()')
    await evaluate('localStorage.removeItem("mc.example"); location.hash = "#/settings"; location.hash = "#/"')
    const nothing = await settleBox('the empty box', reading => reading.notices.length > 0)
    check('a box asked to show nothing says so instead of refilling itself',
      nothing.turnCount === 0 && nothing.runRows === 0 && /set to show nothing/i.test(nothing.notices.join()),
      JSON.stringify(nothing.notices))
    check('and it offers the way back to the choice',
      await evaluate('!!document.querySelector(".log-notices .home-next")'))

    /* ---------- the Settings -> Setup section, which was rendered and inert ----------
       Measured on the glass rather than argued from the source: its controller
       builds a click handler that only `bind` attaches, and nothing called it.
       This is the check that says whether that is still true.

       IT RUNS BEFORE the state this harness carries across a relaunch is set
       up, and that order is load-bearing. Moving the autonomy answer re-applies
       the whole first-run profile, which legitimately resets the choice of what
       the screens read -- so doing it afterwards silently undid this harness's
       own arrangements and produced a persistence failure that was mine, not
       the product's. Two runs were spent finding that out. */
    await evaluate('location.hash = "#/settings?category=setup"')
    await until('the setup section', 'document.querySelector("[data-setup-profile-system]") !== null')
    const beforeAutonomy = await evaluate('document.querySelector(\'[data-setup-profile-set="autonomy"][aria-pressed="true"]\')?.dataset.setupProfileValue || ""')
    /* Clicked more than once on purpose, and this was measured rather than
       assumed: that section reads this computer's configuration after it first
       renders and then REPLACES its own markup with the answer, so a click that
       lands in the gap hits a node that is about to be thrown away and does
       nothing. Two runs in six failed here before this loop, and a check that
       fails one run in three does not report a defect, it reports a coin toss.
       The retry cannot hide a genuinely dead control: an unbound handler never
       responds however many times it is clicked. */
    let afterAutonomy = beforeAutonomy
    for (let attempt = 0; attempt < 10 && afterAutonomy !== 'assisted'; attempt += 1) {
      await evaluate('document.querySelector(\'[data-setup-profile-set="autonomy"][data-setup-profile-value="assisted"]\')?.click()')
      await delay(400)
      afterAutonomy = await evaluate('document.querySelector(\'[data-setup-profile-set="autonomy"][aria-pressed="true"]\')?.dataset.setupProfileValue || ""')
    }
    check('a control in Settings -> Setup does something when it is clicked',
      beforeAutonomy !== 'assisted' && afterAutonomy === 'assisted',
      `${beforeAutonomy} then ${afterAutonomy}`)

    /* ---------- back to a state worth carrying across a relaunch ---------- */
    await evaluate('localStorage.setItem("mc.example", "on"); location.hash = "#/"')
    await until('the box again', '!!document.querySelector(".home")')
    await evaluate('location.hash = "#/settings?category=home-screen"')
    await until('the runs control again', 'document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="with"]\') !== null')
    await evaluate('document.querySelector(\'[data-chatbox-set="runs"][data-chatbox-value="with"]\').click()')
    const keptSelection = await evaluate('localStorage.getItem("mc.chat.agents")')
    const origin = await evaluate('location.origin')

    /* ---------- the choice survives closing the program ---------- */
    await stop(child, session)
    const shellPort = Number(new URL(origin).port)
    const portReleased = await waitForPortFree(shellPort)
    check('the closed window released the address it was serving from', portReleased, `${origin}`)
    child = launch()
    session.close()
    session = createSession(port, child)
    await session.open()
    await session.send('Runtime.enable')
    const evaluate2 = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    /* THE BLANK PAGE PASSES A HASH-ONLY CONDITION. location.hash on the
       pre-load about:blank document is "", so waiting for hash "#/"-or-"" is
       satisfied before the shell has served anything -- and localStorage on
       that null-origin document does not answer, it THROWS SecurityError,
       which is how the 2026-08-19 final confirming suite died here under
       port contention ("the relaunch moved address: ...4601 then null").
       Nothing below is measurable before the app's own http(s) document
       exists, so that is what is waited for. If it never arrives, the
       machine withheld the relaunch -- another process squatting the range,
       a shell that could not serve -- and that is named with the suite's own
       unmeasurable marker rather than dressed up as a product failure. The
       two checks that matter (the choice survives; the box comes back
       narrowed) are unchanged and still fail loudly whenever they run. */
    let relaunchedIntoApp = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate2('location.protocol.startsWith("http") && (location.hash === "#/" || location.hash === "")')) { relaunchedIntoApp = true; break }
      await delay(250)
    }
    if (!relaunchedIntoApp) {
      const parked = await evaluate2('JSON.stringify({ href: location.href, origin: location.origin })').catch(() => 'unreadable')
      console.log(`
${UNMEASURABLE_MARK} the relaunched window never reached the application's own page within 20s (${parked}); the surviving-setting checks were not measured this run.`)
      const failedSoFar = checks.filter(entry => !entry.ok)
      const notExercised = [
        'the choice survives a relaunch',
        'and the box comes back narrowed rather than full',
      ]
      for (const name of notExercised) console.log(`  NOT EXERCISED: ${name}  -- the relaunched window did not reach an http document`)
      console.log(`
${checks.length - failedSoFar.length}/${checks.length + notExercised.length} checks passed before the relaunch became unmeasurable`)
      /* In the suite, the shared marker above classifies this as INCONCLUSIVE.
         Standalone, false is equally load-bearing: an unmeasured run must never
         reach the PASS footer or exit zero merely because earlier checks passed. */
      return false
    }
    const reopenedOrigin = await evaluate2('location.origin')
    /* THE ADDRESS IS DIAGNOSTIC DETAIL, NOT A CHECK. It used to be asserted --
       "the relaunched window came back at the same address, which is what every
       stored setting is keyed to" -- and that assertion has been RETIRED
       because the contract it names is retired. Settings are no longer keyed to
       the origin: dist/durable-storage.js carries them across a port change and
       tools/prefs-origin-proof.mjs is the gate that proves it, by launching the
       packaged application twice with the first port deliberately held.
       Measured on this tree on 2026-08-11: the relaunch landed on 4602 instead
       of 4601 because a concurrent lane held the port, that assertion went red,
       and "the choice survives a relaunch" -- the check that is actually about
       this box -- PASSED in the same run. An instrument asserting a retired
       contract manufactures a kill, and this one manufactured it out of nothing
       worse than another process being alive at the same time. So the address
       is still printed, and still attached to the surviving-setting check as
       the first thing that tells you which failure you are looking at. */
    if (reopenedOrigin !== origin) {
      console.log(`  note  the relaunch moved address: ${origin} then ${reopenedOrigin} ` +
        '(expected when another process holds the port; the next check is what decides whether that mattered)')
    }
    const survived = await evaluate2('localStorage.getItem("mc.chat.agents")')
    /* The address is part of the evidence. What a browser keeps is keyed by
       ORIGIN, and this application serves itself from a port it picks at
       launch, so a relaunch that lands on a different port would lose every
       setting in the product and not only these two. If this check ever fails,
       the address is the first thing that tells you which of those two
       failures it is. */
    check('the choice survives a relaunch', survived === keptSelection && survived !== null,
      `stored ${keptSelection}, read back ${survived}, at ${await evaluate2('location.origin')} (was ${origin})`)
    let reopened = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      reopened = await evaluate2(READ_BOX)
      if (reopened?.present && reopened.turnCount > 0) break
      await delay(250)
    }
    const reopenedState = await evaluate2('JSON.stringify({ hash: location.hash, example: localStorage.getItem("mc.example"), runs: localStorage.getItem("mc.chat.runs"), mode: document.querySelector(".home")?.dataset.mode })')
    check('and the box comes back narrowed rather than full',
      reopened?.present && reopened.turnCount > 0 && !reopened.speakers.some(label => label.includes(target)),
      `${reopened?.turnCount} turns, ${JSON.stringify([...new Set((reopened?.speakers || []).filter(Boolean))])}, ${reopenedState}`)
  } catch (error) {
    /* Say WHERE it broke, not only that it did. A harness that reports a bare
       exception makes an instrument fault and a product fault read the same. */
    let where = ''
    try {
      const packet = await session.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ href: location.href, body: document.body.className, stage: (document.getElementById("stage")?.innerHTML || "").slice(0, 300), failures: window.__mcQaErrors || [] })',
        returnByValue: true,
      })
      where = ` at ${packet.result?.result?.value}`
    } catch { /* the page is gone too */ }
    check('the check ran to completion', false, `${error.message}${where}`)
  } finally {
    session.close()
    await stop(child)
  }

  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  return failed.length === 0
}

const scratch = mkdtempSync(path.join(tmpdir(), 'mc-chatbox-qa-'))
let ok = false
try {
  const executable = await stage(scratch)
  console.log(`\nchat box settings, driven in ${executable}:`)
  ok = await drive(executable, scratch)
} catch (error) {
  console.error(error)
  process.exitCode = 2
} finally {
  if (!KEEP) {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }) } catch { /* a locked scratch copy is not a product failure */ }
  }
}
if (process.exitCode !== 2) {
  console.log(ok ? '\nchat box settings: PASS' : '\nchat box settings: FAIL')
  process.exit(ok ? 0 : 1)
}
