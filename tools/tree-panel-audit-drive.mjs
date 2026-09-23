#!/usr/bin/env node

/* THE RIGHT PANEL ON PAGE 2, PHOTOGRAPHED IN EVERY STATE, BEFORE ANYONE
 * SIMPLIFIES IT.
 *
 * The owner, tonight (2026-08-19): "ther right panel on page 2 is still so
 * complicated i think its in there maybe somewhere." The half-sentence in the
 * middle is about the folder feature — he suspects folder-picking exists
 * somewhere in the panel and cannot find it. That suspicion is itself the
 * finding this drive exists to make concrete: BEFORE any editing, capture the
 * panel in each of its states on the staged packaged build, with an inventory
 * of every control a person could press, so the simplification that follows
 * argues from photographs and readings rather than from the source.
 *
 * AUDIT ONLY. This file changes nothing in the product and asserts almost
 * nothing: it records. The one hard failure is a state that cannot be REACHED
 * by real presses, because a state the drive cannot reach is a state the
 * person cannot reach, and that is a finding of the loudest kind.
 *
 * States, in the order a person meets them:
 *   1  overview          the fleet rail, nothing selected
 *   2  compose           press an empty circle; whatever the panel says first
 *                        (on a fresh profile that is the switched-off notice
 *                        with its in-panel switch — pressed here, the real path)
 *   3  chat              a node with a running agent (narrating fixture), its
 *                        Chat tab, shot mid-turn and again when the turn ends
 *   4  actions popup     the verbs behind the chat composer's actions button
 *   5  details           the Details tab: facts, conversation, Setup (folder,
 *                        Reports to), start-work controls
 *   6  roles             the overview rail's Roles section and its editor
 *   7  widths            overview + details re-shot at 1024 and 1920 wide
 *
 * Navigation is BY CLICKING (#nav-next), never location.hash; auditSelf()
 * fails the run if a hash assignment ever creeps in. Staging, isolation and
 * input discipline are tools/test-account-harness.mjs's (scratch copy of
 * release/win-unpacked, never the installed app, never NSIS; sterile profile).
 *
 *   node tools/tree-panel-audit-drive.mjs [--visible] [--keep]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  argument,
  assertIsolated,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { createChatPresser } from './lib/chat-drive-lib.mjs'
/* The panel's own words, so this drive asserts against the copy the product
   ships rather than against a phrase typed into a harness. Importable because
   src/tree-standing-requests.js deliberately has no DOM and no stylesheet. */
import { REQUEST_PANEL } from '../src/tree-standing-requests.js'

const KEEP = process.argv.includes('--keep')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SELF = fileURLToPath(import.meta.url)
const NARRATING_ENGINE = path.join(REPO, 'tools/test/fixtures/narrating-engine/src/lib/agent-engine/codex-process.js')
/* WHERE THE PHOTOGRAPHS LAND, AND WHY IT IS NOW A FLAG (2026-08-23). The
   default is unchanged: reports/tree-panel-audit, beside the report they were
   taken for. What changed is that this driver joined
   tools/packaged-qa-suite.mjs, and release:cut runs that suite and then
   requires `git status --porcelain` to be EMPTY before `npm run dist`.
   reports/tree-panel-audit is TRACKED, so a gate re-running here would modify
   committed evidence and fail the cut on output the gate itself had just
   produced. The suite passes `--out` into a scratch directory. Same flag, same
   reason, same spelling as tools/context-window-drive.mjs. */
const OUT = path.resolve(argument('--out', path.join(REPO, 'reports', 'tree-panel-audit')))

const findings = []
const note = (level, text) => {
  findings.push({ level, text })
  if (level === 'FAIL') process.exitCode = 1
  console.log(`  ${level.padEnd(5)} ${text}`)
}

function auditSelf() {
  return readFileSync(SELF, 'utf8')
    .split('\n')
    .filter(line => /location\.hash\s*=[^=]/.test(line))
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !line.includes('auditSelf'))
}

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

/* Evidence, never a measurement (pattern measured by node-remove-drive:
   lifecycle first or a headless window never services the frame; a deadline
   or one stuck capture hangs the run after its checks already passed). */
const SHOT_DEADLINE_MS = 12_000
const withDeadline = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms}ms`)), ms)),
])

async function shoot(window, name) {
  try {
    mkdirSync(OUT, { recursive: true })
    await withDeadline(window.session.send('Page.setWebLifecycleState', { state: 'active' }), SHOT_DEADLINE_MS, 'the lifecycle change')
    /* MEASURED ON THIS RUN, twice: with the lifecycle active, captures right
       after an evaluate-driven scroll still never answered — the compositor
       had produced no frame since the state change, and captureScreenshot
       waits for one. rAFs alone were NOT enough (8 of 11 still hung); a real
       input event is what reliably wakes the headless compositor, so a
       harmless 1px mouse move is dispatched first, then the frames. */
    let shot = null
    for (let attempt = 0; attempt < 2 && !shot; attempt += 1) {
      try {
        await window.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4 + attempt, y: 4, button: 'none' })
        await withDeadline(
          window.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))'),
          SHOT_DEADLINE_MS, 'the paint nudge',
        )
        shot = await withDeadline(window.session.send('Page.captureScreenshot', { format: 'png' }), SHOT_DEADLINE_MS, 'the capture')
      } catch (error) {
        if (attempt === 1) throw error
      }
    }
    const file = path.join(OUT, name)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  shot  ${file}`)
    return file
  } catch (error) {
    console.log(`  shot  ${name} could not be taken (${error?.message || error})`)
    return null
  }
}

/* ------------------------------------------------------------- pressing -- */

/* B-POOL-6 MIGRATION (API decision doc §6, step 2 of 5): NOT byte-
   identical to chat-history-drive.mjs's own original -- two small, real
   differences, named rather than smoothed over. (1) This file's press()
   returned bare {pressed: true} with no `.at` at all (the other three
   step-2 files carried {x,y} nobody read); the shared adapter returns
   {pressed: true, at: {}}, adding a field this file never had -- grepped
   first, nothing here reads `.at`, so the addition is inert. (2) This
   file's key() settled 400ms after a key event, not 500ms like the other
   three step-2 files and the origin -- unified onto the shared module's
   500ms (the value chat-drive-lib.mjs standardised on from the origin driver
   and three of its four copies) rather than parameterising the module for
   a 100ms difference nothing in this file's own history explains. Same
   one named reachability change as every other step-2 file: FLEET_NODE_
   VISIBLE's ancestor-opacity walk over this harness's own window.
   waitForVisible/VISIBLE_FN. */
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
    if ((await valueNow()) === wanted) return { ok: true }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${JSON.stringify(wanted)} in ${maxPresses} presses` }
}

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

/* --------------------------------------------------------- the inventory -- */

/* Every control and section heading inside a container, with the same
   geometric standard the harness presses by: box, viewport, and
   elementFromPoint. "present" in this report never means merely "in the DOM";
   a control the point test cannot reach is recorded as unreachable, which is
   the exact distinction the findability complaint is about. */
const INVENTORY_FN = `(containerSelector) => {
  const container = document.querySelector(containerSelector)
  if (!container) return { absent: true }
  const seen = []
  const visibleState = (node) => {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
    /* The harness's own standard: an element is measured where a reader would
       have scrolled it to, and the point test then says who actually receives
       a press there. Without the scroll, everything below the fold reads as
       "covered" by whatever happens to sit at the clamped point — the first
       run of this drive reported 53 of 53 controls covered that way. */
    const before = node.getBoundingClientRect()
    const wasBelowFold = before.y < 0 || before.y + before.height > innerHeight
    try { node.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* detached */ }
    const box = node.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
    const x = Math.min(Math.max(box.x + box.width / 2, 0), innerWidth - 1)
    const y = Math.min(Math.max(box.y + box.height / 2, 0), innerHeight - 1)
    const hit = document.elementFromPoint(x, y)
    const receives = hit && (hit === node || node.contains(hit) || (hit.closest && hit.closest('label')?.control === node))
    const coveredBy = receives ? null : (hit ? hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nothing')
    return {
      state: receives ? (wasBelowFold ? 'scroll-to-reach' : 'visible') : 'covered',
      ...(coveredBy ? { coveredBy } : {}),
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    }
  }
  for (const node of container.querySelectorAll('.rail-sec, .board-box-h, button, select, input, textarea, output, [role="button"]')) {
    const kind = node.classList.contains('rail-sec') || node.classList.contains('board-box-h') ? 'heading' : node.tagName.toLowerCase()
    const label = (node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 90)
    const entry = { kind, label, ...visibleState(node) }
    if (node.disabled === true) entry.disabled = true
    if (node.tagName === 'SELECT') entry.options = [...node.options].map(option => option.textContent.trim()).slice(0, 12)
    if (node.hidden) entry.state = 'hidden-attr'
    seen.push(entry)
  }
  /* The element that actually scrolls this content: itself or the nearest
     ancestor with overflow, up to the rail. The first run read .rail, which
     never scrolls, and reported every state as fitting its window. */
  let scroller = container
  for (let node = container; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1) { scroller = node; break }
    if (node.classList.contains('rail')) break
  }
  return {
    controls: seen,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    viewport: { w: innerWidth, h: innerHeight },
  }
}`

async function inventory(window, containerSelector, stateName, record) {
  const read = readOrThrow(
    await window.evaluate(`(${INVENTORY_FN})(${JSON.stringify(containerSelector)})`),
    `the ${stateName} inventory`,
  )
  record[stateName] = { container: containerSelector, ...read }
  if (read.absent) { note('FAIL', `${stateName}: ${containerSelector} is not on the page`); return read }
  const pressables = read.controls.filter(c => c.kind !== 'heading' && c.kind !== 'output')
  const buried = pressables.filter(c => c.state === 'scroll-to-reach').length
  const covered = pressables.filter(c => c.state === 'covered').length
  note('INFO', `${stateName}: ${pressables.length} controls (${buried} below the fold, ${covered} covered), rail ${read.scrollHeight}px tall in a ${read.clientHeight}px window`)
  return read
}

/* ---------------------------------------------------------------- drive -- */

async function clickToComputers(window) {
  for (let step = 0; step < 12; step += 1) {
    const route = await window.evaluate('document.body.dataset.route')
    if (route === 'computers') return true
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') { note('FAIL', `#nav-next would not press (${clicked}) while looking for the computers page`); return false }
    await delay(700)
  }
  note('FAIL', 'twelve presses of #nav-next never landed on the computers page')
  return false
}

async function drive(executable, scratch, appRoot) {
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  const record = {}
  try {
    await delay(2500)
    /* The isolation proof reads what the app WROTE, so it can only run once
       the window is up: the prefs file inside the scratch profile is the
       evidence the run never touched the real user's data directory. */
    assertIsolated(profile)
    if (!(await clickToComputers(window))) return record
    await delay(2500)

    /* -- 1 · overview ---------------------------------------------------- */
    await shoot(window, '01-overview.png')
    await inventory(window, '.computers .rail .stats-page', 'overview', record)

    /* -- 2 · compose ----------------------------------------------------- */
    const empty = await press(window, '.computers .tree-empty-node')
    if (!empty.pressed) {
      note('FAIL', `the empty circle could not be pressed (${empty.why}); the compose states are unreachable`)
      return record
    }
    await delay(1800)
    await shoot(window, '02-compose-first-open.png')
    await inventory(window, '.computers .rail .compose-page', 'compose-first-open', record)

    /* On a profile that never answered setup, the panel carries the switch.
       Pressing it here is the product's own remedy path, driven. */
    const switchState = await window.visibility('[data-compose-unavailable-action="panel"]')
    if (switchState?.state === 'visible') {
      const flipped = await press(window, '[data-compose-unavailable-action="panel"]')
      note(flipped.pressed ? 'INFO' : 'FAIL', flipped.pressed
        ? 'starting was switched off; the in-panel switch was pressed (the product’s own remedy)'
        : `the in-panel start switch would not press (${flipped.why})`)
      await delay(1500)
      await shoot(window, '02b-compose-after-switch.png')
      await inventory(window, '.computers .rail .compose-page', 'compose-ready', record)
    } else {
      record['compose-ready'] = record['compose-first-open']
    }

    /* -- 3 · start a real (fixture) agent, chat tab ----------------------- */
    const offered = readOrThrow(await window.evaluate(`(() => {
      const read = field => {
        const node = document.querySelector('[data-compose-field="' + field + '"]')
        return node ? [...node.options].map(o => o.value).filter(Boolean) : []
      }
      return { tiers: read('tier'), roles: read('role') }
    })()`), 'the compose menus')
    if (!offered.tiers.length || !offered.roles.length) {
      note('FAIL', `the compose panel offers no startable tier or role (${JSON.stringify(offered)}); the running states are unreachable`)
      return record
    }
    const pickedTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', offered.tiers[0])
    if (!pickedTier.ok) { note('FAIL', `could not choose a tier (${pickedTier.why})`); return record }
    const pickedRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
    if (!pickedRole.ok) { note('FAIL', `could not choose a role (${pickedRole.why})`); return record }
    const typed = await typeInto(window, '[data-compose-field="message"]',
      'Say hello, then describe this tree in one sentence.')
    if (!typed.pressed) { note('FAIL', `the brief field would not take focus (${typed.why})`); return record }
    const started = await press(window, '[data-compose-action="start"]')
    if (!started.pressed) { note('FAIL', `Start would not press (${started.why})`); return record }
    await delay(1200)
    await shoot(window, '03-agent-starting.png')
    await delay(4500)
    const circle = await window.waitForVisible('.node[data-agent-id]', 12000)
    if (circle?.state !== 'visible') {
      /* The panel's own words are the finding, not this drive's guess. */
      const said = readOrThrow(await window.evaluate(`(() => ({
        status: (document.querySelector('[data-compose-status]')?.textContent || '').trim(),
        notice: (document.querySelector('[data-compose-notice]')?.textContent || '').trim(),
        problems: [...document.querySelectorAll('[data-compose-problem]')].map(n => n.textContent.trim()).filter(Boolean),
        canvasStatus: (document.querySelector('.org-status')?.textContent || '').trim(),
      }))()`), 'the compose refusal')
      note('FAIL', `the start drew no reachable circle (${circle?.state}); the panel said ${JSON.stringify(said)}`)
      return record
    }
    const pressedCircle = await press(window, '.node[data-agent-id]')
    if (!pressedCircle.pressed) { note('FAIL', `the circle would not press (${pressedCircle.why})`); return record }
    await delay(1500)
    await shoot(window, '04-node-chat.png')
    await inventory(window, '.computers .rail .ctl-page', 'node-chat', record)

    /* -- 4 · the actions popup ------------------------------------------- */
    const actions = await press(window, '[data-rail-chat-host] [data-chat-actions]')
    if (actions.pressed) {
      await delay(600)
      await shoot(window, '05-actions-popup.png')
      const popup = readOrThrow(await window.evaluate(`(() => {
        const pop = document.querySelector('.chat-actions-pop')
        if (!pop) return null
        return [...pop.querySelectorAll('.chat-actions-row')].map(row => ({
          label: (row.querySelector('div')?.textContent || row.textContent || '').trim().slice(0, 60),
          disabled: row.disabled === true,
        }))
      })()`), 'the actions popup rows')
      record['actions-popup'] = { rows: popup }
      note(popup ? 'INFO' : 'FAIL', popup
        ? `actions popup: ${popup.length} verbs (${popup.filter(r => r.disabled).length} disabled)`
        : 'the actions button pressed but no popup appeared')
      await key(window, 'Escape', 27)
    } else {
      note('FAIL', `the chat actions button would not press (${actions.why})`)
    }

    /* -- 5 · the Details tab ---------------------------------------------- */
    const details = await press(window, '[data-rail-tab="details"]')
    if (!details.pressed) { note('FAIL', `the Details tab would not press (${details.why})`); return record }
    await delay(900)
    await shoot(window, '06-node-details-top.png')
    await inventory(window, '.computers .rail .ctl-page', 'node-details', record)
    /* The Setup box is the suspected hiding place of the folder control.
       Scroll it into view the way a reader would and photograph it. */
    await window.evaluate(`document.querySelector('[data-tree-move]')?.scrollIntoView({ block: 'center' })`)
    await delay(600)
    await shoot(window, '07-node-details-setup.png')
    const worksIn = readOrThrow(await window.evaluate(`(() => {
      const select = document.querySelector('[data-tree-profile]')
      if (!select) return null
      return { options: [...select.options].map(o => o.textContent.trim()), value: select.selectedOptions[0]?.textContent.trim() || '' }
    })()`), 'the Works in menu')
    record['works-in'] = worksIn
    note('INFO', worksIn
      ? `the folder control today: a "Works in" menu offering ${JSON.stringify(worksIn.options)}`
      : 'no Works in menu on the Details tab')

    /* -- 5b · the rules this circle carries, WRITTEN THEN READ BACK -------- */
    /* The whole point of the panel: file a real rule through the product's own
       /RequestTree command in the chat box, then prove the rail reads it back.
       Nothing is seeded — the ledger entry this reads is one this drive made
       the product write, through the same path a person uses. */
    const chatTab = await press(window, '[data-rail-tab="chat"]')
    if (!chatTab.pressed) note('FAIL', `the Chat tab would not press (${chatTab.why})`)
    else {
      const RULE = 'Never write outside this folder.'
      const typedRule = await typeInto(window, '[data-rail-chat-host] .chat-input input', `/RequestTree ${RULE}`)
      if (!typedRule.pressed) note('FAIL', `the message box would not take the command (${typedRule.why})`)
      else {
        await key(window, 'Enter', 13)
        await delay(2500)
        const filed = readOrThrow(await window.evaluate(`(() => {
          const notes = [...document.querySelectorAll('[data-rail-chat-host] .msg')]
          return notes.map(n => n.textContent.trim()).filter(Boolean).slice(-3)
        })()`), 'the filing confirmation')
        record['request-filed'] = filed
        const confirmed = filed.some(line => /\bRT\d+\b/.test(line))
        note(confirmed ? 'PASS' : 'FAIL',
          confirmed ? `/RequestTree filed a rule and the chat named its id (${JSON.stringify(filed.slice(-1))})`
            : `/RequestTree did not confirm a filing; the chat last said ${JSON.stringify(filed)}`)
        /* Now the read-back, on the Details tab, by real press. */
        await press(window, '[data-rail-tab="details"]')
        await delay(1200)
        /* The panel is built on mount, so reopen the circle to re-read. */
        await press(window, '.computers .rail-back')
        await delay(600)
        await press(window, '.node[data-agent-id]')
        await delay(1200)
        await press(window, '[data-rail-tab="details"]')
        await delay(1200)
        await window.evaluate(`document.querySelector('[data-requests-slot]')?.scrollIntoView({ block: 'center' })`)
        await delay(600)
        await shoot(window, '05b-standing-requests.png')
        const shown = readOrThrow(await window.evaluate(`(() => {
          const slot = document.querySelector('[data-requests-slot]')
          if (!slot) return null
          const box = slot.getBoundingClientRect()
          const x = Math.min(Math.max(box.x + box.width / 2, 0), innerWidth - 1)
          const y = Math.min(Math.max(box.y + box.height / 2, 0), innerHeight - 1)
          const hit = document.elementFromPoint(x, y)
          return {
            painted: box.width > 0 && box.height > 0,
            reachable: Boolean(hit && slot.contains(hit)),
            words: [...slot.querySelectorAll('.request-words')].map(n => n.textContent.trim()),
            ids: [...slot.querySelectorAll('.request-id')].map(n => n.textContent.trim()),
            text: slot.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400),
          }
        })()`), 'the standing-requests panel')
        record['standing-requests-panel'] = shown
        const readBack = Boolean(shown && shown.painted && shown.reachable && shown.words.includes(RULE))
        note(readBack ? 'PASS' : 'FAIL',
          readBack
            ? `the rail read the rule back where it applies: ${JSON.stringify(shown.words)} ${JSON.stringify(shown.ids)}`
            : `the filed rule did not come back on the rail; the panel said ${JSON.stringify(shown)}`)
        /* Read from the copy module, never retyped here: an assertion that
           quotes a sentence goes red the next time the sentence is improved,
           and that red reads as the product losing the feature. */
        const statesPrecedence = Boolean(shown && shown.text.includes(REQUEST_PANEL.precedence))
        note(statesPrecedence ? 'PASS' : 'FAIL',
          statesPrecedence ? 'the panel states which layer wins, in one sentence'
            : 'the panel does not state the precedence')
      }
    }

    /* -- 6 · the roles editor --------------------------------------------- */
    const back = await press(window, '.computers .rail-back')
    if (back.pressed) {
      await delay(900)
      /* The role editor is a collapsed <details class="role-item"> per role in
         the Role library — the first run's inventory read its textareas as
         "covered", which is exactly how a person meets them: invisible until
         the summary is pressed. Expand the first one the way a person would. */
      const summaryTagged = readOrThrow(await window.evaluate(`(() => {
        const summary = document.querySelector('.computers .rail details.role-item > summary')
        if (!summary) return null
        summary.id = 'tree-panel-audit-role-summary'
        return { label: summary.textContent.trim().slice(0, 60) }
      })()`), 'the first role item summary')
      if (summaryTagged) {
        const pressed = await press(window, '#tree-panel-audit-role-summary')
        note(pressed.pressed ? 'INFO' : 'FAIL', pressed.pressed
          ? `roles: expanded ${JSON.stringify(summaryTagged.label)}`
          : `roles: ${JSON.stringify(summaryTagged.label)} would not press (${pressed.why})`)
        await delay(900)
        await shoot(window, '08-role-editor.png')
        await inventory(window, '.computers .rail .stats-page', 'role-editor', record)
      } else {
        note('INFO', 'roles: no role-item details on this fresh profile')
        await shoot(window, '08-roles-section.png')
      }
    } else {
      note('FAIL', `the rail back button would not press (${back.why})`)
    }

    /* -- 7 · widths: the owner's bar is CLEAN AT 1024-1920 ----------------- */
    for (const width of [1024, 1440, 1920]) {
      await window.session.send('Emulation.setDeviceMetricsOverride', {
        width, height: 800, deviceScaleFactor: 1, mobile: false,
      })
      await delay(900)
      await shoot(window, `09-overview-${width}.png`)
      await inventory(window, '.computers .rail .stats-page', `overview-${width}`, record)
      /* The panel has to EXIST at this width: the rail on screen, beside the
         canvas, in a page that does not scroll sideways. Before 2026-08-20
         the 1024 reading was a rail stacked entirely below the fold. */
      const layout = readOrThrow(await window.evaluate(`(() => {
        const rail = document.querySelector('.computers .rail')
        const canvas = document.querySelector('.computers .graph-wrap')
        if (!rail || !canvas) return null
        const r = rail.getBoundingClientRect(), c = canvas.getBoundingClientRect()
        return {
          rail: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          canvas: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) },
          railOnScreen: r.width > 0 && r.x < innerWidth && r.y < innerHeight && r.y + r.height > 0,
          sideBySide: r.x >= c.x + c.width - 1 && r.y < c.y + c.height && c.y < r.y + r.height,
          sidewaysScroll: document.documentElement.scrollWidth > innerWidth + 1,
        }
      })()`), `the ${width}px layout`)
      record[`layout-${width}`] = layout
      const clean = layout && layout.railOnScreen && layout.sideBySide && !layout.sidewaysScroll
      note(clean ? 'PASS' : 'FAIL',
        `${width}px: rail ${layout?.railOnScreen ? 'on screen' : 'OFF SCREEN'}, ` +
        `${layout?.sideBySide ? 'beside the canvas' : 'NOT beside the canvas'}, ` +
        `${layout?.sidewaysScroll ? 'PAGE SCROLLS SIDEWAYS' : 'no sideways scroll'} ` +
        `(rail ${JSON.stringify(layout?.rail)})`)
      const circleAgain = await press(window, '.node[data-agent-id]')
      if (circleAgain.pressed) {
        await press(window, '[data-rail-tab="details"]')
        await delay(700)
        await shoot(window, `10-details-${width}.png`)
        /* The Setup box must not contradict itself: the two conditional rows
           ship [hidden] and must not paint — the .ctl-row[hidden] defect this
           drive found on 2026-08-20. Geometric reading, not DOM presence. */
        const honest = readOrThrow(await window.evaluate(`(() => {
          const painted = selector => {
            const node = document.querySelector(selector)
            if (!node) return false
            const box = node.getBoundingClientRect()
            return box.width > 0 && box.height > 0
          }
          return {
            restartRow: painted('[data-tree-profile-restart-row]'),
            moveRowPainted: painted('[data-tree-move-row]'),
            moveRowHiddenAttr: document.querySelector('[data-tree-move-row]')?.hidden === true,
          }
        })()`), 'the Setup rows')
        record[`setup-honesty-${width}`] = honest
        const contradiction = honest.restartRow || (honest.moveRowHiddenAttr && honest.moveRowPainted)
        note(contradiction ? 'FAIL' : 'PASS',
          `${width}px Setup box: restart row ${honest.restartRow ? 'PAINTED with no change' : 'not painted'}, ` +
          `move row ${honest.moveRowPainted ? (honest.moveRowHiddenAttr ? 'PAINTED while hidden' : 'painted (offered)') : 'not painted'}`)
      } else {
        note('FAIL', `${width}px: the agent circle could not be pressed (${circleAgain.why})`)
      }
      const backAgain = await press(window, '.computers .rail-back')
      if (!backAgain.pressed) note('INFO', `at ${width}px the rail back button did not press (${backAgain.why})`)
      await delay(500)
    }
    await window.session.send('Emulation.clearDeviceMetricsOverride', {})

    return record
  } finally {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, 'inventory.json'), JSON.stringify(record, null, 2))
    console.log(`  wrote ${path.join(OUT, 'inventory.json')}`)
    try { await window.evaluate('window.close()') } catch { /* gone already */ }
    reap(window.child?.pid)
  }
}

async function main() {
  const hashes = auditSelf()
  if (hashes.length > 0) {
    console.error(`this drive must navigate by clicking; found hash assignment:\n${hashes.join('\n')}`)
    process.exit(2)
  }
  process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  const scratch = mkdtempSync(path.join(tmpdir(), 'tree-panel-audit-'))
  console.log(`staging into ${scratch}`)
  try {
    const { executable, appRoot } = await stage(scratch)
    await drive(executable, scratch, appRoot)
  } finally {
    if (KEEP) console.log(`kept ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  }
  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${findings.filter(f => f.level === 'INFO').length} recorded, ${failed.length} unreachable`)
}

await main()
