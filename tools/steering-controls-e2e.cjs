'use strict'

/* PROOF BY USE THAT PAUSE, RESPAWN AND TERMINATE STEER A REAL AGENT PROCESS.
 *
 * The sibling smoke (tools/agent-from-ui-smoke.cjs) proves a person can START
 * an agent from the interface. It calls window.mcAgent directly, which is the
 * right shape for that question and the wrong shape for this one: the three
 * steering controls are DOM buttons whose availability, confirm step and
 * ownership arbitration all live in src/views/agent.js, and a check that
 * bypasses them proves the bridge works while the buttons stay dead.
 *
 * So this drives the real page: it boots shell/main.cjs, navigates the real
 * renderer to a real agent's drill-in, presses the real Start control, and then
 * presses Pause, Respawn and Terminate the way a person does -- including the
 * second press each destructive control requires.
 *
 * AND IT CHECKS THE OPERATING SYSTEM, NOT THE SCREEN. Every claim about a
 * control's effect is checked against the process table: the Codex child this
 * window owns is identified by pid before the control is pressed and looked for
 * again afterwards. A control that repaints its own label is not a control that
 * steered anything, and the difference is only visible from outside the app.
 *
 * Verified by exit code. Any failed step exits non-zero.
 */

const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')
const { reapDescendants } = require('./process-tree.cjs')

const APP_ROOT = process.env.MC_APP_ROOT || path.resolve(__dirname, '..')
const TIMEOUT_MS = 600_000
const SNAPSHOT_TIMEOUT_MS = 20_000

/* POINTING THIS AT release/win-unpacked/resources/app.asar RUNS THE SHIPPED
 * BITS, and it needs one thing the app root cannot supply.
 *
 * resolveCapabilityRoot() in shell/capability-layer.cjs reads
 * `process.resourcesPath`, which Electron sets to ITS OWN resources directory
 * when a checkout's electron binary is the host. So loading the packaged
 * shell/main.cjs out of the asar resolves the packaged shell and the packaged
 * renderer but no capability payload at all -- measured: the window came up and
 * `mcOrg.read()` answered ORG_PAYLOAD_ABSENT, which is the app correctly
 * reporting that it has no organisation rather than any steering defect.
 *
 * It is read at call time, not at load, so naming the packaged resources
 * directory before shell/main.cjs is required is enough. Set only when the
 * caller asked for it: an unset value must keep the checkout's own behaviour,
 * because a harness that silently redirects a product's payload lookup is a
 * harness that can no longer say which copy it measured. */
if (process.env.MC_RESOURCES_PATH && process.env.MC_RESOURCES_PATH.trim() !== '') {
  /* defineProperty, not assignment: `process.resourcesPath` is a read-only
     own property, and the plain assignment threw at module load -- which
     Electron reported as "App threw an error during load" and then sat on for
     the full watchdog, eleven minutes for a one-line mistake. Failing loudly
     and continuing is strictly better than failing at load. */
  try {
    Object.defineProperty(process, 'resourcesPath', {
      value: path.resolve(process.env.MC_RESOURCES_PATH),
      configurable: true,
      writable: false,
      enumerable: true,
    })
  } catch (error) {
    console.error('[steering] could not point resourcesPath at the packaged payload: ' + error.message)
  }
}
console.log(`[steering] appRoot=${APP_ROOT}`)
console.log(`[steering] resourcesPath=${process.resourcesPath}`)

const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

let finishing = false
function finish(code) {
  if (finishing) return
  finishing = true
  const reaped = reapDescendants(process.pid)
  if (reaped > 0) console.log(`[steering] reaped ${reaped} descendant process(es) before exit`)
  app.exit(code)
}

function fatal(message) {
  console.error('STEERING FATAL: ' + message)
  finish(20)
}

/* ---------- the process table, read the way the test must read it ----------
 *
 * One CIM snapshot per call rather than one Get-Process per pid: the walk has
 * to be a single instant or a child that starts between two queries appears in
 * neither, which is exactly the moment respawn occupies. */
function snapshot() {
  let raw
  try {
    raw = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true })
  } catch (error) {
    throw new Error('could not read the process table: ' + error.message)
  }
  try {
    const rows = JSON.parse(raw)
    return Array.isArray(rows) ? rows : [rows]
  } catch (error) {
    throw new Error('could not parse the process table: ' + error.message)
  }
}

/** Every descendant of this process whose image is the Codex binary. */
function codexPids() {
  const rows = snapshot()
  const children = new Map()
  const named = new Map()
  for (const row of rows) {
    if (!row) continue
    const pid = Number(row.ProcessId)
    const parent = Number(row.ParentProcessId)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue
    named.set(pid, String(row.Name || ''))
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(pid)
  }
  const found = []
  const seen = new Set([process.pid])
  const queue = [process.pid]
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue
      seen.add(pid)
      if (/^codex(\.exe)?$/i.test(named.get(pid) || '')) found.push(pid)
      queue.push(pid)
    }
  }
  return found.sort((a, b) => a - b)
}

function aliveNow(pid) {
  if (!Number.isSafeInteger(pid)) return false
  try {
    const out = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`,
    ], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true })
    const count = out.trim()
    if (count !== '0' && count !== '1') {
      throw new Error('unexpected process count: ' + JSON.stringify(count))
    }
    return count === '1'
  } catch (error) {
    throw new Error(`could not determine whether pid ${pid} is alive: ${error.message}`)
  }
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until `read()` satisfies `ok`, or give up. Returns the last reading. */
async function until(read, ok, { timeout = 60_000, every = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last = await read()
  while (!ok(last)) {
    if (Date.now() > deadline) return last
    await settle(every)
    last = await read()
  }
  return last
}

require(path.join(APP_ROOT, 'shell', 'main.cjs'))

async function windowReady() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within 60s')
    await settle(250)
  }
}

/* The page's own reading of the three controls, as a person sees them. */
const CONTROL_STATE = `(() => {
  const read = (id) => {
    const b = document.querySelector('[data-control="' + id + '"]')
    if (!b) return null
    return {
      disabled: b.disabled === true,
      label: b.querySelector('.ctl-label')?.textContent || '',
      note: b.querySelector('.ctl-note')?.textContent || '',
      phase: b.dataset.phase || '',
    }
  }
  const result = document.querySelector('.ctl-result')
  const status = document.querySelector('[data-session-status]')
  const transcript = document.querySelector('[data-session-output]')
  return JSON.stringify({
    pause: read('pause'),
    respawn: read('respawn'),
    terminate: read('terminate'),
    result: result ? result.textContent : null,
    sessionStatus: status ? status.textContent : null,
    transcript: transcript ? transcript.textContent.length : null,
  })
})()`

/* The sentence the panel prints while one control is in flight. Nothing may be
   pressed until it is gone: a click arriving during it is silently dropped by
   runSessionControl(), which would make a harness measure a press that never
   happened. */
const BUSY = /One control at a time/i

/* REAL INPUT, NOT A DOM CALL. Every OTHER assertion in this file checks the
 * operating system rather than the screen (see the file header); the presses
 * themselves used to be the one place this file still took a shortcut --
 * `document.querySelector(...).click()`, which JS-DISPATCHES the SAME EVENT A
 * COVERED, HIDDEN OR ZERO-SIZE CONTROL WOULD ALSO ANSWER TO.
 *
 * This file drives a live Electron BrowserWindow rather than a raw CDP
 * session, so it cannot reuse tools/lib/fleet-node.mjs's press() verbatim
 * (that one calls session.send('Input.dispatchMouseEvent', ...), and there is
 * no CDP session object here -- only webContents). It DOES reuse that
 * module's FLEET_NODE_VISIBLE verbatim: the exact same bounding-box +
 * elementFromPoint reachability proof steps 1-3 of the doctrine require,
 * dynamically imported since this file is CommonJS and that module is not.
 * Step 4 -- the actual dispatch -- uses webContents.sendInputEvent(), which is
 * Electron's own equivalent of CDP's Input.dispatchMouseEvent: it enters
 * Chromium's real input pipeline rather than calling a DOM method, which is
 * the property the doctrine cares about, not the specific transport. */
async function makePresser() {
  const { FLEET_NODE_VISIBLE } = await import('./lib/fleet-node.mjs')
  return function pressReal(win, js, selector, timeoutMs = 12_000) {
    return (async () => {
      const until_ = Date.now() + timeoutMs
      let spot = { state: 'absent' }
      for (;;) {
        spot = JSON.parse(await js(`JSON.stringify((${FLEET_NODE_VISIBLE})(${JSON.stringify(selector)}))`))
        if (spot.state === 'visible' || Date.now() >= until_) break
        await settle(250)
      }
      if (spot.state !== 'visible') {
        return spot.state === 'covered' ? `covered-by-${spot.by}` : spot.state
      }
      const x = Math.round(spot.x)
      const y = Math.round(spot.y)
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await settle(400)
      return 'clicked'
    })()
  }
}

async function run() {
  const win = await windowReady()
  const js = code => win.webContents.executeJavaScript(code, true)
  const controls = async () => JSON.parse(await js(CONTROL_STATE))
  const pressReal = await makePresser()
  const press = selector => pressReal(win, js, selector)

  step('the real app window loaded', true, await js('document.title'))

  const availability = JSON.parse(await js('window.mcAgent.availability().then(JSON.stringify)'))
  if (availability.ok !== true) {
    step('an engine is configured for this run', false, 'code=' + availability.code)
    return
  }
  step('an engine is configured for this run', true, availability.code)

  /* The agent whose page we drive is read from the product's own org store, so
     this cannot pass against an id that only exists in the test. */
  const org = JSON.parse(await js('window.mcOrg.read().then(JSON.stringify)'))
  const declared = (org && org.org && Array.isArray(org.org.agents)) ? org.org.agents : []
  const target = declared.find(a => a && a.enabled !== false) || declared[0]
  if (!target) {
    step('the product declares an agent to steer', false, 'org=' + JSON.stringify(org).slice(0, 200))
    return
  }
  step('the product declares an agent to steer', true, `agentId=${target.id}`)

  /* Turn the write action on the way Settings does, and land on the live
     drill-in. Reloaded, because both flags are read at mount. */
  await js(`(() => {
    localStorage.setItem('mc.write.agent-session', 'enabled')
    localStorage.removeItem('mc.example')
    location.hash = '#/agent/this-computer/${target.id}'
    return true
  })()`)
  await js('location.reload()')
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
  await settle(2500)

  const start = JSON.parse(await until(
    async () => js(`JSON.stringify((() => {
      const b = document.querySelector('[data-session-start]')
      const s = document.querySelector('[data-session-status]')
      return { present: Boolean(b), disabled: b ? b.disabled : null, status: s ? s.textContent : null }
    })())`),
    v => { const p = JSON.parse(v); return p.present && p.disabled === false },
    { timeout: 90_000 },
  ))
  step('the live agent page offers a working Start control', start.present && start.disabled === false, JSON.stringify(start))
  if (!start.present || start.disabled !== false) return

  const idle = await controls()
  step(
    'with no session the three controls refuse in a sentence naming the remedy',
    idle.pause.disabled && idle.respawn.disabled && idle.terminate.disabled
      && /start one above/i.test(String(idle.result || '')),
    JSON.stringify(idle.result),
  )

  const before = codexPids()

  /* Long enough that a turn is genuinely still running when Pause is pressed.
     A prompt that completes first would make Pause unavailable and the run
     would measure nothing. */
  await js(`(() => {
    const form = document.querySelector('[data-session-form]')
    form.elements.text.value = 'Count from 1 to 300. Print one number per line, and after each number write one short sentence about it. Do not stop early.'
    document.querySelector('[data-session-start]').click()
    return true
  })()`)

  /* WAIT FOR REAL OUTPUT, not just for the button to enable.
   *
   * The first run of this file pressed Pause the moment Pause enabled, which is
   * immediately after start() and before the model has emitted a token. The
   * transcript was 0 characters long before the press and 0 after it, and the
   * "output stopped" check passed on that -- measuring nothing, which is the
   * absence-read-as-consent shape this project keeps finding, here in the test
   * rather than the product. A turn that is demonstrably streaming is the only
   * precondition under which "it stopped" means anything. */
  const running = await until(
    controls,
    c => c.pause && c.pause.disabled === false && Number(c.transcript) > 0,
    { timeout: 180_000 },
  )
  step('Start opened a session and Pause became available while it works', running.pause.disabled === false,
    `pause.note=${JSON.stringify(running.pause.note)} status=${JSON.stringify(running.sessionStatus)}`)
  step('the agent is genuinely producing output when Pause is pressed', Number(running.transcript) > 0,
    `transcriptChars=${running.transcript}`)
  if (!(Number(running.transcript) > 0)) return

  const started = await until(async () => codexPids(), pids => pids.some(p => !before.includes(p)), { timeout: 60_000 })
  const sessionPids = started.filter(p => !before.includes(p))
  step('a real Codex process is running underneath the page', sessionPids.length > 0, 'pids=' + JSON.stringify(sessionPids))
  if (sessionPids.length === 0) return
  const firstPid = sessionPids[0]

  // ---------- PAUSE ----------
  const growing = (await controls()).transcript
  const pausePress = await press('[data-control="pause"]')
  step('a person can actually reach and press Pause (real input, elementFromPoint-verified)', pausePress === 'clicked', pausePress)
  if (pausePress !== 'clicked') return
  const paused = await until(controls, c => /Stopped the turn that was running|did not happen/i.test(String(c.result || '')), { timeout: 120_000 })
  step('Pause reported that it stopped the turn', /Stopped the turn that was running/i.test(String(paused.result || '')), JSON.stringify(paused.result))
  step('Pause left the session open, not killed', aliveNow(firstPid), `pid=${firstPid}`)
  step('Pause disabled itself once nothing is running', paused.pause?.disabled === true, JSON.stringify(paused.pause))
  step('Respawn and Terminate stay available over the idle session',
    paused.respawn?.disabled === false && paused.terminate?.disabled === false,
    `respawn=${paused.respawn?.note} terminate=${paused.terminate?.note}`)

  /* The transcript is the only evidence that the WORK stopped, as distinct from
     the button reporting that it did. Sampled twice across a gap: a paused turn
     writes nothing more. */
  const settled = (await controls()).transcript
  await settle(8000)
  const later = (await controls()).transcript
  step('the agent stopped producing output after Pause',
    Number(settled) > 0 && settled === later,
    `atClick=${growing} afterPause=${settled} eightSecondsLater=${later}`)

  // ---------- RESPAWN ----------
  await until(controls, c => !BUSY.test(String(c.result || '')), { timeout: 120_000 })
  const respawnPress1 = await press('[data-control="respawn"]')
  step('a person can actually reach and press Respawn the first time (real input, elementFromPoint-verified)', respawnPress1 === 'clicked', respawnPress1)
  if (respawnPress1 !== 'clicked') return
  const confirming = await until(controls, c => /select again/i.test(String(c.respawn?.note || '')), { timeout: 30_000 })
  step('Respawn asks before it destroys the session', /select again/i.test(String(confirming.respawn?.note || '')), JSON.stringify(confirming.respawn))
  const respawnPress2 = await press('[data-control="respawn"]')
  step('a person can actually reach and press Respawn the confirming time (real input, elementFromPoint-verified)', respawnPress2 === 'clicked', respawnPress2)
  if (respawnPress2 !== 'clicked') return
  /* Sampled DURING the action, which is the only moment this can be observed.
     Respawn closes a child and starts another, so it is in flight for seconds;
     if the poll sees the finished sentence first the sample is reported as
     missed rather than assumed. */
  const inFlight = await until(
    controls,
    c => c.respawn?.phase === 'pending' || /Ended that session and started a new one/i.test(String(c.result || '')),
    { timeout: 120_000, every: 120 },
  )
  step('while Respawn runs, the button says it is working rather than unavailable',
    inFlight.respawn?.phase === 'pending' && inFlight.respawn?.note === 'Working…' && inFlight.respawn?.disabled === true,
    JSON.stringify({ respawn: inFlight.respawn, result: inFlight.result }))

  const respawned = await until(
    controls,
    c => /Ended that session and started a new one|respawn did not happen/i.test(String(c.result || '')),
    { timeout: 180_000 },
  )
  step('Respawn reported a new session', /Ended that session and started a new one/i.test(String(respawned.result || '')), JSON.stringify(respawned.result))

  const afterRespawn = await until(
    async () => codexPids(),
    pids => !pids.includes(firstPid) && pids.some(p => !before.includes(p) && p !== firstPid),
    { timeout: 90_000 },
  )
  const secondPid = afterRespawn.find(p => !before.includes(p) && p !== firstPid)
  step('Respawn killed the original Codex process', !aliveNow(firstPid), `pid=${firstPid} alive=${aliveNow(firstPid)}`)
  step('Respawn started a DIFFERENT Codex process', Number.isSafeInteger(secondPid) && secondPid !== firstPid,
    `before=${firstPid} after=${secondPid}`)
  if (!Number.isSafeInteger(secondPid)) return

  // ---------- TERMINATE ----------
  await until(controls, c => !BUSY.test(String(c.result || '')), { timeout: 120_000 })
  const terminatePress1 = await press('[data-control="terminate"]')
  step('a person can actually reach and press Terminate the first time (real input, elementFromPoint-verified)', terminatePress1 === 'clicked', terminatePress1)
  if (terminatePress1 !== 'clicked') return
  const terminateConfirm = await until(controls, c => /select again/i.test(String(c.terminate?.note || '')), { timeout: 30_000 })
  step('Terminate asks before it ends the session', /select again/i.test(String(terminateConfirm.terminate?.note || '')), JSON.stringify(terminateConfirm.terminate))
  const terminatePress2 = await press('[data-control="terminate"]')
  step('a person can actually reach and press Terminate the confirming time (real input, elementFromPoint-verified)', terminatePress2 === 'clicked', terminatePress2)
  if (terminatePress2 !== 'clicked') return
  const terminated = await until(controls, c => /Ended the session\.|terminate did not happen/i.test(String(c.result || '')), { timeout: 180_000 })
  step('Terminate reported the session ended', /Ended the session/i.test(String(terminated.result || '')), JSON.stringify(terminated.result))

  const gone = await until(async () => aliveNow(secondPid), v => v === false, { timeout: 90_000 })
  step('Terminate killed the Codex process the page had started', gone === false, `pid=${secondPid} alive=${gone}`)

  const afterAll = await controls()
  step('after Terminate the controls refuse again, naming the remedy',
    afterAll.pause?.disabled === true && afterAll.respawn?.disabled === true && afterAll.terminate?.disabled === true,
    JSON.stringify({ pause: afterAll.pause?.note, respawn: afterAll.respawn?.note, terminate: afterAll.terminate?.note }))

  const leftovers = codexPids().filter(p => !before.includes(p))
  step('no Codex process was orphaned by the run', leftovers.length === 0, 'leftovers=' + JSON.stringify(leftovers))
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => fatal('exceeded ' + TIMEOUT_MS + 'ms'), TIMEOUT_MS)
  try {
    await run()
    clearTimeout(guard)
    const failed = steps.filter(s => !s.ok)
    console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`)
    finish(failed.length === 0 ? 0 : 1)
  } catch (error) {
    clearTimeout(guard)
    console.error('STEERING ERROR:', error && error.stack ? error.stack : error)
    finish(21)
  }
})
