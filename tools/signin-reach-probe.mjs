#!/usr/bin/env node
/* WHY IS "Open sign-in" ZERO-SIZE, AND IS IT ZERO-SIZE FOR A PERSON TOO?
 *
 * tools/uninstall-reset-packaged-qa.mjs dies at its first step with
 * `sign-in-link:zero-size`. The element is in the DOM
 * (src/fleet-profile-settings.js: `<a class="ctl-btn" href="#/account">`), its
 * own computed style is not display:none / visibility:hidden / opacity:0 --
 * test-account-harness.mjs checks those FIRST and would have said `hidden` --
 * and yet getBoundingClientRect() comes back 0x0.
 *
 * THIS FILE DOES NOT FIX ANYTHING. It measures, because there are four
 * different causes that all produce that one word, and they need four
 * different answers:
 *
 *   1. an ANCESTOR is display:none (a collapsed section), so the child's own
 *      style is innocent and its box is still 0x0;
 *   2. something is painted OVER it (that would read `covered`, not
 *      `zero-size`, but the two get confused in reports so both are measured);
 *   3. the anchor itself collapses -- an inline <a> with no layout;
 *   4. it is an artifact of the harness and a person can click it fine.
 *
 * So: the full ancestor chain is walked and each link reports its own tag,
 * class, `hidden` attribute, `inert`, computed display and box. Whichever
 * ancestor is the FIRST one with a zero box is the one that collapsed the
 * control, and it is named. Belief is not accepted.
 *
 * It also measures the FIRST-RUN QUESTION, which is the one the owner cares
 * about: on a profile that has never been used, how many presses does it take
 * a person who has just installed this to reach sign-in?
 *
 *   node tools/signin-reach-probe.mjs [--visible] [--release <dir>]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  assertIsolated, closeWindow, createLedger, delay, describeTimeline, openWindow,
  releaseDirectory, route, scratchDirectory, seedMachineRecord, stage,
} from './test-account-harness.mjs'

const SIGN_IN = 'a.ctl-btn[href="#/account"]'

/* The ancestor walk. Runs in the page; returns plain data only. */
const CHAIN_FN = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { found: false }
  const describe = el => {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 80),
      id: el.id || null,
      hiddenAttr: el.hasAttribute('hidden'),
      inert: el.hasAttribute('inert'),
      ariaHidden: el.getAttribute('aria-hidden'),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      contentVisibility: style.contentVisibility || null,
      w: Math.round(box.width * 100) / 100,
      h: Math.round(box.height * 100) / 100,
    }
  }
  const chain = []
  let cursor = node
  while (cursor && cursor !== document.documentElement) {
    chain.push(describe(cursor))
    cursor = cursor.parentElement
  }
  return { found: true, chain }
}`

/* What a person sees on the settings page before touching anything. */
const SURFACE_FN = `() => {
  const visible = el => {
    const box = el.getBoundingClientRect()
    return box.width >= 1 && box.height >= 1
  }
  /* THE GROUPS ARE IN THE RAIL. The page draws one category and no container
     around it, so what a first-time person meets is the rail: four group lines,
     the categories under whichever are open, and one category's controls beside
     them. */
  const groups = [...document.querySelectorAll('.settings-rail [data-rail-group-wrap]')].map(wrap => ({
    id: wrap.dataset.railGroupWrap,
    open: wrap.classList.contains('is-open'),
    headText: (wrap.querySelector('[data-rail-group]')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    bodyHidden: wrap.querySelector('.settings-rail-sections')?.hasAttribute('hidden') ?? null,
  }))
  const controls = [...document.querySelectorAll('.settings-sections button, .settings-sections input, .settings-sections select, .settings-sections a')]
  return {
    route: document.body.dataset.route,
    groups,
    controlsInDom: controls.length,
    controlsWithABox: controls.filter(visible).length,
    openGroupsStored: (() => { try { return localStorage.getItem('mc.settings.open-groups') } catch { return 'THREW' } })(),
    footer: (document.querySelector('.settings-footer')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 900),
  }
}`

/* Evidence, never a measurement, AND BOUNDED. Page.captureScreenshot does not
   return under MC_SMOKE_HEADLESS=1 unless the page is driven back to `active`
   first -- and sometimes not even then. session.send has no deadline of its
   own, so an unanswerable capture hangs the whole run on a picture after every
   reading it was illustrating has already been taken. Measured here on the
   first run of this probe: it stopped dead at the first shot with 4 checks
   already passed and no verdict line. Same fix, same reason, as
   tools/node-remove-drive.mjs. */
const SHOT_DEADLINE_MS = 12_000
const withDeadline = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms}ms`)), ms)),
])

/* CAN A PERSON TELL A COLLAPSED HEADING OPENS?
 *
 * Opening one group fixes one symptom; a first-time person still meets five
 * shut ones, and if those read as inert grey text the controls behind them are
 * still hiding harder than they have to. Affordance is not a matter of opinion
 * here -- every signal it could carry is measurable, so all of them are
 * measured and the weak ones are named. */
const AFFORDANCE_FN = `() => {
  const boxOf = el => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } }
  return [...document.querySelectorAll('.settings-rail [data-rail-group-wrap]')].map(group => {
    const head = group.querySelector('[data-rail-group]')
    if (!head) return { id: group.dataset.railGroupWrap, head: 'MISSING' }
    const headStyle = getComputedStyle(head)
    const glyph = head.querySelector('.settings-reveal-glyph')
    const list = group.querySelector('.settings-rail-sections')
    const name = head
    return {
      id: group.dataset.railGroupWrap,
      open: group.classList.contains('is-open'),
      /* a real <button> is keyboard-reachable and announced as pressable */
      tag: head.tagName,
      cursor: headStyle.cursor,
      ariaExpanded: head.getAttribute('aria-expanded'),
      ariaControls: head.getAttribute('aria-controls'),
      headBox: boxOf(head),
      nameColor: name ? getComputedStyle(name).color : null,
      glyph: glyph ? {
        text: glyph.textContent.trim(),
        fontSize: getComputedStyle(glyph).fontSize,
        color: getComputedStyle(glyph).color,
        box: boxOf(glyph),
        ariaHidden: glyph.getAttribute('aria-hidden'),
      } : 'NO GLYPH',
      /* WHAT IS INSIDE A SHUT GROUP, one press away. The main column's group
         head used to PRINT the section names while it was closed, because that
         head was the only thing on screen for that group. The rail holds the
         groups now and the names are the buttons under the head, so the
         question this can still answer is whether they are there to be
         revealed rather than whether they are already drawn. */
      contentsList: list ? { text: list.textContent.trim().slice(0, 90), count: list.querySelectorAll('button[data-category]').length } : 'NO LIST',
    }
  })
}`

async function shoot(window, scratch, name) {
  const file = path.join(scratch, 'shots', `${name}.png`)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    await withDeadline(window.session.send('Page.setWebLifecycleState', { state: 'active' }), SHOT_DEADLINE_MS, 'the lifecycle change')
    const shot = await withDeadline(window.session.send('Page.captureScreenshot', { format: 'png' }), SHOT_DEADLINE_MS, 'the capture')
    const data = shot?.result?.data
    if (!data) return `${name}: the capture answered with no image`
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  } catch (error) {
    return `${name} could not be photographed (${error?.message || error}); the readings stand on their own`
  }
}

/* A real press: move, down, up, at a point already proven to belong to the
   target under elementFromPoint. The shared clickVisible omits the move. */
async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') return spot?.state === 'covered' ? `covered-by-${spot.by}` : (spot?.state || 'unknown')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }
  await delay(450)
  return 'clicked'
}

async function resize(window, width, height = 900) {
  await window.session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  })
  await delay(700)
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('signin-reach-probe')
  const profile = path.join(scratch, 'one-windows-user')
  const evidence = { scratch, measurements: {} }

  const staged = await stage(scratch, releaseDirectory())
  seedMachineRecord(profile, staged.appRoot, 'standard')

  let window = await openWindow(staged.executable, profile)
  try {
    assertIsolated(profile)
    ledger.check('the packaged app launched on a sterile profile', true, describeTimeline(window.timeline))

    /* Reach settings the way the failing driver does: home, gear, all settings.
       Reproduced here rather than imported so a failure inside gotoSettings is
       visible as its own step. */
    const { gotoSettings } = await import('./test-account-harness.mjs')
    const reached = await gotoSettings(window)
    ledger.check('the settings page is reachable', reached === 'clicked' || reached === 'already-there', reached)
    if (reached !== 'clicked' && reached !== 'already-there') {
      ledger.note(`route is ${await route(window)}; the rest of this probe needs the settings page`)
      return ledger.finish('signin-reach-probe')
    }

    // ---- 1. reproduce the reported state, with its own words ----
    const asHarnessSeesIt = await window.visibility(SIGN_IN)
    evidence.measurements.harnessState = asHarnessSeesIt
    ledger.note(`the harness's own visibility verdict on ${SIGN_IN}: ${JSON.stringify(asHarnessSeesIt)}`)

    // ---- 2. WHY. the ancestor chain, first zero-box link named ----
    const chain = await window.evaluate(`(${CHAIN_FN})(${JSON.stringify(SIGN_IN)})`)
    evidence.measurements.chain = chain
    ledger.check('the sign-in anchor exists in the DOM', chain?.found === true, JSON.stringify(chain?.chain?.[0] || null))
    if (chain?.found) {
      const collapsed = chain.chain.filter(link => link.w < 1 || link.h < 1)
      const culprit = chain.chain.find(link => link.display === 'none' || link.hiddenAttr === true)
      ledger.note(`${collapsed.length} of ${chain.chain.length} links in the chain have a zero box`)
      ledger.note(`first link that is display:none or [hidden]: ${culprit ? JSON.stringify(culprit) : 'NONE — the cause is not a collapsed ancestor'}`)
      for (const link of chain.chain) {
        ledger.note(`  ${link.tag}.${link.cls || '-'}${link.id ? '#' + link.id : ''} display=${link.display} hidden=${link.hiddenAttr} inert=${link.inert} box=${link.w}x${link.h}`)
      }
    }

    // ---- 3. what a first-time person is actually looking at ----
    const surface = await window.evaluate(`(${SURFACE_FN})()`)
    evidence.measurements.surface = surface
    ledger.note(`settings page: ${surface?.controlsWithABox}/${surface?.controlsInDom} controls have a box`)
    ledger.note(`remembered open groups in storage: ${surface?.openGroupsStored === null ? 'NOTHING STORED (a first visit)' : surface?.openGroupsStored}`)
    for (const group of surface?.groups || []) {
      ledger.note(`  group ${group.id}: open=${group.open} bodyHidden=${group.bodyHidden} — ${group.headText}`)
    }
    /* THE HEADLINE NUMBER, and it is the product's own sentence rather than
       mine: the footer counts what a person can actually see. "0 shown" was
       what a brand-new person was told before this lane touched anything. */
    ledger.note(`the footer, in the product's own words: "${surface?.footer}"`)
    ledger.check('a first-time person is shown more than nothing on the settings page',
      (surface?.controlsWithABox || 0) > 6 && !/\b0 shown\b/.test(surface?.footer || ''),
      `${surface?.controlsWithABox}/${surface?.controlsInDom} controls have a box; footer says "${surface?.footer}"`)

    /* THE POINT OF THE WHOLE LANE: reachable on arrival, with no press at all. */
    ledger.check('the sign-in control is on the screen when a person ARRIVES, pressing nothing',
      asHarnessSeesIt?.state === 'visible',
      JSON.stringify(asHarnessSeesIt))

    const first = await shoot(window, scratch, 'settings-first-visit-default-width')
    ledger.note(`screenshot: ${first}`)

    // ---- 4. the nesting is kept: one group open, five still shut ----
    const openCount = (surface?.groups || []).filter(group => group.open).length
    ledger.check('exactly one group is open on arrival, so the nesting still buys what it costs',
      openCount === 1, `${openCount} of ${surface?.groups?.length} groups open`)

    // ---- 5. can a person TELL the other five open? ----
    /* Opening one group fixes one symptom. If the five that stay shut read as
       inert grey text, the controls behind them are still hiding harder than
       they have to, and this fix only moved the problem. */
    const affordance = await window.evaluate(`(${AFFORDANCE_FN})()`)
    evidence.measurements.affordance = affordance
    const shut = (affordance || []).filter(group => group.open === false)
    for (const group of shut) {
      ledger.note(`  shut group ${group.id}: <${group.tag}> cursor=${group.cursor} aria-expanded=${group.ariaExpanded} aria-controls=${group.ariaControls ? 'yes' : 'NO'}`)
      ledger.note(`    chevron ${JSON.stringify(group.glyph)}`)
      ledger.note(`    contents preview ${JSON.stringify(group.contentsList)}`)
    }
    ledger.check('every shut group is a real button a keyboard can reach and a reader is told about',
      shut.length > 0 && shut.every(group => group.tag === 'BUTTON' && group.ariaExpanded === 'false' && group.ariaControls),
      `${shut.length} shut groups checked`)
    ledger.check('every shut group shows a pointer cursor, so the pointer says it is pressable',
      shut.every(group => group.cursor === 'pointer'),
      shut.map(group => `${group.id}:${group.cursor}`).join(' '))
    ledger.check('every shut group carries a visible chevron with a real box',
      shut.every(group => group.glyph !== 'NO GLYPH' && group.glyph.box.w >= 1 && group.glyph.box.h >= 1),
      shut.map(group => `${group.id}:${group.glyph === 'NO GLYPH' ? 'none' : group.glyph.text + ' ' + group.glyph.box.w + 'x' + group.glyph.box.h}`).join(' '))
    ledger.check('every shut group holds the names of what is inside it, one press away',
      shut.every(group => group.contentsList !== 'NO LIST' && group.contentsList.count > 0),
      shut.map(group => `${group.id}:${group.contentsList === 'NO LIST' ? 'none' : group.contentsList.count}`).join(' | '))

    // ---- 6. the same question at the widths the owner named ----
    for (const width of [1024, 1440, 1920]) {
      await resize(window, width)
      const at = await window.visibility(SIGN_IN)
      evidence.measurements[`at${width}`] = at
      ledger.check(`the sign-in control is reachable at ${width}px`, at?.state === 'visible',
        `${at?.state}${at?.state === 'covered' ? ' by ' + at.by : ''}`)
      const file = await shoot(window, scratch, `arrival-${width}`)
      ledger.note(`  screenshot: ${file}`)
    }
    await window.session.send('Emulation.clearDeviceMetricsOverride')

    // ---- 7. is search a second route to it? ----
    const typed = await window.typeInto('.settings-search input[type="search"]', 'sign in')
    await delay(900)
    const viaSearch = await window.visibility(SIGN_IN)
    evidence.measurements.viaSearch = { typed, state: viaSearch }
    ledger.note(`typing "sign in" into the settings search: ${typed}; the control is then ${viaSearch?.state}`)
  } finally {
    const timeline = await closeWindow(window)
    evidence.timeline = describeTimeline(timeline)
    mkdirSync(scratch, { recursive: true })
    writeFileSync(path.join(scratch, 'measurements.json'), JSON.stringify(evidence, null, 2), 'utf8')
    console.log(`\nevidence: ${scratch}`)
  }
  return ledger.finish('signin-reach-probe')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
