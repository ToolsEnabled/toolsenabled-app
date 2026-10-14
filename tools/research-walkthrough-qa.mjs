#!/usr/bin/env node

// THE RESEARCH WORKBENCH, DRIVEN LIVE IN A REAL PACKAGED BUILD.
//
// WHAT THIS PROVES THAT NO UNIT SUITE CAN. The #/research page is a live
// product surface: it pins to the capability layer its own shell supervises,
// reads the durable research service through ten bridge routes, keeps a
// person's experiments in their ACCOUNT row, and holds every run behind the
// research.pipeline settings gate. Each of those is a boundary between four
// processes (renderer, shell, capability layer, state store), and a source
// assertion sees exactly one side of any of them. This file stages a real
// packaged copy, swaps in the CURRENT dist/, shell/ AND capability/ payload,
// and walks the page the way a person would on a fresh machine:
//
//   1. A fresh universe opens on the first-run question; skip leads to the app.
//   2. The research page mounts LIVE by default -- no example face, and the
//      signed-out designer says "sign in" instead of pretending.
//   3. An account is created and signed in through the product's own surface
//      (window.mcAccount), and the designer form appears for it.
//   4. A project is created through the page's own New-project flow.
//   5. A queue-sized grid experiment is designed and submitted through the ONE
//      designer form -- and the SETTINGS GATE refuses it, out loud, with the
//      switch's own name (research.pipeline) in the status line. Nothing is
//      queued behind the refusal. This is live enforcement end to end,
//      measured WITHOUT flipping any owner setting.
//   6. The worker control shows the service's own lifecycle word, and starting
//      the worker is refused by the same gate, by name.
//
// THE ISOLATION CONTRACT (same mechanisms as setup-walkthrough-qa.mjs, and
// each is the one it is for a measured reason):
//   --user-data-dir   isolates userData -- and with it the capability state
//                     root (<userData>/capability), the workspace, the account
//                     store and the single-instance lock.
//   LOCALAPPDATA      isolates the engine's services root AND the settings
//                     file the research gate reads (%LOCALAPPDATA%\ToolsEnabled\
//                     settings.json) -- the REAL one is never touched, which is
//                     also why the gate's default-off answer is assertable.
//   USERPROFILE       isolates defaultWorkspacePath().
// ELECTRON_RUN_AS_NODE is stripped (a GUI launch under it is a silent exit 0),
// MC_SMOKE_HEADLESS=1 keeps the window off the desktop, and MC_BRIDGE_PROOF_FILE
// is removed so nothing even resembles the developer bridge path: the staged
// app runs SUPERVISED -- its own shell starts its own capability layer against
// this scratch universe, and the renderer pins to that layer (source:
// 'supervised'), which this file asserts before it asserts anything else about
// the service. No port anybody else owns is contacted: the harness itself
// never fetches the bridge, and the staged layer binds its own free port.
//
// IT KILLS ONLY WHAT IT STARTED, matched by executable PATH under its own
// scratch copy -- which also covers the capability layer, because the layer IS
// this same executable running as node.
//
// RUN IT:
//   node tools/research-walkthrough-qa.mjs --release <win-unpacked dir>
//   (defaults to <repo>/release/win-unpacked, like every packaged driver here)

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { releaseDirectory, stage as stageRelease, stageModeForArguments, STAGE_EXACT_RELEASE } from './test-account-harness.mjs'
import { appExecutable } from './lib/packaged-platform.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

const RELEASE = releaseDirectory()
const KEEP = process.argv.includes('--keep')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/* Every directory under a root, relative and sorted. Used as the disk's own
   answer to "did a program actually run", which no sentence on a screen can
   give. */
export function walkDirectories(root, readDirectory = readdirSync) {
  const found = []
  const walk = (current, prefix) => {
    let entries
    try {
      entries = readDirectory(current, { withFileTypes: true })
    } catch (cause) {
      /* ENOENT is the one answer that means this directory is absent (a run
         may disappear while the board is being refreshed). Resource pressure,
         unreadable media, and unclassified throws do not prove an empty tree. */
      if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return
      const error = new Error(`could not inspect ${current}; this is not claiming that the directory or its run artifacts are absent`, { cause })
      error.code = 'DIRECTORY_WALK_UNAVAILABLE'
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      found.push(relative)
      walk(path.join(current, entry.name), relative)
    }
  }
  walk(root, '')
  return found.sort()
}

/* ---------- stage a real packaged copy ----------
 *
 * Explicit candidate mode copies the whole selected release unchanged. It must
 * not add missing Research routes from checkout and then credit the candidate.
 *
 * Only implicit development mode follows setup-walkthrough-qa.mjs: borrow the built Electron binary,
 * swap in the current renderer and shell, write nothing under release/. ONE
 * DELIBERATE ADDITION: the capability payload (resources/capability, an
 * electron-builder extraResource OUTSIDE app.asar) is ALSO replaced with this
 * tree's capability/, because the packaged payload predates the ten research-*
 * bridge routes this walkthrough drives. A staged payload that silently lacked
 * them would report "the product has no research service" about a copy that
 * was never given one, so the swap is verified before launch. */
async function stage(scratch) {
  if (stageModeForArguments() === STAGE_EXACT_RELEASE) {
    return (await stageRelease(scratch)).executable
  }
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const app = path.join(scratch, 'app')
  const unpacked = path.join(scratch, 'asar-stage')

  if (!existsSync(path.join(RELEASE, 'resources', 'app.asar'))) {
    throw new Error(`no packaged build at ${RELEASE}. Run \`npm run dist\` first, or pass --release <dir>.`)
  }
  cpSync(RELEASE, app, { recursive: true, dereference: true })
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))

  /* The current capability payload, staged whole. It lives beside app.asar,
     never inside it (shell/capability-layer.cjs resolveCapabilityRoot). */
  const capabilityFrom = path.join(REPO_ROOT, 'capability')
  const capabilityTo = path.join(app, 'resources', 'capability')
  if (!existsSync(path.join(capabilityFrom, 'PAYLOAD.json'))) {
    throw new Error(`capability/ has no PAYLOAD.json at ${capabilityFrom}; this tree cannot stage a capability layer`)
  }
  rmSync(capabilityTo, { recursive: true, force: true })
  cpSync(capabilityFrom, capabilityTo, { recursive: true })
  /* VERIFIED, NOT ASSUMED: the staged payload must actually carry the research
     routes this walkthrough exists to drive. */
  const serverSource = readFileSync(path.join(capabilityTo, 'src', 'lib', 'mission-bridge', 'server.js'), 'utf8')
  if (!serverSource.includes('/v1/actions/research-run-submit')) {
    throw new Error('the staged capability payload does not carry the research bridge routes; staging failed')
  }

  return asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
    /* Named, not found: on Linux the launcher is the `toolsenabled` ELF and
       this staged copy had no `.exe` to return. */
    .then(() => appExecutable(app))
}

/* ---------- a bounded CDP client (the setup harness's, verbatim) ---------- */

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
        if (child.exitCode !== null) {
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered; this is a startup failure, not a slow paint`)
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

/* ---------- the walkthrough ---------- */

async function drive(executable, scratch) {
  const port = await freePort()
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  }

  const profile = path.join(scratch, 'profile')
  mkdirSync(path.join(profile, 'userdata'), { recursive: true })

  /* The one shared launch environment (tools/lib/sterile-launch.cjs): every
     home inside the scratch profile, ELECTRON_RUN_AS_NODE deleted. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  /* Never the developer-bridge path, even by accident. A packaged build fences
     the variable anyway; this states the intent where it can be read. */
  delete environment.MC_BRIDGE_PROOF_FILE
  /* Owner directive R193: no window on the owner's desktop for automated QA.
     The exact string '1' -- shell/window-options.cjs matches nothing else. */
  environment.MC_SMOKE_HEADLESS = '1'

  const child = spawn(executable, [
    `--user-data-dir=${path.join(profile, 'userdata')}`,
    `--remote-debugging-port=${port}`,
  ], { env: environment, stdio: 'ignore', windowsHide: true })

  const session = createSession(port, child)
  try {
    await session.open()
    await session.send('Runtime.enable')

    const evaluate = async expression => {
      const packet = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (packet.result?.exceptionDetails) throw new Error(packet.result.exceptionDetails.exception?.description || 'evaluate failed')
      return packet.result?.result?.value
    }
    const until = async (label, expression, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return
        await delay(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }
    const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`)

    /* ----- 1. the fresh universe opens on the first-run question; skip it ----- */

    await until('the setup route', 'location.hash === "#/setup"')
    check('a fresh universe opens on the first-run question', true)
    await evaluate('document.querySelector("[data-setup-continue]").click()')
    await until('the folder question', 'document.querySelector("[data-setup-section]").innerText.includes("Which folder")')
    await evaluate('document.querySelector("[data-setup-skip]").click()')
    await until('the app', 'location.hash === "#/" || location.hash === ""')
    check('skip leads into the app', true)

    /* ----- 2. the shell's own capability layer, pinned by the renderer -----
       The supervised source is the whole point: the renderer never scans and
       never touches a port some other process (the live keeper bridge on 4610)
       owns. Waiting here also absorbs the layer's startup so the research
       page's first snapshot lands on a listening service. */

    await until(
      'the supervised capability layer',
      'window.mcShell.getBridgeEndpoint().then(e => e && e.ok === true && e.source === "supervised")',
      240,
    )
    const endpoint = JSON.parse(await evaluate('window.mcShell.getBridgeEndpoint().then(e => JSON.stringify(e))'))
    check('the shell supervises its own capability layer and the renderer pins to it',
      endpoint.source === 'supervised' && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.baseUrl),
      `${endpoint.baseUrl} pid ${endpoint.pid}`)

    /* ----- 3. the research page mounts LIVE, signed out, no example face ----- */

    await evaluate('location.hash = "#/research"')
    await until('the research page', 'document.querySelector("main.research-page") !== null')
    check('the research page mounts live by default in a fresh universe',
      await evaluate('document.querySelector("main.research-page")?.dataset.liveMode') === 'live')

    /* The service snapshot answering is ALSO the proof the renderer completed
       its bootstrap against the pinned layer -- in supervised mode there is no
       other listener it could have reached. */
    await until('the project selector fed by the service snapshot',
      'document.querySelector("[data-project-select]") && document.querySelector("[data-project-select]").disabled === false', 120)
    check('the project selector reflects the live service snapshot', true)

    const pageText = await text('main.research-page')
    check('no example face bleeds into the live page',
      !/example face|example data/i.test(pageText))

    await until('the signed-out designer sentence',
      'document.querySelector("[data-research-designer]").innerText.includes("Sign in to design experiments")')
    check('signed out, the designer asks for sign-in instead of pretending', true)

    check('the honest hold is on the project bar before anything is pressed',
      /pipeline is switched off in settings/i.test(await text('[data-project-status]')),
      (await text('[data-project-status]')).slice(0, 120))

    /* ----- 4. an account, created and signed in through the product surface ----- */

    const created = JSON.parse(await evaluate(
      `window.mcAccount.create(${JSON.stringify({ username: 'walkthrough', displayName: 'Walkthrough', password: 'walkthrough owns this bench 2026' })}).then(r => JSON.stringify(r))`,
    ))
    check('a local account is created through the product surface', created.ok === true, created.ok ? created.account.username : `${created.code}: ${created.reason}`)

    const signedIn = JSON.parse(await evaluate(
      `window.mcAccount.signIn(${JSON.stringify({ username: 'walkthrough', password: 'walkthrough owns this bench 2026' })}).then(r => JSON.stringify(r))`,
    ))
    check('the account signs in', signedIn.ok === true, signedIn.ok ? '' : `${signedIn.code}: ${signedIn.reason}`)
    check('the shell reports the session as signed in',
      JSON.parse(await evaluate('window.mcAccount.current().then(r => JSON.stringify(r))')).signedIn === true)

    /* Remount the research view so it re-reads the account rows. The old view
       lingers ~420ms for its exit transition, so wait for it to actually leave
       before asking for the fresh one. */
    await evaluate('location.hash = "#/"')
    await until('the research view to retire', 'document.querySelectorAll("main.research-page").length === 0')
    await evaluate('location.hash = "#/research"')
    await until('the signed-in designer form', 'document.querySelector("[data-exp-form]") !== null', 80)
    check('signed in, the designer offers the one form',
      !(await text('[data-research-designer]')).includes('Sign in to design experiments'))

    /* ----- 5. a project, through the page's own New-project flow -----
       window.prompt throws in Electron by design, so the page carries its own
       inline name field; this drives it the way a person does — open, type,
       press Create. */

    await until('the New project control', 'document.querySelector("[data-project-new]") && document.querySelector("[data-project-new]").hidden === false', 120)
    await evaluate('document.querySelector("[data-project-new]").click()')
    await until('the inline name field', 'document.querySelector("[data-project-new-form]") && document.querySelector("[data-project-new-form]").hidden === false')
    await evaluate('(() => { document.querySelector("[data-project-new-name]").value = "Walkthrough project"; return true })()')
    await evaluate('document.querySelector("[data-project-new-save]").click()')
    await until('the created project to be selected',
      '[...document.querySelectorAll("[data-project-select] option")].some(o => o.textContent.includes("Walkthrough project") && o.selected)', 80)
    check('New project creates and selects a project through the page flow', true)

    /* ----- 6. the ONE designer form: a queue-sized grid experiment ----- */

    const filled = await evaluate(`(() => {
      const form = document.querySelector('[data-exp-form]')
      if (!form) return false
      form.elements.name.value = 'Walkthrough grid'
      form.elements.runnerKind.value = 'process'
      form.elements.runnerDetail.value = ${JSON.stringify('cmd.exe\n/c\necho walkthrough')}
      form.elements.datasetPath.value = ''
      /* The axes builder, driven the way a person drives it: add a row, name
         the axis, write its values. The Advanced raw fields stay empty, so the
         row is the one source the submit composes from. */
      form.querySelector('[data-axis-add]').click()
      const row = form.querySelector('[data-axis-rows] [data-axis-row]')
      if (!row) return false
      row.querySelector('[data-axis-name]').value = 'variant'
      row.querySelector('[data-axis-values]').value = 'a, b'
      form.elements.runsPerCell.value = '1'
      form.requestSubmit()
      return true
    })()`)
    check('the designer form takes the grid experiment', filled === true)
    await until('the saved experiment card', 'document.querySelector("[data-exp-run]") !== null', 80)
    check('a process-runner grid is queue-sized, and the control says so',
      (await evaluate('document.querySelector("[data-exp-run]").textContent')) === 'Send to the run queue')

    /* ----- 6b. the gathered view and the status strip -----
       The card opens into ONE inline panel carrying the experiment's cells;
       and the project bar's status strip states the current load honestly --
       here, before anything runs, that is an explicit "nothing running"
       rather than a silent blank. */

    await evaluate('document.querySelector("[data-exp-open]").click()')
    await until('the gathered panel', 'document.querySelector("[data-exp-gathered]") !== null', 40)
    check('the card opens into one gathered view holding its cells',
      (await evaluate('document.querySelectorAll("[data-exp-gathered] .research-cell").length')) === 2,
      (await text('[data-exp-gathered]')).slice(0, 120).replace(/\n/g, ' | '))
    check('the status strip states absence honestly',
      (await text('[data-research-pulse]')).trim() === 'nothing running',
      (await text('[data-research-pulse]')).slice(0, 80))

    /* ----- 7. the settings gate, live, holding the submit -----
       research.pipeline defaults OFF and this universe has no settings file,
       so the service MUST refuse -- and the refusal must surface as its own
       sentence, naming the switch, in the designer's status line. */

    await evaluate('document.querySelector("[data-exp-run]").click()')
    let refusalSurfaced = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await text('[data-mc="designer"]')).includes('research.pipeline')) { refusalSurfaced = true; break }
      await delay(250)
    }
    check('the settings gate refuses the submit and the refusal surfaces, naming research.pipeline',
      refusalSurfaced,
      refusalSurfaced
        ? (await text('[data-exp-form-status]')).slice(0, 160)
        : `designer says: ${(await text('[data-mc="designer"]')).slice(0, 300).replace(/\n/g, ' | ')}`)

    await until('the service run board after the refusal',
      'document.querySelector("[data-service-runboard]") !== null', 80)
    check('nothing was queued behind the refusal',
      (await text('[data-service-runboard]')).includes('No grid experiments are registered'),
      (await text('[data-service-runboard]')).slice(0, 160).replace(/\n/g, ' | '))

    /* ----- 8. the worker control and the same gate on the lifecycle ----- */

    const workerText = await text('[data-research-worker]')
    check('the worker control shows the service\'s own lifecycle word',
      /Run worker: [a-z_ ]+\./i.test(workerText), workerText.slice(0, 120))
    check('the run board service block renders', await evaluate('document.querySelector("[data-service-runboard]") !== null'))

    const startOffered = await evaluate('document.querySelector(\'[data-research-worker-toggle="start"]\') !== null')
    check('the worker start control is offered (the runtime is configured)', startOffered)
    if (startOffered) {
      await evaluate('document.querySelector(\'[data-research-worker-toggle="start"]\').click()')
      await until('the worker refusal sentence',
        'document.querySelector("[data-research-worker-status]").innerText.includes("research.pipeline")', 120)
      check('starting the worker is refused by the same gate, named',
        (await text('[data-research-worker-status]')).includes('research.pipeline'),
        (await text('[data-research-worker-status]')).slice(0, 160))
    }

    /* ----- 9. THE SWITCH THE PAGE HAS BEEN POINTING AT -----
     *
     * Everything above measures the refusal, and the refusal was never in
     * doubt. What WAS wrong, and what the final gate stopped a cut over, is
     * that the sentence naming the switch pointed at nothing: there was no
     * control for the research pipeline anywhere in this product, and the only
     * way to run a single research job was to hand-write the settings file
     * beside the program -- which is what every measurement of this page had
     * done up to now. A research product whose research cannot be switched on
     * by the person it belongs to is not shippable, whatever the refusal says.
     *
     * So this half is the other direction, and every step of it is a press:
     * follow the page's own link, find the switch, turn it on, come back, and
     * watch a submitted run reach a REAL process. Nothing here writes a
     * settings file; the product does, and the file on disk is read back
     * afterwards to prove which. */

    const linkHref = await evaluate('document.querySelector("[data-project-status] a")?.getAttribute("href") || ""')
    check('the hold sentence carries a link to the switch it names',
      /^#\/settings\?setting=research/.test(linkHref), JSON.stringify(linkHref))

    await evaluate('document.querySelector("[data-project-status] a").click()')
    await until('the settings page the link names', 'document.querySelector("main.settings-page") !== null', 80)
    await until('the research section to answer the installed application',
      'document.querySelector("[data-research-setting-row=\'research.pipeline\']") !== null', 160)
    check('the switch the sentence points at EXISTS in Settings', true,
      (await text("[data-research-setting-row='research.pipeline']")).replace(/\n/g, ' | ').slice(0, 140))

    check('it is a real control, not a sentence about one',
      await evaluate('document.querySelector("input[data-research-setting=\'research.pipeline\']") !== null'))
    check('and it starts off, matching the refusal the page has been showing',
      await evaluate('document.querySelector("input[data-research-setting=\'research.pipeline\']").checked') === false)

    /* BOTH switches. The pipeline is a fence rather than a hint, and this
       experiment runs a PROGRAM, so the row that permits programs has to be on
       as well -- which is the behaviour the section itself states. */
    for (const settingId of ['research.pipeline', 'research.runner_process']) {
      await evaluate('document.querySelector("input[data-research-setting=\'' + settingId + '\']").click()')
      await until('the ' + settingId + ' row to report what the write did',
        '/turned on/i.test(document.querySelector("[data-research-setting-status=\'' + settingId + '\']")?.innerText || "")', 160)
    }
    check('pressing the switches reports what the write actually did',
      /turned on/i.test(await text("[data-research-setting-status='research.pipeline']")),
      (await text("[data-research-setting-status='research.pipeline']")).slice(0, 160))

    /* THE FILE THE ENFORCER READS, read off the disk rather than believed.
       A control that repaints itself and writes nothing is the defect this
       whole section exists to end, so the proof is the bytes -- including the
       provenance, because the gate refuses a value nobody chose. */
    const settingsFile = path.join(profile, 'local', 'ToolsEnabled', 'settings.json')
    let written = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (existsSync(settingsFile)) { try { written = JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { written = null } }
      if (written?.values?.['research.pipeline'] === true) break
      await delay(250)
    }
    check('the switch wrote the file the enforcer reads, as this person’s own choice',
      written?.values?.['research.pipeline'] === true
        && written?.values?.['research.runner_process'] === true
        && written?.provenance?.['research.pipeline']?.source === 'user',
      JSON.stringify({ values: written?.values ?? null, provenance: written?.provenance?.['research.pipeline'] ?? null }).slice(0, 220))

    /* ----- 10. and now the SAME submit runs a real process ----- */

    await evaluate('location.hash = "#/research"')
    await until('the research page again', 'document.querySelector("main.research-page") !== null', 80)
    await until('the project bar to re-read the gate',
      'document.querySelector("[data-project-status]") && !/switched off in settings/i.test(document.querySelector("[data-project-status]").innerText)', 160)
    check('the hold sentence is gone once the switch is on',
      !/switched off in settings/i.test(await text('[data-project-status]')),
      (await text('[data-project-status]')).slice(0, 120) || '(empty, which is the honest state)')

    await until('the run control', 'document.querySelector("[data-exp-run]") !== null', 80)
    await evaluate('document.querySelector("[data-exp-run]").click()')
    await until('the submitted runs to appear on the run board',
      'document.querySelectorAll("[data-run-drill]").length >= 2', 200)
    const queued = await evaluate('document.querySelectorAll("[data-run-drill]").length')
    check('the submit is accepted now and the runs are queued', queued >= 2, queued + ' run(s) on the board')

    const startNow = await evaluate('document.querySelector("[data-research-worker-toggle=\'start\']") !== null')
    check('the worker start control is still offered', startNow)
    if (startNow) await evaluate('document.querySelector("[data-research-worker-toggle=\'start\']").click()')
    await until('the worker to report a lifecycle answer rather than the gate',
      '!/research\\.pipeline/.test(document.querySelector("[data-research-worker-status]")?.innerText || "")', 200)
    check('starting the worker is no longer refused by the gate',
      !/research\.pipeline/.test(await text('[data-research-worker-status]')),
      (await text('[data-research-worker-status]')).slice(0, 160))

    /* THE PROCESS ITSELF. This experiment's runner is cmd.exe /c echo, and the
       runner spawns it with the run's own artifact folder as its working
       directory. So the proof that a program really ran is a folder on this
       disk, inside this run's own isolated universe, that the product created
       while the driver watched -- not a word on a screen, which a page can
       paint from anything. */
    const artifactRoot = path.join(profile, 'userdata', 'capability', 'state', 'research')
    let ranFolders = []
    let boardWord = ''
    for (let attempt = 0; attempt < 240; attempt += 1) {
      boardWord = (await text('[data-service-runboard]')) || ''
      ranFolders = existsSync(artifactRoot) ? walkDirectories(artifactRoot) : []
      /* THE PRODUCT'S OWN WORD, not the service's status code. The board
         renders runStateWord(), which says 'finished' for a succeeded run --
         a driver waiting for 'succeeded' polls out its whole budget over a run
         that finished in seconds and then reports the product as stuck, which
         is what the first version of this check did. */
      if (ranFolders.length > 0 && /finished|failed|cancelled/i.test(boardWord)) break
      await delay(500)
    }
    check('a real process ran: the product made the run its own artifact folder',
      ranFolders.length > 0,
      ranFolders.length > 0 ? ranFolders.slice(0, 4).join(', ') : 'nothing under ' + artifactRoot)
    check('the run reaches a terminal state on the board rather than sitting queued',
      /finished/i.test(boardWord) && !/queued\b/i.test(boardWord.replace(/queued through the service/gi, '')),
      boardWord.replace(/\n/g, ' | ').slice(0, 220))

    /* ----- 11. and the worker stops when it is told to -----
     *
     * A control that only starts is half a control, and there is a second,
     * blunter reason this is here: the worker is a real child process holding
     * this run's staged payload open, so a driver that walks away from a
     * running worker cannot delete its own scratch copy. The first version of
     * this section did exactly that and ended a 35-of-35 run with an EBUSY
     * stack instead of a verdict. */
    const stopOffered = await evaluate('document.querySelector("[data-research-worker-toggle=\'stop\']") !== null')
    if (stopOffered) {
      await evaluate('document.querySelector("[data-research-worker-toggle=\'stop\']").click()')
      await until('the worker to report that it stopped',
        '/stopped/i.test(document.querySelector("[data-research-worker]")?.innerText || "")', 160)
    }
    check('the worker stops when it is told to',
      stopOffered && /stopped/i.test(await text('[data-research-worker]')),
      (await text('[data-research-worker]')).replace(/\n/g, ' | ').slice(0, 160))
  } finally {
    session.close()
    await delay(300)
    /* By PATH, under this run's own scratch copy. This one filter also reaps
       the capability layer: it is the same executable, running as node. */
    try {
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='ToolsEnabled.exe'" | Where-Object { $_.ExecutablePath -like '${path.join(scratch, 'app').replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', windowsHide: true })
    } catch { /* nothing of ours left to stop */ }
    try { child.kill() } catch { /* already gone */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (child.exitCode !== null) break
      await delay(250)
    }
  }

  const failed = checks.filter(entry => !entry.ok)
  console.log(`research walkthrough: ${checks.length - failed.length}/${checks.length} checks`)
  return failed.length === 0
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-research-qa-'))
  let ok = false
  try {
    const executable = await stage(scratch)
    console.log(`artifact: ${RELEASE}; staging: ${stageModeForArguments()}; scratch Research scenario, not installer qualification`)
    console.log('\nresearch walkthrough, fresh universe:')
    ok = await drive(executable, scratch)
  } finally {
    /* THE SCRATCH COPY IS NOT A VERDICT. A staged payload is held open by any
       child that has not finished exiting, and Windows reports that as EBUSY --
       which used to throw out of this block and end a run that had passed every
       check with a stack trace and no verdict at all. What is left behind is a
       temporary directory; it is reported and the run's own answer stands. */
    if (!KEEP) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
      } catch (error) {
        console.log(`the scratch copy could not be removed (${error.code || error.message}); it is at ${scratch}`)
      }
    }
  }
  console.log(ok ? '\nresearch walkthrough: PASS' : '\nresearch walkthrough: FAIL')
  process.exit(ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
