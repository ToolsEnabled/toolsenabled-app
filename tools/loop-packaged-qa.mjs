#!/usr/bin/env node
/* A LOOP THAT ACTUALLY LOOPED AND ACTUALLY STOPPED, ON A PACKAGED WINDOW,
 * REACHED BY CLICKING.
 *
 * tools/test/agent-loops.test.mjs proves the loop CONTRACT against injected
 * timers. That cannot see whether a person can get to the control, and a loop
 * driven by a fake clock has not demonstrated the one property that matters
 * most: that leaving it alone produces another run, and that pressing stop ends
 * it. So this harness clicks Start on a real packaged build, WAITS OUT REAL
 * WALL-CLOCK INTERVALS, and counts what arrived at the other end.
 *
 * WHY A CONTROLLED BRIDGE RATHER THAN THE REAL ENGINE.
 *
 * Proving a loop with live agents would spawn real Codex/Claude processes on the
 * owner's machine, burn account budget, and -- this being a LOOP -- do it
 * repeatedly and leave lanes running if the harness died mid-run. That is not a
 * cost a test may impose. So the engine is replaced by a bridge stub that speaks
 * the real protocol, and everything ABOVE it is the shipped product: the real
 * supervised startup, the real pin, the real bootstrap-proof exchange, the real
 * bearer auth, the real postBridgeAction, the real controller, real setTimeout
 * intervals, and a real click on real glass.
 *
 * WHICH HALF IS SUBSTITUTED, AND WHY IT MOVED.
 *
 * This harness used to suppress the app's own capability layer -- it set
 * MC_BRIDGE_PROOF_FILE so the shell would report source 'env' and vouch for no
 * origin, which left the renderer's `?bridge=` developer override free to select
 * a bridge the harness had started. Commit 17a0483 fenced that variable out of
 * packaged builds: HKCU\Environment is writable by any same-user process with no
 * elevation, so the variable was never evidence that a developer was present,
 * and honouring it sent this boot's bootstrap proof to whatever squatted a low
 * discovery port. A packaged build can no longer report 'env', so the old gate
 * could never pass again.
 *
 * The repair is NOT to re-open that path. An opt-in that an attacker can supply
 * by writing the user's environment is the hole itself, so no environment
 * variable, and no CLI switch on the shipped binary, re-enables it here. What
 * moved instead is WHICH half is substituted: rather than subverting how the
 * product FINDS its layer, the harness substitutes the ENGINE the product
 * starts. It swaps `bridgeEntrypoint` in a scratch copy of the payload record
 * (resources/capability/PAYLOAD.json), so shell/capability-layer.cjs starts the
 * controlled stub as the app's own supervised layer. The product then takes the
 * supervised customer path exactly as a double-clicked install does.
 *
 * WHAT EACH ARM ACTUALLY PROVES, STATED SO IT CANNOT BE OVERSOLD.
 *
 * PROVEN by this run, on the shipped packaged binary: that the app starts its
 * own capability layer and reports it; that the renderer pins to that exact
 * origin and pid rather than scanning; that the shell reads the layer's own
 * bootstrap proof and the renderer exchanges it for a bearer; that a person can
 * click to the loop control; and that real elapsed wall-clock time produces a
 * second nested run and that pressing stop ends it.
 *
 * NOT PROVEN, and not claimed: anything about the real engine's behaviour below
 * the bridge protocol, and -- because the entrypoint is swapped -- that the
 * SHIPPED payload's own tools/mission-bridge.js starts and serves. A harness
 * that substituted the engine and then reported on the engine would be checking
 * air, so that is said here rather than left to be discovered.
 *
 * On the size of that second gap, measured rather than assumed:
 * tools/smoke-packaged.mjs DOES start the shipped payload from a release
 * directory copy in a sterile profile and round-trips a real tool call with a
 * signed audit row -- but it starts the payload's MCP entrypoint
 * (src/mcp-server.js), not its bridgeEntrypoint. As of this commit nothing
 * starts a release directory's tools/mission-bridge.js. So "the shipped payload
 * runs, reaches its vault and signs audit" is covered; "the shipped payload's
 * BRIDGE binds and serves /v1/* under the supervisor" is not covered by anything,
 * and this harness does not close it either. It is a known hole, written down.
 *
 * The half this deliberately does not cover -- that a spawned child is confined
 * to the installed tier -- is covered where it can be done honestly, by spawning
 * REAL child processes and reading the argv the child itself recorded:
 * toolsenabled-current/tests/loop-guided-child-confinement.test.js.
 *
 * THE THREE RULES BORROWED FROM THE HARNESSES THAT EARNED THEM.
 *
 * 1. NAVIGATE BY CLICKING. A sibling harness reached its page by assigning
 *    location.hash and passed in full on a build where nothing routed to the
 *    page. auditSelf() enforces that against this file's own source.
 * 2. ISOLATE LOCALAPPDATA *AND* USERPROFILE, not just --user-data-dir.
 * 3. CLEANUP MAY NEVER FAIL THE RUN.
 *
 * This takes a little over two minutes: it is mostly spent waiting for time to
 * pass, which is the only way to prove that time passing produces another run.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* The precondition this file used to ASSUME. See tools/lib/fleet-node.mjs. */
import { startFleetNode } from './lib/fleet-node.mjs'
import {
  environmentFor as credentialSafeEnvironment,
  machineRecordProductDirectory,
  stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE,
} from './test-account-harness.mjs'
import { appExecutable, defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* The interval the loop is driven at. One minute is the product's own floor
   (LOOP_BOUNDS.minIntervalMs), so this is the fastest a real person could run
   one -- the harness gets no special speed the customer does not have. */
const INTERVAL_MINUTES = 1
const INTERVAL_WAIT_MS = 68_000

function auditSelf() {
  return readFileSync(SELF, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => /location\.hash\s*=/.test(line))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
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

async function stage(scratch) {
  // --release selects candidate bytes. The later synthetic engine remains
  // instrumented functional QA, never untouched-artifact qualification.
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    return (await stageRelease(scratch)).executable
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
  return appExecutable(app)
}

/* SUBSTITUTE THE ENGINE, IN THE COPY, LEAVING THE REST OF THE PAYLOAD ALONE.
 *
 * Only PAYLOAD.json's bridgeEntrypoint is repointed, and only inside the scratch
 * copy. The rest of the payload stays as shipped -- which matters, because
 * seedMachineRecord() below loads the real src/lib/setup/machine-record.js out of
 * this same directory, and because readPayloadRecord() is shipped code that gets
 * to parse a real record.
 *
 * The stub's per-run secret is generated HERE and written beside it. It is not
 * an environment variable, and deliberately so: the whole reason this harness
 * needed repairing is that a variable is settable by anything running as the
 * user. This is a file inside a freshly created temp directory that exists only
 * for this run, and it configures a stub that is never shipped -- it grants no
 * capability inside the product at all.
 */
function installControlledLayer(executable, scratch) {
  const capability = path.join(path.dirname(executable), 'resources', 'capability')
  const record = path.join(capability, 'PAYLOAD.json')
  if (!existsSync(record)) {
    throw new Error(`the staged app ships no capability payload at ${capability}; a viewer with nothing behind it cannot take the supervised path`)
  }
  const stubDirectory = path.join(capability, 'qa-controlled-layer')
  mkdirSync(stubDirectory, { recursive: true })
  cpSync(path.join(REPO_ROOT, 'tools', 'test', 'loop-qa-bridge-stub.cjs'), path.join(stubDirectory, 'loop-qa-bridge-stub.cjs'))

  const qaNonce = crypto.randomBytes(32).toString('base64url')
  const announceFile = path.join(scratch, 'qa', 'controlled-layer-announce.json')
  const proofFile = path.join(scratch, 'qa', 'controlled-layer-proof.json')
  writeFileSync(
    path.join(stubDirectory, 'loop-qa-bridge-stub.config.json'),
    JSON.stringify({ qaNonce, announceFile, proofFile }),
    'utf8',
  )

  const payload = JSON.parse(readFileSync(record, 'utf8'))
  const shippedEntrypoint = payload.bridgeEntrypoint
  payload.bridgeEntrypoint = 'qa-controlled-layer/loop-qa-bridge-stub.cjs'
  writeFileSync(record, JSON.stringify(payload, null, 2), 'utf8')
  return { qaNonce, announceFile, proofFile, shippedEntrypoint }
}

/* Wait for the layer the APP started to say where it is. This file is the
   harness's own statement of the stub's identity, written by the stub before it
   prints the line the shell parses -- so it is independent of anything the shell
   or the renderer reports, which is what makes comparing them meaningful. */
async function readAnnounce(announceFile, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode} before its capability layer announced itself`)
    if (existsSync(announceFile)) {
      try { return JSON.parse(readFileSync(announceFile, 'utf8')) } catch { /* still being written */ }
    }
    await delay(250)
  }
  throw new Error(`the app's own capability layer never announced itself at ${announceFile}`)
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
  return servicesRoot
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

/* THE DECOY, WHICH IS THE ADVERSARY IN THIS TEST RATHER THAN A HELPER.
 *
 * The supervised pin's whole promise is that once the shell vouches for an
 * origin, the renderer binds THERE and the `?bridge=` developer override and the
 * 4610-4619 range scan are both unreachable. This harness does not take that on
 * faith and it does not take it from reading the source: it runs a second,
 * structurally VALID bridge, names it on `?bridge=`, and requires that nothing
 * ever arrives. If the pin regresses, this listener is where the traffic goes --
 * and because it is ours, the regression is caught in a sink we control instead
 * of on the owner's real engine.
 *
 * It also answers /v1/bootstrap for the decoy proof the harness deliberately
 * puts on MC_BRIDGE_PROOF_FILE. That pair -- an environment variable naming a
 * proof file, and a valid bridge waiting on the override -- IS the escalation
 * 17a0483 closed, reproduced here as a controlled negative. A build where the
 * fence regressed does not merely fail a label check; it completes the attack
 * against this decoy, and the decoy's arrival log says so. */
function startDecoyBridge(port, decoyProof) {
  const received = []
  const startedAt = new Date().toISOString()
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    const cors = {
      'access-control-allow-origin': request.headers.origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    }
    const reply = (status, body) => {
      const payload = JSON.stringify(body)
      response.writeHead(status, { ...cors, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      response.end(payload)
    }
    /* A preflight is the browser asking, not the product arriving, so it is not
       recorded as contact -- recording it would make this check fail for a
       reason that is not the regression it exists to catch. */
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      return response.end()
    }
    received.push({ pathname: url.pathname, at: Date.now() })
    if (url.pathname === '/v1/runtime') {
      return reply(200, { ok: true, baseUrl: `http://127.0.0.1:${port}`, port, startedAt, pid: process.pid })
    }
    if (url.pathname === '/v1/bootstrap') {
      if (url.searchParams.get('proof') !== decoyProof) return reply(403, { ok: false, error: { code: 'BRIDGE_PROOF_REFUSED', message: 'bad proof' } })
      return reply(200, { ok: true, token: 'decoy-bearer' })
    }
    return reply(200, { ok: true })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, received }))
  })
}

/* Read what ARRIVED at the app's own layer, from the layer itself.
 *
 * The stub is a child of the app, not of this process, so its record is fetched
 * over its own listener behind the per-run nonce. This is the same doctrine the
 * in-process version had -- assert on what arrived, never on what the renderer
 * believes it sent -- with the record now living one process further away. */
async function controlledLayerState(origin, nonce) {
  const response = await fetch(`${origin}/qa/state?nonce=${encodeURIComponent(nonce)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`the controlled layer refused its own QA state route (${response.status})`)
  const body = await response.json()
  const received = Array.isArray(body.received) ? body.received : []
  return {
    received,
    bootstrapAccepted: body.bootstrapAccepted === true,
    dispatches: received.filter(entry => entry.pathname === '/v1/actions/dispatch'),
    terminates: received.filter(entry => entry.pathname === '/v1/actions/terminate'),
  }
}

/* Is the listener the shell named still the process the harness started?
 *
 * Other Claude sessions work on this machine and QA harnesses cycle ports
 * continuously, so "something valid answers at that origin" is not an answer.
 * The nonce is 32 random bytes minted for this run and known only to this
 * harness and its own stub, so a neighbour that inherits the port cannot
 * produce it and this check fails closed rather than binding to a stranger. */
async function challengeControlledLayer(origin, nonce) {
  try {
    const response = await fetch(`${origin}/qa/whoami?nonce=${encodeURIComponent(nonce)}`, { cache: 'no-store' })
    if (!response.ok) return { ok: false, reason: `status ${response.status}` }
    const body = await response.json()
    return { ok: body?.nonce === nonce, pid: body?.pid, port: body?.port }
  } catch (error) {
    return { ok: false, reason: error?.message || 'unreachable' }
  }
}

async function waitFor(predicate, { timeoutMs, everyMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(everyMs)
  }
  return last
}

function createSession(port, child) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  return {
    async open() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
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
      throw new Error('no debuggable page appeared within 30s')
    },
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise(resolve => pending.set(id, resolve))
    },
    close() { try { socket?.close() } catch { /* already gone */ } },
  }
}

/* VISIBLE IS MEASURED, AND SO IS CLICKABLE.
 *
 * The inherited version of this helper checked size and computed style only. It
 * reported `visible` -- and the click reported `clicked` -- for a control that
 * was scrolled below the fold of the rail, because a synthetic mouse event at
 * viewport coordinates that land outside the window simply hits nothing. This
 * harness spent two full runs believing it had pressed Start.
 *
 * So: scroll the node into view, then refuse any point that falls outside the
 * viewport, and confirm with elementFromPoint that the pixel actually belongs to
 * the node. A click that cannot be shown to have landed is not evidence. */
const VISIBLE = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  node.scrollIntoView({ block: 'center', inline: 'nearest' })
  const box = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return { state: 'offscreen', x, y, viewport: [window.innerWidth, window.innerHeight] }
  }
  const hit = document.elementFromPoint(x, y)
  if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) {
    return { state: 'occluded', by: hit ? (hit.className || hit.tagName) : 'nothing' }
  }
  return { state: 'visible', x, y }
}`

async function main() {
  const offenders = auditSelf()
  if (offenders.length > 0) {
    for (const { line, at } of offenders) console.error(`  self-audit: line ${at} navigates by assigning the hash: ${line.trim()}`)
    console.error('A reachability suite that reaches the page by assigning the hash is not a reachability suite.')
    process.exitCode = 1
    return
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'loop-qa-'))
  const profile = path.join(scratch, 'profile')
  let child = null
  let session = null
  let decoy = null
  let layer = null

  try {
    const executable = await stage(scratch)
    const appRoot = path.dirname(executable)
    const controlled = installControlledLayer(executable, scratch)
    seedMachineRecord(profile, appRoot, 'standard')

    /* THE DECOY IS THE ATTACK, SET UP DELIBERATELY.
     *
     * A valid bridge on `?bridge=`, plus MC_BRIDGE_PROOF_FILE naming a proof
     * file it will accept, is precisely the escalation commit 17a0483 closed.
     * The harness arranges both and then requires that NOTHING arrives here. On
     * a build where the fence or the supervised pin regressed, the product
     * completes the attack against this listener and the checks below go red
     * with the arrival log as the evidence.
     *
     * It sits outside 4610-4619 for the same reason the controlled layer does:
     * this box runs a real capability layer inside that range, and a test that
     * squats there could be found by somebody else's scan. */
    const decoyProof = crypto.randomBytes(32).toString('base64url')
    const decoyProofFile = path.join(scratch, 'decoy-bridge-proof.json')
    writeFileSync(decoyProofFile, JSON.stringify({ token: decoyProof }), 'utf8')
    const decoyPort = await freePort()
    if (decoyPort >= 4610 && decoyPort <= 4619) throw new Error('the decoy must not sit inside the discovery range')
    decoy = await startDecoyBridge(decoyPort, decoyProof)
    const decoyOrigin = `http://127.0.0.1:${decoyPort}`

    /* Probe the decoy from here before the app is allowed anywhere near it. A
       decoy that is silently broken would report "nothing arrived" for the wrong
       reason, which is the most expensive kind of wrong answer a harness can
       give: a green light bought with a dead listener. */
    const decoyProbe = await fetch(`${decoyOrigin}/v1/bootstrap?proof=${decoyProof}`).then(r => r.json())
    if (decoyProbe?.ok !== true) throw new Error(`the decoy bridge did not answer its own bootstrap: ${JSON.stringify(decoyProbe)}`)
    const decoyContactsBeforeLaunch = decoy.received.length

    const port = await freePort()
    const userData = path.join(profile, 'userdata')
    const environment = credentialSafeEnvironment(profile)
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_NO_ATTACH_CONSOLE
    environment.LOCALAPPDATA = path.join(profile, 'local')
    environment.USERPROFILE = path.join(profile, 'home')
    environment.CODEX_HOME = path.join(profile, 'home', '.codex')
    /* Set ON PURPOSE, and expected to be ignored. This is no longer how the
       harness reaches its bridge -- it is the adversary's input, and the checks
       below require the packaged build to refuse it. */
    environment.MC_BRIDGE_PROOF_FILE = decoyProofFile
    mkdirSync(environment.CODEX_HOME, { recursive: true })

    child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })

    /* The app starts its own layer. Wait for THAT process to say where it is,
       from its own file, before asking the shell anything. */
    const announce = await readAnnounce(controlled.announceFile, child)
    layer = { origin: announce.baseUrl, nonce: controlled.qaNonce }

    session = createSession(port, child)
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
      await delay(400)
      return 'clicked'
    }

    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
    await delay(1200)

    /* ---------- SAFETY GATE, PART 1: IDENTITY ----------
     *
     * WHAT REPLACED `source === 'env'`, AND WHY IT IS STRONGER.
     *
     * The old gate asked the shell to describe itself and accepted the answer
     * 'env' as proof. That label only ever established a NEGATIVE -- that no
     * supervised layer was being reported -- and left the actual binding to a
     * `?bridge=` query parameter nobody checked had been honoured. It could not
     * survive the fence, and it should not have: a self-reported label is not
     * evidence of which process is on the other end of a socket.
     *
     * What is required now is that THREE independent sources agree:
     *   (a) the shell, over IPC, names a supervised origin and a pid;
     *   (b) the layer the app started names the same origin and the same pid in
     *       a file it wrote itself, before the shell ever spoke;
     *   (c) a live challenge to that origin returns a 32-byte secret minted for
     *       this run and known only to this harness and its own stub.
     *
     * (a) alone is a claim. (a)+(b) proves the shell is describing the process
     * the harness planted. (c) additionally proves that process is STILL the one
     * answering there now -- which is the part that matters on this machine,
     * where other sessions and QA harnesses cycle ports continuously. A
     * neighbour that inherits the port cannot produce the nonce, so a busy box
     * makes this gate refuse rather than make it lie. */
    const endpoint = await evaluate(`(async () => {
      const reported = await window.mcShell?.getBridgeEndpoint?.()
      return reported ?? null
    })()`)
    const challenge = await challengeControlledLayer(announce.baseUrl, controlled.qaNonce)
    const identity = {
      source: endpoint?.source ?? 'none',
      shellBaseUrl: endpoint?.baseUrl ?? null,
      shellPid: endpoint?.pid ?? null,
      announcedBaseUrl: announce.baseUrl,
      announcedPid: announce.pid,
      challengeOk: challenge.ok === true,
      challengePid: challenge.pid ?? null,
    }
    const boundToControlledLayer = endpoint?.ok === true
      && endpoint.source === 'supervised'
      && endpoint.baseUrl === announce.baseUrl
      && endpoint.pid === announce.pid
      && challenge.ok === true
      && challenge.pid === announce.pid

    check('the app runs its own supervised layer and it is the one this harness planted',
      boundToControlledLayer === true, JSON.stringify(identity))
    if (!boundToControlledLayer) {
      throw new Error(`refusing to dispatch: the app's capability layer is not provably the controlled one (${JSON.stringify(identity)}). A loop bound to a real bridge would spawn real agents repeatedly.`)
    }
    /* Recorded for cleanup only once the challenge has proved this pid is the
       harness's own stub. Before this line the harness knows a pid; after it,
       the harness knows WHOSE. */
    layer.pid = announce.pid

    /* The fence itself, regression-tested by the harness it broke. The variable
       is set on this launch; a packaged build must ignore it, keep reporting the
       supervised layer, and leave a record beside the user's data saying so. */
    check('a packaged build refuses the environment proof path rather than honouring it',
      endpoint.envProofRefused === true, `envProofRefused=${String(endpoint.envProofRefused)} source=${endpoint.source}`)
    check('the refusal is recorded where a person can find it, not only in memory',
      existsSync(path.join(userData, '.bridge-env-refusal.json')), path.join(userData, '.bridge-env-refusal.json'))

    /* Renderer settings, and the decoy named on the developer override. The
       override is honoured ONLY when the shell vouches for no supervised layer,
       so on a correct build this parameter must change nothing at all -- that is
       what the silence check below measures. This is app-level setup, not route
       navigation: page 2 is still reached by clicking, below. */
    /* LIVE, NOT SIMULATED -- and that is the product's rule, not a shortcut.
     *
     * This harness used to select the simulated rail. When it was written the
     * loop box was built for both rails; it has since been fenced to real
     * sources -- mountStartWorkControls builds the Loop panel only when the
     * board reads this computer, and under the example fleet it mounts a
     * stated absence instead, because only a rail reading this computer "is
     * entitled to build a control that reaches the bridge". A loop control
     * that reaches the bridge cannot be exercised anywhere else, so asking
     * for the example board now asks for a page that legitimately has no
     * Loop panel on it.
     *
     * That is a SECOND breakage in this harness, independent of the fence, and it
     * was hidden behind the first: the safety gate threw before the click ever
     * happened, so the stale selector never got to fail. Going live is safe here
     * for exactly the reason the gate above established -- "live" resolves to the
     * controlled layer this harness planted, and nothing else. */
    await evaluate(`(() => {
      localStorage.removeItem('mc.example')
      localStorage.setItem('mc.write.dispatch', 'enabled')
      /* The walk below starts an agent on this computer so that there is a node
         to open a rail on, and this is the switch that decides whether the
         product will let anything start at all. Turned on the way a person
         turns it on in Settings. NOTHING IS SPENT: CODEX_HOME is an empty
         scratch directory, so the start is refused with the engine's own
         signed-out sentence before any child process exists -- and the node is
         written before the engine is asked, which is why the refusal still
         leaves the circle this harness needs. */
      localStorage.setItem('mc.write.agent-session', 'enabled')
      const url = new URL(window.location.href)
      url.search = 'bridge=${decoyOrigin}'
      window.location.replace(url.toString())
      return true
    })()`)
    await delay(3000)
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')

    /* ---------- reachability, by clicking ---------- */

    const toPage2 = await clickVisible('#nav-next')
    const route = await evaluate('document.body.dataset.route')
    check('the forward control reaches page 2 by clicking', toPage2 === 'clicked' && route === 'computers', `${toPage2} route=${route}`)

    /* ---------- SAFETY GATE, PART 2: ARRIVAL ----------
     *
     * Identity proves where the shell POINTS. This proves where the renderer
     * WENT, and it is measured at the far end rather than asked of the glass.
     *
     * Reaching page 2 runs the computers view's prepareBridgeOnce(), which calls
     * the shipped bridgeReachable() -- a real configuredBaseUrl() resolution and
     * a real bootstrap exchange. So by now the controlled layer must have been
     * handed the proof that only it minted and only the shell could read, and
     * must have accepted it. Nothing has been dispatched yet, so this is still
     * before any agent could be spawned anywhere.
     *
     * If that handshake did not land here, the renderer resolved somewhere else
     * and this harness must not click Start. */
    const beforeStart = await waitFor(
      async () => {
        const state = await controlledLayerState(announce.baseUrl, controlled.qaNonce)
        return state.bootstrapAccepted ? state : null
      },
      { timeoutMs: 45_000 },
    ) || await controlledLayerState(announce.baseUrl, controlled.qaNonce)

    check('the renderer completed the real bootstrap handshake against the controlled layer',
      beforeStart.bootstrapAccepted === true,
      JSON.stringify(beforeStart.received.map(entry => entry.pathname)))
    check('nothing has been dispatched before the start control is pressed',
      beforeStart.dispatches.length === 0, `dispatches=${beforeStart.dispatches.length}`)
    const decoySilentBeforeStart = decoy.received.length === decoyContactsBeforeLaunch
    check('the supervised pin beats the ?bridge= override: the decoy bridge was never contacted',
      decoySilentBeforeStart, JSON.stringify(decoy.received.map(entry => entry.pathname)))

    if (!beforeStart.bootstrapAccepted || beforeStart.dispatches.length !== 0 || !decoySilentBeforeStart) {
      throw new Error(`refusing to dispatch: the renderer is not provably talking to the controlled layer (bootstrapAccepted=${beforeStart.bootstrapAccepted}, dispatches=${beforeStart.dispatches.length}, decoyContacts=${JSON.stringify(decoy.received.map(entry => entry.pathname))}). A loop bound to a real bridge would spawn real agents repeatedly.`)
    }

    /* THE BOARD OPENS EMPTY, AND THAT IS THE PRODUCT'S RULE, NOT A DEFECT.
       This was a single click on `.static-tree-node`, which on a sterile
       profile is absent -- "the node tree should be empty unless a user has
       started a session" -- so this check could never have passed and the loop
       panel behind it was never measured. The walk starts an agent the way a
       person does and then opens its rail. */
    const reached = await startFleetNode({ session, evaluate, delay })
    check('an agent started on this computer opens its rail board',
      reached.ok, reached.ok ? '' : `stopped at ${reached.at}: ${reached.detail}`)

    const loopBox = await evaluate(`(${VISIBLE})('.board-loop-box')`)
    /* When this is absent the bare word "absent" is not enough to act on -- it
       cannot distinguish "the panel regressed" from "the harness opened the
       wrong rail", which is exactly the confusion that cost this file a full
       debugging cycle. So report which rail is open and what boxes are on it. */
    const railState = loopBox.state === 'visible' ? null : await evaluate(`(() => {
      const rail = document.querySelector('.rail-scroll')
      return {
        liveMode: document.querySelector('#view-computers')?.dataset?.liveMode ?? rail?.dataset?.liveMode ?? 'unknown',
        railTitle: document.querySelector('.rail-title')?.textContent?.trim() ?? 'no rail',
        boxes: [...document.querySelectorAll('.board-box')].map(node => node.className),
        treeNodes: document.querySelectorAll('.static-tree-node').length,
      }
    })()`)
    check('the Loop panel is on the glass, not merely in the DOM', loopBox.state === 'visible',
      railState ? `${loopBox.state} ${JSON.stringify(railState)}` : loopBox.state)

    /* ---------- the stop is beside the start, before anything runs ---------- */

    const idle = await evaluate(`(() => {
      const box = document.querySelector('.board-loop-box')
      if (!box) return null
      const stop = box.querySelector('[data-loop="stop"]')
      const go = box.querySelector('[data-loop="go"]')
      return {
        stopPresent: Boolean(stop),
        stopDisabled: stop.disabled,
        stopTitle: stop.title,
        goDisabled: go.disabled,
        sameParent: stop.parentElement === go.parentElement,
        bounds: box.querySelector('[data-loop="bounds"]').textContent.trim(),
        honesty: box.querySelector('[data-loop="honesty"]').textContent.trim(),
        runOptions: [...box.querySelectorAll('[data-loop="runs"] option')].map(option => Number(option.value)),
      }
    })()`)

    check('the stop control is rendered beside the start, not on another screen',
      idle && idle.stopPresent && idle.sameParent === true, JSON.stringify({ present: idle?.stopPresent, sameParent: idle?.sameParent }))
    check('with no loop running the stop is disabled and says why', idle && idle.stopDisabled === true && idle.stopTitle.length > 10, idle?.stopTitle)
    check('the panel states the overrun rule where a person can read it', /skipped/i.test(idle?.bounds || ''), idle?.bounds?.slice(0, 90))
    check('the panel states that each run kills its own process tree', /process tree/i.test(idle?.bounds || ''), idle?.bounds?.slice(-90))
    check('the panel admits the loop does not survive a restart', /not durable across a restart/i.test(idle?.honesty || ''), idle?.honesty?.slice(0, 90))
    check('the run count cannot be set past the engine cap',
      Array.isArray(idle?.runOptions) && Math.max(...idle.runOptions) === 8, JSON.stringify(idle?.runOptions))

    /* ---------- start it, for real, at the product's own minimum interval ---------- */

    const configured = await evaluate(`(() => {
      const box = document.querySelector('.board-loop-box')
      const every = box.querySelector('[data-loop="every"]')
      every.value = '${INTERVAL_MINUTES}'
      every.dispatchEvent(new Event('change', { bubbles: true }))
      const runs = box.querySelector('[data-loop="runs"]')
      runs.value = '8'
      runs.dispatchEvent(new Event('change', { bubbles: true }))
      return { plan: box.querySelector('[data-loop="plan"]').textContent.trim(), goDisabled: box.querySelector('[data-loop="go"]').disabled }
    })()`)
    check('a configured loop is startable and says what it will do', configured.goDisabled === false && configured.plan.length > 20, configured.plan)

    const started = await clickVisible('[data-loop="go"]')
    check('the start control accepts a click', started === 'clicked', started)
    await delay(4000)

    const afterStart = await evaluate(`(() => {
      const box = document.querySelector('.board-loop-box')
      return {
        stopDisabled: box.querySelector('[data-loop="stop"]').disabled,
        out: box.querySelector('[data-loop="out"]').textContent.trim(),
        rows: box.querySelectorAll('.team-row').length,
      }
    })()`)
    const firstRun = await controlledLayerState(announce.baseUrl, controlled.qaNonce)
    check('the first run starts immediately, without waiting an interval', firstRun.dispatches.length === 1,
      `dispatches=${firstRun.dispatches.length} out="${afterStart.out}" layerSaw=${JSON.stringify(firstRun.received.map(entry => entry.pathname))}`)
    check('the stop becomes available the moment a loop is running', afterStart.stopDisabled === false, String(afterStart.stopDisabled))

    /* Fail fast rather than spend two more minutes waiting for intervals that
       cannot produce anything. A harness that waits anyway just reports the same
       failure three times and hides which one was first. */
    if (firstRun.dispatches.length === 0) {
      throw new Error(`no run reached the controlled layer, so there is no loop to wait for. panel said: "${afterStart.out}". the layer saw: ${JSON.stringify(firstRun.received.map(entry => entry.pathname))}`)
    }

    /* ---------- IT LOOPS. Wait out a real interval. ---------- */

    console.log(`  ..  waiting ${Math.round(INTERVAL_WAIT_MS / 1000)}s for the interval to elapse`)
    await delay(INTERVAL_WAIT_MS)

    const { dispatches } = await controlledLayerState(announce.baseUrl, controlled.qaNonce)
    check('leaving the loop alone produces a SECOND run — this is the loop', dispatches.length === 2, `dispatches=${dispatches.length}`)

    const anchorId = 'launch_stub0001'
    check('the second run is nested under the first, which is what arms the engine fan-out cap',
      dispatches[1]?.body?.parentLaunchId === anchorId, String(dispatches[1]?.body?.parentLaunchId))
    check('the first run is a root and names no parent',
      dispatches[0] && !Object.hasOwn(dispatches[0].body, 'parentLaunchId'), JSON.stringify(Object.keys(dispatches[0]?.body || {})))
    /* The positive that makes the comparison below load-bearing. Without it,
       two absent bodies compare equal and this "passes" having inspected
       nothing -- which is exactly what it did on the first run of this harness. */
    check('both runs actually carried a body to compare',
      Boolean(dispatches[0]?.body?.tier) && Boolean(dispatches[1]?.body?.tier),
      JSON.stringify([dispatches[0]?.body?.tier, dispatches[1]?.body?.tier]))
    check('nesting is the only difference between the two runs',
      Boolean(dispatches[0]?.body) && Boolean(dispatches[1]?.body)
      && JSON.stringify({ ...dispatches[1].body, parentLaunchId: undefined }) === JSON.stringify({ ...dispatches[0].body, parentLaunchId: undefined }),
      'bodies otherwise identical')

    /* ---------- IT STOPS. ---------- */

    const stopped = await clickVisible('[data-loop="stop"]')
    check('the stop control accepts a click while the loop is running', stopped === 'clicked', stopped)
    await delay(3000)

    const afterStop = await evaluate(`(() => {
      const box = document.querySelector('.board-loop-box')
      return {
        out: box.querySelector('[data-loop="out"]').textContent.trim(),
        stopDisabled: box.querySelector('[data-loop="stop"]').disabled,
      }
    })()`)
    check('the stop reports that no further run will start', /No further run will start/i.test(afterStop.out), afterStop.out.slice(0, 110))
    check('the stop is no longer offered once the loop is stopped', afterStop.stopDisabled === true, String(afterStop.stopDisabled))

    console.log(`  ..  waiting a further ${Math.round(INTERVAL_WAIT_MS / 1000)}s to prove the stop held`)
    await delay(INTERVAL_WAIT_MS)
    const afterHold = await controlledLayerState(announce.baseUrl, controlled.qaNonce)
    check('after the stop, a further elapsed interval produces NO third run — this is the stop',
      afterHold.dispatches.length === 2, `dispatches=${afterHold.dispatches.length}`)

    /* The decoy, asked one last time. Everything above could be true while a
       second binding quietly also existed; this says the whole run reached one
       bridge and it was the controlled one. */
    check('across the entire run the decoy bridge was never contacted once',
      decoy.received.length === decoyContactsBeforeLaunch,
      JSON.stringify(decoy.received.map(entry => entry.pathname)))

    const errors = await evaluate(`(() => (window.__qaErrors || []).length)()`)
    check('the renderer logged no errors reaching or driving the loop', errors === undefined || errors === 0, String(errors))
  } catch (error) {
    check('the harness ran to completion', false, error?.message || String(error))
  } finally {
    /* Cleanup may never decide the verdict. */
    try { session?.close() } catch { /* already gone */ }
    try { decoy?.server?.close() } catch { /* already gone */ }
    try {
      if (child && child.exitCode === null) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await delay(1500)
      }
    } catch { /* the OS will reap it */ }
    /* The controlled layer is a CHILD of the app, so the /T above normally takes
       it. This is the case where the app died first and left it orphaned. Only
       ever the pid this harness's OWN stub announced, and only after the nonce
       challenge confirmed that pid was the stub: never a process this harness
       did not start. */
    try {
      if (Number.isSafeInteger(layer?.pid)) {
        spawn('taskkill.exe', ['/PID', String(layer.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await delay(500)
      }
    } catch { /* the OS will reap it */ }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    catch { /* a held DLL is not a failed test */ }
  }

  const failed = results.filter(result => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length > 0) {
    for (const result of failed) console.log(`  FAILED: ${result.name} ${result.detail}`)
    process.exitCode = 1
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
