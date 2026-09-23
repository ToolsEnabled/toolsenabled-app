#!/usr/bin/env node

// THE EXAMPLE AGENT PAGE MUST NOT CARRY A CONTROL THAT REACHES A REAL SESSION.
//
// WHAT WENT WRONG, measured on the packaged build before this suite existed.
// At #/agent/c1/terra-01 with the agent view in simulated mode, the page
// rendered its own banner:
//
//   "Example data. These are not your agents - nothing here is running, and no
//    control on this page reaches a real session."
//
// and in the same viewport rendered an ENABLED Start button over the note
// "This computer is set to Unrestricted. Nothing narrows it: it can read,
// change and delete any file on this computer and run any program, without
// asking." Pressing it took mcAgent.history().total from 0 to 1 and the status
// row from "agent engine ready" to "running - session open": a real spawn,
// recorded on the device, launched from a page that told the person nothing on
// it was real. The reporting lane went further on a real profile and had the
// session write a file to disk, then read that file back independently.
//
// The cause was one dropped argument. src/views/agent.js computes `live`, uses
// it to choose between the two banners, and then called both write-surface
// mounts with only `{ agentId }` -- so the surfaces that start a CLI child
// process and dispatch an audited lane had no idea which page they were on.
// Absence read as consent, the same shape this project has now found eight
// times in different layers.
//
// WHY THIS IS A PACKAGED-WINDOW SUITE AND NOT A `node --test` FILE. Source text
// cannot see reachability -- the house rule, and it is not theoretical here.
// The old suite's only statement about this surface was
// `assert.match(view, /mountAgentSessionSurface\(root/)`, a regex over
// src/views/agent.js. That assertion was true for the entire life of the defect
// and is still true now, on both sides of the fix. It could not have caught
// this and cannot catch its return. Only rendering the page and looking for the
// control can.
//
// IT ASSERTS BOTH DIRECTIONS, and the second half is the one that matters most
// for whoever comes next:
//
//   EXAMPLE mode - the banner is the example banner, and the session surface,
//   the Start control and the audited-dispatch surface are all ABSENT.
//
//   LIVE mode - the same page, backed by a real projection, still mounts the
//   session surface with an ENABLED Start.
//
// Without the live half, this suite could be satisfied by deleting the feature,
// which is the cheapest wrong way to make a safety test green and would drop a
// shipped capability the owner has said must not be dropped. With it, the only
// way to pass is the actual invariant: real controls on the real page, no real
// controls on the demonstration page.
//
// ISOLATION, each mechanism for a reason learned the hard way by
// tools/agent-subpage-qa.mjs and tools/setup-walkthrough-qa.mjs:
//   --user-data-dir  the supported userData override, and it changes the
//                    single-instance lock key so this runs beside a copy
//                    someone else is using.
//   LOCALAPPDATA     resolveServicesRoot() is our own code reading the
//                    environment; without this the harness reads the OWNER'S
//                    recorded permission level.
//   USERPROFILE      so the confinement probe reads scratch, not a real profile.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node and
// exits 0, which is indistinguishable from a crash.
//
// IT KILLS ONLY THE PROCESS IT STARTED and writes nothing under release/.
//
// RUN IT:
//   node tools/example-page-write-fence-qa.mjs
//   node tools/example-page-write-fence-qa.mjs --shipped-shell   (renderer only)

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* The live board opens with an EMPTY tree by the product's own rule, so the
   node this fence is measured on has to be made first. See tools/lib/fleet-node.mjs. */
import { createPresser, startFleetNode } from './lib/fleet-node.mjs'
import {
  environmentFor as credentialSafeEnvironment,
  machineRecordProductDirectory,
  userDataFor,
} from './test-account-harness.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
/* The renderer is what this fence lives in, so a run may deliberately pin the
   shipped shell and vary only dist/. The default stages both, because the
   product is both. */
const SHIPPED_SHELL = process.argv.includes('--shipped-shell')
/* Unrestricted is the level the original capture was taken at and the level at
   which a mistaken Start does the most damage, so it is the default. The fence
   does not depend on the tier -- a real session at any level is still a real
   session on a page that says there are none. */
const TIER = argument('--tier', 'unrestricted')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 0) throw new Error(`no .exe in the staged app at ${appRoot}`)
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

/* Borrow the built binary and swap in the CURRENT renderer, rather than running
   electron-builder -- which has damaged node_modules through this worktree's
   junction for three separate lanes in one day. Nothing under release/ is
   written. */
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
  for (const directory of SHIPPED_SHELL ? ['dist'] : ['dist', 'shell']) {
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
          /* NAME THE REAL CAUSE. A shell that throws at module scope exits
             before any window paints, and "the fence could not be measured" must
             never read as "the fence held". */
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered -- this is a STARTUP failure, not a fence result.\n${startupLog.join('')}`)
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
  const productDirectory = machineRecordProductDirectory(profile)
  const servicesRoot = path.join(profile, 'local', productDirectory)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(REPO_ROOT, 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  }), { servicesRoot })
}

/* A REAL LIVE PROJECTION, delivered the way the product actually delivers one.
   The shell intercepts /data/<domain>.json and serves it from the directory the
   fleet profile configures, so a file dropped into dist/data is ignored -- an
   earlier version of this harness did exactly that and measured "projection
   unavailable" while believing it was measuring live mode. */
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
    sources: [{ id: 'fence-qa', kind: 'directory', path: 'scratch', ok: true, observedAt, reason: null }],
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

  const userData = userDataFor(profile)
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(userData, 'fleet-profile.json'), `${JSON.stringify({
    storageVersion: 1,
    state: 'configured',
    profile: {
      schemaVersion: 1,
      id: 'fenceqa',
      label: 'Fence QA fleet',
      machines: [{ id: 'a', name: 'Machine A', ip: '127.0.0.1' }],
      transports: [{ id: 'bridge', label: 'Bridge', endpoint: '127.0.0.1:8788' }],
      dataSource: { kind: 'directory', path: projectionDirectory },
    },
  })}\n`, 'utf8')
}

/* WHAT IS ACTUALLY ON THE GLASS. `shown` is measured, never assumed: a
   stylesheet that hides a control leaves every node exactly where a querySelector
   finds it. For this fence the presence of a live control is the failure, so
   both presence and visibility are reported and the assertions use presence --
   a Start that is merely visually hidden is still a Start the keyboard reaches. */
const READ_PAGE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = node => (node ? node.textContent.replace(/[\\s]+/g, ' ').trim() : null)
  const start = document.querySelector('[data-session-start]')
  return {
    present: Boolean(document.querySelector('.agentv')),
    liveMode: document.querySelector('.agentv') ? document.querySelector('.agentv').dataset.liveMode : null,
    banner: text(document.querySelector('.agent-provenance')),
    /* WHICH BANNER, asked of the mark the product sets rather than of the
       sentence it prints. src/views/agent.js writes data-kind="declared" on the
       live branch and data-kind="example" on the other, and those two words are
       the whole fact this suite needs. See the check below for what pinning the
       prose instead cost. */
    bannerKind: (document.querySelector('.agent-provenance') || {}).dataset?.kind || null,
    sessionSurface: Boolean(document.querySelector('.agent-session-surface')),
    startPresent: Boolean(start),
    startShown: shown(start),
    startDisabled: start ? start.disabled : null,
    sessionStatus: text(document.querySelector('[data-session-status]')),
    dispatchSurface: Boolean(document.querySelector('.agent-write-surface')),
    bridgeIsReal: typeof globalThis.mcAgent === 'object' && globalThis.mcAgent !== null && typeof globalThis.mcAgent.start === 'function',
  }
})()`

/* THE SECOND EXAMPLE SURFACE, and the one this harness did not cover.
 *
 * dd01899 fenced the example AGENT page and its own commit message said the
 * simulated COMPUTERS board still built the same real dispatch, team and loop
 * boxes, gated on nothing but the dispatch write flag. So the example copy of
 * page 2 could start a real agent while the app-wide notice on screen said the
 * page was showing example data. Same defect, same fence, and now the same
 * harness -- a fence measured on one of two surfaces is a fence with a hole in
 * it, and the hole is exactly where nobody is looking.
 *
 * PRESENCE, NOT VISIBILITY, for the same reason as above: a control hidden by a
 * stylesheet is still a control the keyboard reaches. */
const READ_BOARD = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = node => (node ? node.textContent.replace(/[\\s]+/g, ' ').trim() : null)
  const board = document.querySelector('.computers')
  return {
    present: Boolean(board),
    liveMode: board ? board.dataset.liveMode : null,
    /* 'available' on both sources now: the example is a projection like any
       other (mountMockFleet feeds the same adapter), and the old sim's
       'simulated' value went with the second render. */
    projectionState: board ? board.dataset.projectionState : null,
    /* The bar's own marking, the product's one phrasing for example data.
       null when the badge node is absent, which is the live board's truth. */
    exampleBadge: text(document.querySelector('.computers [data-example-badge]')),
    railOpen: Boolean(document.querySelector('.computers .board-ctl-box')),
    launchControls: document.querySelectorAll('.computers [data-launch]').length,
    dispatchButton: Boolean(document.querySelector('.computers [data-launch="dispatch"]')),
    teamControls: document.querySelectorAll('.computers [data-team]').length,
    loopControls: document.querySelectorAll('.computers [data-loop]').length,
    absentBox: Boolean(document.querySelector('.computers .board-ctl-absent')),
    absentText: text(document.querySelector('.computers .board-ctl-absent')),
    /* The app-wide "some screens show example data" notice. The example board
       already wears its own badge, and board.css keys on data-live-mode
       'simulated' to hold this toast off it -- two notices disagreeing about
       what is real is worse than either; on a live board it is true and must
       stay. */
    exampleToastShown: shown(document.querySelector('.fleet-profile-notice:not(.is-serious)')),
    bridgeIsReal: typeof globalThis.mcAgent === 'object' && globalThis.mcAgent !== null,
  }
})()`

async function drive(executable, scratch, { live }) {
  const port = await freePort()
  const label = live ? 'live' : 'example'
  const profile = path.join(scratch, `profile-${label}`)
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  seedMachineRecord(profile, path.join(scratch, 'app'), TIER)
  if (live) seedLiveProjection(profile)

  const environment = credentialSafeEnvironment(profile)
  delete environment.ELECTRON_RUN_AS_NODE
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  mkdirSync(environment.CODEX_HOME, { recursive: true })

  const startupLog = []
  const child = spawn(executable, [
    `--user-data-dir=${userDataFor(profile)}`,
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
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const until = async (name, expression, attempts = 60) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return true
        await delay(250)
      }
      return false
    }

    await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
    /* Every write flag this page can honour is turned ON. The fence must hold
       because of the page's provenance, not because a capability happened to be
       switched off -- a run that left them off would pass without measuring
       anything. The source axis is ONE switch now (src/data-source.js):
       mc.example present-as-'on' pins every screen to the example fleet, and
       absent is the shipped default, this computer's own data. */
    await evaluate(`(() => {
      localStorage.${live ? "removeItem('mc.example')" : "setItem('mc.example', 'on')"};
      localStorage.setItem('mc.write.agent-session', 'enabled');
      localStorage.setItem('mc.write.dispatch', 'enabled');
      localStorage.setItem('mc.write.report-read', 'enabled');
      localStorage.setItem('mc.theme', 'tan');
      location.hash = '#/agent/c1/terra-01';
    })()`)
    await evaluate('location.reload()')
    const reached = await until('the agent view', `Boolean(document.querySelector('.agentv'))`)
    if (!reached) {
      const reason = await evaluate(`(() => { const n = document.querySelector('.projection-state'); return n ? n.textContent.trim() : '(no projection-state node)' })()`)
      throw new Error(`the ${label} agent page never rendered, so the fence was NOT measured: ${reason}`)
    }
    /* The surfaces mount synchronously but fill in asynchronously (availability
       and confinement are two separate awaits). Settling avoids reading a Start
       that is still in its pre-availability disabled state and calling that a
       fence. */
    await delay(2500)
    const page = await evaluate(READ_PAGE)

    /* ---------- and now the same question of the computers board ----------
       Same window, same write flags, only the surface changes. No second
       source write: the one mc.example switch set before the agent page IS
       the whole axis, and it governs this board too. The controls rail is
       opened by pressing a node, which is how the page opens it for a
       person; there is no deep link to a rail. */
    await evaluate(`(() => {
      location.hash = '#/computers';
    })()`)
    await evaluate('location.reload()')
    const onBoard = await until('the computers board', `Boolean(document.querySelector('.computers'))`)
    let board = { present: false, reachedRail: false }
    if (onBoard) {
      await delay(2000)
      /* HOW THE RAIL IS OPENED, AND WHY THE TWO BOARDS DIFFER.
       *
       * This dispatched a synthetic dblclick at whatever `.static-tree-node`
       * it found. On the EXAMPLE board that node is one of the demonstration
       * fleet's own circles and it is there on arrival. On the LIVE board there
       * is no node at all until this person has started something -- "the node
       * tree should be empty unless a user has started a session" -- so the
       * live half of this fence reported `no-node` and then measured an
       * unopened rail, which is how "launch controls EXIST on the live board"
       * came to fail on a build whose controls were fine. The live walk now
       * starts an agent the way a person does (nothing is spent: CODEX_HOME is
       * an empty scratch directory, so the engine refuses and the node is
       * written before the engine is asked). Both halves press for real. */
      let opened = 'no-node'
      if (live) {
        const reached = await startFleetNode({ session, evaluate, delay })
        opened = reached.ok ? 'opened' : `${reached.at}: ${reached.detail}`
      } else {
        const { press } = createPresser({ session, evaluate, delay })
        opened = (await press('.computers .static-tree-node')) === 'clicked' ? 'opened' : 'not-pressable'
      }
      await until('the controls rail', `Boolean(document.querySelector('.computers .board-ctl-box'))`, 40)
      await delay(1500)
      board = { ...(await evaluate(READ_BOARD)), reachedRail: opened === 'opened', railDetail: opened }
    }
    return { page, board }
  } finally {
    session.close()
    try { child.kill() } catch { /* already gone */ }
    await delay(1000)
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'example-page-fence-'))
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

try {
  const executable = await stage(scratch)
  console.log(`staged ${SHIPPED_SHELL ? 'current dist/ over the shipped shell' : 'current dist/ + shell/'}, tier ${TIER}\n`)

  console.log('EXAMPLE mode -- the page that says nothing on it is real')
  const { page: example, board: exampleBoard } = await drive(executable, scratch, { live: false })
  check('the page is in simulated mode', example.liveMode === 'simulated', `liveMode=${example.liveMode}`)
  /* The example half keeps its sentence AS WELL as its kind, and deliberately:
     this exact wording is the promise the fence below is measured against, so a
     rewrite of it should stop this suite and be re-read, not pass quietly. */
  check('the example banner is the one on screen',
    example.bannerKind === 'example'
      && typeof example.banner === 'string'
      && example.banner.includes('no control on this page reaches a real session'),
    `kind=${JSON.stringify(example.bannerKind)} ${JSON.stringify(example.banner)}`)
  check('the desktop agent bridge is reachable from this page',
    example.bridgeIsReal === true,
    'if this is false the fence below proves nothing, because nothing could have started a session anyway')
  check('NO agent-session surface is mounted', example.sessionSurface === false)
  check('NO Start control exists', example.startPresent === false,
    example.startPresent ? `Start is present (disabled=${example.startDisabled}, shown=${example.startShown}, status=${JSON.stringify(example.sessionStatus)})` : '')
  check('NO audited-dispatch surface is mounted', example.dispatchSurface === false)

  console.log('\nEXAMPLE mode -- the computers board, same window, same flags')
  check('the example board carries the delivered vocabulary: liveMode simulated, projection available',
    exampleBoard.liveMode === 'simulated' && exampleBoard.projectionState === 'available',
    `liveMode=${exampleBoard.liveMode} projectionState=${exampleBoard.projectionState}`)
  check('the board wears the example badge, in the product’s one phrasing',
    exampleBoard.exampleBadge === 'Example, not your data', JSON.stringify(exampleBoard.exampleBadge))
  check('the controls rail opens on the simulated board',
    exampleBoard.reachedRail === true && exampleBoard.railOpen === true,
    `reachedRail=${exampleBoard.reachedRail} railOpen=${exampleBoard.railOpen} -- if this is false the fence below proves nothing`)
  check('NO launch controls exist on the simulated board',
    exampleBoard.launchControls === 0, `${exampleBoard.launchControls} [data-launch] control(s)`)
  check('NO dispatch button exists on the simulated board',
    exampleBoard.dispatchButton === false,
    'this is the one that reached a real bridge from the example copy of page 2')
  check('NO team controls exist on the simulated board',
    exampleBoard.teamControls === 0, `${exampleBoard.teamControls} [data-team] control(s)`)
  check('NO loop controls exist on the simulated board',
    exampleBoard.loopControls === 0, `${exampleBoard.loopControls} [data-loop] control(s)`)
  /* Absent is not enough on its own: a gap where Dispatch used to be reads as a
     broken page. The absence has to say it is deliberate and where the real one
     is. */
  check('and their absence is STATED rather than silent',
    exampleBoard.absentBox === true && /nothing here starts anything/i.test(exampleBoard.absentText || ''),
    JSON.stringify(exampleBoard.absentText))
  check('the app-wide example-data notice is not also shouting on this board',
    exampleBoard.exampleToastShown === false,
    'the in-flow statement replaces it here; on a live board it stays')

  console.log('\nLIVE mode -- the same page backed by a real projection')
  const { page: liveView, board: liveBoard } = await drive(executable, scratch, { live: true })
  check('the page is in live mode', liveView.liveMode === 'live', `liveMode=${liveView.liveMode}`)
  /* THE LIVE PAGE CARRIES THE LIVE BANNER, ASKED BY KIND AND NOT BY SENTENCE.
   *
   * This required the exact words "Declared topology read from this computer".
   * Commit cf0aaf2 -- the pass that made every rendered word beginner-readable
   * -- rewrote that line to "Read from the team record saved on this computer."
   * six hours after this file was written, and this check has been red ever
   * since on a page that is behaving exactly as it should. A fence suite that
   * goes red when the product's English improves teaches the next reader to
   * ignore it, and an ignored fence is how the control it guards comes back.
   *
   * The fact being fenced is WHICH BANNER, and the product already states that
   * in a form no copy pass will touch: data-kind, "declared" or "example". The
   * sentence is still printed as the evidence, and the negative half below is
   * what actually holds the line -- the live page must not be wearing the
   * example banner, which is the confusion this suite exists to catch. */
  check('the live banner is the one on screen',
    liveView.bannerKind === 'declared'
      && typeof liveView.banner === 'string'
      && !/no control on this page reaches a real session/i.test(liveView.banner),
    `kind=${JSON.stringify(liveView.bannerKind)} ${JSON.stringify(liveView.banner)}`)
  check('the agent-session surface IS mounted', liveView.sessionSurface === true)
  check('the Start control EXISTS', liveView.startPresent === true)
  check('the Start control is ENABLED', liveView.startDisabled === false,
    `disabled=${liveView.startDisabled}, status=${JSON.stringify(liveView.sessionStatus)}`)

  /* THE NON-VACUITY HALF. Every check above is satisfied by a board that builds
     no controls at all, which is exactly what a fence applied to both branches
     by mistake would produce -- a "fix" that passes the fence suite and removes
     the feature. So the live board must still HAVE the controls the example one
     is refused. */
  console.log('\nLIVE mode -- the computers board still has the controls the example is refused')
  check('the live board is in live mode', liveBoard.liveMode === 'live', `liveMode=${liveBoard.liveMode}`)
  check('and no example badge is on it -- real data is never badged',
    liveBoard.exampleBadge === null, JSON.stringify(liveBoard.exampleBadge))
  check('the controls rail opens on the live board',
    liveBoard.reachedRail === true && liveBoard.railOpen === true,
    `reachedRail=${liveBoard.reachedRail} railOpen=${liveBoard.railOpen}`)
  check('launch controls EXIST on the live board',
    liveBoard.launchControls > 0, `${liveBoard.launchControls} [data-launch] control(s)`)
  check('the dispatch button EXISTS on the live board', liveBoard.dispatchButton === true)
  check('and the stated-absence box is NOT on the live board',
    liveBoard.absentBox === false,
    'it would be telling a person the real controls are elsewhere while standing next to them')
} finally {
  if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* held by a dying child */ } }
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.error(`FAILED: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
