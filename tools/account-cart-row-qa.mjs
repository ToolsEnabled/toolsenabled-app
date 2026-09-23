#!/usr/bin/env node

/* THE PURCHASE-LIST ROW ON THE ACCOUNT SCREEN, TIMED ON A PACKAGED WINDOW.
 *
 * WHAT WAS REPORTED, AND WHY A HARNESS RATHER THAN A READ OF THE SOURCE.
 * Driven live on 1.0.6, the account screen drew a row headed "Your purchase
 * list" whose entire content was "Reading what is waiting for you to decide…"
 * -- identical at 0s, 5s, 15s, 30s and 60s, with no console error, no network
 * error and no exception. Reading src/views/account.js does not tell you
 * whether that row is HUNG or merely SLOW, and the difference decides the fix:
 * a hang is a missing settle, a slow read is a missing budget. Only a clock
 * against the real glass separates them, so this puts one there.
 *
 * WHAT IT MEASURES, in this order, all on the shipped binary:
 *
 *   1. THE ROW'S OWN STATE MACHINE. `data-cart-state` is sampled on a timer
 *      until it leaves "reading" or the budget runs out. The answer is a
 *      NUMBER OF MILLISECONDS, which is the fact the report above was missing.
 *   2. EACH STAGE OF THE READ, TIMED SEPARATELY. The row's read is a chain:
 *      ask the shell which bridge is ours, ask it for this boot's proof,
 *      exchange the proof for a bearer, then GET /v1/owner-prompts. Timing the
 *      whole chain says "slow"; timing each link says WHICH one. They are
 *      called directly here, from the page, exactly as the renderer calls them.
 *   3. WHICH STATE ROOT ANSWERED. The reply's prompt count is recorded next to
 *      the count in the engine's own store, so a build that reads a different
 *      state root than the one holding the queue is legible as that, and not
 *      as an empty queue.
 *
 * WHAT IT DOES NOT DO. It signs nothing in, spends nothing, decides nothing and
 * reads no vault record. It creates a THROWAWAY account in a sterile profile,
 * because the row is only drawn for a signed-in person and driving the owner's
 * own account would need his password, which a harness may not have.
 *
 * THE PROFILE IS STERILE AND THE STATE ROOT WITH IT. --user-data-dir moves
 * Electron's userData, and shell/main.cjs derives CAPABILITY_STATE_ROOT from
 * that, so this run cannot read, write or disturb the owner's installed copy.
 * That is also why the prompt count it observes is 0 rather than his 10: this
 * measures the SHAPE of the read, and the store comparison in step 3 is what
 * carries the split.
 *
 * NAVIGATION IS BY HASH, DELIBERATELY, AND THAT IS NOT A REACHABILITY CLAIM.
 * Sibling harnesses navigate by clicking because they assert a person can GET
 * to a screen. This one asserts something about a row's state machine once the
 * screen is open, so it deep-links and claims nothing about the route.
 * tools/first-run-contract-qa.mjs owns the reachability question.
 *
 * READ THE EXIT CODE. THREE VALUES, ONLY TWO ARE VERDICTS:
 *   0  the row resolved to a real state within budget
 *   1  the row FAILED to resolve, or resolved outside the budget -- a
 *      statement about the product
 *   2  NO VERDICT: the harness never attached or never signed in, so nothing
 *      was measured. A statement about the probe or the machine, NEVER about
 *      the product.
 * Never read it through a pipe: `node x.mjs | tail` reports TAIL's status.
 *
 * RUN IT:
 *   node tools/account-cart-row-qa.mjs
 *   node tools/account-cart-row-qa.mjs --app release/win-unpacked
 *   node tools/account-cart-row-qa.mjs --release release/win-unpacked
 *   node tools/account-cart-row-qa.mjs --budget 90000
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { UNMEASURABLE_MARK } from './machine-steadiness.mjs'
import { machineRecordProductDirectory, userDataFor } from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_APP = defaultReleaseDirectory(REPO_ROOT)
const ACTIVE_PORT_FILE = 'DevToolsActivePort'
const OPEN_BUDGET_MS = 90_000
const {
  canonicalWindowsPathThroughExistingAncestors,
  profileRootFromWindowsUserPath,
  trustedProfileShortAliasRoot,
  usesUnsupportedWindowsPathNamespace,
  windowsProfileReferences,
} = require_(path.join(REPO_ROOT, 'shell', 'install-profile-guard.cjs'))

/* THE BUDGET IS THE ASSERTION. A row that resolves in 8 seconds and a row that
   resolves in 110 are the same row to a state machine and completely different
   products to a person. Six seconds is what a person will wait in front of a
   sentence that says something is being read; past that the row owes them a
   different sentence, not more patience. */
const ROW_BUDGET_MS = 6_000
const SAMPLE_BUDGET_MS = Number(process.env.CART_QA_SAMPLE_MS || 25_000)
const SAMPLE_EVERY_MS = 250

class HarnessError extends Error {}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseArguments(argv) {
  const options = { app: DEFAULT_APP, budget: ROW_BUDGET_MS, unpackaged: false }
  for (let index = 0; index < argv.length; index += 1) {
    /* THE SAME SHELL, THE SAME PRELOAD, THE SAME CAPABILITY LAYER, THE RENDERER
       FROM dist/ RATHER THAN FROM THE ASAR. This is how a renderer fix is
       measured without a forty-minute electron-builder run, and it is exactly
       the mode that makes the shipped defect legible: the packaged asar and the
       built dist/ can disagree, and this run says which one you measured. */
    if (argv[index] === '--unpackaged') { options.unpackaged = true; continue }
    if (argv[index] === '--app' || argv[index] === '--release') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${argv[index]} needs a directory after it`)
      options.app = path.resolve(value)
      index += 1
      continue
    }
    if (argv[index] === '--budget') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--budget needs a positive number of milliseconds')
      options.budget = value
      index += 1
      continue
    }
    throw new Error(`unrecognized argument ${JSON.stringify(argv[index])}`)
  }
  return options
}

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
    await delay(200)
  }
  throw new HarnessError(`the app never wrote ${ACTIVE_PORT_FILE} within ${Math.round(budgetMs / 1000)}s`)
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
              if (packet.id === undefined) { events.push(packet); return }
              const handler = pending.get(packet.id)
              if (handler) { pending.delete(packet.id); handler(packet) }
            })
            say(`attached to the window after ${Date.now() - started}ms`)
            return
          }
          lastSeen = targets.length
            ? `${targets.length} target(s), none a debuggable page`
            : 'an EMPTY target list -- the process is up but no window opened'
        } catch (error) {
          lastSeen = `the endpoint refused the connection (${error?.cause?.code || error?.message || error})`
        }
        await delay(500)
      }
      throw new HarnessError(`no debuggable page within ${Math.round(budgetMs / 1000)}s -- ${lastSeen}`)
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* The row, as the row itself reports it. `data-cart-state` is written by
   cartMarkup in src/account-markup.js and is the only place the four states are
   distinguishable without reading prose. */
const ROW_PROBE = `(() => {
  const row = document.querySelector('[data-account-cart]')
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
  return {
    present: Boolean(row),
    state: row ? row.dataset.cartState || '' : '',
    text: row ? norm(row.innerText).slice(0, 600) : '',
    signedInMarkers: document.querySelectorAll('[data-account-sign-out]').length,
  }
})()`

/* Each link of the read chain, timed on its own, called the way the renderer
   calls it. NOTHING SECRET IS RETURNED: the proof call reports only whether it
   answered and how long the answer is, never the answer. */
const STAGE_PROBE = `(async () => {
  const out = {}
  const time = async (name, run) => {
    const started = performance.now()
    try {
      const value = await run()
      out[name] = { ms: Math.round(performance.now() - started), ok: true, value }
    } catch (error) {
      out[name] = { ms: Math.round(performance.now() - started), ok: false, error: String(error && error.message || error) }
    }
  }
  await time('getBridgeEndpoint', async () => {
    const reply = await window.mcShell.getBridgeEndpoint()
    return { ok: reply && reply.ok === true, source: reply && reply.source, baseUrl: reply && reply.baseUrl, reason: reply && reply.reason }
  })
  await time('getBridgeProof', async () => {
    const reply = await window.mcShell.getBridgeProof()
    return { ok: reply && reply.ok === true, proofLength: reply && typeof reply.proof === 'string' ? reply.proof.length : null, reason: reply && reply.reason }
  })
  const base = out.getBridgeEndpoint.value && out.getBridgeEndpoint.value.baseUrl
  if (base) {
    await time('runtimeProbe', async () => {
      const response = await fetch(base + '/v1/runtime', { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      return { status: response.status, port: body && body.port }
    })
  }
  /* THE READ THE ROW ACTUALLY PERFORMS, reproduced call for call in the order
     src/views/account.js refresh() performs it. The built bundle cannot be
     imported by module path, so the CHANNELS are driven directly -- which is
     the honest substitute, because every one of them is a preload channel the
     view calls through exactly this surface. */
  await time('mcAccount.current', async () => {
    const reply = await window.mcAccount.current()
    return { ok: reply && reply.ok, signedIn: reply && reply.signedIn }
  })
  await time('mcAccount.data', async () => {
    const reply = await window.mcAccount.data()
    return { ok: reply && reply.ok === true, code: reply && reply.code }
  })
  await time('mcAccount.paymentPresence', async () => {
    const reply = await window.mcAccount.paymentPresence()
    return { ok: reply && reply.ok === true, code: reply && reply.code }
  })
  await time('mcAgent.history', async () => {
    if (!window.mcAgent || typeof window.mcAgent.history !== 'function') return { present: false }
    const reply = await window.mcAgent.history({ limit: 200 })
    return { present: true, ok: reply && reply.ok === true, entries: reply && Array.isArray(reply.entries) ? reply.entries.length : null }
  })
  const proofValue = out.getBridgeProof.value
  if (base && proofValue && proofValue.ok) {
    /* The bootstrap exchange and the queue read, done here the way
       src/mission-bridge.js does them. The bearer is used and never reported. */
    await time('bootstrapExchange', async () => {
      const url = new URL('/v1/bootstrap', base)
      const proof = await window.mcShell.getBridgeProof()
      url.searchParams.set('proof', proof.proof)
      const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => null)
      window.__cartProbeToken = body && body.token
      return { status: response.status, ok: Boolean(body && body.ok === true && typeof body.token === 'string') }
    })
    await time('ownerPromptSnapshot', async () => {
      const response = await fetch(base + '/v1/owner-prompts', {
        cache: 'no-store',
        headers: { accept: 'application/json', authorization: 'Bearer ' + window.__cartProbeToken },
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, ok: Boolean(body && body.ok === true), prompts: body && Array.isArray(body.prompts) ? body.prompts.length : null }
    })
    delete window.__cartProbeToken
  }
  return out
})()`

/* The window attaches to the debugger long before it has painted anything, so
   the first evaluate lands on an empty document. This waits for the account
   screen to actually exist rather than sleeping a guessed number of seconds. */
const WAIT_FOR_ACCOUNT = `(async () => {
  location.hash = '#/account'
  const started = Date.now()
  while (Date.now() - started < 60000) {
    const form = document.querySelector('[data-account-form]')
    const out = document.querySelector('[data-account-sign-out]')
    if (form || out) return { ok: true, ms: Date.now() - started, form: form ? form.dataset.accountForm : null, alreadySignedIn: Boolean(out) }
    await new Promise(r => setTimeout(r, 200))
  }
  return { ok: false, ms: Date.now() - started, bodyLength: (document.body.innerText || '').length, hash: location.hash }
})()`

function createAccountScript(username, password) {
  return `(async () => {
    location.hash = '#/account'
    await new Promise(r => setTimeout(r, 1200))
    const modeButton = document.querySelector('[data-account-mode="create"]')
    if (modeButton) { modeButton.click(); await new Promise(r => setTimeout(r, 600)) }
    const form = document.querySelector('[data-account-form="create"]')
    if (!form) return { ok: false, reason: 'no create form on the account screen' }
    const set = (name, value) => {
      const field = form.querySelector('[name="' + name + '"]')
      if (!field) return false
      field.value = value
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    if (!set('username', ${JSON.stringify(username)})) return { ok: false, reason: 'no username field' }
    if (!set('password', ${JSON.stringify(password)})) return { ok: false, reason: 'no password field' }
    const submit = form.querySelector('button[type="submit"]')
    if (!submit) return { ok: false, reason: 'no submit control' }
    submit.click()
    return { ok: true }
  })()`
}

async function evaluate(session, expression) {
  const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  /* A protocol-level refusal is NOT a page result. Reporting it as `undefined`
     is how a harness comes to blame the product for its own failure to ask, so
     it is raised with the refusal text the debugger actually sent. */
  if (packet.error) {
    throw new HarnessError(`the debugger refused the evaluation: ${JSON.stringify(packet.error)}`)
  }
  if (packet.result?.exceptionDetails) {
    throw new HarnessError(`the page threw while being measured: ${packet.result.exceptionDetails.text} ${packet.result.exceptionDetails.exception?.description || ''}`)
  }
  return packet.result?.result?.value
}

/* The shell attaches the debugger to an about:blank page and THEN navigates it
   to the served build, so the first evaluations land in a context that is
   destroyed underneath them. That is the harness racing the app, not a defect
   in the app, so it is retried rather than reported. */
async function evaluateAfterNavigation(session, expression, budgetMs = 60_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < budgetMs) {
    try {
      return await evaluate(session, expression)
    } catch (error) {
      if (!(error instanceof HarnessError) || !/Execution context was destroyed|Cannot find context/.test(error.message)) throw error
      last = error
    }
    await delay(250)
  }
  throw new HarnessError(`the page never held still long enough to be measured within ${budgetMs}ms: ${last?.message}`)
}

/* THE FIRST-RUN GATE IS ANSWERED, NOT BYPASSED. A profile with no machine
   record is a copy that has never been set up, and the router correctly refuses
   every route but #/setup -- measured: a deep link to #/account came back at
   #/setup after 60s. This writes the same record the walkthrough writes, at the
   most confined tier, using the PAYLOAD'S OWN module rather than a hand-rolled
   copy, so the record cannot drift from what the product accepts. */
function seedMachineRecord(profile, payloadRoot, tier = 'guided') {
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(payloadRoot, 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(payloadRoot, 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
}

export function engineQueueCount({
  environment = process.env,
  platform = process.platform,
  currentUserHome = os.homedir(),
  readStore = readFileSync,
  filesystem = undefined,
  resolveTrustedAlias = trustedProfileShortAliasRoot,
} = {}) {
  /* The other side of the split, read from disk rather than described. The
     engine checkout is named here as data, and only its COUNT is reported --
     no title, no amount, no line of somebody's shopping list.

     THE PATH IS CONFIGURED, NOT HARDCODED, AND ABSENCE IS SAID OUT LOUD.
     This read an absolute path into the builder's own machine, which put
     their home directory AND the location of a private sibling checkout into a
     file classified open. Two disclosures for a number.

     A relative default was the obvious alternative and is worse: it would
     assume a sibling layout, silently read nothing on a machine arranged
     differently, and report zero -- which is indistinguishable from a genuinely
     empty queue. That is the absence-as-emptiness defect this codebase keeps
     finding, so it is refused here too: no path configured means UNAVAILABLE,
     with the reason stated, never a confident zero. */
  const configured = typeof environment.TOOLSENABLED_ENGINE_ROOT === 'string'
    ? environment.TOOLSENABLED_ENGINE_ROOT.trim() : ''
  if (!configured) {
    return { readable: false, reason: 'TOOLSENABLED_ENGINE_ROOT is not set, so the engine queue was not read. This is not a count of zero.' }
  }
  if ((platform === 'win32' && (!path.win32.isAbsolute(configured) || usesUnsupportedWindowsPathNamespace(configured))) ||
      (platform !== 'win32' && !path.isAbsolute(configured))) {
    return { readable: false, reason: 'TOOLSENABLED_ENGINE_ROOT was refused by the account fence, so the engine queue was not read. This is not a count of zero.' }
  }
  const selectedRoot = platform === 'win32' ? path.win32.normalize(configured) : path.normalize(configured)
  let currentProfile = null
  let trustedAlias = null
  let aliasResolved = false
  const isAllowedWindowsProfileReference = reference => {
    if (!currentProfile || typeof reference !== 'string') return false
    if (reference.toLowerCase() === currentProfile.toLowerCase()) return true
    if (!/^[a-z0-9_$%'-]{1,6}~[1-9][0-9]*$/i.test(path.win32.basename(reference))) return false
    if (!aliasResolved) {
      aliasResolved = true
      try { trustedAlias = resolveTrustedAlias(currentProfile) }
      catch { trustedAlias = null }
    }
    return Boolean(trustedAlias && reference.toLowerCase() === trustedAlias.toLowerCase())
  }
  if (platform === 'win32') {
    currentProfile = profileRootFromWindowsUserPath(currentUserHome)
    if (!currentProfile) {
      return { readable: false, reason: 'TOOLSENABLED_ENGINE_ROOT was refused by the account fence, so the engine queue was not read. This is not a count of zero.' }
    }
    const references = windowsProfileReferences(selectedRoot, currentProfile)
    if (references.some(reference => !isAllowedWindowsProfileReference(reference))) {
      /* Lexical refusal precedes path.join/readFileSync: a stale sibling
         account setting is never touched merely to produce a diagnostic. */
      return { readable: false, reason: 'TOOLSENABLED_ENGINE_ROOT was refused by the account fence, so the engine queue was not read. This is not a count of zero.' }
    }
  }
  const store = path.join(selectedRoot, 'state', 'owner-public-prompts.json')
  if (platform === 'win32') {
    const canonicalStore = canonicalWindowsPathThroughExistingAncestors(store, {
      ...(filesystem || {}),
      /* Stop on the link's text before a sibling profile is opened. Ordinary
         external roots remain diagnostic; only another account is fenced. */
      stopAtTarget: target => windowsProfileReferences(target, currentProfile)
        .some(reference => !isAllowedWindowsProfileReference(reference)),
    })
    if (!canonicalStore || windowsProfileReferences(canonicalStore, currentProfile)
      .some(reference => !isAllowedWindowsProfileReference(reference))) {
      return { readable: false, reason: 'TOOLSENABLED_ENGINE_ROOT was refused by the account fence, so the engine queue was not read. This is not a count of zero.' }
    }
  }
  try {
    const parsed = JSON.parse(readStore(store, 'utf8'))
    const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : []
    return { readable: true, prompts: prompts.length, purchaseBatches: prompts.filter(p => p && p.kind === 'purchase_batch').length }
  } catch {
    return { readable: false, reason: 'The configured engine queue store could not be read. This is not a count of zero.' }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  /* Named, not found: `ToolsEnabled.exe` is not what a Linux candidate
     carries, so the packaged arm of this driver could not start at all off
     Windows. appExecutable answers for both shapes. */
  const executable = options.unpackaged ? require_('electron') : appExecutable(options.app)
  const launchArgs = options.unpackaged ? [path.join(REPO_ROOT, 'shell', 'main.cjs')] : []
  /* Unpackaged, resolveCapabilityRoot() finds <repo>/capability rather than
     resources/capability, so the machine record has to name the same one or the
     seeded install describes a payload that is not the one that will run. */
  const payloadRoot = options.unpackaged ? REPO_ROOT : path.join(options.app, 'resources')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cart-row-qa-'))
  const profile = path.join(scratch, 'profile')
  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  prepareSterileProfile(qaProfileDirectories(profile))
  seedMachineRecord(profile, payloadRoot)

  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home inside the scratch profile, ELECTRON_RUN_AS_NODE deleted -- set in
     this working environment, it turns the packaged binary into plain Node that
     reads stdin, hits EOF, exits 0 and opens no window, indistinguishable from
     a crash. */
  const environment = sterileLaunchEnvironment(qaProfileDirectories(profile))
  /* No visible window: this is a measurement, not an owner-facing interaction. */
  environment.MC_SMOKE_HEADLESS = '1'

  const child = spawn(executable, [...launchArgs, `--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const noise = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { noise.push(chunk); while (noise.length > 400) noise.shift() })
  }

  const say = message => console.log(`  ..    ${message}`)
  const session = createSession(child, userData, say)
  let verdict = 2
  try {
    await session.open(OPEN_BUDGET_MS)
    await session.send('Runtime.enable')
    await session.send('Log.enable')

    const ready = await evaluateAfterNavigation(session, WAIT_FOR_ACCOUNT)
    if (ready?.ok !== true) throw new HarnessError(`the account screen never appeared: ${JSON.stringify(ready)}`)
    say(`account screen present after ${ready.ms}ms (form=${ready.form}, alreadySignedIn=${ready.alreadySignedIn})`)

    const created = await evaluate(session, createAccountScript('cartprobe', 'a-long-enough-throwaway-passphrase'))
    if (created?.ok !== true) throw new HarnessError(`could not create a throwaway account: ${created?.reason || 'unknown'}`)
    say('throwaway account submitted; watching the row')

    /* THE MEASUREMENT, AND THE CLOCK STARTS WHERE THE PERSON'S DOES.
     *
     * The first version of this started counting at the moment the account was
     * submitted, which put the whole create-and-sign-in sequence inside the
     * row's budget and failed a row that was in fact correct: it appeared, on a
     * screen that took seven seconds to build, already resolved. What is being
     * asserted is how long the ROW SAYS IT IS READING -- so the clock starts
     * when the row is first on the glass, and time before that belongs to a
     * different question and a different harness. */
    const watchStarted = Date.now()
    let started = null
    let firstResolvedMs = null
    let last = null
    const samples = []
    while (Date.now() - watchStarted < SAMPLE_BUDGET_MS) {
      last = await evaluate(session, ROW_PROBE)
      if (last.present && started === null) started = Date.now()
      const elapsed = started === null ? 0 : Date.now() - started
      if (samples.length === 0 || elapsed - samples[samples.length - 1].ms >= 2_000) {
        samples.push({ ms: elapsed, state: last.state, present: last.present })
      }
      if (last.present && last.state && last.state !== 'reading') { firstResolvedMs = elapsed; break }
      await delay(SAMPLE_EVERY_MS)
    }
    if (started === null) throw new HarnessError(`the purchase-list row never appeared at all within ${SAMPLE_BUDGET_MS}ms, so its timing was never measured`)

    /* THE DISCRIMINATOR. A row stuck after the create-and-sign-in sequence and a
       row stuck on a clean signed-in mount are two different defects: the first
       is an ordering fault in that sequence, the second is structural in the
       view's own read. Leaving the page and coming back separates them, and
       costs one navigation. */
    await evaluate(session, `(async () => { location.hash = '#/home'; await new Promise(r => setTimeout(r, 800)); location.hash = '#/account'; await new Promise(r => setTimeout(r, 800)); return true })()`)
    const remountStarted = Date.now()
    let remount = null
    let remountResolvedMs = null
    while (Date.now() - remountStarted < 20_000) {
      remount = await evaluate(session, ROW_PROBE)
      if (remount.present && remount.state && remount.state !== 'reading') { remountResolvedMs = Date.now() - remountStarted; break }
      await delay(SAMPLE_EVERY_MS)
    }
    console.log('')
    console.log('THE SAME ROW ON A CLEAN SIGNED-IN REMOUNT')
    console.log(`  state=${remount?.state || '(none)'} after ${remountResolvedMs === null ? '>20000' : remountResolvedMs}ms`)
    console.log(`  text: ${remount?.text || '(none)'}`)

    const stages = await evaluate(session, STAGE_PROBE)
    const engine = engineQueueCount()

    console.log('')
    console.log('ROW SAMPLES (ms -> state)')
    for (const sample of samples) console.log(`  ${String(sample.ms).padStart(7)}  ${sample.state || (sample.present ? '(no state)' : '(row absent)')}`)
    console.log('')
    console.log('FINAL ROW')
    console.log(`  present=${last?.present} state=${last?.state || '(none)'}`)
    console.log(`  text: ${last?.text || '(none)'}`)
    /* WHAT THE PAGE SAID WHILE IT WAS STUCK. The report this harness exists to
       explain claimed zero console errors, and a harness that enables Log and
       Runtime and then never reads them would repeat that claim without ever
       having checked it. An unhandled rejection inside refresh() is exactly the
       shape of failure that leaves a row on its first state forever. */
    const spoken = session.events.filter(packet => (
      packet.method === 'Runtime.exceptionThrown' || packet.method === 'Runtime.consoleAPICalled' || packet.method === 'Log.entryAdded'
    ))
    console.log('')
    console.log(`WHAT THE PAGE SAID (${spoken.length} entr${spoken.length === 1 ? 'y' : 'ies'})`)
    for (const packet of spoken.slice(0, 40)) {
      if (packet.method === 'Runtime.exceptionThrown') {
        const detail = packet.params?.exceptionDetails
        console.log(`  EXCEPTION  ${detail?.text || ''} ${detail?.exception?.description || JSON.stringify(detail?.exception?.value ?? null)}`)
      } else if (packet.method === 'Log.entryAdded') {
        console.log(`  LOG ${packet.params?.entry?.level}  ${packet.params?.entry?.text}`)
      } else {
        const args = (packet.params?.args || []).map(a => a.value ?? a.description ?? a.type).join(' ')
        console.log(`  CONSOLE ${packet.params?.type}  ${args}`)
      }
    }
    console.log('')
    console.log('STAGE TIMINGS')
    for (const [name, result] of Object.entries(stages || {})) {
      console.log(`  ${name.padEnd(22)} ${String(result.ms).padStart(7)}ms  ${JSON.stringify(result.ok ? result.value : result.error)}`)
    }
    console.log('')
    console.log('WHICH STATE ROOT ANSWERED')
    console.log(`  this sterile profile's layer: ${JSON.stringify(stages?.ownerPromptSnapshot?.value ?? null)}`)
    console.log(`  the engine's own store:       ${JSON.stringify(engine)}`)
    console.log('')

    if (firstResolvedMs === null) {
      console.log(`FAIL  the row never left "reading" within ${SAMPLE_BUDGET_MS}ms. A surface that waits forever with no error is indistinguishable from broken.`)
      verdict = 1
    } else if (firstResolvedMs > options.budget) {
      console.log(`FAIL  the row resolved to "${last.state}" after ${firstResolvedMs}ms, past the ${options.budget}ms budget. It resolves, but not inside the time a person will wait.`)
      verdict = 1
    } else {
      console.log(`PASS  the row resolved to "${last.state}" after ${firstResolvedMs}ms, inside the ${options.budget}ms budget.`)
      verdict = 0
    }
  } catch (error) {
    if (error instanceof HarnessError) {
      console.log('')
      console.log(`NO VERDICT  ${error.message}`)
      console.log(`${UNMEASURABLE_MARK} the account-cart harness did not reach its timed row assertion.`)
      const said = noise.join('').trim()
      if (said) console.log(`  the process said:\n${said.split('\n').slice(-25).map(l => `    ${l}`).join('\n')}`)
      verdict = 2
    } else {
      throw error
    }
  } finally {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    if (child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* nothing left */ }
    }
    await delay(600)
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a locked profile is not a verdict */ }
  }
  if (verdict === 0 || verdict === 1) {
    console.log(`${verdict === 0 ? 1 : 0}/1 checks passed (account cart row)`)
  }
  process.exit(verdict)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exit(2)
  })
}
