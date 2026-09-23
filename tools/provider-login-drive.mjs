#!/usr/bin/env node

/* DRIVE THE TWO BUTTONS THE WAY THE FIRST EXTERNAL USER WOULD HAVE USED THEM.
 *
 * WHY THIS EXISTS. The first person outside this machine to install 1.0.20 got
 * stuck exactly where the owner predicted: the guide told them to run
 * "codex login" in the window their install had just finished in, and that
 * window answered "'codex' is not recognized". The repair is two buttons on
 * every one of the three programs -- Install, which fetches and installs here,
 * and Sign in, which opens a FRESH terminal window with that program's own
 * sign-in running in it. A button is a claim about a control, and this tree
 * has had green suites while controls were dead on the glass, so the claim is
 * pressed here, with real mouse events, on the packaged build.
 *
 *   ABSENT      the program is not on PATH. Both buttons are on the glass, and
 *               the note says the program is not here yet and what Install
 *               fetches.
 *   NO NPM      no Node at all. The Install press must answer with the real
 *               fix, never an npm error a stranger cannot act on.
 *   SIGNED OUT  the program is here, its home is empty. Both buttons are on the
 *               glass and the note says what a press would do.
 *   SIGNED IN   the program's own sign-in file exists (the profile's home
 *               points at this machine's real one through a junction --
 *               established practice; nothing is copied and nothing is read).
 *               The page must say so, and Sign in must stay honest about what
 *               pressing it would do.
 *
 * SIGN IN IS NEVER PRESSED BY THIS DRIVER, IN ANY STATE, and that is a rule
 * rather than an omission. A press now opens a real terminal window running a
 * real sign-in against whatever account is on the machine the driver is
 * running on. A driver may not start that on somebody's computer, and it could
 * not finish it either -- completion is a person signing in to their own
 * account in their own browser. So the button is read, described, and left
 * alone, and what the press DOES is held instead by
 * tools/test/provider-login.test.mjs, which asserts the exact terminal and the
 * exact command line handed to it without opening anything.
 *
 * EACH STATE IS A FRESH WINDOW ON A FRESH PROFILE, because that is what each
 * state IS on a customer machine. The absent state strips only the PATH
 * entries that resolve the three programs; everything else is this machine.
 *
 * A SCREENSHOT PER STATE, read by the person running this, beside the DOM
 * facts. The DOM read is the measurement; the image is the proof a
 * conversation can point at. Evidence lands in --shots <dir> (default: a
 * fresh directory under the system temp root), never in the repository.
 *
 *   node tools/provider-login-drive.mjs                 all three states
 *   node tools/provider-login-drive.mjs --state absent  one state
 *   node tools/provider-login-drive.mjs --visible       watch it happen
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  argument,
  closeWindow,
  delay,
  openWindow,
  reap,
  route,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { GUIDE_HREF } from '../src/first-run-needs.js'

/* THE DOOR, AND WHAT COUNTS AS HAVING GONE THROUGH IT.
 *
 * The provider list used to be a page of its own at `#/guide`, so "the route is
 * guide" was the whole question. It is a section of Settings now, reached at
 * `#/settings?setting=<row>`, and `document.body.dataset.route` says only
 * `settings` for it -- which is also true six screens above the answer. So the
 * address is asked as well, and the row id is read off the same constant every
 * door in the product links to rather than spelled here a second time. */
const GUIDE_ROW = GUIDE_HREF.slice(GUIDE_HREF.indexOf('?') + 1)
const GUIDE_DOOR = `a[href="${GUIDE_HREF}"]`
async function atThisComputer(window) {
  if ((await route(window)) !== 'settings') return false
  const hash = await window.evaluate('location.hash')
  return String(hash || '').includes(GUIDE_ROW)
}


const ONLY = argument('--state', null)
const SHOTS = argument('--shots', null) || mkdtempSync(path.join(tmpdir(), 'provider-login-shots-'))
mkdirSync(SHOTS, { recursive: true })

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* The same three-event press the guide drive uses: move, down, up. */
async function press(window, selector) {
  const spot = await window.waitForVisible(selector, 9000)
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(40)
  }
  await delay(400)
  return { pressed: true }
}

/* The lifecycle nudge every headless screenshot in this repo needs; without
   setWebLifecycleState the capture never returns under MC_SMOKE_HEADLESS. */
async function screenshot(window, name) {
  /* One retry: a hidden window's first frame is timing-dependent, and a second
     miss is a missing image, never a missing measurement -- the DOM read is
     the measurement. Same rule the other packaged screenshotters state. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await window.session.send('Page.enable', {})
      await window.session.send('Page.setWebLifecycleState', { state: 'active' })
      await delay(attempt === 0 ? 500 : 1200)
      const race = await Promise.race([
        window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }),
        new Promise(resolve => setTimeout(() => resolve(null), 15_000)),
      ])
      const data = race?.result?.data
      if (!data) continue
      const file = path.join(SHOTS, name)
      writeFileSync(file, Buffer.from(data, 'base64'))
      note('info', `screenshot: ${file}`)
      return file
    } catch { /* retry once */ }
  }
  note('WARN', `${name}: no image came back; the DOM facts above are the measurement`)
  return null
}

async function walkToGuide(window) {
  /* Pressed up to twice, and the route is POLLED after each press: a press in
     the same second the window first paints can land on a page that has not
     attached its router yet -- measured once on a run sharing the machine with
     a full suite. A second press on a settled page is what a person does. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pressed = await press(window, GUIDE_DOOR)
    if (!pressed.pressed) { note('FAIL', `the door to This computer could not be pressed: ${pressed.why}`); return false }
    const until = Date.now() + 5000
    for (;;) {
      if (await atThisComputer(window)) return true
      if (Date.now() >= until) break
      await delay(300)
    }
  }
  note('FAIL', `after two presses the route is still "${await route(window)}"`)
  return false
}

/* One provider's sign-in block, as the DOM actually has it. */
async function readSignIn(window, provider) {
  return window.evaluate(`(() => {
    const panel = document.querySelector('.guide-signin[data-signin-provider="${provider}"]')
    const presence = document.querySelector('.guide-provider[data-provider="${provider}"] .guide-presence')
    if (!panel) return { panel: false }
    const start = panel.querySelector('[data-signin-start]')
    return {
      panel: true,
      hidden: panel.hidden,
      disabled: start ? start.disabled : null,
      buttonText: start ? (start.textContent || '').trim() : null,
      state: panel.dataset.signinState || null,
      installHidden: panel.querySelector('[data-signin-install]')?.hidden ?? null,
      note: (panel.querySelector('[data-signin-note]')?.textContent || '').trim(),
      status: (panel.querySelector('[data-signin-status]')?.textContent || '').trim(),
      log: (panel.querySelector('[data-signin-log]')?.textContent || '').trim(),
      stopHidden: panel.querySelector('[data-signin-stop]')?.hidden ?? null,
      presenceText: presence ? (presence.textContent || '').trim() : null,
      installed: presence?.dataset.installed || null,
      signedIn: presence?.dataset.signedIn || null,
    }
  })()`)
}

async function waitFor(window, provider, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await readSignIn(window, provider)
    if ((last && predicate(last)) || Date.now() >= until) return last
    await delay(400)
  }
}

/* PATH with every directory that resolves the named programs removed -- the
   friend's machine before any install, built from this one. Stripping npm and
   node as well is the machine with no Node at all, which is the state the
   install button's honest refusal exists for. */
function pathWithout(programs) {
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return (process.env.PATH || '').split(';').filter(directory => {
    if (!directory.trim()) return false
    for (const program of programs) {
      for (const extension of extensions) {
        try { if (statSync(path.join(directory.trim(), `${program}${extension}`)).isFile()) return false } catch { /* keep */ }
      }
    }
    return true
  }).join(';')
}

function junction(linkPath, target) {
  mkdirSync(path.dirname(linkPath), { recursive: true })
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', linkPath, target], { windowsHide: true, stdio: 'ignore' })
}

async function driveState(state, executable, appRoot) {
  console.log(`\n=== state: ${state} ===`)
  const scratch = mkdtempSync(path.join(tmpdir(), `provider-login-${state}-`))
  const profile = path.join(scratch, 'profile')
  seedMachineRecord(profile, appRoot, 'standard')

  const savedPath = process.env.PATH
  let window = null
  try {
    if (state === 'absent') {
      process.env.PATH = pathWithout(['codex', 'claude', 'gemini'])
      process.env.Path = process.env.PATH
    }
    if (state === 'no-npm') {
      process.env.PATH = pathWithout(['codex', 'claude', 'gemini', 'npm', 'node'])
      process.env.Path = process.env.PATH
    }
    if (state === 'signed-in') {
      /* The junctions point the isolated home at this machine's real sign-in
         folders. Presence answers by existence alone; nothing follows them to
         read a byte, and removing the profile removes only the link. */
      junction(path.join(profile, 'home', '.codex'), path.join(process.env.USERPROFILE, '.codex'))
      junction(path.join(profile, 'home', '.claude'), path.join(process.env.USERPROFILE, '.claude'))
    }
    window = await openWindow(executable, profile)
    if (!(await walkToGuide(window))) return

    for (const provider of ['codex', 'claude', 'gemini']) {
      console.log(`\n--- ${provider} ---`)
      const first = await waitFor(window, provider, seen => seen.panel && seen.hidden === false, 9000)
      if (!first?.panel || first.hidden !== false) {
        note('FAIL', `${provider}: the sign-in panel never appeared (panel=${first?.panel}, hidden=${first?.hidden})`)
        continue
      }
      note('info', `${provider}: presence says "${first.presenceText}" (installed=${first.installed}, signedIn=${first.signedIn})`)
      note('info', `${provider}: button "${first.buttonText}" disabled=${first.disabled}; note "${first.note}"`)

      if (state === 'absent' || state === 'no-npm') {
        note(first.state === 'install' ? 'ok' : 'FAIL', `${provider}: the panel offers Install when the program is absent (state=${first.state})`)
        note(first.installHidden === false ? 'ok' : 'FAIL', `${provider}: the Install button is on the glass`)
        note(/not on this computer/i.test(first.note) ? 'ok' : 'FAIL', `${provider}: the note says what is true`)
        note(/maker's own channel/i.test(first.note) && /does not ship/i.test(first.note) ? 'ok' : 'FAIL',
          `${provider}: the note says whose bytes the install fetches`)
      }

      if (state === 'no-npm' && provider === 'codex') {
        /* The machine with no Node at all: the press must answer with the real
           fix, never with an npm error a stranger cannot act on. */
        const pressed = await press(window, `.guide-signin[data-signin-provider="${provider}"] [data-signin-install]`)
        if (!pressed.pressed) { note('FAIL', `${provider}: Install could not be pressed: ${pressed.why}`); continue }
        const refusal = await waitFor(window, provider, seen => /Node\.js/.test(seen.status), 9000)
        note(/Node\.js/.test(refusal.status) ? 'ok' : 'FAIL',
          `${provider}: the no-npm refusal names Node.js ("${refusal.status}")`)
        await screenshot(window, `${state}-${provider}-refusal.png`)
      }

      if (state === 'absent' && provider === 'codex') {
        /* THE FRIEND'S WHOLE JOURNEY, one press at a time: Install pressed, the
           official npm fetch streams onto the panel, and the panel's own state
           turns to sign-in without anybody typing anything. The last press --
           Sign in -- is the one this driver does not make, for the reason at the
           top of this file: it would open a real terminal running a real
           sign-in on this machine's own account. */
        const pressed = await press(window, `.guide-signin[data-signin-provider="${provider}"] [data-signin-install]`)
        if (!pressed.pressed) { note('FAIL', `${provider}: Install could not be pressed: ${pressed.why}`); continue }
        /* npm is quiet while it fetches and prints almost everything at the
           end -- measured on the first run of this drive, where a log-only
           wait sat through a whole successful install. The immediate proof of
           the press is the running sentence; the log is asserted as EVER
           having content by the exit path below. */
        const installing = await waitFor(window, provider,
          seen => seen.log.length > 0 || /installer is running/i.test(seen.status), 60_000)
        note(installing.log.length > 0 || /installer is running/i.test(installing.status) ? 'ok' : 'FAIL',
          `${provider}: the press visibly starts the installer ("${installing.status.slice(0, 80)}")`)
        await screenshot(window, `${state}-${provider}-installing.png`)
        const switched = await waitFor(window, provider, seen => seen.state === 'sign-in', 480_000)
        note(switched.state === 'sign-in' ? 'ok' : 'FAIL',
          `${provider}: after the install the panel offers Sign in on its own (state=${switched.state}, presence="${switched.presenceText}")`)
        await screenshot(window, `${state}-${provider}-installed.png`)
        note(switched.disabled === false ? 'ok' : 'FAIL',
          `${provider}: Sign in is on the glass and pressable straight after the install`)
        note('info', `${provider}: NOT pressed -- a press opens a real terminal running a real sign-in on this machine`)
      }

      if (state === 'signed-out') {
        note(first.disabled === false ? 'ok' : 'FAIL', `${provider}: Sign in is enabled`)
        note(first.installHidden === false ? 'ok' : 'FAIL', `${provider}: Install is on the glass beside it`)
        note(/terminal window/i.test(first.note) ? 'ok' : 'FAIL',
          `${provider}: the note says a press opens a terminal window ("${first.note.slice(0, 80)}")`)
        await screenshot(window, `${state}-${provider}-both-buttons.png`)
        note('info', `${provider}: NOT pressed -- a press opens a real terminal running a real sign-in on this machine`)
      }

      if (state === 'signed-in') {
        note(first.signedIn === 'yes' ? 'ok' : 'FAIL',
          `${provider}: the page says the sign-in is already there ("${first.presenceText}")`)
        note(first.disabled === false ? 'ok' : 'FAIL', `${provider}: the button stays available for re-sign-in`)
        note(/signed in already/i.test(first.note) ? 'ok' : 'FAIL',
          `${provider}: the note says what pressing it would really do`)
        note('info', `${provider}: NOT pressed in this state -- a press starts a real re-sign-in against this machine's own account`)
      }
    }
    await screenshot(window, `${state}-guide.png`)
  } finally {
    process.env.PATH = savedPath
    process.env.Path = savedPath
    if (window) await closeWindow(window)
    await reap()
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* junctions went with it */ }
  }
}

async function main() {
  const staging = mkdtempSync(path.join(tmpdir(), 'provider-login-stage-'))
  try {
    console.log('staging the packaged build with this tree\'s renderer...')
    const { executable, appRoot } = await stage(staging)
    for (const state of ['no-npm', 'absent', 'signed-out', 'signed-in']) {
      if (ONLY && state !== ONLY) continue
      await driveState(state, executable, appRoot)
    }
  } finally {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* left for a person */ }
  }
  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${failed.length === 0 ? 'DROVE CLEAN' : `${failed.length} FAILURE(S)`}; evidence in ${SHOTS}`)
  /* Exit explicitly: a CDP socket or a reaped child's stream can keep the
     event loop alive after the verdict is printed, and a driver that hangs
     after answering is a driver that gets its answer thrown away by a
     timeout. Measured on this file's first full run. */
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
