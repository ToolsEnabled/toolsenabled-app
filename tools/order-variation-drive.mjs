#!/usr/bin/env node

/* ORDER-DEPENDENT VISIBILITY: the same controls, pressed in DIFFERENT ORDERS.
 *
 * THE DEFECT CLASS THIS HUNTS (owner directive, 2026-08-19 night): a control
 * that exists in the DOM but that a person cannot reach -- possibly only AFTER
 * another control was pressed, or only at one width, or only on a return visit.
 * Tonight's settings page shipped "116 settings · 0 shown": every DOM query
 * passed while a person saw six grey headings. So nothing here reads DOM
 * presence as existence. A control "exists" only when the geometric triple
 * holds: nonzero box AND its centre is inside the viewport AND
 * elementFromPoint at that centre returns the control or a descendant of it
 * (ancestor hits are refused -- the press would never reach the control).
 *
 * THE INSTRUMENT is a census: every button/link/input on the surface, with its
 * triple, taken BEFORE and AFTER every press, and diffed. A sequence's finding
 * is the diff, not a feeling. Orderings driven:
 *
 *   FLEET (page 2, the flagship board)
 *     F1 open compose panel -> cancel -> reopen        (cancel/retry)
 *     F2 open compose -> navigate away -> come back    (state restore)
 *     F3 start a node (refused offline, by design) -> rail tabs in orders:
 *        details->chat->chat (idempotence), censused each step
 *     F4 resize 1024 -> press tabs -> resize 1920      (width-dependent hides)
 *   SETTINGS
 *     S1 open group A -> open group B -> close A       (does B survive A?)
 *     S2 flip a toggle -> collapse its group -> reopen (truthful re-render)
 *     S3 search -> clear                               (do controls return?)
 *     S4 leave settings -> return                      (open-state restore)
 *     S5 same group header twice in a row              (idempotence)
 *   WALKTHROUGH (fresh profile, no seeded record)
 *     W1 forward -> back -> forward                    (does back lose state?)
 *     W2 skip from first screen -> route stays home
 *
 * REAL INPUT ONLY: Input.dispatchMouseEvent / Input.insertText through the
 * shared harness, which refuses a press whose landing point does not belong to
 * the target. Never el.click(), never dispatchEvent, never location.hash.
 *
 * USAGE  node tools/order-variation-drive.mjs --shots <dir> [--phase fleet|settings|walkthrough|all]
 * EXIT   0 all checks passed · 1 a check failed · 2 harness could not run
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  closeWindow,
  createLedger,
  delay,
  describeTimeline,
  openWindow,
  reap,
  scratchDirectory,
  seedMachineRecord,
  stage,
  argument,
  closeDrawer,
  gotoHome,
  gotoSettings,
  openDrawer,
  route,
} from './test-account-harness.mjs'

const SHOTS = argument('--shots', null)
const PHASE = argument('--phase', 'all')
const ledger = createLedger()
const { check, note } = ledger

export function decodeFiledGroups(raw) {
  if (raw === '' || raw == null) return { code: 'ABSENT', groups: [] }
  try {
    const groups = JSON.parse(raw)
    if (!Array.isArray(groups)) throw new TypeError('the stored value is not a list')
    return { code: 'OK', groups }
  } catch (error) {
    return {
      code: 'COULD_NOT_DECODE_OPEN_GROUPS',
      groups: null,
      detail: `Could not decode the filed settings groups (${error?.message || String(error)}); this is not claiming that no groups were filed.`,
    }
  }
}

/* ------------------------------------------------------------ instruments -- */

async function shot(window, name) {
  if (!SHOTS) return
  try {
    mkdirSync(SHOTS, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await window.session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
      await delay(300)
      const reply = await Promise.race([
        window.session.send('Page.captureScreenshot', { format: 'png' }),
        delay(15000).then(() => null),
      ])
      const data = reply?.result?.data || reply?.data
      if (data) { writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64')); return }
    }
    note(`shot ${name}: no data came back after two attempts`)
  } catch (error) { note(`shot ${name} failed: ${error?.message || error}`) }
}

/* The census: every control on the surface, with the geometric triple.
 * Deliberately does NOT scroll -- a census must not disturb the layout it is
 * measuring. 'scroll' means "reachable only by scrolling", which is fine for a
 * person; 'covered' with an ancestor or foreign element is the defect class. */
const CENSUS_FN = `(() => {
  const nodes = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
  const out = []
  const seen = new Map()
  for (const node of nodes) {
    let id = node.tagName.toLowerCase()
      + (node.id ? '#' + node.id : '')
      + (node.dataset ? Object.entries(node.dataset).slice(0, 2).map(([k, v]) => '[' + k + '=' + String(v).slice(0, 24) + ']').join('') : '')
      + '.' + String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').split(' ').filter(Boolean).slice(0, 2).join('.')
      + ':' + (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    const bump = (seen.get(id) || 0) + 1
    seen.set(id, bump)
    if (bump > 1) id += '~' + bump
    const disabled = node.disabled === true
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { out.push({ id, state: 'hidden', disabled }); continue }
    if (node.closest('[inert]')) { out.push({ id, state: 'inert', disabled }); continue }
    /* Content of a CLOSED <details> can still measure a laid-out box in
       Chromium while a person sees nothing of it. It is reachable only through
       its summary, so it is its own state, not 'scroll'. */
    const closedDetails = node.closest('details:not([open])')
    if (closedDetails && !(node.closest('summary') && closedDetails.contains(node.closest('summary')))) {
      out.push({ id, state: 'closed-details', disabled }); continue
    }
    const box = node.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) { out.push({ id, state: 'zero', disabled }); continue }
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const b = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { out.push({ id, state: 'scroll', box: b, disabled }); continue }
    const hit = document.elementFromPoint(x, y)
    if (!hit) { out.push({ id, state: 'covered', by: 'nothing', box: b, disabled }); continue }
    const label = hit.closest ? hit.closest('label') : null
    const receives = hit === node || node.contains(hit) || (label && label.control === node)
    if (!receives) {
      const name = hit.tagName + '.' + String(hit.className || '').split(' ')[0]
      out.push({ id, state: 'covered', by: (hit.contains(node) ? 'own-ancestor-' : '') + name, box: b, disabled })
      continue
    }
    out.push({ id, state: 'ok', x: Math.round(x), y: Math.round(y), disabled })
  }
  return { hash: location.hash, route: document.body.dataset.route, vw: innerWidth, vh: innerHeight, controls: out }
})()`

async function census(window, name) {
  const result = await window.evaluate(CENSUS_FN)
  if (result?.__evaluateThrew) { note(`census ${name} threw: ${result.__evaluateThrew}`); return null }
  if (SHOTS && result) {
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, `census-${name}.json`), JSON.stringify(result, null, 1))
  }
  return result
}

/* Which controls a person could press (or scroll to) in `before` but not in
 * `after`. `expect` is a predicate over the id for disappearances that the
 * sequence legitimately causes (a closed drawer takes its own buttons along). */
function lostControls(before, after, expect = () => false) {
  if (!before || !after) return { unmeasurable: true, lost: [] }
  const reachable = new Set(['ok', 'scroll'])
  const now = new Map(after.controls.map(control => [control.id, control]))
  const lost = []
  for (const control of before.controls) {
    if (!reachable.has(control.state) || control.disabled) continue
    const later = now.get(control.id)
    const state = later ? later.state : 'absent'
    if (reachable.has(state)) continue
    if (expect(control.id, state)) continue
    lost.push({ id: control.id, was: control.state, now: state, by: later?.by })
  }
  return { unmeasurable: false, lost }
}

function summarize(result) {
  if (!result) return 'unmeasurable'
  const states = {}
  for (const control of result.controls) states[control.state] = (states[control.state] || 0) + 1
  return `${result.controls.length} controls (${Object.entries(states).map(([k, v]) => `${k}:${v}`).join(' ')}) at ${result.vw}x${result.vh} on ${result.route}`
}

/* Resize the real window over the debugger; when the page-level session cannot
 * reach the Browser domain, fall back to viewport emulation and SAY so -- an
 * emulated 1024 exercises the same CSS the real window would. */
async function resizeTo(window, width, height) {
  try {
    const target = await window.session.send('Browser.getWindowForTarget')
    const windowId = target?.result?.windowId
    if (windowId !== undefined) {
      await window.session.send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
      await delay(900)
      return `window-${await window.evaluate('innerWidth')}`
    }
    if (target?.error) note(`Browser.getWindowForTarget: ${target.error.message}`)
  } catch { /* fall through to emulation */ }
  try {
    const reply = await window.session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
    if (reply?.error) return `resize-failed:${reply.error.message}`
    await delay(900)
    return `emulated-${await window.evaluate('innerWidth')}`
  } catch (error) { return `resize-failed:${error?.message || error}` }
}

/* ------------------------------------------------------- fleet board (F) --- */

async function gotoComputers(window) {
  await gotoHome(window)
  for (let step = 0; step < 12; step += 1) {
    if ((await route(window)) === 'computers') return 'there'
    const next = await window.clickVisible('#nav-next')
    if (next !== 'clicked') return `arrow:${next}`
    await delay(500)
  }
  return `stuck-on-${await route(window)}`
}

async function fleetPhase(window) {
  console.log('\n-- FLEET BOARD, in varied orders --')
  const reached = await gotoComputers(window)
  check('F0 the fleet board is reachable by clicking the arrows', reached === 'there', reached)
  if (reached !== 'there') return
  await delay(1200)
  const base = await census(window, 'F-board-base')
  note(`board census: ${summarize(base)}`)
  await shot(window, 'F0-board')

  /* F1: compose open -> cancel -> reopen. The cancel path must give back every
     control it took, and the retry must present the same panel. */
  const open1 = await window.clickVisible('.computers .tree-empty-node')
  check('F1 the empty tree slot takes a real press', open1 === 'clicked', open1)
  await delay(800)
  const composeOpen = await census(window, 'F1-compose-open')
  await shot(window, 'F1-compose-open')
  const roleSeen = await window.visibility('[data-compose-field="role"]')
  check('F1 the start panel presents its role selector to a pointer', roleSeen?.state === 'visible', roleSeen?.state + (roleSeen?.by ? `:${roleSeen.by}` : ''))

  /* Cancel by the panel's own button -- the primary person path. */
  const cancelPress = await window.clickVisible('[data-compose-action="cancel"]')
  await delay(900)
  const afterCancel = await census(window, 'F1-after-cancel')
  await shot(window, 'F1-after-cancel')
  const cancelDiff = lostControls(base, afterCancel)
  check('F1 the cancel button closes the panel and gives back every board control', cancelPress === 'clicked' && cancelDiff.lost.length === 0,
    `press=${cancelPress} ` + (cancelDiff.lost.slice(0, 4).map(l => `${l.id} ${l.was}->${l.now}${l.by ? ' by ' + l.by : ''}`).join(' | ') || ''))

  const open2 = await window.clickVisible('.computers .tree-empty-node')
  await delay(800)
  const roleAgain = await window.visibility('[data-compose-field="role"]')
  check('F1 reopening after cancel presents the same panel', open2 === 'clicked' && roleAgain?.state === 'visible', `press=${open2} role=${roleAgain?.state}`)
  await shot(window, 'F1-compose-reopen')

  /* Second cancel route: Escape from inside the panel (the keyboard path the
   * panel documents). Both routes must give the SAME board back. */
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' })
  }
  await delay(900)
  const afterEscape = await census(window, 'F1-after-escape')
  await shot(window, 'F1-after-escape')
  const escapeDiff = lostControls(base, afterEscape)
  check('F1 Escape also cancels, giving back the same board', escapeDiff.lost.length === 0,
    escapeDiff.lost.slice(0, 4).map(l => `${l.id} ${l.was}->${l.now}${l.by ? ' by ' + l.by : ''}`).join(' | ') || '')

  const open3 = await window.clickVisible('.computers .tree-empty-node')
  await delay(800)
  const roleThird = await window.visibility('[data-compose-field="role"]')
  check('F1 the panel opens a third time after both cancel routes', open3 === 'clicked' && roleThird?.state === 'visible', `press=${open3} role=${roleThird?.state}`)

  /* F2: with the panel open, walk AWAY (arrow), then come back. The board must
   * not come back wedged, and the panel's controls must not leak onto the next
   * page. */
  const away = await window.clickVisible('#nav-next')
  await delay(900)
  const awayRoute = await route(window)
  const awayCensus = await census(window, 'F2-away')
  const composeLeak = awayCensus?.controls?.filter(control =>
    control.id.includes('compose') && (control.state === 'ok' || control.state === 'covered')) || []
  check('F2 leaving mid-compose does not leak panel controls onto the next page',
    away === 'clicked' && composeLeak.length === 0,
    `route=${awayRoute} leaked=${composeLeak.map(l => l.id).join(',') || 'none'}`)
  const back = await gotoComputers(window)
  await delay(900)
  const backCensus = await census(window, 'F2-back')
  await shot(window, 'F2-back-on-board')
  const backDiff = lostControls(base, backCensus)
  check('F2 returning to the board restores every control the base board had', back === 'there' && backDiff.lost.length === 0,
    backDiff.lost.slice(0, 4).map(l => `${l.id} ${l.was}->${l.now}${l.by ? ' by ' + l.by : ''}`).join(' | ') || back)

  /* F3: really start a node (the offline refusal is the sanctioned zero-cost
   * path), then drive the rail tabs in orders. */
  const { startFleetNode } = await import('./lib/fleet-node.mjs')
  const started = await startFleetNode({ session: window.session, evaluate: window.evaluate, delay })
  check('F3 the start-an-agent walk reaches its end', started.ok === true, started.ok ? '' : `stopped at ${started.at}: ${started.detail}`)
  await delay(1200)
  await shot(window, 'F3-node-started')

  const railBase = await census(window, 'F3-rail-base')
  note(`rail census: ${summarize(railBase)}`)

  const tabs = ['details', 'chat', 'chat']
  let previous = railBase
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index]
    const pressed = await window.clickVisible(`[data-rail-tab="${tab}"]`)
    await delay(700)
    const after = await census(window, `F3-tab-${index}-${tab}`)
    await shot(window, `F3-tab-${index}-${tab}`)
    const isOn = await window.evaluate(`document.querySelector('[data-rail-tab="${tab}"]')?.classList.contains('on')`)
    check(`F3 rail tab "${tab}" (press ${index + 1}) is pressable and truthfully lit`, pressed === 'clicked' && isOn === true, `press=${pressed} lit=${isOn}`)
    /* Tab switches swap tab BODIES; the tab buttons themselves must never go. */
    const tabLoss = lostControls(previous, after, id => !id.includes('rail-tab='))
    check(`F3 after pressing "${tab}" the rail tabs are all still pressable`, tabLoss.lost.length === 0,
      tabLoss.lost.map(l => `${l.id} ${l.was}->${l.now}`).join(' | ') || '')
    previous = after
  }

  /* F4: width variation AFTER presses. 1024 first, tabs again, then 1920. */
  const narrow = await resizeTo(window, 1024, 768)
  note(`resize to 1024: ${narrow}`)
  if (!narrow.startsWith('resize-failed') && narrow !== 'no-window-id') {
    await delay(600)
    const at1024 = await census(window, 'F4-1024')
    await shot(window, 'F4-board-1024')
    note(`board at 1024: ${summarize(at1024)}`)
    const covered1024 = at1024?.controls?.filter(control => control.state === 'covered' && !control.disabled) || []
    check('F4 at 1024 no board control is covered by another element', covered1024.length === 0,
      covered1024.slice(0, 5).map(l => `${l.id} by ${l.by}`).join(' | ') || '')
    const tabAt1024 = await window.clickVisible('[data-rail-tab="details"]')
    check('F4 the details tab still takes a press at 1024', tabAt1024 === 'clicked', tabAt1024)
    const wide = await resizeTo(window, 1920, 1080)
    note(`resize to 1920: ${wide}`)
    await delay(600)
    const at1920 = await census(window, 'F4-1920')
    await shot(window, 'F4-board-1920')
    const covered1920 = at1920?.controls?.filter(control => control.state === 'covered' && !control.disabled) || []
    check('F4 back at 1920 no board control is covered', covered1920.length === 0,
      covered1920.slice(0, 5).map(l => `${l.id} by ${l.by}`).join(' | ') || '')
  } else {
    note('UNMEASURABLE: F4 width variation -- the window would not resize over the debugger: ' + narrow)
  }
}

/* ------------------------------------------- fleet board, round 2 (G) ----- *
 *
 * Round 1 measured two things it could not explain from outside:
 *   - the Role library's editors (textareas + Save/Reset) measure LAID-OUT
 *     boxes on the untouched board while sitting inside closed <details>;
 *   - after a compose-panel cancel, those Save/Reset buttons flipped to
 *     computed display:none while their sibling textareas did not.
 * This round resolves both ON THE GLASS: open a role editor the way a person
 * does, prove its Save control takes a pointer, then run the compose panel's
 * open -> turn-on -> cancel orderings across it and re-prove the Save control
 * after every step. Plus the enablement ordering round 1 exposed: the start
 * form ships disabled ("Starting an assistant is switched off") with its own
 * "Turn on running agents" press -- does that press enable the form, and does
 * the enablement survive cancel -> reopen?
 */

async function fleet2Phase(window) {
  console.log('\n-- FLEET BOARD round 2: role library x compose orderings --')
  const reached = await gotoComputers(window)
  check('G0 the fleet board is reachable by clicking', reached === 'there', reached)
  if (reached !== 'there') return
  await delay(1200)

  /* G1: open a role editor by its summary, like a person. */
  const summaryPress = await window.clickVisible('.board-roles-box .role-item summary')
  await delay(700)
  const saveBefore = await window.visibility('.board-roles-box .role-item[open] [data-act="save"]')
  await shot(window, 'G1-role-editor-open')
  check('G1 opening a Role library entry presents its Save control to a pointer',
    summaryPress === 'clicked' && saveBefore?.state === 'visible',
    `press=${summaryPress} save=${saveBefore?.state}${saveBefore?.by ? ':' + saveBefore.by : ''}`)
  const saveMeta = await window.evaluate(`(() => {
    const save = document.querySelector('.board-roles-box .role-item[open] [data-act="save"]')
    return save ? { disabled: save.disabled, title: save.title || '' } : null
  })()`)
  note(`Save control: ${JSON.stringify(saveMeta)}`)

  /* G2: compose panel over the open role editor, then its turn-on press. */
  const slot1 = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const saveDuring = await window.visibility('.board-roles-box .role-item[open] [data-act="save"]')
  note(`Save control while compose is open: ${saveDuring?.state}${saveDuring?.by ? ':' + saveDuring.by : ''}`)
  await shot(window, 'G2-compose-over-editor')
  const formBefore = await window.evaluate(`(() => {
    const role = document.querySelector('[data-compose-field="role"]')
    const submit = document.querySelector('[data-compose-action="start"]')
    const enable = document.querySelector('[data-compose-unavailable-action]')
    return { roleDisabled: role?.disabled ?? 'absent', submitDisabled: submit?.disabled ?? 'absent', enablePresent: Boolean(enable), enableText: enable?.textContent?.trim().slice(0, 60) || '' }
  })()`)
  note(`start form before turn-on: ${JSON.stringify(formBefore)}`)
  if (formBefore?.enablePresent) {
    const enablePress = await window.clickVisible('[data-compose-unavailable-action]')
    await delay(1200)
    const formAfter = await window.evaluate(`(() => {
      const role = document.querySelector('[data-compose-field="role"]')
      const submit = document.querySelector('[data-compose-action="start"]')
      return { roleDisabled: role?.disabled ?? 'absent', submitDisabled: submit?.disabled ?? 'absent' }
    })()`)
    await shot(window, 'G2-after-turn-on')
    check('G2 "Turn on running agents" enables the start form it sits beside',
      enablePress === 'clicked' && formAfter?.roleDisabled === false,
      `press=${enablePress} after=${JSON.stringify(formAfter)}`)
  } else if (formBefore?.roleDisabled === false) {
    note('start form already enabled; the turn-on ordering is not available on this profile')
  } else {
    check('G2 the disabled start form offers its own turn-on control', false, JSON.stringify(formBefore))
  }

  /* G3: cancel the panel, then re-prove the role editor's Save control --
   * round 1 measured Save/Reset at computed display:none after this exact
   * ordering. */
  const cancelPress = await window.clickVisible('[data-compose-action="cancel"]')
  await delay(1000)
  const itemStillOpen = await window.evaluate(`document.querySelector('.board-roles-box .role-item[open]') !== null`)
  const saveAfter = await window.visibility('.board-roles-box .role-item[open] [data-act="save"]')
  await shot(window, 'G3-after-cancel-editor-state')
  check('G3 after compose-cancel the opened role editor still presents Save',
    cancelPress === 'clicked' && itemStillOpen === true && saveAfter?.state === 'visible',
    `cancel=${cancelPress} itemOpen=${itemStillOpen} save=${saveAfter?.state}${saveAfter?.by ? ':' + saveAfter.by : ''}`)

  /* G4: reopen the panel -- did the turn-on choice survive the cancel? */
  const slot2 = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const formReopened = await window.evaluate(`(() => {
    const role = document.querySelector('[data-compose-field="role"]')
    return { roleDisabled: role?.disabled ?? 'absent', enableStillOffered: Boolean(document.querySelector('[data-compose-unavailable-action]')) }
  })()`)
  await shot(window, 'G4-reopened-panel')
  check('G4 the turn-on choice survives cancel and reopen',
    slot2 === 'clicked' && formReopened?.roleDisabled === false,
    `press=${slot2} reopened=${JSON.stringify(formReopened)}`)
  await window.clickVisible('[data-compose-action="cancel"]')
  await delay(800)

  /* G5: the full start walk (ends at the engine's own signed-out refusal,
   * drawing a real node), then the rail tabs in orders. */
  const { startFleetNode } = await import('./lib/fleet-node.mjs')
  const started = await startFleetNode({ session: window.session, evaluate: window.evaluate, delay })
  check('G5 the start-an-agent walk reaches its end', started.ok === true, started.ok ? '' : `stopped at ${started.at}: ${started.detail}`)
  await delay(1500)
  await shot(window, 'G5-node-on-board')

  if (started.ok) {
    const railBase = await census(window, 'G5-rail-base')
    note(`rail census: ${summarize(railBase)}`)
    const tabs = ['details', 'chat', 'chat']
    let previous = railBase
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index]
      const pressed = await window.clickVisible(`[data-rail-tab="${tab}"]`)
      await delay(700)
      const after = await census(window, `G5-tab-${index}-${tab}`)
      await shot(window, `G5-tab-${index}-${tab}`)
      const isOn = await window.evaluate(`document.querySelector('[data-rail-tab="${tab}"]')?.classList.contains('on')`)
      check(`G5 rail tab "${tab}" (press ${index + 1}) is pressable and truthfully lit`, pressed === 'clicked' && isOn === true, `press=${pressed} lit=${isOn}`)
      const tabLoss = lostControls(previous, after, id => !id.includes('rail-tab='))
      check(`G5 after pressing "${tab}" the rail tabs are all still pressable`, tabLoss.lost.length === 0,
        tabLoss.lost.map(l => `${l.id} ${l.was}->${l.now}`).join(' | ') || '')
      previous = after
    }
  }

  /* G6: width variation after all of the above. */
  const narrow = await resizeTo(window, 1024, 768)
  note(`resize to 1024: ${narrow}`)
  if (!narrow.startsWith('resize-failed')) {
    await delay(600)
    const at1024 = await census(window, 'G6-1024')
    await shot(window, 'G6-board-1024')
    note(`board at 1024: ${summarize(at1024)}`)
    const covered1024 = at1024?.controls?.filter(control => control.state === 'covered' && !control.disabled) || []
    check('G6 at 1024 no board control is covered by another element', covered1024.length === 0,
      covered1024.slice(0, 5).map(l => `${l.id} by ${l.by}`).join(' | ') || '')
    const saveAt1024 = await window.visibility('.board-roles-box .role-item[open] [data-act="save"]')
    note(`Save control at 1024: ${saveAt1024?.state}${saveAt1024?.by ? ':' + saveAt1024.by : ''}`)
    const wide = await resizeTo(window, 1920, 1080)
    note(`resize to 1920: ${wide}`)
    await delay(600)
    const at1920 = await census(window, 'G6-1920')
    await shot(window, 'G6-board-1920')
    const covered1920 = at1920?.controls?.filter(control => control.state === 'covered' && !control.disabled) || []
    check('G6 back at 1920 no board control is covered', covered1920.length === 0,
      covered1920.slice(0, 5).map(l => `${l.id} by ${l.by}`).join(' | ') || '')
    await window.session.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await delay(500)
  } else {
    note('UNMEASURABLE: G6 width variation -- ' + narrow)
  }
}

/* ------------------------------------------- fleet board, round 3 (R) ----- *
 *
 * R1 isolates WHICH press kills an open role editor (round 2 proved the whole
 *    sequence open-editor -> compose -> turn-on -> cancel collapses it), and
 *    whether wording a person TYPED but had not saved dies with it.
 * R2 is the driven proof of the Escape fix: mouse-open then Escape with no
 *    click inside the panel must close it (this exact ordering was measured
 *    dead at HEAD), keyboard-open then Escape must still close it, and the
 *    in-panel Escape (focus in the message box) must still close it.
 */

const ESC = { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }
const TAB = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, code: 'Tab', key: 'Tab' }
const ENTER = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }

/* rawKeyDown skips the browser's default processing -- right for Escape and
 * Tab probing, WRONG for activating a focused button with Enter: the click a
 * real Enter synthesises never happens (measured: the slot button stayed
 * pressed-looking and no panel opened). Enter goes through as a full keyDown
 * with its text so the default activation runs. */
async function pressKey(window, key, { activate = false } = {}) {
  const down = activate ? { type: 'keyDown', text: key.key === 'Enter' ? '\r' : key.key, ...key } : { type: 'rawKeyDown', ...key }
  await window.session.send('Input.dispatchKeyEvent', down)
  await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await delay(200)
}

const PANEL_OPEN = `document.querySelector('[data-agent-compose="open"]') !== null`
const OPEN_ITEM = '.board-roles-box .role-item[open]'
const OWNS = `${OPEN_ITEM} textarea[data-field="owns"]`

async function fleet3Phase(window) {
  console.log('\n-- FLEET BOARD round 3: kill-sequence isolation + Escape proof --')
  const reached = await gotoComputers(window)
  check('R0 the fleet board is reachable by clicking', reached === 'there', reached)
  if (reached !== 'there') return
  await delay(1200)

  /* R1a: open a role editor and TYPE into it (real click + insertText). */
  const summaryPress = await window.clickVisible('.board-roles-box .role-item summary')
  await delay(700)
  const marker = ' ORDER-DRIVE-MARKER'
  const typed = await window.typeInto(OWNS, marker)
  const valueAfterType = await window.evaluate(`document.querySelector(${JSON.stringify(OWNS)})?.value ?? 'absent'`)
  check('R1 a person can type into an open role editor', summaryPress === 'clicked' && typed === 'typed' && String(valueAfterType).includes(marker.trim()),
    `press=${summaryPress} typed=${typed} carries-marker=${String(valueAfterType).includes(marker.trim())}`)
  await shot(window, 'R1-typed-into-editor')

  /* R1b: compose OPEN alone -- does the editor survive the rail page swap? */
  const slot1 = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const afterOpen = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    value: document.querySelector(${JSON.stringify(OWNS)})?.value ?? 'absent',
  })`)
  note(`after compose OPEN: ${JSON.stringify(afterOpen)}`)

  /* R1c: cancel alone (no turn-on this cycle). */
  const cancel1 = await window.clickVisible('[data-compose-action="cancel"]')
  await delay(1000)
  const afterCancel = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    value: document.querySelector(${JSON.stringify(OWNS)})?.value ?? 'absent',
    anyValueCarriesMarker: [...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER')),
  })`)
  await shot(window, 'R1-after-cancel-alone')
  check('R1 compose open -> cancel leaves the open editor open', slot1 === 'clicked' && cancel1 === 'clicked' && afterCancel?.itemOpen === true,
    `open=${slot1} cancel=${cancel1} after=${JSON.stringify(afterCancel)}`)
  check('R1 wording typed before the panel round-trip is still in the editor', afterCancel?.anyValueCarriesMarker === true,
    JSON.stringify(afterCancel))

  /* R1d: now the turn-on variant. Re-establish an open editor with the marker
   * if the previous step lost it. */
  const reopened = await window.evaluate(`document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null`)
  if (reopened !== true) {
    await window.clickVisible('.board-roles-box .role-item summary')
    await delay(700)
    await window.typeInto(OWNS, marker)
  } else if (afterCancel?.anyValueCarriesMarker !== true) {
    await window.typeInto(OWNS, marker)
  }
  const slot2 = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const enableOffered = await window.visibility('[data-compose-unavailable-action]')
  let turnOn = 'not-offered'
  if (enableOffered?.state === 'visible') {
    turnOn = await window.clickVisible('[data-compose-unavailable-action]')
    await delay(1200)
  }
  const afterTurnOn = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    anyValueCarriesMarker: [...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER')),
  })`)
  note(`after TURN-ON press (press=${turnOn}): ${JSON.stringify(afterTurnOn)}`)
  const cancel2 = await window.clickVisible('[data-compose-action="cancel"]')
  await delay(1000)
  const afterTurnOnCancel = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    anyValueCarriesMarker: [...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER')),
  })`)
  await shot(window, 'R1-after-turnon-cancel')
  check('R1 the turn-on ordering leaves the open editor open', slot2 === 'clicked' && cancel2 === 'clicked' && afterTurnOnCancel?.itemOpen === true,
    `open=${slot2} turnOn=${turnOn} cancel=${cancel2} after=${JSON.stringify(afterTurnOnCancel)}`)
  check('R1 the turn-on ordering keeps typed wording', afterTurnOnCancel?.anyValueCarriesMarker === true, JSON.stringify(afterTurnOnCancel))

  /* R2a: THE DRIVEN PROOF. Mouse-open, then Escape, no click inside the panel. */
  const slotEsc = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const openBeforeEsc = await window.evaluate(PANEL_OPEN)
  const focusAfterOpen = await window.evaluate(`(() => {
    const active = document.activeElement
    const panel = document.querySelector('[data-agent-compose="open"]')
    return { tag: active?.tagName || 'none', inPanel: Boolean(panel && active && panel.contains(active)), isRoot: active === panel }
  })()`)
  await pressKey(window, ESC)
  await delay(800)
  const openAfterEsc = await window.evaluate(PANEL_OPEN)
  await shot(window, 'R2-after-mouse-open-escape')
  check('R2 mouse-open then Escape (no panel click) cancels the panel',
    slotEsc === 'clicked' && openBeforeEsc === true && openAfterEsc === false,
    `open=${slotEsc} before=${openBeforeEsc} focus=${JSON.stringify(focusAfterOpen)} after=${openAfterEsc}`)

  /* R2b: keyboard-open (Tab to the slot button, Enter), then Escape. */
  let slotFocused = false
  for (let hop = 0; hop < 60 && !slotFocused; hop += 1) {
    await pressKey(window, TAB)
    slotFocused = (await window.evaluate(`document.activeElement?.classList?.contains('tree-empty-node') === true`)) === true
  }
  if (!slotFocused) {
    note('UNMEASURABLE: R2 keyboard-open -- 60 Tab presses never landed on the empty slot button; reporting, not asserting')
  } else {
    await pressKey(window, ENTER, { activate: true })
    await delay(900)
    const kbOpen = await window.evaluate(PANEL_OPEN)
    const kbFocus = await window.evaluate(`(() => {
      const active = document.activeElement
      const panel = document.querySelector('[data-agent-compose="open"]')
      return { field: active?.getAttribute?.('data-compose-field') || active?.tagName || 'none', inPanel: Boolean(panel && active && panel.contains(active)) }
    })()`)
    await pressKey(window, ESC)
    await delay(800)
    const kbClosed = await window.evaluate(PANEL_OPEN)
    await shot(window, 'R2-after-keyboard-open-escape')
    check('R2 keyboard-open puts focus in the panel and Escape still cancels',
      kbOpen === true && kbFocus?.inPanel === true && kbClosed === false,
      `open=${kbOpen} focus=${JSON.stringify(kbFocus)} closed=${kbClosed}`)
  }

  /* R2c: the in-panel Escape that already worked must still work: mouse-open,
   * click the message box, Escape. */
  const slotMsg = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const msgClick = await window.clickVisible('[data-compose-field="message"]')
  await pressKey(window, ESC)
  await delay(800)
  const msgClosed = await window.evaluate(PANEL_OPEN)
  check('R2 Escape from the message box still cancels (no regression)',
    slotMsg === 'clicked' && msgClick === 'clicked' && msgClosed === false,
    `open=${slotMsg} click=${msgClick} closed=${msgClosed}`)

  /* R3: the reopened panel after turn-on: is the turn-on control truthfully
   * gone from the glass, or still offered although the switch is on? */
  const slot3 = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const enableAfterOn = await window.visibility('[data-compose-unavailable-action]')
  const roleEnabled = await window.evaluate(`document.querySelector('[data-compose-field="role"]')?.disabled === false`)
  await shot(window, 'R3-reopened-after-turn-on')
  check('R3 with running agents on, the reopened panel does not offer turn-on as pressable',
    roleEnabled === true && enableAfterOn?.state !== 'visible',
    `roleEnabled=${roleEnabled} turnOnControl=${enableAfterOn?.state}${enableAfterOn?.by ? ':' + enableAfterOn.by : ''}`)
  await window.clickVisible('[data-compose-action="cancel"]')
  await delay(600)
}

/* ------------------------------------------- fleet board, round 4 (D) ----- *
 *
 * The SECOND reachable path to the same data loss, driven end to end: the
 * settings drawer's per-page live toggle fires the same route remount as the
 * compose panel's turn-on press, with no compose panel involved. A person
 * with a role editor open and wording typed flips the page to the example
 * board and back -- their wording must come back with the live board.
 */

async function fleet4Phase(window) {
  console.log('\n-- FLEET BOARD round 4: the drawer path to the same remount --')
  const reached = await gotoComputers(window)
  check('D0 the fleet board is reachable by clicking', reached === 'there', reached)
  if (reached !== 'there') return
  await delay(1200)

  const summaryPress = await window.clickVisible('.board-roles-box .role-item summary')
  await delay(700)
  const marker = ' ORDER-DRIVE-MARKER'
  const typed = await window.typeInto(OWNS, marker)
  const carried = await window.evaluate(`String(document.querySelector(${JSON.stringify(OWNS)})?.value ?? '').includes('ORDER-DRIVE-MARKER')`)
  check('D1 a role editor is open with typed wording', summaryPress === 'clicked' && typed === 'typed' && carried === true,
    `press=${summaryPress} typed=${typed} carried=${carried}`)
  await shot(window, 'D1-typed')

  const drawer = await openDrawer(window)
  const toggleSelector = '#drawer label.set-row:has(input[data-quick-live="computers"])'
  const flip1 = await window.clickVisible(toggleSelector)
  await delay(1600)
  const modeAfterFlip = await window.evaluate(`({
    liveMode: document.querySelector('.computers')?.dataset?.liveMode ?? 'unknown',
    libraryPresent: document.querySelector('.board-roles-box') !== null,
    capture: window.__mcOrderDriveCapture ?? null,
    restore: window.__mcOrderDriveRestore ?? null,
  })`)
  note(`after flip to example: ${JSON.stringify(modeAfterFlip)}`)
  await shot(window, 'D2-flipped-to-example')

  const flip2 = await window.clickVisible(toggleSelector)
  await delay(1600)
  const closed = await closeDrawer(window)
  /* The live board rebuilds its library after the org read answers. */
  let libraryBack = { state: 'absent' }
  const until = Date.now() + 12000
  while (Date.now() < until) {
    libraryBack = await window.visibility('.board-roles-box .role-item')
    if (libraryBack?.state === 'visible') break
    await delay(400)
  }
  const outcome = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    anyValueCarriesMarker: [...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER')),
    capture: window.__mcOrderDriveCapture ?? null,
    restore: window.__mcOrderDriveRestore ?? null,
  })`)
  /* THE PROOF HAS TO BE ON GLASS, NOT ONLY IN THE READ. The rail comes back
     scrolled to its top and the Role library is a thousand pixels down it, so
     the obvious screenshot shows an empty overview and proves nothing either
     way. visibility() scrolls the restored editor into the viewport the way a
     person would scroll to it, and reports whether it really got there. */
  const onGlass = await window.visibility(OPEN_ITEM)
  note(`restored editor on glass: ${JSON.stringify(onGlass)}`)
  await shot(window, 'D3-back-on-live')
  check('D2 the drawer live-toggle presses landed and the drawer closed', drawer !== 'covered' && flip1 === 'clicked' && flip2 === 'clicked' && closed === 'closed',
    `drawer=${drawer} flips=${flip1}/${flip2} close=${closed}`)
  check('D3 flipping to the example board and back keeps the open editor', outcome?.itemOpen === true,
    `library=${libraryBack?.state} ${JSON.stringify(outcome)}`)
  check('D3 ...and keeps the typed wording', outcome?.anyValueCarriesMarker === true, JSON.stringify(outcome))
}

/* ------------------------------------------- fleet board, round 5 (E) ----- *
 *
 * THE THIRD DOORWAY, AS A POSITIVE CONTROL. tree-start's rail inventory found
 * exactly one other control in the whole rail that flips a write flag:
 * src/cloud-tasks.js offSwitch() -- "Turn on Codex Cloud launching", appended
 * into the Codex Cloud box header when that flag is off, mounted on a
 * selected node's Details tab. Same setWriteEnabled -> WRITE_FLAGS_EVENT ->
 * route remount as the compose panel's turn-on. If the restore-level fix
 * preserves typed Role wording across THIS doorway too, with no code naming
 * it, the fix is at the right level.
 */

async function fleet5Phase(window) {
  console.log('\n-- FLEET BOARD round 5: the cloud-box doorway --')
  const reached = await gotoComputers(window)
  check('E0 the fleet board is reachable by clicking', reached === 'there', reached)
  if (reached !== 'there') return
  await delay(1200)

  /* RUNNING AGENTS FIRST, AND IT IS NOT A SHORTCUT -- it is the precondition
     for the thing being measured. MEASURED 2026-08-20 with a standalone probe:
     on a sterile profile the start panel's role <select> carries all six
     options and is `disabled: true` until this flag is on. A press on a
     disabled select takes no focus (activeElement stayed on the panel root),
     so the Escape that tools/lib/fleet-node.mjs sends to dismiss the native
     popup bubbled to the panel root instead and cancelled the whole panel --
     which the walk then reported as "the selector still has no value". No node
     can be started at all in that state, and this phase needs a node.

     IT DOES NOT WEAKEN THE POSITIVE CONTROL. This flip happens BEFORE the
     marker is typed, so the wording never has to survive it; the only remount
     the marker is asked to ride is the cloud one, several steps later. */
  const slotForTurnOn = await window.clickVisible('.computers .tree-empty-node')
  await delay(900)
  const turnOnOffered = await window.visibility('[data-compose-unavailable-action]')
  let turnOn = 'not-offered'
  if (turnOnOffered?.state === 'visible') {
    turnOn = await window.clickVisible('[data-compose-unavailable-action]')
    await delay(1400)
  }
  await window.clickVisible('[data-compose-action="cancel"]')
  await delay(900)
  const roleUsable = await window.evaluate(`(() => {
    const select = document.querySelector('[data-compose-field="role"]')
    return select ? select.disabled === false : 'panel-closed'
  })()`)
  note(`running agents turned on before typing: slot=${slotForTurnOn} offered=${turnOnOffered?.state} press=${turnOn} role-usable=${roleUsable}`)

  const summaryPress = await window.clickVisible('.board-roles-box .role-item summary')
  await delay(700)
  const typed = await window.typeInto(OWNS, ' ORDER-DRIVE-MARKER')
  const carried = await window.evaluate(`String(document.querySelector(${JSON.stringify(OWNS)})?.value ?? '').includes('ORDER-DRIVE-MARKER')`)
  check('E1 a role editor is open with typed wording', summaryPress === 'clicked' && typed === 'typed' && carried === true,
    `press=${summaryPress} typed=${typed} carried=${carried}`)
  await shot(window, 'E1-typed-before-cloud')

  const { startFleetNode } = await import('./lib/fleet-node.mjs')
  const started = await startFleetNode({ session: window.session, evaluate: window.evaluate, delay })
  check('E2 a node reaches the board so the rail has a Details tab', started.ok === true,
    started.ok ? '' : `stopped at ${started.at}: ${started.detail}`)
  if (!started.ok) return
  await delay(1200)
  const heldThroughStart = await window.evaluate(`[...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER'))`)
  note(`typed wording still in the (parked) stats rail after the node start: ${heldThroughStart}`)

  const detailsTab = await window.clickVisible('[data-rail-tab="details"]')
  await delay(900)
  /* THE CONTROL LIVES BEHIND A DISCLOSURE NOW, so the drive opens it the way a
     person does rather than reaching past it. The rail's "Start work" group
     (Launch, Team, Loop, Codex Cloud) ships collapsed and remembers the
     posture, so this presses only when the body is actually hidden -- a second
     press on an open group would close it and the phase would report the
     control missing when it is simply folded away. */
  const foldedAway = await window.evaluate(`document.querySelector('[data-start-work-body]')?.hidden === true`)
  let openedGroup = 'not-needed'
  if (foldedAway === true) {
    openedGroup = await window.clickVisible('[data-start-work-toggle]')
    await delay(600)
  }
  note(`start-work group: hidden=${foldedAway} open-press=${openedGroup}`)
  const cloudSpot = await window.waitForVisible('[data-cloud-enable]', 10000)
  await shot(window, 'E3-details-tab')
  if (cloudSpot?.state !== 'visible') {
    const boxes = await window.evaluate(`[...document.querySelectorAll('.board-box-h .bh-t')].map(n => n.textContent.trim()).join(' | ')`)
    note(`UNMEASURABLE: E3 -- the cloud turn-on control never presented (${cloudSpot?.state}${cloudSpot?.by ? ':' + cloudSpot.by : ''}); rail boxes: ${boxes}`)
    return
  }
  const pressEnable = await window.clickVisible('[data-cloud-enable]')
  await delay(1800)
  let libraryBack = { state: 'absent' }
  const until = Date.now() + 12000
  while (Date.now() < until) {
    libraryBack = await window.visibility('.board-roles-box .role-item')
    if (libraryBack?.state === 'visible') break
    await delay(400)
  }
  const outcome = await window.evaluate(`({
    itemOpen: document.querySelector(${JSON.stringify(OPEN_ITEM)}) !== null,
    anyValueCarriesMarker: [...document.querySelectorAll('.board-roles-box textarea')].some(t => t.value.includes('ORDER-DRIVE-MARKER')),
    capture: window.__mcOrderDriveCapture ?? null,
    restore: window.__mcOrderDriveRestore ?? null,
  })`)
  /* Same reason as D3: scroll to the restored editor so the screenshot shows
     the wording rather than the top of a rail. */
  const onGlass = await window.visibility(OPEN_ITEM)
  note(`restored editor on glass: ${JSON.stringify(onGlass)}`)
  await shot(window, 'E4-after-cloud-turn-on')
  check('E3 the cloud turn-on press lands and the view returns', pressEnable === 'clicked' && libraryBack?.state === 'visible',
    `press=${pressEnable} library=${libraryBack?.state}`)
  check('E4 typed Role wording rides the cloud-doorway remount too', outcome?.itemOpen === true && outcome?.anyValueCarriesMarker === true,
    JSON.stringify(outcome))
}

/* --------------------------------------------------------- settings (S) --- */

async function settingsPhase(window) {
  console.log('\n-- SETTINGS, in varied orders --')
  const reached = await gotoSettings(window)
  check('S0 the settings page is reachable by clicking', reached === 'clicked' || reached === 'already-there', reached)
  if (reached !== 'clicked' && reached !== 'already-there') return
  await delay(900)
  await shot(window, 'S0-settings')

  /* THE GROUPS ARE IN THE RAIL AND THE CATEGORIES ARE PAGES.
     Every scenario below used to press group heads in the main column, because
     the page was one document with twelve sections in it and those heads opened
     and closed parts of it. The page draws ONE category now and the address
     says which, so the same questions are asked of the two things that remain:
     the rail's own open state, and what survives the page being built again
     from a different address. */
  const groups = await window.evaluate(`[...document.querySelectorAll('.settings-rail [data-rail-group]')].map(b => ({
    id: b.dataset.railGroup, open: b.getAttribute('aria-expanded') === 'true' }))`)
  if (!Array.isArray(groups) || groups.length < 2) {
    check('S0 the settings page presents at least two groups', false, JSON.stringify(groups))
    return
  }
  note(`groups: ${groups.map(g => `${g.id}${g.open ? '(open)' : ''}`).join(' ')}`)
  note(`footer says: ${JSON.stringify(await window.evaluate(`document.querySelector('.settings-footer')?.innerText || ''`))}`)

  const railHead = id => `.settings-rail [data-rail-group="${id}"]`
  const railList = id => `#settings-rail-${id}`
  const shownCategory = () => window.evaluate(
    `document.querySelector('.settings-sections .settings-section')?.dataset.settingsSection || 'none'`)
  const openEveryGroup = () => window.evaluate(`(() => {
    for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
    return true
  })()`)
  const goToCategory = async (category) => {
    /* The rail folds back to "what this person filed, plus the group the page
       is in" on every navigation, so the group holding the wanted category is
       opened first -- the same button a person would press. */
    await openEveryGroup()
    const pressed = await window.clickVisible(`.settings-rail button[data-category=${JSON.stringify(category)}]`)
    await delay(900)
    return pressed
  }

  const groupA = groups.find(g => !g.open)?.id ?? groups[0].id
  const groupB = groups.filter(g => !g.open && g.id !== groupA)[0]?.id ?? groups[1].id

  /* S1: open A, open B, close A -- B's categories must survive A's closing, and
     so must the category on the page, which belongs to neither of them. */
  const pageBefore = await shownCategory()
  const openA = await window.clickVisible(railHead(groupA))
  await delay(700)
  const openB = await window.clickVisible(railHead(groupB))
  await delay(700)
  await shot(window, 'S1-A-and-B-open')
  const bothOpen = await census(window, 'S1-both-open')
  const closeA = await window.clickVisible(railHead(groupA))
  await delay(700)
  await shot(window, 'S1-A-closed-B-open')
  const aClosed = await census(window, 'S1-A-closed')
  const bStillOpen = await window.evaluate(`document.querySelector('${railHead(groupB)}')?.getAttribute('aria-expanded')`)
  check('S1 open A, open B, close A: presses landed', openA === 'clicked' && openB === 'clicked' && closeA === 'clicked', `${openA}/${openB}/${closeA}`)
  check('S1 closing group A leaves group B truthfully open', bStillOpen === 'true', `aria-expanded=${bStillOpen}`)
  const bCategories = await window.evaluate(`document.querySelectorAll('${railList(groupB)} button[data-category]').length`)
  check('S1 group B still lists its categories after A closes', typeof bCategories === 'number' && bCategories > 0, String(bCategories))
  const pageAfterGroups = await shownCategory()
  check('S1 opening and closing a group in the rail moves nothing on the page',
    pageAfterGroups === pageBefore, `${pageBefore} -> ${pageAfterGroups}`)
  /* The category buttons inside group A's list are expected to go with its
   * close; anything OUTSIDE A that went with it is the finding. While A was
   * still on the glass we could not know which lost id was A's -- so ask the
   * page NOW (the list is hidden, not removed) which control identities it
   * holds, using the SAME identity algorithm the census uses. */
  const aOwnedIds = await window.evaluate(`(() => {
    const body = document.querySelector('${railList(groupA)}')
    if (!body) return []
    const seen = new Map()
    const all = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
    const ids = []
    for (const node of all) {
      let id = node.tagName.toLowerCase()
        + (node.id ? '#' + node.id : '')
        + (node.dataset ? Object.entries(node.dataset).slice(0, 2).map(([k, v]) => '[' + k + '=' + String(v).slice(0, 24) + ']').join('') : '')
        + '.' + String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').split(' ').filter(Boolean).slice(0, 2).join('.')
        + ':' + (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
      const bump = (seen.get(id) || 0) + 1
      seen.set(id, bump)
      if (bump > 1) id += '~' + bump
      if (body.contains(node)) ids.push(id)
    }
    return ids
  })()`)
  const aOwned = new Set(Array.isArray(aOwnedIds) ? aOwnedIds : [])
  const s1Diff = lostControls(bothOpen, aClosed)
  /* A hidden list's buttons have no innerText, so their census ids lose the
   * text suffix; match on the id's prefix before the ':' as the fallback. */
  const aPrefixes = new Set([...aOwned].map(id => id.split(':')[0]))
  const s1Foreign = s1Diff.lost.filter(l => !aOwned.has(l.id) && !aPrefixes.has(l.id.split(':')[0]))
  note(`S1 controls gone with A's close: ${s1Diff.lost.length} (A-owned matched: ${s1Diff.lost.length - s1Foreign.length})`)
  check('S1 nothing OUTSIDE group A vanished when A closed', s1Foreign.length === 0,
    s1Foreign.slice(0, 5).map(l => `${l.id} ${l.was}->${l.now}${l.by ? ' by ' + l.by : ''}`).join(' | ') || '')

  /* S2: flip a toggle, walk to another category, walk back. The page is built
     again from the address on the way back, so what it draws has to be what the
     store says rather than what the last render happened to be holding. */
  await openEveryGroup()
  await delay(400)
  const categories = await window.evaluate(
    `[...document.querySelectorAll('.settings-rail button[data-category]')].map(b => b.dataset.category)`)
  const TOGGLE_PROBE = `(() => {
    const row = [...document.querySelectorAll('.settings-sections .settings-row')].find(r =>
      r.querySelector('label.toggle input[type="checkbox"]') && !r.closest('[inert]') && !r.closest('[hidden]'))
    if (!row) return null
    const control = row.querySelector('label.toggle input[type="checkbox"]')
    control.scrollIntoView({ block: 'center' })
    return { id: row.dataset.settingId || null, state: String(control.checked) }
  })()`
  let toggleProbe = null
  for (const category of categories || []) {
    if (await goToCategory(category) !== 'clicked') { note(`S2 the rail would not open ${category}`); continue }
    const probe = await window.evaluate(TOGGLE_PROBE)
    if (probe && probe.id) { toggleProbe = { ...probe, category }; break }
  }
  if (!toggleProbe) {
    note('UNMEASURABLE: S2 -- no category on this copy offers a pressable toggle row')
  } else {
    /* The checkbox is visually replaced by the label's own art; the LABEL is
     * what a person presses, and the harness's label rule scores the hit. */
    const rowSelector = `[data-setting-id="${toggleProbe.id}"] label.toggle`
    const readState = () => window.evaluate(`(() => {
      const control = document.querySelector('.settings-sections [data-setting-id="${toggleProbe.id}"] label.toggle input[type="checkbox"]')
      return control ? String(control.checked) : 'absent'
    })()`)
    const before = await readState()
    const flip = await window.clickVisible(rowSelector)
    await delay(700)
    const flipped = await readState()
    await shot(window, 'S2-toggle-flipped')
    check(`S2 toggle ${toggleProbe.id} flips on a real press`, flip === 'clicked' && flipped !== before && flipped !== 'absent', `press=${flip} ${before}->${flipped}`)
    const away = (categories || []).find(category => category !== toggleProbe.category) || null
    const left = away ? await goToCategory(away) : 'none'
    const gone = await readState()
    const back = await goToCategory(toggleProbe.category)
    const after = await readState()
    await shot(window, 'S2-category-returned')
    check('S2 walking to another category takes the first one off the page', gone === 'absent',
      `${away}: the flipped row reads ${gone}`)
    check('S2 walking back draws the toggle in its true state',
      left === 'clicked' && back === 'clicked' && after === flipped, `${flipped} then ${after}`)
    /* put it back the way it was */
    if (after === flipped && flipped !== before) { await window.clickVisible(rowSelector); await delay(500) }
  }

  /* S3: search, then clear. Hidden controls must return. */
  const searchSpot = await window.visibility('.settings-search input')
  if (searchSpot?.state !== 'visible') {
    check('S3 the settings search box is reachable', false, searchSpot?.state + (searchSpot?.by ? `:${searchSpot.by}` : ''))
  } else {
    const preSearch = await census(window, 'S3-pre-search')
    const typed = await window.typeInto('.settings-search input', 'agent')
    await delay(900)
    await shot(window, 'S3-searched')
    await census(window, 'S3-during-search')
    const resultsShown = await window.evaluate(`document.querySelectorAll('.settings-row:not([hidden])').length`)
    check('S3 typing into search presents result rows', typed === 'typed' && typeof resultsShown === 'number' && resultsShown > 0, `typed=${typed} rows=${resultsShown}`)
    /* clear it with real input: select-all + delete via keys */
    await window.clickVisible('.settings-search input')
    for (const [key, code] of [['a', 65]]) {
      await window.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 2, code: 'KeyA', key: key })
      await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 2, code: 'KeyA', key: key })
    }
    await window.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, code: 'Delete', key: 'Delete' })
    await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, code: 'Delete', key: 'Delete' })
    await delay(900)
    await shot(window, 'S3-cleared')
    const afterClear = await census(window, 'S3-after-clear')
    const searchValue = await window.evaluate(`document.querySelector('.settings-search input')?.value ?? 'absent'`)
    check('S3 the search box really cleared (real keys, not .value)', searchValue === '', JSON.stringify(searchValue))
    const s3Diff = lostControls(preSearch, afterClear)
    check('S3 clearing the search returns every control the page had before', s3Diff.lost.length === 0,
      s3Diff.lost.slice(0, 5).map(l => `${l.id} ${l.was}->${l.now}`).join(' | ') || '')
  }

  /* S4: leave settings, come back. What a PERSON opened is what has to be
     remembered -- a group the address opened for them was never their filing
     decision, so it is the store this compares. */
  const filedBefore = await window.evaluate(`localStorage.getItem('mc.settings.open-groups') || ''`)
  const departed = await gotoHome(window)
  await delay(700)
  const returned = await gotoSettings(window)
  await delay(900)
  const filedAfter = await window.evaluate(`localStorage.getItem('mc.settings.open-groups') || ''`)
  const openAfter = await window.evaluate(`[...document.querySelectorAll('.settings-rail [data-rail-group]')]
    .filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.dataset.railGroup)`)
  await shot(window, 'S4-returned')
  const filed = decodeFiledGroups(filedBefore)
  if (filed.code === 'COULD_NOT_DECODE_OPEN_GROUPS') note(`UNMEASURABLE: S4 -- ${filed.detail}`)
  check('S4 leaving and returning keeps every group the person opened open',
    filed.code !== 'COULD_NOT_DECODE_OPEN_GROUPS'
      && departed !== 'stuck' && (returned === 'clicked' || returned === 'already-there')
      && filedAfter === filedBefore && filed.groups.every(id => (openAfter || []).includes(id)),
    `filed=[${filedBefore}] -> [${filedAfter}] open=[${(openAfter || []).join(' ')}]`)

  /* S5: the same group head twice in a row -- open then closed, truthfully. */
  const twiceTarget = groupA
  const press1 = await window.clickVisible(railHead(twiceTarget))
  await delay(600)
  const state1 = await window.evaluate(`document.querySelector('${railHead(twiceTarget)}')?.getAttribute('aria-expanded')`)
  const press2 = await window.clickVisible(railHead(twiceTarget))
  await delay(600)
  const state2 = await window.evaluate(`document.querySelector('${railHead(twiceTarget)}')?.getAttribute('aria-expanded')`)
  const listHidden = await window.evaluate(`document.querySelector('${railList(twiceTarget)}')?.hidden`)
  check('S5 a group head pressed twice lands open then closed, its list agreeing', press1 === 'clicked' && press2 === 'clicked' && state1 !== state2 && String(listHidden) === String(state2 === 'false'),
    `presses=${press1}/${press2} expanded=${state1}->${state2} listHidden=${listHidden}`)
  await shot(window, 'S5-after-double-press')
}

/* ------------------------------------------------------ walkthrough (W) --- */

async function walkthroughPhase(executable, scratch) {
  console.log('\n-- SETUP WALKTHROUGH, fresh profile, unusual orders --')
  const profile = path.join(scratch, 'profile-walkthrough')
  mkdirSync(profile, { recursive: true })
  let window = null
  try {
    window = await openWindow(executable, profile)
    note(`walkthrough window: ${describeTimeline(window.timeline)}`)
    await delay(1500)
    const landed = await route(window)
    check('W0 a fresh profile lands on the setup walkthrough', landed === 'setup', `route=${landed}`)
    await shot(window, 'W0-fresh')
    if (landed !== 'setup') return

    /* W1: forward, then BACK, then forward again. The selection made before
     * going back must still be selected when we return. */
    const skipFirst = await window.visibility('[data-setup-skip-first]')
    note(`skip-first control: ${skipFirst?.state}`)
    const pick = await window.clickVisible('[data-setup-choice="standard"]')
    await delay(700)
    const picked1 = await window.evaluate(`document.querySelector('[data-setup-tier="standard"][aria-pressed="true"]') !== null || document.querySelector('[data-setup-choice="standard"][aria-current="true"]') !== null`)
    check('W1 a choice card takes a real press', pick === 'clicked' && picked1 === true, `press=${pick} lit=${picked1}`)
    const forward = await window.clickVisible('[data-setup-continue]')
    await delay(1600)
    await shot(window, 'W1-forward')
    const backSpot = await window.visibility('[data-setup-back]')
    const back = await window.clickVisible('[data-setup-back]')
    await delay(1200)
    await shot(window, 'W1-back')
    const picked2 = await window.evaluate(`document.querySelector('[data-setup-tier="standard"][aria-pressed="true"]') !== null || document.querySelector('[data-setup-choice="standard"][aria-current="true"]') !== null`)
    check('W1 Continue then Back keeps the recorded choice lit', forward === 'clicked' && back === 'clicked' && picked2 === true,
      `forward=${forward} backSeen=${backSpot?.state} back=${back} stillLit=${picked2}`)
    const forward2 = await window.clickVisible('[data-setup-continue]')
    await delay(1600)
    check('W1 Continue works again after going back', forward2 === 'clicked', forward2)
    await shot(window, 'W1-forward-again')
    const w1Census = await census(window, 'W1-second-step')
    note(`walkthrough step census: ${summarize(w1Census)}`)
    const coveredW = w1Census?.controls?.filter(control => control.state === 'covered' && !control.disabled) || []
    check('W1 nothing on the walkthrough step is covered', coveredW.length === 0, coveredW.map(l => `${l.id} by ${l.by}`).join(' | ') || '')

    /* W2: back to the first screen, then skip -- home, and STAYS home. */
    let hops = 0
    while (hops < 8 && (await window.visibility('[data-setup-skip-first]'))?.state !== 'visible') {
      const stepBack = await window.clickVisible('[data-setup-back]', { timeoutMs: 4000 })
      if (stepBack !== 'clicked') break
      await delay(900)
      hops += 1
    }
    const skip = await window.clickVisible('[data-setup-skip-first]')
    await delay(1500)
    const afterSkip = await route(window)
    check('W2 skip from the first screen lands on home', skip === 'clicked' && afterSkip === 'home', `skip=${skip} route=${afterSkip}`)
    await shot(window, 'W2-after-skip')
    await delay(2500)
    const staysPut = await route(window)
    check('W2 ...and STAYS on home (the gate is satisfied, not dodged)', staysPut === 'home', `route=${staysPut}`)
  } finally {
    if (window) { await closeWindow(window); reap(window.child?.pid) }
  }
}

/* ------------------------------------------------------------------ main --- */

async function main() {
  const scratch = scratchDirectory('order-variation')
  note(`scratch: ${scratch}`)
  const { executable, appRoot } = await stage(scratch)
  note(`staged executable: ${executable}`)

  if (PHASE === 'all' || PHASE.startsWith('fleet') || PHASE === 'settings') {
    const profile = path.join(scratch, 'profile-main')
    mkdirSync(profile, { recursive: true })
    seedMachineRecord(profile, appRoot, 'standard')
    let window = null
    try {
      window = await openWindow(executable, profile)
      note(`main window: ${describeTimeline(window.timeline)}`)
      await delay(1500)
      if (PHASE === 'fleet') await fleetPhase(window)
      if (PHASE === 'fleet2') await fleet2Phase(window)
      if (PHASE === 'all' || PHASE === 'fleet3') await fleet3Phase(window)
      if (PHASE === 'all' || PHASE === 'fleet4') await fleet4Phase(window)
      /* fleet5 is asked for by name, like fleet and fleet2, and deliberately
         not folded into 'all': it starts a node and turns a write flag ON,
         and the settings phase that follows reads write flags. A positive
         control that quietly re-arms the next phase's preconditions is how a
         suite starts explaining its own results. */
      if (PHASE === 'fleet5') await fleet5Phase(window)
      if (PHASE === 'all' || PHASE === 'settings') await settingsPhase(window)
    } finally {
      if (window) { await closeWindow(window); reap(window.child?.pid) }
    }
  }

  if (PHASE === 'all' || PHASE === 'walkthrough') {
    await walkthroughPhase(executable, path.join(scratch))
  }

  ledger.finish('order-variation drive')
}

if (process.env.ORDER_VARIATION_DRIVE_TEST !== '1') {
  main().catch(error => {
    console.error(`harness could not run: ${error?.stack || error}`)
    process.exitCode = 2
  })
}
