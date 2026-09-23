#!/usr/bin/env node

// LEGACY-ONB-001 — DOES EVERY UNAVAILABLE-HOST STATE EXPLAIN ITSELF AND OFFER A WAY
// FORWARD? MEASURED IN THE PACKAGED WINDOW, ON A STERILE PROFILE, BY CLICKING.
//
// THE FINDING THIS EXISTS FOR, confirmed on machine B: on a fresh isolated profile a
// person reaches Home with no local fleet host, the coordinator thread unavailable and
// messaging disabled, and NOTHING on Home, Settings, the Fleet Graph or the Comms Board
// explains the prerequisite or offers a recovery path.
//
// WHY THIS IS THE SHIPPING STATE AND NOT AN EDGE CASE. Every projection in
// public/data/*.json is a BUILD-TIME file produced by tools/gen-*.mjs from the
// builder's own engine. On any machine that is not the builder's there is nothing to
// read, so all seven ship as {"ok": false, "reason": "No local agent fleet host
// detected on this machine."} — permanently, on every customer install, forever. The
// unavailable branch of each of these four screens is the only branch a customer will
// ever see.
//
// WHAT COUNTS AS A PASS, stated before anything is measured, because the temptation
// here is to accept a sentence as a remedy:
//   * EXPLAINS  — the screen says what the missing thing IS in words a person who has
//                 never heard the phrase "fleet host" can act on. A refusal that names
//                 the mechanism ("Fleet projection unavailable") is a diagnosis, not an
//                 explanation.
//   * OFFERS    — there is a VISIBLE, NAMED control on the glass leading either to a
//                 least-privilege recovery action or to the in-product guide. Visible
//                 means a real box with non-zero size, not merely present in the DOM.
//
// RULES THIS SUITE HOLDS ITSELF TO, borrowed from tools/stranger-onboarding-qa.mjs
// because they earned their place there:
//   * It never assigns location.hash. A person cannot type a route, and a harness that
//     does passes on a build where nothing routes to the screen. Self-audited below.
//   * Every screen is reached by pressing the same controls a person presses.
//   * The guide is only counted as reached if pressing the link actually lands on it.
//
// ISOLATION — one mechanism per thing that would otherwise read the real machine:
//   --user-data-dir  Electron resolves userData through a Windows known folder, not the
//                    environment; this is the supported override and it moves the
//                    single-instance lock, so this runs alongside a copy in use.
//   LOCALAPPDATA     resolveServicesRoot() reads it, so the machine record lands in
//                    scratch instead of the owner's.
//   USERPROFILE      so a Codex-home probe that falls back to ~ reads scratch.
//   CODEX_HOME       the sign-in this product looks for.
//   APPDATA          shell/agent-host.cjs resolves the npm global install under it.
//   PATH             rebuilt from the Windows system directories alone.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node and exits 0,
// which is indistinguishable from a crash.
//
// THE OWNER'S LIVE ENGINE IS NEVER TOUCHED. This starts its own packaged copy from a
// staged directory. It presses no dispatch control and no Start control; every press
// below is a navigation.
//
// RUN IT:
//   node tools/first-run-recovery-qa.mjs
//   node tools/first-run-recovery-qa.mjs --keep      (keep the scratch dir)
//   --release <dir>        default release/win-unpacked
//   --open-timeout-ms <n>  how long to wait for the window (default 120000)
//
// EXIT CODE HAS THREE VALUES AND ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED — a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured.
// Never read this tool's status through a pipe.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/* The words the product is supposed to be saying, read from the same module the
   renderer reads them from. See the note on EXPLANATION below for why this is an
   import and not a regex. Both modules are plain data with no DOM, so a node
   process can hold them. */
import { FIRST_RUN_NEEDS, GUIDE_HREF, commsQuietNotice, hostAbsentNotice } from '../src/first-run-needs.js'
import { CONNECT_HREF } from '../src/device-claim-flow.js'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const OPEN_BUDGET_MS = Number(argument('--open-timeout-ms', 120000))
const SHOOT = argument('--shoot', null) ? path.resolve(argument('--shoot')) : null
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

class HarnessError extends Error {}

/* The instrument audits itself: a suite that reaches a screen by assigning the hash is
   not measuring whether a person can reach it, and the failure is silent. Assignment is
   navigation; comparison is observation, so `===` and `!==` are not caught. */
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
   capability layer that writes state/ next to the binary, so running the artifact in
   place mutates the artifact. dist/ and shell/ come from the working tree so this
   measures what is actually here. */
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
  return appExecutable(app)
}

/* Pick the launcher by SHAPE, not by spelling. */
/* WAS A SEVENTH COPY OF THE SAME RULE, AND OFF WINDOWS EVERY COPY WAS WRONG.
   This function read `.exe` out of the app root; a Linux candidate has none, so
   it refused before measuring anything. tools/lib/packaged-platform.mjs owns
   the one answer -- the same Windows launcher-by-shape logic, plus an ELF
   branch that opens the file with O_NOFOLLOW and checks the magic. */

/* A PATH with nothing on it but Windows itself, built from a fixed list rather than
   filtered out of the real one: filtering fails OPEN — one unfamiliar directory
   carrying a shim and the run silently measures a machine that has Codex. */
function systemOnlyPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return [
    path.join(root, 'system32'),
    root,
    path.join(root, 'system32', 'Wbem'),
    path.join(root, 'system32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

async function openApp(executable, scratch, label) {
  const profile = path.join(scratch, `profile-${label}`)
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

  const userData = path.join(profile, 'userdata')
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
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

  const evaluate = async (expression) => {
    const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.result?.value
  }
  /* A CHECK THAT PASSES ON AN UNREADABLE PAGE IS NOT A CHECK. Everything above
     reads text, and text is on the glass whether or not the layout survived it:
     a notice that overflows its rail, a link clipped out of a scrolling preview
     and a paragraph in invisible ink all pass every assertion in this file. So
     --shoot writes the screens out and a person looks. Off by default because it
     is a human step, not an automated verdict. */
  const shoot = async (name, { whole = false } = {}) => {
    if (!SHOOT) return
    /* `whole` captures past the fold. This is a reading section and the half of
       it nobody would see in a viewport shot -- what already works, and the way
       back into the product -- is exactly the half a reviewer needs to check, so
       a viewport crop would be a screenshot that proves the top of the page. */
    let options = { format: 'png' }
    if (whole) {
      const metrics = await session.send('Page.getLayoutMetrics')
      const size = metrics?.result?.cssContentSize
      if (size) {
        options = {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
        }
      }
    }
    const reply = await session.send('Page.captureScreenshot', options)
    const data = reply?.result?.data
    if (!data) { console.log(`  ..    no screenshot came back for ${name}`); return }
    mkdirSync(SHOOT, { recursive: true })
    const file = path.join(SHOOT, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  ..    wrote ${file}`)
  }
  const until = async (what, expression, tries = 80) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await evaluate(expression)) return true
      await delay(250)
    }
    console.log(`  ..    gave up waiting for ${what}`)
    return false
  }
  /* A control counts only if it is a real box with a name a person could read.
     Returns a WORD so a failure says WHICH of the three ways it failed. */
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

/* Everything on the glass, plus the doors to This computer visible on it. innerText, never
   innerHTML: an instruction in the DOM and not on the glass is not an instruction. */
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
    screen: norm(document.body.innerText),
    /* Every visible anchor or button that leads somewhere, with its words. This is
       what "offers a recovery path" is measured against. */
    exits: [...document.querySelectorAll('a[href^="#/"], button[data-guide], a[data-guide]')]
      .filter(shown)
      .map(node => ({ text: norm(node.textContent), href: node.getAttribute('href') || '' })),
    guideLinks: [...document.querySelectorAll('a[href="${GUIDE_HREF}"]')].filter(shown).length,
  }
})()`

async function walkSetup({ evaluate, until, clickVisible, clickLastVisible }, check) {
  /* A CLICK WHOSE ANSWER IS THROWN AWAY turns "the control was not there" into
   * twenty seconds of silence blamed on whatever we polled for NEXT.
   *
   * Every red driver in RELEASE-CUT-TRAPS-2026-08-15 section 12 reports the
   * same sentence -- "gave up waiting for the review" -- and not one of them
   * can say whether the review failed to draw or the click before it never
   * landed. That is not a small difference: the first is a product defect and
   * the second is a harness defect, and a whole diagnostic pass was spent
   * without being able to tell them apart. clickVisible already answers
   * absent / not-visible / clicked for exactly this reason. The walk simply
   * discarded it.
   *
   * This records the answer and keeps walking rather than returning early: the
   * abort would be a control-flow change these packaged drivers cannot be
   * re-run here to validate, and the diagnostic value is the same either way --
   * the named failure lands in the log BEFORE the misattributed one, so the
   * reader can see which came first. */
  const press = async (click, selector, what) => {
    const outcome = await click(selector)
    const ok = outcome === 'clicked'
    check(`the walk can press ${what}`, ok, `${selector} -> ${outcome}`)
    return ok
  }

  const onSetup = await until('the permission question', `location.hash === '#/setup'`)
  check('a fresh profile opens on the permission question', onSetup, `hash=${await evaluate('location.hash')}`)
  if (!onSetup) return false
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

/* THE PREREQUISITE, IN A PERSON'S WORDS.
 *
 * THE ASSERTION IS AGAINST THE COPY MODULE, NOT AGAINST A REGEX I TYPED HERE, and
 * that is the difference between this suite and one that cannot fail. The defect
 * class in this codebase is a helper that exists while the call site still names
 * a literal -- the module is right, the screen is wrong, and a source-text check
 * waves it through. So the sentences below are READ FROM src/first-run-needs.js
 * and looked for on the glass. Change the copy and this follows; wire a screen to
 * something else and this goes red.
 *
 * The `mechanismOnly` pattern is the other half. A screen passes only if it has
 * the explanation as well; matching "fleet projection unavailable" alone would
 * pass the exact refusal this finding is about. */
/* A distinctive clause OF the module's own sentence, not a phrase typed here: it
   is sliced out of the live value, so a rewrite of the copy that drops this
   clause fails loudly at startup instead of silently measuring nothing. */
const EXPLANATION = hostAbsentNotice('probe').body
const EXPLAINS_CLAUSE = 'a program that watches the agents running on a group of computers'
if (!EXPLANATION.includes(EXPLAINS_CLAUSE)) {
  console.error('\nNO VERDICT: the clause this suite looks for is no longer in the copy module.')
  console.error(`  looked for: ${JSON.stringify(EXPLAINS_CLAUSE)}`)
  console.error(`  the module says: ${JSON.stringify(EXPLANATION)}`)
  process.exit(2)
}
const MECHANISM_ONLY = /fleet projection unavailable|ops projection unavailable/i

/* THE COMMS BOARD HAS TWO INTENDED EMPTY STATES, AND WHICH ONE SHOWS IS A
 * PROPERTY OF THE PAYLOAD, NOT OF THIS REPO.
 *
 * The board's message pane is read at run time through the shell
 * (`mc-agent:local-messages` -> the capability payload's agent-comms-local.js
 * ownerJournal()). A payload WITHOUT that reader refuses the read, and the
 * board falls back to the host-absent notice -- EXPLAINS_CLAUSE above. A
 * payload WITH it answers a sterile profile ok-and-empty, the board takes its
 * live branch, and the honest sentence is the quiet notice: the record was
 * read and there is nothing in it. Calling that an absent host would blame a
 * read that worked.
 *
 * MEASURED, 2026-08-19, when the re-cut confirming run took this suite
 * 45/47: the previous cut's staged copy (Temp\first-run-recovery-t9LvJB,
 * payload files of 08-13) has NO agent-comms-local.js -- its board showed the
 * host-absent notice and this suite was green against it. The re-cut's
 * payload carries the reader, the board went quiet-and-doorless, and both
 * comms checks went red with src/views/comms.js UNCHANGED in the commit
 * window (a3e9f85..0485034 touches neither comms.js nor first-run-needs.js;
 * capability/ is not even tracked). The product now says why it is quiet in
 * the module's words below and keeps the door; this suite accepts EITHER
 * intended state and still fails a board that explains in neither. */
const QUIET = commsQuietNotice().body
const QUIET_CLAUSE = 'no agent here has sent another agent a message'
if (!QUIET.includes(QUIET_CLAUSE)) {
  console.error('\nNO VERDICT: the quiet-board clause this suite looks for is no longer in the copy module.')
  console.error(`  looked for: ${JSON.stringify(QUIET_CLAUSE)}`)
  console.error(`  the module says: ${JSON.stringify(QUIET)}`)
  process.exit(2)
}

async function main() {
  auditSelf()
  const scratch = mkdtempSync(path.join(tmpdir(), 'first-run-recovery-'))
  const checks = []
  const check = (what, ok, detail = '') => {
    checks.push({ name: what, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  let app = null
  try {
    const executable = await stage(scratch)
    console.log(`staged a copy at ${executable}`)
    app = await openApp(executable, scratch, 'sterile')
    const { evaluate, until, clickVisible, shoot } = app

    console.log('\n== first run, sterile profile, no fleet host, no Codex ==')
    if (!await walkSetup(app, check)) return 1
    await delay(1500)

    /* ---------- HOME ---------- */
    const home = await evaluate(SCREEN)
    note(`home: ${home.screen.slice(0, 400)}`)
    /* Home deliberately stopped calling this computer "connected" in the LAN
       sense. That word was the only account-looking claim on the first screen,
       but its old guide door did not connect the computer to the account a
       person had just made. The current recovery contract is stronger and more
       direct: the first screen names the account action and opens its real row. */
    check('home offers the real account-connection door',
      home.exits.some(exit => exit.href === CONNECT_HREF
        && /connect this computer to your toolsenabled account/i.test(exit.text)),
      JSON.stringify(home.exits))
    await shoot('01-home')

    /* ---------- FLEET GRAPH ---------- */
    const toComputers = await clickVisible('#nav-next')
    check('the forward chevron reaches the fleet graph', toComputers === 'clicked', String(toComputers))
    await until('the computers page', `document.body.dataset.route === 'computers'`)
    await delay(1800)
    const computers = await evaluate(SCREEN)
    note(`fleet graph: ${computers.screen.slice(0, 500)}`)
    /* WHAT THIS CHECK USED TO ASK FOR, AND WHY THE PAGE NO LONGER OWES IT.
     *
     * It required the envelope explanation -- "a program that watches the agents
     * running on a group of computers" -- on this screen, because when it was
     * written the fleet graph's whole answer to a fresh install was the
     * unavailable state, and an unexplained refusal was the defect. 6f0a34a
     * ("Page 2: put THIS computer on the fleet page, so a fresh install has an
     * agent") changed what the screen IS: it now draws this computer from the
     * organisation this copy declares, so the person is looking at their own
     * machine rather than at a sentence about a host that is missing. Demanding
     * the explanation of a missing host on a page that is no longer describing
     * one would be asking the product to apologise for something it now does.
     *
     * What it still owes, and what is asserted instead: the machine in front of
     * the person is ON the page, the page says where that came from rather than
     * letting it read as observed telemetry, and the way out is still offered.
     * The verbatim refusal is kept as a NOTE: the projection still carries it
     * (declaredAgentsData's observedSessions.reason) and the drill-in still
     * prints it, but it is no longer required to be on this screen. */
    check('the fleet graph puts this computer on the page rather than a missing host',
      /this computer/i.test(computers.screen), computers.screen.slice(0, 300))
    check('the fleet graph says where what it is showing came from',
      /(signed record|team record saved on this computer|declar)/i.test(computers.screen),
      computers.screen.slice(0, 300))
    if (/No local agent fleet host detected on this machine/i.test(computers.screen)) {
      note('the fleet graph also still carries the verbatim host refusal')
    }
    await shoot('02-fleet-graph')
    check('the fleet graph offers the guide',
      computers.guideLinks > 0, JSON.stringify(computers.exits))

    /* ---------- METRICS, RESEARCH, LEDGER on the way round ----------
       The finding named four screens. The directive says EVERY unavailable-host
       state, and these three reach the same one on the same install, so they are
       walked and read rather than assumed. Metrics is reported rather than
       asserted: see the note at the bottom of reports/lanes/team2-b5.md. */
    const onTheWay = {}
    for (const step of ['metrics', 'research', 'comms']) {
      await clickVisible('#nav-next')
      await until(`the ${step} page`, `document.body.dataset.route === '${step}'`)
      await delay(1400)
      onTheWay[step] = await evaluate(SCREEN)
    }
    note(`metrics: ${onTheWay.metrics.screen.slice(0, 260)}`)
    /* Metrics carries the DOOR and not the explanation, on purpose: it reports
       its absence per component, eight times, and an explanation repeated eight
       times would bury the page. So this asserts the way out exists, not that the
       paragraph is on it. */
    check('the metrics page offers the guide',
      onTheWay.metrics.guideLinks > 0, JSON.stringify(onTheWay.metrics.exits))
    /* 61262ac: "The research page said its report library 'could not be read'.
       It was never shipped." The envelope explanation belonged to the old
       sentence, which described a read that failed. There was no failed read:
       this copy ships with no report library at all, and the page now says that
       and says what a report library is. Requiring the old clause here would be
       requiring the page to go back to explaining a failure that never
       happened. */
    /* ASSERTED ON THE SENTENCE, NOT ON THE ABSENCE OF A PHRASE ANYWHERE ON THE
       SCREEN. The first version of this check also required that the words
       "could not be read" appear NOWHERE in the page's text -- and this screen
       carries several other regions that legitimately say a thing could not be
       read. That is a rule about the whole page dressed up as a rule about one
       sentence, and it went red on a page that says exactly the right thing. */
    check('the research page says its report library was never shipped, rather than that a read failed',
      /was not shipped with one/i.test(onTheWay.research.screen)
        && !/report library.{0,40}could not be read/i.test(onTheWay.research.screen),
      onTheWay.research.screen.slice(0, 260))
    check('the research page offers the guide',
      onTheWay.research.guideLinks > 0, JSON.stringify(onTheWay.research.exits))
    await delay(1800)
    const comms = await evaluate(SCREEN)
    note(`comms board: ${comms.screen.slice(0, 500)}`)
    check('the comms board explains why there is no traffic, in the copy module\'s words',
      comms.screen.includes(EXPLAINS_CLAUSE) || comms.screen.includes(QUIET_CLAUSE),
      comms.screen.slice(0, 300))
    check('the comms board no longer leaves the bare refusal as the only thing on it',
      !MECHANISM_ONLY.test(comms.screen) || comms.screen.includes(EXPLAINS_CLAUSE),
      comms.screen.slice(0, 300))
    await shoot('03-comms-board')
    check('the comms board offers the guide',
      comms.guideLinks > 0, JSON.stringify(comms.exits))

    /* ---------- LEDGER ---------- */
    await clickVisible('#nav-next')
    await until('the ledger page', `document.body.dataset.route === 'ledger'`)
    await delay(1600)
    const ledger = await evaluate(SCREEN)
    note(`ledger: ${ledger.screen.slice(0, 260)}`)
    /* 1bdcce7: "The ledger promised it would fill in, and it never will." The
       envelope explanation carried an implicit promise -- that this is a view
       onto a fleet which, once connected, would populate this register. It will
       not: this register lists requests recorded while ToolsEnabled itself is
       being built, and on a customer's machine it is empty for good. So the
       page says what the register IS, and that is what is checked. */
    check('the ledger says what this register is, instead of promising it will fill in',
      /requests recorded while ToolsEnabled itself is being built/i.test(ledger.screen),
      ledger.screen.slice(0, 260))
    check('the ledger offers the guide', ledger.guideLinks > 0, JSON.stringify(ledger.exits))

    /* ---------- SETTINGS ---------- */
    const gear = await clickVisible('#open-settings')
    check('the gear opens the drawer', gear === 'clicked', String(gear))
    await delay(400)
    const toSettings = await clickVisible('.drawer-all')
    check('the drawer reaches the settings page', toSettings === 'clicked', String(toSettings))
    await until('the settings page', `document.body.dataset.route === 'settings'`)
    await delay(1200)
    /* The rail's groups ship collapsed; open them the way a person does, so the
       exact categories this driver wants are buttons on the screen. */
    await evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
    await delay(400)
    const toScreens = await clickVisible('.settings-rail button[data-category="What the screens show"]')
    check('the settings rail reaches What the screens show', toScreens === 'clicked', String(toScreens))
    await delay(700)
    const screensSettings = await evaluate(SCREEN)
    /* This is the current version of the old "live-source switches are not the
       missing thing" contract. There is one example-mode switch now, and its
       note must say both that it does not connect anything and that it cannot
       make an empty live record non-empty. */
    check('settings says the example switch is not the missing connection',
      /does not connect anything/i.test(screensSettings.screen)
        && /this switch does not change that/i.test(screensSettings.screen),
      screensSettings.screen.slice(0, 500))
    check('What the screens show offers the guide',
      screensSettings.guideLinks > 0, JSON.stringify(screensSettings.exits.slice(0, 12)))
    await shoot('04-settings')

    /* The guide's install/readiness controls live behind Setup. Reach that
       category by name rather than assuming a rail position or trying to use
       the guide link from whatever category happens to be selected. */
    const toSetup = await clickVisible('.settings-rail button[data-category="Setup"]')
    check('the settings rail reaches Setup', toSetup === 'clicked', String(toSetup))
    await delay(700)
    const setupSettings = await evaluate(SCREEN)
    check('Setup offers the guide', setupSettings.guideLinks > 0, JSON.stringify(setupSettings.exits.slice(0, 12)))
    await shoot('04b-settings-setup')

    /* ---------- AND THE GUIDE IS REACHABLE BY PRESSING THE LINK ---------- */
    const pressed = await clickVisible(`a[href="${GUIDE_HREF}"]`)
    check('the door to This computer can be pressed', pressed === 'clicked', String(pressed))
    /* IT LANDS ON THE ROW, NOT MERELY ON SETTINGS. The page it used to open was
       a stop of its own; the answer now lives in one section of a page with
       hundreds of rows, so "settings is on screen" is not the same claim and
       would pass while the reader was six screens above the answer. */
    const atGuide = await until('the This computer row', `document.body.dataset.route === 'settings' && location.hash.includes('setting=this_computer_programs')`, 40)
    check('pressing it lands on the This computer row', atGuide, `hash=${await evaluate('location.hash')}`)
    await delay(600)
    const guide = await evaluate(SCREEN)
    note(`guide: ${guide.screen.slice(0, 700)}`)
    /* EVERY SENTENCE THE MODULE DECLARES IS ON THE PAGE. A guide that renders two
       of its three sections is the same defect as no guide, one screen further
       along, and only walking the data catches it. */
    for (const need of FIRST_RUN_NEEDS) {
      check(`the guide renders the "${need.id}" section`, guide.screen.includes(need.title), need.title)
      for (const step of need.steps) {
        check(`the guide shows the step: ${step.text.slice(0, 46)}`,
          guide.screen.includes(step.text), step.text)
      }
    }
    /* The two things a person on a bare machine actually needs, asserted on the
       glass rather than inferred from the section titles above. */
    /* IT USED TO BE "the guide gives the exact command that makes agents work
       here", matching `winget install OpenAI.Codex` on the glass. There is no
       command on the glass any more, and its absence is the repair rather than
       a regression: the guide printed an install line and a sign-in line for a
       person to copy, and the first external user copied them into one window
       and was told "'codex' is not recognized". The page installs and signs in
       at the press of a button now, for all three programs, and what has to be
       on the glass is the offer -- said in the section's own words, which are
       static and therefore true even on a machine whose presence read never
       answers. */
    check('the guide offers to install and sign in rather than printing a command',
      /two buttons: Install/i.test(guide.screen), guide.screen.slice(0, 240))
    check('the guide prints no install-or-sign-in command for anybody to copy',
      !/winget install|npm install -g|codex login|claude auth/i.test(guide.screen), guide.screen.slice(0, 400))
    check('the guide says plainly that nothing here connects a host',
      /no setting that connects one and no command that installs one/i.test(guide.screen),
      guide.screen.slice(0, 400))
    /* IT USED TO BE `exits.some(href === '#/settings')`, and that check stopped
       measuring anything the day this stopped being a page of its own: the
       reader IS in Settings now, so a link back to Settings is either absent or
       trivially satisfied, and either way it says nothing about being trapped.
       What "leads back into the product" means here is that the rest of Settings
       is still standing beside the section -- the rail, with its categories --
       and that the row the address named is actually on the glass. */
    const notTrapped = await evaluate(`(() => {
      const rail = document.querySelector('.settings-rail')
      const row = document.querySelector('[data-setting-id="this_computer_programs"]')
      const shown = node => { const box = node?.getBoundingClientRect(); return Boolean(box && box.width > 0 && box.height > 0) }
      return JSON.stringify({ rail: shown(rail), row: Boolean(row) })
    })()`)
    check('the section stands inside Settings, with the way out still on screen',
      notTrapped === JSON.stringify({ rail: true, row: true }), String(notTrapped))
    /* THE GUIDE IN ALL THREE THEMES, pressed from the drawer the way a person
       changes theme. A reading page whose ink comes from theme tokens should
       follow with no rules of its own; the only way to know it does is to look. */
    for (const theme of ['white', 'tan', 'black']) {
      await clickVisible('#open-settings')
      await delay(250)
      const picked = await clickVisible(`#theme-seg button[data-theme="${theme}"]`)
      check(`the guide can be read on the ${theme} theme`, picked === 'clicked', String(picked))
      await delay(250)
      await evaluate(`document.getElementById('close-settings').click()`)
      await delay(400)
      await shoot(`05-guide-${theme}`, { whole: true })
      /* AND THE HALF BELOW THE FOLD. This app scrolls inside its own stage, not
         the document, so captureBeyondViewport returns the viewport and nothing
         more -- the first version of this shot silently proved only the top of
         the page. Scroll the real container and take a second frame. Scrolling
         is not navigation; a person does it with a wheel. */
      const scrolled = await evaluate(`(() => {
        let node = document.querySelector('[data-setting-id="this_computer_programs"]')
        while (node && node !== document.body) {
          if (node.scrollHeight - node.clientHeight > 40) {
            node.scrollTop = node.scrollHeight
            return node.className || node.id || 'unnamed'
          }
          node = node.parentElement
        }
        return null
      })()`)
      if (theme === 'white') {
        check('the guide is longer than one screen and scrolls', Boolean(scrolled), String(scrolled))
      }
      await delay(350)
      await shoot(`06-guide-${theme}-bottom`)
    }

    /* THE ARROWS MUST NOT STRAND ANYONE ON IT. The guide is off the ring, so a
       person who presses forward has to come back to the product rather than
       walking into a stop that is not there. */
    const forward = await clickVisible('#nav-next')
    check('the forward arrow leaves the guide', forward === 'clicked', String(forward))
    const backHome = await until('home', `document.body.dataset.route === 'home'`, 40)
    check('and it lands on home', backHome, `hash=${await evaluate('location.hash')}`)
  } finally {
    if (app) await app.teardown()
    if (KEEP) console.log(`\nkept the scratch directory at ${scratch}`)
    else {
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) }
      catch (error) { console.log(`\ncould not remove the scratch directory (${error.code || error.message}); it is at ${scratch}`) }
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
