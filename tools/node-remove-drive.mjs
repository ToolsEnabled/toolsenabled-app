#!/usr/bin/env node

/* REMOVING A NODE, DRIVEN ON THE GLASS.
 *
 * THE FINDING THIS ANSWERS, the owner's words: "there was also no way to
 * remove an old node you wanted to delete." The palette now carries the leg;
 * this drive proves the three states of the row and the whole removal on a
 * staged packaged build with real CDP input — real presses at coordinates,
 * real typing, the narrating fixture engine running a real turn through the
 * real host — and proves what is deleted against what is kept:
 *
 *   deleted  the node's record in the tree store, its durable saved
 *            conversation (through the transcript store), the window caches
 *   kept     the signed run records — read back through mc-agent:history and
 *            required to still verify AFTER the removal and AFTER a restart
 *
 * THE LEGS, in the order the design states them:
 *   1  parent with a child: Remove row disabled, "Move or remove its one
 *      agent first."
 *   2  child mid-turn: Remove row disabled, "Stop this agent first."
 *   3  stop the child from the same palette, reopen: Remove enabled; the
 *      confirm stage names the agent AND its saved conversation, with the
 *      signed-records sentence, plus Remove and Back
 *   4  confirmed: circle gone, store record gone, transcript record gone,
 *      ledger still verifying, rail back on the overview
 *   5  restart the app: still gone, no ghost
 *
 * Staging, isolation and input discipline are tools/test-account-harness.mjs's
 * (never the installed copy, never NSIS; a scratch profile per run).
 *
 *   node tools/node-remove-drive.mjs
 *   node tools/node-remove-drive.mjs --visible
 *   node tools/node-remove-drive.mjs --keep
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
} from './test-account-harness.mjs'
import { createChatPresser } from './lib/chat-drive-lib.mjs'

const KEEP = process.argv.includes('--keep')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NARRATING_ENGINE = path.join(REPO, 'tools/test/fixtures/narrating-engine/src/lib/agent-engine/codex-process.js')
const SHOTS = path.join(REPO, 'reports', 'node-remove-drive')

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
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

/* Evidence, never a measurement: a shot that cannot be taken is reported and
   swallowed. Page.setWebLifecycleState first, because a headless window never
   services the frame the capture waits for otherwise.
 *
 * AND BOUNDED, WHICH IS THE PART MEASURED HERE RATHER THAN ASSUMED. Two runs
 * of this drive stopped dead at the third shot: with the actions popup open on
 * its confirm sub-stage, Page.captureScreenshot never resolved, and because
 * session.send has no deadline the whole run hung on a picture — after every
 * check it was taking had already passed. A capture that cannot answer inside
 * the deadline is abandoned and said so; the readings stand on their own. */
const SHOT_DEADLINE_MS = 12_000
const withDeadline = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms}ms`)), ms)),
])

async function shoot(window, name) {
  try {
    mkdirSync(SHOTS, { recursive: true })
    await withDeadline(window.session.send('Page.setWebLifecycleState', { state: 'active' }), SHOT_DEADLINE_MS, 'the lifecycle change')
    const shot = await withDeadline(window.session.send('Page.captureScreenshot', { format: 'png' }), SHOT_DEADLINE_MS, 'the capture')
    const file = path.join(SHOTS, name)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  shot  ${file}`)
  } catch (error) {
    console.log(`  shot  ${name} could not be taken (${error?.message || error}); the readings above stand on their own`)
  }
}

/* ------------------------------------------------------------- pressing -- */

/* B-POOL-6 MIGRATION (API decision doc §6, step 2 of 5): byte-identical to
   chat-history-drive.mjs's own press/typeInto/key before its own step-1
   migration -- verified directly, not assumed, before this file was
   touched. Same adapter, same reasoning, same one named behavior change
   (FLEET_NODE_VISIBLE's ancestor-opacity walk over this harness's own
   window.waitForVisible/VISIBLE_FN, which only ever checked the target
   node's own opacity) -- see chat-history-drive.mjs's own comment at this
   same point for the full account. */
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

/* A <select> under CDP: Escape the native popup first, then arrow to the
   value. Ported from tools/chat-history-drive.mjs, which measured this. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if ((await valueNow()) === wanted) return { ok: true, presses: i }
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

const treesKey = computerId => `mc.fleet.trees.v1:${computerId}`
const storeKey = computerId => `mc.fleet.transcripts.v1:${computerId}`

const READ_TREES = computerId => `(() => {
  try {
    const raw = JSON.parse(localStorage.getItem(${JSON.stringify(treesKey(computerId))}))
    if (!raw) return { trees: [], nodes: [] }
    return { trees: raw.trees.map(t => t.id), nodes: raw.nodes.map(n => ({ id: n.id, parentId: n.parentId, status: n.status, statusNote: n.statusNote, sessionId: n.sessionId })) }
  } catch (error) { return { broken: String(error) } }
})()`

const READ_TRANSCRIPTS = computerId => `(() => {
  try {
    const raw = JSON.parse(localStorage.getItem(${JSON.stringify(storeKey(computerId))}))
    return { ids: raw && raw.nodes ? Object.keys(raw.nodes) : [] }
  } catch (error) { return { ids: [], broken: String(error) } }
})()`

const READ_LEDGER = `(async () => {
  try {
    const history = await window.mcAgent.history({ limit: 100 })
    if (!history || history.ok !== true) return { ok: false, code: history && history.code }
    return { ok: true, total: history.total, verified: history.verified, sessions: history.entries.map(e => e.sessionId) }
  } catch (error) { return { ok: false, code: String(error && error.message).slice(0, 120) } }
})()`

/* The actions popup as data: every row's label, enabled state, and the
   sentence it shows (the reason when disabled, the hint otherwise), plus the
   sub-stage title and the status line at the foot. */
const READ_POPUP = `(() => {
  const pop = document.querySelector('.chat-actions-pop')
  if (!pop) return null
  const title = pop.querySelector('.chat-actions-title')
  return {
    title: title && !title.hidden ? title.textContent.trim() : null,
    out: (pop.querySelector('.chat-actions-out')?.textContent || '').trim(),
    rows: [...pop.querySelectorAll('.chat-actions-row')].map(row => ({
      label: (row.querySelector('div')?.textContent || row.textContent || '').trim().slice(0, 60),
      disabled: row.disabled === true,
      sentence: (row.querySelector('.chat-actions-hint')?.textContent || '').trim(),
      why: (row.querySelector('.chat-actions-why')?.textContent || '').trim(),
    })),
  }
})()`

async function openPopup(window) {
  const pressed = await press(window, '[data-rail-chat-host] [data-chat-actions]')
  if (!pressed.pressed) return { ok: false, why: `the actions button could not be pressed (${pressed.why})` }
  await delay(400)
  const popup = readOrThrow(await window.evaluate(READ_POPUP), 'the actions popup')
  if (!popup) return { ok: false, why: 'no popup appeared' }
  return { ok: true, popup }
}

/* Press one popup row by its label. The rows repaint, so the id is stamped
   and pressed in the same beat. */
async function pressPopupRow(window, label) {
  const target = readOrThrow(await window.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.chat-actions-pop .chat-actions-row')]
    const at = rows.findIndex(row => ((row.querySelector('div')?.textContent) || '').trim() === ${JSON.stringify(label)})
    if (at < 0) return { at, labels: rows.map(row => ((row.querySelector('div')?.textContent) || '').trim()) }
    rows[at].id = 'node-remove-drive-row'
    return { at }
  })()`), `the ${label} row`)
  if (target.at < 0) return { pressed: false, why: `no row reads ${JSON.stringify(label)}; offered ${JSON.stringify(target.labels)}` }
  return press(window, '#node-remove-drive-row')
}

const rowByLabel = (popup, label) => popup.rows.find(row => row.label === label) || null

/* THE EVIDENCE HAS TO SHOW THE ROW UNDER MEASUREMENT. The popup's list
   scrolls, and the destructive group sits at its foot -- so a shot taken as
   the popup opens frames "Queue a message" and not the row this drive is
   about. Scrolling is a read, not a press: it moves nothing and changes no
   state, and the readings above it are already taken from the DOM. */
async function scrollRowIntoView(window, label) {
  await window.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.chat-actions-pop .chat-actions-row')]
    const row = rows.find(entry => ((entry.querySelector('div')?.textContent) || '').trim() === ${JSON.stringify(label)})
    if (row) row.scrollIntoView({ block: 'center' })
    return Boolean(row)
  })()`)
  await delay(350)
}

/* ------------------------------------------------ starting a real agent -- */

async function startAgentFromCanvas(window, brief, { slot = '.computers .tree-empty-node' } = {}) {
  const doorway = await press(window, slot)
  if (!doorway.pressed) return { ok: false, why: `the empty slot could not be pressed (${doorway.why})` }
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
    if (!btn.id) btn.id = 'node-remove-drive-start'
    return { selector: '#' + btn.id }
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

/* ---------------------------------------------------------------- drive -- */

async function drive(executable, scratch, appRoot) {
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  let computerId = null
  let parentId = null
  let childId = null
  let childSession = null
  try {
    computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) {
      note('FAIL', `no engine reachable in this staged build (${reachable && reachable.code}); the removal cannot be driven`)
      return
    }

    /* Two real agents, parent and child, the way a person makes them. */
    const parent = await startAgentFromCanvas(window, 'Coordinate this drive.')
    if (!parent.ok) { note('FAIL', `the parent could not be started: ${parent.why}`); return }
    parentId = parent.nodeId
    note('INFO', `the parent start drew ${parentId}`)
    const child = await startAgentFromCanvas(window, 'Do one small job under the coordinator.', {
      slot: `.tree-empty-node[data-parent-id="${parentId}"]`,
    })
    if (!child.ok) { note('FAIL', `the child could not be started: ${child.why}`); return }
    childId = child.nodeId
    note('INFO', `the child start drew ${childId}`)
    /* The session id is polled rather than sampled once: a second session on
       a machine already running one takes longer to come up than the first. */
    let childRecord = null
    for (let attempt = 0; attempt < 10 && !childRecord?.sessionId; attempt += 1) {
      await delay(1500)
      childRecord = readOrThrow(await window.evaluate(READ_TREES(computerId)), 'the tree record')
        .nodes.find(node => node.id === childId) || null
    }
    childSession = childRecord?.sessionId || null
    check(Boolean(childSession), 'the child holds a real session', childSession || `record=${JSON.stringify(childRecord)}`)
    if (!childSession) {
      const outcome = readOrThrow(await window.evaluate(`(() => ({
        status: (document.querySelector('.org-status')?.textContent || '').trim(),
        codes: [...document.querySelectorAll('[data-refusal-code]')].map(n => n.getAttribute('data-refusal-code')),
      }))()`), 'the start outcome line')
      note('INFO', `after the child start the status line reads ${JSON.stringify(outcome.status)} codes=${JSON.stringify(outcome.codes)}`)
      const saved = readOrThrow(await window.evaluate(READ_TREES(computerId)), 'the tree record')
      note('INFO', `tree record now: ${JSON.stringify(saved)}`)
      await shoot(window, '00-child-start-outcome.png')
      return
    }

    /* LEG 1 — the parent: Remove disabled with the children reason. */
    const parentCircle = await press(window, `.node[data-agent-id="${parentId}"]`)
    if (!parentCircle.pressed) { note('FAIL', `the parent circle could not be pressed (${parentCircle.why})`); return }
    await delay(1200)
    const parentPop = await openPopup(window)
    if (!parentPop.ok) { note('FAIL', parentPop.why); return }
    const parentRemove = rowByLabel(parentPop.popup, 'Remove this agent')
    check(Boolean(parentRemove), 'the parent palette carries the Remove row')
    check(parentRemove?.disabled === true, 'Remove on the parent is disabled while an agent works under it')
    check(
      parentRemove?.why === 'Move or remove its one agent first.',
      'the parent row says the children reason, in the store’s own words',
      JSON.stringify(parentRemove?.why),
    )
    await scrollRowIntoView(window, 'Remove this agent')
    await shoot(window, '01-parent-remove-disabled.png')
    await key(window, 'Escape', 27)

    /* LEG 2 — the child, mid-turn: Remove disabled with the stop reason. */
    const childCircle = await press(window, `.node[data-agent-id="${childId}"]`)
    if (!childCircle.pressed) { note('FAIL', `the child circle could not be pressed (${childCircle.why})`); return }
    await delay(1200)
    const sent = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'do that again')
    if (!sent.pressed) { note('FAIL', `the child message box could not be pressed (${sent.why})`); return }
    await key(window, 'Enter', 13)
    await delay(700)
    const runningPop = await openPopup(window)
    if (!runningPop.ok) { note('FAIL', runningPop.why); return }
    const runningRemove = rowByLabel(runningPop.popup, 'Remove this agent')
    const runningStop = rowByLabel(runningPop.popup, 'Stop this agent')
    check(runningRemove?.disabled === true, 'Remove on the running child is disabled')
    check(
      runningRemove?.why === 'Stop this agent first.',
      'the running row says the stop reason, in the store’s own words',
      JSON.stringify(runningRemove?.why),
    )
    check(runningStop?.disabled === false, 'the way out it names — Stop — is pressable in the same menu')
    await scrollRowIntoView(window, 'Remove this agent')
    await shoot(window, '02-child-running-remove-disabled.png')

    /* LEG 3 — stop it, reopen, and the confirm stage. */
    const stopPressed = await pressPopupRow(window, 'Stop this agent')
    if (!stopPressed.pressed) { note('FAIL', `Stop could not be pressed (${stopPressed.why})`); return }
    await delay(1500)
    const stopped = readOrThrow(await window.evaluate(READ_POPUP), 'the popup after Stop')
    note('INFO', `after Stop the status line reads ${JSON.stringify(stopped?.out || '')}`)
    await key(window, 'Escape', 27)
    await delay(400)

    /* The saved conversation this removal is about to name really exists. */
    const savedBefore = readOrThrow(await window.evaluate(READ_TRANSCRIPTS(computerId)), 'the transcript record')
    check(savedBefore.ids.includes(childId), 'the child has a saved conversation before the removal', savedBefore.ids.join(','))
    const ledgerBefore = readOrThrow(await window.evaluate(READ_LEDGER), 'the signed run records')
    check(ledgerBefore.ok === true && ledgerBefore.verified === true, 'the signed run records verify before the removal', `total=${ledgerBefore.total}`)
    check(ledgerBefore.sessions.includes(childSession), 'the child’s run is in the signed records', childSession)

    const freshPop = await openPopup(window)
    if (!freshPop.ok) { note('FAIL', freshPop.why); return }
    const removableRow = rowByLabel(freshPop.popup, 'Remove this agent')
    check(removableRow?.disabled === false, 'Remove on the stopped child is pressable')
    const opened = await pressPopupRow(window, 'Remove this agent')
    if (!opened.pressed) { note('FAIL', `the Remove row could not be pressed (${opened.why})`); return }
    await delay(600)
    const confirm = readOrThrow(await window.evaluate(READ_POPUP), 'the confirm stage')
    check(confirm?.title === 'Remove this agent', 'the confirm stage is titled with the action', JSON.stringify(confirm?.title))
    const confirmRow = rowByLabel(confirm || { rows: [] }, 'Remove')
    const backRow = (confirm?.rows || []).find(row => /Back/.test(row.label))
    check(Boolean(confirmRow), 'the confirm stage offers Remove')
    check(Boolean(backRow), 'the confirm stage offers Back')
    check(
      /^This removes .+ and its saved conversation here\. The signed run records are kept\.$/.test(confirmRow?.sentence || ''),
      'the confirm sentence names the agent, its saved conversation, and what is kept',
      JSON.stringify(confirmRow?.sentence),
    )
    await shoot(window, '03-confirm-stage.png')

    /* LEG 4 — confirmed. */
    const removed = await pressPopupRow(window, 'Remove')
    if (!removed.pressed) { note('FAIL', `the confirm Remove could not be pressed (${removed.why})`); return }
    await delay(1800)
    const circles = readOrThrow(
      await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
      'the canvas after the removal',
    )
    check(!circles.includes(childId), 'the circle is gone from the canvas', circles.join(',') || 'empty')
    check(circles.includes(parentId), 'the parent is untouched')
    const treesAfter = readOrThrow(await window.evaluate(READ_TREES(computerId)), 'the tree record after the removal')
    check(!treesAfter.nodes.some(node => node.id === childId), 'the node is out of the saved tree record')
    const savedAfter = readOrThrow(await window.evaluate(READ_TRANSCRIPTS(computerId)), 'the transcript record after the removal')
    check(!savedAfter.ids.includes(childId), 'the saved conversation went with it', savedAfter.ids.join(',') || 'none')
    const ledgerAfter = readOrThrow(await window.evaluate(READ_LEDGER), 'the signed records after the removal')
    check(ledgerAfter.ok === true && ledgerAfter.verified === true, 'the signed run records still verify', `total=${ledgerAfter.total}`)
    check(ledgerAfter.sessions.includes(childSession), 'the removed agent’s run is still in the signed records')
    const rail = readOrThrow(await window.evaluate(`(() => ({
      stats: Boolean(document.querySelector('.stats-page.is-active')),
      controls: Boolean(document.querySelector('.ctl-page.is-active')),
      status: (document.querySelector('.org-status')?.textContent || '').trim(),
    }))()`), 'the rail after the removal')
    check(rail.stats === true && rail.controls === false, 'the rail returned to the overview')
    check(
      /^Removed .+ and its saved conversation here\. The signed run records are kept\.$/.test(rail.status),
      'the outcome sentence on screen says what went and what stayed',
      JSON.stringify(rail.status),
    )
    await shoot(window, '04-after-removal.png')
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
  }

  if (!computerId || !childId) return

  /* LEG 5 — restart: still gone, no ghost. */
  const again = await openWindow(executable, profile)
  try {
    await computerOnScreen(again)
    await delay(1500)
    const circles = readOrThrow(
      await again.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
      'the canvas after the restart',
    )
    check(!circles.includes(childId), 'the removed node stays gone across a restart', circles.join(',') || 'empty')
    check(circles.includes(parentId), 'the parent survives the restart')
    const trees = readOrThrow(await again.evaluate(READ_TREES(computerId)), 'the tree record after the restart')
    check(!trees.nodes.some(node => node.id === childId), 'no ghost record came back')
    const saved = readOrThrow(await again.evaluate(READ_TRANSCRIPTS(computerId)), 'the transcripts after the restart')
    check(!saved.ids.includes(childId), 'no ghost conversation came back', saved.ids.join(',') || 'none')
    const ledger = readOrThrow(await again.evaluate(READ_LEDGER), 'the signed records after the restart')
    check(ledger.ok === true && ledger.verified === true, 'the signed run records verify after the restart', `total=${ledger.total}`)
    check(ledger.sessions.includes(childSession), 'the removed agent’s run is still on the permanent record')
    await shoot(again, '05-after-restart.png')
  } finally {
    await closeWindow(again)
    reap(again.timeline.pid)
    assertIsolated(profile)
  }
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
  /* The narrating fixture's confinement stub answers from this variable and
     REFUSES when it is unstaged -- the same staging every narrating drive
     carries (tools/chat-history-drive.mjs measured this first). */
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  const scratch = mkdtempSync(path.join(tmpdir(), 'node-remove-drive-'))
  console.log(`staging into ${scratch}`)
  try {
    const { executable, appRoot } = await stage(scratch)
    await drive(executable, scratch, appRoot)
  } finally {
    if (KEEP) console.log(`kept ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  }
  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${findings.filter(f => f.level === 'PASS').length} passed, ${failed.length} failed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
