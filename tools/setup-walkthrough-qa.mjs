#!/usr/bin/env node

// THE FIRST-RUN WALKTHROUGH, DRIVEN IN A REAL PACKAGED BUILD.
//
// WHY THIS EXISTS AND WHY IT CANNOT BE A `node --test` SUITE.
//
// src/views/setup.js imports three stylesheets and builds DOM, so no node test
// can call it. Everything a unit suite can say about it is therefore a statement
// about its SOURCE TEXT -- and source text cannot see reachability. Measured,
// not argued: planting `return ''` at the top of a markup builder, with the real
// builder still below it, renders the screen EMPTY while every source assertion
// stays true. The import is still there, the dispatcher still says
// `return accountMarkup()`, the step is still in STEPS. Dead code matches a text
// search exactly as well as live code does.
//
// Two lanes hit that independently in one session. The residual each was left
// with was identical: an early return inside a wrapper in this file, and the
// wrapper ceasing to delegate. Both were invisible to every cheap instrument and
// both are killed by this one, because it renders the window and reads the words
// on the screen.
//
// It also covers the two things a first run has to get right that no unit test
// observes: that a FRESH machine opens on the question at all, and that what the
// walkthrough writes is read back by the ENGINE'S OWN reader rather than by the
// code that wrote it.
//
// RUN IT:
//   node tools/setup-walkthrough-qa.mjs                 (both paths)
//   node tools/setup-walkthrough-qa.mjs --mode finish   (one path)
//
// It requires an existing release/win-unpacked to borrow the Electron binary and
// the capability payload from; it never writes there. Build one with `npm run
// dist` first, or point at another with --release <dir>.
//
// ISOLATION, and each mechanism is the one it is for a measured reason:
//   --user-data-dir   Electron resolves userData through the Windows
//                     known-folder API, NOT the environment. Setting APPDATA
//                     does not isolate it and makes app.getPath('userData')
//                     throw before any window exists, which looks exactly like a
//                     lost single-instance lock. This switch is the supported
//                     override and it changes the lock key too, so this can run
//                     alongside a copy someone else is using.
//   LOCALAPPDATA      resolveServicesRoot() is our own code reading the
//                     environment, so machine.json lands in scratch and the real
//                     one is never touched.
//   USERPROFILE       defaultWorkspacePath(), so Finish creates its folder in
//                     scratch rather than in someone's Documents.
// ELECTRON_RUN_AS_NODE is stripped: with it set the binary runs headless as
// Node, exits 0, and is indistinguishable from a crash.
//
// IT KILLS ONLY WHAT IT STARTED, matched by executable PATH under its own
// scratch copy. Another lane's app, or the owner's, is never touched.

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { resolveMachineServicesRoot } from './lib/qa-services-root.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const MODES = argument('--mode') ? [argument('--mode')] : ['finish', 'skip']
const KEEP = process.argv.includes('--keep')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/* ---------- stage a real packaged copy ----------
 *
 * Deliberately NOT electron-builder. Three lanes had node_modules damaged by
 * electron-builder writing through this worktree's junction in one day, and a
 * shared checkout cannot afford that for a test run. This borrows the built
 * binary and the capability payload, swaps in the current dist/ and shell/, and
 * writes nothing under release/. */
function stage(scratch) {
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
  return asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
    .then(() => path.join(app, 'ToolsEnabled.exe'))
}

/* ---------- a bounded CDP client ---------- */

/* A PORT NOBODY ELSE HOLDS, ASKED FOR RATHER THAN GUESSED.
 *
 * This harness used a fixed debugger port and was measured at ONE FAILURE IN
 * FOUR consecutive runs: the previous run's Electron had not finished releasing
 * the port, so the next instance could not open the debugger and no page ever
 * appeared. The symptom -- "the app exited before it painted" -- is
 * indistinguishable from a real startup crash, which is precisely the reading
 * that cost another lane three false regression reports in this repo. An
 * instrument that is flaky one run in four does not report a defect; it reports
 * a coin toss, and whoever runs it once believes the toss.
 *
 * The OS is asked for a free port instead. Binding zero and reading back the
 * assignment cannot collide with a lingering process or with another lane
 * running this at the same moment. */
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
        /* An exited child is a DIFFERENT fact from a slow one, and conflating
           them is how a startup crash gets read as a timeout and vice versa. */
        if (child.exitCode !== null) {
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered; this is a startup failure, not a slow paint`)
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`)
          const page = (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
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

async function drive(mode, executable, scratch) {
  const port = await freePort()
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }

  const profile = path.join(scratch, `profile-${mode}`)
  mkdirSync(path.join(profile, 'userdata'), { recursive: true })
  const machineRecord = require_(path.join(path.dirname(executable), 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)

  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home inside the scratch profile, ELECTRON_RUN_AS_NODE deleted. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))

  const child = spawn(executable, [
    `--user-data-dir=${path.join(profile, 'userdata')}`,
    `--remote-debugging-port=${port}`,
    /* windowsHide kills the console flash only; the BrowserWindow is hidden by
       MC_SMOKE_HEADLESS=1 in the inherited environment (shell/window-options.cjs). */
  ], { env: environment, stdio: 'ignore', windowsHide: true })

  const session = createSession(port, child)
  try {
    await session.open()
    await session.send('Runtime.enable')

    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const until = async (label, expression, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return
        await delay(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }
    const screen = () => evaluate('document.querySelector("[data-setup-section]")?.innerText || ""')
    const clickLast = selector => evaluate(
      `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (!nodes.length) return false; nodes[nodes.length - 1].click(); return true })()`,
    )

    await until('the setup route', 'location.hash === "#/setup"')
    check('a fresh machine opens on the permission question', true)
    check('a disclosure sits at the point of choice', /will not pretend about/i.test(await screen()))
    check('Continue records the level', await evaluate('!!document.querySelector("[data-setup-continue]")'))
    await evaluate('document.querySelector("[data-setup-continue]").click()')

    await until('the folder question', 'document.querySelector("[data-setup-section]").innerText.includes("Which folder")')
    check('the walkthrough continues to the folder question', true)
    await until('the folder to resolve', 'document.querySelector(".setup-root-path") !== null')
    const suggested = await evaluate('document.querySelector(".setup-root-path").textContent')
    check('the folder it suggests is the person\'s own and is shown to them', suggested.includes(profile))

    /* THE INVARIANT: with questions still open, nothing has been applied. */
    const midFlags = JSON.parse(await evaluate(
      'JSON.stringify(["dispatch","decision","queue","thread-reply","report-read","agent-session"].map(id => localStorage.getItem("mc.write." + id)))',
    ))
    check('no setting is applied while the questions are open', midFlags.every(value => value === null))

    if (mode === 'skip') {
      check('skip is offered', await evaluate('!!document.querySelector("[data-setup-skip]")'))
      await evaluate('document.querySelector("[data-setup-skip]").click()')
      await until('the app', 'location.hash === "#/" || location.hash === ""')
    } else {
      await clickLast('[data-setup-next]')
      /* THE RESIDUAL THIS HARNESS EXISTS FOR. A step that renders empty, or a
         wrapper that stops delegating, is invisible to every source assertion
         and is caught right here by reading what is actually on the screen. */
      await until(
        'the sign-in step',
        'document.querySelector("[data-setup-section]").innerText.includes("Who is using this copy") || document.querySelector("[data-setup-section]").innerText.includes("Signed in as")',
      )
      const account = await screen()
      check('the sign-in step is REACHABLE and renders', /Who is using this copy|Signed in as/i.test(account))
      check('its disclosure survives: the account is local to this computer', /account on this computer/i.test(account))
      /* REWORDED WITH THE COPY, NOT LOOSENED. Google sign-in now exists, so
         "not a login to ... Google" stopped being true and the sentence on
         screen changed. What B14 is actually about -- a Claude or ChatGPT
         SUBSCRIPTION login -- is unchanged, and that is what this reads. */
      check('its disclosure survives: it is not a provider subscription login', /not a login to Claude or ChatGPT/i.test(account))
      /* AND THE SECOND WAY IN IS ON THE SCREEN. It may be offered or it may say
         why it cannot be; what it must never do is be absent without a word. */
      check('the Google option is on the first-run step, offered or explained', /Sign in with Google/i.test(account))
      check('a person can carry on without an account', await evaluate('document.querySelectorAll("[data-setup-next]").length > 0'))

      await clickLast('[data-setup-next]')
      await until('the autonomy question', 'document.querySelector("[data-setup-section]").innerText.includes("without asking")')
      check('the third question sets the switches', true)
      await evaluate('document.querySelector(\'[data-setup-set="autonomy"][data-setup-value="assisted"]\').click()')
      await evaluate('document.querySelector(\'[data-setup-next="review"]\').click()')

      await until('the review', 'document.querySelector("[data-setup-section]").innerText.includes("what those answers set")')
      const review = await screen()
      check('the review shows what was chosen', /Here is what those answers set/i.test(review))
      check('the review states nothing is written yet', /Nothing has been written yet/i.test(review))
      check('the review states what it never asks for', /stay in their own programs/i.test(review))
      check('the beginner level refuses to take over an editor session',
        await evaluate('document.querySelector(\'[data-setup-set="intent:attach"][aria-pressed="true"]\').dataset.setupValue') === 'mirror')

      await evaluate('document.querySelector(\'[data-setup-next="finish"]\').click()')
      await until('the app', 'location.hash === "#/" || location.hash === ""', 60)
    }

    /* ---------- the settings surface, opened for real ---------- */
    /* Each category is its own page, so the Setup section is reached by its own
       address rather than by opening Settings and looking for it. */
    await evaluate('location.hash = "#/settings?category=setup"')
    await until('the settings page', 'document.querySelector(".settings-page") !== null')
    await until('the setup section', 'document.querySelector("[data-setup-profile-system]") !== null', 60)
    const settings = await evaluate('document.querySelector("[data-setup-profile-system]")?.innerText || ""')
    check('the Setup section renders in Settings', settings.length > 0)
    check('the permission level is changeable after first run', /Permission level/i.test(settings))
    for (const row of ['When it needs permission', 'Sessions found in your editor', 'If an account runs out']) {
      check(`"${row}" is reachable after first run`, settings.includes(row))
    }
    /* EVERY CATEGORY IN THE RAIL IS A PAGE, AND EACH ONE HAS TO ARRIVE.
       This used to count the rail's buttons against the sections drawn beside
       them, because the page drew all twelve at once. It draws ONE, so the same
       promise -- no button in that list opens onto nothing -- is kept by
       pressing each of them and reading back what arrived. */
    const categories = await evaluate(`(() => {
      for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
      return [...document.querySelectorAll('.settings-rail button[data-category]')].map(node => node.dataset.category)
    })()`)
    check('the rail offers its categories', Array.isArray(categories) && categories.length > 0,
      `${categories?.length} categories`)
    const empty = []
    for (const category of categories || []) {
      const selector = `.settings-rail button[data-category=${JSON.stringify(category)}]`
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
      await delay(500)
      const drawn = await evaluate(`[...document.querySelectorAll('.settings-sections .settings-section')]
        .map(node => node.dataset.settingsSection)`)
      const only = new Set(drawn || [])
      if (only.size !== 1 || !only.has(category)) empty.push(`${category} drew ${JSON.stringify(drawn)}`)
    }
    check('every rail category opens onto its own page, and nothing else', empty.length === 0,
      empty.slice(0, 4).join(' | ') || `${categories?.length} categories`)

    /* ---------- read it back with the engine's own reader ---------- */
    const record = machineRecord.readMachineRecord({ servicesRoot })
    check('the engine\'s own reader reads the record back', Boolean(record))
    check('the engine validates it', machineRecord.validateMachineRecord(record).ok)
    check('the level chosen is the level recorded', record.tier === 'guided', record.tier)
    if (mode === 'skip') {
      check('skipping switched nothing on', JSON.parse(await evaluate(
        'JSON.stringify(["dispatch","decision","queue","report-read","agent-session"].map(id => localStorage.getItem("mc.write." + id)))',
      )).every(value => value !== 'enabled'))
      check('skipping left the folder as recorded', record.workspaceChosen === undefined)
    } else {
      check('the folder shown is the folder recorded', record.workspaceRoots[0] === suggested)
      check('the folder was created', existsSync(record.workspaceRoots[0]))
      check('the assistant is configured in the chosen folder', existsSync(path.join(record.workspaceRoots[0], '.mcp.json')))
    }
  } finally {
    session.close()
    await delay(300)
    /* By PATH, under this run's own scratch copy. Never by process name: another
       lane's ToolsEnabled, or the owner's, must not be touched. */
    try {
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='ToolsEnabled.exe'" | Where-Object { $_.ExecutablePath -like '${path.join(scratch, 'app').replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', windowsHide: true })
    } catch { /* nothing of ours left to stop */ }
    try { child.kill() } catch { /* already gone */ }
    /* Wait for the tree to actually be gone rather than assuming the kill was
       synchronous. A half-dead instance still holds its ports, and the next
       mode's run would inherit that as a mystery startup failure. */
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (child.exitCode !== null) break
      await delay(250)
    }
  }

  const failed = checks.filter(entry => !entry.ok)
  console.log(`${mode}: ${checks.length - failed.length}/${checks.length} checks`)
  return failed.length === 0
}

const scratch = mkdtempSync(path.join(tmpdir(), 'mc-setup-qa-'))
let ok = true
try {
  const executable = await stage(scratch)
  for (const mode of MODES) {
    console.log(`\n${mode} path, fresh profile:`)
    ok = (await drive(mode, executable, scratch)) && ok
  }
} finally {
  if (!KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
console.log(ok ? '\nsetup walkthrough: PASS' : '\nsetup walkthrough: FAIL')
process.exit(ok ? 0 : 1)
