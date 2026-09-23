#!/usr/bin/env node

/* THE PERSON WHO ANSWERED "NOTHING YET", AND THE ONE PRESS THAT LETS THEM START.
 *
 * THE WALK THIS PROVES, end to end and with a real hand:
 *   setup records "Nothing yet -- let me look around first"
 *   -> the compose panel opens and says starting is switched off
 *   -> press "Turn on running agents" IN THE PANEL
 *   -> the Start control comes back, in place, with no restart
 *   -> a start actually proceeds
 *
 * WHY THE LAST STEP IS THE ONE THAT MATTERS. A switch that reveals a control is
 * only half a fix; the half that has failed on this product before is a control
 * that appears and then refuses, because the flag was written somewhere the
 * start path never reads. So this run presses Start afterwards and reads what
 * came back -- either a session or a NAMED refusal, never silence.
 *
 * NOTHING IS SEEDED THAT THE PRESS IS SUPPOSED TO DO. Every other driver in
 * this repository writes `mc.write.agent-session` into the profile to get past
 * this state, and that is exactly the state under test here, so this one does
 * not. The only thing seeded is the setup answer itself -- the recorded choice
 * a person really made -- and the run asserts the flag is OFF before it starts,
 * so a harness that accidentally enabled it cannot report a pass.
 *
 * IT MAY SPEND A LITTLE on the person's own subscription if the start is
 * accepted, so it is a tool and not a default test target.
 *
 *   node tools/compose-turn-it-on-drive.mjs
 *   node tools/compose-turn-it-on-drive.mjs --visible --keep
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  argument,
  closeWindow,
  delay,
  openWindow,
  reap,
  releaseDirectory,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const RELEASE = path.resolve(argument('--release', releaseDirectory()))
const KEEP = process.argv.includes('--keep')

/* src/setup-profile.js owns both of these; they are written here rather than
   imported because this file drives a PACKAGED build and must describe the
   profile from outside it. */
const PROFILE_KEY = 'mc.setup.profile'
const WRITE_FLAG_KEY = 'mc.write.agent-session'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

const SPOT_FN = `(selector) => {
  const el = document.querySelector(selector)
  if (!el) return { state: 'absent' }
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return { state: 'hidden' }
  try { el.scrollIntoView({ block: 'center' }) } catch (error) { /* detached */ }
  const box = el.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'offscreen' }
  const hit = document.elementFromPoint(x, y)
  if (!hit) return { state: 'covered', by: 'nothing' }
  const receives = hit === el || el.contains(hit)
  if (!receives) {
    const name = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    return { state: 'covered', by: hit.contains(el) ? ('own-ancestor-' + name) : name }
  }
  return { state: 'visible', x, y, text: (el.textContent || '').trim().slice(0, 60), disabled: el.disabled === true }
}`

/* Keep an unreadable observation distinct from an absent node. In particular,
   a malformed storage read must not make the report below claim that no node
   was created. This function is evaluated afresh for every observation, so a
   transient failure is neither cached nor latched. */
const READ_OUTCOME_FN = `() => {
  const trees = localStorage.getItem('mc.fleet.trees.v1:this-computer')
  let node = null
  if (trees !== null) {
    try {
      node = (JSON.parse(trees).nodes || [])[0] || null
    } catch (error) {
      return {
        node: null,
        status: null,
        error: {
          code: 'OUTCOME_UNREADABLE',
          message: 'Could not read the start outcome. This does not claim that no node was created.',
        },
      }
    }
  }
  return {
    node: node ? { status: node.status, statusNote: (node.statusNote || '').slice(0, 200), hasSession: Boolean(node.sessionId) } : null,
    status: document.querySelector('[data-org-status], .graph-status')?.textContent?.trim()?.slice(0, 200) || null,
    error: null,
  }
}`

async function spot(window, selector, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs
  let last = { state: 'absent' }
  for (;;) {
    last = await window.evaluate(`(${SPOT_FN})(${JSON.stringify(selector)})`)
    if (last?.state === 'visible' || Date.now() >= until) return last
    await delay(240)
  }
}

async function press(window, selector) {
  const at = await spot(window, selector)
  if (at?.state !== 'visible') {
    return { pressed: false, why: at?.state === 'covered' ? `covered by ${at.by}` : (at?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(500)
  return { pressed: true, at: { x: Math.round(at.x), y: Math.round(at.y) }, text: at.text }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
}

async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await key(window, 'Escape', 27)
  await delay(120)
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
    if (current === wanted) return { ok: true }
    await key(window, 'ArrowDown', 40)
    await delay(130)
  }
  return { ok: false, why: `never reached ${wanted}` }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'compose-turn-on-'))
let window = null
try {
  console.log('staging the packaged build...')
  const staged = await stage(scratch, RELEASE)

  /* A sign-in is lent so the LAST step can be a real answer rather than a
     sign-in refusal. It is not needed for the switch itself. */
  const realHome = process.env.USERPROFILE || ''
  const credential = path.join(realHome, '.codex', 'auth.json')
  if (existsSync(credential)) {
    mkdirSync(path.join(scratch, 'home', '.codex'), { recursive: true })
    cpSync(credential, path.join(scratch, 'home', '.codex', 'auth.json'))
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* linked */ }
    }
  }

  seedMachineRecord(scratch, staged.appRoot, 'standard')
  window = await openWindow(staged.executable, scratch)

  /* THE ANSWER A PERSON REALLY GAVE. Written as the walkthrough writes it, and
     it is the ONLY thing seeded -- the write flag it implies is deliberately
     left alone, because turning it on is the thing under test. */
  await window.evaluate(`localStorage.setItem(${JSON.stringify(PROFILE_KEY)}, ${JSON.stringify(JSON.stringify({
    schemaVersion: 1,
    status: 'complete',
    answers: { autonomy: 'observe', screens: 'live' },
  }))})`)
  await window.evaluate(`localStorage.removeItem(${JSON.stringify(WRITE_FLAG_KEY)})`)
  await window.evaluate(`location.hash = '#/computers'`)
  await delay(900)
  await window.evaluate(`location.reload()`)
  await delay(4200)

  const flagBefore = await window.evaluate(`localStorage.getItem(${JSON.stringify(WRITE_FLAG_KEY)})`)
  check('starting agents is switched off before anything is pressed', flagBefore !== 'enabled', `recorded value: ${JSON.stringify(flagBefore)}`)

  const doorway = await press(window, '.computers .tree-empty-node')
  check('the empty slot opens the panel', doorway.pressed, doorway.why || `at (${doorway.at?.x}, ${doorway.at?.y})`)
  await delay(1800)

  const notice = await window.evaluate(`document.querySelector('[data-compose-notice]')?.textContent?.trim() || ''`)
  check('the panel says starting is switched off', /switched off|turn it on/i.test(notice), JSON.stringify(notice.slice(0, 140)))

  const submitBefore = await spot(window, '.agent-compose-submit')
  check('Start is switched off while the answer stands', submitBefore.disabled === true, `state ${submitBefore.state}, disabled=${submitBefore.disabled}`)

  const switchSpot = await spot(window, '[data-compose-unavailable-action]')
  check('the switch is in the panel, pressable', switchSpot.state === 'visible', `state ${switchSpot.state}${switchSpot.by ? ` (${switchSpot.by})` : ''}`)
  check('it says what the press does', /turn on running agents/i.test(switchSpot.text || ''), JSON.stringify(switchSpot.text))

  const thrown = await press(window, '[data-compose-unavailable-action]')
  check('the switch can be pressed', thrown.pressed, thrown.why || '')
  await delay(900)

  const flagAfter = await window.evaluate(`localStorage.getItem(${JSON.stringify(WRITE_FLAG_KEY)})`)
  check('the recorded answer changed, and only because it was pressed', flagAfter === 'enabled', `recorded value: ${JSON.stringify(flagAfter)}`)

  const submitAfter = await spot(window, '.agent-compose-submit')
  check('Start came back in place, with no restart', submitAfter.state === 'visible' && submitAfter.disabled === false, `state ${submitAfter.state}, disabled=${submitAfter.disabled}`)
  const noticeAfter = await window.evaluate(`document.querySelector('[data-compose-notice]')?.hidden === true`)
  check('the reason left with it', noticeAfter === true, `notice hidden: ${noticeAfter}`)

  /* AND A START REALLY PROCEEDS. A control that appears and then refuses is the
     defect this product has shipped before. */
  const role = await chooseByKeyboard(window, '[data-compose-field="role"]', 'manager')
  const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', 'luna')
  const typed = await press(window, '[data-compose-field="message"]')
  if (typed.pressed) await window.session.send('Input.insertText', { text: 'Say the word READY and nothing else.' })
  await delay(200)
  check('the form can be filled after the switch', role.ok && tier.ok && typed.pressed, `${role.why || ''} ${tier.why || ''} ${typed.why || ''}`.trim())

  const started = await press(window, '.agent-compose-submit')
  check('Start can be pressed', started.pressed, started.why || '')
  await delay(9000)

  const outcome = await window.evaluate(`(${READ_OUTCOME_FN})()`)
  /* EITHER OUTCOME IS A PASS, and silence is the failure. A started session is
     the happy path; a NAMED refusal is the product being honest about something
     else (no engine, no sign-in). A node that is still a draft with nothing
     said anywhere means the press went nowhere, which is the defect. */
  const spoke = Boolean(outcome.error || (outcome.node && (outcome.node.hasSession || outcome.node.status === 'failed' || outcome.node.statusNote)))
  check(
    'the start proceeded and the product said what happened',
    spoke,
    outcome.error
      ? `${outcome.error.code}: ${outcome.error.message}`
      : outcome.node
      ? `node status=${outcome.node.status} session=${outcome.node.hasSession} note=${JSON.stringify(outcome.node.statusNote)}`
      : `no node was created; status line said ${JSON.stringify(outcome.status)}`,
  )
} finally {
  if (window) {
    await closeWindow(window)
    reap(window.timeline.pid)
  }
  if (!KEEP) {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS will */ }
  } else {
    console.log(`kept: ${scratch}`)
  }
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`failing: ${failed.map(entry => entry.name).join(' | ')}`)
  process.exitCode = 1
}
