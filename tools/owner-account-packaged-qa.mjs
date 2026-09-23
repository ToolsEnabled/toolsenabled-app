#!/usr/bin/env node
/* CAN A PERSON MAKE AN ACCOUNT, SIGN IN, AND SEE THEIR OWN THINGS -- ON THE PACKAGED WINDOW.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED, on this machine, 2026-08-11:
 *   - %APPDATA%\ToolsEnabled\product-accounts.json did not exist. Nobody had
 *     ever made an account through the shipped flow, so nothing proved the flow
 *     worked at all.
 *   - `accountId` appeared nowhere in the application outside
 *     shell/product-account.cjs. Signing in changed a NAME on a record and
 *     nothing else: one shared settings file, inherited by whoever signed in
 *     next. "Your data" was a sentence the product could not write.
 *   - payment_method.card_status answered `present: false` with a 1260-byte
 *     card record in the vault, because it asked a verb the vault's own
 *     denylist refuses.
 *
 * SO THIS RUNS THE PACKAGED APPLICATION AND TYPES. It creates an account by
 * filling the shipped form and pressing the shipped button, signs out, signs
 * back in, and reads what the window says about that account's settings and
 * that account's payment method. A source test cannot do any of that: the
 * defects above were in the ROUTING, the PAYLOAD and the PARTITION, and each
 * one reads as ordinary in the file it lives in.
 *
 * THE PASSWORD IS GENERATED HERE AND NEVER LEAVES THIS PROCESS. It is made from
 * crypto.randomBytes, typed into the field through the debugger, and dropped.
 * It is not printed, not written to a log, not passed as an argument, and not
 * put in the summary -- the assertions below are about SHAPE and REFUSAL, and
 * the one place the password value is used against a file is where the run
 * proves it is NOT in one.
 *
 * THE VAULT RECORD THIS PLANTS IS THE STRING 'synthetic-not-a-card'. The owner's
 * real payment record is never copied, moved, read or decrypted by this file.
 * What is under test is whether the product tells the truth about a record
 * BEING THERE, and a synthetic record proves that exactly as well as a real one
 * while proving nothing about anybody's money.
 *
 * ISOLATION IS MEASURED, NOT ASSUMED. Every phase runs against a sterile
 * --user-data-dir, and the run FAILS if the app wrote its account store
 * anywhere other than inside that scratch profile. A harness that had inherited
 * this machine's real installation would be creating accounts in it.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import {
  environmentFor as credentialSafeEnvironment,
  stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE,
} from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const USERNAME = 'qa.owner.probe'
const DISPLAY_NAME = 'QA Owner Probe'
const SECOND_USERNAME = 'qa.other.probe'
const CARD_KEY = 'payment_card_default'
/* Not a card. The literal is here so a reader can see that no real record is
   involved, and so the assertions can prove it never reaches the window. */
const SYNTHETIC_RECORD = 'synthetic-not-a-card'

/* A generated password, made once per run and held only in this process.
   16 random bytes as base64url is 22 characters, comfortably over the shipped
   12-character minimum, and it is never derived from anything guessable. */
const password = () => randomBytes(16).toString('base64url')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (!launcher) throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
  return path.join(appRoot, launcher)
}

/* The packaged build with THIS tree's dist/ and shell/ in it. Repacking the
   archive keeps the artifact real -- same exe, same resources/capability, same
   asar -- while carrying the change under test. Rebuilding the installer per
   run costs minutes and an electron-builder lock. */
async function stage(scratch) {
  // Exact --release also forbids the legacy checkout vault-script repair below.
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    const staged = await stageRelease(scratch)
    return { executable: staged.executable, app: staged.appRoot }
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
  /* The presence verb lives in the capability payload, which is NOT inside the
     asar -- it sits beside it as resources/capability. The packaged copy on
     disk predates this change, so the staged artifact gets this tree's copy of
     the one script under test, exactly as the payload stage would. */
  const stagedTools = path.join(REPO_ROOT, 'capability', 'tools')
  const packedTools = path.join(app, 'resources', 'capability', 'tools')
  /* MEASURED, AND IT IS A REAL DEFECT IN THE SHIPPED ARTIFACT: release/win-unpacked
     carries tools/secrets.ps1 but NOT tools/lib/, and secrets.ps1's third line
     dot-sources tools/lib/vault-acl.ps1 under `$ErrorActionPreference = 'Stop'`.
     In the shipped build that script therefore cannot start at all, so every
     vault operation in the installed product fails before it reads anything --
     which this harness saw as "the vault could not be read". The staging
     directory has the file; the packed artifact predates it. Copying both is
     what the payload stage would do, and the missing file is reported rather
     than papered over: rebuilding the installer is not this lane's to do. */
  for (const entry of ['secrets.ps1', 'lib']) {
    const from = path.join(stagedTools, entry)
    if (existsSync(from) && existsSync(packedTools)) {
      cpSync(from, path.join(packedTools, entry), { recursive: true })
    }
  }
  return { executable: appExecutable(app), app }
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
      /* 90s. This machine routinely has half a dozen other Electron windows up
         from other lanes; a harness that gives up early reports a busy machine
         as a broken build. */
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

/* VISIBLE IS MEASURED. Text in the DOM is not text on the screen, and a field
   that cannot be seen cannot be typed into by a person. */
const VISIBLE = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
  /* SCROLLED TO FIRST, and this was a real defect in this harness.
     The coordinates below are dispatched as a MOUSE EVENT at a page position.
     An element that is on the page but BELOW THE FOLD passed every check here
     and then reported 'clicked' while the click landed on whatever was actually
     at that y -- so a control the harness never touched read as a control that
     did not work. It was found when the sign-in screen grew and pushed "Create
     account" to y=846 in an 832px window: the fields typed, the button did not
     press, and eight checks failed for a reason that was not the product's.
     A person scrolls; so does this. */
  node.scrollIntoView({ block: 'center', inline: 'nearest' })
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  /* Still out of the viewport after scrolling is a genuine problem, and it is
     reported as one rather than clicked at blindly. */
  if (box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) {
    return { state: 'off-screen' }
  }
  return { state: 'visible', x: box.x + box.width / 2, y: box.y + box.height / 2 }
}`

const userDataFor = profile => path.join(profile, 'userdata')

async function openWindow(executable, profile) {
  const port = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataFor(profile)}`], {
    env: credentialSafeEnvironment(profile), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const session = createSession(port, child)
  await session.open()
  const evaluate = async expression => {
    const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return packet?.result?.result?.value
  }
  const clickVisible = async selector => {
    const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(selector)})`)
    if (spot?.state !== 'visible') return spot?.state || 'absent'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    await delay(450)
    return 'clicked'
  }
  /* TYPED, NOT ASSIGNED. `Input.insertText` goes through the same path a
     keyboard does, so a field that is disabled, absent or not focused does not
     receive it -- which is the difference between proving the form works and
     proving a variable can be set. The value never appears in a log: the only
     thing sent over the debugger is the insertText payload itself. */
  const typeInto = async (selector, value) => {
    const spot = await evaluate(`(${VISIBLE})(${JSON.stringify(selector)})`)
    if (spot?.state !== 'visible') return spot?.state || 'absent'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    await session.send('Input.insertText', { text: value })
    await delay(120)
    return 'typed'
  }
  await delay(2200)
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
  return { child, session, evaluate, clickVisible, typeInto }
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

/* Reach the sign-in screen the way a person does: the settings surface links to
   it. The address bar is not a route a customer has. */
async function openAccountScreen(window) {
  const linked = await window.clickVisible('a[href="#/account"]')
  if (linked === 'clicked') {
    await delay(900)
    return 'clicked-a-link'
  }
  /* FALLBACK, AND IT IS REPORTED AS ONE. The settings page that carries the
     link is not always the page a run lands on, and a harness that could only
     start from there would be testing the route to the screen rather than the
     screen. The check below records which way it got there so a run that never
     found the link is visible rather than silently equivalent. */
  await window.evaluate("location.hash = '#/account'")
  await delay(1200)
  return 'typed-the-address'
}

/* PAST FIRST RUN, BECAUSE THAT IS NOT WHAT THIS MEASURES.
 *
 * A sterile profile lands on the walkthrough and stays there -- measured: every
 * check below read "How much should the assistant be allowed to do?" until this
 * existed. The walkthrough has its own lane and its own harnesses; seeding the
 * recorded permission level is the same thing tools/checkout-privacy-packaged-qa.mjs
 * and tools/recommended-path-packaged-qa.mjs do, and it is stated here rather
 * than hidden so nobody reads a green run as covering first run too. */
function seedMachineRecord(profile, appRoot, tier = 'guided') {
  const servicesRoot = path.join(profile, 'local', 'ToolsEnabled')
  const workspace = path.join(profile, 'home', 'ToolsEnabled')
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

/* And the renderer's own record that first run is done. The walkthrough stores
   its profile through localStorage, which the shell keeps in renderer-prefs.json
   -- so seeding it there is seeding it where the product actually reads it.
   This file is ALSO what the first account adopts, which is deliberate: it
   makes the adoption path real in this run instead of theoretical. */
function seedCompletedSetup(profile) {
  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(userData, 'renderer-prefs.json'), `${JSON.stringify({
    storageVersion: 1,
    values: {
      'mc.setup.profile': JSON.stringify({
        schemaVersion: 1, status: 'complete', step: 'review',
        answers: { autonomy: 'assisted', screens: 'live', workspaceRoots: [path.join(profile, 'home', 'ToolsEnabled')], approvals: 'other-work', attach: 'fork', ideImport: 'ask', failover: 'manual' },
        updatedAtMs: Date.now(),
      }),
      'mc.write.agent-session': 'enabled',
    },
    drainedOrigins: [],
  }, null, 2)}\n`, 'utf8')
}

function plantVaultRecord(profile, present) {
  const vaultDirectory = path.join(userDataFor(profile), 'capability', 'vault')
  mkdirSync(vaultDirectory, { recursive: true })
  const contents = present
    ? { [CARD_KEY]: SYNTHETIC_RECORD, unrelated_probe_key: 'synthetic' }
    : { unrelated_probe_key: 'synthetic' }
  writeFileSync(path.join(vaultDirectory, 'secrets.json'), JSON.stringify(contents), 'utf8')
  return path.join(vaultDirectory, 'secrets.json')
}

/* What the window says, read off the rendered account screen. Only the rows
   this run is about; the whole page body would make every assertion depend on
   copy nobody is testing. */
const READ_SCREEN = `() => {
  const text = selector => {
    const node = document.querySelector(selector)
    return node ? node.textContent.replace(/\\s+/g, ' ').trim() : null
  }
  const payment = document.querySelector('[data-account-data-payment]')
  return {
    route: document.body.dataset.route || null,
    title: text('.setup-title'),
    settings: text('[data-account-data-settings]'),
    history: text('[data-account-data-history]'),
    payment: payment ? payment.textContent.replace(/\\s+/g, ' ').trim() : null,
    paymentState: payment ? payment.dataset.paymentState : null,
    body: document.body.innerText,
  }
}`


/* WAITED FOR, NOT SLEPT THROUGH.
 *
 * Both create steps below read the screen after `await delay(6000)` with the
 * note "scrypt at N=2^17 costs about a second, twice". Measured on a staged
 * packaged build 2026-08-18: at six seconds the create question was still on
 * the glass, so four checks reported "the window says who is signed in -- Who
 * is using this copy?" on a run whose own later checks then read the new
 * account's id, attached a payment card to it, and found both accounts on disk
 * in their own partitions. The product had repainted; this file had stopped
 * looking. A fixed sleep is a claim about how fast the machine running the
 * suite is, and it is the only claim in this file nobody measured.
 *
 * The poll ends on an ANSWER -- signed in, or the refusal the view paints --
 * and reports how long it waited, so a create that gets slower has somewhere to
 * show it before it becomes a red. Running out of budget IS a red, and the
 * right one: a screen that never repaints after its own action is the defect
 * these checks were written for. */
async function settledAfterCreate(window, { timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const seen = await window.evaluate(`(() => {
      const title = document.querySelector('.setup-title')
      const notice = document.querySelector('[data-account-notice], .setup-notice')
      return { title: title ? title.textContent.trim() : '', notice: notice ? notice.textContent.trim().slice(0, 140) : '' }
    })()`)
    const waitedMs = Date.now() - startedAt
    if (/^Signed in as /.test(seen.title)) return { ok: true, waitedMs, title: seen.title }
    if (/did not work/i.test(seen.notice)) return { ok: false, waitedMs, title: seen.title, notice: seen.notice }
    if (waitedMs >= timeoutMs) return { ok: false, waitedMs, title: seen.title, notice: seen.notice || 'the screen never changed' }
    await delay(400)
  }
}

async function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'owner-account-qa-'))
  const profile = path.join(scratch, 'profile')
  mkdirSync(profile, { recursive: true })
  let window = null
  const startedAt = Date.now()

  try {
    const { executable, app } = await stage(scratch)
    seedMachineRecord(profile, app)
    seedCompletedSetup(profile)

    /* ---------------- PHASE 1: make an account by typing ---------------- */
    const chosen = password()
    plantVaultRecord(profile, true)
    window = await openWindow(executable, profile)

    const arrival = await openAccountScreen(window)
    check('the sign-in screen opens on the packaged window', (await window.evaluate('document.body.dataset.route')) === 'account', arrival)

    const modeSwitch = await window.clickVisible('[data-account-mode="create"]')
    check('a computer with no account offers to create one', modeSwitch === 'clicked' || (await window.evaluate("!!document.querySelector('[data-account-form=\"create\"]')")) === true, `switch=${modeSwitch}`)

    const typedName = await window.typeInto('[data-account-form="create"] input[name="username"]', USERNAME)
    const typedDisplay = await window.typeInto('[data-account-form="create"] input[name="displayName"]', DISPLAY_NAME)
    const typedPassword = await window.typeInto('[data-account-form="create"] input[name="password"]', chosen)
    check('every field on the create form accepts typing', typedName === 'typed' && typedDisplay === 'typed' && typedPassword === 'typed',
      `${typedName}/${typedDisplay}/${typedPassword}`)

    const submitted = await window.clickVisible('[data-account-form="create"] button[type="submit"]')
    check('the create button is clickable', submitted === 'clicked', submitted)
    const createSettled = await settledAfterCreate(window)
    console.log(`  ..   the create settled after ${Math.round(createSettled.waitedMs / 1000)}s${createSettled.ok ? '' : ` WITHOUT signing in: ${createSettled.notice}`}`)

    const afterCreate = await window.evaluate(`(${READ_SCREEN})()`)
    check('the window says who is signed in', /Signed in as/.test(afterCreate.title || ''), afterCreate.title || 'no title')
    check('it is the name that was typed', (afterCreate.body || '').includes(DISPLAY_NAME))

    /* ---------------- PHASE 2: his data, and his card ---------------- */
    check('the screen states what settings belong to this account', typeof afterCreate.settings === 'string' && afterCreate.settings.length > 0,
      (afterCreate.settings || 'absent').slice(0, 90))
    check('the screen states what history belongs to this account', typeof afterCreate.history === 'string' && afterCreate.history.length > 0,
      (afterCreate.history || 'absent').slice(0, 90))

    const attached = await window.evaluate(`window.mcAccount.attachPaymentMethod({ vaultKey: ${JSON.stringify(CARD_KEY)} }).then(r => r.ok === true)`)
    check('a payment method can be attached to the signed-in account', attached === true, String(attached))

    await window.evaluate("location.hash = '#/'")
    await delay(400)
    await window.evaluate("location.hash = '#/account'")
    await delay(2500)
    const withCard = await window.evaluate(`(${READ_SCREEN})()`)
    check('the window shows the card as ON FILE', withCard.paymentState === 'on-file', `state=${withCard.paymentState}`)
    check('and says so in words a person can read', /card is on file/i.test(withCard.payment || ''), (withCard.payment || 'absent').slice(0, 110))
    check('the vault key is named and the record itself is not', (withCard.payment || '').includes(CARD_KEY) && !(withCard.body || '').includes(SYNTHETIC_RECORD))

    /* ---------------- PHASE 3: the mutation. Take the record away. ----------------
     *
     * The check that stops phase 2 being a hardcoded "yes". Same account, same
     * binding, same window: only the vault changes. */
    plantVaultRecord(profile, false)
    await window.evaluate("location.hash = '#/'")
    await delay(400)
    await window.evaluate("location.hash = '#/account'")
    await delay(2500)
    const withoutCard = await window.evaluate(`(${READ_SCREEN})()`)
    check('with the record removed the window stops saying it is on file', withoutCard.paymentState !== 'on-file', `state=${withoutCard.paymentState}`)
    check('and does not claim there is no card, because one IS attached', withoutCard.paymentState === 'attached-not-here',
      (withoutCard.payment || 'absent').slice(0, 110))

    /* ---------------- PHASE 3b: the record of a run says WHO ----------------
     *
     * The single spawn record on this machine before this lane read
     * `"principal":"unauthenticated"`. That is what "his history is
     * unattributed" meant, and the fix is only real if a NEW record, written by
     * the shipped path while somebody is signed in, carries `account:<id>`.
     *
     * NOTHING IS SPENT PROVING IT. shell/main.cjs writes the spawn record
     * BEFORE it asks the engine to start anything -- `recordSpawnIntent()` runs
     * ahead of `startSession()`, deliberately, so that a refusal cannot leave an
     * unrecorded process. So a start that then fails for want of an engine still
     * produces the record this is about, at no provider cost. Whether the engine
     * was there is not what is under test here. */
    const accountId = await window.evaluate('window.mcAccount.current().then(state => state && state.account ? state.account.id : null)')
    check('the window knows which account is signed in', /^[0-9a-f]{32}$/.test(String(accountId || '')), String(accountId).slice(0, 8) + '...')
    await window.evaluate('window.mcAgent.start({ sessionId: "owner-account-qa-probe", surface: "qa" }).then(() => true).catch(() => true)')
    await delay(2500)
    const ledgerPath = path.join(userDataFor(profile), 'agent-spawn-records.jsonl')
    const ledgerLines = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []
    check('a run started while signed in produced a record', ledgerLines.length > 0, `${ledgerLines.length} record(s)`)
    const attributed = ledgerLines.filter(entry => entry.principal === `account:${accountId}`)
    check('and the record says WHO started it, not "unauthenticated"',
      attributed.length > 0 && ledgerLines.every(entry => entry.principal !== 'unauthenticated'),
      attributed.length > 0 ? `principal=account:${String(attributed[0].principal).slice(8, 16)}...` : ledgerLines.map(entry => entry.principal).join(','))
    const historyPrincipals = await window.evaluate('window.mcAgent.history({ limit: 10 }).then(reply => (reply.entries || []).map(entry => entry.principal))')
    check('the page can see the principal, which is what lets it show YOUR history',
      Array.isArray(historyPrincipals) && historyPrincipals.some(value => value === `account:${accountId}`),
      JSON.stringify(historyPrincipals || []).slice(0, 60))

    /* ---------------- PHASE 4: it is a PARTITION, not a label ---------------- */
    plantVaultRecord(profile, true)
    const signedOut = await window.clickVisible('[data-account-sign-out]')
    await delay(2000)
    check('signing out works from the screen', signedOut === 'clicked', signedOut)

    const secondPassword = password()
    await window.clickVisible('[data-account-mode="create"]')
    await window.typeInto('[data-account-form="create"] input[name="username"]', SECOND_USERNAME)
    await window.typeInto('[data-account-form="create"] input[name="password"]', secondPassword)
    await window.clickVisible('[data-account-form="create"] button[type="submit"]')
    const secondSettled = await settledAfterCreate(window)
    console.log(`  ..   the second create settled after ${Math.round(secondSettled.waitedMs / 1000)}s${secondSettled.ok ? '' : ` WITHOUT signing in: ${secondSettled.notice}`}`)

    const second = await window.evaluate(`(${READ_SCREEN})()`)
    check('a second account can be made on the same computer', /Signed in as/.test(second.title || ''), second.title || 'no title')
    check('the second account is NOT shown the first account payment method', second.paymentState === 'none',
      `state=${second.paymentState}`)
    check('and is not shown the first account name', !(second.body || '').includes(DISPLAY_NAME))

    /* ---------------- PHASE 5: the password is nowhere on disk ---------------- */
    const userData = userDataFor(profile)
    const accountStore = path.join(userData, 'product-accounts.json')
    check('the account store is inside the sterile profile', existsSync(accountStore), accountStore)
    if (existsSync(accountStore)) {
      const raw = readFileSync(accountStore, 'utf8')
      check('both accounts are in it', raw.includes(USERNAME) && raw.includes(SECOND_USERNAME))
      check('neither password is in it, in any form',
        !raw.includes(chosen) && !raw.includes(secondPassword)
        && !raw.includes(Buffer.from(chosen, 'utf8').toString('base64')))
      check('what IS in it is a scrypt verifier at the shipped cost', /scrypt\$N=131072,r=8,p=1\$/.test(raw))
    }
    /* The second account has written nothing yet, so it has no file yet -- a
       partition that is created on first write rather than on sign-in is
       correct, and asserting two files before the second account writes would
       be asserting the wrong thing. So: make it write, then count. */
    await window.evaluate("window.mcAccount.putSetting('mc.theme', 'white')")
    await delay(600)
    const partitions = existsSync(path.join(userData, 'accounts')) ? readdirSync(path.join(userData, 'accounts')) : []
    check('each account got its OWN partition file', partitions.length === 2, partitions.join(', ') || 'none')
    /* Only the payment block. The adopted settings legitimately contain the
       first-run profile, whose own JSON carries a thirteen-digit timestamp --
       a whole-file digit scan fails on a correct file, and the person who hits
       that deletes the assertion instead of narrowing it. */
    check('no payment record in any partition holds anything shaped like a card number',
      partitions.every(name => {
        const stored = JSON.parse(readFileSync(path.join(userData, 'accounts', name), 'utf8'))
        if (!stored.paymentMethod) return true
        return Object.values(stored.paymentMethod)
          .filter(value => typeof value === 'string')
          .every(value => !/\d{12,19}/.test(value.replace(/[ -]/g, '')))
      }))

    /* The isolation claim itself. If the app wrote to this machine's real
       installation, every assertion above was measured against the owner's own
       state. */
    check('nothing was written to this machine real installation',
      !existsSync(path.join(process.env.APPDATA || 'C:\\nonexistent', 'ToolsEnabled', 'accounts', `${USERNAME}.json`))
      && userData.startsWith(scratch), userData)
  } catch (error) {
    check('the run completed', false, error?.message || String(error))
  } finally {
    await closeWindow(window)
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the OS will reclaim it */ }
  }

  const failed = results.filter(entry => !entry.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  FAILED: ${entry.name}${entry.detail ? ` -- ${entry.detail}` : ''}`)
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
