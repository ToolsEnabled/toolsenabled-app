#!/usr/bin/env node
/* CAN A PERSON PRESS "all settings →" IN THE DRAWER, ON THE SETTINGS ROUTE?
 *
 * THE COMPLAINT, PUT THE WAY A CUSTOMER WOULD PUT IT. You are on the settings
 * page. You press the gear, the drawer slides in, and at the bottom of it is a
 * link that says "all settings →". You press it and the drawer just closes --
 * because the floating "some screens show example data" notice is painted on
 * top of that exact corner and swallowed the press.
 *
 * WHY THE OBVIOUS PROOF IS NOT A PROOF. Both the notice and the link are
 * anchors pointing at `#/settings`, and pressing anywhere outside the drawer
 * closes the drawer as well. So "the drawer closed" and "the address is
 * #/settings" are true whichever of the two took the press: neither
 * distinguishes the fixed product from the broken one. The only thing that
 * does is WHICH ELEMENT the press landed on, so this driver records the click
 * target from a capture listener on the document and dispatches a real
 * `Input.dispatchMouseEvent` at the link's own centre.
 *
 * AND IT PROVES THE RULE IS LOAD-BEARING, NOT LUCK. A run that only sees the
 * link on top cannot tell a fix from a notice that happened not to be showing.
 * So the same point is measured twice in the same window: once with the
 * suppression rule live, and once with the notice forced back on top by an
 * injected `display:block !important` -- the original defect, reproduced on
 * demand. If the forced pass does not land on the notice, this driver says so
 * rather than claiming a fix it did not test.
 *
 *   node tools/settings-drawer-link-qa.mjs [--visible] [--release <dir>]
 */

import path from 'node:path'

import {
  VISIBLE, closeDrawer, closeWindow, createLedger, delay, describeTimeline, drawerIsOpen,
  gotoSettings, openDrawer, openWindow, releaseDirectory, route, scratchDirectory,
  seedMachineRecord, stage, writeEvidence,
} from './test-account-harness.mjs'

const LINK = '.drawer-all'
const NOTICE = '.fleet-profile-notice'

/* The centre of the link, in viewport coordinates, plus what the browser says
   is actually at that point. One evaluate so the box and the hit test cannot
   disagree about which frame they were taken in. */
const PROBE_FN = `(linkSelector, noticeSelector) => {
  const link = document.querySelector(linkSelector)
  if (!link) return { state: 'absent' }
  const box = link.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = document.elementFromPoint(x, y)
  const notice = document.querySelector(noticeSelector)
  const name = node => node
    ? node.tagName + (node.className ? '.' + String(node.className).split(' ').join('.') : '')
    : 'nothing'
  const rect = node => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  return {
    state: 'measured',
    x, y,
    viewport: { w: innerWidth, h: innerHeight },
    /* The drawer slides in over ~1.5s in a window that starts life not
       compositing, and it is parked entirely off the right edge until it
       arrives. A point outside the viewport hit-tests as nothing, which is a
       fact about the transition, not about the stacking -- so every
       measurement below waits for this to be true before it means anything. */
    inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
    link: rect(link),
    hit: name(hit),
    hitIsLink: Boolean(hit && (hit === link || link.contains(hit) || hit.contains(link))),
    noticePresent: Boolean(notice),
    noticeDisplay: notice ? getComputedStyle(notice).display : null,
    noticeZ: notice ? getComputedStyle(notice).zIndex : null,
    noticeRect: notice ? rect(notice) : null,
    drawerZ: (() => { const d = document.querySelector('#drawer'); return d ? getComputedStyle(d).zIndex : null })(),
  }
}`

/* The recorder. Capture phase on the document, so it sees the press before any
   handler can stop it, and it records the ELEMENT rather than the outcome. */
const RECORDER = `(() => {
  window.__linkProbe = null
  if (!window.__linkProbeInstalled) {
    window.__linkProbeInstalled = true
    document.addEventListener('click', event => {
      const t = event.target
      window.__linkProbe = {
        tag: t.tagName,
        cls: String(t.className || ''),
        href: t.getAttribute ? t.getAttribute('href') : null,
        text: String(t.textContent || '').trim().slice(0, 48),
      }
    }, true)
  }
  return true
})()`

/* Measure once the drawer has finished arriving, not once it has been asked to.
   Returns the last reading either way, so a drawer that never lands is reported
   as that rather than as a covered link. */
async function settled(window, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await window.evaluate(`(${PROBE_FN})(${JSON.stringify(LINK)}, ${JSON.stringify(NOTICE)})`)
    if (last?.inViewport === true || Date.now() >= until) return last
    await delay(250)
  }
}

async function pressAt(window, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  await delay(120)
}

function overlaps(a, b) {
  if (!a || !b) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('settings-drawer-link-qa')
  const profile = path.join(scratch, 'profile')
  let window = null
  const started = Date.now()

  console.log(`release  : ${releaseDirectory()}`)
  console.log(`scratch  : ${scratch}`)
  console.log(`mode     : ${VISIBLE ? 'VISIBLE (control run)' : 'headless'}`)

  try {
    const { executable, appRoot } = await stage(scratch)
    seedMachineRecord(profile, appRoot, 'standard')

    window = await openWindow(executable, profile)
    ledger.check('the packaged application opens', window.timeline.windowAt !== null,
      describeTimeline(window.timeline))

    /* ------- FIRST, A SCREEN THE SETTINGS PAGE HAS NEVER BEEN OPENED FROM ---
     *
     * THE ABSENCE CASE FOR THE FIX ITSELF. The rule that suppresses the notice
     * lives in `src/settings.css`, which is imported by the settings, account
     * and setup views. If the build ever splits those views into their own
     * stylesheet, the rule would arrive only after somebody had already visited
     * one of them -- and the drawer would be un-pressable on every screen until
     * they did, which is the state a new customer is in. So the first press of
     * this run happens on a screen reached from the ring, before the settings
     * page has ever been mounted in this window. */
    await window.evaluate(RECORDER)
    let virginRoute = null
    let virginProbe = null
    for (let step = 0; step < 8; step += 1) {
      if ((await window.clickVisible('#nav-next')) !== 'clicked') break
      await delay(450)
      const here = await route(window)
      const shown = await window.evaluate(
        `(() => { const n = document.querySelector('${NOTICE}'); return n ? getComputedStyle(n).display : null })()`)
      if (shown && shown !== 'none') { virginRoute = here; break }
    }
    ledger.check('there is a screen other than settings where the floating notice shows, reachable before settings is ever opened',
      virginRoute !== null, virginRoute ? `route=${virginRoute}` : 'the notice showed on no ring stop')
    /* WHERE THE OVERLAP IS NOW MEASURED. The two boxes used to be compared on
       the SETTINGS route, and that premise has since been made false on purpose
       -- see the check below. The overlap the owner reported is a property of
       the notice and the drawer's link, not of any one route, so it is measured
       on the route where the notice genuinely paints. */
    const virginNoticeRect = virginRoute
      ? await window.evaluate(`(() => { const n = document.querySelector('${NOTICE}'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
      : null
    if (virginRoute) {
      await openDrawer(window)
      virginProbe = await settled(window)
      await window.evaluate('window.__linkProbe = null')
      await pressAt(window, virginProbe.x, virginProbe.y)
      await delay(900)
      const virginPress = await window.evaluate('window.__linkProbe')
      const virginHash = await window.evaluate('location.hash')
      ledger.check(`the notice and the drawer link really do occupy the same corner on ${virginRoute}`,
        overlaps(virginProbe.link, virginNoticeRect),
        `link ${JSON.stringify(virginProbe.link)} notice ${JSON.stringify(virginNoticeRect)} notice z=${virginProbe.noticeZ} drawer z=${virginProbe.drawerZ}`)
      ledger.check(`the link takes the press on ${virginRoute} too, with the settings page never yet opened`,
        Boolean(virginPress) && String(virginPress.cls).includes('drawer-all') && virginHash === '#/settings',
        `hit=${virginProbe.hit} press=${virginPress ? `${virginPress.tag}.${virginPress.cls}` : 'nothing'} hash=${virginHash}`)
    }
    await closeDrawer(window)

    const reached = await gotoSettings(window)
    const landed = await route(window)
    ledger.check('the settings route is reached by clicking only', landed === 'settings',
      `${reached} -> route=${landed}`)

    /* WHAT THIS PAIR OF CHECKS USED TO SAY, AND WHY IT IS WRONG NOW.
     *
     * They read "the floating fleet-profile notice is on screen on the settings
     * route with the drawer closed" and "the two really do occupy the same
     * corner". Both were PREMISE checks: they established the overlap this file
     * exists to be about, on the route it was first reported from. src/settings.css
     * now suppresses the notice on that route outright (2047fd2) --
     * `body[data-route="settings"] .fleet-profile-notice { display: none }` --
     * for the reason written beside the rule: the notice's own href points at
     * #/settings, so on that route "it is a nag standing on its own destination",
     * and the owner's screenshot showed it painting semi-transparently over the
     * System section's "Your account" row and swallowing that row's clicks.
     *
     * So the premise is now measured where it is still true (the virgin route
     * above), and what is asserted here is the suppression itself -- PRESENT in
     * the document and display:none, not merely absent. The distinction is the
     * whole of it: a notice that stopped being rendered on this route would pass
     * an "is it out of the way" check while having lost its own state, and the
     * rule under test is a display rule, not a deletion. */
    const beforeOpen = await window.evaluate(
      `(() => { const n = document.querySelector('${NOTICE}'); return n ? { display: getComputedStyle(n).display, text: (n.textContent||'').trim().slice(0,60) } : null })()`)
    ledger.check('the floating notice is suppressed on the settings route, because that is where its own link points',
      beforeOpen !== null && beforeOpen.display === 'none',
      beforeOpen ? `display=${beforeOpen.display} "${beforeOpen.text}"` : 'the notice is not in the document at all, so the rule under test is not what is hiding it')

    /* ---------------- the gesture, with the product as it ships ------------- */
    await window.evaluate(RECORDER)
    const opened = await openDrawer(window)
    ledger.check('the settings drawer opens on the settings route', await drawerIsOpen(window), opened)

    const live = await settled(window)
    ledger.check('the drawer finishes sliding in, so its link is inside the window',
      live.inViewport === true, `link box ${JSON.stringify(live.link)} in ${JSON.stringify(live.viewport)}`)
    ledger.note(`link box ${JSON.stringify(live.link)}  (the overlap premise is measured on ${virginRoute}, above)`)
    ledger.check('with the drawer open, the point at the centre of "all settings" belongs to the link, not to the notice',
      live.hitIsLink === true, `elementFromPoint -> ${live.hit}`)
    ledger.check('the notice is suppressed for exactly the span the drawer is open',
      live.noticePresent === true && live.noticeDisplay === 'none',
      `present=${live.noticePresent} display=${live.noticeDisplay}`)

    /* THE SERIOUS VARIANT, WHICH IS THE ONE THAT COULD HAVE BEEN LEFT BEHIND.
       Three other rules in this product suppress this notice with
       `:not(.is-serious)` -- correctly, because a real profile failure must not
       be hidden by a route. If the drawer rule had been written the same way by
       reflex, the customer whose profile is broken would be the one who cannot
       press the link. Measured, not assumed. */
    const serious = await window.evaluate(
      `(() => { const n = document.querySelector('${NOTICE}'); if (!n) return null; n.classList.add('is-serious'); return getComputedStyle(n).display })()`)
    const seriousProbe = await settled(window)
    await window.evaluate(
      `(() => { const n = document.querySelector('${NOTICE}'); if (n) n.classList.remove('is-serious'); return true })()`)
    ledger.check('a SERIOUS notice is suppressed by the open drawer too, so a broken profile does not cost the customer the link',
      serious === 'none' && seriousProbe.hitIsLink === true,
      `display=${serious} elementFromPoint -> ${seriousProbe.hit}`)

    await window.evaluate('window.__linkProbe = null')
    await pressAt(window, live.x, live.y)
    await delay(700)
    const pressed = await window.evaluate('window.__linkProbe')
    const afterHash = await window.evaluate('location.hash')
    const drawerAfter = await drawerIsOpen(window)
    ledger.check('a real mouse press at that point is received by the "all settings" link itself',
      Boolean(pressed) && String(pressed.cls).includes('drawer-all'),
      pressed ? `${pressed.tag}.${pressed.cls} href=${pressed.href} "${pressed.text}"` : 'nothing received the press')
    ledger.check('pressing it does what the link says: settings, and the drawer gets out of the way',
      afterHash === '#/settings' && drawerAfter === false,
      `hash=${afterHash} drawerOpen=${drawerAfter}`)

    /* ---------------- the same point, with the defect put back -------------- */
    /* WITHOUT THIS THE RUN ABOVE PROVES NOTHING. A notice that is simply not
       showing would pass every check above while the stacking was untouched. */
    await openDrawer(window)
    await settled(window)
    await window.evaluate(
      `(() => { const s = document.createElement('style'); s.id = 'link-probe-control'; s.textContent = '${NOTICE}{display:block !important}'; document.head.appendChild(s); return true })()`)
    await delay(400)
    const forced = await settled(window)
    await window.evaluate('window.__linkProbe = null')
    await pressAt(window, forced.x, forced.y)
    await delay(700)
    const forcedPress = await window.evaluate('window.__linkProbe')
    await window.evaluate(`(() => { const s = document.getElementById('link-probe-control'); if (s) s.remove(); return true })()`)
    ledger.check('CONTROL: force the notice back on top and the same press lands on the notice instead',
      forced.hitIsLink === false && Boolean(forcedPress) && String(forcedPress.cls).includes('fleet-profile-notice'),
      `elementFromPoint -> ${forced.hit}; press -> ${forcedPress ? `${forcedPress.tag}.${forcedPress.cls}` : 'nothing'}`)

    /* ---------------- and once more, as it ships, to close the loop --------- */
    await closeDrawer(window)
    await delay(400)
    await openDrawer(window)
    const again = await settled(window)
    await window.evaluate('window.__linkProbe = null')
    await pressAt(window, again.x, again.y)
    await delay(700)
    const againPress = await window.evaluate('window.__linkProbe')
    ledger.check('with the control removed the link takes the press again (the suppression rule is what does it)',
      again.hitIsLink === true && Boolean(againPress) && String(againPress.cls).includes('drawer-all'),
      `elementFromPoint -> ${again.hit}; press -> ${againPress ? `${againPress.tag}.${againPress.cls}` : 'nothing'}`)

    writeEvidence(scratch, 'measurements.json', {
      route: landed, live, forced, again, virginRoute, virginNoticeRect, pressed, forcedPress, againPress,
    })
  } finally {
    if (window) await closeWindow(window)
  }

  ledger.finish(`${Math.round((Date.now() - started) / 1000)}s`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
