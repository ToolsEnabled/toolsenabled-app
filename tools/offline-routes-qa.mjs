#!/usr/bin/env node

// B7 — WHAT DOES A PERSON SEE ON EVERY PRIMARY ROUTE WHEN NOTHING IS REACHABLE?
// MEASURED IN THE PACKAGED WINDOW, ON A STERILE PROFILE, BY CLICKING.
//
// THREE MACHINE STATES, ONE VARIABLE EACH, and the baseline exists so that the
// permanent no-fleet-host state (documented in reports/lanes/team2-b5.md) is not
// mistaken for an offline defect:
//
//   connected   the layer starts, the machine's own network is left alone.
//               This is the control. Everything it shows is what a person sees
//               on a working install with no fleet host, which is every install.
//   offline     the machine has no route off itself. Chromium is pointed at a
//               dead proxy and the proxy environment every child CLI reads names
//               the same dead port, with loopback explicitly bypassed -- so the
//               app still serves its own dist/ and still starts its own
//               capability layer, exactly as pulling the ethernet cable does.
//   nothing     offline AND the app's own capability layer cannot start (its
//               payload is not in the staged copy). "Nothing is reachable" in
//               the literal sense: no internet, no audited bridge.
//
// WHY THE PROXY AND NOT AN ADAPTER. Turning off the machine's network needs
// elevation and would take the owner's own session down with it. A dead proxy
// with `<-loopback>` NOT in the bypass list is the same observation for
// everything that leaves the machine, and leaves loopback -- which is where this
// app's server and its capability layer live -- untouched. A proxy that refuses
// instantly is also the KINDER offline: a blackholed network makes the app wait
// for its own timeouts, so any hang this finds is a floor, not a ceiling.
//
// WHAT IS MEASURED ON EACH ROUTE, stated before anything is run:
//   HANGS   a pending state ("Checking…", "Loading…", aria-busy, a checking
//           data-state) still on the glass after the settle deadline. A spinner
//           that never resolves is the defect this task names first.
//   LIES    a health word the screen cannot have measured in this state -- a
//           "live" pill, a "ready" write state, a count of things that answered.
//   BLANKS  a route that renders nothing a person can read or act on.
// The verdicts on LIES are made by a person reading the transcript and the
// screenshots this writes; the harness records the exact strings rather than
// pretending a regex can judge honesty.
//
// RULES BORROWED FROM tools/first-run-recovery-qa.mjs BECAUSE THEY EARNED THEIR
// PLACE THERE:
//   * It never assigns location.hash. A person cannot type a route. Self-audited.
//   * Every route is reached by pressing the control a person presses.
//   * No write control is ever pressed. Every press below is a navigation.
//
// THE OWNER'S LIVE ENGINE IS NEVER TOUCHED. This starts its own packaged copy
// from a staged directory. In the `nothing` state the renderer's discovery scan
// can find a foreign capability layer already listening on 127.0.0.1:4610 (this
// machine has one), and that is deliberately left alone rather than worked
// around: the scan's only request is the unauthenticated, side-effect-free
// /v1/runtime, this copy has no bootstrap proof to hand it, and the endpoint
// each run actually resolved is recorded below so the reader can see which it
// was.
//
// RUN IT:
//   node tools/offline-routes-qa.mjs
//   node tools/offline-routes-qa.mjs --state offline
//   node tools/offline-routes-qa.mjs --shoot artifacts/b7
//   --release <dir>        default release/win-unpacked
//   --settle-ms <n>        how long a pending state may persist (default 45000)
//   --keep                 keep the scratch dir
//
// EXIT CODE HAS THREE VALUES AND ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED — a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { GUIDE_HREF } from '../src/first-run-needs.js'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
const SETTLE_BUDGET_MS = Number(argument('--settle-ms', 45000))
const SHOOT = argument('--shoot', null) ? path.resolve(argument('--shoot')) : null
const ONLY_STATE = argument('--state', null)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* A port nothing can be listening on. Chromium refuses to connect to port 1 in
   the same breath it would refuse an unplugged cable, and Node/Rust clients that
   read the proxy environment get a connection refusal on their first packet. */
const DEAD_PROXY = '127.0.0.1:1'

class HarnessError extends Error {}

function auditSelf() {
  const source = readFileSync(SELF, 'utf8')
  const offences = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(\+?=)(?!=)/.test(line))
    .filter(({ line }) => !line.includes('SELF-AUDIT-PATTERN'))
  if (offences.length === 0) return
  console.error('\nNO VERDICT: this suite navigates by assigning location.hash, which is the')
  console.error('one thing a customer cannot do. Offending lines:')
  for (const { line, number } of offences) console.error(`  ${number}: ${line.trim()}`)
  process.exit(2)
}

/* A COPY is run, never release/win-unpacked itself: the GUI starts a supervised
 * capability layer that writes state/ next to the binary, so running the
 * artifact in place mutates the artifact. dist/ and shell/ come from the working
 * tree so this measures what is actually here.
 *
 * WHY resources/app/ AND NOT A REPACKED app.asar. The obvious staging (extract
 * the asar, swap two directories, repack) needs @electron/asar, which is a
 * transitive dependency of electron-builder and WAS NOT INSTALLED in this tree
 * when this ran -- the first version of this file died on it mid-lane. Electron
 * reads an unpacked resources/app/ directory when there is no app.asar beside
 * it, and the archive holds nothing but package.json, dist/ and shell/ (see
 * resources/app.asar.filelist.txt), so the unpacked form is the same program
 * with one less tool between this harness and the thing it measures. */
async function stage(scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const app = path.join(scratch, 'app')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  const unpacked = path.join(app, 'resources', 'app')
  mkdirSync(unpacked, { recursive: true })
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  rmSync(path.join(app, 'resources', 'app.asar'), { force: true })
  rmSync(path.join(app, 'resources', 'app.asar.filelist.txt'), { force: true })
  return app
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  if (executables.length === 0) throw new Error(`no .exe in the staged app at ${appRoot}`)
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

function systemOnlyPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return [
    path.join(root, 'system32'),
    root,
    path.join(root, 'system32', 'Wbem'),
    path.join(root, 'system32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

async function openApp(appRoot, scratch, machineState) {
  const executable = appExecutable(appRoot)
  const profile = path.join(scratch, `profile-${machineState.id}`)
  for (const leaf of ['userdata', 'local', 'home', 'appdata']) {
    mkdirSync(path.join(profile, leaf), { recursive: true })
  }
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.APPDATA = path.join(profile, 'appdata')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  environment.PATH = systemOnlyPath()
  environment.Path = environment.PATH

  if (machineState.offline) {
    /* Every client that reads the proxy environment -- the codex CLI, anything
       spawned by the capability layer, Node's own https agents when configured
       -- gets a dead first hop. Loopback is exempted explicitly so this stays a
       measurement of the NETWORK being gone and not of the app being gone. */
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      environment[key] = `http://${DEAD_PROXY}`
    }
    environment.NO_PROXY = '127.0.0.1,localhost,::1'
    environment.no_proxy = environment.NO_PROXY
  }

  const userData = path.join(profile, 'userdata')
  const argv = [`--user-data-dir=${userData}`, '--remote-debugging-port=0']
  if (machineState.offline) {
    /* Chromium's own stack: the OAuth window, net.fetch, and every renderer
       request that is not loopback. The bypass list is stated rather than left
       to the default so the exemption is visible in this file. */
    argv.push(`--proxy-server=http://${DEAD_PROXY}`)
    argv.push('--proxy-bypass-list=127.0.0.1;localhost;[::1]')
  }

  const child = spawn(executable, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

  const evaluate = async (expression) => {
    const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.result?.value
  }
  const shoot = async (name) => {
    if (!SHOOT) return
    const reply = await session.send('Page.captureScreenshot', { format: 'png' })
    const data = reply?.result?.data
    if (!data) return
    mkdirSync(SHOOT, { recursive: true })
    writeFileSync(path.join(SHOOT, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const until = async (what, expression, tries = 80) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await evaluate(expression)) return true
      await delay(250)
    }
    console.log(`  ..    gave up waiting for ${what}`)
    return false
  }
  const clickVisible = async (selector) => evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return 'absent'
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return 'not-visible'
    if (style.visibility === 'hidden' || style.display === 'none') return 'not-visible'
    node.click()
    return 'clicked'
  })()`)
  const clickLastVisible = async (selector) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    if (!nodes.length) return 'absent'
    nodes[nodes.length - 1].click()
    return 'clicked'
  })()`)

  return { evaluate, until, clickVisible, clickLastVisible, shoot, teardown, noise }
}

function createSession(child, userDataDir, say) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open(budgetMs) {
      const started = Date.now()
      const file = path.join(userDataDir, 'DevToolsActivePort')
      let port = null
      while (Date.now() - started < budgetMs && port === null) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before publishing a debugger port`)
        }
        try {
          const candidate = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
          if (Number.isInteger(candidate) && candidate > 0) port = candidate
        } catch { /* not written yet */ }
        if (port === null) await delay(200)
      }
      if (port === null) throw new HarnessError(`the app never published a debugger port within ${Math.round(budgetMs / 1000)}s`)
      say(`debugger published on 127.0.0.1:${port} after ${Date.now() - started}ms`)

      let lastSeen = 'the debugger endpoint never answered at all'
      while (Date.now() - started < budgetMs) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before the debugger answered`)
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
            ? `${targets.length} target(s) and none a debuggable page`
            : 'an EMPTY target list — the process is up but no window opened'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s — ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* A PENDING STATE, DEFINED SO THAT IT CANNOT BE CONFUSED WITH A LABEL.
 *
 * An ellipsis alone is not a spinner: this product uses it for truncation
 * ("…" at 190 chars), for placeholders ("Message coordinator…") and for
 * controls that open a picker ("Choose a folder…"). What makes a string a
 * pending state is an ellipsis AND a verb about work in flight. The
 * attribute half catches the pending states that carry no words at all. */
const PENDING = `(() => {
  const shown = node => {
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim()
  const VERB = /\\b(check|checking|load|loading|read|reading|measur|connect|connecting|start|starting|stopping|wait|waiting|working|saving|dispatch|dispatching|launching|previewing|terminating|archiving|resolving|comput|pending)/i
  const found = new Map()
  const add = (why, node) => {
    const text = norm(node.textContent).slice(0, 160)
    const key = why + '|' + text + '|' + node.className
    if (!found.has(key)) found.set(key, { why, text, at: node.className || node.tagName })
  }
  for (const node of document.querySelectorAll('body *')) {
    if (node.children.length !== 0) continue
    if (!shown(node)) continue
    const text = norm(node.textContent)
    if (!text || !text.includes('\\u2026')) continue
    if (!VERB.test(text)) continue
    add('words', node)
  }
  for (const node of document.querySelectorAll(
    '[data-state="checking"],[data-state="pending"],[data-projection-state="loading"],[aria-busy="true"],.is-loading,[data-session-status]'
  )) {
    if (!shown(node)) continue
    const text = norm(node.textContent)
    if (!VERB.test(text) && node.getAttribute('aria-busy') !== 'true') continue
    add('attribute', node)
  }
  return [...found.values()]
})()`

const SCREEN = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim()
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    /* #stage, not body: the closed settings drawer is display:block and parked
       off-screen, so body.innerText carries its whole contents onto every route
       and would make each screen look like it says more than it does. */
    screen: norm(document.querySelector('#stage')?.innerText),
    views: document.querySelectorAll('#stage > .view').length,
    /* The health words this task is about, read where they actually live rather
       than grepped out of the page text: a "live" pill and a write-state line
       both say a thing about reachability that the screen has to have measured. */
    livePills: [...document.querySelectorAll('.head-live, .session-write-state, [data-live-mode], [data-projection-state]')]
      .filter(shown)
      .map(node => ({ cls: node.className, state: node.dataset.projectionState || node.dataset.state || '', text: norm(node.textContent).slice(0, 120) })),
    exits: [...document.querySelectorAll('a[href^="#/"]')].filter(shown)
      .map(node => ({ text: norm(node.textContent), href: node.getAttribute('href') || '' })),
  }
})()`

async function walkSetup({ evaluate, until, clickVisible, clickLastVisible }, check, note) {
  const onSetup = await until('the permission question', `location.hash === '#/setup'`)
  if (!onSetup) {
    /* THE GATE IS ALLOWED NOT TO FIRE, and this is not a pass by omission.
       src/setup-state.js fails OPEN: when the shell cannot record a permission
       level the first launch goes straight into the app rather than trapping a
       person on a screen whose only button would fail. So the harness records
       WHY it did not fire, from the shell's own bootstrap, and carries on to
       the routes -- which is where this task's question actually lives. */
    const why = await evaluate(`(() => { try { return JSON.stringify(window.mcSetup?.bootstrap ?? null) } catch (e) { return 'threw: ' + e.message } })()`)
    const landed = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 40)
    note(`the first-run question did not open; the shell's setup bootstrap says ${why}`)
    check('the app is usable even when the first-run question does not open', landed,
      `hash=${await evaluate('location.hash')} bootstrap=${String(why).slice(0, 240)}`)
    return landed
  }
  check('a fresh profile opens on the permission question', onSetup, `hash=${await evaluate('location.hash')}`)
  /* Records what each press actually did. See the long note on the same helper
     in tools/first-run-recovery-qa.mjs: a discarded click answer is why every
     RELEASE-CUT-TRAPS section 12 failure reads "gave up waiting for the review"
     and none of them can say whether the review failed to draw or the click
     before it never landed. */
  const press = async (click, selector, what) => {
    const outcome = await click(selector)
    const ok = outcome === 'clicked'
    check(`the walk can press ${what}`, ok, `${selector} -> ${outcome}`)
    return ok
  }
  await press(clickVisible, '[data-setup-continue]', 'Continue on the permission question')
  await until('the folder question', `document.querySelector('[data-setup-section]')?.innerText.includes('Which folder')`)
  await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
  await press(clickLastVisible, '[data-setup-next]', 'Continue on the folder question')
  await until('the sign-in step',
    `document.querySelector('[data-setup-section]')?.innerText.includes('Who is using this copy') || document.querySelector('[data-setup-section]')?.innerText.includes('Signed in as')`)
  await press(clickLastVisible, '[data-setup-next]', 'Continue on the sign-in step')
  await until('the autonomy question', `document.querySelector('[data-setup-section]')?.innerText.includes('without asking')`)
  await press(clickVisible, '[data-setup-set="autonomy"][data-setup-value="assisted"]', 'the assisted autonomy level')
  await press(clickVisible, '[data-setup-next="review"]', 'Continue through to the review')
  await until('the review', `document.querySelector('[data-setup-section]')?.innerText.includes('what those answers set')`)
  await until('the readiness answer on the review',
    `!document.querySelector('[data-setup-section]')?.innerText.includes('Checking whether Codex')`)
  await press(clickVisible, '[data-setup-next="finish"]', 'Finish on the review')
  const intoApp = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 120)
  check('setup ends in the app', intoApp, `hash=${await evaluate('location.hash')}`)
  return intoApp
}

/* HOW LONG A ROUTE IS WATCHED BEFORE IT IS CALLED SETTLED.
 *
 * A single sample the instant the route changes measures nothing: the pending
 * state a bridge call puts up has not been put up yet. So every route is
 * watched for at least this long, the UNION of everything seen is kept as
 * evidence, and only what is still there at the end counts as stuck. */
const MIN_WATCH_MS = 5000

/** Watch a route; report every pending state seen and any still there at the end. */
async function settle(app, budgetMs) {
  const started = Date.now()
  const seen = new Map()
  let markers = []
  let clearSamples = 0
  while (Date.now() - started < budgetMs) {
    markers = await app.evaluate(PENDING)
    for (const marker of markers) seen.set(`${marker.why}|${marker.text}`, marker)
    clearSamples = markers.length === 0 ? clearSamples + 1 : 0
    if (Date.now() - started >= MIN_WATCH_MS && clearSamples >= 2) break
    await delay(500)
  }
  return { seen: [...seen.values()], last: markers, ms: Date.now() - started }
}

const RING_AFTER_HOME = ['computers', 'metrics', 'research', 'comms', 'ledger', 'approvals']

/* A SCREEN MAY NOT CONTRADICT ITSELF IN ONE VIEWPORT.
 *
 * Each entry is: when the screen says `when`, it must NOT also say `never`.
 * Written this way rather than as three flat regexes because the defect in
 * every case is a PAIR -- a refusal and, beside it, a number or a promise that
 * could only exist if the refusal were untrue. A bare "must not contain
 * `0 tasks`" would go red on a working fleet whose agent has genuinely done
 * none, which is a real state and a correct thing to show. */
const SELF_CONTRADICTIONS = Object.freeze({
  computers: [{
    name: 'the fleet graph does not report task telemetry the same page calls unavailable',
    when: /not provided by fleet projection/i,
    never: /\d+\s+tasks?\s*·\s*[\d.]+%\s*fail/i,
  }],
  /* RETARGETED after the comms redesign. The old pair ("ops projection is
     unavailable" / "N conversations") named sentences the board no longer
     prints, so the rule could never fire. What the board says now when the
     whole read fails is src/comms-copy.js UNREADABLE_SUB, and the number it
     must not also claim is the inventory line's ("N services · N channels ·
     N messages", comms-copy.js inventoryLine) -- the contradiction that
     module's own comment says this file pins. `when` is the WHOLE-read
     sentence on purpose: a partial read legitimately prints "N services ·
     channels could not be read" in one line. */
  comms: [{
    name: 'the comms board does not count services, channels or messages in a report it says it could not read',
    when: /The comms report could not be read\./i,
    never: /\b\d+\s+(?:services?|channels?|messages?)\b/i,
  }],
  approvals: [{
    name: 'approvals does not describe approving while saying the queue could not be read',
    when: /queue could not be read/i,
    never: /it does not spend/i,
  }],
})

async function walkOneState(appRoot, scratch, machineState, check, note) {
  const app = await openApp(appRoot, scratch, machineState)
  const records = []
  let endpoint = null
  let offlineProof = null
  try {
    if (!await walkSetup(app, check, note)) return { records, failedSetup: true }

    /* WHICH BRIDGE THIS RUN ACTUALLY RESOLVED, recorded before anything is
       judged: a "nothing is reachable" run that quietly found a foreign layer
       is measuring something else, and the reader must be able to see that.
       Asked after the walkthrough because the preload's world is only there
       once the app page has loaded. */
    endpoint = await app.evaluate(`(async () => {
      try { return JSON.stringify(await window.mcShell.getBridgeEndpoint()) } catch (e) { return 'threw: ' + e.message }
    })()`)
    note(`bridge endpoint: ${endpoint}`)

    /* PROVE THE STATE THIS RUN CLAIMS TO BE IN, from inside the app's own
       network stack, before any verdict is written down. A suite that says
       "offline" and was not is worse than no suite: every route would pass for
       the wrong reason. One unauthenticated GET to a well-known 204 endpoint,
       no credentials, no body. */
    offlineProof = await app.evaluate(`(async () => {
      const started = Date.now()
      try {
        /* no-cors: the point is whether a packet can LEAVE, and a cross-origin
           204 with no Access-Control-Allow-Origin rejects with the same
           "Failed to fetch" a dead network gives. The first version of this
           probe reported the control machine as offline for exactly that
           reason. An opaque response means the request completed. */
        const response = await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) })
        return 'reached the internet: type ' + response.type + ' in ' + (Date.now() - started) + 'ms'
      } catch (error) { return 'no route off this machine: ' + (error && error.name) + ' ' + (error && error.message) + ' in ' + (Date.now() - started) + 'ms' }
    })()`)
    note(`network probe: ${offlineProof}`)
    check(`[${machineState.id}] the machine really is ${machineState.offline ? 'offline' : 'online'} for this run`,
      machineState.offline ? /^no route off this machine/.test(offlineProof) : /^reached the internet/.test(offlineProof),
      offlineProof)

    /* THE STATE A CUSTOMER ACTUALLY REACHES, as distinct from a broken install:
       the layer came up, the app got a working session out of it, and then it
       went away. That is the one that can leave a health claim on a screen --
       the screens were right when they drew it and nothing has told them
       otherwise. The layer is killed with its whole tree, and the kill is
       CONFIRMED before any route is judged, so a failed kill cannot pass as a
       measurement of a dead layer. */
    if (machineState.killLayer) {
      const pid = JSON.parse(endpoint)?.pid
      if (!Number.isSafeInteger(pid)) throw new HarnessError(`no capability layer pid to kill; the endpoint said ${endpoint}`)
      await new Promise(resolve => {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('exit', resolve)
      })
      await delay(1500)
      const after = await app.evaluate(`(async () => {
        try {
          const response = await fetch(${JSON.stringify('')} + (${JSON.stringify(JSON.parse(endpoint).baseUrl)}) + '/v1/runtime', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
          return 'still answering: HTTP ' + response.status
        } catch (error) { return 'gone: ' + (error && error.name) }
      })()`)
      note(`capability layer after the kill: ${after}`)
      check(`[${machineState.id}] the capability layer really is gone before any route is judged`,
        /^gone/.test(after), after)
    }

    const visit = async (name, { label = name, dwellMs = 0 } = {}) => {
      await app.until(`the ${name} page`, `document.body.dataset.route === '${name}'`)
      /* THE OUTGOING VIEW IS STILL ON THE STAGE FOR 420ms. Reading the screen
         before it leaves attributes the previous route's words to this one --
         the first version of this file recorded the fleet graph's text as the
         metrics page's, and would have cleared metrics of a defect it had. */
      await app.until('the previous view to leave', `document.querySelectorAll('#stage > .view').length === 1`, 12)
      const settled = await settle(app, SETTLE_BUDGET_MS)
      const screen = await app.evaluate(SCREEN)
      await app.shoot(`${machineState.id}-${label}`)
      /* A SCREEN THAT WAS RIGHT WHEN IT DREW AND IS NOT RIGHT NOW. Home's
         approvals row is polled, not live, so the interesting question is not
         what it says a second after the bridge dies but whether it ever takes
         the claim back. The dwell is longer than that poll, and the second
         capture is what the answer is read off. */
      let screenAfterDwell = null
      if (dwellMs > 0) {
        await delay(dwellMs)
        screenAfterDwell = await app.evaluate(SCREEN)
        await app.shoot(`${machineState.id}-${label}-after-${Math.round(dwellMs / 1000)}s`)
      }
      const record = { name, label, ...screen, dwellMs, screenAfterDwell, pendingSeen: settled.seen, pendingLast: settled.last, settleMs: settled.ms }
      records.push(record)
      note(`${machineState.id}/${label}: watched ${settled.ms}ms; ${settled.seen.length} pending seen, ${settled.last.length} left`)
      for (const marker of settled.seen) note(`    saw pending: ${JSON.stringify(marker)}`)
      for (const marker of settled.last) note(`    STILL PENDING: ${JSON.stringify(marker)}`)
      check(`[${machineState.id}] ${label} has no pending state left after ${Math.round(SETTLE_BUDGET_MS / 1000)}s`,
        settled.last.length === 0, settled.last.map(m => m.text).join(' | ').slice(0, 200))
      check(`[${machineState.id}] ${label} renders something a person can read`,
        record.screen.replace(/\s/g, '').length > 40, `${record.screen.length} chars`)
      for (const rule of SELF_CONTRADICTIONS[name] || []) {
        if (!rule.when.test(record.screen)) { note(`${label}: ${rule.name} — not in that state this run`); continue }
        const offending = record.screen.match(rule.never)
        check(`[${machineState.id}] ${label}: ${rule.name}`, offending === null, offending ? `it also says "${offending[0]}"` : '')
      }
      return record
    }

    await delay(1200)
    /* HOME IS ALREADY MOUNTED when the walk starts -- setup finishes on it --
       so this capture is of a screen that read the bridge BEFORE it went away.
       The dwell is 26s, longer than home's own 20s approvals poll, so a claim
       that is merely stale is visibly distinguished from one that is stuck. */
    await visit('home', { dwellMs: 26000 })
    for (const stop of RING_AFTER_HOME) {
      const pressed = await app.clickVisible('#nav-next')
      if (pressed !== 'clicked') { check(`[${machineState.id}] the forward chevron is pressable on the way to ${stop}`, false, String(pressed)); break }
      await visit(stop)
    }
    /* AND HOME AGAIN, ON A FRESH MOUNT. The ring closes, so one more press of
       the same chevron lands back on home -- this time built from scratch with
       the bridge already gone, which is the state that says whether the screen
       can state a fact it has no way of knowing. */
    if (await app.clickVisible('#nav-next') === 'clicked') await visit('home', { label: 'home-again' })
    /* Settings is off the ring and is reached the way a person reaches it. */
    await app.clickVisible('#open-settings')
    await delay(400)
    await app.clickVisible('.drawer-all')
    await visit('settings')

    /* The two off-ring places a stranger is actually sent to from the routes
       above: the This computer section of Settings (every unavailable-host state
       links to it) and the account screen (checkout and setup both send a
       blocked person there). Each is only visited if a screen genuinely offers
       the link. */
    /* `route` is the stop the router names and `label` is what the shot is
       filed under. They were the same word while the This computer section was
       a page of its own; it is a section of Settings now, so the stop is
       `settings` and the label is what a reader would call the place. */
    for (const [route, label, selector] of [
      ['settings', 'this computer', `a[href="${GUIDE_HREF}"]`],
      ['account', 'account', 'a[href="#/account"]'],
    ]) {
      const pressed = await app.clickVisible(selector)
      if (pressed !== 'clicked') { note(`no visible link to ${label} on settings (${pressed})`); continue }
      await visit(route, { label })
      /* back to settings so the next link is looked for where it lives */
      await app.clickVisible('#open-settings')
      await delay(400)
      await app.clickVisible('.drawer-all')
      await app.until('settings again', `document.body.dataset.route === 'settings'`, 20)
      await delay(600)
    }
  } finally {
    await app.teardown()
  }
  return { records, endpoint, offlineProof }
}

const STATES = [
  { id: 'connected', offline: false, stripCapability: false, what: 'layer up, network untouched (the control)' },
  { id: 'offline', offline: true, stripCapability: false, what: 'no route off this machine; the layer still starts' },
  { id: 'nothing', offline: true, stripCapability: true, what: 'no network AND no capability layer' },
  /* The layer is killed AFTER the app has a working session with it, so this is
     the only state where a screen could be showing something it measured while
     the answer was still true. Network left alone: the variable is the bridge. */
  { id: 'layer-killed', offline: false, stripCapability: false, killLayer: true, what: 'the capability layer was up, answered, and then died' },
]

async function main() {
  auditSelf()
  const scratch = mkdtempSync(path.join(tmpdir(), 'offline-routes-'))
  const checks = []
  const check = (what, ok, detail = '') => {
    checks.push({ name: what, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)
  const transcript = {}

  try {
    const appRoot = await stage(scratch)
    console.log(`staged a copy at ${appRoot}`)
    /* A SECOND COPY with no capability payload, so the two states differ by that
       one directory and by nothing else. Copied rather than mutated in place so
       a run of both states in one invocation cannot contaminate the first. */
    const strippedRoot = path.join(scratch, 'app-no-capability')
    cpSync(appRoot, strippedRoot, { recursive: true })
    rmSync(path.join(strippedRoot, 'resources', 'capability'), { recursive: true, force: true })

    for (const machineState of STATES) {
      if (ONLY_STATE && machineState.id !== ONLY_STATE) continue
      console.log(`\n== ${machineState.id}: ${machineState.what} ==`)
      const root = machineState.stripCapability ? strippedRoot : appRoot
      const result = await walkOneState(root, scratch, machineState, check, note)
      transcript[machineState.id] = result
    }
  } finally {
    const out = path.join(REPO_ROOT, 'reports', 'lanes', 'team2-b7-transcript.json')
    try {
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(transcript, null, 2))
      console.log(`\nwrote the full transcript to ${out}`)
    } catch (error) { console.log(`could not write the transcript: ${error.message}`) }
    if (KEEP) console.log(`kept the scratch directory at ${scratch}`)
    else {
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) }
      catch (error) { console.log(`could not remove the scratch directory (${error.code || error.message}); it is at ${scratch}`) }
    }
  }

  const failed = checks.filter(result => !result.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.error(`FAILED: ${failed.map(result => result.name).join('; ')}`)
    return 1
  }
  return 0
}

main().then(
  code => { process.exitCode = code },
  error => {
    if (error instanceof HarnessError) {
      console.error('\nNO VERDICT — nothing about the product was measured.')
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error('\nNO VERDICT — the harness failed before it could measure anything.')
    console.error(error?.stack || String(error))
    process.exitCode = 2
  },
)
