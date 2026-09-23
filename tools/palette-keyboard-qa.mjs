#!/usr/bin/env node

/* THE ACTIONS POPUP, DRIVEN THE WAY THE OWNER ASKED FOR IT TO WORK.
 *
 * His words on this menu: "this menu needs to be more like vscode, much more
 * intuitive preferably". The substance of VS Code's quick pick is that the
 * keyboard drives everything from the filter box: type to narrow, Up and Down
 * to move, Enter to run, Escape to leave, with the row under the cursor
 * announced to assistive tech. Before this repair the popup's entire keyboard
 * handler was one line for Escape, rows were reachable only by Tab or mouse,
 * and a disabled row would not say why it could not be pressed.
 *
 * So this drives the packaged build with REAL input only -- CDP mouse presses,
 * CDP key events, Input.insertText -- and reads back what the glass says.
 * No el.click(), no dispatchEvent, no synthetic focus.
 *
 * TWO PROFILES.
 *
 *   A (seeded)  two saved tree nodes, one that ran once and one that never
 *               started, written straight into the store the page reads. Every
 *               keyboard behaviour and every disabled reason is measurable
 *               here without an engine.
 *   B (live)    NOTHING seeded. A real Claude agent is started from the tree
 *               with real presses and keystrokes, and the palette is opened
 *               over the RUNNING session: the three restored rows must be
 *               pressable, and Enter on "Queue a message" must land focus in
 *               the composer with the popup closed.
 *
 * WHAT IS DELIBERATELY NOT DRIVEN, SAID PLAINLY. The attach and mention rows
 * end in dialog.showOpenDialog (shell/main.cjs, mc-agent:pick-attachment and
 * mc-agent:pick-mention). That is a NATIVE window: MC_SMOKE_HEADLESS hides
 * only the app's own window (shell/window-options.cjs), so the dialog would
 * open ON THE OWNER'S DESKTOP, and CDP Input events are injected into the web
 * contents, so no key this driver can send reaches a native dialog. Driving
 * those two rows to their cancel sentences therefore needs a shell-side test
 * seam, which is another lane's file. This run proves the rows are pressable
 * and wired to the pickers (part B reads their enabled state on a live agent;
 * tools/test/palette-rows.test.mjs proves the wiring and the cancel sentences
 * as data) and claims nothing further.
 *
 *   node tools/palette-keyboard-qa.mjs
 *   node tools/palette-keyboard-qa.mjs --visible
 *   node tools/palette-keyboard-qa.mjs --seeded-only
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }
/* NEVER the repo root — see home-activity-substance-qa.mjs's SHOTS note: the
   cwd default littered the repository with evidence PNGs and stopped two cut
   attempts at the clean-tree gate. */
const SHOTS = process.env.PALETTE_QA_SHOTS
  || mkdtempSync(path.join(tmpdir(), 'palette-qa-shots-'))
const SEEDED_ONLY = process.argv.includes('--seeded-only')

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (!value || typeof value !== 'object') throw new Error(`the page expression for ${what} answered ${JSON.stringify(value)}`)
  return value
}

async function shoot(window, file) {
  try {
    await window.session.send('Page.setWebLifecycleState', { state: 'active' })
    const shot = await window.session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  shot  ${file}`)
  } catch (error) {
    console.log(`  shot  could not be taken (${error?.message || error}); the readings stand on their own`)
  }
}

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(600)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
  await delay(180)
}
const KEYS = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Home: 36, End: 35 }

async function typeReal(window, selector, text) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await window.session.send('Input.insertText', { text })
  await delay(250)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: typeof landed === 'string' && landed.includes(text.slice(0, 20)), landed }
}

async function chooseByKeyboard(window, selector, wanted) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await key(window, 'Escape', KEYS.Escape)
  for (let step = 0; step < 14; step += 1) {
    const at = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
    if (at === wanted) {
      return { ok: true, label: await window.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n?.options[n.selectedIndex]?.textContent.trim() || '' })()`) }
    }
    await key(window, 'ArrowDown', KEYS.ArrowDown)
  }
  return { ok: false, why: `never reached ${wanted}` }
}

/* Everything the popup is saying right now, off the DOM and nothing else. */
const READ_POP = `(() => {
  const pop = document.querySelector('.chat-actions-pop')
  if (!pop) return { open: false }
  const filter = pop.querySelector('.chat-actions-filter')
  const list = pop.querySelector('.chat-actions-list')
  const rows = [...pop.querySelectorAll('.chat-actions-row')].map(row => ({
    id: row.id,
    role: row.getAttribute('role'),
    label: (row.querySelector('div')?.textContent || row.textContent || '').trim().slice(0, 60),
    hint: (row.querySelector('.chat-actions-hint')?.textContent || '').trim().slice(0, 90),
    why: row.querySelector('.chat-actions-why') !== null,
    disabled: row.disabled === true,
    active: row.classList.contains('is-active'),
    selected: row.getAttribute('aria-selected'),
  }))
  return {
    open: true,
    filter: filter ? {
      role: filter.getAttribute('role'),
      controls: filter.getAttribute('aria-controls'),
      activedescendant: filter.getAttribute('aria-activedescendant'),
      focused: document.activeElement === filter,
      value: filter.value,
      hidden: filter.hidden === true,
    } : null,
    list: list ? { id: list.id, role: list.getAttribute('role') } : null,
    headings: [...pop.querySelectorAll('.chat-actions-group')].map(h => ({
      text: (h.textContent || '').trim(), role: h.getAttribute('role'),
    })),
    rows,
    out: (pop.querySelector('.chat-actions-out')?.textContent || '').trim(),
  }
})()`

const activeRow = state => (Array.isArray(state.rows) ? state.rows : []).find(row => row.active) || null

/* ================================================================== A ==== */

const NODES = [
  {
    key: 'ran',
    sessionId: 'chat-palette-1111-2222-3333-444444444444',
    status: 'finished',
    role: 'coordinator',
    message: 'Summarise the build log in three lines.',
    reply: 'Two steps passed and the packaging step was skipped.',
  },
  {
    key: 'never',
    sessionId: null,
    status: 'failed',
    role: 'worker',
    message: '',
    reply: '',
  },
]

/* WHAT THE RAIL WAS SHOWING WHEN THE DOOR WAS NOT THERE. `press` says
   'hidden' whenever the button's computed style says so, and visibility is
   INHERITED: every rail page except the active one is `visibility: hidden`
   (src/tree-graph.css .rail-page), so a button inside an inactive controls
   page reports 'hidden' even though nothing hid the button itself. This
   names the page that WAS active, so a red says which surface the product
   was on instead of leaving the reader to guess. */
async function doorDiagnostics(window, nodeId = null) {
  const diag = await window.evaluate(`(() => {
    const btn = document.querySelector('[data-rail-chat-host] [data-chat-actions]')
    const s = btn ? getComputedStyle(btn) : null
    const active = document.querySelector('.computers .rail-page.is-active')
    const title = active ? (active.querySelector('.rail-title')?.textContent || '').trim() : null
    const body = btn ? btn.closest('[data-rail-body]') : null
    return {
      btnExists: !!btn,
      btn: s ? { display: s.display, visibility: s.visibility, opacity: s.opacity } : null,
      activeRailPage: active ? active.className : 'none',
      activeRailTitle: title,
      chatBodyHidden: body ? body.hidden === true : null,
      tabOn: document.querySelector('[data-rail-tab].on')?.dataset.railTab || null,
      selected: window.__mcGraph?.selectedId ?? null,
      statusChip: ${JSON.stringify(nodeId)} ? (document.querySelector('.node[data-agent-id="' + ${JSON.stringify(nodeId)} + '"] .node-role')?.textContent || '').trim() : null,
    }
  })()`)
  return JSON.stringify(diag)
}

/* THE DOOR, PRESSED THE WAY A PERSON PRESSES IT -- including pressing the
 * circle again when the product changes the page underneath the gesture.
 *
 * MEASURED, 2026-08-19, with the diagnostics above, on BOTH sides of the
 * re-cut window: the fleet projection re-apply path ends in showStats()
 * (src/views/computers.js), and when a re-read lands between this driver's
 * circle press and its door press -- which the record written by the agent
 * start makes likely, and machine load decides -- the rail is back on
 * "Fleet overview", every inactive rail page is visibility:hidden
 * (src/tree-graph.css), and the door reports hidden for the full wait.
 * Signature, verbatim from a red run at tree a3e9f85 (the previously GREEN
 * confirming tree) and again at 0485034: activeRailPage="rail-page
 * stats-page is-active", btn.visibility="hidden", the node still selected.
 * One race, two trees, red on whichever side the machine was busier for --
 * that is the weather, not the product's delta.
 *
 * SO THE INSTRUMENT DOES WHAT A PERSON DOES: sees the overview, presses the
 * agent's circle again, and goes back through the door. Same policy this
 * driver already applies to the SAME lifecycle event when it closes the
 * popup (the reopen path below). The flip itself stays in the output as an
 * info line -- absorbed silently it would stop being a finding. ANY OTHER
 * hidden door -- controls page active but the button dark, the button gone --
 * still fails here, with the diagnostics naming what was on the glass. */
async function pressActionsDoor(window, circleSelector) {
  let flips = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const door = await press(window, '[data-rail-chat-host] [data-chat-actions]')
    if (door.pressed) return { pressed: true, flips }
    const diag = await window.evaluate(`(() => {
      const btn = document.querySelector('[data-rail-chat-host] [data-chat-actions]')
      const s = btn ? getComputedStyle(btn) : null
      const active = document.querySelector('.computers .rail-page.is-active')
      return {
        overview: Boolean(active && active.classList.contains('stats-page')),
        doorParked: Boolean(btn && s && s.display !== 'none' && s.visibility === 'hidden'),
      }
    })()`)
    if (!(diag && diag.overview && diag.doorParked)) {
      return { pressed: false, why: door.why, flips }
    }
    flips += 1
    const circle = await press(window, circleSelector)
    if (!circle.pressed) return { pressed: false, why: `the circle was not pressable on re-entry (${circle.why})`, flips }
    await delay(900)
  }
  return { pressed: false, why: 'the rail kept leaving for the overview', flips }
}

async function openPaletteOn(window, nodeKey) {
  await key(window, 'Escape', KEYS.Escape)
  await delay(500)
  const circle = await press(window, `.node[data-agent-id="node-palette-${nodeKey}"]`)
  if (!circle.pressed) return { ok: false, why: `the circle was not pressable (${circle.why})` }
  await delay(900)
  const door = await pressActionsDoor(window, `.node[data-agent-id="node-palette-${nodeKey}"]`)
  if (!door.pressed) return { ok: false, why: `the actions button was not pressable (${door.why})` }
  if (door.flips > 0) note('info', `the fleet re-read took the rail back to the overview mid-gesture (showStats on projection apply); pressed the circle again the way a person would (${door.flips}x)`)
  await delay(400)
  const state = readOrThrow(await window.evaluate(READ_POP), 'the popup')
  return state.open ? { ok: true, state } : { ok: false, why: 'the popup did not open' }
}

async function seededRun() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'palette-kb-qa-'))
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1000)
    await window.evaluate(`location.reload()`)
    await delay(3800)
    const computerId = await window.evaluate(`window.__mcGraph?.computer?.id || null`)
    if (!computerId) { note('FAIL', 'HARNESS STATE: no computer on the page; nothing below is a measurement.'); return }

    const stamp = new Date().toISOString()
    const record = {
      version: 1,
      computerId,
      trees: [{ id: 'tree-palette-qa', name: 'Palette', createdAt: stamp, updatedAt: stamp, profileId: null }],
      nodes: NODES.map((seed, index) => ({
        id: `node-palette-${seed.key}`,
        treeId: 'tree-palette-qa',
        parentId: index === 0 ? null : 'node-palette-ran',
        role: seed.role,
        message: seed.message,
        status: seed.status,
        statusNote: seed.status === 'failed' ? 'The packaging step refused to run.' : '',
        reply: seed.reply,
        tier: 'claude-sonnet',
        sessionId: seed.sessionId,
        createdAt: stamp,
        updatedAt: stamp,
      })),
    }
    await window.evaluate(`localStorage.setItem(${JSON.stringify(`mc.fleet.trees.v1:${computerId}`)}, ${JSON.stringify(JSON.stringify(record))})`)
    await window.evaluate(`location.reload()`)
    await delay(4200)

    console.log('\n[A1] the popup announces itself: combobox over listbox, grouped, reasons visible')
    const opened = await openPaletteOn(window, 'ran')
    if (!opened.ok) { note('FAIL', `HARNESS STATE: ${opened.why}`); return }
    let state = opened.state
    note(state.filter?.role === 'combobox' ? 'ok' : 'FAIL', `the filter is a combobox: role=${JSON.stringify(state.filter?.role)}`)
    note(state.list?.role === 'listbox' && state.filter?.controls === state.list?.id ? 'ok' : 'FAIL',
      `it names the list it controls: aria-controls=${JSON.stringify(state.filter?.controls)} list id=${JSON.stringify(state.list?.id)}`)
    note(state.filter?.focused === true ? 'ok' : 'FAIL', 'the filter has focus the moment the popup opens')
    note(state.rows.every(row => row.role === 'option') ? 'ok' : 'FAIL', `every row is an option (${state.rows.length} rows)`)
    note(state.headings.length === 3 && state.headings.every(h => h.role === 'presentation') ? 'ok' : 'FAIL',
      `three group headings, none of them an option: ${JSON.stringify(state.headings.map(h => h.text))}`)
    note(state.headings[2] && /stop or start over/i.test(state.headings[2].text) ? 'ok' : 'FAIL',
      'the group that ends or forgets something is last')
    const stopRow = state.rows.find(row => /^Stop this agent/.test(row.label))
    note(stopRow && stopRow.disabled && stopRow.why && /not running/i.test(stopRow.hint) ? 'ok' : 'FAIL',
      `a disabled row shows its reason in place of its hint: ${JSON.stringify(stopRow?.hint)}`)
    const first = activeRow(state)
    note(first && state.filter?.activedescendant === first.id ? 'ok' : 'FAIL',
      `the active row is announced: aria-activedescendant=${JSON.stringify(state.filter?.activedescendant)} on ${JSON.stringify(first?.label)}`)
    await shoot(window, path.join(SHOTS, 'palette-open.png'))

    console.log('\n[A2] type to filter, arrows to move, and the announcement follows')
    await window.session.send('Input.insertText', { text: 'copy' })
    await delay(400)
    state = readOrThrow(await window.evaluate(READ_POP), 'the filtered popup')
    note(state.filter?.value === 'copy' ? 'ok' : 'FAIL', `typing landed in the filter: ${JSON.stringify(state.filter?.value)}`)
    note(state.rows.length === 2 && state.rows.every(row => /^Copy/.test(row.label)) ? 'ok' : 'FAIL',
      `the rows narrowed to the two copy actions: ${JSON.stringify(state.rows.map(row => row.label))}`)
    const before = activeRow(state)
    note(before && /Copy what you asked for/.test(before.label) ? 'ok' : 'FAIL',
      `the cursor sits on the first enabled match: ${JSON.stringify(before?.label)}`)
    await key(window, 'ArrowDown', KEYS.ArrowDown)
    state = readOrThrow(await window.evaluate(READ_POP), 'after ArrowDown')
    const afterDown = activeRow(state)
    note(afterDown && /Copy what it said/.test(afterDown.label) && state.filter?.activedescendant === afterDown.id ? 'ok' : 'FAIL',
      `ArrowDown moved the cursor and the announcement: ${JSON.stringify(afterDown?.label)} ${JSON.stringify(state.filter?.activedescendant)}`)
    note(afterDown && afterDown.selected === 'true' && before && state.rows.find(r => r.id === before.id)?.selected === 'false' ? 'ok' : 'FAIL',
      'aria-selected follows the cursor')
    await key(window, 'ArrowUp', KEYS.ArrowUp)
    state = readOrThrow(await window.evaluate(READ_POP), 'after ArrowUp')
    note(activeRow(state) && /Copy what you asked for/.test(activeRow(state).label) ? 'ok' : 'FAIL', 'ArrowUp moved it back')
    await shoot(window, path.join(SHOTS, 'palette-filtered.png'))

    console.log('\n[A3] Enter runs the active row, entirely from the keyboard')
    await key(window, 'Enter', KEYS.Enter)
    await delay(600)
    state = readOrThrow(await window.evaluate(READ_POP), 'after Enter')
    /* The copy verb really ran: the status line carries one of its two honest
       outcomes. Which one depends on whether the offscreen window may write
       the clipboard, and both prove the press reached the runner. */
    note(/^Copied\.$|clipboard refused/i.test(state.out) ? 'ok' : 'FAIL',
      `Enter ran Copy what you asked for and the status line answered: ${JSON.stringify(state.out)}`)

    console.log('\n[A4] Enter on a disabled row speaks the reason instead of doing nothing')
    await key(window, 'Escape', KEYS.Escape)
    await delay(400)
    const reopened = await openPaletteOn(window, 'ran')
    if (!reopened.ok) { note('FAIL', `HARNESS STATE: ${reopened.why}`); return }
    await window.session.send('Input.insertText', { text: 'interrupt' })
    await delay(400)
    state = readOrThrow(await window.evaluate(READ_POP), 'the interrupt filter')
    note(state.rows.length === 1 && state.rows[0].disabled ? 'ok' : 'FAIL',
      `the one match is the disabled Interrupt row: ${JSON.stringify(state.rows.map(row => row.label))}`)
    await key(window, 'Enter', KEYS.Enter)
    state = readOrThrow(await window.evaluate(READ_POP), 'after Enter on disabled')
    note(/not running/i.test(state.out) ? 'ok' : 'FAIL',
      `the status line says WHY instead of staying silent: ${JSON.stringify(state.out)}`)
    note(state.open === true ? 'ok' : 'FAIL', 'and the popup stays open, because nothing ran')

    console.log('\n[A5] Escape closes; the never-started node names its own state')
    await key(window, 'Escape', KEYS.Escape)
    await delay(400)
    state = readOrThrow(await window.evaluate(READ_POP), 'after Escape')
    note(state.open === false ? 'ok' : 'FAIL', 'Escape closed the popup')
    const never = await openPaletteOn(window, 'never')
    if (!never.ok) { note('FAIL', `HARNESS STATE: ${never.why}`); return }
    state = never.state
    const attach = state.rows.find(row => /^Attach an image/.test(row.label))
    const brief = state.rows.find(row => /^Copy what you asked for/.test(row.label))
    note(attach && attach.disabled && /has not started/i.test(attach.hint) ? 'ok' : 'FAIL',
      `attach on a never-started agent says the agent has not started: ${JSON.stringify(attach?.hint)}`)
    note(brief && brief.disabled && /nothing was asked/i.test(brief.hint) ? 'ok' : 'FAIL',
      `copy-brief on a node with no brief says so: ${JSON.stringify(brief?.hint)}`)
    note(state.rows.filter(row => row.disabled).every(row => row.hint.length > 0) ? 'ok' : 'FAIL',
      'every disabled row on this node carries a reason')
    await shoot(window, path.join(SHOTS, 'palette-disabled-reasons.png'))
    await key(window, 'Escape', KEYS.Escape)
  } finally {
    if (window) { await closeWindow(window).catch(() => {}); reap(window.timeline?.pid) }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* outlives the run */ }
  }
}

/* ================================================================== B ==== */

const LIVE_PROMPT = 'Write the single word Kestrel on the first line, then count from 1 to 400, one number per line. Do not say anything else.'

const SIGN_IN_FS = { cpSync, existsSync, mkdirSync, statSync, symlinkSync }

export function lendClaudeSignIn(scratch, fs = SIGN_IN_FS) {
  const realHome = process.env.USERPROFILE || ''
  const credential = path.join(realHome, '.claude', '.credentials.json')
  try {
    fs.statSync(credential)
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') {
      return { ok: false, code: 'CLAUDE_CREDENTIAL_ABSENT' }
    }
    return {
      ok: false,
      code: 'CLAUDE_CREDENTIAL_CHECK_FAILED',
      causeCode: error instanceof Error && typeof error.code === 'string' ? error.code : null,
      message: 'Could not check the Claude sign-in; this is NOT claiming the credential is absent.',
    }
  }
  const scratchClaude = path.join(scratch, 'home', '.claude')
  fs.mkdirSync(scratchClaude, { recursive: true })
  fs.cpSync(credential, path.join(scratchClaude, '.credentials.json'))
  const settings = path.join(realHome, '.claude.json')
  if (fs.existsSync(settings)) fs.cpSync(settings, path.join(scratch, 'home', '.claude.json'))
  const realNpm = path.join(process.env.APPDATA || '', 'npm')
  if (fs.existsSync(realNpm)) {
    fs.mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
    try { fs.symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* linked */ }
  }
  return { ok: true, code: 'CLAUDE_CREDENTIAL_LENT' }
}

async function liveRun() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'palette-kb-live-'))
  let window = null
  try {
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    const signIn = lendClaudeSignIn(scratch)
    if (!signIn.ok && signIn.code === 'CLAUDE_CREDENTIAL_ABSENT') {
      note('FAIL', 'HARNESS STATE: this computer has no Claude sign-in to lend, so the live half was not measured.')
      return
    }
    if (!signIn.ok) {
      note('FAIL', `HARNESS STATE: ${signIn.message} code=${signIn.causeCode || 'UNKNOWN'}; the live half was not measured.`)
      return
    }
    window = await openWindow(staged.executable, scratch)
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3600)

    console.log('\n[B1] a real agent, started from the tree with real input')
    let availability = 'null'
    const ready = Date.now() + 30_000
    for (;;) {
      availability = await window.evaluate(`window.mcAgent ? window.mcAgent.availability().then(r => JSON.stringify(r)) : 'null'`)
      if (String(availability).includes('"ok":true') || Date.now() > ready) break
      await delay(1500)
    }
    if (!String(availability).includes('"ok":true')) {
      note('FAIL', `HARNESS STATE: no agent can start here (${availability}); the live half was not measured.`)
      return
    }
    const doorway = await press(window, '.computers .tree-empty-node')
    if (!doorway.pressed) { note('FAIL', `HARNESS STATE: no way into the start panel (${doorway.why})`); return }
    await delay(2400)
    const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', 'claude-sonnet')
    note(tier.ok ? 'ok' : 'FAIL', `chose claude-sonnet with real arrow keys: ${tier.ok ? JSON.stringify(tier.label) : tier.why}`)
    if (!tier.ok) return
    const firstRole = await window.evaluate(`(() => {
      const node = document.querySelector('[data-compose-field="role"]')
      return node ? ([...node.options].map(o => o.value).find(v => v && v.length > 0) || null) : null
    })()`)
    if (!firstRole) { note('FAIL', 'HARNESS STATE: no role menu'); return }
    const role = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
    if (!role.ok) { note('FAIL', `HARNESS STATE: no role chosen (${role.why})`); return }
    const typed = await typeReal(window, '[data-compose-field="message"]', LIVE_PROMPT)
    note(typed.ok ? 'ok' : 'FAIL', 'typed the brief with real keystrokes')
    if (!typed.ok) return
    const startSelector = await window.evaluate(`(() => {
      const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
        return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
      if (!btn) return null
      if (!btn.id) btn.id = 'palette-live-start'
      return '#' + btn.id
    })()`)
    if (!startSelector) { note('FAIL', 'HARNESS STATE: no Start control'); return }
    const started = await press(window, startSelector)
    note(started.pressed ? 'ok' : 'FAIL', 'pressed Start')
    if (!started.pressed) return
    await delay(2500)

    console.log('\n[B2] the palette over the RUNNING agent: the three restored rows are pressable')
    /* The circle for the node the start just created: the newest node on the
       canvas. Its id is minted by the store, so it is read off the glass. */
    const nodeId = await window.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.node[data-agent-id]')]
      return nodes.length ? nodes[nodes.length - 1].dataset.agentId : null
    })()`)
    if (!nodeId) { note('FAIL', 'HARNESS STATE: the started agent has no circle on the canvas'); return }
    await key(window, 'Escape', KEYS.Escape)
    await delay(400)
    const circle = await press(window, `.node[data-agent-id="${nodeId}"]`)
    if (!circle.pressed) { note('FAIL', `HARNESS STATE: the circle was not pressable (${circle.why})`); return }
    await delay(1000)
    /* THE RAIL REBUILDS ITSELF WHILE A SESSION SETTLES. showTreeNodeControls
       is called again for the node in the rail when its session opens and when
       its status lands (src/views/computers.js:5704, :5720), and the rebuilt
       chat's dispose closes the popup. Measured twice on this driver: a popup
       opened during the starting-to-running transition was gone within half a
       second, pressed and confirmed open and then not there to read. A person
       who opens this menu the moment they start an agent loses it the same
       way. Reported to the rail's owner as a finding; this measurement is
       about the KEYBOARD, so it retries after the transition instead of
       failing over a lifecycle event it does not own. */
    let state = null
    let lost = 0
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const door = await pressActionsDoor(window, `.node[data-agent-id="${nodeId}"]`)
      if (!door.pressed) {
        note('FAIL', `HARNESS STATE: the actions button was not pressable (${door.why}) :: ${await doorDiagnostics(window, nodeId)}`)
        return
      }
      if (door.flips > 0) note('info', `the fleet re-read took the rail back to the overview mid-gesture (showStats on projection apply); pressed the circle again the way a person would (${door.flips}x)`)
      await delay(700)
      state = readOrThrow(await window.evaluate(READ_POP), 'the live popup')
      if (state.open) break
      lost += 1
      await delay(2500)
    }
    note('ok', 'pressed the actions button on the live chat')
    if (lost > 0) {
      note('info', `the rail rebuild took the popup ${lost} time(s) before it stayed up (src/views/computers.js:5704/:5720) -- a person opening this menu right as their agent starts loses it the same way`)
    }
    if (!state.open) { note('FAIL', 'the popup never stayed open over the live agent'); return }
    for (const label of ['Queue a message', 'Attach an image', 'Mention a file']) {
      const row = state.rows.find(r => r.label.startsWith(label))
      note(row && !row.disabled ? 'ok' : 'FAIL',
        `${JSON.stringify(label)} is on the menu and pressable over a running agent${row ? '' : ' -- THE ROW IS MISSING'}`)
    }
    const interrupt = state.rows.find(r => /^Interrupt/.test(r.label))
    /* "WHILE THE TURN RUNS" IS A PREMISE, AND THE PREMISE CAN LAPSE. This read
       lands seconds after Start -- more seconds when the rail-flip retry above
       fired, or when the machine is churning under the whole suite -- and a
       short turn (or one the provider refuses over quota) is OVER by then, the
       store honestly says so, and Interrupt is honestly disabled. MEASURED
       twice under a deterministic rail flip and once in the 2026-08-19
       confirming suite: the row read disabled with the node's stored status
       'finished' -- a completed turn, not a broken control. So a disabled row
       is judged against the store: a turn still on record as running with
       Interrupt dark is the product defect this check exists for and still
       fails; a turn that genuinely ended before the read is named as harness
       state, because nothing about the product was measured. */
    if (interrupt && !interrupt.disabled) {
      note('ok', 'Interrupt is pressable while the turn runs')
    } else {
      const storedStatus = await window.evaluate(`(() => {
        const cid = window.__mcGraph?.computer?.id || null
        try {
          const rec = JSON.parse(localStorage.getItem('mc.fleet.trees.v1:' + cid) || 'null')
          const node = rec && rec.nodes.find(n => n.id === ${JSON.stringify(nodeId)})
          return node ? node.status : null
        } catch { return null }
      })()`)
      const turnOver = storedStatus === 'finished' || storedStatus === 'turn-failed' || storedStatus === 'interrupted'
      if (turnOver) {
        note('info', `HARNESS STATE: the turn ended (stored status ${JSON.stringify(storedStatus)}) before this read, so Interrupt-while-running was not measured this run`)
      } else {
        note('FAIL', `Interrupt is pressable while the turn runs :: row=${JSON.stringify(interrupt || null)} storedStatus=${JSON.stringify(storedStatus)}`)
      }
    }
    await shoot(window, path.join(SHOTS, 'palette-live.png'))

    console.log('\n[B3] Enter on "Queue a message": the popup gets out of the way and the composer takes focus')
    /* THE RAIL REBUILDS ITSELF ON SESSION EVENTS while a turn is settling --
       showTreeNodeControls is called again for the node in the rail when its
       session opens or its status lands (src/views/computers.js:5704, :5720),
       and the rebuilt chat's dispose closes the popup. Observed on this run:
       the popup opened in [B2] was gone by the time this step read it. A
       person mid-word in the filter would lose the popup the same way; noted
       for the rail's owner, and this driver reopens rather than failing a
       keyboard measurement over a lifecycle event it does not own. */
    state = readOrThrow(await window.evaluate(READ_POP), 'the popup before the queue step')
    if (!state.open) {
      note('info', 'the rail rebuilt itself on a session event and took the popup with it (src/views/computers.js:5704/:5720); reopened to continue the keyboard measurement')
      const again = await pressActionsDoor(window, `.node[data-agent-id="${nodeId}"]`)
      if (!again.pressed) { note('FAIL', `HARNESS STATE: the actions button was not pressable on reopen (${again.why}) :: ${await doorDiagnostics(window, nodeId)}`); return }
      if (again.flips > 0) note('info', `the fleet re-read took the rail back to the overview mid-gesture (showStats on projection apply); pressed the circle again the way a person would (${again.flips}x)`)
      await delay(400)
    }
    await window.session.send('Input.insertText', { text: 'queue' })
    await delay(400)
    state = readOrThrow(await window.evaluate(READ_POP), 'the queue filter')
    if (!state.open) { note('FAIL', 'the popup closed again before the queue row could be reached'); return }
    const queueActive = activeRow(state)
    note(queueActive && /^Queue a message/.test(queueActive.label) ? 'ok' : 'FAIL',
      `typing queue put the cursor on the queue row: ${JSON.stringify(queueActive?.label)}`)
    await key(window, 'Enter', KEYS.Enter)
    await delay(800)
    const after = readOrThrow(await window.evaluate(`(() => ({
      open: Boolean(document.querySelector('.chat-actions-pop')),
      composerFocused: Boolean(document.activeElement
        && document.activeElement.matches('[data-rail-chat-host] .chat-input input')),
    }))()`), 'after Enter on queue')
    note(after.open === false ? 'ok' : 'FAIL', 'the popup closed')
    note(after.composerFocused === true ? 'ok' : 'FAIL', 'and the message box has focus, ready to queue')
    await shoot(window, path.join(SHOTS, 'palette-queue-focus.png'))

    note('info', 'NOT DRIVEN, by design: pressing Attach or Mention opens a native file dialog (shell/main.cjs, mc-agent:pick-attachment / mc-agent:pick-mention). MC_SMOKE_HEADLESS hides only the app window, so that dialog would open on the real desktop, and CDP keys are injected into the page, never into a native dialog. The wiring and both cancel sentences are proven as data by tools/test/palette-rows.test.mjs.')

    /* The agent is left to finish or be reaped with the window; nothing here
       depends on the turn's outcome. */
  } finally {
    if (window) { await closeWindow(window).catch(() => {}); reap(window.timeline?.pid) }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* outlives the run */ }
  }
}

async function main() {
  await seededRun()
  if (!SEEDED_ONLY) await liveRun()
  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
    process.exitCode = 2
  })
}
