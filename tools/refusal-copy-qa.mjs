#!/usr/bin/env node

// B6 — DOES ANY REFUSAL IN THE RUNNING PRODUCT PUT A BARE IDENTIFIER IN FRONT OF A
// PERSON, AND DOES EVERY REFUSAL SAY WHAT TO DO? MEASURED BY DRIVING REFUSALS IN THE
// PACKAGED WINDOW, ON A STERILE PROFILE, BY PRESSING THE CONTROLS.
//
// WHY A DRIVER AND NOT A TEST. tools/test/refusal-copy.test.mjs holds the copy module
// to its rule and can prove every sentence it returns is actionable. It cannot prove
// the product CALLS it: the nine sites this lane repaired all existed while
// src/agent-availability-copy.js was already correct next door. The only instrument
// that can tell those two apart is one that presses a control and reads the glass.
//
// WHAT IT DOES, in order:
//   1. Walks every screen a person can reach by clicking and reads all VISIBLE text,
//      looking for anything shaped like one of this product's identifiers. This is the
//      sweep: it finds refusals nobody thought to look at, including ones that have not
//      been written yet.
//   2. Turns on the two write actions whose controls can refuse (Dispatch, Codex Cloud)
//      through the Settings toggles a person would use, then presses those controls and
//      reads what comes back. This is the drive.
//
// WHAT COUNTS AS A FAILURE, stated before anything is measured:
//   BARE     — visible text contains a token matching /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/.
//              That is this product's identifier shape. It is deliberately not limited
//              to the START of a line: the first repair of this defect class elsewhere
//              moved the code to the end, which is the same defect.
//   MUTE     — a control that refused produced text with no action in it, or produced
//              a fragment too short to act on.
// A refusal that never happened is NOT a pass. Every drive below reports whether the
// control actually refused, and a control that could not be reached is reported as
// UNMEASURED, never as ok.
//
// ISOLATION — the same mechanisms tools/first-run-recovery-qa.mjs uses and for the same
// reasons: --user-data-dir moves userData and the single-instance lock; LOCALAPPDATA,
// USERPROFILE, APPDATA, CODEX_HOME and PATH are rebuilt so nothing reads the owner's
// machine. ELECTRON_RUN_AS_NODE is stripped, or the binary runs headless and exits 0,
// which is indistinguishable from a crash.
//
// THE OWNER'S LIVE ENGINE IS NEVER TOUCHED. This starts its own packaged copy from a
// staged directory. NOTHING IS SPENT: the Codex Cloud control is pressed on a profile
// with no cloud account, which is why it refuses; it is the refusal that is being
// measured, and a launch that succeeded would be reported as UNMEASURED, not as a pass.
//
// RUN IT:
//   node tools/refusal-copy-qa.mjs
//   node tools/refusal-copy-qa.mjs --keep            keep the scratch dir
//   --release <dir>        default release/win-unpacked
//   --open-timeout-ms <n>  how long to wait for the window (default 120000)
//
// EXIT CODE HAS THREE VALUES AND ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED — a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/* The rule is imported from the module the product uses, never retyped here. A
   suite that carries its own copy of the pattern passes the day somebody widens
   the product's. Both modules are plain data with no DOM. */
import { IDENTIFIER_RE } from '../src/refusal-copy.js'
import { GUIDE_HREF } from '../src/first-run-needs.js'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* The fleet page opens with an EMPTY tree by the product's own rule, so the
   node these controls hang off has to be made first. See tools/lib/fleet-node.mjs;
   nothing is spent, because the start is refused by a signed-out engine and the
   node is written before the engine is asked. */
import { startFleetNode } from './lib/fleet-node.mjs'
import { environmentFor as credentialSafeEnvironment } from './test-account-harness.mjs'
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

class HarnessError extends Error {}

/* THE INSTRUMENT AUDITS ITSELF. A suite that reaches a screen by assigning the hash is
   not measuring whether a person can reach it, and the failure is silent. */
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

/* THE RULE, EXPRESSED ONCE. `IDENTIFIER_RE` is anchored -- it answers "is this WHOLE
   string a code" -- and what a sweep needs is "does this text CONTAIN one", so the
   source is reused with the anchors dropped rather than a second pattern being typed.
   If the product's idea of an identifier changes, this follows it. */
const EMBEDDED_IDENTIFIER = new RegExp(IDENTIFIER_RE.source.replace(/^\^/, '\\b').replace(/\$$/, '\\b'), 'g')

/* Words that are SCREAMING_SNAKE on the glass legitimately. Each one is a false
   positive that has to be named to be excluded, so the list stays short and every
   entry is a decision somebody made rather than a pattern that quietly widened. */
const ALLOWED = new Set([
  'BUILD_QUEUE',   // the file's real name, quoted in the guide
])

function identifiersIn(text) {
  return [...String(text || '').matchAll(EMBEDDED_IDENTIFIER)]
    .map(match => match[0])
    .filter(token => !ALLOWED.has(token))
}

/* A COPY is run, never release/win-unpacked itself: the GUI writes state/ next to the
   binary, so running the artifact in place mutates the artifact. dist/ and shell/ come
   from the working tree so this measures what is actually here. */
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

/* WAS A SEVENTH COPY OF THE SAME RULE, AND OFF WINDOWS EVERY COPY WAS WRONG.
   This function read `.exe` out of the app root; a Linux candidate has none, so
   it refused before measuring anything. tools/lib/packaged-platform.mjs owns
   the one answer -- the same Windows launcher-by-shape logic, plus an ELF
   branch that opens the file with O_NOFOLLOW and checks the magic. */

/* A PATH with nothing on it but Windows itself, built from a fixed list rather than
   filtered out of the real one: filtering fails OPEN. */
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
  const environment = credentialSafeEnvironment(profile)
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
  /* Press a control found by the WORDS ON IT, which is how a person finds it. */
  const clickByText = async (selector, text) => evaluate(`(() => {
    const wanted = ${JSON.stringify(String(text).toLowerCase())}
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      if (!(box.width > 0 && box.height > 0)) return false
      if (style.visibility === 'hidden' || style.display === 'none') return false
      return (node.innerText || node.textContent || '').toLowerCase().includes(wanted)
    })
    if (!nodes.length) return 'absent'
    nodes[0].click()
    return 'clicked'
  })()`)

  return { evaluate, until, clickVisible, clickLastVisible, clickByText, teardown, noise, session }
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

/* innerText, never innerHTML or textContent: a string in the DOM that no pixel
   renders is not something a person read, and counting it would make this suite
   fail on copy nobody can see. */
const VISIBLE_TEXT = `(() => String(document.body.innerText || '').replace(/\\s+/g, ' ').trim())()`

/* THE WALKTHROUGH, WALKED THE WAY A PERSON WALKS IT — one loop, not a fixed
 * script of presses.
 *
 * A step-by-step script was written first and it was WRONG, in the way that
 * costs a whole run: each press was fired once, so a press that arrived while
 * the step it belonged to was still settling did nothing, and the suite then
 * reported "the walkthrough never reached its review" — a statement about the
 * product, from a fault in the harness. It failed on the FIRST step twice and
 * passed twice, which is the signature of a race and not of a defect.
 *
 * So this presses whatever forward control is currently enabled, looks at where
 * it is, and presses again — bounded, and reporting the step it is stuck on
 * rather than a guess. Nothing here reaches past the walkthrough's own
 * controls: the tier choice and the autonomy choice are made because the
 * walkthrough will not move until they are, and both are made by clicking the
 * option a person would click.
 */
async function walkSetup({ evaluate, until, clickVisible, clickLastVisible }, note) {
  const onSetup = await until('the permission question', `location.hash === '#/setup'`)
  if (!onSetup) { note(`did not land on setup; hash=${await evaluate('location.hash')}`); return false }

  const section = () => evaluate(`String(document.querySelector('[data-setup-section]')?.innerText || '').replace(/\\s+/g, ' ')`)
  let lastSeen = ''
  for (let step = 0; step < 60; step += 1) {
    if (await evaluate(`location.hash === '#/' || location.hash === ''`)) return true
    const text = await section()
    lastSeen = text

    /* The two questions that must be ANSWERED before their step will move. Both
       are clicked only when nothing is chosen yet, so pressing again later
       cannot un-choose one. */
    if (/Permission level/i.test(text)) {
      await clickVisible('[data-setup-tier][aria-pressed="false"]')
    }
    if (/without asking/i.test(text) && !(await evaluate(`document.querySelector('[data-setup-set="autonomy"][aria-pressed="true"]') !== null`))) {
      await clickVisible('[data-setup-set="autonomy"][data-setup-value="assisted"]')
      await delay(250)
    }
    /* The folder step resolves a path asynchronously and its forward control
       stays disabled until it has one; waiting for that is waiting for the
       product, not for the harness. */
    if (/Which folder/i.test(text)) {
      await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`, 40)
    }
    if (/Checking whether Codex/i.test(text)) {
      await until('the readiness answer', `!document.querySelector('[data-setup-section]')?.innerText.includes('Checking whether Codex')`, 60)
    }

    const pressed = await clickLastVisible('[data-setup-next]:not([disabled]), [data-setup-continue]:not([disabled])')
    if (pressed !== 'clicked') await delay(400)
    await delay(500)
  }
  note(`the walkthrough never finished; it was showing: ${lastSeen.slice(0, 400)}`)
  return false
}

async function main() {
  auditSelf()
  const scratch = mkdtempSync(path.join(tmpdir(), 'refusal-copy-'))
  const checks = []
  const check = (what, ok, detail = '') => {
    checks.push({ name: what, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)
  const started = Date.now()
  let app = null

  try {
    console.log(`\nstaging a copy of ${RELEASE}`)
    const executable = await stage(scratch)
    console.log(`opening ${path.basename(executable)} on a sterile profile`)
    app = await openApp(executable, scratch, 'sweep')

    const walked = await walkSetup(app, note)
    check('the walkthrough ends in the app, so the screens below are the ones a person reaches', walked,
      `hash=${await app.evaluate('location.hash')}`)
    if (!walked) return

    /* ---------------------------------------------------------------- SWEEP */
    /* Reached by pressing the ring and the arrows, never by assigning a hash.
       The ring is the product's own navigation; a screen this cannot reach by
       pressing is a screen a person cannot reach either. */
    const seen = []
    const record = async (label) => {
      await delay(700)
      const text = await app.evaluate(VISIBLE_TEXT)
      const hash = await app.evaluate('location.hash')
      const found = identifiersIn(text)
      seen.push({ label, hash, found, length: text.length })
      note(`${label} (${hash || '#/'}): ${text.length} characters visible, ${found.length} identifier(s)`)
      return found
    }

    await record('home')
    /* The forward arrow is the ring. Press it until it comes back to where it
       started, so this walks whatever screens the product actually has rather
       than a list typed here that can go stale. */
    const visited = new Set([await app.evaluate('location.hash')])
    for (let step = 0; step < 12; step += 1) {
      /* #nav-next is the forward arrow, and per src/main.js the two arrows are
         the ONLY navigation this product has. Walking with it is therefore the
         same tour a person takes, in the same order. */
      const pressed = await app.clickVisible('#nav-next')
      if (pressed !== 'clicked') { note(`the forward arrow was ${pressed} after ${step} steps`); break }
      await delay(600)
      const hash = await app.evaluate('location.hash')
      if (visited.has(hash)) { note(`the ring came back to ${hash || '#/'} after ${step + 1} steps`); break }
      visited.add(hash)
      await record(`ring step ${step + 1}`)
    }
    check('the ring walk reached more than one screen', seen.length > 1, `${seen.length} screens read`)

    const sweepOffences = seen.filter(entry => entry.found.length > 0)
    check('no screen a person walks to shows a bare identifier', sweepOffences.length === 0,
      sweepOffences.map(entry => `${entry.label}: ${entry.found.join(', ')}`).join(' | ') || `${seen.length} screens clean`)

    /* ---------------------------------------------------------------- DRIVE */
    /* The two write actions whose controls can refuse are off by default (they
       fail closed, deliberately). They are turned on the way a person turns
       them on -- by pressing the toggle in Settings -- because a driver that
       wrote the storage key directly would pass on a build where the toggle is
       broken. */
    /* THE THREE SCREENS THE RING DOES NOT STOP AT. Settings, the This computer
       section and the account page are reached from doors rather than from the arrows, so a
       ring walk alone would report "the whole product is clean" having never
       opened them. Named here so the coverage this suite claims is the
       coverage it has. */
    for (const [label, selector] of [
      ['the This computer section', `a[href="${GUIDE_HREF}"]`],
      ['the account page', 'a[href="#/account"]'],
    ]) {
      if (await app.clickVisible(selector) !== 'clicked') { note(`${label} has no door on this screen`); continue }
      await delay(900)
      const found = await record(label)
      if (found.length === 0) note(`${label} is clean`)
      await app.clickVisible('#nav-back')
      await delay(600)
    }

    const settingsReached = await app.clickByText('a[href="#/settings"], button', 'settings')
      === 'clicked' && await app.until('the settings screen', `location.hash === '#/settings'`)
    check('Settings is reachable by pressing a control', settingsReached,
      `hash=${await app.evaluate('location.hash')}`)
    if (settingsReached) {
      /* EVERY CATEGORY IS ITS OWN PAGE, so the sweep walks them. Reading
         "settings" now reads ONE of twelve pages, and the eleven unread ones
         are exactly where a bare identifier would sit unnoticed. The rail's
         groups ship collapsed, so they are opened first -- the same gesture
         that used to open the group heads in the main column. */
      const categories = await app.evaluate(`(() => {
        for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
        return [...document.querySelectorAll('.settings-rail button[data-category]')].map(node => node.dataset.category)
      })()`)
      note(`settings offers ${categories?.length || 0} categories`)
      for (const category of categories || []) {
        const selector = `.settings-rail button[data-category=${JSON.stringify(category)}]`
        await app.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
        await delay(600)
        await record(`settings: ${category}`)
      }
      /* The three switches pressed below are all on the page that holds the
         acting switches, so that is the page left open. */
      await app.evaluate(`location.hash = '#/settings?category=things-it-may-do-for-you'`)
      await delay(900)
    }
    const doorOffences = seen.filter(entry => entry.found.length > 0)
    check('no screen reached through a door shows a bare identifier either', doorOffences.length === 0,
      doorOffences.map(entry => `${entry.label}: ${entry.found.join(', ')}`).join(' | ') || `${seen.length} screens read in total`)

    let flagsOn = false
    if (settingsReached) {
      flagsOn = await app.evaluate(`(() => {
        /* Find each write toggle by the words next to it, press it, and report
           what the storage says afterwards -- so "the toggle moved" and "the
           product believes it" are two facts, not one assumption. */
        const wanted = [
          { label: 'Dispatch agent lanes', settingId: 'write_dispatch' },
          { label: 'Launch Codex Cloud tasks', settingId: 'write_cloud-launch' },
          /* The controls below hang off a node, and a node only exists once
             this person has started an agent on this computer. This is the
             switch that decides whether the product will let anything start. */
          { label: 'Run an agent session', settingId: 'write_agent-session' },
        ]
        const pressed = []
        for (const { label, settingId } of wanted) {
          /* THE ROW, NOT AN ANCESTOR OF IT. This used to be a
             querySelectorAll('*') sweep with .find(), which walks in DOCUMENT
             ORDER and therefore returns the OUTERMOST element whose text starts
             with the label -- a section container, not the row. Its first
             control in document order can be a reveal button, so this pressed
             the wrong thing and reported the write flag unmoved, which reads
             exactly like a product defect and is not one. Measured 2026-08-17.
             src/views/settings.js:395 gives every row a data-setting-id; use it,
             and keep the old sweep only as a fallback for a renamed row. */
          const row = document.querySelector('article[data-setting-id="' + settingId + '"]')
            || [...document.querySelectorAll('*')].reverse().find(node =>
              node.children.length <= 6
              && (node.innerText || '').trim().startsWith(label)
              && node.querySelector('button, input[type=checkbox], [role=switch]'))
          /* The toggle first: a row may carry other controls, and only this one
             is the setting. */
          const control = row?.querySelector('input[type=checkbox], [role=switch]')
            || row?.querySelector('button')
          if (!control) { pressed.push(label + ': no control'); continue }
          /* Report what the press DID, not just that one happened: a toggle
             that was already on reads the same as one that refuses to move. */
          /* ASK THE QUESTION THE CHECK'S NAME ASKS. Pressing blindly turned an
             already-ON toggle OFF and then reported that it "cannot be switched
             on" -- a green product reading as a defect. So: press only when it
             is off, and prove the control MOVES by pressing twice when it is
             already on, ending enabled either way. */
          const key = 'mc.write.' + settingId.replace('write_', '')
          const before = { checked: control.checked ?? null, stored: localStorage.getItem(key) }
          control.click()
          const mid = { checked: control.checked ?? null, stored: localStorage.getItem(key) }
          if (mid.stored !== 'enabled') control.click()
          const after = { checked: control.checked ?? null, stored: localStorage.getItem(key) }
          pressed.push(label + ': ' + before.stored + ' -> ' + mid.stored + ' -> ' + after.stored
            + (mid.stored !== before.stored ? ' (the control moves)' : ' (THE CONTROL DID NOT MOVE)'))
        }
        return JSON.stringify({
          pressed,
          dispatch: localStorage.getItem('mc.write.dispatch'),
          cloud: localStorage.getItem('mc.write.cloud-launch'),
          agentSession: localStorage.getItem('mc.write.agent-session'),
        })
      })()`)
      note(`write toggles: ${flagsOn}`)
    }
    const storage = (() => { try { return JSON.parse(flagsOn || '{}') } catch { return {} } })()
    const dispatchOn = storage.dispatch === 'enabled'
    const cloudOn = storage.cloud === 'enabled'
    check('the Dispatch write action can be switched on from Settings', dispatchOn, `mc.write.dispatch=${storage.dispatch}`)
    check('the Codex Cloud write action can be switched on from Settings', cloudOn, `mc.write.cloud-launch=${storage.cloud}`)
    check('the Run-an-agent-session write action can be switched on from Settings',
      storage.agentSession === 'enabled', `mc.write.agent-session=${storage.agentSession}`)

    /* Back to the fleet page by pressing, then into an agent's controls rail,
       then the control itself. Every step reports what it found so a run that
       cannot reach the control says UNMEASURED rather than quietly passing. */
    const drives = []
    /* An answer is WAITED FOR, not sampled after a fixed pause. The audited call
       behind these controls has a 30-second budget, and a fixed delay that
       expires first reports "the control produced no output" -- a harness
       failure dressed as a product failure, which is the one reading this suite
       must never produce. `settled` is a pending word going away, not merely
       any text: "dispatching…" is output too. */
    const drive = async (label, open, outputSelector) => {
      const reached = await open()
      if (!reached) { drives.push({ label, state: 'unmeasured', detail: 'the control could not be reached' }); return }
      const readOutput = `(() => {
        const node = document.querySelector(${JSON.stringify(outputSelector)})
        if (!node) return null
        return { text: String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
                 code: node.getAttribute('data-refusal-code') }
      })()`
      let last = null
      for (let attempt = 0; attempt < 140; attempt += 1) {
        last = await app.evaluate(readOutput)
        const settled = last?.text && !/…$|^checking|^dispatching|^reading|^recording|^waiting/i.test(last.text)
        if (settled) break
        await delay(250)
      }
      if (!last) { drives.push({ label, state: 'unmeasured', detail: `no element matched ${outputSelector}` }); return }
      if (!last.text) { drives.push({ label, state: 'unmeasured', detail: 'the control produced no output within 35s' }); return }
      drives.push({ label, state: 'measured', detail: last.text, code: last.code || null })
    }

    await drive('fleet page · Dispatch a lane', async () => {
      /* Home is one press BACK from the fleet page on the ring, so this reaches
         it the way a person does rather than by naming its address. */
      for (let step = 0; step < 10; step += 1) {
        if (await app.evaluate(`location.hash === '#/computers'`)) break
        if (await app.clickVisible('#nav-next') !== 'clicked') return false
        await delay(500)
      }
      if (!await app.until('the fleet page', `location.hash === '#/computers'`)) return false
      /* THIS USED TO WAIT FOR A CIRCLE THAT WAS NEVER GOING TO APPEAR. A
         sterile profile has started nothing, the tree is empty by the product's
         own rule, and the wait simply timed out -- so all three drives below it
         reported "the control could not be reached", which is UNMEASURED and
         reads, correctly, as a red. The node is made the way a person makes
         one, and the walk names the step that stopped if it stops. */
      const reached = await startFleetNode({ session: app.session, evaluate: app.evaluate, delay })
      if (!reached.ok) { note(`the fleet node walk stopped at ${reached.at}: ${reached.detail}`); return false }
      const there = await app.until('the launch control', `document.querySelector('[data-launch="dispatch"]:not([disabled])') !== null`, 40)
      if (!there) return false
      return await app.clickVisible('[data-launch="dispatch"]') === 'clicked'
    }, '[data-launch="out"]')

    /* CODEX CLOUD, DRIVEN WITHOUT SPENDING ANYTHING. The launch button is NOT
       pressed. The two lines measured here -- the accounts/environments read
       that happens on mount, and the "Refresh tasks" read -- go through the
       SAME refusal() helper in src/cloud-tasks-controller.js that the launch
       line does, so the copy under test is identical and nothing is created.
       Pressing Launch to measure a refusal would be measuring a refusal by
       risking the thing the refusal is about. */
    /* REFRESH WITH NO ACCOUNT SIGNED IN IS MEASURED ON THE ACCOUNTS LINE, NOT
       THE TASK LINE, and that is the behaviour under test rather than a
       convenience.

       This check used to press Refresh and wait for the TASK line to say
       something. It said the same thing the accounts line had already said --
       one condition, two 47-word paragraphs -- which is precisely the defect
       the owner filed against this panel. The repair made `refresh()` stop at
       the accounts read when there is no account to read as
       (src/cloud-tasks-controller.js: "WHEN THE ACCOUNTS LINE HAS ALREADY
       EXPLAINED THIS, SAY NOTHING"), so the task line is now deliberately
       silent in this state and the old wait could only ever time out.

       Asserting the task line here again would demand the duplication back. So
       the press is measured where the sentence now lives, and the silence of
       the task line is checked separately below -- which makes this driver
       defend the deduplication instead of fighting it. */
    await drive('Codex Cloud · Refresh tasks (a read; nothing is launched)', async () => {
      const there = await app.until('the cloud panel', `document.querySelector('[data-cloud="refresh"]') !== null`, 40)
      if (!there) return false
      return await app.clickVisible('[data-cloud="refresh"]') === 'clicked'
    }, '[data-cloud="environments-out"]')

    /* The other half of the same fact: one condition, one sentence. */
    {
      const taskLine = await app.evaluate(`(() => {
        const node = document.querySelector('[data-cloud="list-out"]')
        return node ? String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() : null
      })()`)
      check('the task line stays silent while the accounts line explains',
        taskLine === '' || taskLine === null,
        `task line: ${JSON.stringify(taskLine)} -- with no account signed in this condition is explained once, on the accounts line`)
    }

    await drive('Codex Cloud · the environments read that happens on its own', async () =>
      app.until('the environments line to say something',
        `(document.querySelector('[data-cloud="environments-out"]')?.textContent || '').trim().length > 0`, 60),
    '[data-cloud="environments-out"]')

    for (const entry of drives) {
      if (entry.state !== 'measured') {
        check(`DRIVEN: ${entry.label}`, false, `UNMEASURED — ${entry.detail}`)
        continue
      }
      const found = identifiersIn(entry.detail)
      check(`DRIVEN: ${entry.label} — no bare identifier`, found.length === 0,
        found.length ? `${found.join(', ')} in: ${entry.detail}` : entry.detail)
      check(`DRIVEN: ${entry.label} — says what to do`,
        entry.detail.length >= 60 && /\b(try|press|open|close|choose|pick|refresh|reload|check|look|correct|stop|start|wait|turn|reinstall|sign)\b/i.test(entry.detail),
        entry.detail)
      note(`  its identifier, carried where a person will not read it: ${entry.code || '(none)'}`)
    }

    /* The sweep, once more, AFTER the drives: a refusal that has been triggered
       is on the glass now and was not during the first walk. */
    const afterText = await app.evaluate(VISIBLE_TEXT)
    const afterFound = identifiersIn(afterText)
    check('no bare identifier on the glass after the controls have refused', afterFound.length === 0,
      afterFound.join(', ') || 'clean')
  } catch (error) {
    if (error instanceof HarnessError) {
      console.error(`\nNO VERDICT: ${error.message}`)
      process.exitCode = 2
      return
    }
    console.error(`\nNO VERDICT: the harness itself failed: ${error?.stack || error}`)
    process.exitCode = 2
    return
  } finally {
    if (app) await app.teardown()
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds files */ } }
    else console.log(`\nkept ${scratch}`)
  }

  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s`)
  if (failed.length) {
    console.log('failed:')
    for (const entry of failed) console.log(`  - ${entry.name}`)
  }
  process.exitCode = failed.length ? 1 : 0
}

await main()
