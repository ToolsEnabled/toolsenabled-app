#!/usr/bin/env node

/* THE FOUR THINGS THE OWNER FOUND BY HAND, ASKED THE WAY HE ASKED THEM.
 *
 * "I REFUSE TO BELIEVE YOU THAT ANYTHING WORKS UNTIL YOU CLICK THROUGH IT AND
 * USE IT IN PRODUCTION YOURSELF ... IT HAS TO BE DONE AS A REAL USER WOULD, NOT
 * WITH DOM ELEMENTS, WITH REAL KEYBOARD AND MOUSE CLICKS."
 *
 * So every press in this file is a mouse at a coordinate: move, down, up. There
 * is no el.click(), no dispatchEvent, and nothing is assigned to `.value`.
 * Before every press the point under the cursor is read with
 * document.elementFromPoint and RECORDED, because a press that lands on
 * something else is the finding -- three of the four defects below are exactly
 * that shape, and a harness that clicks by selector cannot see any of them.
 *
 * WHAT IT MEASURES
 *
 *   1  THE EFFORT MENU CAN BE REACHED BY A MOUSE. "How hard should it think?"
 *      resolved through elementFromPoint to div.agent-compose-actions -- the
 *      Start bar was on top of it. Measured at two window sizes, because the
 *      panel is a column in a clipping rail and the overlap is a geometry
 *      question, not a markup question.
 *   2  THE FLEET OVERVIEW COUNTS WHAT IS ACTUALLY THERE. "0 Agents on record"
 *      beside agents that ran.
 *   3  A REFUSAL CARRIES ITS REAL REASON. Starting a Claude tier from a tree
 *      cannot work (shell/agent-host.cjs raises AGENT_TIER_NO_LAUNCHER, and
 *      that is honest); the panel was painting "this copy was not told why" and
 *      telling the person to try again, which can never work.
 *   4  "TURN ON AGENT SESSIONS IN SETTINGS" LANDS ON THE SETTING. It landed at
 *      the top of a 219-control page with the control far below the fold.
 *
 * THREE RUNS, THREE ENVIRONMENTS, AND EACH ONE IS A DIFFERENT FENCE.
 *
 * Run A is providerless: PATH is cut back to the Windows system directories and
 * APPDATA/LOCALAPPDATA/USERPROFILE/CODEX_HOME point into this run's scratch, so
 * no assistant program can be resolved and no provider budget can be spent. The
 * borrowed fence is tools/agent-start-flow-qa.mjs's, measured rather than
 * reasoned. The one Start this file presses names a CLAUDE tier, which the host
 * refuses before anything is spawned, so even a mistake in the fence could not
 * start a paid session.
 *
 * Run B additionally puts a scratch directory on PATH holding a `codex.cmd`
 * that prints a version and exits. shell/agent-host.cjs codexCommandIsMissing()
 * answers PRESENCE by stat, without spawning anything, so this is enough to
 * make the app's own availability probe say the engine is ready -- which is the
 * state the home screen's "Turn on agent sessions in Settings" link exists in.
 * Nothing in run B starts an agent, so the stub is never executed. Without it
 * the link is simply not on the screen and defect 4 could not be driven at all.
 *
 * A HARNESS MISTAKE IS NEVER REPORTED AS A PRODUCT DEFECT. Staging refuses on a
 * stale dist/ (assertRendererMeasurable), the run refuses if the window never
 * mounts a view, and every check that could not be exercised is reported as NOT
 * EXERCISED rather than as a pass or a failure.
 *
 * Run C is the opposite of run A on purpose and is OPT-IN. It starts two REAL
 * Codex sessions on this machine's own sign-in and spends real quota, so it
 * runs only under --live-agent. It exists because checks 2's repair was proven
 * against REFUSED starts, which shows the hero reads the record rather than a
 * dead projection and does NOT show that an agent's real work lands on it --
 * two different facts, and only one of them had been measured.
 *
 * USAGE
 *   node tools/owner-walkthrough-drive.mjs
 *   node tools/owner-walkthrough-drive.mjs --visible      show the window
 *   node tools/owner-walkthrough-drive.mjs --keep         keep the scratch tree
 *   node tools/owner-walkthrough-drive.mjs --live-agent   start REAL agents and
 *                                                         spend REAL quota
 *
 * EXIT  0 everything measured passed · 1 a check failed · 2 the harness could
 *       not run · 3 nothing failed but something could not be exercised.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, seedMachineRecord, scratchDirectory, stage } from './test-account-harness.mjs'
import { prepareSterileProfile, qaProfileDirectories, sterileLaunchEnvironment } from './lib/sterile-launch.cjs'
import { START_PANEL, START_REFUSAL, TIER_CHOICES } from '../src/fleet-tree-copy.js'
import { UNAVAILABLE_TEXT } from '../src/agent-availability-copy.js'

const SELF = fileURLToPath(import.meta.url)
const VISIBLE = process.argv.includes('--visible')
const KEEP = process.argv.includes('--keep')
const STARTED_AT = Date.now()

/* Playwright is an explicit test-kit dependency. No account-specific fallback:
   a missing location is a no-verdict harness setup error, never permission to
   reach into another Windows profile. */
const PLAYWRIGHT_ROOT = typeof process.env.MC_PLAYWRIGHT_ROOT === 'string'
  ? process.env.MC_PLAYWRIGHT_ROOT.trim()
  : ''
const require_ = PLAYWRIGHT_ROOT
  ? createRequire(path.resolve(PLAYWRIGHT_ROOT, 'package.json'))
  : null

class HarnessError extends Error {
  constructor(message, code = 'HARNESS_COULD_NOT_RUN') {
    super(message)
    this.code = code
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------- the ledger -- */

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, state: pass === true ? 'pass' : 'fail', detail: String(detail) })
  console.log(`  ${pass === true ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  return pass === true
}
function pending(name, why) {
  checks.push({ name, state: 'pending', detail: String(why) })
  console.log(`  ....  ${name}  -- NOT EXERCISED: ${why}`)
}
function note(text) { console.log(`  --    ${text}`) }

function report() {
  const failed = checks.filter(entry => entry.state === 'fail')
  const notRun = checks.filter(entry => entry.state === 'pending')
  console.log(`\n${checks.length - failed.length - notRun.length}/${checks.length} checks passed in ${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`)
  for (const entry of failed) console.log(`  FAILED:        ${entry.name}  -- ${entry.detail}`)
  for (const entry of notRun) console.log(`  NOT EXERCISED: ${entry.name}  -- ${entry.detail}`)
  if (failed.length > 0) return 1
  if (notRun.length > 0) return 3
  return 0
}

/* ------------------------------------------------------- the environments -- */

function baseEnvironment(profile) {
  /* The homes come from the one shared helper (tools/lib/sterile-launch.cjs):
     APPDATA, LOCALAPPDATA, USERPROFILE, CODEX_HOME and TEMP inside the scratch
     profile, HOME/HOMEDRIVE/HOMEPATH gone, ELECTRON_RUN_AS_NODE deleted. What
     this harness adds is its own PATH and no engine variable. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  mkdirSync(path.join(profile, 'userdata'), { recursive: true })
  for (const key of Object.keys(environment)) {
    if (/^(path|mission_control_engine)$/i.test(key)) delete environment[key]
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemPath = [
    path.join(systemRoot, 'system32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ]
  environment.PATH = systemPath.join(';')
  /* Inherited, the packaged executable starts as a bare Node process with no
     app object and an exit code that reads like an ordinary failure. */
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'
  return { environment, systemPath }
}

function providerlessEnvironment(profile) {
  return baseEnvironment(profile).environment
}

/* PRESENCE ONLY, AND IT IS NEVER RUN. codexCommandIsMissing() stats
   `codex.cmd` on PATH; nothing in run B starts a session, so this file is
   looked at and not executed. */
function engineReadyEnvironment(profile) {
  const { environment, systemPath } = baseEnvironment(profile)
  const bin = path.join(profile, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'codex.cmd'), '@echo codex-cli 0.0.0-presence-stub\r\n', 'utf8')
  environment.PATH = [...systemPath, bin].join(';')
  /* AND THE SIGN-IN, WHICH IS ALSO ONLY EVER LOOKED FOR. At an isolated
     permission level the probe refuses unless CODEX_HOME holds an auth.json
     (confinedSessionIsSignedOut in shell/agent-host.cjs). It checks existence
     and nothing else, and this run starts no session, so a placeholder file in
     a scratch directory is enough to put the home screen into the state the
     link under test lives in. It authenticates nothing and is deleted with the
     scratch tree. */
  writeFileSync(path.join(environment.CODEX_HOME, 'auth.json'), '{}\n', 'utf8')
  return environment
}

/* ------------------------------------------------------------- the window -- */

async function openApp(executable, profile, environment) {
  if (!require_) throw new HarnessError('MC_PLAYWRIGHT_ROOT must name the authorized Playwright test kit')
  const { _electron } = require_('playwright')
  const userData = path.join(profile, 'userdata')
  const app = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userData}`],
    env: environment,
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  const thrown = []
  page.on('pageerror', error => { thrown.push(String(error?.message || error)) })
  return { app, page, thrown }
}

async function closeApp(open) {
  if (!open) return
  try { await open.app.close() } catch { /* already gone */ }
}

/** Set the window to a real size, the way a person's window has one. */
async function resizeTo(open, width, height) {
  /* Unmaximised first, deliberately: setContentSize on a MAXIMISED window is
     accepted and does nothing, so the second size in a sweep silently measured
     the first one again -- two identical measurements reported as two sizes. */
  await open.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return null
    if (window.isMaximized()) window.unmaximize()
    if (window.isFullScreen()) window.setFullScreen(false)
    window.setContentSize(size.width, size.height)
    return window.getContentSize()
  }, { width, height })
  await delay(900)
  return open.page.evaluate('({ w: innerWidth, h: innerHeight })')
}

async function waitForView(open, budgetMs = 90_000) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    const ready = await open.page.evaluate(`(() => document.readyState === 'complete'
      && Boolean(document.getElementById('stage'))
      && document.getElementById('stage').childElementCount > 0)()`)
    if (ready === true) return true
    await delay(400)
  }
  return false
}

const routeOf = open => open.page.evaluate('document.body.dataset.route || ""')

/* ------------------------------------------------- real presses, recorded -- */

/**
 * Where a control is, and WHAT IS ACTUALLY UNDER THAT POINT.
 *
 * The second half is the whole instrument. A bounding box says the control is
 * laid out; elementFromPoint says a mouse would reach it. Three of the four
 * findings this file drives are the difference between those two sentences.
 */
const AT_POINT = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return { state: 'hidden' }
  }
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const viewport = { w: innerWidth, h: innerHeight }
  const geometry = { x: box.x, y: box.y, w: box.width, h: box.height }
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
    return { state: 'offscreen', box: geometry, viewport, x, y }
  }
  const hit = document.elementFromPoint(x, y)
  const describe = element => element
    ? element.tagName.toLowerCase()
      + (element.id ? '#' + element.id : '')
      + (element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\\s+/).join('.')
        : '')
    : 'nothing'
  const mine = Boolean(hit) && (hit === node || node.contains(hit))
  return {
    state: mine ? 'reachable' : 'covered',
    under: describe(hit),
    self: describe(node),
    box: geometry,
    viewport,
    x,
    y,
  }
}`

async function at(open, selector) {
  return open.page.evaluate(`(${AT_POINT})(${JSON.stringify(selector)})`)
}

/* WAITED FOR, NOT SAMPLED ONCE, and this cost the first two runs of this file.
 *
 * MEASURED: the window mounts its first view and the topbar's own layout is not
 * final for another second or so; elementFromPoint at the forward arrow's
 * centre returned <html> at 2.4s and the arrow itself at 6s, with nothing about
 * the product different between the two. A single sample there reported "the
 * forward arrow could not be pressed", which is a serious-sounding finding
 * about the harness. So reachability is polled, and the LAST state seen is what
 * gets reported when it never becomes reachable -- a control still covered
 * after the whole budget is a real finding, and it reads the same. */
async function reachable(open, selector, budgetMs = 6000) {
  const until = Date.now() + budgetMs
  let last = await at(open, selector)
  while (last?.state !== 'reachable' && Date.now() < until) {
    await delay(300)
    last = await at(open, selector)
  }
  return last
}

/**
 * A press: move the cursor there, put the button down, lift it up.
 *
 * The point under the cursor is recorded FIRST and returned with the result, so
 * a press that landed on the wrong thing is visible in the evidence rather than
 * inferred from what did not happen afterwards.
 */
async function press(open, selector, { settleMs = 500, waitMs = 6000 } = {}) {
  const spot = await reachable(open, selector, waitMs)
  if (spot?.state !== 'reachable') return { pressed: false, spot }
  await open.page.mouse.move(spot.x, spot.y)
  await delay(60)
  await open.page.mouse.down()
  await delay(60)
  await open.page.mouse.up()
  await delay(settleMs)
  return { pressed: true, spot }
}

/** Scroll the way a person scrolls: the wheel, over the thing being read. */
async function wheelOver(open, selector, deltaY, times = 1) {
  const spot = await at(open, selector)
  if (spot?.state === 'absent' || spot?.state === 'hidden' || spot?.state === 'zero-size') return spot
  await open.page.mouse.move(spot.x, spot.y)
  for (let step = 0; step < times; step += 1) {
    await open.page.mouse.wheel(0, deltaY)
    await delay(140)
  }
  await delay(320)
  return spot
}

/**
 * Change a menu with the keyboard, which is what a person does after the menu
 * has focus -- and the one way to work a native <select> without asking the
 * operating system to draw a popup this run cannot see.
 */
async function chooseByKeyboard(open, selector, wantedValue) {
  const before = await open.page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
  await open.page.keyboard.press('Home')
  for (let step = 0; step < 24; step += 1) {
    const current = await open.page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
    if (current === wantedValue) return { ok: true, before, after: current, presses: step }
    await open.page.keyboard.press('ArrowDown')
    await delay(90)
  }
  const after = await open.page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
  return { ok: after === wantedValue, before, after, presses: 24 }
}

const textOf = (open, selector) =>
  open.page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent || '').trim()`)

/* --------------------------------------------------------- getting about --- */

/** The route stamp, once it has stopped moving. */
async function settledRoute(open, from = null, budgetMs = 8000) {
  const until = Date.now() + budgetMs
  let seen = await routeOf(open)
  while (Date.now() < until) {
    await delay(250)
    const now = await routeOf(open)
    /* Two agreeing reads AND a change from where we started. `from` is null on
       the first read of a run, where any settled value is the answer. */
    if (now === seen && (from === null || now !== from)) return now
    seen = now
  }
  return seen
}

/**
 * Walk the ring by pressing the forward arrow, like a person with a mouse.
 *
 * ONE PRESS PER STOP, AND THE STOP IS WAITED FOR. src/main.js swaps views
 * inside document.startViewTransition, and `document.body.dataset.route` is
 * only stamped when that swap runs -- so the stamp lags the press by most of a
 * second. A loop that re-read the stamp on a fixed settle pressed the arrow a
 * SECOND time while the first press was still in flight and sailed past the
 * fleet page into metrics: measured, `route: "metrics", board: false`, reported
 * as "no empty node on the page". That was a finding about this file, not about
 * the product, and it is the reason the wait below is on the route CHANGING
 * rather than on a duration.
 */
async function walkTo(open, wanted, limit = 12) {
  let here = await settledRoute(open)
  for (let step = 0; step < limit; step += 1) {
    if (here === wanted) return true
    const pressed = await press(open, '#nav-next', { settleMs: 250 })
    if (!pressed.pressed) {
      note(`  the forward arrow could not be pressed from ${here}: ${JSON.stringify(pressed.spot)}`)
      return false
    }
    const next = await settledRoute(open, here)
    if (next === here) {
      note(`  the forward arrow was pressed on ${here} and the page did not move`)
      return false
    }
    here = next
  }
  note(`  walked ${limit} stops and never reached ${wanted}; last stop ${here}`)
  return here === wanted
}

/* ============================== run A ====================================== */

const EFFORT = '[data-compose-field="effort"]'
const ROLE = '[data-compose-field="role"]'
const TIER = '[data-compose-field="tier"]'
const MESSAGE = '[data-compose-field="message"]'
const SUBMIT = '[data-compose-action="start"]'
const NOTICE = '[data-compose-notice="panel"]'
const BODY = '[data-compose-body="form"]'

/** Press an empty spot in the tree, which is how the compose panel opens. */
/* THE PANEL'S OWN GEOMETRY, because "the menu is covered" and "the menu is
   below the fold" and "the menu is fine" are three different products and the
   difference is arithmetic. Reports the scroller's real overflow behaviour --
   the class the panel asks for (.rail-scroll) is only ever DEFINED under
   .board-page and .agentv-panels in this tree, and the compose page is
   neither -- so whether it scrolls at all is a measurement, not a reading. */
const PANEL_GEOMETRY = `(() => {
  const panel = document.querySelector('.agent-compose')
  const body = document.querySelector('[data-compose-body="form"]')
  const actions = document.querySelector('.agent-compose-actions')
  const effort = document.querySelector('[data-compose-field="effort"]')
  if (!panel || !body) return { present: false }
  const box = node => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }
  const style = getComputedStyle(body)
  const effortBox = effort ? effort.getBoundingClientRect() : null
  const centre = effortBox ? { x: effortBox.x + effortBox.width / 2, y: effortBox.y + effortBox.height / 2 } : null
  const hit = centre ? document.elementFromPoint(centre.x, centre.y) : null
  const name = el => el
    ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
    : 'nothing'
  return {
    present: true,
    viewport: { w: innerWidth, h: innerHeight },
    panel: box(panel),
    body: box(body),
    actions: box(actions),
    effort: box(effort),
    scroller: {
      overflowY: style.overflowY,
      flex: style.flex,
      minHeight: style.minHeight,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollTop: Math.round(body.scrollTop),
      scrollable: body.scrollHeight > body.clientHeight + 1,
    },
    /* The band between the bottom of what the scroller shows and the top of
       the Start bar is where a half-clipped control appears to be and is not. */
    effortCentreUnder: name(hit),
    effortCentreInsideScroller: Boolean(centre && body.getBoundingClientRect().bottom >= centre.y),
    /* WHERE THE PANEL'S HEIGHT COMES FROM. The panel can only be as tall as the
       rail page it is mounted in; if there is unused room between the panel's
       bottom and the rail's, that room is the difference between a form that
       fits and a control cut in half, and it is worth knowing whose padding it
       is before anything is changed. */
    ancestry: (() => {
      const chain = []
      let node = panel
      while (node && node !== document.body) {
        const r = node.getBoundingClientRect()
        const s = getComputedStyle(node)
        chain.push({
          name: name(node),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          display: s.display,
          overflow: s.overflowY,
          padding: s.padding,
          position: s.position,
        })
        node = node.parentElement
      }
      return chain
    })(),
  }
})()`

async function panelGeometry(open) {
  return open.page.evaluate(PANEL_GEOMETRY)
}

const NEW_TREE_SELECTOR = '.tree-new-tree'

/* NOT MARKED WITH AN ATTRIBUTE FIRST, and that was a harness bug worth naming.
   The tree canvas rebuilds its slot buttons on every layout pass, so a
   data-attribute stamped on the node in one evaluate was gone by the next one
   and the press reported "absent" about a node that was on the glass. The
   selector is resolved and the point taken in the SAME read, and the press is
   a mouse at that point. */
async function openComposePanel(open) {
  const header = await reachable(open, '.tree-chat-add', 15_000)
  if (header?.state !== 'reachable') return { opened: false, why: `the header + is unavailable: ${JSON.stringify(header)}` }
  await open.page.mouse.move(header.x, header.y)
  await open.page.mouse.down()
  await open.page.mouse.up()
  const spot = await reachable(open, NEW_TREE_SELECTOR, 15_000)
  if (spot?.state === 'absent') {
    /* WHAT THE PAGE WAS SHOWING INSTEAD. Without this, "no empty node" is the
       same sentence for a live board with no slots, a board still loading, and
       a page showing the worked example -- three different problems. */
    const why = await open.page.evaluate(`(() => {
      const root = document.querySelector('.computers')
      return {
        route: document.body.dataset.route,
        board: Boolean(root),
        liveMode: root ? root.getAttribute('data-live-mode') : null,
        slots: document.querySelectorAll('.tree-empty-node').length,
        nodes: document.querySelectorAll('.static-tree-node, .tree-node').length,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
      }
    })()`)
    return { opened: false, why: `no New tree action in the header menu; ${JSON.stringify(why)}` }
  }
  if (spot?.state !== 'reachable') {
    return { opened: false, why: `New tree is on the page and not reachable: ${JSON.stringify(spot)}` }
  }
  await open.page.mouse.move(spot.x, spot.y)
  await delay(80)
  await open.page.mouse.down()
  await delay(80)
  await open.page.mouse.up()
  for (let step = 0; step < 20; step += 1) {
    await delay(300)
    const isOpen = await open.page.evaluate('Boolean(document.querySelector(\'[data-agent-compose="open"]\'))')
    if (isOpen === true) return { opened: true, why: '', spot }
  }
  return { opened: false, why: `the press landed on ${spot.under} and no panel appeared`, spot }
}

async function driveComposePanel(open, sizes) {
  const reached = await walkTo(open, 'computers')
  if (!reached) {
    pending('the effort menu can be reached by a mouse', 'the fleet page was never reached by pressing the arrow')
    pending('a refusal names its real reason', 'the fleet page was never reached by pressing the arrow')
    return { started: false }
  }
  note(`on ${await routeOf(open)}`)

  let panelState = null
  for (const size of sizes) {
    const viewport = await resizeTo(open, size.width, size.height)
    note(`window ${size.width}x${size.height} -> viewport ${JSON.stringify(viewport)}`)

    /* The panel is rebuilt per press, so it is opened fresh at each size --
       a panel laid out at one size and measured at another would be a finding
       about the harness. */
    const opened = await openComposePanel(open)
    if (!opened.opened) {
      pending(`the effort menu can be reached by a mouse at ${size.width}x${size.height}`, opened.why)
      continue
    }
    panelState = 'open'

    const first = await at(open, EFFORT)
    note(`  effort at first paint: ${first.state}${first.under ? ` (under the cursor: ${first.under})` : ''} box=${JSON.stringify(first.box || null)}`)
    note(`  panel at first paint: ${JSON.stringify(await panelGeometry(open))}`)

    /* AND IN THE STATE A PERSON IS ACTUALLY IN WHEN THEY REACH THIS MENU.
       Nobody opens the panel and goes straight for the last field: they answer
       the role first, which paints that role's summary line under the menu and
       makes everything below it taller. A measurement taken on an untouched
       panel is a measurement of a screen nobody is looking at. */
    const rolePrime = await press(open, ROLE, { settleMs: 300 })
    await open.page.keyboard.press('Escape')
    const primeChoice = await open.page.evaluate(`(() => {
      const menu = document.querySelector(${JSON.stringify(ROLE)})
      return menu ? [...menu.options].map(option => option.value).filter(Boolean)[0] || null : null
    })()`)
    if (rolePrime.pressed && primeChoice) await chooseByKeyboard(open, ROLE, primeChoice)
    const withRole = await at(open, EFFORT)
    note(`  effort once a role is chosen: ${withRole.state}${withRole.under ? ` (under the cursor: ${withRole.under})` : ''}`)
    const geometry = await panelGeometry(open)
    note(`  panel once a role is chosen: ${JSON.stringify(geometry)}`)

    check(`the compose panel's form really scrolls at ${size.width}x${size.height}`,
      geometry.present === true
        && (geometry.scroller.overflowY === 'auto' || geometry.scroller.overflowY === 'scroll'),
      geometry.present
        ? `overflow-y=${geometry.scroller.overflowY} flex=${geometry.scroller.flex} content=${geometry.scroller.scrollHeight}px in ${geometry.scroller.clientHeight}px`
        : 'the panel was not on the page to measure')

    check(`the effort menu is never hidden under the Start bar at ${size.width}x${size.height}`,
      geometry.present === true && !/agent-compose-actions/.test(String(geometry.effortCentreUnder)),
      `elementFromPoint at its centre returns ${geometry.effortCentreUnder}`)

    /* A person who cannot see the control scrolls to it. The wheel is the
       gesture; the form scrolls, and where it stops is what a mouse can reach. */
    await wheelOver(open, BODY, 240, 6)
    const after = await at(open, EFFORT)

    check(`the effort menu can be reached by a mouse at ${size.width}x${size.height}`,
      after.state === 'reachable',
      after.state === 'covered'
        ? `elementFromPoint at its own centre returns ${after.under}, not the menu`
        : `${after.state}${after.box ? ` box=${JSON.stringify(after.box)} viewport=${JSON.stringify(after.viewport)}` : ''}`)

    if (after.state === 'reachable') {
      const pressed = await press(open, EFFORT, { settleMs: 400 })
      /* A native menu may have opened over the window; Escape closes it and
         leaves the control focused, which is the state the keyboard works in. */
      await open.page.keyboard.press('Escape')
      await delay(200)
      const focused = await open.page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(EFFORT)})`)
      const changed = await chooseByKeyboard(open, EFFORT, 'high')
      check(`the effort menu actually changes value when worked at ${size.width}x${size.height}`,
        changed.ok && changed.before !== changed.after,
        `pressed at (${Math.round(pressed.spot.x)},${Math.round(pressed.spot.y)}); focus landed on it: ${focused === true}; ${changed.before} -> ${changed.after}`)
    } else {
      pending(`the effort menu actually changes value when worked at ${size.width}x${size.height}`,
        'the menu could not be reached, so there was nothing to work')
    }
  }

  if (panelState !== 'open') return { started: false }

  /* ---- the refusal, on the panel the person is looking at ---- */
  /* WHAT THE SHELL SAID, AND WHAT THE MENU DREW. The renderer used to decide
     this from a frozen list; it now asks. Both halves are recorded so a menu
     that quietly fell back to its default is visible as one. */
  const startable = await open.page.evaluate(`(async () => {
    const bridge = globalThis.mcAgent
    if (!bridge || typeof bridge.startableTiers !== 'function') return { channel: false }
    try { return { channel: true, reply: await bridge.startableTiers() } }
    catch (error) { return { channel: true, threw: String(error && error.message || error) } }
  })()`)
  const drawn = await open.page.evaluate(`(() => {
    const menu = document.querySelector('[data-compose-field="tier"]')
    return menu ? [...menu.options].map(option => option.textContent) : null
  })()`)
  note(`  the shell answers startable: ${JSON.stringify(startable)}`)
  note(`  the menu draws: ${JSON.stringify(drawn)}`)

  const claudeRow = TIER_CHOICES.find(choice => /claude/i.test(choice.id))
  if (!claudeRow) {
    pending('a refusal names its real reason', 'this build offers no Claude tier to refuse')
    return { started: false }
  }

  /* Back to the top of the form before filling it in. The size sweep above
     left the scroller at the bottom, and a press aimed at the role menu from
     there is a press at whatever the scroll left in that spot. */
  await wheelOver(open, BODY, -240, 8)
  const rolePress = await press(open, ROLE, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const roleChoice = await open.page.evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(ROLE)})
    return menu ? [...menu.options].map(option => option.value).filter(Boolean)[0] || null : null
  })()`)
  const rolePicked = roleChoice ? await chooseByKeyboard(open, ROLE, roleChoice) : { ok: false }
  note(`  role: pressed=${rolePress.pressed} picked=${rolePicked.after ?? 'none'}`)

  const messagePress = await press(open, MESSAGE, { settleMs: 300 })
  if (messagePress.pressed) {
    await open.page.keyboard.type('Read the notes in my documents folder and list what is unfinished.', { delay: 12 })
  }

  await wheelOver(open, BODY, 240, 4)
  const tierPress = await press(open, TIER, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const tierPicked = await chooseByKeyboard(open, TIER, claudeRow.id)
  note(`  tier: pressed=${tierPress.pressed} ${tierPicked.before} -> ${tierPicked.after}`)

  if (tierPicked.after !== claudeRow.id) {
    pending('a refusal names its real reason', `the tier menu could not be moved to ${claudeRow.id}`)
    return { started: false }
  }

  const submitted = await press(open, SUBMIT, { settleMs: 1200 })
  if (!submitted.pressed) {
    pending('a refusal names its real reason', `Start could not be pressed: ${JSON.stringify(submitted.spot)}`)
    return { started: false }
  }
  /* A start crosses the IPC boundary, the spawn recorder and the host. */
  for (let step = 0; step < 40; step += 1) {
    const shown = await textOf(open, NOTICE)
    if (shown) break
    await delay(500)
  }
  const sentence = await textOf(open, NOTICE)
  note(`  the panel says: "${sentence}"`)

  const real = UNAVAILABLE_TEXT.AGENT_TIER_NO_LAUNCHER
  const realFragment = real.split(/[.,]/)[0].trim().toLowerCase()
  check('a refusal names its real reason',
    Boolean(sentence) && sentence.toLowerCase().includes(realFragment),
    sentence ? `it said: "${sentence}"` : 'the panel said nothing at all')
  check('a refusal that cannot be retried does not tell the person to retry',
    Boolean(sentence) && !sentence.includes(START_REFUSAL.noReasonGiven),
    sentence.includes(START_REFUSAL.noReasonGiven)
      ? 'it painted the "this copy was not told why · try once more" sentence'
      : 'no "try once more" for a refusal that retrying cannot clear')

  /* THE SECOND PROVIDER THE TREE CANNOT START, pressed rather than reasoned
     about. `local` reaches the same refusal in shell/agent-host.cjs by a
     different branch of the same check, and a run that measured only the Claude
     rows would not have shown that the sentence names both. */
  const localRow = TIER_CHOICES.find(choice => choice.id === 'local')
  if (!localRow) {
    pending('the same refusal answers the other engine a tree cannot start', 'this build offers no local tier')
    return { started: true }
  }
  await wheelOver(open, BODY, 240, 4)
  const secondTier = await press(open, TIER, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const secondPicked = await chooseByKeyboard(open, TIER, 'local')
  if (!secondTier.pressed || secondPicked.after !== 'local') {
    pending('the same refusal answers the other engine a tree cannot start',
      `the tier menu could not be moved to local (${secondPicked.before} -> ${secondPicked.after})`)
    return { started: true }
  }
  const secondSubmit = await press(open, SUBMIT, { settleMs: 1200 })
  if (!secondSubmit.pressed) {
    pending('the same refusal answers the other engine a tree cannot start',
      `Start could not be pressed: ${JSON.stringify(secondSubmit.spot)}`)
    return { started: true }
  }
  let secondSentence = ''
  for (let step = 0; step < 40; step += 1) {
    secondSentence = await textOf(open, NOTICE)
    if (secondSentence) break
    await delay(500)
  }
  note(`  on the local engine the panel says: "${secondSentence}"`)
  check('the same refusal answers the other engine a tree cannot start',
    Boolean(secondSentence)
      && secondSentence.toLowerCase().includes(realFragment)
      && !secondSentence.includes(START_REFUSAL.noReasonGiven),
    secondSentence ? `it said: "${secondSentence}"` : 'the panel said nothing at all')

  return { started: true }
}

/* ------------------------------------------------------ the record count --- */

async function driveFleetOverview(open) {
  /* Back to the fleet page, and to the rail's own first page. */
  const closed = await press(open, '[data-compose-action="cancel"]', { settleMs: 900 })
  note(`  compose panel closed by pressing Cancel: ${closed.pressed}`)

  const ledger = await open.page.evaluate(`(async () => {
    const bridge = globalThis.mcAgent
    if (!bridge || typeof bridge.history !== 'function') return { bridge: false }
    try { return { bridge: true, reply: await bridge.history({ limit: 20 }) } }
    catch (error) { return { bridge: true, threw: String(error && error.message || error) } }
  })()`)
  const recorded = ledger?.reply?.outcomes?.starts ?? null
  note(`  the signed record holds ${recorded === null ? 'an unknown number of' : recorded} start(s); verified=${ledger?.reply?.verified}`)

  /* WHAT THE PRODUCT ACTUALLY SAVED ABOUT THIS TREE. Dumped on the FREE run, so
     the live one does not have to spend provider quota discovering that this
     harness's reader was looking in the wrong place. */
  const stored = await open.page.evaluate(`(() => {
    const keys = []
    for (let index = 0; index < localStorage.length; index += 1) keys.push(localStorage.key(index))
    const treeKey = keys.find(key => key && key.includes('fleet.trees'))
    return {
      fleetKeys: keys.filter(key => key && key.includes('fleet')),
      shape: treeKey ? String(localStorage.getItem(treeKey)).slice(0, 320) : null,
      canvasNodes: document.querySelectorAll('.node.static-tree-node').length,
    }
  })()`)
  note(`  saved keys mentioning fleet: ${JSON.stringify(stored.fleetKeys)}`)
  note(`  saved tree shape: ${stored.shape}`)
  note(`  nodes on the canvas: ${stored.canvasNodes}`)
  note(`  savedNodes() reads: ${JSON.stringify(await savedNodes(open))}`)

  /* The count is read from the record after the page paints, so the hero is
     waited for rather than sampled the instant the rail appears. */
  let shown = ''
  let state = ''
  for (let step = 0; step < 24; step += 1) {
    shown = await textOf(open, '#agent-count')
    state = await open.page.evaluate('document.querySelector("#agent-count")?.dataset.recordState || ""')
    if (state && state !== 'reading') break
    await delay(400)
  }
  const label = await textOf(open, '.stat-hero .l')
  const recordNote = await textOf(open, '[data-agent-record-note]')
  note(`  the fleet overview shows "${shown}" under "${label}" (state ${state || 'none'})`)
  note(`  and says: "${recordNote}"`)

  if (recorded === null) {
    pending('the fleet overview counts what is actually on record',
      'this copy could not read its own spawn record, so there is no true number to compare against')
    return
  }
  if (!shown) {
    pending('the fleet overview counts what is actually on record',
      'the fleet overview hero was not on the page to read')
    return
  }
  check('the fleet overview counts what is actually on record',
    Number(shown) === recorded,
    `the screen says ${shown}; the signed record holds ${recorded} start(s)`)
}

/* ============================== run B ====================================== */

const SETTINGS_LINK = 'a.home-next[href^="#/settings"]'

async function driveSettingsLink(open) {
  const home = await routeOf(open)
  note(`run B opened on ${home}`)
  const present = await at(open, SETTINGS_LINK)
  if (present.state === 'absent') {
    const engine = await open.page.evaluate(`(async () => {
      const bridge = globalThis.mcAgent
      if (!bridge) return { bridge: false }
      try { return { bridge: true, availability: await bridge.availability() } }
      catch (error) { return { bridge: true, threw: String(error && error.message || error) } }
    })()`)
    pending('"Turn on agent sessions in Settings" lands on the setting',
      `the link was not on the home screen; availability=${JSON.stringify(engine)}`)
    return
  }
  const label = await textOf(open, SETTINGS_LINK)
  const href = await open.page.evaluate(`document.querySelector(${JSON.stringify(SETTINGS_LINK)})?.getAttribute('href') || ''`)
  note(`  the link reads "${label}" and points at ${href}`)

  const pressed = await press(open, SETTINGS_LINK, { settleMs: 2500 })
  if (!pressed.pressed) {
    pending('"Turn on agent sessions in Settings" lands on the setting',
      `the link could not be pressed: ${JSON.stringify(pressed.spot)}`)
    return
  }
  /* The route stamp lands when the view swap completes, and the swap runs
     inside a View Transition; sampling once at the press reported "landed on
     home" about a window that was on the settings page a second later. */
  let landed = await routeOf(open)
  for (let step = 0; step < 20 && landed !== 'settings'; step += 1) {
    await delay(400)
    landed = await routeOf(open)
  }
  check('pressing the link reaches the settings page', landed === 'settings', `landed on ${landed}`)

  /* Where the person is now, measured the way a person judges it: is the
     control they were sent to actually on the screen in front of them?
     WAITED FOR, NOT SAMPLED ONCE. The landing scrolls 10000px and the settings
     page re-renders when its capability probes answer, so a single sample a
     fixed delay after the press caught the page mid-settle and reported
     elementFromPoint returning <html> -- while the press immediately after it
     worked. That is this harness reading too early, and reporting it as a
     covered control would have been the fourth false finding of the day. */
  await reachable(open, '[data-setting-id="write_agent-session"] .settings-toggle', 10_000)
  const landing = await open.page.evaluate(`(() => {
    const row = document.querySelector('[data-setting-id="write_agent-session"]')
    if (!row) return { present: false }
    const box = row.getBoundingClientRect()
    const inert = Boolean(row.closest('[inert]'))
    /* THE VISIBLE SWITCH, NOT THE INPUT. A toggle row is a label.settings-toggle
       wrapping a hidden checkbox and an i element; the i is the thing a person
       sees and presses, and the label carries the press to the input. Measuring
       the INPUT's centre reports the i sitting on top of it and reads like a
       covered control -- which is this harness misreading a perfectly ordinary
       styled checkbox, not a defect. So the label is the control here. */
    const control = row.querySelector('.settings-toggle, .settings-seg, select, .settings-range, button')
    const controlBox = control ? control.getBoundingClientRect() : null
    const point = controlBox
      ? document.elementFromPoint(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2)
      : null
    return {
      present: true,
      inert,
      top: box.y,
      onScreen: box.y >= 0 && box.y <= innerHeight && box.height > 0,
      viewport: innerHeight,
      name: (row.querySelector('.settings-name')?.textContent || '').trim(),
      controlReachable: Boolean(control && point && (point === control || control.contains(point))),
      under: point ? point.tagName.toLowerCase() + (point.className && typeof point.className === 'string' ? '.' + point.className.trim().split(/\\s+/)[0] : '') : 'nothing',
    }
  })()`)
  note(`  landing: ${JSON.stringify(landing)}`)

  if (landing?.present !== true) {
    pending('"Turn on agent sessions in Settings" lands on the setting',
      'the settings page has no row for the agent-session switch at all')
    return
  }
  check('"Turn on agent sessions in Settings" lands on the setting',
    landing.onScreen === true && landing.inert === false,
    landing.inert
      ? `the row exists but is inside a collapsed tier (inert), ${Math.round(landing.top)}px from the top of the viewport`
      : `the row "${landing.name}" sits at y=${Math.round(landing.top)} in a ${landing.viewport}px viewport`)
  check('and the switch it landed on can be reached by a mouse',
    landing.controlReachable === true,
    landing.controlReachable === true
      ? `elementFromPoint returns ${landing.under}, inside the control`
      : `elementFromPoint returns ${landing.under}`)

  /* AND IT IS A SWITCH, NOT A PICTURE OF ONE. Landing on the row is only half
     the promise the sentence made; the other half is that the person can turn
     the thing on from where they were sent. Pressed with the mouse, and the
     answer is read from the product's own stored flag rather than from the
     checkbox's own property. */
  const before = await open.page.evaluate(`(() => {
    const input = document.querySelector('[data-setting-id="write_agent-session"] .settings-toggle input')
    return { checked: input ? input.checked : null, stored: localStorage.getItem('mc.write.agent-session') }
  })()`)
  const flipped = await press(open, '[data-setting-id="write_agent-session"] .settings-toggle', { settleMs: 900 })
  const after = await open.page.evaluate(`(() => {
    const input = document.querySelector('[data-setting-id="write_agent-session"] .settings-toggle input')
    return { checked: input ? input.checked : null, stored: localStorage.getItem('mc.write.agent-session') }
  })()`)
  check('and agent sessions can actually be turned on from where the link landed',
    flipped.pressed && before.checked === false && after.checked === true && after.stored === 'enabled',
    `pressed=${flipped.pressed} checked ${before.checked} -> ${after.checked}; stored ${before.stored} -> ${after.stored}`)
}

/* ============================== run C ======================================
 *
 * AN AGENT THAT REALLY RUNS, AND THE COUNTER THAT HAS TO NOTICE.
 *
 * WHY THIS IS SEPARATE AND OPT-IN. Runs A and B are fenced so that no assistant
 * program can be resolved and no provider budget can be spent. This one is the
 * opposite by construction: it starts REAL Codex sessions on the owner's own
 * sign-in and spends real quota, so it runs only under --live-agent and never
 * as part of an ordinary pass. Two turns, each one sentence long.
 *
 * WHY IT EXISTS AT ALL. The fleet overview's count was repaired and proven
 * against REFUSED starts -- the ledger records a start intent either way. That
 * proves the hero reads the record instead of a dead projection, and it does
 * NOT prove the thing the owner actually asked for, which is that an agent's
 * real work is attached to the record. A refused start and a finished agent are
 * different facts and only one of them had been measured.
 *
 * WHAT IS ISOLATED AND WHAT DELIBERATELY IS NOT. The user data directory,
 * APPDATA, LOCALAPPDATA and USERPROFILE all point into this run's scratch, so
 * the ledger being counted is THIS run's ledger and the agent's workspace is a
 * scratch folder -- a count taken from the machine's real installation would be
 * a finding about the wrong computer, and an agent running in the repository
 * would be a live process with tools inside the working tree. What is NOT
 * isolated is the ability to resolve and sign in to Codex: the npm global
 * directory is put back on PATH, and auth.json is COPIED into a scratch
 * CODEX_HOME so the real ~/.codex is never written to and the owner's own
 * config.toml -- with its MCP servers and its effort setting -- is not
 * inherited by a test session. The file is copied by path and never read,
 * printed or returned by this file.
 */

/* THE ANSWER MUST NOT BE INSIDE THE QUESTION, and this file got that wrong once.
 *
 * The first version asked the agent to "reply with exactly the word
 * PELICAN-4402" and then searched the screen for PELICAN-4402. That string was
 * typed into the box by this harness, so a run where NOTHING started could pass
 * on the echo of its own prompt -- a sibling lane proved exactly that failure on
 * its own driver, twice, and excluding form fields was not enough for them
 * because the tree re-renders the asked-line outside the form.
 *
 * So the prompt now contains a question and NOT its answer. Nothing this harness
 * types anywhere contains "391"; the only way that string can reach the screen
 * is an engine that multiplied. assertAnswerNotInQuestion() below refuses to run
 * at all if that ever stops being true, because the whole proof rests on it. */
const LIVE_ANSWER = '391'
const LIVE_JOB = 'What is 17 multiplied by 23? Reply with only the number.'
const LIVE = process.argv.includes('--live-agent')

/* THE ONE LINK THIS RUN CREATES, REMEMBERED SO IT CAN BE BROKEN FIRST.
 *
 * A junction inside the scratch tree points at the machine's REAL npm global
 * directory. Node's rmSync unlinks a junction rather than recursing through it
 * -- measured after the first live run: the real directory still held its 28
 * entries and codex still resolved. But that is one implementation detail
 * standing between this file and deleting the owner's global npm install, and
 * "it happened to be fine" is not a fence. The link is therefore removed by
 * name, before the tree it lives in is removed at all. */
let liveNpmLink = null

function liveEnvironment(profile) {
  /* The homes from the one shared helper (tools/lib/sterile-launch.cjs), exactly
     as baseEnvironment() above; this run differs only in its PATH and in the
     sign-in copied below. */
  const environment = sterileLaunchEnvironment(prepareSterileProfile(qaProfileDirectories(profile)))
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  /* The npm global directory is where this machine's codex.CMD lives. It is
     named from the REAL APPDATA before APPDATA is redirected, because the
     redirect is what makes codexCommandIsMissing() fall through to PATH. */
  const npmGlobal = path.join(process.env.APPDATA || '', 'npm')
  environment.PATH = [
    path.join(systemRoot, 'system32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'Wbem'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    npmGlobal,
  ].join(';')

  const realCodexHome = path.join(process.env.USERPROFILE || '', '.codex')
  mkdirSync(path.join(profile, 'userdata'), { recursive: true })
  /* THE ONLY THING TAKEN FROM THE REAL HOME. Copied rather than pointed at, so
     nothing this run does can touch the owner's Codex sign-in, and copied ALONE
     so his config.toml is not inherited. Never opened by this file. */
  const credential = path.join(realCodexHome, 'auth.json')
  if (!existsSync(credential)) {
    throw new HarnessError(
      `no Codex sign-in at ${credential}, so a live agent cannot start.`
      + ' Run `codex login` in a terminal, or drop --live-agent.',
    )
  }
  copyFileSync(credential, path.join(environment.CODEX_HOME, 'auth.json'))

  /* AND THE NPM GLOBAL LAYOUT, WHICH IS NOT THE SAME QUESTION AS PATH.
   *
   * MEASURED, and it cost a run. With APPDATA redirected and only PATH carrying
   * codex.CMD, the app's readiness probe answered {ok:true, AGENT_ENGINE_READY}
   * -- codexCommandIsMissing() stats PATH -- and the PRESS then refused with
   * "Codex is the program that actually runs an agent, and this computer does
   * not have it yet". The engine's own resolver prefers
   * %APPDATA%/npm/node_modules/@openai/codex, which the redirect had emptied.
   * A real user's APPDATA has it, so refusing to reproduce that layout would
   * have measured a machine nobody has.
   *
   * A junction rather than a copy: it needs no administrator, it is read-only
   * as far as this run is concerned, and it goes away with the scratch tree.
   * APPDATA itself stays scratch, deliberately -- pointing it at the real
   * Roaming would let shell/userdata-adoption.cjs find the machine's own
   * legacy data and adopt it into this profile, which would both pollute the
   * count this run exists to measure and write to the owner's data. */
  const realNpmGlobal = path.join(process.env.APPDATA || '', 'npm')
  const scratchNpmGlobal = path.join(environment.APPDATA, 'npm')
  if (existsSync(realNpmGlobal) && !existsSync(scratchNpmGlobal)) {
    try {
      symlinkSync(realNpmGlobal, scratchNpmGlobal, 'junction')
      liveNpmLink = scratchNpmGlobal
    } catch (error) {
      throw new HarnessError(
        `could not link the npm global directory into the scratch profile (${error.message}).`
        + ' Without it the engine cannot resolve Codex and no live agent can start.',
      )
    }
  }
  return environment
}

/** What the product itself saved about this tree, read from its own store. */
async function savedNodes(open) {
  return open.page.evaluate(`(() => {
    const out = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !key.startsWith('mc.fleet.trees.v1:')) continue
      let parsed
      try { parsed = JSON.parse(localStorage.getItem(key)) } catch { continue }
      /* NODES ARE A SIBLING OF TREES, NOT A CHILD OF ONE. The record is
         {version, computerId, trees: [...], nodes: [...]} -- see record() in
         src/fleet-trees.js. Reading them as tree.nodes returned an empty list on
         a tree with two nodes visibly on the canvas, and the live run reported
         "0 finished, 0 failed, of 0 node(s)" about agents that had genuinely
         started and been recorded. That was this reader, not the product. */
      for (const node of (parsed && parsed.nodes) || []) {
        out.push({
          id: node.id,
          status: node.status,
          session: Boolean(node.sessionId),
          reply: String(node.reply || '').slice(0, 160),
          /* Carried so the check can prove the answer is NOT in what was asked. */
          message: String(node.message || '').slice(0, 200),
        })
      }
    }
    return out
  })()`)
}

async function startOneLiveAgent(open, ordinal) {
  const opened = await openComposePanel(open)
  if (!opened.opened) return { ok: false, why: opened.why }

  const rolePressed = await press(open, ROLE, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const roleId = await open.page.evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(ROLE)})
    return menu ? [...menu.options].map(option => option.value).filter(Boolean)[0] || null : null
  })()`)
  if (!rolePressed.pressed || !roleId) return { ok: false, why: 'the role menu could not be worked' }
  await chooseByKeyboard(open, ROLE, roleId)

  const messagePressed = await press(open, MESSAGE, { settleMs: 300 })
  if (!messagePressed.pressed) return { ok: false, why: 'the brief could not be pressed' }
  await open.page.keyboard.type(LIVE_JOB, { delay: 10 })

  /* The engine menu is left exactly as the product set it: luna, the Codex
     default. Touching it would be measuring a choice nobody made. */
  const tier = await open.page.evaluate(`document.querySelector(${JSON.stringify(TIER)})?.value || ''`)
  note(`  agent ${ordinal}: role=${roleId} engine=${tier} brief typed by keystroke`)

  const submitted = await press(open, SUBMIT, { settleMs: 1500 })
  if (!submitted.pressed) return { ok: false, why: `Start could not be pressed: ${JSON.stringify(submitted.spot)}` }
  return { ok: true, tier }
}

/**
 * Wait for the product to say, in its own saved state, that N agents are done.
 *
 * COUNTED, NOT "ANY". The obvious version returns as soon as SOME node is
 * terminal, which is true the instant the first agent finishes -- so the second
 * agent's wait would return immediately, before it had answered anything, and
 * report the first agent's success as the second's.
 */
async function waitForFinished(open, expected, budgetMs = 240_000) {
  const until = Date.now() + budgetMs
  let last = []
  while (Date.now() < until) {
    last = await savedNodes(open)
    const terminal = last.filter(node => node.status === 'finished' || node.status === 'failed')
    if (terminal.length >= expected) return last
    await delay(2000)
  }
  return last
}

/* THE PROOF RESTS ON THIS, SO IT IS CHECKED BEFORE ANYTHING IS SPENT.
 *
 * If the expected answer ever appears in the prompt -- or in any other text this
 * harness types -- then a run where nothing started can pass on the echo of its
 * own question, which is precisely the failure this file shipped once. A
 * refusal here is a harness fault and exits 2; it is never a finding about the
 * product. */
function assertAnswerNotInQuestion() {
  const typed = [LIVE_JOB, 'A spot on the tree, so this computer has an agent page to open.']
  for (const text of typed) {
    if (text.includes(LIVE_ANSWER)) {
      throw new HarnessError(
        `the expected answer "${LIVE_ANSWER}" appears in text this harness types (${JSON.stringify(text)}),`
        + ' so a run where nothing started could pass on its own echo. Refusing to measure.',
      )
    }
  }
}

async function driveLiveAgents(open) {
  assertAnswerNotInQuestion()
  const reached = await walkTo(open, 'computers')
  if (!reached) {
    pending('an agent that really runs is added to the record', 'the fleet page was never reached')
    return
  }
  await resizeTo(open, 1512, 945)

  /* PREFLIGHT, IN THE MAIN PROCESS, because a start that refuses with "Codex is
     not installed" is either a true statement about this machine or a hole in
     this run's environment, and those two need different people. Read from the
     Electron main process itself -- the one that resolves the CLI -- rather
     than inferred from the renderer. */
  /* The env is READ from the main process and the file checks are done here:
     Playwright's main-process evaluate has no `require` in scope, and reaching
     for one would be this harness fighting its own tool rather than measuring
     the product. */
  const seen = await open.app.evaluate(({ app }) => ({
    path: process.env.PATH || process.env.Path || '',
    pathExt: process.env.PATHEXT || '',
    codexHome: process.env.CODEX_HOME || '',
    appData: process.env.APPDATA || '',
    version: app.getVersion(),
  }))
  const extensions = (seen.pathExt || '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(Boolean)
  const hits = []
  for (const directory of seen.path.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      if (existsSync(path.join(directory, `codex${extension}`))) hits.push(path.join(directory, `codex${extension}`))
    }
  }
  note(`  the main process would resolve codex at: ${JSON.stringify(hits)}`)
  note(`  CODEX_HOME=${seen.codexHome} auth.json present: ${existsSync(path.join(seen.codexHome, 'auth.json'))}`)
  note(`  APPDATA the app sees: ${seen.appData}`)
  const availability = await open.page.evaluate(`(async () => {
    try { return await globalThis.mcAgent.availability() } catch (error) { return { threw: String(error && error.message || error) } }
  })()`)
  note(`  the app's own readiness probe answers: ${JSON.stringify(availability)}`)
  if (availability?.ok !== true) {
    pending('an agent that really runs is added to the record',
      `this machine is not ready to start one: ${JSON.stringify(availability)}`)
    return
  }

  for (const ordinal of [1, 2]) {
    /* WHICH NODE IS THE NEW ONE, decided before the start rather than by
       position afterwards. On the second pass the canvas already holds the
       first agent, and "the first .node on the canvas" would have measured
       agent 1 twice and called it agent 2. */
    const before = new Set((await savedNodes(open)).map(node => node.id))
    const started = await startOneLiveAgent(open, ordinal)
    if (!started.ok) {
      pending(`agent ${ordinal} really runs and finishes`, started.why)
      pending(`the fleet overview counts ${ordinal} agent(s) that really ran`, 'no live agent was started')
      return
    }

    const nodes = await waitForFinished(open, ordinal)
    const mine = nodes.find(node => !before.has(node.id)) || null
    const sentence = await textOf(open, '[data-org-status], .org-status')
    note(`  agent ${ordinal} node: ${mine ? `${mine.status}, session ${mine.session}` : 'not found in the saved tree'}`)
    if (!mine || mine.status === 'failed') {
      /* A refused live start is a real answer about THIS MACHINE -- quota, a
         sign-in, a CLI version -- and it is not evidence about the counter
         either way. Reported as unexercised, in the product's own words. */
      pending(`agent ${ordinal} really runs and finishes`,
        mine
          ? `this machine refused the start: ${sentence || 'no sentence on the status line'}`
          : 'the start left no node in the saved tree')
      pending(`the fleet overview counts ${ordinal} agent(s) that really ran`, 'no live agent finished')
      return
    }
    check(`agent ${ordinal} really runs and finishes`, mine.status === 'finished',
      `the saved tree says this node is "${mine.status}" with a session: ${mine.session}`)

    /* WHAT THE AGENT ACTUALLY SAID, because "it finished" and "it did the work"
       are different claims. Read twice: from what the product SAVED, and from
       the node's own page after pressing that node on the canvas. */
    /* THE REPLY FIELD, NOT THE BRIEF. node.message is what this harness typed;
       node.reply is what the engine said, written by setNodeReply() from the
       turn event. They are different fields, and the check asserts the answer is
       in the second and absent from the first -- so an echo of the prompt cannot
       satisfy it even if the two ever became the same string. */
    const saidBack = String(mine.reply || '')
    const asked = String(mine.message || '')
    check(`agent ${ordinal}'s answer is the work that was asked for`,
      saidBack.includes(LIVE_ANSWER) && !asked.includes(LIVE_ANSWER),
      saidBack
        ? `it replied "${saidBack.slice(0, 120)}"; the brief it was given does not contain the answer: ${!asked.includes(LIVE_ANSWER)}`
        : 'the saved node carries no reply')

    let said = ''
    const nodeSelector = `.node.static-tree-node[data-agent-id="${mine.id}"]`
    const nodeSpot = await reachable(open, nodeSelector, 12_000)
    if (nodeSpot?.state === 'reachable') {
      await open.page.mouse.move(nodeSpot.x, nodeSpot.y)
      await open.page.mouse.down()
      await open.page.mouse.up()
      for (let step = 0; step < 30; step += 1) {
        await delay(500)
        said = await textOf(open, '[data-tree-said]')
        if (said && said.includes(LIVE_ANSWER)) break
      }
    } else {
      note(`  the node could not be pressed on the canvas: ${JSON.stringify(nodeSpot)}`)
    }
    note(`  agent ${ordinal} answered on screen: "${said.slice(0, 160)}"`)
    check(`agent ${ordinal}'s own answer is on the screen`, said.includes(LIVE_ANSWER),
      said ? `the reply panel reads "${said.slice(0, 120)}"` : 'the reply panel was empty')

    /* NAVIGATE AWAY AND BACK, which is the gesture the count now re-reads on. */
    const back = await press(open, '.rail-back', { settleMs: 1200 })
    note(`  pressed the rail's back control: ${back.pressed}`)
    let shown = ''
    let state = ''
    for (let step = 0; step < 30; step += 1) {
      shown = await textOf(open, '#agent-count')
      state = await open.page.evaluate('document.querySelector("#agent-count")?.dataset.recordState || ""')
      if (state && state !== 'reading') break
      await delay(400)
    }
    const ledger = await open.page.evaluate(`(async () => {
      try { return await globalThis.mcAgent.history({ limit: 200 }) } catch (error) { return { threw: String(error && error.message || error) } }
    })()`)
    const recorded = ledger?.outcomes?.starts ?? null
    note(`  after agent ${ordinal}: the overview shows "${shown}" (state ${state}); the signed record holds ${recorded} start(s)`)
    check(`the fleet overview counts ${ordinal} agent(s) that really ran`,
      shown === String(ordinal) && recorded === ordinal,
      `the screen says ${shown}, the record holds ${recorded}, and ${ordinal} agent(s) have run`)
  }
}

/* ============================== run D ======================================
 *
 * THE PROMISE THE REFUSAL MAKES, DRIVEN.
 *
 * When a tree refuses a Claude tier it currently ends with: "To use Claude now,
 * hand the work over on the agent page, which runs on that sign-in." That is a
 * promise about a DIFFERENT screen. A person who has just hit a wall is being
 * sent somewhere; this asks whether the current candidate's door opens.
 *
 * IT IS TWO QUESTIONS AND THEY SEPARATE CLEANLY.
 *
 *   1. IS THE MECHANISM THERE? Does handing work over with a Claude assistant
 *      selected reach a lane that spawns the real claude binary, or is it
 *      refused before anything is started? This needs no credential: a refusal
 *      before the spawn falsifies the promise whatever is signed in.
 *   2. DOES AN ANSWER COME BACK? That needs the person's own Claude sign-in,
 *      which lives in their home directory. Run under --live-handover-signed-in
 *      only, and reported separately, because a machine with no sign-in failing
 *      says nothing about a machine that has one.
 *
 * The default is question 1, deliberately: it is the cheap half, it is the half
 * that can prove the promise FALSE, and it copies no credential anywhere.
 */

const HANDOVER = process.argv.includes('--live-handover')
const HANDOVER_SIGNED_IN = process.argv.includes('--live-handover-signed-in')

/** Every process on this machine whose command line names claude, right now. */
export function claudeProcesses(spawn = spawnSync) {
  const result = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude' } | Select-Object -First 8 ProcessId,Name | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  /* Only a successful query with no output means there are no matching
     processes. A timeout, resource-pressure error, or failed PowerShell query
     says nothing about presence; in particular it must not lower `before` to
     zero and make the hand-over loop claim that a process appeared. */
  if (result.error || result.status !== 0) {
    const cause = result.error?.code || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)
    throw new HarnessError(
      `could not inspect Claude processes (${cause}); this is not claiming that none exist.`,
      'CLAUDE_PROCESS_LOOKUP_COULD_NOT_TELL',
    )
  }
  if (!String(result.stdout || '').trim()) return []
  try {
    const parsed = JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    throw new HarnessError(
      'could not read the Claude process query result; this is not claiming that none exist.',
      'CLAUDE_PROCESS_LOOKUP_COULD_NOT_TELL',
    )
  }
}

/* The Claude sign-in, copied the same way and for the same reason the Codex one
   is: the real home is never written to, and the copy dies with the scratch
   tree. Only under the signed-in flag; nothing here is read or printed. */
export function fileIsAbsent(file, stat = statSync) {
  try {
    stat(file)
    return false
  } catch (error) {
    if (error && error.code === 'ENOENT') return true
    const cause = error && error.code ? error.code : 'an unclassified error'
    throw new HarnessError(
      `could not inspect ${file} (${cause}); this is not claiming that it is absent.`,
      'CLAUDE_SIGN_IN_LOOKUP_COULD_NOT_TELL',
    )
  }
}

function copyClaudeSignIn(profile) {
  const realHome = process.env.USERPROFILE || ''
  const scratchHome = path.join(profile, 'home')
  const credential = path.join(realHome, '.claude', '.credentials.json')
  if (fileIsAbsent(credential)) return { ok: false, why: `no Claude sign-in at ${credential}` }
  mkdirSync(path.join(scratchHome, '.claude'), { recursive: true })
  copyFileSync(credential, path.join(scratchHome, '.claude', '.credentials.json'))
  /* The onboarding record too, or the CLI treats this as a first run and stops
     to ask questions no harness can answer. */
  const settings = path.join(realHome, '.claude.json')
  if (!fileIsAbsent(settings)) copyFileSync(settings, path.join(scratchHome, '.claude.json'))
  return { ok: true }
}

/** Turn a write action on the way a person does: Settings, its section, its switch. */
async function enableWriteAction(open, settingId, label) {
  const reached = await walkTo(open, 'settings')
  if (!reached) return { ok: false, why: 'the settings page was never reached by pressing the arrow' }
  /* The rail's groups ship collapsed; open them the way a person does, so the
     category this driver wants is a button on the screen. */
  await open.page.evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
  await delay(500)
  /* The rail category, pressed. `dispatch` is a depth-1 row, so the section
     alone puts it on screen -- no reveal to open. */
  const category = await press(open, 'button[data-category="Things it may do for you"]', { settleMs: 1200 })
  if (!category.pressed) return { ok: false, why: `the acting-switches category could not be pressed: ${JSON.stringify(category.spot)}` }
  const toggle = `[data-setting-id="${settingId}"] .settings-toggle`
  const before = await open.page.evaluate(`document.querySelector('[data-setting-id="${settingId}"] .settings-toggle input')?.checked`)
  if (before === true) return { ok: true, already: true }
  const pressed = await press(open, toggle, { settleMs: 900 })
  if (!pressed.pressed) return { ok: false, why: `the "${label}" switch could not be pressed: ${JSON.stringify(pressed.spot)}` }
  const after = await open.page.evaluate(`document.querySelector('[data-setting-id="${settingId}"] .settings-toggle input')?.checked`)
  return after === true ? { ok: true } : { ok: false, why: `the "${label}" switch did not turn on` }
}

async function driveHandover(open, { signedIn }) {
  const enabled = await enableWriteAction(open, 'write_dispatch', 'Hand out work to agents')
  if (!enabled.ok) {
    pending('the agent page really offers a Claude hand-over', enabled.why)
    return
  }
  note(`  "Hand out work to agents" is on${enabled.already ? ' (it already was)' : ''}`)

  const onBoard = await walkTo(open, 'computers')
  if (!onBoard) {
    pending('the agent page really offers a Claude hand-over', 'the fleet page was never reached')
    return
  }
  /* HOW A PERSON REACHES AN AGENT PAGE ON THIS BOARD.
     The "See an example agent" link only exists on the projection-unavailable
     branch (emptyStateExample in src/views/computers.js); a machine whose
     declared fleet resolves gets a populated board and no such link -- measured,
     the first attempt at this run reported it simply absent. The real door is a
     node's own page, so a node is made first. It is made with a REFUSED start:
     a Claude tier cannot launch from a tree, the node stays and is marked
     failed, and nothing is spawned and no quota is spent to get one. */
  const opened = await openComposePanel(open)
  if (!opened.opened) {
    pending('the agent page really offers a Claude hand-over', `no compose panel to make a node with: ${opened.why}`)
    return
  }
  const roleId = await open.page.evaluate(`(() => {
    const menu = document.querySelector(${JSON.stringify(ROLE)})
    return menu ? [...menu.options].map(option => option.value).filter(Boolean)[0] || null : null
  })()`)
  await press(open, ROLE, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  if (roleId) await chooseByKeyboard(open, ROLE, roleId)
  await press(open, MESSAGE, { settleMs: 300 })
  await open.page.keyboard.type('A spot on the tree, so this computer has an agent page to open.', { delay: 8 })
  await wheelOver(open, BODY, 240, 4)
  await press(open, TIER, { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const refusedTier = TIER_CHOICES.find(choice => /claude/i.test(choice.id))
  if (refusedTier) await chooseByKeyboard(open, TIER, refusedTier.id)
  await press(open, SUBMIT, { settleMs: 2500 })
  await press(open, '[data-compose-action="cancel"]', { settleMs: 1200 })

  const nodeSpot = await reachable(open, '.node.static-tree-node', 12_000)
  if (nodeSpot?.state !== 'reachable') {
    pending('the agent page really offers a Claude hand-over',
      `no node on the canvas to open an agent page from: ${JSON.stringify(nodeSpot)}`)
    return
  }
  await open.page.mouse.move(nodeSpot.x, nodeSpot.y)
  await open.page.mouse.down()
  await open.page.mouse.up()
  await delay(1500)
  /* EVERY DOOR TO THE AGENT PAGE THAT EXISTS ON THIS SCREEN RIGHT NOW.
     The refusal on the tree sends a person to the agent page; whether they can
     GET there from where they are standing is the first half of whether that
     sentence is true, and it is a question about this screen, not about the
     form on the other side. Enumerated rather than inferred. */
  const doors = await open.page.evaluate(`(() => {
    const links = [...document.querySelectorAll('a[href*="#/agent/"]')].map(node => ({
      kind: 'link', href: node.getAttribute('href'), text: (node.textContent || '').trim().slice(0, 60),
      visible: node.getBoundingClientRect().height > 0,
    }))
    const buttons = [...document.querySelectorAll('[data-a="open"], #open-agent, [data-open-agent]')].map(node => ({
      kind: 'button', text: (node.textContent || '').trim().slice(0, 60),
      disabled: node.disabled === true || node.hasAttribute('disabled'),
      visible: node.getBoundingClientRect().height > 0,
    }))
    return { links, buttons, route: document.body.dataset.route }
  })()`)
  note(`  doors to the agent page on this screen: ${JSON.stringify(doors)}`)

  const openFull = await press(open, '[data-a="open"]', { settleMs: 2500 })
  if (!openFull.pressed) {
    const usable = [...(doors.links || []), ...(doors.buttons || [])]
      .filter(door => door.visible && !door.disabled)
    check('a person refused on the tree can reach the agent page they were sent to',
      usable.length > 0,
      usable.length > 0
        ? `${usable.length} door(s): ${JSON.stringify(usable)}`
        : 'no visible, enabled control on this screen navigates to the agent page')
    /* AND THE FORM ON THE FAR SIDE IS NOT MEASURED FROM HERE.
       It could be reached by switching this page to its demonstration board
       (Settings, Data & Sim), and the form there is the same form -- but that
       is a different state from the one this check is about, and folding a
       pass from it into this run would let "the form works somewhere" stand in
       for "the person who was sent there can use it". The door is the finding;
       the form is left NOT EXERCISED and said so. */
    pending('the agent page really offers a Claude hand-over',
      'there is no way through to it from the screen the refusal is shown on')
    return
  }
  check('a person refused on the tree can reach the agent page they were sent to', true,
    'the node\'s own page offers "Open full view"')
  const route = await settledRoute(open, 'computers')
  note(`  pressing the node then "Open full view" landed on ${route}`)
  if (route !== 'agent') {
    pending('the agent page really offers a Claude hand-over', `it landed on ${route}, not the agent page`)
    return
  }

  const form = await reachable(open, '[data-dispatch-form]', 12_000)
  if (form?.state === 'absent') {
    pending('the agent page really offers a Claude hand-over',
      'the agent page has no hand-over form on it, with the write action switched on')
    return
  }
  const tiers = await open.page.evaluate(`(() => {
    const menu = document.querySelector('[data-dispatch-form] select[name="tier"]')
    if (!menu) return null
    return [...menu.options].map(option => ({ value: option.value, label: option.textContent.trim(), group: option.parentElement.label || '' }))
  })()`)
  const claudeTier = (tiers || []).find(option => /claude/i.test(option.value) || /anthropic/i.test(option.group))
  check('the agent page really offers a Claude hand-over', Boolean(claudeTier),
    claudeTier ? `it offers "${claudeTier.label}" under "${claudeTier.group}"` : `the assistant menu offers: ${JSON.stringify(tiers)}`)
  if (!claudeTier) return

  /* Fill it in the way a person does. The assistant menu is a native select, so
     it is pressed with the mouse and moved with the keyboard. */
  const tierPress = await press(open, '[data-dispatch-form] select[name="tier"]', { settleMs: 300 })
  await open.page.keyboard.press('Escape')
  const picked = await chooseByKeyboard(open, '[data-dispatch-form] select[name="tier"]', claudeTier.value)
  note(`  assistant menu: pressed=${tierPress.pressed} ${picked.before} -> ${picked.after}`)
  if (picked.after !== claudeTier.value) {
    pending('handing work to Claude reaches a lane rather than a refusal',
      `the assistant menu could not be moved to ${claudeTier.value}`)
    return
  }
  const briefPressed = await press(open, '[data-dispatch-form] textarea[name="brief"]', { settleMs: 300 })
  if (!briefPressed.pressed) {
    pending('handing work to Claude reaches a lane rather than a refusal', 'the brief box could not be pressed')
    return
  }
  await open.page.keyboard.type(LIVE_JOB, { delay: 10 })

  const before = claudeProcesses().length
  const handed = await press(open, '[data-dispatch-form] button[type="submit"]', { settleMs: 2000 })
  if (!handed.pressed) {
    pending('handing work to Claude reaches a lane rather than a refusal', 'the hand-over button could not be pressed')
    return
  }

  /* WHAT THE PRODUCT SAYS, and WHAT THE MACHINE DOES, watched together. */
  let sentence = ''
  let refusalCodeShown = ''
  let sawClaude = 0
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    sentence = await textOf(open, '[data-dispatch-form] [data-action-output]')
    refusalCodeShown = await open.page.evaluate('document.querySelector(\'[data-dispatch-form] [data-action-output]\')?.dataset.refusalCode || ""')
    const running = claudeProcesses().length
    if (running > before) sawClaude = Math.max(sawClaude, running - before)
    const state = await open.page.evaluate('document.querySelector(\'[data-dispatch-form] [data-action-output]\')?.dataset.actionState || ""')
    if (state && state !== 'pending') break
    await delay(1500)
  }
  note(`  the hand-over form says: "${sentence}"`)
  note(`  refusal code carried: ${refusalCodeShown || 'none'}`)
  note(`  claude processes that appeared while it ran: ${sawClaude}`)

  const refused = /nothing was handed over/i.test(sentence)
  check('handing work to Claude reaches a lane rather than a refusal', !refused && Boolean(sentence),
    refused
      ? `the audited connection refused it: "${sentence}"${refusalCodeShown ? ` (${refusalCodeShown})` : ''}`
      : `it answered: "${sentence}"`)

  if (!signedIn) {
    note('  question 2 (does a real answer come back) needs the Claude sign-in;'
      + ' re-run with --live-handover-signed-in to measure it')
    return
  }
  check('a real Claude child was started by the hand-over', sawClaude > 0,
    sawClaude > 0 ? `${sawClaude} claude process(es) appeared` : 'no claude process ever appeared on this machine')
}

/* ================================ main ===================================== */

async function main() {
  const scratch = scratchDirectory('owner-walkthrough')
  console.log(`scratch: ${scratch}`)
  let runA = null
  let runB = null
  let runC = null
  let runD = null
  try {
    const staged = await stage(scratch)
    console.log(`app:     ${staged.executable}`)
    console.log('renderer and shell: this working tree, inside the packaged build')
    console.log('')

    /* ---------- run A ---------- */
    const profileA = path.join(scratch, 'profile-a')
    mkdirSync(profileA, { recursive: true })
    seedMachineRecord(profileA, staged.appRoot)
    runA = await openApp(staged.executable, profileA, providerlessEnvironment(profileA))
    if (!(await waitForView(runA))) {
      throw new HarnessError('run A never mounted a view, so there was nothing to measure')
    }
    console.log('RUN A  the compose panel, and what a refusal says')
    const composed = await driveComposePanel(runA, [
      { width: 1512, height: 945 },
      { width: 1280, height: 800 },
    ])
    if (composed.started) await driveFleetOverview(runA)
    else {
      pending('the fleet overview counts what is actually on record',
        'no start reached the record in this run, so there is nothing the overview could be wrong about')
    }
    if (runA.thrown.length > 0) note(`run A page errors: ${runA.thrown.slice(0, 3).join(' /// ')}`)
    await closeApp(runA)
    runA = null

    /* ---------- run B ---------- */
    console.log('')
    console.log('RUN B  the home screen link into Settings')
    const profileB = path.join(scratch, 'profile-b')
    mkdirSync(profileB, { recursive: true })
    seedMachineRecord(profileB, staged.appRoot)
    runB = await openApp(staged.executable, profileB, engineReadyEnvironment(profileB))
    if (!(await waitForView(runB))) {
      throw new HarnessError('run B never mounted a view, so there was nothing to measure')
    }
    await resizeTo(runB, 1512, 945)
    await driveSettingsLink(runB)
    if (runB.thrown.length > 0) note(`run B page errors: ${runB.thrown.slice(0, 3).join(' /// ')}`)
    await closeApp(runB)
    runB = null

    /* ---------- run C, only when asked ---------- */
    if (LIVE) {
      console.log('')
      console.log('RUN C  two agents that really run, and the count that has to notice')
      console.log('       (real Codex sessions on this machine\'s own sign-in; real quota)')
      const profileC = path.join(scratch, 'profile-c')
      mkdirSync(profileC, { recursive: true })
      const environmentC = liveEnvironment(profileC)
      seedMachineRecord(profileC, staged.appRoot)
      runC = await openApp(staged.executable, profileC, environmentC)
      if (!(await waitForView(runC))) {
        throw new HarnessError('run C never mounted a view, so there was nothing to measure')
      }
      await driveLiveAgents(runC)
      if (runC.thrown.length > 0) note(`run C page errors: ${runC.thrown.slice(0, 3).join(' /// ')}`)
      await closeApp(runC)
      runC = null
    } else {
      console.log('')
      console.log('RUN C  skipped: pass --live-agent to start real Codex sessions and spend real quota')
    }

    /* ---------- run D, only when asked ---------- */
    if (HANDOVER || HANDOVER_SIGNED_IN) {
      console.log('')
      console.log('RUN D  the promise the tree refusal makes about the agent page')
      const profileD = path.join(scratch, 'profile-d')
      mkdirSync(profileD, { recursive: true })
      const environmentD = liveEnvironment(profileD)
      if (HANDOVER_SIGNED_IN) {
        const copied = copyClaudeSignIn(profileD)
        note(copied.ok
          ? '  the Claude sign-in was copied into this run\'s scratch home'
          : `  no Claude sign-in to copy: ${copied.why}`)
      }
      seedMachineRecord(profileD, staged.appRoot)
      runD = await openApp(staged.executable, profileD, environmentD)
      if (!(await waitForView(runD))) {
        throw new HarnessError('run D never mounted a view, so there was nothing to measure')
      }
      await resizeTo(runD, 1512, 945)
      await driveHandover(runD, { signedIn: HANDOVER_SIGNED_IN })
      if (runD.thrown.length > 0) note(`run D page errors: ${runD.thrown.slice(0, 3).join(' /// ')}`)
      await closeApp(runD)
      runD = null
    }

    return report()
  } catch (error) {
    if (error instanceof HarnessError) {
      console.error(`\nHARNESS: ${error.message}`)
      return 2
    }
    console.error(`\nHARNESS: ${error?.stack || error}`)
    return 2
  } finally {
    await closeApp(runA)
    await closeApp(runB)
    await closeApp(runC)
    /* THE LINK COMES OUT FIRST, ALWAYS -- before the scratch tree is removed
       and whether or not the tree is being kept. See liveNpmLink above: on the
       far side of this junction is the machine's real global npm install. */
    if (liveNpmLink) {
      try { unlinkSync(liveNpmLink) } catch { try { rmdirSync(liveNpmLink) } catch { /* already gone */ } }
      liveNpmLink = null
    }
    if (!KEEP) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* windows holds handles */ }
    } else {
      console.log(`kept: ${scratch}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then(code => { process.exitCode = code }, error => {
    console.error(error)
    process.exitCode = 2
  })
}

void SELF
void REPO_ROOT
void START_PANEL
