'use strict'

/* PROOF THAT THE STEERING TRIO'S NEW PRESS MECHANISM ACTUALLY DISCRIMINATES
 * A REACHABLE CONTROL FROM ONE A PERSON CANNOT PRESS.
 *
 * tools/steering-controls-e2e.cjs and tools/recommended-path-packaged-qa.mjs
 * were converted from `document.querySelector('[data-control="X"]').click()`
 * to real dispatched input (Electron's webContents.sendInputEvent / CDP's
 * Input.dispatchMouseEvent) with a pre-press elementFromPoint reachability
 * proof.
 * Both files' full runs spend real provider tokens on a real Codex
 * conversation (a multi-minute "count to 300" / "reply PONG" turn) to reach
 * the point where Pause/Respawn/Terminate are actually pressable, which makes
 * repeating a full run under mutation -- the refutation this class of change
 * needs -- an expensive way to prove something that has nothing to do with
 * token spend: whether the REACHABILITY CHECK ITSELF can tell a person-
 * pressable control from one of the six shapes the doctrine names that a
 * synthetic .click() cannot see.
 *
 * So this file answers exactly that question, cheaply: it boots the real app
 * (same shell/main.cjs this checkout ships, same as steering-controls-e2e.cjs)
 * -- seconds, no agent, no token spend -- and injects seven synthetic
 * [data-control]-shaped buttons on the live agent page: one genuinely
 * reachable, and one for each of display:none, visibility:hidden,
 * pointer-events:none, zero-size, off-viewport, and covered-by-an-overlay.
 * It presses all seven with the SAME pressReal() this file duplicates
 * (verbatim) from tools/steering-controls-e2e.cjs's own converted mechanism,
 * and requires each of the six defective ones to be refused BY NAME and the
 * seventh to be genuinely clicked -- verified by a real click counter, not by
 * the press function's own say-so.
 *
 * WHAT THIS DOES NOT PROVE, ON PURPOSE: that Pause/Respawn/Terminate's own
 * handlers correctly steer a real session. That is the two QA files' job,
 * unchanged by this file, and it is why this file's report notes that those
 * two were each run live, once, to completion rather than under mutation.
 *
 * Verified by exit code. Any failed step exits non-zero.
 */

const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { reapDescendants } = require('./process-tree.cjs')

const APP_ROOT = process.env.MC_APP_ROOT || path.resolve(__dirname, '..')
const TIMEOUT_MS = 60_000

if (process.env.MC_RESOURCES_PATH && process.env.MC_RESOURCES_PATH.trim() !== '') {
  try {
    Object.defineProperty(process, 'resourcesPath', {
      value: path.resolve(process.env.MC_RESOURCES_PATH),
      configurable: true,
      writable: false,
      enumerable: true,
    })
  } catch (error) {
    console.error('[reachability] could not point resourcesPath at the packaged payload: ' + error.message)
  }
}

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
  if (reaped > 0) console.log(`[reachability] reaped ${reaped} descendant process(es) before exit`)
  app.exit(code)
}

function fatal(message) {
  console.error('REACHABILITY FATAL: ' + message)
  finish(20)
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

require(path.join(APP_ROOT, 'shell', 'main.cjs'))

async function windowReady() {
  const deadline = Date.now() + 30_000
  for (;;) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within 30s')
    await settle(250)
  }
}

/* VERBATIM FROM tools/steering-controls-e2e.cjs, so this file proves the
 * EXACT mechanism that file presses the steering trio with -- not a
 * reimplementation that could quietly drift from what actually ships in the
 * converted QA harness. */
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

/* The seven rigs, each a [data-control]-shaped button with a click counter on
 * `window.__reach` so a false 'clicked' verdict (the press function lying
 * about having pressed something) is caught independently of press()'s own
 * return value. Built with a REAL overlay for the covered case -- an actual
 * element sitting on top in z-order, not a claim about one -- because that is
 * the one BOUNDING BOX ALONE (a geometry sweep, per the doctrine's own second
 * measured instance) cannot see either. */
const BUILD_RIGS = `(() => {
  window.__reach = { clicks: {} }
  const host = document.createElement('div')
  host.id = '__reach-host'
  document.body.appendChild(host)
  /* Each rig gets its OWN, non-overlapping fixed position. Sharing one spot
     across rigs was tried first and was wrong: elementFromPoint resolves the
     TOPMOST-PAINTED element at a point, so two normally-visible buttons
     stacked at the same coordinates would make elementFromPoint(reach-ok's
     own box) answer with whichever sibling paints on top, reporting reach-ok
     as "covered" by a defect of this rig's own layout, not of the mechanism
     being proven. */
  /* MAX Z-INDEX, MEASURED NECESSARY. The first draft used zIndex:1 and
     reach-ok -- otherwise unmodified -- came back covered-by-DIV: this
     product's own home-page chrome paints something over the top-left
     region at a z-index this rig had not out-ranked. A rig meant to prove
     "genuinely reachable" has to actually be on top of the real page, not
     merely present in its DOM -- which is exactly the distinction the
     doctrine draws between elementFromPoint and a bounding box. */
  const TOP_Z = 2147483647
  let row = 0
  const nextTop = () => { const top = 20 + row * 50; row += 1; return top }
  const make = (id, style) => {
    const top = nextTop()
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('data-control', id)
    b.textContent = id
    b.addEventListener('click', () => { window.__reach.clicks[id] = (window.__reach.clicks[id] || 0) + 1 })
    Object.assign(b.style, {
      position: 'fixed', left: '20px', top: top + 'px', width: '80px', height: '30px',
      zIndex: String(TOP_Z), margin: '0', padding: '0', border: '0', minWidth: '0', minHeight: '0',
    }, style)
    host.appendChild(b)
    return { node: b, top }
  }
  make('reach-ok', {})
  make('reach-display-none', { display: 'none' })
  make('reach-visibility-hidden', { visibility: 'hidden' })
  make('reach-pointer-events-none', { pointerEvents: 'none' })
  /* min-width/min-height:0 above is what makes this one actually zero: a
     bare width:0;height:0 on a <button> measured non-zero here first --
     Chromium's UA stylesheet gives form controls an intrinsic minimum size
     that explicit width/height alone does not override. */
  make('reach-zero-size', { width: '0px', height: '0px' })
  make('reach-offscreen', { left: (innerWidth + 500) + 'px' })
  const covered = make('reach-covered', {})
  /* The overlay sits exactly over reach-covered's own box, at the SAME max
     z-index as every rig (2147483647 is the top of the valid CSS range;
     asking for one more would be an out-of-range value browsers are free to
     clamp or ignore). Equal z-index ties break on DOM order, and the overlay
     is appended after every rig including reach-covered, so it alone wins
     the tie at that one spot while every other rig -- painted with nothing
     appended after it at its own position -- is unaffected. */
  const overlay = document.createElement('div')
  overlay.id = '__reach-overlay'
  Object.assign(overlay.style, { position: 'fixed', left: '20px', top: covered.top + 'px', width: '80px', height: '30px', zIndex: String(TOP_Z), background: 'transparent' })
  document.body.appendChild(overlay)
  return true
})()`

const REMOVE_RIGS = `(() => {
  document.getElementById('__reach-host')?.remove()
  document.getElementById('__reach-overlay')?.remove()
  delete window.__reach
  return true
})()`

async function run() {
  const win = await windowReady()
  const js = code => win.webContents.executeJavaScript(code, true)
  const pressReal = await makePresser()
  const press = selector => pressReal(win, js, selector, 3_000)

  step('the real app window loaded', true, await js('document.title'))
  await js(BUILD_RIGS)

  try {
    /* Exact strings match FLEET_NODE_VISIBLE's own naming
       (`hit.tagName + '.' + firstClass`, tagName uppercase, no class on the
       plain <div> overlay here so it names just 'DIV'). reach-pointer-events-
       none is checked loosely on purpose: CSS pointer-events:none makes
       elementFromPoint skip straight to whatever paints underneath it, which
       is the surrounding page chrome, not a rig this file controls -- the
       claim this case exists to prove is only that it is NOT treated as
       reachable, not which element elementFromPoint happens to name instead. */
    const cases = [
      ['reach-ok', spot => spot === 'clicked'],
      ['reach-display-none', spot => spot === 'hidden'],
      ['reach-visibility-hidden', spot => spot === 'hidden'],
      ['reach-pointer-events-none', spot => spot !== 'clicked' && spot !== 'absent'],
      ['reach-zero-size', spot => spot === 'zero-size'],
      ['reach-offscreen', spot => spot === 'offscreen'],
      ['reach-covered', spot => spot === 'covered-by-DIV'],
    ]
    for (const [id, matches] of cases) {
      const result = await press(`[data-control="${id}"]`)
      const clicks = await js(`window.__reach.clicks['${id}'] || 0`)
      if (id === 'reach-ok') {
        step(`${id}: a genuinely reachable control is pressed for real`,
          matches(result) && clicks === 1, `press()=${result} clicks=${clicks}`)
      } else {
        step(`${id}: refused, and the button never actually felt the press`,
          matches(result) && clicks === 0, `press()=${result} clicks=${clicks}`)
      }
    }
  } finally {
    await js(REMOVE_RIGS)
  }
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
    console.error('REACHABILITY ERROR:', error && error.stack ? error.stack : error)
    finish(21)
  }
})
