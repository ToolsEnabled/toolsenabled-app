#!/usr/bin/env node
/* THE OPERATOR'S PURCHASE LIST IS NOT IN THE PRODUCT, PROVEN ON THE PACKAGED WINDOW.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED. release/win-unpacked, as shipped, launched
 * in a sterile profile: one click on the back chevron from home landed on Checkout,
 * and the window read out "37 items - list prepared 8/11/2026 - spend cap $100.00 per
 * day from config/toolsenabled.policy.json ... by src/lib/providers/pay.js", the group
 * "Needed to ship", the line "Code signing certificate ... Everyone who downloads the
 * installer gets the full-screen blue panel with NO publisher name", and "WHY YOU
 * WANTED IT: You asked the price directly, R1203". Internal paths, internal request
 * ids, the operator's own second-person deliberations, and a written admission that
 * the installer is unsigned -- shipped to every stranger who installs this.
 *
 * WHY A SOURCE TEST COULD NOT HAVE CAUGHT IT. Every one of those strings was in a
 * data file that no source assertion had any reason to look at, reached through a
 * route that read as ordinary. What was wrong was the PAYLOAD and the RING, and both
 * are properties of the built artifact rather than of any line of source. So this
 * runs the packaged application and asks the two questions a customer's machine asks:
 * can I get to that screen, and are those bytes on my disk.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the second one is not decoration. Deleting the
 * screen would also have made the first half green, and it would have taken away a
 * surface the owner asked for by name ("all purchase windows 1 click away"). So the
 * run continues: it installs an invented test purchase list where an operator's own
 * install keeps one, restarts, and requires the checkout to come back and work. The
 * real operator list is private input and is never a release-gate dependency. A guard
 * that only proves an absence cannot tell "fixed" from "removed".
 *
 * NAVIGATION IS BY CLICKING. A sibling harness reached its page by assigning
 * location.hash and passed on a build where nothing routed there. auditSelf() below
 * holds this file to that against its own source: the only hash assignment permitted
 * is the forced-door test, which is the OPPOSITE claim (typing an address that must
 * refuse) and is marked as such on the line above it.
 *
 * ISOLATION IS MEASURED, NOT ASSUMED. app.getPath('userData') is where the purchase
 * list is read from, so a harness pointed at the wrong one would be reading -- and in
 * phase three WRITING -- this machine's real installation. Overriding APPDATA does not
 * move it (Electron resolves the Windows known folder, not the variable); the
 * --user-data-dir switch does. Rather than encode that as a belief, the run finds the
 * directory the app actually wrote renderer-prefs.json into and fails if it is not
 * inside the sterile profile. A lane once spent hours on a confident, wrong finding
 * because its harness had inherited this machine's state.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import {
  machineRecordProductDirectory, userDataFor,
  stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE,
} from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
/* Presses of the forward chevron: comfortably more than the ring is long, so a
   walk sees every stop the build offers whatever order they are in. Deliberately
   NOT the RING array from src/main.js -- a harness that imports the list it is
   checking cannot notice a stop going missing from it. */
const RING_STOPS = 10
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* The strings this defect was made of. Every one was read off the packaged window
 * before the fix; none of them may appear anywhere in the product's own payload. */
const LEAK_MARKERS = Object.freeze([
  'config/toolsenabled.policy.json',
  'src/lib/providers/pay.js',
  'Code signing certificate',
  'More info then Run anyway',
  'R1203',
])

/* A purchase list that belongs to nobody. It proves the product surface still
 * works without making a clean release worktree depend on the operator's
 * deliberately ignored private file. Every name and explanation is invented,
 * and the fixture is installed only in this run's sterile userData. */
function syntheticCatalog() {
  const now = new Date().toISOString()
  const item = (id, name, usd) => ({
    id,
    name,
    vendor: 'Example Vendor QAMARK-CATALOGUE',
    category: 'required-to-ship',
    cadence: 'annual',
    firstYearUsd: usd,
    renewalUsd: null,
    priceVerified: false,
    priceVerifiedDate: null,
    quantityMax: 1,
    defaultSelected: false,
    whatItIs: 'An invented line item that exists only so this screen can be tested.',
    whatBreaksWithout: 'Nothing. This list is synthetic and belongs to no one.',
    whyHeWantedIt: 'A test wrote it to prove the purchase surface still works.',
    sourceUrl: null,
    warning: null,
    blockers: [],
    notes: null,
  })
  return {
    version: 2,
    generatedAt: now,
    currency: 'USD',
    spendPolicy: { dailyLimitUsd: 100, source: 'a synthetic test policy', readAt: now },
    categories: [{
      id: 'required-to-ship',
      label: 'Synthetic group',
      blurb: 'Invented lines, present only so the purchase screen can be tested.',
    }],
    items: [item('qa-line-one', 'Synthetic line one', 12), item('qa-line-two', 'Synthetic line two', 34)],
  }
}

/* ---------- the instrument audits itself ---------- */
function auditSelf() {
  const lines = readFileSync(SELF, 'utf8').split('\n')
  return lines
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => /location\.hash\s*=/.test(line))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ at }) => !/FORCED DOOR:/.test(lines[at - 2] || ''))
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

/* WAS A SEVENTH COPY OF THE SAME RULE, AND OFF WINDOWS EVERY COPY WAS WRONG.
   This function read `.exe` out of the app root; a Linux candidate has none, so
   it refused before measuring anything. tools/lib/packaged-platform.mjs owns
   the one answer -- the same Windows launcher-by-shape logic, plus an ELF
   branch that opens the file with O_NOFOLLOW and checks the magic. */

/* The packaged build with THIS tree's dist/ and shell/ in it. Rebuilding the
 * installer for every run costs minutes and an electron-builder lock; repacking the
 * archive keeps the artifact real -- asar, resources/capability, the same exe -- while
 * carrying the change under test. */
async function stage(scratch) {
  // An explicit --release must preserve that candidate, not overlay this checkout.
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    const staged = await stageRelease(scratch)
    return { executable: staged.executable, archive: staged.archive }
  }
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')
  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first.`)
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
  return { executable: appExecutable(app), archive: path.join(app, 'resources', 'app.asar') }
}

/* Read the archive's own file list out of its header. Same format read as
 * tools/check-asar-manifest.mjs, and the same self-check: a walk that disagrees with
 * the header has not finished, and an unfinished walk cannot clear a payload. */
function archiveEntries(archivePath) {
  const { openSync, readSync, closeSync } = require_('node:fs')
  const fd = openSync(archivePath, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const jsonBuffer = Buffer.alloc(jsonLength)
    readSync(fd, jsonBuffer, 0, jsonLength, 16)
    const header = JSON.parse(jsonBuffer.toString('utf8'))
    const entries = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, full)
        else entries.push({ path: full, size: child.size, offset: Number(child.offset) })
      }
    }
    walk(header, '')
    const countHeaderFiles = (node) => Object.values(node.files || {})
      .reduce((total, child) => total + (child.files ? countHeaderFiles(child) : 1), 0)
    const baseOffset = 16 + Math.ceil(jsonLength / 4) * 4
    return { entries, headerCount: countHeaderFiles(header), baseOffset }
  } finally {
    closeSync(fd)
  }
}

function archiveText(archivePath, entry, baseOffset) {
  const { openSync, readSync, closeSync } = require_('node:fs')
  const fd = openSync(archivePath, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function seedMachineRecord(profile, appRoot, tier) {
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
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
      /* 90s, not 30s. This machine routinely has half a dozen other Electron
         windows up from other lanes, and a harness that gives up early reports a
         busy machine as a broken build. */
      for (let attempt = 0; attempt < 180; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before the debugger answered`)
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
      throw new Error('no debuggable page appeared within 90s')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* VISIBLE IS MEASURED. Text in the DOM is not text on the screen. */
const VISIBLE = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const box = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  return { state: 'visible', x: box.x + box.width / 2, y: box.y + box.height / 2 }
}`

/* userData, and therefore the purchase list, is the --user-data-dir the app is
 * launched with. Named once, here, so the phase that writes a list and the phase
 * that checks isolation cannot drift into meaning two different directories. */
function environmentFor(profile) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.APPDATA = path.join(profile, 'roaming')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.APPDATA, { recursive: true })
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  return environment
}

async function openWindow(executable, profile) {
  const port = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataFor(profile)}`], {
    env: environmentFor(profile), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const session = createSession(port, child)
  await session.open()
  const evaluate = async expression => {
    const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return packet?.result?.result?.value
  }
  const clickVisible = async selector => {
    const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(selector)})`)
    if (spot.state !== 'visible') return spot.state
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    await delay(450)
    return 'clicked'
  }
  await delay(2200)
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
  return { child, session, evaluate, clickVisible }
}

async function closeWindow(window) {
  try { window?.session?.close() } catch { /* already gone */ }
  try {
    if (window?.child && window.child.exitCode === null) {
      spawn('taskkill.exe', ['/PID', String(window.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      await delay(1400)
    }
  } catch { /* nothing to reap */ }
}

/** Walk the whole ring forward by clicking, recording every stop it lands on. */
async function walkRing(window, steps) {
  const visited = []
  for (let step = 0; step < steps; step += 1) {
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') return { visited, clicked }
    await delay(350)
    visited.push(await window.evaluate('document.body.dataset.route'))
  }
  return { visited, clicked: 'clicked' }
}

/** Every marker of the leak, anywhere in what the window is showing. */
async function markersOnScreen(window) {
  return window.evaluate(`(() => {
    const text = document.body.innerText || ''
    return ${JSON.stringify(LEAK_MARKERS)}.filter(marker => text.includes(marker))
  })()`)
}

async function main() {
  const offenders = auditSelf()
  if (offenders.length > 0) {
    for (const { line, at } of offenders) console.error(`  self-audit: line ${at} navigates by assigning the hash: ${line.trim()}`)
    console.error('A reachability suite that reaches the page by assigning the hash is not a reachability suite.')
    process.exitCode = 1
    return
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'checkout-privacy-qa-'))
  const strangerProfile = path.join(scratch, 'stranger')
  const operatorProfile = path.join(scratch, 'operator')
  let window = null

  try {
    const { executable, archive } = await stage(scratch)
    const appRoot = path.dirname(executable)

    /* ---------- 1. THE BYTES ---------- */
    const { entries, headerCount, baseOffset } = archiveEntries(archive)
    check('the archive reader finished, so its verdict means something',
      entries.length === headerCount, `${entries.length} entries vs header ${headerCount}`)

    const catalogEntries = entries.filter(entry => /purchase-catalog\.json$/.test(entry.path) && !/schema/.test(entry.path))
    check('the installer does not carry a purchase list at all',
      catalogEntries.length === 0, catalogEntries.map(entry => entry.path).join(', '))

    const textual = entries.filter(entry => /\.(js|json|html|css|md|txt|svg)$/i.test(entry.path))
    const marked = []
    for (const entry of textual) {
      const body = archiveText(archive, entry, baseOffset)
      const hits = LEAK_MARKERS.filter(marker => body.includes(marker))
      if (hits.length > 0) marked.push(`${entry.path} [${hits.join(', ')}]`)
    }
    check(`none of the ${LEAK_MARKERS.length} leaked strings survive anywhere in the payload`,
      marked.length === 0, marked.join(' | '))

    /* ---------- 2. A STRANGER'S FRESH INSTALL ---------- */
    seedMachineRecord(strangerProfile, appRoot, 'standard')
    window = await openWindow(executable, strangerProfile)

    check('a fresh profile opens past the permission question',
      (await window.evaluate('document.body.dataset.route')) !== 'setup',
      `route=${await window.evaluate('document.body.dataset.route')}`)

    /* WHERE IS THIS WINDOW'S userData, REALLY? renderer-prefs.json is written into it
       at startup, so the file's own location is the answer -- and if it is not inside
       the sterile profile, this run has been reading the real installation and every
       result below it is about the wrong machine. */
    const prefs = path.join(userDataFor(strangerProfile), 'renderer-prefs.json')
    const isolated = existsSync(prefs)
    check('the window is reading a sterile data directory, not this machine\'s own',
      isolated, `${prefs} exists=${isolated}`)
    if (!isolated) throw new Error('userData is not inside the harness profile; refusing to report on the wrong machine')

    const back = await window.clickVisible('#nav-back')
    const afterBack = await window.evaluate('document.body.dataset.route')
    check('one click back from home does not land on the purchase list',
      back === 'clicked' && afterBack !== 'checkout', `${back} route=${afterBack}`)

    const backMarkers = await markersOnScreen(window)
    check('and nothing of the operator\'s list is on that screen', backMarkers.length === 0, backMarkers.join(', '))

    const ring = await walkRing(window, RING_STOPS)
    check('walking the whole ring forward never reaches the purchase list',
      ring.clicked === 'clicked' && !ring.visited.includes('checkout'), ring.visited.join(' -> '))

    const fetched = await window.evaluate(`(async () => {
      try {
        const response = await fetch('data/purchase-catalog.json', { cache: 'no-store' })
        return { status: response.status, type: response.headers.get('content-type') }
      } catch (error) { return { status: 'threw', type: String(error && error.message) } }
    })()`)
    check('asking the shell for the list directly is refused, not answered with the app shell',
      fetched.status === 404, JSON.stringify(fetched))

    // FORCED DOOR: typing the address must refuse, which is the one claim a click cannot make.
    await window.evaluate("location.hash = '#/checkout'")
    await delay(900)
    const forced = await window.evaluate('document.body.dataset.route')
    const forcedMarkers = await markersOnScreen(window)
    check('typing the checkout address lands on home instead of opening it',
      forced === 'home', `route=${forced}`)
    check('and the forced door shows none of the list either', forcedMarkers.length === 0, forcedMarkers.join(', '))

    await closeWindow(window)
    window = null

    /* ---------- 3. A LIST-BEARING INSTALL: THE FEATURE IS STILL THERE ---------- */
    seedMachineRecord(operatorProfile, appRoot, 'standard')
    const userData = userDataFor(operatorProfile)
    mkdirSync(userData, { recursive: true })
    writeFileSync(path.join(userData, 'purchase-catalog.json'), JSON.stringify(syntheticCatalog(), null, 2))

    window = await openWindow(executable, operatorProfile)
    /* REACHED BY WALKING THE RING, NOT BY COUNTING CLICKS FROM HOME.
     *
     * This used to press `#nav-back` once and require `checkout`, because when
     * it was written `checkout` was the LAST stop on the ring and one click
     * back from home therefore landed on it -- the very shape of the leak.
     * `settings` was appended after the ring in src/main.js (commit 101ebb1),
     * so back-from-home is `settings` now and this went red on a product that
     * is behaving correctly, while saying nothing at all about the claim it
     * was written for.
     *
     * The claim is REACHABILITY, and the claim's negative half above already
     * asks it the right way: walk the whole ring by pressing the chevron a
     * person presses, and look at what is on it. So this asks the identical
     * question in the identical way and requires the opposite answer. It stays
     * honest across any future reordering of the ring, and it still fails --
     * as the whole point of this half demands -- if the screen is deleted
     * rather than fixed. */
    const operatorRing = await walkRing(window, RING_STOPS)
    check('with a list installed, walking the ring reaches the checkout again',
      operatorRing.clicked === 'clicked' && operatorRing.visited.includes('checkout'), operatorRing.visited.join(' -> '))

    /* The walk wraps past the stop; stand ON it before reading the screen.
       Bounded by the same number of presses, so a ring that never offers it
       ends the loop rather than spinning. */
    let route = await window.evaluate('document.body.dataset.route')
    for (let step = 0; step < RING_STOPS && route !== 'checkout'; step += 1) {
      if (await window.clickVisible('#nav-next') !== 'clicked') break
      await delay(350)
      route = await window.evaluate('document.body.dataset.route')
    }
    check('and it can be stood on, which is where the screen itself is measured',
      route === 'checkout', `route=${route}`)

    const surface = await window.evaluate(`(() => ({
      title: document.querySelector('.checkout-title')?.textContent || null,
      items: document.querySelectorAll('.checkout-item').length,
      provenance: document.querySelector('[data-provenance]')?.textContent || null,
    }))()`)
    check('the restored checkout renders the synthetic list, not an empty shop',
      surface.title === 'Checkout' && surface.items > 0, `${surface.items} items`)
    check('and the totals strip is present, so the screen is working rather than merely routed',
      (await window.evaluate(`(${VISIBLE})('.checkout-summary')`)).state === 'visible')
    await closeWindow(window)
    window = null
  } finally {
    /* Cleanup may never decide the verdict. */
    await closeWindow(window)
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows may still hold a DLL */ }
  }

  const failed = results.filter(result => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error))
  process.exitCode = 1
})
