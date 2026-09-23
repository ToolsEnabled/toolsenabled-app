'use strict'

/* Read the home screen of an exact UNPACKED candidate and check the properties
 * the owner reported broken, on the rendered DOM rather than on the source.
 *
 * WHY THIS EXISTS SEPARATELY FROM tools/test/home-screen.test.mjs.
 *
 * That suite proves the DECISION is sound: it walks every reachable input to
 * describeHome() and asserts the sentence set never contradicts, repeats, or
 * talks like a README. What it cannot see -- and a mutation round proved this,
 * it is not a theoretical gap -- is a RENDERER that has stopped rendering that
 * decision. Blanking the facts on their way to the screen left every source
 * pattern that suite looks for still present in the file, and it stayed green
 * over a home screen with nothing under the ring.
 *
 * So this reads what is actually on the glass. It launches the packaged
 * application against a throwaway profile, drives it over the DevTools
 * protocol, and asserts against `document` -- which is the only place the
 * question "does this screen contradict itself" can honestly be answered.
 *
 * THREE TRAPS THIS HANDLES, EACH OF WHICH HAS COST THIS PROJECT HOURS:
 *   1. ELECTRON_RUN_AS_NODE is stripped. Inherited, it turns the Electron
 *      binary into headless Node that exits 0 with no window, which looks
 *      exactly like a crash.
 *   2. The candidate is copied byte-for-byte to a new directory. Cleanup uses
 *      a retained native descendant owner, never a process-name census or a
 *      numeric PID recovered after exit. Maintained instances stay running.
 *   3. It uses its own --user-data-dir and redirects every application home.
 *      Environment isolation is not an OS filesystem/network sandbox; native
 *      runs still require an appropriately isolated QA host/session.
 *
 * Usage: node tools/home-screen-qa.cjs --release <unpacked candidate>
 * The former single positional directory is also accepted. This is not an
 * installed/upgrade proof; the candidate and profile are disposable copies.
 * Exit 0 = every check passed. Exit 1 = a check failed. Exit 2 = could not run.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { spawnOwnedClaim } = require('../shell/owned-claim-process.cjs')
const { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } = require('./lib/sterile-launch.cjs')

const APP_EXE = 'ToolsEnabled.exe'
/* THE DEBUG PORT IS ASSIGNED BY THE OS, NOT BY THIS FILE.
 *
 * It was the literal 9411. Two runs at once -- this harness against one build
 * while any other CDP-driven harness or a second unpacked copy ran against
 * another -- both asked Chromium for 9411. The second launch gets the port
 * refused, exposes no page, and this file's launch loop then times out with
 * "the application did not present a home screen within 60000ms", which reads
 * as a STARTUP CRASH IN THE PRODUCT. It is not: it is two harnesses fighting
 * over one number. The setup-walkthrough harness removed the same pattern after
 * measuring a 1-in-4 flake from it.
 *
 * `--remote-debugging-port=0` makes Chromium bind an ephemeral port and write
 * the real one as the first line of DevToolsActivePort inside the user-data-dir
 * -- which is already per-run (mkdtemp), so two runs cannot collide on it
 * either. The port is therefore read back rather than assumed, and a run that
 * cannot read it says so instead of blaming the application.
 */
const CDP_PORT_REQUEST = 0
const LAUNCH_TIMEOUT_MS = 60_000
let cdpPort = null
let activeRunSignal

function homeReleaseArgument(argv = process.argv.slice(2), platform = process.platform) {
  if (!['linux', 'win32'].includes(platform)) throw new Error('Home native QA requires Linux or Windows ownership support')
  let value
  if (argv.length === 0) value = path.join(__dirname, '..', 'release', platform === 'linux' ? 'linux-unpacked' : 'win-unpacked')
  else if (argv.length === 2 && argv[0] === '--release') value = argv[1]
  else if (argv.length === 1) value = argv[0].startsWith('--release=') ? argv[0].slice('--release='.length) : argv[0]
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
    throw new Error('Home QA requires exactly one candidate directory: --release <path> (or one legacy positional path)')
  }
  return path.resolve(value)
}

async function stageHomeRelease(scratch, argv = process.argv.slice(2), harness) {
  const release = homeReleaseArgument(argv)
  const { stage, STAGE_EXACT_RELEASE } = harness || await import('./test-account-harness.mjs')
  // Even the legacy/default invocation was a packaged proof, not a source
  // overlay. No checkout dist, shell, engine or repair shim enters this copy.
  const staged = await stage(scratch, release, { mode: STAGE_EXACT_RELEASE })
  if (process.platform === 'win32' && path.basename(staged.executable) !== APP_EXE) {
    throw new Error('Home QA did not select the declared Windows launcher')
  }
  return staged
}

function homeEnvironment(profile, base = process.env, platform = process.platform) {
  const allowed = /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DISPLAY|XAUTHORITY|LANG|LC_ALL|MC_SMOKE_HEADLESS)$/i
  const gui = Object.fromEntries(Object.entries(base).filter(([name]) => allowed.test(name)))
  const environment = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(profile)), gui,
    { systemPathOnly: true, platform })
  if (platform === 'linux') {
    environment.XDG_RUNTIME_DIR = path.join(profile, 'runtime')
    fs.mkdirSync(environment.XDG_RUNTIME_DIR, { mode: 0o700 })
    // A redirected HOME alone cannot isolate the owner's session keyring.
    // Do not inherit or auto-discover either of the owner's D-Bus connections.
    environment.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(profile, 'absent-session-bus')}`
    environment.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${path.join(profile, 'absent-system-bus')}`
  }
  return environment
}

async function inspectOwnedHome(launch, inspect, {
  spawnOwner = spawnOwnedClaim, timeoutMs = 210_000, cleanupMs = 15_000,
  maxOutputBytes = 2 * 1024 * 1024, signals = process,
} = {}) {
  for (const limit of [timeoutMs, cleanupMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Home QA limits must be positive integers')
  }
  const controller = new AbortController()
  let owner, timer, abortListener, finishing = false, outputBytes = 0, value, error, receipt
  const stop = reason => controller.abort(new Error(reason))
  const interrupt = () => stop('Home QA interrupted by SIGINT')
  const terminate = () => stop('Home QA interrupted by SIGTERM')
  try {
    // Reuse containment only, not any device-claim API. On Windows the Job
    // implementation comes from this exact staged candidate's engine.
    owner = spawnOwner({ ...launch, spawn: (command, args, options) => spawn(command, args, options),
      cleanupTimeoutMs: cleanupMs })
    signals.on('SIGINT', interrupt)
    signals.on('SIGTERM', terminate)
    timer = setTimeout(() => stop(`Home QA exceeded ${timeoutMs} ms`), timeoutMs)
    const collect = chunk => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) stop(`Home QA native output exceeded ${maxOutputBytes} bytes`)
    }
    // Drain but never print native output: it can include runtime diagnostics.
    owner.child.stdout.on('data', collect)
    owner.child.stderr.on('data', collect)
    owner.completion.then(() => {
      if (!finishing) stop('The owned application exited before Home inspection completed')
    }, () => stop('Home QA native ownership completion failed'))
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
    })
    value = await Promise.race([Promise.resolve().then(() => inspect(controller.signal)), aborted])
    controller.signal.throwIfAborted()
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error('Home QA inspection failed')
  } finally {
    finishing = true
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', abortListener)
    controller.abort(new Error('Home QA inspection finished'))
    signals.off('SIGINT', interrupt)
    signals.off('SIGTERM', terminate)
    if (owner) {
      let cleanupTimer
      try {
        receipt = await Promise.race([
          owner.cancel(),
          new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(null), cleanupMs) }),
        ])
      } catch { receipt = null }
      finally { clearTimeout(cleanupTimer) }
    }
    if (receipt?.quiescent !== true) {
      error ||= new Error('Home QA descendant cleanup is UNCONFIRMED; retain scratch and do not retry')
      owner?.child.unref?.()
      // EOF leaves the native owner responsible for cleanup. Never kill its
      // numeric PID or treat a wrapper close as an empty descendant receipt.
      for (const stream of owner?.child.stdio || []) stream?.destroy?.()
    }
    if (receipt?.started !== true) error ||= new Error('Home QA never established a started native application')
  }
  return { value, error, cleanupConfirmed: receipt?.quiescent === true, receipt, outputBytes }
}

function readDevToolsPort(profileDir) {
  try {
    const first = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
    const port = Number(first)
    if (/^\d+$/.test(first) && Number.isInteger(port) && port > 0 && port <= 65535) return port
    const error = new Error('could not use DevToolsActivePort because its first line is not a decimal TCP port from 1 through 65535; this is NOT claiming the file or application is absent')
    error.code = 'ERR_DEVTOOLS_PORT_INVALID'
    throw error
  } catch (cause) {
    /* ENOENT is the one answer this poll can safely turn into "not here yet".
       Anything else means this machine could not read the answer; it does not
       mean Chromium failed to publish one. In particular, returning null for
       EMFILE/EAGAIN/EIO/EBUSY used to make the launch loop keep polling and
       eventually make the definite (and false) claim that the application
       "never wrote DevToolsActivePort". */
    if (cause && cause.code === 'ENOENT') return null
    if (cause && cause.code === 'ERR_DEVTOOLS_PORT_INVALID') throw cause
    const error = new Error(
      `could not read DevToolsActivePort; this is NOT claiming the file or application is absent: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    error.code = 'ERR_DEVTOOLS_PORT_UNREADABLE'
    throw error
  }
}

function discoverDevToolsPort(profileDir) {
  /* A successful discovery is intentionally latched: Chromium's chosen port
     cannot change during this child process, and repeated disk reads bought
     nothing. An unreadable result throws above, so it is never latched. */
  if (!cdpPort) cdpPort = readDevToolsPort(profileDir)
  return cdpPort
}

const delay = ms => sleep(ms, undefined, { signal: activeRunSignal })
const problems = []
const checks = []

function check(name, ok, detail) {
  checks.push({ name, ok })
  if (!ok) problems.push(`${name}${detail ? ` -- ${detail}` : ''}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`)
}

async function evaluateOverCdp(expression, { port, signal, timeoutMs = 5_000,
  fetchImpl = fetch, WebSocketImpl = WebSocket,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('the application has not published a valid DevTools port yet')
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  bounded.throwIfAborted()
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: bounded, redirect: 'error' })
  if (!response.ok) throw new Error('the application DevTools page list was not readable')
  const list = await response.json()
  const pages = Array.isArray(list) ? list.filter(target => target.type === 'page' && !String(target.url).startsWith('devtools://')) : []
  if (pages.length !== 1) throw new Error('the owned application must expose exactly one page to inspect')
  const address = new URL(pages[0].webSocketDebuggerUrl)
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || Number(address.port) !== port
      || address.username || address.password || !address.pathname.startsWith('/devtools/page/')) {
    throw new Error('the application supplied a debugger endpoint outside its discovered loopback port')
  }
  bounded.throwIfAborted()
  const socket = new WebSocketImpl(address.href)
  let abortListener, onOpen, onError, onClose, onMessage
  try {
    const reply = await new Promise((resolve, reject) => {
      abortListener = () => reject(bounded.reason)
      onError = () => reject(new Error('could not attach to the page'))
      onClose = () => reject(new Error('the page debugger closed before its answer'))
      onMessage = event => {
        try {
          if (Buffer.byteLength(event.data) > 2 * 1024 * 1024) throw new Error('Home QA debugger answer exceeded its byte limit')
          const message = JSON.parse(event.data)
          if (message.id === 1) resolve(message)
        } catch (error) { reject(error) }
      }
      onOpen = () => { try { socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      })) } catch (error) { reject(error) } }
      bounded.addEventListener('abort', abortListener, { once: true })
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', onClose, { once: true })
      socket.addEventListener('message', onMessage)
      if (bounded.aborted) abortListener()
    })
    if (reply.error) throw new Error('the page debugger rejected Runtime.evaluate')
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description || 'evaluation threw')
    }
    return reply.result?.result?.value
  } finally {
    bounded.removeEventListener('abort', abortListener)
    socket.removeEventListener('open', onOpen)
    socket.removeEventListener('close', onClose)
    socket.removeEventListener('message', onMessage)
    // Retain the once-only error handler while closing a connecting socket.
    try { socket.close() } catch { /* closure is also bounded by the native owner */ }
  }
}

const evaluate = expression => evaluateOverCdp(expression, { port: cdpPort, signal: activeRunSignal })

/* HOME IS NO LONGER THE FIRST SCREEN, AND THIS FILE USED TO ASSUME IT WAS.
 *
 * The launch below is deliberately sterile -- its own --user-data-dir and its
 * own HOME, so it can never read or write a real installation's record. That
 * also means every run is a FIRST run, and a first run opens on the permission
 * question at `#/setup`. Home is behind it.
 *
 * So the wait for `.home` never ended, and after sixty seconds this file said
 * "the application did not present a home screen" -- an accusation of a startup
 * crash, about a product that had started perfectly and was standing on the
 * screen it is supposed to open on. That is the same false-blame trap the note
 * on the DevTools port above records, arriving from the other direction.
 *
 * The walk below is the one the other route harnesses already drive
 * (tools/offline-routes-qa.mjs walkSetup, tools/first-run-recovery-qa.mjs):
 * answer each question with the recommended answer and press through to the
 * app. Every press is checked, so a walk that breaks says WHICH question it
 * broke on rather than blaming the screen two steps later.
 */

/** Poll an expression until it is true. Returns false if it never became true. */
async function until(expression, seconds = 40) {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    activeRunSignal?.throwIfAborted()
    try { if (await evaluate(`Boolean(${expression})`) === true) return true } catch { /* the page is not answering yet */ }
    if (Date.now() > deadline) return false
    await delay(500)
  }
}

/* Click by what is ON THE GLASS, never by what is in the DOM: setup keeps the
   steps it has finished in the document, so a bare querySelector would press
   the Continue belonging to a question two steps back. `last` picks the
   furthest one along, which is the one a person is looking at. */
const clickScript = (selector, last) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((node) => {
    const box = node.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'
  })
  if (nodes.length === 0) return 'nothing matching is on the screen'
  const node = ${last ? 'nodes[nodes.length - 1]' : 'nodes[0]'}
  if (node.disabled) return 'it is there but disabled'
  node.click()
  return 'clicked'
})()`

const clickVisible = (selector) => evaluate(clickScript(selector, false))
const clickLastVisible = (selector) => evaluate(clickScript(selector, true))

const setupSaysScript = (phrase) =>
  `(document.querySelector('[data-setup-section]')?.innerText || '').includes(${JSON.stringify(phrase)})`

/** Answer the first-run questions and end up in the app. */
async function walkSetup() {
  if (!await until(`location.hash === '#/setup'`, 60)) {
    /* THE QUESTION IS ALLOWED NOT TO OPEN, and that is not a pass by omission.
       src/setup-state.js fails OPEN: a copy that cannot record a permission
       level goes straight into the app rather than trapping a person on a
       screen whose only button would fail. So this says why, from the shell's
       own bootstrap, and carries on to home -- which is what this file is for. */
    const why = await evaluate(`(() => { try { return JSON.stringify(window.mcSetup?.bootstrap ?? null) } catch (e) { return 'threw: ' + e.message } })()`)
    console.log(`    the first-run question did not open; the shell's setup bootstrap says ${String(why).slice(0, 240)}`)
    return until(`location.hash === '#/' || location.hash === ''`, 40)
  }
  const press = async (click, selector, what) => {
    const outcome = await click(selector)
    check(`the walk to home can press ${what}`, outcome === 'clicked', `${selector} -- ${outcome}`)
    return outcome === 'clicked'
  }
  /* The recommended answer is the default on every question, so nothing is
     chosen here except the one level this file is not entitled to leave to a
     default: assisted, which is the level a new person is given. */
  if (!await press(clickVisible, '[data-setup-continue]', 'Continue on the permission question')) return false
  await until(setupSaysScript('Which folder'))
  await until(`document.querySelector('.setup-root-path') !== null`)
  if (!await press(clickLastVisible, '[data-setup-next]', 'Continue on the folder question')) return false
  await until(`${setupSaysScript('Who is using this copy')} || ${setupSaysScript('Signed in as')}`)
  if (!await press(clickLastVisible, '[data-setup-next]', 'Continue on the sign-in question')) return false
  await until(setupSaysScript('without asking'))
  if (!await press(clickVisible, '[data-setup-set="autonomy"][data-setup-value="assisted"]', 'the assisted level')) return false
  if (!await press(clickVisible, '[data-setup-next="review"]', 'Continue through to the review')) return false
  await until(setupSaysScript('what those answers set'))
  /* The review checks what is installed before it will finish; pressing while
     it is still checking presses a button that is not ready. */
  await until(`!${setupSaysScript('Checking whether Codex')}`)
  if (!await press(clickVisible, '[data-setup-next="finish"]', 'Finish on the review')) return false
  return until(`location.hash === '#/' || location.hash === ''`, 120)
}

/* Read every sentence the home screen is actually showing. Deliberately taken
   from rendered text nodes rather than from any module: this must not be able
   to agree with the decision by construction.
   `visible` is measured, not assumed. Text in the DOM is not text on the glass:
   a stylesheet that hides the fact rows leaves every string exactly where a
   textContent read finds it, and leaves the screen blank. Anything this file
   asserts about what a person can read is therefore gated on a real box. */
const READ_HOME = `(() => {
  const home = document.querySelector('.home')
  if (!home) return { present: false }
  const text = (node) => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const shown = (node) => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'
  }
  const notice = document.querySelector('.fleet-profile-notice')
  return {
    present: true,
    mode: home.dataset.mode,
    caption: text(home.querySelector('.uring-caption')),
    headline: text(home.querySelector('.uring-sub')),
    headlineVisible: shown(home.querySelector('.uring-sub')),
    facts: [...home.querySelectorAll('.home-fact')].filter(shown).map(node => text(node.querySelector('span'))),
    factsInDom: home.querySelectorAll('.home-fact').length,
    panelBodyVisible: shown(home.querySelector('.session-log')),
    digitsHidden: Boolean(home.querySelector('.uring-digits')?.hidden),
    digits: [...home.querySelectorAll('.uring-digits .n.cur')].map(text),
    panelTitle: text(home.querySelector('[data-panel-title]')),
    panelBadge: home.querySelector('[data-panel-badge]')?.hidden ? '' : text(home.querySelector('[data-panel-badge]')),
    panelBody: text(home.querySelector('.session-log')),
    footer: home.querySelector('[data-panel-foot]')?.hidden ? '' : text(home.querySelector('[data-panel-foot]')),
    composer: Boolean(home.querySelector('.session-input input')),
    composerPlaceholder: home.querySelector('.session-input input')?.placeholder || '',
    composerDisabled: home.querySelector('.session-input input')?.disabled ?? null,
    /* The sentence home writes beside a box it has switched off, read the way
       the glass reads it. src/views/home.js ensureComposer() creates the box
       disabled and puts this row under it, and only enables the box once the
       bridge has said it will carry a message. */
    composerSays: text(home.querySelector('.session-write-state')),
    composerSaysVisible: shown(home.querySelector('.session-write-state')),
    noticeVisible: Boolean(notice) && getComputedStyle(notice).display !== 'none',
    overflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth,
  }
})()`

const INTERNAL_VOCABULARY = [
  /projection/i, /audited bridge/i, /coordinator thread/i, /health sweep/i,
  /source unavailable/i, /read-only/i, /\bfleet host\b/i, /subsystem/i,
  /localhost|127\.0\.0\.1/,
]
const README_PUNCTUATION = [['·', 'interpunct'], ['…', 'ellipsis'], ['—', 'em dash'], ['●', 'bullet']]

function normalize(sentence) {
  const filler = new Set(['a', 'an', 'the', 'is', 'are', 'has', 'have', 'be', 'to', 'of', 'on', 'in', 'it', 'this', 'that', 'your', 'you', 'and', 'so', 'here'])
  return sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => !filler.has(word)).join(' ')
}

async function main() {
  homeReleaseArgument() // Refuse malformed selection before creating scratch.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-home-qa-'))
  console.log(`Home QA scratch retained for inspection: ${scratch}`)
  const staged = await stageHomeRelease(scratch)
  const { exactTreeManifest } = await import('./test-account-harness.mjs')
  const { packagedLaunchCommand } = await import('./lib/packaged-platform.mjs')
  const manifest = exactTreeManifest(staged.appRoot)
  const before = JSON.stringify(manifest)
  console.log(`Home QA subject: ${staged.sourceRelease}\nstage mode: ${staged.stageMode}; unpacked native copy, not installed proof`)
  console.log(`archive identity: ${JSON.stringify(manifest.find(entry => entry.path === 'resources/app.asar'))}`)
  const profile = path.join(scratch, 'profile')
  /* THE ELECTRON USER-DATA DIRECTORY IS NOT THE SterILE PROFILE ROOT, and on
     Linux that is not a preference. shell/linux-account-state.cjs refuses a
     userData that is the home directory or its PARENT (:24), and the sterile
     profile puts HOME at <profile>/userprofile -- so launching with
     --user-data-dir=<profile> made the product refuse with
     MC_ACCOUNT_STATE_UNSAFE and exit before any window. Measured 2026-09-11:
     this driver reported "The owned application exited before Home inspection
     completed", which is a product-shaped sentence about a directory the
     harness chose. A sibling directory is what the shared harness has always
     used (userDataFor(profile) = <profile>/userdata) and it satisfies the rule
     on both platforms. */
  const userData = path.join(scratch, 'userdata')
  const environment = homeEnvironment(profile)
  cdpPort = null
  /* THE LAUNCH IS THE APPLICATION'S, AND ON LINUX IT NEEDS ONE MORE THING.
     Measured 2026-09-11 in the first Linux packaged-QA run: this driver
     reported "The owned application exited before Home inspection completed"
     after 1.5s, because the packaged ELF aborts at exit 133 --
     kernel.apparmor_restrict_unprivileged_userns=1 denies Chromium the
     namespace sandbox and an UNPACKED tree's chrome-sandbox cannot be
     root:4755. Reported as a product failure that is a lie about the product.
     packagedLaunchCommand returns the executable untouched unless the operator
     named a loaded AppArmor profile granting `userns` -- the same shape the
     shipped .deb installs -- and is the identity function on Windows. aa-exec
     execs in place, so the pid the native owner claims is still the
     application's (tools/test/packaged-platform.test.mjs measures that). */
  const launch = packagedLaunchCommand(staged.executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT_REQUEST}`])
  const result = await inspectOwnedHome({
    command: launch.command,
    args: launch.args,
    payloadRoot: path.join(staged.appRoot, 'resources', 'capability'),
    stateRoot: path.join(scratch, 'native-owner'), environment,
  }, async signal => {
    activeRunSignal = signal
    let home = null
    /* First: a window that answers at all. Separated from the wait for home
       below so the two failures cannot be reported as one -- "it never started"
       and "it started and home never drew" send a reader to opposite places. */
    const portDeadline = Date.now() + LAUNCH_TIMEOUT_MS
    for (;;) {
      signal.throwIfAborted()
      if (Date.now() > portDeadline) {
        throw new Error(cdpPort
          ? `the application published DevTools port ${cdpPort} but no page there would answer within ${LAUNCH_TIMEOUT_MS}ms`
          : `the application never wrote DevToolsActivePort into ${userData} within ${LAUNCH_TIMEOUT_MS}ms, so this run never inspected it`)
      }
      await delay(700)
      discoverDevToolsPort(userData)
      try { if (typeof await evaluate('location.hash') === 'string') break } catch { /* the window is not up yet */ }
    }

    /* Then the first-run questions, because a sterile profile always meets
       them and home is behind them. */
    const inTheApp = await walkSetup()
    check('the first-run walk ends in the application', inTheApp,
      `hash=${await evaluate('location.hash').catch((error) => `unreadable: ${error.message}`)}`)
    if (!inTheApp) throw new Error('this run never got past the first-run questions, so it never read home')

    const homeDeadline = Date.now() + LAUNCH_TIMEOUT_MS
    for (;;) {
      signal.throwIfAborted()
      if (Date.now() > homeDeadline) {
        throw new Error(`the application did not present a home screen within ${LAUNCH_TIMEOUT_MS}ms of finishing setup (DevTools port ${cdpPort}, hash ${await evaluate('location.hash').catch(() => '?')})`)
      }
      await delay(700)
      try {
        const reading = await evaluate(READ_HOME)
        /* Wait for the first-paint gate: the screen deliberately renders
           nothing until its local reads answer, so an empty caption here is
           "not ready yet", not a failure. */
        if (reading?.present && reading.caption) { home = reading; break }
      } catch { /* the page is between renders */ }
    }

    console.log(`\nhome screen read from ${staged.executable}\n  mode: ${home.mode}\n`)

    const sentences = [home.headline, ...home.facts, home.panelTitle, home.panelBadge, home.footer]
      .map((value) => String(value || '').trim()).filter(Boolean)
    const everything = [...sentences, home.panelBody].join('\n')

    check('the screen rendered at all', home.present && Boolean(home.caption))
    check('the ring states one headline, and it is on the glass',
      Boolean(home.headline) && home.headlineVisible === true,
      `${JSON.stringify(home.headline)} visible=${home.headlineVisible}`)
    check('at least one fact is VISIBLY stated under the ring, and never more than three',
      home.facts.length >= 1 && home.facts.length <= 3,
      `${home.facts.length} visible of ${home.factsInDom} in the DOM: ${JSON.stringify(home.facts)}`)
    check('the panel is titled', Boolean(home.panelTitle), JSON.stringify(home.panelTitle))
    check('the panel body is on the glass', home.panelBodyVisible === true)

    /* The reported defect, measured on the glass. */
    const worksHere = sentences.filter((s) => /already works on this/i.test(s))
    const nothingHere = sentences.filter((s) => /no local agent fleet host|cannot run agents|not set up to run agents/i.test(s))
    check('the screen does not both claim and deny that it works on this computer',
      worksHere.length === 0 || nothingHere.length === 0,
      `${JSON.stringify(worksHere)} vs ${JSON.stringify(nothingHere)}`)

    const duplicates = []
    for (let i = 0; i < sentences.length; i += 1) {
      for (let j = i + 1; j < sentences.length; j += 1) {
        if (normalize(sentences[i]) === normalize(sentences[j])) duplicates.push([sentences[i], sentences[j]])
      }
    }
    check('the screen does not say the same thing twice', duplicates.length === 0, JSON.stringify(duplicates))

    const vocabulary = INTERNAL_VOCABULARY.filter((pattern) => pattern.test(everything)).map(String)
    check('the screen names no mechanism a person does not have', vocabulary.length === 0, vocabulary.join(', '))

    const punctuation = README_PUNCTUATION.filter(([character]) => sentences.some((s) => s.includes(character)))
    check('the screen does not punctuate like a README', punctuation.length === 0, punctuation.map(([, name]) => name).join(', '))

    check('the clock shows real numbers or is not shown at all',
      home.digitsHidden || (home.digits.length > 0 && home.digits.every((digit) => /^[0-9]+$/.test(digit))),
      `hidden=${home.digitsHidden} digits=${JSON.stringify(home.digits)}`)

    /* THE RULE THE PRODUCT STATES ABOUT ITS OWN COMPOSER, CHECKED WHERE IT CAN
       STILL COME OUT FALSE.
       `|| home.mode === 'fleet'` used to close this line. It was written when
       the box was drawn in two modes -- sample and fleet -- so exempting one of
       them still left the other one measurable. The box is fleet-only now
       (src/local-activity.js: "the composer exists only where it does
       something"), which turned that clause into an exemption for every screen
       that can carry a composer at all: the check could no longer be false, and
       an assertion that cannot fail reads as coverage while providing none.
       What home actually does is the better rule anyway. The box arrives
       disabled and a sentence beside it says why -- it is checking, replies are
       switched off, or they cannot be sent right now -- and it is enabled only
       once the bridge answers that it will carry the message. So: a composer on
       the glass either accepts typing, or says in words why it does not. */
    check('an input that cannot accept anything says so beside itself',
      !home.composer || home.composerDisabled === false || (home.composerSaysVisible && home.composerSays.length > 0),
      `composer=${home.composer} disabled=${home.composerDisabled} beside it=${JSON.stringify(home.composerSays)} placeholder=${JSON.stringify(home.composerPlaceholder)}`)

    check('a demonstration is badged, and real data is not',
      home.mode === 'sample' ? Boolean(home.panelBadge) : home.panelBadge === '',
      `mode=${home.mode} badge=${JSON.stringify(home.panelBadge)}`)

    check('the floating example-data banner does not sit under home\'s own statement',
      home.noticeVisible === false, `notice visible=${home.noticeVisible}`)

    check('the page does not scroll sideways', home.overflowsHorizontally === false)
  })
  activeRunSignal = undefined
  check('the check ran to completion', !result.error, result.error?.message)
  check('the retained native owner confirmed all descendants stopped', result.cleanupConfirmed,
    'cleanup UNCONFIRMED; scratch retained, no automatic retry is safe')
  if (result.cleanupConfirmed) {
    try {
      check('the inspected packaged copy retained its exact bytes and topology',
        before === JSON.stringify(exactTreeManifest(staged.appRoot)))
      check('the selected source candidate retained its exact bytes and topology',
        before === JSON.stringify(exactTreeManifest(staged.sourceRelease)))
    } catch (error) {
      check('candidate identity was readable after native closure', false, error.message)
    }
  }

  const passed = checks.filter((entry) => entry.ok).length
  console.log(`\n${passed}/${checks.length} checks passed`)
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
  }
  process.exitCode = problems.length === 0 ? 0 : 1
}

if (require.main === module) {
  main().then(
    () => {},
    (error) => { console.error(error); process.exitCode = 2 },
  )
}

module.exports = {
  homeReleaseArgument,
  stageHomeRelease,
  homeEnvironment,
  inspectOwnedHome,
  evaluateOverCdp,
  readDevToolsPort,
  discoverDevToolsPort,
  /* Test-only reset for the process-lifetime success latch. */
  resetDevToolsPortForTest() { cdpPort = null },
}
