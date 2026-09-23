#!/usr/bin/env node
/* THE TEAM PANEL, ON A REAL PACKAGED WINDOW, REACHED BY CLICKING.
 *
 * Source tests cannot see reachability: dead code matches a text search exactly
 * as well as live code does. tools/test/agent-teams.test.mjs proves the team
 * CONTRACT; this proves a person can get to it and that its refusals are real
 * on the glass rather than in a unit test's imagination.
 *
 * THREE RULES BORROWED FROM THE HARNESSES THAT EARNED THEM.
 *
 * 1. NAVIGATE BY CLICKING. A sibling harness reached its page by assigning
 *    location.hash, which is the one thing a customer cannot do, and passed in
 *    full on a build where nothing routed to the page. auditSelf() below
 *    enforces that against this file's own source rather than trusting it.
 *
 * 2. ISOLATE THE PROFILE PROPERLY -- LOCALAPPDATA *AND* USERPROFILE, not just
 *    --user-data-dir. A lane spent hours concluding the permission tier was
 *    unenforced because its harness inherited this machine's `unrestricted`
 *    level and produced a confident, wrong finding.
 *
 * 3. CLEANUP MAY NEVER FAIL THE RUN. A lane's harness exited 1 after 45/45
 *    passed because Windows held a staged DLL and the cleanup threw out of a
 *    finally.
 *
 * WHAT THIS DOES NOT DO: it does not dispatch. Starting four real agent
 * processes to prove a picker works would burn account budget and leave lanes
 * running on the owner's machine. The dispatch call itself is the SAME
 * postBridgeAction('dispatch', ...) the single-lane button already uses and
 * that tools/test/agent-teams.test.mjs pins argument-for-argument.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
/* The precondition this file used to ASSUME. See tools/lib/fleet-node.mjs: the
   board opens with an empty tree by the owner's own rule, so the node has to be
   made the way a person makes one before a rail can be opened on it. */
import { createPresser, startFleetNode } from './lib/fleet-node.mjs'
import {
  environmentFor as credentialSafeEnvironment,
  resolveMachineServicesRoot,
  stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE,
} from './test-account-harness.mjs'
/* The two tables the panel is built from, imported rather than retyped. A
   harness carrying its own copy of "how many tiers there are" is a harness that
   goes red the day a tier is added and green the day one is silently dropped. */
import { LAUNCH_TIERS } from '../src/orchestration-controls.js'
import { TIER_SEAT_POOL } from '../src/agent-teams.js'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const RELEASE = defaultReleaseDirectory(REPO_ROOT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ---------- the instrument audits itself ----------
 * The only navigation this file may perform for a reachability claim is a
 * click. Assigning the hash would let it pass on a build with no door. */
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

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (!launcher) throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
  return path.join(appRoot, launcher)
}

async function stage(scratch) {
  // --release must not borrow this checkout's renderer, shell or package.json.
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

/* The machine record is written with the ENGINE's own writer, so this harness
   cannot seed a shape the product would reject. It also clears the first-run
   gate, which otherwise forces #/setup before anything renders. */
function seedMachineRecord(profile, appRoot, tier) {
  const workspace = path.join(profile, 'home', 'ToolsEnabled')
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
  mkdirSync(servicesRoot, { recursive: true })
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

async function main() {
  const offenders = auditSelf()
  if (offenders.length > 0) {
    for (const { line, at } of offenders) console.error(`  self-audit: line ${at} navigates by assigning the hash: ${line.trim()}`)
    console.error('A reachability suite that reaches the page by assigning the hash is not a reachability suite.')
    process.exitCode = 1
    return
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'team-panel-qa-'))
  const profile = path.join(scratch, 'profile')
  let child = null
  let session = null

  try {
    const executable = await stage(scratch)
    const appRoot = path.dirname(executable)
    seedMachineRecord(profile, appRoot, 'standard')

    const port = await freePort()
    /* THE ISOLATION THAT ACTUALLY MATTERS. Inheriting this machine's
       LOCALAPPDATA is how a lane measured the owner's `unrestricted` level and
       reported the tier unenforced. */
    const environment = credentialSafeEnvironment(profile)
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_NO_ATTACH_CONSOLE
    environment.LOCALAPPDATA = path.join(profile, 'local')
    environment.USERPROFILE = path.join(profile, 'home')
    environment.CODEX_HOME = path.join(profile, 'home', '.codex')
    mkdirSync(environment.CODEX_HOME, { recursive: true })

    child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(profile, 'userdata')}`], {
      env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      await delay(500)
      return 'clicked'
    }

    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
    await delay(1200)

    /* THE RAIL IS A SETTING, NOT A ROUTE, AND IT MUST BE THE LIVE ONE.
     *
     * This read `'simulated'`, and that is why every assertion below it failed:
     * `.board-team-box` was `absent`, and the three checks that read fields off
     * it failed with it, the last of them crashing this harness on
     * `Cannot read properties of undefined (reading 'disabled')`. None of that
     * was a product defect. src/views/computers.js builds Launch, Team and Loop
     * with `live: true` inside mountStartWorkControls and nowhere else, and
     * each of those builders returns null unless it is -- deliberately, and
     * the comment there says so: under the example fleet the rail mounts a
     * stated absence instead, because the example's own badge says nothing on
     * it is real, and a control that reaches the audited bridge has no
     * business on it. So a harness pointed at the example board was asserting
     * that the example copy can dispatch real agents, which it must never be
     * able to do.
     *
     * The live rail is also the one a paying customer gets. It draws from
     * window.mcOrg.read(), which answers on any machine (src/declared-fleet.js);
     * the build-time /data/fleet.json does not, and treating that absence as
     * "no computers exist" was the defect that module was written to close. */
    await evaluate(`(() => {
      localStorage.removeItem('mc.example')
      localStorage.setItem('mc.write.dispatch', 'enabled')
      /* The walk below starts an agent on this computer to get a node onto the
         board, and this is the switch that decides whether the product will let
         anything start (START_CONTROL_FLAG; setup writes it from the autonomy
         answer). It is turned on here the way a person turns it on in Settings
         -> Write -> Run an agent session, because a harness that left it off
         would be measuring the switched-off product and calling the refusal a
         defect. Nothing is spent: CODEX_HOME below is an empty scratch
         directory, so the start itself is refused with the engine's own
         signed-out sentence and no child process is ever created. */
      localStorage.setItem('mc.write.agent-session', 'enabled')
      location.reload()
      return true
    })()`)
    await delay(2500)
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')

    check('a fresh profile opens past the permission question',
      (await evaluate('document.body.dataset.route')) !== 'setup',
      `route=${await evaluate('document.body.dataset.route')}`)

    const toPage2 = await clickVisible('#nav-next')
    const route = await evaluate('document.body.dataset.route')
    check('the forward control reaches page 2 by clicking', toPage2 === 'clicked' && route === 'computers', `${toPage2} route=${route}`)

    /* Open the rail board the way a person does: start an agent on this
       computer, then click the circle it drew.
     *
     * THIS USED TO BE ONE clickVisible('.static-tree-node') AND IT COULD NEVER
     * HAVE PASSED. A sterile profile has started nothing, and an empty tree is
     * this product's stated behaviour for that ("the node tree should be empty
     * unless a user has started a session"), so the selector was absent, this
     * check failed, and the four checks reading fields off the panel failed
     * with it -- the last of them crashing the run on `Cannot read properties
     * of undefined`. Nothing about the Team panel was broken; the harness was
     * asking a page with no agents to show it one. */
    const reached = await startFleetNode({ session, evaluate, delay })
    check('an agent started on this computer opens its rail board',
      reached.ok, reached.ok ? '' : `stopped at ${reached.at}: ${reached.detail}`)
    if (!reached.ok) {
      throw new Error(`the rail never opened (${reached.at}: ${reached.detail}), so the panel below was NOT measured`)
    }

    const teamBox = await evaluate(`(${VISIBLE})('.board-team-box')`)
    check('the Team panel is on the glass, not merely in the DOM', teamBox.state === 'visible', teamBox.state)

    const inventory = await evaluate(`(() => {
      const box = document.querySelector('.board-team-box')
      if (!box) return null
      return {
        members: [...box.querySelectorAll('[data-team-member]')].map(input => input.getAttribute('data-team-member')),
        seatNotes: [...box.querySelectorAll('.team-member code')].map(code => code.textContent.trim()),
        leadOptions: [...box.querySelectorAll('[data-team="lead"] option')].map(option => option.value),
        buttonDisabled: box.querySelector('[data-team="go"]').disabled,
        plan: box.querySelector('[data-team="plan"]').textContent.trim(),
      }
    })()`)

    const tierIds = LAUNCH_TIERS.map(tier => tier.id)
    check('every dispatchable tier is offered as a team member',
      inventory && JSON.stringify(inventory.members) === JSON.stringify(tierIds),
      `panel=${JSON.stringify(inventory?.members)} table=${JSON.stringify(tierIds)}`)
    check('every dispatchable tier can also lead',
      inventory && JSON.stringify(inventory.leadOptions) === JSON.stringify(tierIds),
      JSON.stringify(inventory?.leadOptions))

    /* WHAT THIS CHECK USED TO SAY, AND WHY IT IS WRONG NOW. It read "each
       member shows the declared agent it becomes" and required exactly three
       members to print the identity `claude`. That was true when all three
       Claude tiers mapped onto ONE declared seat -- and that mapping was the
       defect: the presence registry refuses a second live lane per identity, so
       a single `claude` seat capped this product at ONE concurrent Claude agent
       whatever tier was asked for. src/agent-teams.js now gives the Claude tiers
       a pool of four seats (and `local` four of its own), and its header says so
       in as many words: "This file used to refuse that." A tier with a pool has
       no answer to "which lane do you become" until it is dispatched, so the
       panel prints the pool SIZE, which is the honest one. The rule is checked
       against the pool table rather than against a number typed here. */
    const expectedSeatNotes = tierIds.map(id => {
      const seats = TIER_SEAT_POOL[id] || []
      return `${seats.length} seat${seats.length === 1 ? '' : 's'}`
    })
    check('each member states how many seats its tier can run on',
      inventory && JSON.stringify(inventory.seatNotes) === JSON.stringify(expectedSeatNotes),
      `panel=${JSON.stringify(inventory?.seatNotes)} pools=${JSON.stringify(expectedSeatNotes)}`)
    check('with nothing selected the team cannot be dispatched, and says why',
      inventory && inventory.buttonDisabled === true && inventory.plan.length > 20,
      inventory?.plan)

    /* THE PRESSES BELOW ARE REAL. This block used to set `input.checked = true`
       and dispatch a synthetic `change`, which is a state a person cannot
       produce and which cannot tell a reachable control from a covered one. */
    const { press } = createPresser({ session, evaluate, delay })
    const sendKey = async (code, vk) => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await session.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key: code })
      }
      await delay(200)
    }
    const pickLead = async (tierId) => {
      const already = await evaluate(`document.querySelector('[data-team="lead"]')?.value || ''`)
      if (already === tierId) return 'already'
      const pressed = await press('[data-team="lead"]')
      if (pressed !== 'clicked') return pressed
      await sendKey('Escape', 27)
      for (let attempt = 0; attempt < tierIds.length + 2; attempt += 1) {
        const now = await evaluate(`document.querySelector('[data-team="lead"]')?.value || ''`)
        if (now === tierId) return 'chosen'
        await sendKey('ArrowDown', 40)
      }
      return `never-reached-${tierId}`
    }
    const toggleMember = async (tierId) => press(`[data-team-member="${tierId}"]`)
    const readTeam = async () => evaluate(`(() => {
      const box = document.querySelector('.board-team-box')
      return {
        disabled: box.querySelector('[data-team="go"]').disabled,
        plan: box.querySelector('[data-team="plan"]').textContent.trim(),
        title: box.querySelector('[data-team="go"]').title,
        checked: [...box.querySelectorAll('[data-team-member]')].filter(input => input.checked).map(input => input.getAttribute('data-team-member')),
      }
    })()`)
    const clearMembers = async () => {
      for (const id of (await readTeam()).checked) await toggleMember(id)
    }

    /* THE REFUSAL THAT IS STILL REAL: a pool drawn harder than it is deep.
       Every single-seat tier is one lane, so asking a tier to both lead and
       serve as a member is two lanes on one seat -- the 409 the picker exists
       to refuse before anything is dispatched. */
    const lead = await pickLead('sol')
    check('a lead can be chosen from the keyboard', lead === 'chosen' || lead === 'already', String(lead))
    const selfCollision = await toggleMember('sol')
    const conflict = await readTeam()
    check('drawing one seat twice is refused before anything is dispatched',
      selfCollision === 'clicked' && conflict.disabled === true,
      `${selfCollision} disabled=${conflict.disabled} plan=${conflict.plan}`)
    check('the refusal names the tier whose seat ran out', /sol/.test(conflict.plan), conflict.plan)
    check('the disabled control carries a reason longer than a shrug', conflict.title.length > 20, conflict.title)

    /* AND THE COMBINATION THAT USED TO BE REFUSED IS NOW OFFERED, which is the
       positive control for the rewrite above: without it "refused" could simply
       be this panel's answer to everything. */
    await clearMembers()
    for (const id of ['claude-sonnet', 'claude-opus']) await toggleMember(id)
    const twoClaude = await readTeam()
    check('two Claude tiers at once are allowed, because their pool holds four seats',
      twoClaude.disabled === false, `disabled=${twoClaude.disabled} plan=${twoClaude.plan}`)

    /* And a legal team of distinct identities, so the refusal above is not just
       "always off". */
    await clearMembers()
    for (const id of ['luna', 'terra']) await toggleMember(id)
    const legal = await readTeam()
    check('a team of distinct identities is dispatchable', legal.disabled === false, legal.plan)
    check('the ready message states how many lanes will start', /3 lanes total/.test(legal.plan), legal.plan)

    const errors = await evaluate(`(() => (window.__qaErrors || []).length)()`)
    check('the renderer logged no errors reaching or driving the panel', errors === undefined || errors === 0, String(errors))
  } finally {
    /* Cleanup may never decide the verdict. */
    try { session?.close() } catch { /* already gone */ }
    try {
      if (child && child.exitCode === null) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await delay(1200)
      }
    } catch { /* nothing to reap */ }
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
