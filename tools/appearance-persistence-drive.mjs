#!/usr/bin/env node

/* TWO CONTROLS THAT WERE DRAWN AND DID NOT WORK, DRIVEN ON A PACKAGED BUILD.
 *
 * Found by pressing every control on every screen of the shipped 1.0.20
 * installer, as a person on a fresh install:
 *
 *   1  GLOW INTENSITY AND REDUCE MOTION WERE NEVER WRITTEN DOWN. They are the
 *      only two appearance controls offered on every page (the gear drawer) as
 *      well as on the settings page. Both applied instantly; both were at their
 *      defaults again after the window was closed and opened. Measured: 98 of
 *      the other 100 rows on that page survived the same restart, and nothing
 *      was stored under either name. src/appearance-persistence.js is the
 *      repair and its unit suite owns the storage rules; what this file adds is
 *      the half a unit test cannot reach -- a real window, closed and reopened,
 *      with the choice made by a mouse on the actual controls.
 *
 *   2  THE RESET IN THE RESEARCH PAGE'S "EDIT LAYOUT" COULD NOT BE CLICKED. The
 *      components tray belongs to the shared layout engine and carries
 *      `margin-top: -20px` so it tucks under the METRICS filter row, which is
 *      unpositioned. The research bar is `position: relative` (its modules
 *      popover hangs off it), and a positioned element paints above its
 *      unpositioned siblings -- so on that page the tuck slid the tray
 *      underneath the bar. Measured: bar 453-501, tray 481-517, Reset 490-507,
 *      and document.elementFromPoint at the Reset's own centre returned the
 *      bar. THIS IS THE CLASS OF DEFECT NO SELECTOR-CLICKING HARNESS CAN SEE:
 *      the button is in the DOM, is visible, has a real box, and a mouse cannot
 *      reach it. So every press below reads what is actually under the point
 *      first and reports it.
 *
 * USAGE
 *   node tools/appearance-persistence-drive.mjs             (hidden window)
 *   node tools/appearance-persistence-drive.mjs --visible   (show it)
 *
 * EXIT  0 every check passed · 1 a check failed · 2 the harness could not run.
 */

import { rmSync } from 'node:fs'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  scratchDirectory,
  stage,
} from './test-account-harness.mjs'

const STARTED_AT = Date.now()
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: pass === true, detail: String(detail) })
  console.log(`  ${pass === true ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}
function note(text) { console.log(`  --    ${text}`) }

/* WHAT IS ACTUALLY UNDER THE POINT. A press reaches the target only when the
   hit IS the target or one of its own descendants; an ANCESTOR hit means the
   press is never felt, which is defect 2 exactly. */
const AT = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden') return { state: 'hidden' }
  try { node.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch (error) {}
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'offscreen' }
  const hit = document.elementFromPoint(x, y)
  const name = el => el ? el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : 'nothing'
  const label = hit && hit.closest ? hit.closest('label') : null
  const receives = hit === node || node.contains(hit) || (label && label.control === node)
  if (!receives) return { state: 'covered', by: name(hit), x, y }
  return { state: 'visible', x, y, left: box.x, width: box.width, top: Math.round(box.top), bottom: Math.round(box.bottom) }
}`

async function at(window, selector) {
  return window.evaluate(`(${AT})(${JSON.stringify(selector)})`)
}

/* Waited for and then confirmed still, because a switch changes the height of
   its own guidance text and moves whatever is under the pointer next. */
async function press(window, selector, { timeoutMs = 9000 } = {}) {
  const until = Date.now() + timeoutMs
  let spot = await at(window, selector)
  while (spot?.state !== 'visible' && Date.now() < until) {
    await delay(250)
    spot = await at(window, selector)
  }
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.by ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(220)
    const again = await at(window, selector)
    if (again?.state === 'visible' && Math.abs(again.y - spot.y) < 2) { spot = again; break }
    if (again?.state === 'visible') spot = again
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(50)
  }
  await delay(450)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function readMotion(window, inputSelector, hitSelector) {
  const state = await window.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)})
    return {
      checked: input ? Boolean(input.checked) : null,
      disabled: input ? Boolean(input.disabled) : null,
      bodyClass: document.body.classList.contains('reduce-motion'),
      key: localStorage.getItem('mc.set.reduce_motion'),
      hash: location.hash,
      route: document.body.dataset.route || '',
    }
  })()`)
  return { ...state, hit: await at(window, hitSelector) }
}

/* Dispatching mouse events proves only that CDP accepted them. A switch press
   succeeds when the rendered checkbox actually changes. If layout moved under
   the pointer, take fresh geometry and try once more; a second unchanged read
   is a failed action, never a reported success. */
async function changeMotion(window, { inputSelector, hitSelector, from, to }) {
  const before = await readMotion(window, inputSelector, hitSelector)
  const presses = []
  presses.push(await press(window, hitSelector))
  let after = await readMotion(window, inputSelector, hitSelector)
  if (after.checked === before.checked) {
    presses.push(await press(window, hitSelector))
    after = await readMotion(window, inputSelector, hitSelector)
  }
  return {
    before,
    after,
    presses,
    changed: before.checked === from && after.checked === to,
  }
}

const route = window => window.evaluate('document.body.dataset.route || ""')

/** Walk the ring by pressing the forward arrow, the way a person does. */
async function walkTo(window, wanted, limit = 12) {
  for (let step = 0; step < limit; step += 1) {
    if (await route(window) === wanted) return true
    const pressed = await press(window, '#nav-next')
    if (!pressed.pressed) return false
    const before = await route(window)
    for (let wait = 0; wait < 20; wait += 1) {
      await delay(250)
      if (await route(window) !== before) break
    }
  }
  return await route(window) === wanted
}

/** The first-run questions, answered the way the product recommends. */
async function completeFirstRun(window) {
  for (let step = 0; step < 10; step += 1) {
    if (await route(window) !== 'setup') return
    let pressed = await press(window, '[data-setup-continue]', { timeoutMs: 4000 })
    if (!pressed.pressed) pressed = await press(window, '[data-setup-next]', { timeoutMs: 4000 })
    if (!pressed.pressed) return
    await delay(1800)
  }
}

const APPLIED = `({
  glow: getComputedStyle(document.documentElement).getPropertyValue('--glow').trim(),
  reduceMotion: document.body.classList.contains('reduce-motion'),
  storedGlow: localStorage.getItem('mc.set.glow'),
  storedMotion: localStorage.getItem('mc.set.reduce_motion'),
})`

async function main() {
  const scratch = scratchDirectory('appearance-drive')
  let staged = null
  try {
    staged = await stage(scratch)
  } catch (error) {
    console.error(`the harness could not stage a build: ${error?.message || error}`)
    return 2
  }
  const profile = path.join(scratch, 'profile')
  let window = null
  try {
    console.log('\nGLOW AND REDUCE MOTION, SET FROM THE GEAR DRAWER')
    window = await openWindow(staged.executable, profile)
    await completeFirstRun(window)
    note(`at launch: ${JSON.stringify(await window.evaluate(APPLIED))}`)

    await press(window, '#open-settings')
    await delay(1200)
    /* WAITED FOR, NOT SAMPLED ONCE. The drawer slides in, and a window opened
       with show:false is not compositing, so its transition work is deferred:
       the slider read `offscreen` at 1.2s and was on the glass a second later. */
    let slider = await at(window, '#set-glow')
    for (let wait = 0; wait < 20 && slider?.state !== 'visible'; wait += 1) {
      await delay(300)
      slider = await at(window, '#set-glow')
    }
    if (slider?.state !== 'visible') {
      check('the drawer offers a glow slider', false, `the slider is ${slider?.state}`)
    } else {
      /* A point a fifth of the way along the track, the way a person nudges it. */
      const x = slider.left + slider.width * 0.2
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await window.session.send('Input.dispatchMouseEvent', { type, x, y: slider.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
        await delay(50)
      }
      await delay(500)
      check('the drawer offers a glow slider', true)
    }
    const motionOn = await changeMotion(window, {
      inputSelector: '#set-motion',
      hitSelector: 'label:has(#set-motion), .set-row:has(#set-motion) .toggle',
      from: false,
      to: true,
    })
    note(`reduce motion on: ${JSON.stringify(motionOn)}`)
    const set = await window.evaluate(APPLIED)
    note(`after pressing both: ${JSON.stringify(set)}`)
    check('the drawer writes the glow down', set.storedGlow !== null, `stored ${set.storedGlow}`)
    check('the drawer turns reduce motion on and writes it down',
      motionOn.changed && motionOn.after.disabled === false && motionOn.after.bodyClass === true && motionOn.after.key === 'true',
      JSON.stringify(motionOn))

    await closeWindow(window)
    reap(window.timeline.pid)
    window = null
    await delay(1500)

    console.log('\nTHE SAME PROFILE, OPENED AGAIN')
    window = await openWindow(staged.executable, profile)
    const back = await window.evaluate(APPLIED)
    note(`at launch: ${JSON.stringify(back)}`)
    check('the glow survives a restart', String(set.glow) === String(back.glow), `${set.glow} -> ${back.glow}`)
    check('reduce motion survives a restart', set.reduceMotion === back.reduceMotion, `${set.reduceMotion} -> ${back.reduceMotion}`)

    console.log('\nTHE SETTINGS PAGE READS THE SAME CHOICE')
    if (!await walkTo(window, 'settings')) {
      check('the settings page can be reached by pressing the arrow', false, 'never arrived')
    } else {
      check('the settings page can be reached by pressing the arrow', true)
      await delay(1500)
      /* Glow and reduce motion are two rows on ONE category page, and every
         category is its own page now, so the page is opened by its address
         before the two presses below look for their controls. */
      await window.evaluate(`location.hash = '#/settings?category=motion-effects'`)
      await delay(900)
      const shown = await window.evaluate(`document.querySelector('[data-setting-id="glow"] input[type="range"]')?.value ?? null`)
      check('the settings page shows what the drawer set', String(shown) === String(back.storedGlow), `row ${shown} vs stored ${back.storedGlow}`)
      await delay(1200)
      const off = await changeMotion(window, {
        inputSelector: '[data-setting-id="reduce_motion"] input[type="checkbox"]',
        hitSelector: '[data-setting-id="reduce_motion"] label.settings-toggle',
        from: true,
        to: false,
      })
      note(`reduce motion off: ${JSON.stringify(off)}`)
      check('the settings-page press changes the rendered checkbox from on to off',
        off.changed && off.before.disabled === false && off.after.disabled === false,
        JSON.stringify(off))
      /* THE TWO SURFACES DO NOT COMMIT THE SAME WAY, AND THIS DRIVE USED ONE OF
       * EACH. It turned reduce motion ON in the gear drawer, which writes and
       * applies on the press (src/quick-settings.js:475-479), and then turned it
       * OFF on the settings page, which STAGES every row into a draft and writes
       * only when Save is pressed (src/views/settings.js:1807-1813 stages,
       * :1864-1867 is the only code on that page that removes the key and the
       * class, reached solely from draft.save()). This file never pressed Save.
       *
       * So it reported "turning reduce motion off removes its key and its applied
       * class" FAILED, and then "reduce motion stays off after close and reopen"
       * FAILED -- a two-check accusation that an accessibility setting cannot be
       * switched off, against a product that had not been asked to switch it off.
       * The second failure was worse than a false negative: the unsaved draft
       * arms the page's beforeunload veto (:1403-1411, honoured deliberately by
       * shell/main.cjs:8313-8317), so closeWindow's graceful window.close() could
       * not land and the restart was measured across a SIGKILL.
       *
       * The staged-but-not-saved state is now asserted rather than mistaken for a
       * defect -- the page says "Changes take effect after you save" and that
       * promise is worth a check of its own -- and the durable half is measured
       * after the gesture the product requires. */
      check('a settings-page press alone is staged, and says so instead of applying',
        off.after.bodyClass === true && off.after.key === 'true'
        && await window.evaluate(`document.querySelector('.settings-page')?.dataset.settingsSaveState ?? null`) === 'pending',
        JSON.stringify(off.after))
      const savePress = await press(window, '[data-settings-save]')
      note(`save: ${JSON.stringify(savePress)}`)
      let saved = await readMotion(window, '[data-setting-id="reduce_motion"] input[type="checkbox"]',
        '[data-setting-id="reduce_motion"] label.settings-toggle')
      for (let wait = 0; wait < 20 && saved.key !== null; wait += 1) {
        await delay(300)
        saved = await readMotion(window, '[data-setting-id="reduce_motion"] input[type="checkbox"]',
          '[data-setting-id="reduce_motion"] label.settings-toggle')
      }
      note(`after saving: ${JSON.stringify(saved)}`)
      check('turning reduce motion off removes its key and its applied class',
        saved.bodyClass === false && saved.key === null,
        JSON.stringify(saved))
      check('saving leaves no unsaved settings draft holding the window',
        await window.evaluate(`document.querySelector('.settings-page')?.dataset.settingsSaveState ?? null`) === 'saved',
        await window.evaluate(`document.querySelector('.settings-page')?.dataset.settingsSaveState ?? null`))
    }

    await closeWindow(window)
    reap(window.timeline.pid)
    window = null
    await delay(1500)

    console.log('\nTHE OFF CHOICE, OPENED AGAIN')
    window = await openWindow(staged.executable, profile)
    const offBack = await window.evaluate(APPLIED)
    note(`at launch: ${JSON.stringify(offBack)}`)
    check('reduce motion stays off after close and reopen',
      offBack.reduceMotion === false && offBack.storedMotion === null,
      JSON.stringify(offBack))

    console.log('\nTHE RESET IN THE RESEARCH PAGE\'S EDIT LAYOUT')
    if (!await walkTo(window, 'research')) {
      check('the research page can be reached by pressing the arrow', false, 'never arrived')
    } else {
      check('the research page can be reached by pressing the arrow', true)
      await delay(2500)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await window.evaluate(`Boolean(document.querySelector('.m-editing'))`) === true) break
        await press(window, '[data-research-edit]')
        await delay(1800)
      }
      const geometry = await window.evaluate(`(() => {
        const tray = document.querySelector('.m-tray')
        for (const animation of tray?.getAnimations?.() || []) {
          const timing = animation.effect?.getComputedTiming?.()
          if (!Number.isFinite(timing?.endTime)) continue
          try { animation.finish() } catch {}
        }
        const box = el => el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) } : null
        return {
          editing: Boolean(document.querySelector('.m-editing')),
          tray: box(tray),
          bar: box(document.querySelector('[data-research-bar]')),
          reset: box(document.querySelector('.m-reset')),
        }
      })()`)
      note(`geometry: ${JSON.stringify(geometry)}`)
      check('Edit layout puts the components tray on the page', geometry?.editing === true && geometry?.tray?.bottom > geometry?.tray?.top, JSON.stringify(geometry?.tray))
      check('the tray starts below the bar rather than under it',
        Number(geometry?.tray?.top) >= Number(geometry?.bar?.bottom),
        `tray top ${geometry?.tray?.top} vs bar bottom ${geometry?.bar?.bottom}`)
      const spot = await at(window, '.m-reset')
      check('the Reset is what a mouse finds at the Reset', spot?.state === 'visible', spot?.by ? `covered by ${spot.by}` : String(spot?.state))
      const pressed = await press(window, '.m-reset')
      check('the Reset can be pressed', pressed.pressed, pressed.why || `at ${JSON.stringify(pressed.at)}`)
    }
  } catch (error) {
    console.error(`\nthe harness stopped: ${error?.stack || error}`)
    return 2
  } finally {
    if (window) { await closeWindow(window); reap(window.timeline.pid) }
    if (!process.argv.includes('--keep')) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a window may still hold it */ }
    }
  }

  const failed = checks.filter(entry => !entry.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`)
  for (const entry of failed) console.log(`  FAILED: ${entry.name} -- ${entry.detail}`)
  return failed.length > 0 ? 1 : 0
}

process.exit(await main())
