#!/usr/bin/env node

/* THE ENDING OF A RUN, DRIVEN: IS IT WRITTEN DOWN, AND IS ITS ABSENCE HONEST?
 *
 * WHAT THIS ANSWERS. The run ledger wrote two lines per run -- the intent, then
 * started/refused -- and never a line when the session ended, so the product
 * could not truthfully show a finished state or a duration. shell/main.cjs now
 * records `agent_session_end`, and this drives every way a session can end on a
 * staged packaged build and reads what the ledger actually says afterwards:
 *
 *   A  the person STOPS it from the interface        -> reason `closed`
 *   B  the engine's child EXITS on its own            -> reason `exited`
 *   C  the app is KILLED hard                         -> NO end record; the
 *      chain still verifies; the next launch invents nothing
 *   D  the app is closed the ordinary way             -> reason `app-shutdown`
 *
 * IT IS DRIVEN, NOT INSPECTED. Every press is a real mouse press at real
 * coordinates on a staged packaged build (document.elementFromPoint checked
 * first, so a covered control is reported covered rather than clicked); typing
 * is Input.insertText into a focused field. No el.click(), no dispatchEvent.
 *
 * IT NEVER TOUCHES THE INSTALLED COPY. The build is staged into a scratch
 * directory, every launch carries its own --user-data-dir, and LOCALAPPDATA,
 * APPDATA and USERPROFILE are redirected under a scratch profile
 * (tools/test-account-harness.mjs owns that rig).
 *
 * THE ENGINE, AND WHAT THAT COSTS THE CLAIM. The session runs through the real
 * path -- engine, shell/agent-host.cjs, shell/main.cjs, the preload's channel,
 * the renderer -- against tools/test/fixtures/exiting-engine, which spawns a
 * REAL child process (this executable re-entered as Node) so that "the child's
 * own exit" is a genuine operating-system event, and narrates a scripted turn.
 * It answers nothing and reasons about nothing. What this proves is that the
 * product writes down how a session it really started ended, from the process
 * it really started; whether a paid engine's child exits at any given moment is
 * a fact about that engine.
 *
 * THE VERDICT IS THE PRODUCT'S OWN. The chain is verified through
 * window.mcAgent.history() -- the same path the home screen uses, in the main
 * process, where the key is. This driver reads the ledger file too, to say what
 * the bytes hold, but never re-implements the verifier.
 *
 *   node tools/session-end-record-drive.mjs
 *   node tools/session-end-record-drive.mjs --visible
 *   node tools/session-end-record-drive.mjs --keep      leave the scratch directory
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertIsolated,
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
  userDataFor,
} from './test-account-harness.mjs'
import { createChatPresser } from './lib/chat-drive-lib.mjs'

const KEEP = process.argv.includes('--keep')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const EXITING_ENGINE = path.join(REPO, 'tools/test/fixtures/exiting-engine/src/lib/agent-engine/codex-process.js')
const LEDGER_FILE = 'agent-spawn-records.jsonl'

const findings = []
const note = (level, text) => {
  findings.push({ level, text })
  if (level === 'FAIL') process.exitCode = 1
  console.log(`  ${level.padEnd(5)} ${text}`)
}
const check = (ok, subject, detail = '') => note(ok ? 'PASS' : 'FAIL', `${subject}${detail ? ` -- ${detail}` : ''}`)

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (value && typeof value === 'object' && value.__couldNotReadSessionId) {
    const error = new Error(`could not read ${what} (${value.sourceCode || 'UNCLASSIFIED'}); this is NOT claiming the session id is absent`)
    error.code = 'SESSION_ID_READ_INDETERMINATE'
    throw error
  }
  if (value && typeof value === 'object' && value.__couldNotCheckAvailability) {
    const error = new Error(`could not check ${what} (${value.sourceCode || 'UNCLASSIFIED'}); this is NOT claiming the engine is unavailable`)
    error.code = 'ENGINE_AVAILABILITY_INDETERMINATE'
    throw error
  }
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

/* ------------------------------------------------------------- pressing -- */

/* B-POOL-6 MIGRATION (API decision doc §6, step 2 of 5): byte-identical to
   chat-history-drive.mjs's own press/typeInto/key before its own step-1
   migration -- verified directly, not assumed, before this file was
   touched. Same adapter, same one named behavior change (FLEET_NODE_
   VISIBLE's ancestor-opacity walk over this harness's own window.
   waitForVisible/VISIBLE_FN); see chat-history-drive.mjs's own comment at
   this same point for the full account. */
const pressers = new WeakMap()
function presserFor(window) {
  let presser = pressers.get(window)
  if (!presser) {
    presser = createChatPresser({ session: window.session, evaluate: window.evaluate, delay })
    pressers.set(window, presser)
  }
  return presser
}

async function press(window, selector, timeoutMs = 9000) {
  const result = await presserFor(window).press(selector, timeoutMs)
  if (result !== 'clicked') return { pressed: false, why: result }
  return { pressed: true, at: {} }
}

async function typeInto(window, selector, text) {
  const pressed = await press(window, selector)
  if (!pressed.pressed) return pressed
  await presserFor(window).typeInto(text)
  return pressed
}

async function key(window, name, _keyCode) {
  await presserFor(window).key(name)
}

async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if (await valueNow() === wanted) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses` }
}

/* ---------------------------------------------------------------- state -- */

async function computerOnScreen(window) {
  await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
  await window.evaluate("location.hash = '#/computers'")
  await delay(1000)
  await window.evaluate('location.reload()')
  await delay(3800)
  return window.evaluate('window.__mcGraph?.computer?.id || null')
}

/* Ported from tools/chat-history-drive.mjs: the dashed circle, the compose
   panel, a tier and a role by keyboard, a brief, then Start. */
async function startAgentFromCanvas(window, brief) {
  const doorway = await press(window, '.computers .tree-empty-node')
  if (!doorway.pressed) return { ok: false, why: `the dashed circle could not be pressed (${doorway.why})` }
  await delay(2200)
  const offered = readOrThrow(await window.evaluate(`(() => {
    const read = (field) => {
      const node = document.querySelector('[data-compose-field="' + field + '"]')
      return node ? [...node.options].map(o => o.value).filter(Boolean) : []
    }
    return { tiers: read('tier'), roles: read('role') }
  })()`), 'the compose menus')
  if (!offered.tiers.length || !offered.roles.length) {
    return { ok: false, why: `the compose panel offered no tier or role (${JSON.stringify(offered)})` }
  }
  const pickedTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', offered.tiers[0])
  if (!pickedTier.ok) return { ok: false, why: `could not choose a tier (${pickedTier.why})` }
  const pickedRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
  if (!pickedRole.ok) return { ok: false, why: `could not choose a role (${pickedRole.why})` }
  const typed = await typeInto(window, '[data-compose-field="message"]', brief)
  if (!typed.pressed) return { ok: false, why: `the brief field could not be pressed (${typed.why})` }

  const startTarget = readOrThrow(await window.evaluate(`(() => {
    const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = [...document.querySelectorAll('button')].filter(visible).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'session-end-drive-start'
    return { selector: '#' + btn.id, label: btn.textContent.trim().slice(0, 40) }
  })()`), 'the Start control')
  if (!startTarget) return { ok: false, why: 'there is no Start control on the compose panel' }
  const before = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas before the start',
  )
  const pressedStart = await press(window, startTarget.selector)
  if (!pressedStart.pressed) return { ok: false, why: `Start could not be pressed (${pressedStart.why})` }
  await delay(5200)
  const after = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas after the start',
  )
  const fresh = after.find(id => !before.includes(id)) || null
  if (!fresh) return { ok: false, why: `the start drew no new circle (${after.length} on the canvas)` }
  return { ok: true, nodeId: fresh }
}

/* The session id the node holds, read off the page's own saved tree record
   (`mc.fleet.trees.v1:<computerId>`, src/fleet-trees.js). It is the join key
   between the ledger and the conversation, and reading it from the record is
   what makes "the ledger's end record is THIS node's" a measurement. */
async function sessionIdOfNode(window, computerId, nodeId) {
  return readOrThrow(await window.evaluate(`(() => {
    try {
      const raw = localStorage.getItem('mc.fleet.trees.v1:' + ${JSON.stringify(computerId)})
      const record = raw ? JSON.parse(raw) : null
      const node = record && Array.isArray(record.nodes) ? record.nodes.find(n => n.id === ${JSON.stringify(nodeId)}) : null
      return node && node.sessionId ? node.sessionId : null
    } catch (error) {
      return {
        __couldNotReadSessionId: true,
        sourceCode: error && typeof error === 'object' && error.code ? String(error.code) : 'UNCLASSIFIED_THROW'
      }
    }
  })()`), 'the session id on the node')
}

/* --------------------------------------------------------------- ledger -- */

function ledgerLines(profile) {
  const file = path.join(userDataFor(profile), LEDGER_FILE)
  let bytes
  try {
    bytes = readFileSync(file, 'utf8')
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return []
    const sourceCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : 'UNCLASSIFIED_THROW'
    const error = new Error(`could not read the session ledger (${sourceCode}); this is NOT claiming the ledger is absent or empty`)
    error.code = 'SESSION_LEDGER_READ_INDETERMINATE'
    error.cause = cause
    throw error
  }
  return bytes.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/* The run for one session, as the ledger bytes hold it. */
function runOf(lines, sessionId) {
  const start = lines.find(line => line.action === 'agent_session_start' && line.sessionId === sessionId) || null
  const outcome = start ? lines.find(line => line.action === 'agent_session_outcome' && line.outcome?.resolves === start.sequence) || null : null
  const ends = start ? lines.filter(line => line.action === 'agent_session_end' && line.end?.resolves === start.sequence) : []
  return { start, outcome, ends }
}

function describeRun(run) {
  if (!run.start) return 'no start record'
  return `start #${run.start.sequence} ${run.outcome ? run.outcome.outcome.result : 'no outcome'}; `
    + (run.ends.length ? run.ends.map(e => `end #${e.sequence} ${e.end.reason} turns=${e.end.turns} last=${e.end.lastTurnStatus}`).join(' | ') : 'NO end record')
}

async function historyFromApp(window) {
  return readOrThrow(await window.evaluate('(async () => { try { return await window.mcAgent.history({ limit: 200 }) } catch (error) { return { ok: false, code: String(error && error.message) } } })()'), 'mcAgent.history()')
}

/* Find, and press, the Stop row in the chat's Actions popup. */
async function stopFromTheInterface(window, nodeId) {
  const bubble = await press(window, `.node[data-agent-id="${nodeId}"]`)
  if (!bubble.pressed) return { ok: false, why: `the circle could not be pressed (${bubble.why})` }
  await delay(1200)
  const actions = await press(window, '[data-rail-chat-host] [data-chat-actions]')
  if (!actions.pressed) return { ok: false, why: `the Actions control could not be pressed (${actions.why})` }
  await delay(600)
  const row = readOrThrow(await window.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.chat-actions-pop .chat-actions-row')]
    const stop = rows.find(r => /^stop this agent/i.test(r.textContent.trim()))
    if (!stop) return { found: false, labels: rows.map(r => r.textContent.trim().slice(0, 30)) }
    if (!stop.id) stop.id = 'session-end-drive-stop'
    return { found: true, selector: '#' + stop.id, disabled: stop.disabled === true }
  })()`), 'the Stop row')
  if (!row.found) return { ok: false, why: `no Stop row in the Actions popup (${JSON.stringify(row.labels)})` }
  if (row.disabled) return { ok: false, why: 'the Stop row is disabled -- the node is not running' }
  const pressed = await press(window, row.selector)
  if (!pressed.pressed) return { ok: false, why: `the Stop row could not be pressed (${pressed.why})` }
  await delay(1500)
  const said = readOrThrow(await window.evaluate("(document.querySelector('.chat-actions-out')?.textContent || '').trim()"), 'the Actions output')
  return { ok: true, said }
}

/* Start a session through the interface and hand back what the ledger holds
   for it once it is running. Shared by every scenario. */
async function startAndLocate(window, profile) {
  const computerId = await computerOnScreen(window)
  if (!computerId) return { ok: false, why: 'the computers page never named a computer' }
  const reachable = readOrThrow(
    await window.evaluate(`(async () => {
      try { return await window.mcAgent.availability() }
      catch (error) {
        return {
          __couldNotCheckAvailability: true,
          sourceCode: error && typeof error === 'object' && error.code ? String(error.code) : 'UNCLASSIFIED_THROW'
        }
      }
    })()`),
    'the agent availability probe',
  )
  if (!reachable || reachable.ok !== true) return { ok: false, skip: true, why: `no engine reachable in this staged build (${reachable && reachable.code})` }
  const started = await startAgentFromCanvas(window, 'Say done.')
  if (!started.ok) return { ok: false, why: started.why }
  const sessionId = await sessionIdOfNode(window, computerId, started.nodeId)
  if (!sessionId) return { ok: false, why: `the node ${started.nodeId} holds no session id` }
  const run = runOf(ledgerLines(profile), sessionId)
  if (!run.start || !run.outcome || run.outcome.outcome.result !== 'started') {
    return { ok: false, why: `the ledger does not show a started run for ${sessionId}: ${describeRun(run)}` }
  }
  return { ok: true, nodeId: started.nodeId, sessionId, run }
}

/* -------------------------------------------------------------- scenarios -- */

async function scenarioA(executable, scratch, appRoot) {
  console.log('\nA. the person stops it from the interface -> closed')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  delete process.env.MC_TEST_EXIT_AFTER_MS
  const window = await openWindow(executable, profile)
  try {
    const started = await startAndLocate(window, profile)
    if (!started.ok) { note(started.skip ? 'SKIP' : 'FAIL', started.why); return }
    note('INFO', `session ${started.sessionId}: ${describeRun(started.run)}`)
    check(started.run.ends.length === 0, 'a running session has no end record yet', describeRun(started.run))

    /* The first turn ends on its own (turns=1). A second message opens a turn
       the fixture keeps open, so the node is running and Stop is offered. */
    const bubble = await press(window, `.node[data-agent-id="${started.nodeId}"]`)
    if (!bubble.pressed) { note('FAIL', `the circle could not be pressed (${bubble.why})`); return }
    await delay(1000)
    const typed = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'keep going')
    if (!typed.pressed) { note('FAIL', `the message box could not be pressed (${typed.why})`); return }
    await key(window, 'Enter', 13)
    await delay(1200)

    const stopped = await stopFromTheInterface(window, started.nodeId)
    if (!stopped.ok) { note('FAIL', stopped.why); return }
    note('INFO', `pressed Stop; the popup said ${JSON.stringify(stopped.said)}`)

    const run = runOf(ledgerLines(profile), started.sessionId)
    check(run.ends.length === 1, 'the ledger carries exactly one end record for the run', describeRun(run))
    const end = run.ends[0]?.end
    check(end?.reason === 'closed', 'its reason is closed', JSON.stringify(end))
    check(end?.resolves === run.start.sequence, 'it resolves the start record', `resolves=${end?.resolves} start=#${run.start.sequence}`)
    check(end?.turns === 1, 'it counts the one turn that completed', `turns=${end?.turns}`)
    check(end?.lastTurnStatus === 'completed', 'it carries the engine\'s own word for that turn, verbatim', `lastTurnStatus=${end?.lastTurnStatus}`)
    check(!('durationMs' in (end || {})) && !JSON.stringify(run.ends[0]).match(/duration/i), 'it carries no duration')

    const history = await historyFromApp(window)
    check(history.ok === true && history.verified === true, 'the app verifies the chain with the end record in it', `verified=${history.verified} total=${history.total}`)
    const shown = Array.isArray(history.entries) ? history.entries.find(e => e.action === 'agent_session_end' && e.sessionId === started.sessionId) : null
    check(Boolean(shown) && shown.end?.reason === 'closed' && shown.end?.resolves === run.start.sequence, 'history() hands the end to the reader with the same join key', JSON.stringify(shown?.end))
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
  /* AND CLOSING THE APP AFTERWARDS ADDS NO SECOND ENDING to a session that
     already ended. */
  const lines = ledgerLines(profile)
  const ends = lines.filter(line => line.action === 'agent_session_end')
  check(ends.length === 1, 'closing the app afterwards wrote no second ending for the stopped session', `${ends.length} end record(s): ${ends.map(e => e.end.reason).join(',')}`)
}

async function scenarioB(executable, scratch, appRoot) {
  console.log('\nB. the child exits on its own -> exited')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  process.env.MC_TEST_EXIT_AFTER_MS = '6000'
  const window = await openWindow(executable, profile)
  try {
    const started = await startAndLocate(window, profile)
    if (!started.ok) { note(started.skip ? 'SKIP' : 'FAIL', started.why); return }
    note('INFO', `session ${started.sessionId}: ${describeRun(started.run)}`)
    /* The start took ~5s of the child's 6s life; give it time to go. */
    await delay(4000)
    const run = runOf(ledgerLines(profile), started.sessionId)
    check(run.ends.length === 1, 'the ledger carries exactly one end record for the run', describeRun(run))
    const end = run.ends[0]?.end
    check(end?.reason === 'exited', 'its reason is exited', JSON.stringify(end))
    check(end?.resolves === run.start.sequence, 'it resolves the start record', `resolves=${end?.resolves} start=#${run.start.sequence}`)
    check(end?.turns === 1 && end?.lastTurnStatus === 'completed', 'it counts the completed turn and keeps the engine\'s word', `turns=${end?.turns} last=${end?.lastTurnStatus}`)
    const history = await historyFromApp(window)
    check(history.ok === true && history.verified === true, 'the app verifies the chain', `verified=${history.verified} total=${history.total}`)
  } finally {
    delete process.env.MC_TEST_EXIT_AFTER_MS
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
  const ends = ledgerLines(profile).filter(line => line.action === 'agent_session_end')
  check(ends.length === 1, 'closing the app afterwards wrote no second ending for the exited session', `${ends.length}: ${ends.map(e => e.end.reason).join(',')}`)
}

async function scenarioC(executable, scratch, appRoot) {
  console.log('\nC. the app is killed hard -> no end record, and the absence stays honest')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  delete process.env.MC_TEST_EXIT_AFTER_MS
  let window = await openWindow(executable, profile)
  let sessionId = null
  let startSequence = null
  try {
    const started = await startAndLocate(window, profile)
    if (!started.ok) { note(started.skip ? 'SKIP' : 'FAIL', started.why); return }
    sessionId = started.sessionId
    startSequence = started.run.start.sequence
    note('INFO', `session ${sessionId}: ${describeRun(started.run)}`)
  } catch (error) {
    note('FAIL', `scenario C could not start a session: ${String(error && error.message).slice(0, 200)}`)
    await closeWindow(window); reap(window.timeline.pid)
    return
  }
  /* KILLED, NOT CLOSED. taskkill /F on the process tree: no before-quit, no
     destroyed, no chance to write. */
  try { window.session?.close() } catch { /* about to die anyway */ }
  reap(window.timeline.pid)
  await delay(2500)
  const after = runOf(ledgerLines(profile), sessionId)
  check(after.ends.length === 0, 'a hard kill leaves NO end record', describeRun(after))
  check(after.outcome?.outcome?.result === 'started', 'the start and its outcome are still there', describeRun(after))

  /* THE NEXT LAUNCH: verifies the chain, shows the run with no ending, and
     invents nothing. */
  window = await openWindow(executable, profile)
  try {
    const history = await historyFromApp(window)
    check(history.ok === true && history.verified === true, 'the next launch verifies the chain the kill interrupted', `verified=${history.verified} total=${history.total}`)
    const shown = Array.isArray(history.entries) ? history.entries.find(e => e.action === 'agent_session_start' && e.sessionId === sessionId) : null
    check(Boolean(shown) && shown.end === null, 'the run reads as "does not say" -- its end is null, not finished, not running', JSON.stringify(shown && { sequence: shown.sequence, outcome: shown.outcome, end: shown.end }))
    const anyEndForIt = Array.isArray(history.entries) ? history.entries.some(e => e.action === 'agent_session_end' && e.end?.resolves === startSequence) : false
    check(!anyEndForIt, 'the next launch backfilled no ending it did not observe')
    /* Straight off the disk too, after the app has been up a while. */
    await delay(1500)
    const disk = runOf(ledgerLines(profile), sessionId)
    check(disk.ends.length === 0, 'the ledger bytes still carry no ending for the killed run', describeRun(disk))
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
  const finalRun = runOf(ledgerLines(profile), sessionId)
  check(finalRun.ends.length === 0, 'and closing that launch wrote none either -- it never held the session', describeRun(finalRun))
}

async function scenarioD(executable, scratch, appRoot) {
  console.log('\nD. the app is closed the ordinary way with a session live -> app-shutdown (best effort)')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  delete process.env.MC_TEST_EXIT_AFTER_MS
  const window = await openWindow(executable, profile)
  let sessionId = null
  try {
    const started = await startAndLocate(window, profile)
    if (!started.ok) { note(started.skip ? 'SKIP' : 'FAIL', started.why); return }
    sessionId = started.sessionId
    note('INFO', `session ${sessionId}: ${describeRun(started.run)}`)
  } catch (error) {
    note('FAIL', `scenario D could not start a session: ${String(error && error.message).slice(0, 200)}`)
    await closeWindow(window); reap(window.timeline.pid)
    return
  }
  const timeline = await closeWindow(window, { graceful: true, waitMs: 12000 })
  reap(window.timeline.pid)
  note('INFO', `closed: graceful=${timeline?.closedGracefully === true} exit=${timeline?.exitCode}`)
  const run = runOf(ledgerLines(profile), sessionId)
  if (timeline?.closedGracefully === true) {
    check(run.ends.length === 1 && run.ends[0].end.reason === 'app-shutdown', 'an orderly quit recorded app-shutdown for the live session', describeRun(run))
    check(run.ends[0]?.end?.turns === 1 && run.ends[0]?.end?.lastTurnStatus === 'completed', 'with the turn count and the engine\'s word', describeRun(run))
  } else {
    /* The harness had to kill it: that is a hard kill, and the honest answer
       is the same as scenario C's. */
    check(run.ends.length === 0, 'the app would not close on its own, so it was killed, and no ending was written', describeRun(run))
  }
  assertIsolated(profile)
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'session-end-drive-'))
  console.log(`scratch: ${scratch}`)
  process.env.MISSION_CONTROL_ENGINE = EXITING_ENGINE
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged: ${executable}`)
    for (const scenario of [scenarioA, scenarioB, scenarioC, scenarioD]) {
      try {
        await scenario(executable, scratch, appRoot)
      } catch (error) {
        note('FAIL', `${scenario.name} threw: ${String(error && error.message).slice(0, 240)}`)
      }
    }
  } finally {
    const passed = findings.filter(f => f.level === 'PASS').length
    const failed = findings.filter(f => f.level === 'FAIL').length
    const skipped = findings.filter(f => f.level === 'SKIP').length
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* held open by a dead child */ } }
    else console.log(`kept: ${scratch}`)
  }
}

await main()
