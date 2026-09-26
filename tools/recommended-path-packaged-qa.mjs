#!/usr/bin/env node

// THE RECOMMENDED PATH, AND STEERING WHAT IT STARTS, MEASURED ON THE WINDOW.
//
// TWO DEFECTS, ONE ROOT, AND NEITHER OF THEM VISIBLE TO A SOURCE-TEXT TEST.
//
// 1. THE RECOMMENDED ANSWER LED NOWHERE. The setup walkthrough marked two
//    answers Recommended, and taking both produced an installation with NO
//    CONTROL ANYWHERE THAT STARTS AN AGENT: the recommended autonomy answer
//    switched on nothing that acts, and starting a session is one of the things
//    it switched off. To reach a running agent a person had to REFUSE the
//    recommendation. Every "eight clicks to a running agent" measurement this
//    project holds was obtained by ignoring the product's own advice, and the
//    readers most likely to follow that advice are the least equipped to work
//    out why nothing happens.
//
// 2. A RUNNING SESSION COULD NOT BE STEERED. Pause, Respawn and Terminate
//    reported that no observed control target was mapped to the declared agent
//    while a session was genuinely running on the same page.
//
// WHY THIS IS A PACKAGED-WINDOW SUITE. Both defects are absences, and absence
// is exactly what source text cannot see: a Start control that is never
// rendered greps identically to one that is. The unit suites
// (tools/test/setup-profile.test.mjs, tools/test/agent-session-steering.test.mjs)
// assert the derivation and the decision; only rendering the page and pressing
// the buttons can say whether a person meets a control.
//
// SCENARIOS, each in its own sterile profile:
//   recommended   Walk the first-run walkthrough touching NOTHING but Continue
//                 and Finish -- the trusting reader's exact path -- then open an
//                 agent page and require an enabled Start.
//   observe       Deliberately choose the answer that starts nothing, and
//                 require the agent page to SAY SO and offer the switch, rather
//                 than rendering an absence. Then press the switch and require
//                 Start to appear.
//   steering      With a session actually running, require Pause and Terminate
//                 to be enabled and to act.
//
// ISOLATION, for the reasons tools/example-page-write-fence-qa.mjs sets out:
//   --user-data-dir  supported userData override; also changes the instance
//                    lock key, so this runs beside a copy someone else is using.
//   LOCALAPPDATA     resolveServicesRoot() is our own code reading the
//                    environment; without it this reads the OWNER's records.
//   USERPROFILE      so the confinement probe reads scratch, not a real profile.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node and
// exits 0, which is indistinguishable from a crash.
//
// IT KILLS ONLY THE PROCESS IT STARTED and writes nothing under release/.
//
// RUN IT:
//   node tools/recommended-path-packaged-qa.mjs --scenario provider-free
//   node tools/recommended-path-packaged-qa.mjs --scenario steering --keep
// The default is also provider-free. Steering is deliberately manual because
// it starts a signed-in provider session.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* THE STEERING TRIO, PRESSED THE WAY tools/lib/fleet-node.mjs's OTHER
 * CONSUMERS ALREADY PRESS EVERYTHING ELSE (team-panel-packaged-qa.mjs,
 * refusal-copy-qa.mjs, example-page-write-fence-qa.mjs): a real
 * Input.dispatchMouseEvent at a point document.elementFromPoint proves
 * belongs to the control, never `.click()`. A synthetic click succeeds
 * against a covered, hidden or zero-size control, which is exactly the
 * class of false green that method exists to catch. createPresser() takes
 * this file's own {session, evaluate, delay} unchanged: the raw CDP
 * `session.send(method, params)` this file already builds (createSession(),
 * above) is the same shape fleet-node.mjs's press() calls
 * Input.dispatchMouseEvent through. */
import { createPresser } from './lib/fleet-node.mjs'
import {
  environmentFor as credentialSafeEnvironment,
  resolveMachineServicesRoot,
} from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const ONLY = argument('--scenario')
const TIER = argument('--tier', 'standard')
const SHOTS = argument('--shots') ? path.resolve(argument('--shots')) : null

export const PROVIDER_FREE_SCENARIO = 'provider-free'

export function selectedScenarios(requested = null) {
  if (!requested || requested === PROVIDER_FREE_SCENARIO) return ['recommended', 'observe']
  return [requested]
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* WAS A SEVENTH COPY OF THE SAME RULE, AND OFF WINDOWS EVERY COPY WAS WRONG.
   This function read `.exe` out of the app root; a Linux candidate has none, so
   it refused before measuring anything. tools/lib/packaged-platform.mjs owns
   the one answer -- the same Windows launcher-by-shape logic, plus an ELF
   branch that opens the file with O_NOFOLLOW and checks the magic. */

/* Borrow the built binary and swap in the CURRENT renderer and shell, rather
   than running electron-builder -- which has damaged node_modules through this
   worktree's junction for three separate lanes in one day. Nothing under
   release/ is written. */
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
  await asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
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

/* A PORT NOBODY ELSE HOLDS, ASKED FOR RATHER THAN GUESSED. A fixed debugger
   port was measured at one failure in four consecutive runs elsewhere in this
   tree, and its symptom is indistinguishable from a startup crash. */
async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function createSession(port, child, startupLog) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered -- a STARTUP failure, not a result.\n${startupLog.join('')}`)
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

function seedMachineRecord(profile, appRoot, tier) {
  const workspace = path.join(profile, 'home', 'ToolsEnabled')
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
  mkdirSync(servicesRoot, { recursive: true })
  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  }), { servicesRoot })
}

/* A REAL LIVE PROJECTION, delivered the way the product actually delivers one:
   the shell serves /data/<domain>.json from the directory the fleet profile
   configures, so a file dropped into dist/data is ignored. */
function seedLiveProjection(profile) {
  const projectionDirectory = path.join(profile, 'projection')
  mkdirSync(projectionDirectory, { recursive: true })
  const observedAt = new Date().toISOString()
  writeFileSync(path.join(projectionDirectory, 'agents.json'), JSON.stringify({
    schemaVersion: 1,
    domain: 'agents',
    generatedAt: observedAt,
    ok: true,
    reason: null,
    sources: [{ id: 'recommended-path-qa', kind: 'directory', path: 'scratch', ok: true, observedAt, reason: null }],
    data: {
      revision: 1,
      contentHash: 'a'.repeat(64),
      declared: [
        { id: 'terra-01', displayName: 'terra-01', role: 'manager', provider: 'gpt-5.6', enabled: true, assignedPhase: null, phasePriority: [], controlTarget: null },
        { id: 'codex', displayName: 'codex', role: 'controller', provider: 'gpt-5.6', enabled: true, assignedPhase: null, phasePriority: [], controlTarget: null },
      ],
      relationships: [{ from: 'codex', to: 'terra-01', type: 'manages', sourceKind: 'declared' }],
      observedSessions: { ok: true, reason: null, observedAt, value: [] },
    },
  }), 'utf8')

  const userData = path.join(profile, 'userdata')
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(userData, 'fleet-profile.json'), `${JSON.stringify({
    storageVersion: 1,
    state: 'configured',
    profile: {
      schemaVersion: 1,
      id: 'pathqa',
      label: 'Recommended path QA fleet',
      machines: [{ id: 'a', name: 'Machine A', ip: '127.0.0.1' }],
      transports: [{ id: 'bridge', label: 'Bridge', endpoint: '127.0.0.1:8788' }],
      dataSource: { kind: 'directory', path: projectionDirectory },
    },
  })}\n`, 'utf8')
}

/* WHAT IS ACTUALLY ON THE GLASS. `shown` is measured rather than assumed: a
   stylesheet that hides a control leaves every node where a querySelector finds
   it, and for THIS suite a control that exists but cannot be seen is still a
   dead end for the person looking at the screen. */
const READ_AGENT_PAGE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : null)
  const ctl = name => document.querySelector('[data-control="' + name + '"]')
  const face = name => {
    const node = ctl(name)
    if (!node) return null
    return {
      label: text(node.querySelector('.ctl-label')),
      note: text(node.querySelector('.ctl-note')),
      disabled: node.disabled === true,
      shown: shown(node),
    }
  }
  const start = document.querySelector('[data-session-start]')
  return {
    agentPage: Boolean(document.querySelector('.agentv')),
    liveMode: document.querySelector('.agentv')?.dataset.liveMode ?? null,
    sessionSurface: Boolean(document.querySelector('.agent-session-surface')),
    offSurface: Boolean(document.querySelector('[data-session-off]')),
    offReason: text(document.querySelector('[data-session-off] [data-action-output]')),
    enableButton: Boolean(document.querySelector('[data-session-enable]')),
    startPresent: Boolean(start),
    startShown: shown(start),
    startDisabled: start ? start.disabled : null,
    sessionStatus: text(document.querySelector('[data-session-status]')),
    pause: face('pause'),
    respawn: face('respawn'),
    terminate: face('terminate'),
    result: text(document.querySelector('.ctl-result')),
    writeFlag: localStorage.getItem('mc.write.agent-session'),
    autonomy: (() => {
      try {
        const stored = localStorage.getItem('mc.setup.profile')
        if (stored === null) return null
        return JSON.parse(stored)?.answers?.autonomy ?? null
      } catch (error) {
        return {
          code: 'COULD_NOT_READ_SETUP_PROFILE',
          causeCode: error && typeof error === 'object' && typeof error.code === 'string'
            ? error.code
            : 'NO_ERROR_CODE',
          message: 'Could not read the setup profile; this does not claim that the profile or autonomy answer is absent.',
        }
      }
    })(),
  }
})()`

async function withApp(scratch, executable, label, seed, body, { signedInCodexHome = false } = {}) {
  const port = await freePort()
  const profile = path.join(scratch, `profile-${label}`)
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  seed(profile)

  const environment = credentialSafeEnvironment(profile)
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  /* CODEX_HOME IS THE ONE THING A SCENARIO MAY UN-STERILISE, and only the
     steering scenario asks for it.
     A genuinely empty profile has no CLI sign-in, so no session can start, so
     there is nothing to steer -- and a run that cannot start a session cannot
     report anything about the controls that steer one. The steering scenario
     therefore points CODEX_HOME at this account's existing CLI sign-in, which
     is the state every real user of the product is in. It reads that directory
     and never copies, prints or writes it, and the app's own records
     (LOCALAPPDATA) and the confinement probe's home (USERPROFILE) stay in
     scratch, so nothing this run does touches the real installation. */
  if (signedInCodexHome && process.env.USERPROFILE) {
    environment.CODEX_HOME = path.join(process.env.USERPROFILE, '.codex')
  } else {
    environment.CODEX_HOME = path.join(profile, 'home', '.codex')
    mkdirSync(environment.CODEX_HOME, { recursive: true })
  }

  const startupLog = []
  const child = spawn(executable, [
    `--user-data-dir=${path.join(profile, 'userdata')}`,
    `--remote-debugging-port=${port}`,
    /* windowsHide kills the console flash only; the BrowserWindow is hidden by
       MC_SMOKE_HEADLESS=1 in the inherited environment (shell/window-options.cjs). */
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', chunk => startupLog.push(String(chunk)))
  child.stderr.on('data', chunk => startupLog.push(String(chunk)))

  const session = createSession(port, child, startupLog)
  try {
    await session.open()
    await session.send('Runtime.enable')
    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) {
        throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      }
      return packet.result?.result?.value
    }
    const until = async (what, expression, attempts = 60) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return true
        await delay(250)
      }
      throw new Error(`timed out waiting for ${what}`)
    }
    /* Real input, not a DOM call. See the import note above -- same
       {session, evaluate, delay} this file already builds, just handed to
       the shared presser rather than to a raw evaluate('...click()'). */
    const { press } = createPresser({ session, evaluate, delay })
    /* A PICTURE OF THE SCREEN THAT WAS MEASURED. The assertions above read the
       DOM; a stylesheet that renders a control invisible, or a panel that lands
       under the fold, is a defect no querySelector can report. These are for a
       person to look at, and they are written to scratch rather than into the
       repository. */
    const shot = async (name) => {
      if (!SHOTS) return null
      const packet = await session.send('Page.captureScreenshot', { format: 'png' })
      const data = packet.result?.data
      if (!data) return null
      mkdirSync(SHOTS, { recursive: true })
      const file = path.join(SHOTS, `${label}-${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`  shot  ${file}`)
      return file
    }
    if (SHOTS) await session.send('Page.enable')
    return await body({ evaluate, until, shot, press })
  } finally {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    await delay(800)
  }
}

const results = []
function check(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

/* ---------- scenario 1: the trusting reader's exact path ---------- */

async function recommendedPath(scratch, executable) {
  console.log('\n[recommended] the walkthrough, touching nothing but Continue and Finish')
  /* THE RECOMMENDED PERMISSION LEVEL IS SEEDED, NOT CLICKED, AND THAT IS A
     STATED LIMIT OF THIS RUN RATHER THAN A CONVENIENCE.
     `guided` is what the tier question recommends, so seeding it measures the
     same combination a person who takes both recommendations lands on -- and it
     is the HARDER half, because guided's ceiling refuses two of the flags the
     autonomy answer asks for. It is seeded so that this suite's subject stays
     the AUTONOMY answer rather than the tier screen.

     THIS USED TO SAY THE TIER STEP WAS NOT COMPLETABLE FROM A STERILE PROFILE,
     citing tools/setup-walkthrough-qa.mjs --mode finish failing at the same
     point, and handed the diagnosis to whoever owned the tier record. That was
     honest when written and is now false, so it is corrected rather than left
     to send the next reader hunting a defect that is gone. The failure was not
     the tier step: it was Finish silently dropping the press when its view had
     been torn down mid-flow (src/views/setup.js finish(), and the router's
     420ms exit window that lets a person click a view already on its way out).
     Both modes of that harness now pass, and
     tools/setup-deadend-recommended-qa.mjs walks the whole walkthrough from a
     sterile profile -- tier question included -- without seeding anything. */
  return withApp(scratch, executable, 'recommended', profile => {
    seedMachineRecord(profile, path.join(scratch, 'app'), 'guided')
    /* A declared agent has to EXIST for there to be an agent page to look at.
       This seeds the projection the shell serves, exactly as the shipped
       product delivers one; it says nothing about which controls appear on it,
       which is what this run measures. */
    seedLiveProjection(profile)
  }, async ({ evaluate, until, shot }) => {
    const screen = () => evaluate('document.querySelector("[data-setup-section]")?.innerText || ""')
    const clickLast = selector => evaluate(
      `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (!nodes.length) return false; nodes[nodes.length - 1].click(); return true })()`,
    )

    await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
    await evaluate('location.hash = "#/setup"')
    /* NOT ONE ANSWER IS TOUCHED. Every click below is the forward button. If the
       walkthrough's own defaults lead somewhere unusable, this is the run that
       finds out. */
    await until('the folder question', 'document.querySelector("[data-setup-section]")?.innerText.includes("Which folder")')
    await clickLast('[data-setup-next]')
    await until('the account step', 'document.querySelector("[data-setup-section]").innerText.includes("Who is using this copy") || document.querySelector("[data-setup-section]").innerText.includes("Signed in as")')
    await clickLast('[data-setup-next]')
    await until('the autonomy question', 'document.querySelector("[data-setup-section]").innerText.includes("without asking")')

    await shot('autonomy-question')
    const autonomyScreen = await screen()
    const preselected = await evaluate('document.querySelector(\'[data-setup-set="autonomy"][aria-pressed="true"]\')?.dataset.setupValue ?? null')
    check('recommended', 'the walkthrough preselects an answer', Boolean(preselected), String(preselected))
    check('recommended', 'the preselected answer is the one marked Recommended',
      autonomyScreen.includes('Recommended'),
      `preselected=${preselected}`)

    await evaluate('document.querySelector(\'[data-setup-next="review"]\').click()')
    await until('the review', 'document.querySelector("[data-setup-section]").innerText.includes("what those answers set")')
    const review = await screen()
    check('recommended', 'the review does not warn that nothing will start an agent',
      !review.includes('nothing here will start an agent'),
      'a recommended path that has to warn about itself is still the defect')

    await evaluate('document.querySelector(\'[data-setup-next="finish"]\').click()')
    try {
      await until('the app', 'location.hash === "#/" || location.hash === ""', 120)
    } catch (error) {
      /* NAME WHAT THE SCREEN SAID. "Timed out" on its own is the reading that
         costs the next person an hour; the walkthrough states its own refusals
         in the section, so quote it. */
      const stuck = await screen()
      throw new Error(`${error.message}. hash=${await evaluate('location.hash')} section says: ${stuck.slice(0, 400)}`)
    }

    /* THE QUESTION THE WHOLE DEFECT TURNS ON, asked of the finished install. */
    await evaluate('location.hash = "#/agent/c1/terra-01"')
    await until('the agent page', 'Boolean(document.querySelector(".agentv"))', 80)
    await delay(2500)
    await evaluate("document.querySelector('.agent-session-surface')?.scrollIntoView({ block: 'center' })")
    await delay(400)
    await shot('agent-page')
    const page = await evaluate(READ_AGENT_PAGE)
    check('recommended', 'the recommended answers leave the start control switched on',
      page.writeFlag === 'enabled', `mc.write.agent-session=${page.writeFlag}, autonomy=${page.autonomy}`)
    check('recommended', 'a Start control is on the agent page', page.startPresent && page.startShown,
      `present=${page.startPresent} shown=${page.startShown}`)
    check('recommended', 'and it is not switched off by a setting the person never saw',
      page.startPresent && page.offSurface === false, `status=${page.sessionStatus}`)
    return page
  })
}

/* ---------- scenario 2: the answer that starts nothing, chosen deliberately ---------- */

async function observePath(scratch, executable) {
  console.log('\n[observe] choosing the answer that starts nothing, on purpose')
  return withApp(scratch, executable, 'observe', profile => {
    seedMachineRecord(profile, path.join(scratch, 'app'), TIER)
    seedLiveProjection(profile)
  }, async ({ evaluate, until, shot }) => {
    await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
    /* The state a person is in after choosing "Nothing yet -- let me look around
       first": the profile records that answer and the flag is off. Written
       directly rather than re-walking the walkthrough, because scenario 1
       already measured the walkthrough; this scenario is about the AGENT PAGE
       such an answer leads to. */
    await evaluate(`(() => {
      localStorage.removeItem('mc.example');
      localStorage.setItem('mc.write.agent-session', 'disabled');
      localStorage.setItem('mc.setup.profile', JSON.stringify({
        schemaVersion: 1, status: 'complete', step: 'review',
        answers: { autonomy: 'observe', screens: 'live', workspaceRoots: [] },
        updatedAtMs: Date.now(),
      }));
      location.hash = '#/agent/c1/terra-01';
    })()`)
    await evaluate('location.reload()')
    await until('the agent page', 'Boolean(document.querySelector(".agentv"))', 80)
    await delay(2000)

    await evaluate("document.querySelector('.agent-session-surface')?.scrollIntoView({ block: 'center' })")
    await delay(400)
    await shot('switched-off')
    const before = await evaluate(READ_AGENT_PAGE)
    check('observe', 'the page does not simply render an absence', before.offSurface,
      `sessionSurface=${before.sessionSurface} offSurface=${before.offSurface}`)
    check('observe', 'it names the answer that switched starting off',
      typeof before.offReason === 'string' && /look around first/i.test(before.offReason),
      before.offReason ? before.offReason.slice(0, 90) : String(before.offReason))
    check('observe', 'no Start control is offered while it is off', before.startPresent === false)
    check('observe', 'the switch that turns it on is right there', before.enableButton)

    await evaluate('document.querySelector("[data-session-enable]").click()')
    await delay(2500)
    await evaluate("document.querySelector('.agent-session-surface')?.scrollIntoView({ block: 'center' })")
    await delay(400)
    await shot('after-switching-on')
    const after = await evaluate(READ_AGENT_PAGE)
    check('observe', 'pressing it puts a Start control on the page', after.startPresent && after.startShown,
      `writeFlag=${after.writeFlag} status=${after.sessionStatus}`)
    check('observe', 'and nothing was started by the act of switching it on',
      after.sessionStatus !== null && !/running/.test(String(after.sessionStatus)), String(after.sessionStatus))
    return { before, after }
  })
}

/* ---------- scenario 3: steering a session that is genuinely running ---------- */

async function steeringPath(scratch, executable) {
  console.log('\n[steering] a real session, then the three controls')
  return withApp(scratch, executable, 'steering', profile => {
    seedMachineRecord(profile, path.join(scratch, 'app'), TIER)
    seedLiveProjection(profile)
  }, async ({ evaluate, until, shot, press }) => {
    await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
    await evaluate(`(() => {
      localStorage.removeItem('mc.example');
      localStorage.setItem('mc.write.agent-session', 'enabled');
      localStorage.setItem('mc.theme', 'tan');
      location.hash = '#/agent/c1/terra-01';
    })()`)
    await evaluate('location.reload()')
    await until('the agent page', 'Boolean(document.querySelector(".agentv"))', 80)
    await delay(2500)

    const idle = await evaluate(READ_AGENT_PAGE)
    check('steering', 'with nothing running, the controls refuse in words a person can act on',
      idle.pause?.disabled === true && /Start one above/.test(String(idle.result)),
      String(idle.result).slice(0, 110))
    check('steering', 'and the refusal no longer names an internal concept',
      !/observed control target/i.test(String(idle.result)), String(idle.result).slice(0, 90))

    const engineReady = /ready/.test(String(idle.sessionStatus || ''))
    if (!engineReady) {
      /* AN UNMEASURED RESULT IS REPORTED AS UNMEASURED. A machine with no agent
         engine cannot start a session, and calling that "the controls held"
         would be the false green this house standard exists to prevent. */
      check('steering', 'MEASURED: a session could be started on this machine', false,
        `the agent engine is not available here (${idle.sessionStatus}); the steering half was NOT measured`)
      return { idle, running: null, afterPause: null, afterTerminate: null }
    }

    await evaluate(`(() => {
      const form = document.querySelector('[data-session-form]');
      form.elements.text.value = 'Reply with exactly the word: PONG';
      form.requestSubmit();
    })()`)
    await until('a running session', `/running|turn/.test(document.querySelector('[data-session-status]')?.textContent || '')`, 120)
    await delay(1200)
    /* The controls sit below the fold on this page, and a screenshot of the
       top of the page is not a picture of the thing being asserted. */
    await evaluate("document.querySelector('.ctl-actions')?.scrollIntoView({ block: 'center' })")
    await delay(400)
    await shot('session-running')
    const running = await evaluate(READ_AGENT_PAGE)
    check('steering', 'a running session maps to the agent whose page started it',
      running.terminate?.disabled === false, `terminate=${JSON.stringify(running.terminate)}`)
    check('steering', 'Respawn is offered too, not permanently unavailable',
      running.respawn?.disabled === false, `respawn=${JSON.stringify(running.respawn)}`)
    check('steering', 'the controls say what they do to THIS session',
      /Steering the session this app started/.test(String(running.result)), String(running.result).slice(0, 110))

    /* Pause only claims a turn while one is running; if the turn has already
       finished, the honest state is disabled, and that is checked rather than
       demanded. */
    const pauseOffered = running.pause?.disabled === false
    let afterPause = null
    if (pauseOffered) {
      const pausePress = await press('[data-control="pause"]')
      check('steering', 'a person can actually reach and press the Pause control (real input, elementFromPoint-verified)',
        pausePress === 'clicked', pausePress)
      await delay(2000)
      afterPause = await evaluate(READ_AGENT_PAGE)
      check('steering', 'Pause acts on the session and the session survives it',
        /Stopped the turn/.test(String(afterPause.result)) && afterPause.terminate?.disabled === false,
        String(afterPause.result).slice(0, 110))
    } else {
      check('steering', 'Pause is offered only while a turn is running',
        /Nothing is running/.test(String(running.pause?.note || '')) || running.pause?.disabled === true,
        `pause=${JSON.stringify(running.pause)}`)
    }

    /* Terminate confirms once. The first press must post nothing. */
    const terminatePress1 = await press('[data-control="terminate"]')
    check('steering', 'a person can actually reach and press Terminate the first time (real input, elementFromPoint-verified)',
      terminatePress1 === 'clicked', terminatePress1)
    await delay(600)
    const confirming = await evaluate(READ_AGENT_PAGE)
    check('steering', 'Terminate asks before it ends a real process',
      /Select again/i.test(String(confirming.terminate?.note)), JSON.stringify(confirming.terminate))
    const terminatePress2 = await press('[data-control="terminate"]')
    check('steering', 'a person can actually reach and press Terminate the confirming time (real input, elementFromPoint-verified)',
      terminatePress2 === 'clicked', terminatePress2)
    await delay(2500)
    await evaluate("document.querySelector('.ctl-actions')?.scrollIntoView({ block: 'center' })")
    await delay(400)
    await shot('after-terminate')
    const afterTerminate = await evaluate(READ_AGENT_PAGE)
    check('steering', 'Terminate ends the session',
      /Ended the session/.test(String(afterTerminate.result)), String(afterTerminate.result).slice(0, 110))
    check('steering', 'and the controls hand themselves back once it is gone',
      afterTerminate.terminate?.disabled === true && /stopped|ready/i.test(String(afterTerminate.sessionStatus)),
      `status=${afterTerminate.sessionStatus} terminate=${JSON.stringify(afterTerminate.terminate)}`)
    return { idle, running, afterPause, afterTerminate }
  }, { signedInCodexHome: true })
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'recommended-path-qa-'))
  console.log(`scratch: ${scratch}`)
  try {
    const executable = await stage(scratch)
    console.log(`staged:  ${executable}`)
    const scenarios = {
      recommended: recommendedPath,
      observe: observePath,
      steering: steeringPath,
    }
    const chosen = selectedScenarios(ONLY)
    for (const name of chosen) {
      if (!scenarios[name]) throw new Error(`no scenario named ${name}`)
      const value = await scenarios[name](scratch, executable)
      writeFileSync(path.join(scratch, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    }
  } finally {
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds files briefly */ } }
    else console.log(`kept: ${scratch}`)
  }

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    for (const entry of failed) console.log(`  FAILED  [${entry.scenario}] ${entry.name}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
