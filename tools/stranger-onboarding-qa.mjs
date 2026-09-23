#!/usr/bin/env node

// CAN A STRANGER WITH A BARE MACHINE GET THIS PRODUCT WORKING? MEASURED IN A
// PACKAGED WINDOW, ON A FRESH PROFILE, DRIVEN BY CLICKS.
//
// WHAT THIS EXISTS TO CATCH, stated as the measurement that produced it. A lane
// ran the shipped build as a stranger and got an agent to reply -- but only by
// copying the owner's own Codex credential into its isolated environment. A real
// customer cannot do that. What they got instead was:
//
//   * home saying "Not ready yet -- Sign in to Codex on this computer", with no
//     button, no link and no instruction anywhere in the product saying how;
//   * with an auth.json present and no `codex` on PATH, home saying "agent
//     engine ready", Start ENABLED, and every press refusing with the bare
//     string `AGENT_SESSION_FAILED`;
//   * and home reporting "3 agent runs on this computer. All 3 runs still check
//     out." after three starts that had every one of them refused.
//
// THE SECOND ONE IS THE REASON THIS FILE IS NOT A UNIT TEST. Readiness was
// computed from the environment of the process that asks, so it is only true
// when it is asked the way the product asks it: inside the packaged binary, with
// the scrubbed launch environment, from a profile that has never been set up.
// Each scenario below is one machine state, isolated to a single variable.
//
// FOUR MACHINE STATES, AND THE THIRD IS THE ONE THAT USED TO LIE:
//   bare        no Codex on PATH, no sign-in     -> must say install it, and how
//   signed-out  Codex on PATH, no sign-in        -> must say sign in, and how
//   auth-no-cli a sign-in but NO Codex on PATH   -> must NOT say it is ready
//   broken-cli  a `codex` that runs and fails    -> readiness cannot see this;
//                                                   the PRESS must explain
//                                                   itself and the run must be
//                                                   recorded as one that failed
//
// `broken-cli` is the honest test of the residual. The readiness probe answers
// PRESENCE without spawning anything, because it runs on every home mount and a
// probe that starts a child process per mount is not a read. So a `codex` that
// resolves and cannot execute reaches the press, and what this asserts there is
// that the press names a cause and the ledger records a refusal -- not that the
// probe caught it, which it deliberately does not.
//
// RULES THIS SUITE HOLDS ITSELF TO:
//   * It never assigns location.hash. A person cannot type a route, and a
//     harness that does passes on a build where nothing routes to the page. The
//     self-audit below reads this file's own source and fails if that is ever
//     broken, so the instrument cannot quietly start cheating.
//   * A control is only counted as an exit if it is VISIBLE and NAMED.
//   * An instruction is only counted if the exact command a person must run is
//     on the glass. "Install the Codex CLI" is a research task, not a remedy.
//
// ISOLATION -- one mechanism per thing that would otherwise read the real
// machine, each for a measured reason:
//   --user-data-dir  Electron resolves userData through a Windows known folder,
//                    not the environment. This is the supported override and it
//                    moves the single-instance lock, so this runs alongside a
//                    copy someone is using.
//   LOCALAPPDATA     our own resolveServicesRoot() reads it, so the machine
//                    record lands in scratch instead of the owner's.
//   USERPROFILE      so a Codex-home probe that falls back to ~ reads scratch.
//   CODEX_HOME       the sign-in this product actually looks for.
//   APPDATA          shell/agent-host.cjs resolves the npm global install under
//                    it, exactly as the payload's resolveInvocation() does.
//                    WITHOUT THIS the harness finds the OWNER'S real Codex and
//                    every "no CLI" scenario silently measures nothing.
//   PATH             rebuilt from the Windows system directories alone, so the
//                    only `codex` reachable is one this harness put there.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node, exits
// 0, and is indistinguishable from a crash.
//
// THE OWNER'S LIVE ENGINE IS NEVER TOUCHED. This starts its own packaged copy
// from a staged directory and never speaks to 4610 or 4611. It also never
// presses Start on a build it has not first confirmed is bound to its own
// supervised layer; see assertOwnBridge().
//
// RUN IT:
//   node tools/stranger-onboarding-qa.mjs
//   node tools/stranger-onboarding-qa.mjs --scenario auth-no-cli
//   node tools/stranger-onboarding-qa.mjs --keep        (keep the scratch dir)
//   --release <dir>        default release/win-unpacked
//   --open-timeout-ms <n>  how long to wait for the window (default 120000)
//
// READ THE EXIT CODE. IT HAS THREE VALUES AND ONLY TWO ARE VERDICTS:
//   0  every check passed
//   1  a check FAILED -- a statement about the product
//   2  NO VERDICT: the harness never attached, so nothing was measured. A
//      statement about the probe or the machine, never about the product.
// Never read this tool's status through a pipe: `node x.mjs | tail` reports
// TAIL's status, and a green tail over a red run is how a broken build ships.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { environmentFor as credentialSafeEnvironment } from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

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

/* ---------- the instrument audits itself ----------
 * A suite that reaches a screen by assigning the hash is not measuring whether
 * a person can reach it, and the failure is silent: it goes green while the
 * door is missing. Enforced against this file's own source rather than trusted,
 * because a rule nobody checks is a rule that lasts until the first awkward
 * afternoon. Assignment is navigation; comparison is observation, so `==`,
 * `===` and `!==` are not caught and `=` / `+=` are. */
function auditSelf() {
  const source = readFileSync(SELF, 'utf8')
  const offences = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /location\.hash\s*(\+?=)(?!=)/.test(line))
    .filter(({ line }) => !line.includes('SELF-AUDIT-PATTERN'))
  if (offences.length === 0) return
  console.error('\nNO VERDICT: this suite navigates by assigning location.hash, which is')
  console.error('the one thing a customer cannot do. Every reachability claim it makes')
  console.error('would be worthless. Offending lines:')
  for (const { line, number } of offences) console.error(`  ${number}: ${line.trim()}`)
  process.exit(2)
}

class HarnessError extends Error {}

/* ---------- staging ----------
 * A COPY is run, never release/win-unpacked itself. The GUI starts a supervised
 * capability layer that writes state/ -- bearer tokens and an audit database --
 * next to the binary, so running the artifact in place mutates the artifact. A
 * sibling harness does exactly that and contaminates the shipped build; this one
 * does not, and the copy is thrown away at the end. */
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
  /* dist/ and shell/ come from the working tree so this measures what is
     actually here, which is the point of running it before a commit. */
  for (const directory of ['dist', 'shell']) {
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

/* A PATH with nothing on it but Windows itself.
 *
 * THIS IS THE WHOLE EXPERIMENT for three of the four scenarios, so it is built
 * from a fixed list rather than filtered out of the real one. Filtering asks
 * "which entries look like they might contain codex", which is a guess that
 * fails open -- one unfamiliar directory carrying a shim and the scenario
 * silently becomes "codex IS installed", passes, and proves nothing. A fixed
 * allowlist fails the other way: if it is wrong the app does not start, which
 * is loud. */
function systemOnlyPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return [
    path.join(root, 'system32'),
    root,
    path.join(root, 'system32', 'Wbem'),
    path.join(root, 'system32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter)
}

/* A `codex` that resolves and then fails, for the one state the readiness probe
   is documented as unable to see. Deliberately NOT a broken file: it is a real,
   runnable command that exits non-zero, which is what a half-installed CLI or a
   shim pointing at an uninstalled Node behaves like. */
function plantBrokenCodex(binDirectory) {
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(
    path.join(binDirectory, 'codex.cmd'),
    '@echo off\r\necho this codex cannot run 1>&2\r\nexit /b 1\r\n',
    'utf8',
  )
  return binDirectory
}

const SCENARIOS = {
  /* Nothing at all. The state a stranger's machine is actually in. */
  bare: {
    what: 'no Codex on PATH and no sign-in',
    codexOnPath: 'none',
    signedIn: false,
    expectReady: false,
    expectCode: 'AGENT_CODEX_CLI_NOT_INSTALLED',
    /* The exact command, because a remedy a person has to go and research is
       not a remedy. Both forms are offered; the winget one is asserted because
       it is the one that works on a machine with no Node. */
    expectInstruction: /winget install OpenAI\.Codex/i,
  },
  /* Codex present, nobody signed in. The blocker the owner's screenshot showed,
     which named what was missing and never how to fix it. */
  'signed-out': {
    what: 'Codex on PATH, nobody signed in',
    codexOnPath: 'working',
    signedIn: false,
    expectReady: false,
    expectCode: 'AGENT_CONFINEMENT_SIGNED_OUT',
    expectInstruction: /codex login/i,
  },
  /* THE ONE THAT LIED. A sign-in file exists, so the old probe -- which checked
     only that $CODEX_HOME/auth.json EXISTS -- reported the engine ready and
     enabled a Start that refused every press. */
  'auth-no-cli': {
    what: 'a sign-in on disk but no Codex on PATH',
    codexOnPath: 'none',
    signedIn: true,
    expectReady: false,
    expectCode: 'AGENT_CODEX_CLI_NOT_INSTALLED',
    expectInstruction: /winget install OpenAI\.Codex/i,
  },
  /* The residual the probe cannot see without spawning. Readiness passes here
     BY DESIGN; what is under test is the press and the record. */
  'broken-cli': {
    what: 'a Codex that resolves and fails to run',
    codexOnPath: 'broken',
    signedIn: true,
    expectReady: true,
    pressStart: true,
    /* THE SPECIFIC CAUSE, not merely "a sentence".
     *
     * A planted mutation earned this line. The check used to be that the status
     * was not a bare identifier and contained words -- and when the IPC boundary
     * repair was reverted, the press fell back to the generic
     * AGENT_SESSION_FAILED copy, which is a perfectly grammatical sentence full
     * of words. The suite stayed green through the exact regression it was
     * written to catch. So the assertion is now the sentence belonging to THIS
     * fault: `codex` ran and did not report a version. Nothing but the real code
     * crossing the boundary can produce it. */
    expectRefusal: /did not answer when asked its version/i,
  },
}

async function openApp(executable, scratch, label, scenario) {
  const profile = path.join(scratch, `profile-${label}`)
  for (const leaf of ['userdata', 'local', 'home', 'appdata', 'bin']) {
    mkdirSync(path.join(profile, leaf), { recursive: true })
  }

  const environment = credentialSafeEnvironment(profile)
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.APPDATA = path.join(profile, 'appdata')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })

  /* The sign-in, or its absence. This is the only file the old probe looked at
     and it is still one of the two things that must be true. */
  if (scenario.signedIn) {
    writeFileSync(
      path.join(environment.CODEX_HOME, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'harness-not-a-real-token' } }, null, 2),
      'utf8',
    )
  }

  environment.PATH = systemOnlyPath()
  environment.Path = environment.PATH
  if (scenario.codexOnPath === 'broken') {
    environment.PATH = `${plantBrokenCodex(path.join(profile, 'bin'))}${path.delimiter}${environment.PATH}`
    environment.Path = environment.PATH
  }
  if (scenario.codexOnPath === 'working') {
    /* The REAL CLI, reached through the npm layout the payload's own resolver
       prefers, staged into this profile's APPDATA rather than pointed at the
       owner's. A copy, so nothing this harness does can touch the installation
       the owner uses. */
    const source = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex')
    if (!existsSync(source)) {
      throw new HarnessError(
        `the "signed-out" scenario needs a real Codex to copy and none is installed at ${source}. `
        + 'Run `winget install OpenAI.Codex` or `npm install -g @openai/codex`, or run with --scenario to skip this one.',
      )
    }
    const staged = path.join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex')
    mkdirSync(path.dirname(staged), { recursive: true })
    cpSync(source, staged, { recursive: true })
  }

  const userData = path.join(profile, 'userdata')
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    /* windowsHide kills the console flash only; the BrowserWindow is hidden by
       MC_SMOKE_HEADLESS=1 in the inherited environment (shell/window-options.cjs). */
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
    /* child.kill() reaches the main process only; Electron's GPU, utility and
       renderer children survive it and accumulate across runs. */
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
    const reply = await session.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
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
  /* A control counts as an exit only if it is a real box on the screen with a
     name a person could read. Returns a WORD, not a boolean, so a failure says
     which of the three ways it failed. */
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

  return { evaluate, until, clickVisible, clickLastVisible, teardown, noise }
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
      /* --remote-debugging-port=0 lets Chromium choose and publish the port.
         Asking the app which port it got, rather than telling it which to want,
         removes the window in which ten lanes racing for ephemeral ports on
         this machine can make a perfectly healthy start look like a failure. */
      while (Date.now() - started < budgetMs && port === null) {
        if (child.exitCode !== null) {
          throw new HarnessError(`the app exited with code ${child.exitCode} before publishing a debugger port; a startup failure, not a slow paint`)
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
            : 'an EMPTY target list -- the process is up but no window opened; look for a main-process throw below'
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

/* WHAT THE PRESS UNDER TEST CAN REACH, established before anything is pressed.
 *
 * THE CONCERN IS REAL AND IT IS ABOUT A DIFFERENT CONTROL. The owner's live
 * engine supervises a layer on 4611 and a node listener on 4610, the renderer
 * scans 4610-4619, and a harness that drove a dispatch control could therefore
 * drive the owner's running engine. That is a statement about the MISSION
 * BRIDGE, which is what page 2's dispatch, team and loop controls talk to.
 *
 * This suite presses exactly one control -- Start on the agent session surface
 * -- and that is not a bridge control. It goes through window.mcAgent to
 * shell/agent-host.cjs, which spawns `codex` as a child of THIS window's own
 * process. The port range is not involved on that path at all. So the honest
 * assertion is not "which bridge am I bound to" but "the thing I am about to
 * press cannot reach one", and it is made by checking that the press path is
 * mcAgent and that no dispatch control is on this screen to be pressed by
 * accident.
 *
 * Stated rather than assumed because the earlier version of this function
 * probed a `window.mcBridge` that does not exist, got `known: false`, and would
 * have let the run continue on the strength of a check that could never fail.
 * A guard that cannot go red is not a guard. */
async function assertPressCannotReachTheBridge(evaluate) {
  return evaluate(`(() => {
    const dispatch = [...document.querySelectorAll('[data-bridge-action], [data-launch], [data-team], [data-loop]')]
    return {
      agentChannel: typeof window.mcAgent?.start === 'function',
      /* Anything on this screen that talks to the mission bridge. Must be zero:
         the agent page has no dispatch surface, and if one ever appears here
         this run stops rather than pressing blind. */
      bridgeControlsOnScreen: dispatch.length,
      startControls: document.querySelectorAll('[data-session-start]').length,
    }
  })()`)
}

const PROBE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!(box.width > 0 && box.height > 0)) return false
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const norm = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const read = selector => {
    const node = document.querySelector(selector)
    return { present: Boolean(node), visible: shown(node), text: norm(node) }
  }
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    /* The whole visible page. An instruction that is in the DOM but not on the
       glass is not an instruction, so this is innerText, never innerHTML. */
    screen: (document.body.innerText || '').replace(/\\s+/g, ' ').trim(),
    headline: read('.home .uring-sub, .home [data-home-headline]'),
    facts: [...document.querySelectorAll('.home-facts .home-fact')].map(node => norm(node)),
    panelFoot: read('.home [data-panel-foot]'),
    runRows: [...document.querySelectorAll('.home-runs .home-run')].map(node => ({
      what: norm(node.querySelector('.run-what')),
      result: norm(node.querySelector('.run-result')),
    })),
    startPresent: Boolean(document.querySelector('[data-session-start]')),
    startVisible: shown(document.querySelector('[data-session-start]')),
    startDisabled: Boolean(document.querySelector('[data-session-start]')?.disabled),
    sessionStatus: read('[data-session-status]'),
  }
})()`

async function runScenario(executable, scratch, name) {
  const scenario = SCENARIOS[name]
  const checks = []
  const check = (what, ok, detail = '') => {
    checks.push({ name: `${name}: ${what}`, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  }
  const note = detail => console.log(`  ..    ${detail}`)

  console.log(`\n== ${name}: ${scenario.what} ==`)
  const app = await openApp(executable, scratch, name, scenario)
  const { evaluate, until, clickVisible, clickLastVisible, teardown } = app
  try {
    /* ---------- a true first launch, walked by pressing things ---------- */
    const onSetup = await until('the permission question', `location.hash === '#/setup'`)
    check('a fresh profile opens on the permission question', onSetup, `hash=${await evaluate('location.hash')}`)
    if (!onSetup) return checks

    const continued = await clickVisible('[data-setup-continue]')
    check('the permission question continues on the shipped default', continued === 'clicked', String(continued))
    const atFolder = await until('the folder question',
      `document.querySelector('[data-setup-section]')?.innerText.includes('Which folder')`)
    check('it reaches the folder question', atFolder)
    await until('the folder to resolve', `document.querySelector('.setup-root-path') !== null`)
    await clickLastVisible('[data-setup-next]')
    await until('the sign-in step',
      `document.querySelector('[data-setup-section]')?.innerText.includes('Who is using this copy') || document.querySelector('[data-setup-section]')?.innerText.includes('Signed in as')`)
    await clickLastVisible('[data-setup-next]')
    const atAutonomy = await until('the autonomy question',
      `document.querySelector('[data-setup-section]')?.innerText.includes('without asking')`)
    check('it reaches the autonomy question', atAutonomy)
    /* The MIDDLE answer of three, not the most permissive. It is the one that
       switches `agent-session` on at every tier, which is what puts a Start
       control on the agent page at all -- without it the press scenario would
       find no control and silently measure nothing. */
    await clickVisible('[data-setup-set="autonomy"][data-setup-value="assisted"]')
    /* WAIT FOR THE RE-RENDER THE ANSWER ABOVE CAUSES. Answering re-renders the
       section, and for a frame the forward control is not in the document;
       clickVisible does one querySelector and does not retry, so firing it
       straight after the answer is a race. Every other transition in this walk
       is already guarded by an `until` -- this was the one that was not.
       MEASURED (R1531 w1, 2026-08-12): the SAME packed build scored 34/54 then
       44/54 on two consecutive runs with two different failure sets, both
       starting here with `it reaches the review -- absent`, while the previous
       build scored 65/65. Read without this wait, that difference looks like a
       hard regression introduced by the newer commit; the newer commit only
       made the renderer bundle bigger and moved the re-render by a frame. A
       harness that invents a product defect is worse than no harness. With the
       wait, this step passes. No full-suite green number is quoted here on
       purpose: see the port note on the next wait. */
    await until('the review control to be re-rendered', `!!document.querySelector('[data-setup-next="review"]')`)
    const toReview = await clickVisible('[data-setup-next="review"]')
    check('it reaches the review', toReview === 'clicked', String(toReview))
    const atReview = await until('the review',
      `document.querySelector('[data-setup-section]')?.innerText.includes('what those answers set')`)
    check('the review draws', atReview)

    /* ---------- THE SETUP STEP THAT DID NOT EXIST ----------
       Setup used to finish without ever naming Codex, and hand the person a
       home screen blocked on it. */
    /* THIS WAIT USED TO BE SATISFIED BY AN ABSENCE, WHICH IS THIS CODEBASE'S
       NAMED RECURRING DEFECT. Its condition was only
       `!innerText.includes('Checking whether Codex')` -- and a review body that
       has not rendered that line YET does not contain it either, so the wait
       returned true on its first poll against a half-drawn screen. Measured
       (R1531 w1, 2026-08-12): the very next read then got 1337 characters of
       review copy instead of 3208, and `[data-setup-next="finish"]` came back
       'absent', reporting "setup names Codex before it finishes" and "the
       review can be accepted" as product failures on a build where both are
       fine. "Nothing says Checking" means BOTH "the check finished" and "the
       check has not started"; only a positive signal separates them. So the
       condition now also requires the review to be the screen on show and its
       own accept control to exist -- three facts a blank screen cannot fake. */
    await until('the readiness answer on the review', `(() => {
      const text = document.querySelector('[data-setup-section]')?.innerText || ''
      return text.includes('what those answers set')
        && !text.includes('Checking whether Codex')
        && !!document.querySelector('[data-setup-next="finish"]')
    })()`)
    const reviewText = await evaluate(`document.querySelector('[data-setup-section]')?.innerText || ''`)
    check('setup names Codex before it finishes', /codex/i.test(reviewText),
      reviewText ? `${reviewText.length} chars of review copy` : 'no review copy at all')
    if (!scenario.expectReady) {
      check('setup gives the command, not just the diagnosis',
        scenario.expectInstruction.test(reviewText),
        `looked for ${scenario.expectInstruction}`)
    }

    const finished = await clickVisible('[data-setup-next="finish"]')
    check('the review can be accepted', finished === 'clicked', String(finished))
    const intoApp = await until('the app itself', `location.hash === '#/' || location.hash === ''`, 120)
    check('setup ends in the app', intoApp, `hash=${await evaluate('location.hash')}`)
    await delay(1200)

    /* ---------- what home says ---------- */
    const home = await evaluate(PROBE)
    note(`home facts: ${JSON.stringify(home.facts)}`)

    if (!scenario.expectReady) {
      /* THE HEADLINE CLAIM OF THIS WHOLE SUITE. Not merely that it refuses --
         that it refuses and says what to do about it. */
      check('home does not claim agents can run',
        !/agents can run on this computer/i.test(home.screen),
        home.facts.join(' | '))
      check('home names the remedy as a command a person can run',
        scenario.expectInstruction.test(home.screen),
        `looked for ${scenario.expectInstruction} on the glass`)
    } else {
      check('home reports the engine as ready when every precondition is met',
        /agents can run on this computer/i.test(home.screen),
        home.facts.join(' | '))
    }

    /* ---------- the availability code itself ---------- */
    const availability = await evaluate(`(async () => {
      try { return await window.mcAgent.availability() } catch (error) { return { threw: String(error && error.message || error) } }
    })()`)
    note(`availability = ${JSON.stringify(availability)}`)
    if (scenario.expectCode) {
      check(`readiness answers ${scenario.expectCode}`,
        availability && availability.ok === false && availability.code === scenario.expectCode,
        JSON.stringify(availability))
    }
    if (scenario.expectReady) {
      check('readiness answers ready', availability && availability.ok === true, JSON.stringify(availability))
    }

    /* ---------- the press, only where a press is the thing under test ---------- */
    if (scenario.pressStart) {
      /* ---------- reach the agent page the way a person does ---------- */
      const toComputers = await clickVisible('#nav-next')
      check('the forward chevron reaches the computers page', toComputers === 'clicked', String(toComputers))
      await until('the computers page', `document.body.dataset.route === 'computers'`)
      await delay(1400)
      const opened = await clickVisible('.computers .graph-open-btn')
      check('the door into the agent page can be pressed', opened === 'clicked', String(opened))
      const arrived = await until('the agent detail page', `Boolean(document.querySelector('.agentv'))`)
      check('the agent page is reachable by clicking', arrived)
      await delay(1200)

      const press = await assertPressCannotReachTheBridge(evaluate)
      note(`press path: ${JSON.stringify(press)}`)
      /* Not a product check. A refusal to measure, which must never read as a
         finding about the product -- see the exit-code note at the top. */
      if (press.bridgeControlsOnScreen > 0) {
        throw new HarnessError(
          `${press.bridgeControlsOnScreen} mission-bridge control(s) are on the agent page, which this suite did not expect. `
          + 'Refusing to press anything: a stray press here could reach the owner\'s running engine.',
        )
      }
      if (!press.agentChannel) {
        throw new HarnessError('window.mcAgent.start is not a function, so this window cannot start a session at all')
      }

      const reached = press.startControls > 0
      check('a start control is on the page it reached', reached, JSON.stringify(press))
      if (reached) {
        /* THE PROMPT IS PART OF THE PRESS. The textarea is `required`, so a
           click on Start with it empty is swallowed by the browser's own form
           validation and the submit handler never runs -- the first version of
           this harness did exactly that, measured the status row still reading
           "agent engine ready", and reported three failures that were its own.
           Set through the native value setter and followed by an `input` event
           so the field is filled the way typing fills it. */
        const typed = await evaluate(`(() => {
          const field = document.querySelector('[data-session-form] textarea[name="text"]')
          if (!field) return 'absent'
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          setter.call(field, 'Reply with exactly the word CANARY and nothing else.')
          field.dispatchEvent(new Event('input', { bubbles: true }))
          return field.value.length > 0 && field.checkValidity() ? 'typed' : 'invalid'
        })()`)
        check('a prompt can be typed into the agent form', typed === 'typed', String(typed))
        await clickVisible('[data-session-start]')
        await until('the press to resolve',
          `!/^\\s*$/.test(document.querySelector('[data-session-status]')?.textContent || '') `
          + `&& !/starting/i.test(document.querySelector('[data-session-status]')?.textContent || '')`, 80)
        const after = await evaluate(PROBE)
        const status = after.sessionStatus.text || ''
        note(`session status after the press: ${JSON.stringify(status)}`)

        /* THE BARE STRING IS THE DEFECT. A refusal that prints a constant tells
           a person nothing; the code is an identifier, the sentence is the
           product. */
        check('a refused press does not print a bare code',
          !/AGENT_SESSION_FAILED/.test(status) && !/^refused\s*·\s*[A-Z_]+$/.test(status.trim()),
          JSON.stringify(status))
        check('a refused press names a cause in words',
          /refused/i.test(status) && /[a-z]{4,}\s+[a-z]{4,}/.test(status),
          JSON.stringify(status))
        /* The one that can actually tell a repaired boundary from a broken one.
           See expectRefusal in the scenario table. */
        check('a refused press names THIS fault, not the generic fallback',
          scenario.expectRefusal.test(status),
          `looked for ${scenario.expectRefusal} in ${JSON.stringify(status)}`)

        /* ---------- and the run must now LOOK like the failure it was ---------- */
        const history = await evaluate(`(async () => {
          try { return await window.mcAgent.history({ limit: 20 }) } catch (error) { return { threw: String(error) } }
        })()`)
        note(`history outcomes = ${JSON.stringify(history && history.outcomes)}`)
        check('the ledger records that the run refused',
          history && history.outcomes && history.outcomes.refused >= 1,
          JSON.stringify(history && history.outcomes))
        check('the ledger counts one run, not one per record',
          history && history.outcomes && history.outcomes.starts === 1,
          JSON.stringify(history && history.outcomes))

        /* ---------- AND THE SCREEN A PERSON ACTUALLY LOOKS AT ----------
           Recording the outcome is half the repair. The measured defect was on
           HOME: "3 agent runs on this computer" over "All 3 runs still check
           out", after three starts that had every one of them refused. So walk
           back there by pressing the ring, the way a person would, and read it. */
        const backToComputers = await clickVisible('#nav-back')
        check('the back arrow leaves the agent page', backToComputers === 'clicked', String(backToComputers))
        await until('the computers page', `document.body.dataset.route === 'computers'`, 40)
        const backHome = await clickVisible('#nav-back')
        check('the back arrow reaches home', backHome === 'clicked', String(backHome))
        const atHome = await until('home', `document.body.dataset.route === 'home'`, 40)
        check('home draws again', atHome)
        await delay(1500)

        const afterHome = await evaluate(PROBE)
        note(`home footer: ${JSON.stringify(afterHome.panelFoot.text)}`)
        note(`home run rows: ${JSON.stringify(afterHome.runRows)}`)
        check('home says the run did not start',
          /did not start/i.test(afterHome.panelFoot.text) || afterHome.runRows.some(row => /did not start/i.test(row.result)),
          JSON.stringify({ foot: afterHome.panelFoot.text, rows: afterHome.runRows }))
        /* THE EXACT SENTENCE THAT USED TO MISLEAD. An integrity result phrased
           so it reads as a statement about the agents. */
        check('home does not report a failed run as one that checks out',
          !/all 1 runs? still check out/i.test(afterHome.panelFoot.text),
          JSON.stringify(afterHome.panelFoot.text))
      }
    }
  } finally {
    await teardown()
  }
  return checks
}

async function main() {
  auditSelf()
  const only = argument('--scenario')
  const names = only ? [only] : Object.keys(SCENARIOS)
  for (const name of names) {
    if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'stranger-onboarding-'))
  const results = []
  try {
    const executable = await stage(scratch)
    console.log(`staged a copy at ${executable}`)
    for (const name of names) results.push(...await runScenario(executable, scratch, name))
  } finally {
    /* CLEANUP CANNOT FAIL THE RUN. A sibling harness exited 1 after 45 of 45
       checks passed because Windows still held a DLL in the staged copy and the
       remove threw out of a finally -- reporting a red run that had measured a
       green product. The directory is named on the way out so a leak is
       visible rather than silent. */
    if (KEEP) {
      console.log(`\nkept the scratch directory at ${scratch}`)
    } else {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      } catch (error) {
        console.log(`\ncould not remove the scratch directory (${error.code || error.message}); it is at ${scratch}`)
      }
    }
  }

  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
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
      console.error('\nNO VERDICT -- nothing about the product was measured.')
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error('\nNO VERDICT -- the harness failed before it could measure anything.')
    console.error(error?.stack || String(error))
    process.exitCode = 2
  },
)
