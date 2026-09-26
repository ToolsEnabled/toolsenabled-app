#!/usr/bin/env node

// THE TRUSTING READER'S PATH, FROM A GENUINELY FRESH MACHINE, COUNTED IN CLICKS.
//
// WHAT THIS MEASURES THAT THE EXISTING SUITES DO NOT.
//
// tools/recommended-path-packaged-qa.mjs measures the same journey but SEEDS the
// permission level, and says so at its own scenario 1: "the first-run tier step
// is not currently completable in a sterile profile in this tree". So the one
// screen a real customer meets FIRST is the one screen no packaged run walks.
// tools/setup-walkthrough-qa.mjs does click it, and on this tree it reaches the
// review and then TIMES OUT at Finish -- which its 15s budget reports as
// "timed out waiting for the app" and nothing else.
//
// A timeout is not a diagnosis. Either Finish never returns, which is a dead end
// that leaves the customer on a "Saving..." button forever, or it returns slowly,
// which is a different defect with a different fix. This run tells those two
// apart by POLLING while it waits and printing what the screen says each second,
// and by holding a budget long enough that "slow" cannot masquerade as "hung".
//
// IT TOUCHES NOTHING BUT THE FORWARD BUTTON. Every click below is Continue or
// Finish. Not one answer is selected, so what it measures is exactly what the
// product recommends to somebody who takes its advice. The click count it prints
// is therefore the real cost of the recommended path, and the Start control it
// looks for at the end is the thing the whole walkthrough exists to deliver.
//
// ISOLATION, for the reasons the two suites above set out in full:
//   --user-data-dir  the supported userData override; also moves the instance
//                    lock, so this runs beside a copy someone else is using.
//   LOCALAPPDATA     resolveServicesRoot() reads the environment, so machine.json
//                    lands in scratch and the real record is never touched.
//   USERPROFILE      defaultWorkspacePath(), so the folder Finish creates is in
//                    scratch rather than in someone's own profile.
// ELECTRON_RUN_AS_NODE is stripped: set, the binary runs headless as Node and
// exits 0, which is indistinguishable from a crash.
//
// It kills only the process it started and writes nothing under release/.
//
// RUN IT:
//   node tools/setup-deadend-recommended-qa.mjs
//   node tools/setup-deadend-recommended-qa.mjs --keep --shots <dir>

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { defaultReleaseDirectory } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

function argument(name, fallback = null) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const RELEASE = path.resolve(argument('--release', defaultReleaseDirectory(REPO_ROOT)))
const KEEP = process.argv.includes('--keep')
const SHOTS = argument('--shots') ? path.resolve(argument('--shots')) : null
/* Long enough that "slow" cannot be reported as "hung". The existing harness
   budgets 15s and that is the whole reason this defect has no diagnosis. */
const FINISH_BUDGET_MS = Number(argument('--finish-budget', '180000'))
/* A REAL FRESH INSTALL HAS NO FLEET PROFILE, and seeding one hides whatever the
   product does to a person who has not configured a data source yet. With this
   switch the run seeds ONLY the declared agents and leaves the fleet profile
   absent, which is the state a customer is genuinely in. */
const NO_FLEET = process.argv.includes('--no-fleet')
/* ISOLATING THE ONE VARIABLE that separates this run from
   tools/setup-walkthrough-qa.mjs, which reaches the review and then times out at
   Finish on this same tree. That harness PRESSES an autonomy answer before
   continuing; this one presses nothing but Continue. If pressing the answer is
   what breaks Finish, then a customer who actively chooses -- rather than
   accepting the preselection -- cannot complete setup at all, which is a worse
   dead end than the one this lane was sent to fix. */
const CLICK_AUTONOMY = argument('--click-autonomy')
/* THE CONDITIONS tools/setup-walkthrough-qa.mjs RUNS UNDER, exactly: nothing
   seeded at all, not even the agent sign-in directory. Kept as a switch so the
   two suites' disagreement about Finish can be reduced to one variable at a
   time instead of argued about. */
const BARE = process.argv.includes('--bare')
/* PRESS FINISH THE INSTANT THE REVIEW'S TEXT APPEARS, with no read of the screen
   in between -- which is what tools/setup-walkthrough-qa.mjs does. The review
   paints again when its own asynchronous reads land, and a button captured
   before that repaint is DETACHED: `.click()` on it bubbles to nothing, because
   this view delegates from the section element. If that is the whole story, the
   other suite's "timed out waiting for the app" is its own race and not a defect
   a customer can meet, and this switch is what proves it either way. */
const RACY = process.argv.includes('--racy')
/* PRESS CONTINUE ON THE PERMISSION QUESTION THE INSTANT THE ROUTE IS #/setup,
   which is what tools/setup-walkthrough-qa.mjs does, instead of first waiting
   for the stage to mount and reading the preselection. This is the last
   difference between the two suites, and if it is what decides whether Finish
   lands or loops, then the loop is a real race a customer can lose. */
const FAST_TIER = process.argv.includes('--fast-tier')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function appExecutable(appRoot) {
  const executables = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
  if (executables.length === 1) return path.join(appRoot, executables[0])
  const launcher = executables.find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
  if (launcher) return path.join(appRoot, launcher)
  throw new Error(`cannot tell which of these is the launcher: ${executables.join(', ')}`)
}

/* Borrow the built binary and swap in the CURRENT renderer and shell rather than
   running electron-builder, which has damaged node_modules through this
   worktree's junction. Nothing under release/ is written. */
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

/* A PORT NOBODY ELSE HOLDS, ASKED FOR RATHER THAN GUESSED. */
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

/* A DECLARED AGENT HAS TO EXIST for there to be an agent page to look at. This
   seeds the projection the shell serves, exactly as the shipped product
   delivers one. It says NOTHING about which controls appear on that page, which
   is the only thing this run measures. The permission level and every answer are
   left entirely unset -- that is the point of the run. */
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
    sources: [{ id: 'setup-deadend-qa', kind: 'directory', path: 'scratch', ok: true, observedAt, reason: null }],
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
  if (NO_FLEET) return
  writeFileSync(path.join(userData, 'fleet-profile.json'), `${JSON.stringify({
    storageVersion: 1,
    state: 'configured',
    profile: {
      schemaVersion: 1,
      id: 'deadendqa',
      label: 'Setup dead-end QA fleet',
      machines: [{ id: 'a', name: 'Machine A', ip: '127.0.0.1' }],
      transports: [{ id: 'bridge', label: 'Bridge', endpoint: '127.0.0.1:8788' }],
      dataSource: { kind: 'directory', path: projectionDirectory },
    },
  })}\n`, 'utf8')
}

/* WHAT IS ACTUALLY ON THE GLASS. `shown` is measured rather than assumed: a
   stylesheet that hides a control leaves every node where a querySelector finds
   it, and a control that cannot be seen is still a dead end for the person
   looking at the screen. */
const READ_AGENT_PAGE = `(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : null)
  const start = document.querySelector('[data-session-start]')
  return {
    agentPage: Boolean(document.querySelector('.agentv')),
    offSurface: Boolean(document.querySelector('[data-session-off]')),
    offReason: text(document.querySelector('[data-session-off] [data-action-output]')),
    startPresent: Boolean(start),
    startShown: shown(start),
    startDisabled: start ? start.disabled : null,
    startLabel: text(start),
    sessionStatus: text(document.querySelector('[data-session-status]')),
    writeFlag: localStorage.getItem('mc.write.agent-session'),
    autonomy: (() => { try { return JSON.parse(localStorage.getItem('mc.setup.profile') || 'null')?.answers?.autonomy ?? null } catch { return null } })(),
    tier: (() => { try { return JSON.parse(localStorage.getItem('mc.setup.profile') || 'null')?.status ?? null } catch { return null } })(),
  }
})()`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'setup-deadend-qa-'))
  console.log(`scratch: ${scratch}`)
  let clicks = 0
  try {
    const executable = await stage(scratch)
    console.log(`staged:  ${executable}`)

    const port = await freePort()
    const profile = path.join(scratch, 'profile-fresh')
    for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
    if (!BARE) seedLiveProjection(profile)

    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    environment.LOCALAPPDATA = path.join(profile, 'local')
    environment.USERPROFILE = path.join(profile, 'home')
    if (!BARE) {
      environment.CODEX_HOME = path.join(profile, 'home', '.codex')
      mkdirSync(environment.CODEX_HOME, { recursive: true })
    }

    const startupLog = []
    const child = spawn(executable, [
      `--user-data-dir=${path.join(profile, 'userdata')}`,
      `--remote-debugging-port=${port}`,
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', chunk => startupLog.push(String(chunk)))
    child.stderr.on('data', chunk => startupLog.push(String(chunk)))

    const session = createSession(port, child, startupLog)
    try {
      await session.open()
      await session.send('Runtime.enable')
      if (SHOTS) await session.send('Page.enable')

      const evaluate = async expression => {
        const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (packet.result?.exceptionDetails) {
          throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
        }
        return packet.result?.result?.value
      }
      const until = async (what, expression, attempts = 80) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (await evaluate(expression)) return true
          await delay(250)
        }
        throw new Error(`timed out waiting for ${what}`)
      }
      const screen = () => evaluate('document.querySelector("[data-setup-section]")?.innerText || ""')
      const shot = async name => {
        if (!SHOTS) return
        const packet = await session.send('Page.captureScreenshot', { format: 'png' })
        if (!packet.result?.data) return
        mkdirSync(SHOTS, { recursive: true })
        const file = path.join(SHOTS, `${name}.png`)
        writeFileSync(file, Buffer.from(packet.result.data, 'base64'))
        console.log(`  shot  ${file}`)
      }
      /* EVERY forward press goes through here, so the count cannot drift from
         what was actually pressed. */
      const click = async (selector, what) => {
        const pressed = await evaluate(
          `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if (!nodes.length) return false; nodes[nodes.length - 1].click(); return true })()`,
        )
        if (!pressed) throw new Error(`nothing to click for ${what} (${selector})`)
        clicks += 1
        console.log(`  click ${clicks}: ${what}`)
        return pressed
      }

      console.log('\n[fresh machine] no permission level recorded, no answers chosen')
      if (FAST_TIER) {
        await until('the first-run question', 'location.hash === "#/setup"')
        check('a fresh machine opens on the permission question', true)
      } else {
        await until('the application origin', `location.protocol === 'http:' && Boolean(document.querySelector('#stage'))`)
        await until('the first-run question', 'location.hash === "#/setup"')
        check('a fresh machine opens on the permission question', true)

        const tierPreselected = await evaluate('document.querySelector(\'[data-setup-tier][aria-pressed="true"]\')?.dataset.setupTier ?? null')
        const tierScreen = await screen()
        check('the permission question preselects an answer', Boolean(tierPreselected), String(tierPreselected))
        check('the preselected level is the one marked Recommended', /Recommended/.test(tierScreen), `preselected=${tierPreselected}`)
        await shot('1-tier')
      }

      await click('[data-setup-continue]', 'Continue on the permission question')
      await until('the folder question', 'document.querySelector("[data-setup-section]")?.innerText.includes("Which folder")')
      await until('the folder to resolve', 'document.querySelector(".setup-root-path") !== null')
      await shot('2-folder')
      await click('[data-setup-next]', 'Continue on the folder question')

      await until('the account step', 'document.querySelector("[data-setup-section]").innerText.includes("Who is using this copy") || document.querySelector("[data-setup-section]").innerText.includes("Signed in as")')
      await shot('3-account')
      await click('[data-setup-next]', 'Continue past the account step')

      await until('the autonomy question', 'document.querySelector("[data-setup-section]").innerText.includes("without asking")')
      const autonomy = await evaluate('document.querySelector(\'[data-setup-set="autonomy"][aria-pressed="true"]\')?.dataset.setupValue ?? null')
      const autonomyScreen = await screen()
      check('the autonomy question preselects an answer', Boolean(autonomy), String(autonomy))
      check('the preselected answer is the one marked Recommended', /Recommended/.test(autonomyScreen), `preselected=${autonomy}`)
      check('the recommended answer does not warn that nothing will start an agent',
        !autonomyScreen.includes('nothing here will start an agent'),
        'a recommended answer that has to warn about itself is the defect')
      await shot('4-autonomy')
      if (CLICK_AUTONOMY) {
        await click(`[data-setup-set="autonomy"][data-setup-value="${CLICK_AUTONOMY}"]`, `choose "${CLICK_AUTONOMY}" explicitly`)
        await delay(500)
      }
      await click('[data-setup-next="review"]', 'See what that sets')

      await until('the review', 'document.querySelector("[data-setup-section]").innerText.includes("what those answers set")')
      if (!RACY) {
        const review = await screen()
        check('the review does not warn that nothing will start an agent',
          !review.includes('nothing here will start an agent'))
        await shot('5-review')
      }

      /* HOW MANY FINISH BUTTONS ARE ON THIS SCREEN, and is the one a person's eye
         reaches first the one that works? tools/setup-walkthrough-qa.mjs presses
         the FIRST match and times out; this suite presses the LAST and does not.
         If those two differ, the difference is a customer pressing the wrong
         Finish, which is a dead end nobody would ever describe as one. */
      const finishButtons = RACY ? '(not read: --racy presses without looking)' : await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('[data-setup-next="finish"]')]
        return JSON.stringify(nodes.map(node => ({
          label: node.textContent.replace(/\\s+/g, ' ').trim(),
          disabled: node.disabled === true,
          shown: node.getBoundingClientRect().width > 0 && getComputedStyle(node).display !== 'none',
        })))
      })()`
      )
      console.log(`  finish buttons on the review: ${finishButtons}`)

      /* THE STEP THE EXISTING HARNESS REPORTS ONLY AS "timed out". */
      const finishStarted = Date.now()
      await click('[data-setup-next="finish"]', 'Finish setup')
      let landed = false
      let lastSaid = ''
      for (let waited = 0; waited < FINISH_BUDGET_MS; waited += 1000) {
        if (await evaluate('location.hash === "#/" || location.hash === ""')) { landed = true; break }
        const said = await evaluate('location.hash + " | " + (document.querySelector("[data-setup-section]")?.innerText || document.querySelector("#stage")?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200)')
        if (said !== lastSaid) { console.log(`    +${Math.round(waited / 1000)}s  ${said}`); lastSaid = said }
        await delay(1000)
      }
      const finishMs = Date.now() - finishStarted
      check('Finish setup lands the person in the application', landed,
        `${(finishMs / 1000).toFixed(1)}s${landed ? '' : ` (gave up after ${(FINISH_BUDGET_MS / 1000).toFixed(0)}s; screen still says: ${lastSaid})`}`)
      /* A BUTTON THAT WORKS EVENTUALLY IS NOT THE SAME AS ONE THAT WORKS. The
         existing harness budgets 15s, so anything slower reads to the next
         person as a hang; and to a customer, a Finish button that sits on
         "Saving..." past about ten seconds is indistinguishable from a broken
         one. This is reported separately so "it landed" cannot hide "it took
         most of a minute". */
      check('and it does so inside the budget the other suites allow it (15s)',
        landed && finishMs < 15000, `${(finishMs / 1000).toFixed(1)}s`)
      if (!landed) throw new Error(`Finish setup never returned within ${FINISH_BUDGET_MS}ms -- the recommended path dead-ends on the Saving button`)

      /* AND IT HAS TO STILL BE TRUE A MOMENT LATER.
         Reading the route once, immediately after Finish, is how this suite
         reported a green over a live defect: `navigate('#/')` sets the hash
         synchronously, so the hash is briefly correct even when the first-run
         gate is about to throw the person straight back to question 1. A single
         read cannot tell "arrived" from "passing through", and the run that
         follows it then sets the hash itself and never notices. So the route is
         watched for several seconds and the LAST value is what counts. */
      let bounced = null
      for (let i = 0; i < 6; i += 1) {
        await delay(1000)
        const where = await evaluate('location.hash')
        if (where !== '#/' && where !== '') { bounced = where; break }
      }
      const gate = await evaluate(`JSON.stringify({
        bootstrap: globalThis.mcSetup?.bootstrap ?? null,
        profile: (() => { try { return JSON.parse(localStorage.getItem('mc.setup.profile') || 'null') } catch { return 'unparseable' } })(),
        writeAgentSession: localStorage.getItem('mc.write.agent-session'),
      })`)
      check('and the person STAYS in the application rather than being sent back to question 1',
        bounced === null, bounced ? `bounced to ${bounced} -- setup loops forever. gate=${gate}` : 'stayed')
      if (bounced) throw new Error(`the recommended path loops: Finish returns to ${bounced}. gate=${gate}`)

      /* WHERE FINISH ACTUALLY PUTS THE PERSON, quoted rather than assumed. On a
         machine with no data source configured this is the whole of what they
         meet, so a run that skipped straight to an agent URL would be measuring
         a screen the customer has no way to reach. */
      await delay(1500)
      const landing = await evaluate('(location.hash + " | " + (document.querySelector("#stage")?.innerText || "")).replace(/\\s+/g, " ").trim().slice(0, 400)')
      console.log(`  landed on: ${landing}`)
      await shot('6-landing')

      /* THE QUESTION THE WHOLE WALKTHROUGH EXISTS TO ANSWER. */
      await evaluate('location.hash = "#/agent/c1/terra-01"')
      await until('the agent page', 'Boolean(document.querySelector(".agentv"))', 80)
      await delay(2500)
      await evaluate("document.querySelector('.agent-session-surface')?.scrollIntoView({ block: 'center' })")
      await delay(400)
      await shot('6-agent')
      const page = await evaluate(READ_AGENT_PAGE)
      check('the recommended answers leave the start control switched on',
        page.writeFlag === 'enabled', `mc.write.agent-session=${page.writeFlag}, autonomy=${page.autonomy}`)
      check('a Start control is on the agent page and visible',
        page.startPresent && page.startShown, `present=${page.startPresent} shown=${page.startShown}`)
      check('the page is not an absence where a control should be',
        page.offSurface === false, `offSurface=${page.offSurface} status=${page.sessionStatus}`)

      console.log(`\nclicks from first-run screen to a visible Start control: ${clicks}`)
      writeFileSync(path.join(scratch, 'result.json'), `${JSON.stringify({ clicks, finishMs, page }, null, 2)}\n`, 'utf8')
    } finally {
      session.close()
      try { child.kill() } catch { /* already gone */ }
      await delay(800)
    }
  } finally {
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds files briefly */ } }
    else console.log(`kept: ${scratch}`)
  }

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    for (const entry of failed) console.log(`  FAILED  ${entry.name}`)
    process.exitCode = 1
  }
}

await main()
