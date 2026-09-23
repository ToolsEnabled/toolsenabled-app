#!/usr/bin/env node

/* THE CONTEXT WINDOW: MEASURED AT THREE WIDTHS, PHOTOGRAPHED WHERE IT CAN BE.
 *
 * The owner, 2026-08-19: "the context windows were still not coming out nicely
 * enough." His phrase for the chat panel on the fleet board -- the transcript
 * with the agent's tool actions interleaved between the messages -- and his
 * SECOND complaint about it. So the bar is his eye, and the evidence has to be
 * pictures of a real conversation, not a test count.
 *
 * WHAT THIS DRIVE EXISTS TO SETTLE, in the order it settles it:
 *
 *   1  THE ROWS ARE THERE AT ALL. `.chat-action` clips with overflow: hidden
 *      inside a column flex container, and per flexbox an item whose overflow
 *      is not `visible` has an automatic minimum size of ZERO. So the moment a
 *      conversation is tall enough to scroll -- every real one -- the log takes
 *      its negative free space out of the only shrinkable items and every
 *      action row paints at about one pixel. The `.msg` bubbles never shrink
 *      because their overflow IS visible, which is why a four-message demo
 *      looked perfect. This drive therefore builds a log that GENUINELY
 *      SCROLLS before it measures anything, and refuses to report on one that
 *      does not: a measurement taken on a log with free space to spare cannot
 *      see this defect and must not be quoted as clearing it.
 *
 *   2  A PRESS OPENS A ROW. Predicted to be the same defect (at 1px the
 *      disclosure paints nothing and elementFromPoint lands on a neighbour),
 *      but a sibling measured `open` staying false and a prediction is not a
 *      measurement. Pressed here with a real move -> down -> up at coordinates
 *      taken from the row's own box, with elementFromPoint read BEFORE the
 *      press, and the `open` property read after.
 *
 *   3  A ROW WITH NOTHING TO OPEN DOES NOT PRETEND TO BE A CONTROL. When a
 *      turn ends its rows are filed into the saved record, which keeps the
 *      command and not the output, and they are redrawn from there. Those rows
 *      must draw no disclosure mark and must refuse a press without moving.
 *
 *   4  A LONG COMMAND DOES NOT PUSH THE LOG SIDEWAYS. `flex: none` stops rows
 *      shrinking; it must not let them GROW past the log either.
 *
 *   5  AND EVERY OUTCOME WORD IS TRUE. A row that says "running" after its turn
 *      ended, or "did not finish" about a command that was never allowed to
 *      start, is the transcript telling a person something untrue -- and both
 *      were only READABLE once the rows had height. The drive tallies the
 *      outcome words, prints each row's own body beside them, and taps the
 *      preload channel so the words can be checked against what the engine
 *      actually said rather than against what the picture suggests.
 *
 * ON THE WIDTHS, SAID PLAINLY BECAUSE IT LIMITS WHAT THIS FILE CAN PROVE. The
 * display is a ceiling: at devicePixelRatio 1.375 a real window clamps at 1400
 * CSS px, so a 1920-CSS-pixel window cannot exist on this machine and no honest
 * photograph of one can either. Above the ceiling the drive MEASURES under an
 * emulated viewport -- geometry is the one thing emulation genuinely does -- and
 * takes no picture. Every reading prints which mode produced it. See
 * driveAtWidth, and the capture write-up beside openWindow in
 * tools/test-account-harness.mjs.
 *
 * BEFORE AND AFTER ARE THE SAME CONVERSATION. The engine is the narrating
 * fixture (tools/test/fixtures/narrating-engine), so both runs replay an
 * identical turn and the ONLY difference between the two sets of pictures is
 * the stylesheet. A real model would make the two runs differ in their own
 * right and could not answer a question about layout.
 *   --real drives a real Codex (luna) session instead, for the one question
 *   the fixture cannot answer: what a REAL command row says, given that the
 *   engine delivers every shell line wrapped in powershell.exe -Command '...'.
 *
 * Staging, isolation and input discipline are tools/test-account-harness.mjs's:
 * a scratch copy of release/win-unpacked carrying this tree's dist/ and shell/,
 * never the installed app, never the NSIS installer, on a sterile profile.
 * Navigation is by pressing #nav-next; auditSelf() fails the run if a hash
 * assignment ever creeps into this file.
 *
 *   node tools/context-window-drive.mjs --label=after
 *   node tools/context-window-drive.mjs --label=before --release=<dir>
 *   node tools/context-window-drive.mjs --real --label=real-codex
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { argument, assertIsolated, delay, openWindow, reap, seedMachineRecord, stage, userDataFor } from './test-account-harness.mjs'
import { describeActiveRouteResult, pressForwardToActiveRoute } from './lib/active-route-navigation.mjs'

const KEEP = process.argv.includes('--keep')
const REAL = process.argv.includes('--real')
const LABEL = argument('--label', REAL ? 'real-codex' : 'after')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SELF = fileURLToPath(import.meta.url)
const NARRATING_ENGINE = path.join(REPO, 'tools/test/fixtures/narrating-engine/src/lib/agent-engine/codex-process.js')
const OUT = path.resolve(argument('--out', path.join(REPO, 'reports', 'context-window', LABEL)))
/* Turns to send after the opening one. Each fixture turn adds three action
   rows and two bubbles; the log has to end up taller than it is, or the defect
   under measurement is not in the frame. */
const EXTRA_TURNS = Number(argument('--turns', REAL ? '1' : '4'))

const findings = []
const note = (level, text) => {
  findings.push({ level, text })
  if (level === 'FAIL') process.exitCode = 1
  console.log(`  ${level.padEnd(5)} ${text}`)
}

/* WHERE THE RUN IS, PRINTED AS IT GOES -- and it is evidence, not chatter.
 * A run of this drive stalled for twelve minutes and printed one line, so the
 * only thing knowable afterwards was "somewhere between staging and the first
 * finding". The harness's evaluate() has no deadline of its own: when the
 * renderer stops servicing Runtime.evaluate -- which it does on a machine
 * carrying six other lanes' Electron windows -- the await never returns. A
 * breadcrumb plus the watchdog below turns that into a reported stall with a
 * place name on it. A timeout is a CONTINUATION, never a pass. */
let where = 'starting'
let livePid = null
const step = name => { where = name; console.log(`  ..    ${name}`) }

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

/* SIGN-IN BY JUNCTION, NEVER BY COPY -- the rule tools/inside-agents-drive.mjs
   states in full: a copy gives one credential two identities and the owner's
   own sign-in dies when the CLI rotates the token out from under it. Nothing
   here opens, reads, copies or prints a credential. */
function junction(from, to, label) {
  try {
    if (!existsSync(from)) return `${label}: nothing at ${from}`
    if (existsSync(to)) return `${label}: already present`
    mkdirSync(path.dirname(to), { recursive: true })
    symlinkSync(from, to, 'junction')
    return `${label}: junction to the real home (no credential was read)`
  } catch (error) {
    return `${label}: FAILED ${String(error?.message || error)}`
  }
}

/* --------------------------------------------------------------- shots -- */

const SHOT_DEADLINE_MS = 12_000
const withDeadline = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms}ms`)), ms)),
])

/* setWebLifecycleState active, then a real 1px mouse move, then two frames.
   Measured by a sibling drive and again here: a window opened with show:false
   under MC_SMOKE_HEADLESS=1 is not compositing, captureScreenshot waits for a
   frame that will never come, and rAF alone does not wake it -- a real input
   event does. */
async function shoot(window, name) {
  try {
    mkdirSync(OUT, { recursive: true })
    await withDeadline(window.session.send('Page.setWebLifecycleState', { state: 'active' }), SHOT_DEADLINE_MS, 'the lifecycle change')
    let shot = null
    for (let attempt = 0; attempt < 3 && !shot; attempt += 1) {
      try {
        await window.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4 + attempt, y: 4, button: 'none' })
        await withDeadline(
          window.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))'),
          SHOT_DEADLINE_MS, 'the paint nudge',
        )
        /* THE CAPTURE COMES OFF THE WINDOW SURFACE, and both alternatives were
         * measured on this build rather than assumed:
         *
         *   fromSurface: false   NEVER RETURNS under MC_SMOKE_HEADLESS=1. Three
         *                        attempts, a 12s deadline on each, every one
         *                        timed out. Not slow -- dead.
         *   fromSurface: true    returns, and photographs the NATIVE window.
         *
         * Which means Emulation.setDeviceMetricsOverride is the wrong tool for
         * a width sweep here: it resizes what the DOM lays out for and NOT the
         * surface, so an "at 1440" picture showed a layout the DOM in the same
         * run said was not there (log measured at x=1049, chat panel outside
         * the frame). The window is therefore really resized instead -- see the
         * width sweep below -- which is also what a person does. */
        shot = await withDeadline(
          window.session.send('Page.captureScreenshot', { format: 'png' }),
          SHOT_DEADLINE_MS, 'the capture',
        )
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    const file = path.join(OUT, name)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  shot  ${file}`)
    return file
  } catch (error) {
    note('WARN', `${name} could not be captured (${error?.message || error})`)
    return null
  }
}

/* ------------------------------------------------------------ pressing -- */

/* WHERE THE PRESS WILL LAND, AND WHO WILL RECEIVE IT -- read before anything
   is dispatched, so a press that goes to a neighbouring bubble is a recorded
   fact rather than an unexplained non-effect. */
const AIM_FN = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  try { node.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* detached */ }
  const box = node.getBoundingClientRect()
  const name = el => el ? el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') : 'nothing'
  if (box.width < 1 || box.height < 1) {
    return { state: 'zero-size', box: { x: Math.round(box.x), y: Math.round(box.y), w: box.width, h: box.height } }
  }
  const x = Math.min(Math.max(box.x + Math.min(box.width / 2, 140), 1), innerWidth - 2)
  const y = Math.min(Math.max(box.y + box.height / 2, 1), innerHeight - 2)
  const hit = document.elementFromPoint(x, y)
  return {
    state: 'aimed',
    x, y,
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height * 100) / 100 },
    hit: name(hit),
    receives: Boolean(hit && (hit === node || node.contains(hit) || hit.contains(node))),
    onTarget: Boolean(hit && (hit === node || node.contains(hit))),
  }
}`

async function aim(window, selector) {
  return window.evaluate(`(${AIM_FN})(${JSON.stringify(selector)})`)
}

/* A REAL GESTURE: move, down, up. Never el.click(), never dispatchEvent -- a
   synthetic event proves the handler runs, which is not the question when the
   complaint is that pressing the thing on screen does nothing. */
async function pressAt(window, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(420)
}

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  await pressAt(window, spot.x, spot.y)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
  await delay(320)
}

/* A <select> under CDP: Escape the native popup first, then arrow to the
   value. Ported from tools/chat-history-drive.mjs, which measured this. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  const seen = []
  for (let i = 0; i < maxPresses; i += 1) {
    const now = await valueNow()
    seen.push(now)
    if (now === wanted) return { ok: true }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${JSON.stringify(wanted)}; saw ${JSON.stringify([...new Set(seen)])}` }
}

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

/* ---------------------------------------------------------- measuring -- */

/* THE LOG, AS GEOMETRY. Every number here is read from a live layout: the
   heights the rows actually drew, whether the log has negative free space to
   distribute (which is the precondition for the defect), and whether a row's
   own head is being clipped by its own overflow. */
const MEASURE_FN = `(hostSelector) => {
  const round = n => Math.round(n * 100) / 100
  const host = document.querySelector(hostSelector)
  const log = host && host.querySelector('.chat-log')
  if (!log) return { absent: true, host: Boolean(host) }
  const boxOf = node => {
    const b = node.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: round(b.width), h: round(b.height) }
  }
  const rows = [...log.querySelectorAll('details.chat-action')].map((row, index) => {
    const head = row.querySelector('.chat-action-head')
    const detail = row.querySelector('.chat-action-detail')
    const mark = row.querySelector('.chat-action-mark')
    const body = row.querySelector('.chat-action-body')
    const style = getComputedStyle(row)
    return {
      index,
      open: row.open === true,
      bare: row.classList.contains('is-bare'),
      flexShrink: style.flexShrink,
      flexBasis: style.flexBasis,
      box: boxOf(row),
      headBox: head ? boxOf(head) : null,
      headScrollHeight: head ? head.scrollHeight : null,
      clipsItsOwnHead: head ? round(row.getBoundingClientRect().height) + 0.5 < head.scrollHeight : null,
      markVisibility: mark ? getComputedStyle(mark).visibility : null,
      tool: (row.querySelector('.chat-action-tool')?.textContent || '').trim(),
      detail: (detail?.textContent || '').trim().slice(0, 200),
      detailFont: detail ? getComputedStyle(detail).fontFamily : null,
      detailEllipsised: detail ? detail.scrollWidth > detail.clientWidth + 1 : null,
      detailTitle: (detail?.title || '').slice(0, 200),
      bodyChars: body ? body.textContent.length : 0,
      /* THE OUTCOME'S OWN EVIDENCE. A row reading "did not finish" is a claim,
         and the only way to tell a real failing command from a harness that
         refused it is to read what the row is holding. Trimmed, because this
         goes in a committed file. */
      bodyText: body ? body.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
      bodyBox: body ? boxOf(body) : null,
      state: (row.querySelector('.chat-action-state')?.textContent || '').trim(),
      stateKey: row.dataset.actionState || '',
    }
  })
  const msgs = [...log.querySelectorAll('.msg')].map(m => ({
    kind: [...m.classList].filter(c => c !== 'msg').join(' ') || '(none)',
    who: (m.querySelector('.who')?.textContent || '').trim() || null,
    chars: (m.querySelector('.chat-msg-text')?.textContent || m.textContent || '').trim().length,
    box: boxOf(m),
    background: getComputedStyle(m).backgroundImage === 'none' ? getComputedStyle(m).backgroundColor : 'gradient',
  }))
  return {
    viewport: { w: innerWidth, h: innerHeight },
    log: {
      ...boxOf(log),
      clientHeight: log.clientHeight,
      scrollHeight: log.scrollHeight,
      clientWidth: log.clientWidth,
      scrollWidth: log.scrollWidth,
      /* THE PRECONDITION. Without negative free space the flex container has
         nothing to take out of its items and the 1px collapse cannot appear;
         a run that measured a short log has proved nothing. */
      scrolls: log.scrollHeight > log.clientHeight + 1,
      overflowsSideways: log.scrollWidth > log.clientWidth + 1,
      paddingRight: getComputedStyle(log).paddingRight,
    },
    pageScrollsSideways: document.documentElement.scrollWidth > innerWidth + 1,
    rows,
    msgs,
    contextBubbles: msgs.filter(m => m.kind.includes('context')).length,
  }
}`

const HOST = '[data-rail-chat-host]'

async function measure(window, what) {
  return readOrThrow(await window.evaluate(`(${MEASURE_FN})(${JSON.stringify(HOST)})`), what)
}

function describeRows(rows) {
  if (rows.length === 0) return 'no action rows'
  const heights = rows.map(r => r.box.h)
  const hair = rows.filter(r => r.box.h < 6).length
  return `${rows.length} rows, heights ${Math.min(...heights)}–${Math.max(...heights)}px` +
    (hair ? `, ${hair} of them under 6px (COLLAPSED)` : '')
}

/* ------------------------------------------------------------- driving -- */

async function clickToComputers(window) {
  const reached = await pressForwardToActiveRoute(window, {
    hash: '#/computers',
    route: 'computers',
    pageSelector: '.computers',
    pollMs: 250,
  })
  if (reached.ok) return true
  note('FAIL', `the Computers page never became the active page: ${describeActiveRouteResult(reached)}`)
  return false
}

async function sendTurn(window, text) {
  const typed = await press(window, `${HOST} .chat-input input`)
  if (!typed.pressed) return { sent: false, why: `the composer would not take focus (${typed.why})` }
  await window.session.send('Input.insertText', { text })
  await delay(200)
  const sent = await press(window, `${HOST} .chat-send`)
  if (!sent.pressed) return { sent: false, why: `Send would not press (${sent.why})` }
  return { sent: true }
}

async function drive(executable, profile, appRoot) {
  seedMachineRecord(profile, appRoot)
  if (REAL) {
    note('info', junction(path.join(process.env.USERPROFILE || '', '.codex'), path.join(profile, 'home', '.codex'), 'codex home'))
  }
  step('opening the window')
  const window = await openWindow(executable, profile)
  livePid = window.child?.pid ?? null
  const record = { label: LABEL, real: REAL, at: new Date().toISOString() }
  try {
    await delay(2500)
    /* THE ISOLATION PROOF, read from what the app WROTE. Belief is not
       accepted: the file's location is the evidence that this run never touched
       the real installation's data directory. */
    record.isolatedPrefs = assertIsolated(profile)
    step('pressing through to the computers page')
    if (!(await clickToComputers(window))) return record
    await delay(2200)

    step('finding the empty circle')
    /* -- start an agent, by pressing what a person presses ---------------- */
    /* WAITED FOR, NOT SAMPLED. The board draws its empty slot after the fleet
       store answers, and a drive that pressed at a fixed delay reported the
       circle "absent" on a machine that was merely busier than the last run. */
    let empty = { pressed: false, why: 'never looked' }
    for (let attempt = 0; attempt < 8 && !empty.pressed; attempt += 1) {
      empty = await press(window, '.computers .tree-empty-node', 4000)
      if (!empty.pressed) await delay(1200)
    }
    if (!empty.pressed) {
      record.boardWhenEmpty = readOrThrow(await window.evaluate(`(() => ({
        route: document.body.dataset.route,
        nodes: document.querySelectorAll('.computers .node').length,
        emptyNodes: document.querySelectorAll('.computers .tree-empty-node').length,
        staticNodes: document.querySelectorAll('.computers .static-tree-node').length,
        orgStatus: (document.querySelector('.org-status')?.textContent || '').trim().slice(0, 300),
        text: (document.querySelector('.computers') || document.body).innerText.replace(/\\s+/g, ' ').trim().slice(0, 600),
      }))()`), 'the board with no empty circle')
      note('FAIL', `the empty circle would not press (${empty.why}); the board said ${JSON.stringify(record.boardWhenEmpty)}`)
      await shoot(window, '00-no-empty-circle.png')
      return record
    }
    await delay(1600)
    if ((await window.visibility('[data-compose-unavailable-action="panel"]'))?.state === 'visible') {
      const flipped = await press(window, '[data-compose-unavailable-action="panel"]')
      note(flipped.pressed ? 'info' : 'FAIL', flipped.pressed
        ? 'starting was switched off; pressed the panel’s own switch'
        : `the in-panel start switch would not press (${flipped.why})`)
      await delay(1400)
    }
    step('reading the compose menus')
    const offered = readOrThrow(await window.evaluate(`(() => {
      const read = field => {
        const node = document.querySelector('[data-compose-field="' + field + '"]')
        return node ? [...node.options].map(o => o.value).filter(Boolean) : []
      }
      return { tiers: read('tier'), roles: read('role') }
    })()`), 'the compose menus')
    record.offered = offered
    const wantedTier = REAL ? 'luna' : offered.tiers[0]
    if (!offered.tiers.includes(wantedTier) || !offered.roles.length) {
      note('FAIL', `the compose panel cannot start ${wantedTier} (offers ${JSON.stringify(offered)})`)
      return record
    }
    const gotRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
    if (!gotRole.ok) { note('FAIL', `could not choose a role (${gotRole.why})`); return record }
    const gotTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', wantedTier)
    if (!gotTier.ok) { note('FAIL', `could not choose ${wantedTier} (${gotTier.why})`); return record }
    /* THE REAL PROMPT CARRIES ITS OWN POSITIVE CONTROL. `node --version` and
       `npm --version` should succeed anywhere this product runs; `git rev-parse`
       in a folder that is not a repository should fail. If all three come back
       "did not finish", the harness is refusing commands and the words are
       about this driver -- if only the third does, the words are about the
       commands. A tally with no control in it cannot tell those apart, and a
       coordinator looking at a picture could not either. */
    const opening = REAL
      ? 'Run these three commands with your shell tool, one after another, and say nothing else: `node --version`, then `npm --version`, then `git rev-parse --short HEAD`.'
      : 'Check the tests and tell me what you found.'
    const focused = await press(window, '[data-compose-field="message"]')
    if (!focused.pressed) { note('FAIL', `the brief field would not take focus (${focused.why})`); return record }
    await window.session.send('Input.insertText', { text: opening })
    await delay(200)
    /* A TAP ON THE WIRE, SO A ROW'S WORD CAN BE CHOSEN BY WHAT THE ENGINE SAID.
     *
     * The renderer keeps the row, not the packet that made it, so from the DOM
     * alone a refused command and a failed one are indistinguishable -- both
     * arrive as a non-zero exit or a failed status. Deciding the word from the
     * OUTPUT PROSE ("… rejected: blocked by policy") would be guessing at
     * prose, which is exactly what this codebase refuses to do elsewhere. So
     * the drive subscribes to the same preload channel the view does and keeps
     * the raw tool events. It reads; it changes nothing. */
    await window.evaluate(`(() => {
      if (window.__ctxTap) return true
      window.__ctxTap = []
      window.mcAgent.onEvent(packet => {
        const event = packet && packet.event
        if (!event || (event.type !== 'tool_call' && event.type !== 'tool_result')) return
        if (window.__ctxTap.length >= 80) return
        try {
          window.__ctxTap.push(JSON.parse(JSON.stringify({
            type: event.type, tool: event.tool, status: event.status,
            toolCallId: event.toolCallId, payload: event.payload,
          })))
        } catch { /* an unserialisable packet is not worth losing the run over */ }
      })
      return true
    })()`)

    step('starting the agent')
    const started = await press(window, '[data-compose-action="start"]')
    if (!started.pressed) { note('FAIL', `Start would not press (${started.why})`); return record }

    const circle = await window.waitForVisible('.node[data-agent-id]', 20000)
    if (circle?.state !== 'visible') {
      const said = readOrThrow(await window.evaluate(`(() => ({
        status: (document.querySelector('[data-compose-status]')?.textContent || '').trim(),
        problems: [...document.querySelectorAll('[data-compose-problem]')].map(n => n.textContent.trim()).filter(Boolean),
      }))()`), 'the compose refusal')
      note('FAIL', `the start drew no reachable circle (${circle?.state}); the panel said ${JSON.stringify(said)}`)
      return record
    }
    const pressedCircle = await press(window, '.node[data-agent-id]')
    if (!pressedCircle.pressed) { note('FAIL', `the circle would not press (${pressedCircle.why})`); return record }
    await delay(REAL ? 9000 : 6000)

    step('sending a turn and measuring mid-turn')
    /* -- 1 · MID-TURN: rows that still hold what the command printed ------ */
    const later = await sendTurn(window, REAL
      ? 'Now run `node --version` once more and say only the version.'
      : 'Run it again please.')
    if (!later.sent) note('WARN', `a follow-up turn could not be sent: ${later.why}`)
    await delay(REAL ? 4000 : 1500)
    record.midTurn = await measure(window, 'the mid-turn log')
    note('info', `mid-turn: ${describeRows(record.midTurn.rows || [])}, log ${record.midTurn.log?.scrollHeight}px in ${record.midTurn.log?.clientHeight}px (${record.midTurn.log?.scrolls ? 'SCROLLS' : 'fits'})`)
    await shoot(window, '01-mid-turn.png')

    /* THE PRESS, ON A ROW THAT HAS SOMETHING TO OPEN. Everything about this
       verdict is recorded: where the press landed, who elementFromPoint said
       would receive it, and what `open` was before and after. */
    const openable = (record.midTurn.rows || []).find(row => !row.bare && row.bodyChars > 0)
    if (!openable) {
      note('WARN', 'no row with captured output was on screen mid-turn; the press verdict comes from the restored rows below only')
    } else {
      await window.evaluate(`(() => {
        const rows = document.querySelectorAll('${HOST} details.chat-action')
        const row = rows[${openable.index}]
        if (row) row.id = 'ctx-drive-openable'
        return true
      })()`)
      const aimed = readOrThrow(await aim(window, '#ctx-drive-openable'), 'the openable row aim')
      record.pressOpenable = { before: openable, aimed }
      if (aimed.state !== 'aimed') {
        note('FAIL', `the row could not even be aimed at: ${JSON.stringify(aimed)}`)
      } else {
        await pressAt(window, aimed.x, aimed.y)
        const after = readOrThrow(await window.evaluate(`(() => {
          const row = document.getElementById('ctx-drive-openable')
          if (!row) return { gone: true }
          const body = row.querySelector('.chat-action-body')
          return { open: row.open === true, h: Math.round(row.getBoundingClientRect().height * 100) / 100, bodyH: body ? Math.round(body.getBoundingClientRect().height * 100) / 100 : null }
        })()`), 'the row after the press')
        record.pressOpenable.after = after
        const opened = after.open === true && after.h > openable.box.h + 4
        note(opened ? 'PASS' : 'FAIL',
          `press-to-open: aimed at (${Math.round(aimed.x)},${Math.round(aimed.y)}) on a ${aimed.box.h}px row, ` +
          `elementFromPoint answered ${aimed.hit} (${aimed.onTarget ? 'the row itself' : 'NOT the row'}); ` +
          `after a real move→down→up open=${after.open}, row ${openable.box.h}px → ${after.h}px, body ${after.bodyH}px`)
        await shoot(window, '02-row-opened.png')
      }
    }

    step('building a log tall enough to scroll')
    /* -- 2 · a log tall enough that the container must take space back ---- */
    for (let turn = 0; turn < EXTRA_TURNS; turn += 1) {
      const again = await sendTurn(window, REAL ? 'Run `git status --short` and say only the first line.' : `Again, please (${turn + 2}).`)
      if (!again.sent) { note('WARN', `turn ${turn + 2} could not be sent: ${again.why}`); break }
      await delay(REAL ? 12000 : 5200)
    }
    await delay(1800)
    record.settled = await measure(window, 'the settled log')
    note(record.settled.log?.scrolls ? 'info' : 'FAIL',
      `settled: ${describeRows(record.settled.rows || [])}, log ${record.settled.log?.scrollHeight}px in ${record.settled.log?.clientHeight}px ` +
      `(${record.settled.log?.scrolls ? 'SCROLLS — the container has negative free space to distribute' : 'DOES NOT SCROLL — this run cannot see the defect and must not be quoted as clearing it'})`)
    /* WHAT THE OUTCOME WORDS ACTUALLY SAY, counted rather than eyeballed. A
       coordinator looking at a picture could not tell whether four rows reading
       "did not finish" meant four real commands failing or a fixture producing
       them on purpose, and that is the difference between a cosmetic note and
       the biggest finding of the night. The tally plus each row's own body is
       what settles it. */
    const tally = {}
    for (const row of record.settled.rows || []) tally[row.state || '(none)'] = (tally[row.state || '(none)'] || 0) + 1
    record.outcomeWords = tally
    note('info', `outcome words: ${JSON.stringify(tally)} (engine: ${REAL ? 'REAL codex/luna' : 'the narrating FIXTURE, which fails one call of every three on purpose'})`)
    for (const row of (record.settled.rows || []).filter(r => r.stateKey === 'undone' || r.stateKey === 'unknown')) {
      note('info', `  ${row.state}: ${JSON.stringify(row.detail)} — the row holds ${JSON.stringify(row.bodyText.slice(0, 200))}`)
    }
    /* WHAT THE ENGINE ACTUALLY SAID, beside what the row made of it. This is
       the evidence a row's outcome word has to be chosen from. */
    record.toolEvents = readOrThrow(await window.evaluate('window.__ctxTap || []'), 'the tapped tool events')
    for (const event of record.toolEvents.filter(e => e.type === 'tool_result')) {
      note('info', `  wire: ${JSON.stringify({ tool: event.tool, status: event.status, payload: event.payload })}`.slice(0, 420))
    }

    const stillRunning = (record.settled.rows || []).filter(row => row.stateKey === 'working')
    note(stillRunning.length === 0 ? 'PASS' : 'FAIL',
      stillRunning.length === 0
        ? 'no row claims to be running once its turn has ended'
        : `${stillRunning.length} rows still say "running" after the turn ended: ${JSON.stringify(stillRunning.map(r => r.detail))}`)

    const collapsed = (record.settled.rows || []).filter(row => row.box.h < 6)
    note(collapsed.length === 0 ? 'PASS' : 'FAIL',
      collapsed.length === 0
        ? `every action row kept its height in a scrolling log (min ${Math.min(...(record.settled.rows || [{ box: { h: 0 } }]).map(r => r.box.h))}px)`
        : `${collapsed.length} action rows collapsed to a hairline: ${JSON.stringify(collapsed.map(r => r.box.h))}`)
    const clipping = (record.settled.rows || []).filter(row => row.clipsItsOwnHead)
    note(clipping.length === 0 ? 'PASS' : 'FAIL',
      clipping.length === 0 ? 'no row clips its own summary' : `${clipping.length} rows clip their own summary`)

    /* THE WIDTHS AND THE RESTORED CONVERSATION ARE BOTH REACHED BY RELAUNCHING
       the app, so they are one phase and it happens after this window closes.
       See driveAtWidth below for why the debugger cannot do either. */
    return record
  } finally {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({ findings, ...record }, null, 2))
    console.log(`  wrote ${path.join(OUT, 'measurements.json')}`)
    try { await window.evaluate('window.close()') } catch { /* already gone */ }
    reap(window.child?.pid)
  }
}

/* ONE WINDOW PER WIDTH, OPENED AT THAT WIDTH BY THE APP ITSELF.
 *
 * WHY NOT THE DEBUGGER, measured on this build rather than assumed:
 *
 *   Browser.getWindowForTarget / Browser.setWindowBounds  NOT AVAILABLE in a
 *       headless Electron run. This drive asks, gets no windowId, and says so;
 *       a sibling lane measured the same thing across three widths and three
 *       attempts. So the debugger cannot resize this window at all.
 *   Emulation.setDeviceMetricsOverride  changes what the renderer lays out for
 *       and NOT the window, and Page.captureScreenshot photographs the window.
 *       The PNG comes out at EXACTLY the requested width, so nothing about the
 *       file betrays it, while the painted content is the old layout. A sibling
 *       measured a "1920" image with its controls clipped mid-word beside a DOM
 *       read taken in the same breath reporting horizontalOverflow: false.
 *
 * So the app is asked to open at the width instead. shell/main.cjs restores its
 * window from <userData>/shell-state.json (window-state.cjs; minimum 980x640),
 * so seeding that file before launch gives a REAL native window of that size:
 * the surface, the layout and the picture are all one thing, with nothing left
 * to disagree. The size is then read back off the page and printed beside what
 * was asked for -- an instrument that states its own mode, which is the answer
 * to most of the instrument failures this drive has hit.
 *
 * AND IT DELIVERS THE OTHER THING ONLY A RELAUNCH CAN. While the window that
 * ran the turn is open, its rows keep the command output in memory, so leaving
 * the agent and coming back gives rows that still open -- measured, 18 of 18.
 * The saved record keeps the COMMAND and not what it printed, so a row with
 * nothing to open exists only after the app has been closed and started again
 * on the same data directory. That is a person opening the product the next
 * morning, and it is the state the "a row that cannot open must not offer
 * itself" fix exists for.
 */
/* HOW MANY WINDOW PIXELS BUY ONE CSS PIXEL, LEARNED RATHER THAN ASSUMED.
 *
 * The window size in shell-state.json is device-independent pixels and the page
 * reports CSS pixels, and on a display at anything but 100% they are not the
 * same number. MEASURED on the owner's own machine, 2026-08-20: asked for a
 * 1024-wide window, got innerWidth 1029 at devicePixelRatio 1.375. Five pixels
 * -- small enough that a tolerance would hide it and a hard equality would fail
 * a run that is actually fine.
 *
 * Neither is the honest answer. The drive CORRECTS instead: open, read the page
 * back, and if it is not on the number, reopen once asking for the difference.
 * Then the picture is labelled with a width the page really reported. A width
 * that still will not land is reported unmeasured, never photographed.
 */
const WIDTH_TRIES = 3
/* How far off the requested CSS width a real window may land and still be worth
   photographing -- see the lattice note in driveAtWidth. The picture is named
   for what the page reported either way, so this only decides whether a picture
   is worth taking at all. */
const NEAR_ENOUGH = 8

async function driveAtWidth(executable, profile, width, record, { pressBare = false } = {}) {
  const asked = { width, height: 1000 }
  let window = null
  let got = null
  for (let attempt = 0; attempt < WIDTH_TRIES; attempt += 1) {
    step(`opening a real window for ${width}px (asking ${asked.width}x${asked.height})`)
    writeFileSync(
      path.join(userDataFor(profile), 'shell-state.json'),
      JSON.stringify({ x: 20, y: 20, width: asked.width, height: asked.height, maximized: false }),
    )
    window = await openWindow(executable, profile)
    livePid = window.child?.pid ?? null
    await delay(2600)
    /* READ BACK WHAT THE WINDOW REPORTS, BESIDE WHAT WAS ASKED FOR. A resize
       that silently does not take is the same failure family as everything
       else here: an instrument reporting a state it never reached. A
       self-checking log beats a correct result somebody has to trust. */
    got = readOrThrow(await window.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })'), 'the window size')
    note('info', `${width}px: asked the app for ${asked.width}x${asked.height}, the page reports ${got.width}x${got.height} at dpr ${got.dpr} (real window, no emulation)`)
    if (Math.abs(got.width - width) <= NEAR_ENOUGH) break
    if (attempt === WIDTH_TRIES - 1) break
    asked.width += width - got.width
    try { await window.evaluate('window.close()') } catch { /* already gone */ }
    reap(window.child?.pid)
    await delay(1200)
    window = null
  }
  try {
    if (!window) { note('FAIL', `${width}px: no window`); return }
    /* THE DISPLAY IS A CEILING, AND ABOVE IT THERE IS NO HONEST PICTURE AT ALL.
     *
     * MEASURED on the owner's own machine, 2026-08-20: devicePixelRatio 1.375,
     * and innerWidth CLAMPS at 1400 CSS px. Asked for 1480, 1520, 1920, 2440
     * and 2960 device-independent pixels; the page reported 1400 every time. A
     * 1920-CSS-pixel window cannot exist on a 137.5%-scaled display, so no
     * photograph of one can either -- not through Emulation (the picture would
     * not match the layout) and not through the real window (it will not open
     * that wide).
     *
     * So above the ceiling the drive measures and does NOT photograph. An
     * emulated viewport is untrustworthy for a PICTURE and perfectly
     * trustworthy for GEOMETRY -- laying out at a width is exactly what it
     * genuinely does -- and "do the rows still fit" is a geometry question. The
     * mode is recorded on every reading so nobody has to guess how far to trust
     * the artefact beside it. */
    /* AN EXACT CSS WIDTH CAN BE UNREACHABLE, AND THAT IS NOT A FAILURE.
     *
     * MEASURED here: at dpr 1.375 one device pixel is 0.727 CSS px, so the CSS
     * widths a real window can take land on a lattice. Asking for 1024, then
     * 1019, then 1018 gave 1029, 1025 and 1023 -- the convergence works, and
     * 1024 exactly is simply not on the lattice. Refusing to photograph over
     * one pixel would be pedantry that costs the only real picture available;
     * pretending 1023 is 1024 would be the instrument lying. So a near miss is
     * photographed AND LABELLED WITH THE NUMBER THE PAGE REPORTED -- the file
     * is named for the measured width, never the requested one -- while the
     * geometry for the requested width is read separately under emulation.
     * Then no artefact carries a width its page never had. */
    const emulated = Math.abs(got.width - width) > NEAR_ENOUGH
    if (!emulated && got.width !== width) {
      note('info', `${width}px: the nearest real window this display can make is ${got.width}px (dpr ${got.dpr}); the picture is taken there and named for ${got.width}, not ${width}`)
    }
    if (emulated) {
      await window.session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await delay(1100)
      const after = readOrThrow(await window.evaluate('({ width: innerWidth, height: innerHeight })'), 'the emulated size')
      record.widths[width] = { asked, got, emulated: after, mode: 'EMULATED VIEWPORT — geometry only, no picture' }
      if (after.width !== width) {
        note('FAIL', `${width}px: neither the real window (${got.width}) nor emulation (${after.width}) reached it; nothing is reported at this width`)
        return
      }
      note('info', `${width}px: the real window clamped at ${got.width} (display ceiling, dpr ${got.dpr}), so this width is MEASURED under emulation and NOT photographed`)
    } else {
      record.widths[width] = { asked, got, mode: `real window via shell-state.json at ${got.width}px, no emulation` }
    }
    if (!(await clickToComputers(window))) return
    await delay(2200)
    const circle = await press(window, '.node[data-agent-id]', 15000)
    if (!circle.pressed) { note('FAIL', `at ${width}px the saved agent's circle would not press (${circle.why})`); return }
    await delay(2000)
    const read = await measure(window, `the ${width}px log`)
    Object.assign(record.widths[width], read)
    /* Photographed ONLY where the picture and the layout are the same thing. */
    record.widths[width].photographedAt = emulated ? null : await shoot(window, `03-chat-${got.width}px-real-window.png`)
    const rows = read.rows || []
    const tooShort = rows.filter(row => row.box.h < 6).length
    const wider = rows.filter(row => read.log && row.box.w > read.log.clientWidth + 1).length
    note(tooShort === 0 && wider === 0 && !read.log?.overflowsSideways && !read.pageScrollsSideways ? 'PASS' : 'FAIL',
      `${width}px [${record.widths[width].mode}]: ${describeRows(rows)}; ${wider} rows wider than the log; ` +
      `log ${read.log?.overflowsSideways ? 'SCROLLS SIDEWAYS' : 'no sideways scroll'}; ` +
      `page ${read.pageScrollsSideways ? 'SCROLLS SIDEWAYS' : 'no sideways scroll'}; ` +
      `${read.contextBubbles} context asides`)
    /* THE NUMBER THE OWNER'S SENTENCE ACTUALLY TURNS ON. "0 rows wider than the
       log" does not answer him, because the LOG was the thing that was too
       narrow: a command can sit obediently inside a 343px column and still be
       unreadable. How many rows have their text cut off, at each width, is the
       measurement -- and before this the answer was the same at 1024 and 1920,
       which is the whole complaint. */
    const cut = rows.filter(row => row.detailEllipsised).length
    note('info', `${width}px: log ${read.log?.clientWidth}px wide; ${cut} of ${rows.length} command rows have their text cut off`)

    if (!pressBare) return
    const bare = rows.filter(row => row.bare)
    note('info', `restored from the saved record: ${bare.length} of ${rows.length} rows have no captured output`)
    if (bare.length === 0) {
      note('info', 'the restored record still carried every output, so no bare row arose to press')
      return
    }
    await window.evaluate(`(() => {
      const row = document.querySelectorAll('${HOST} details.chat-action')[${bare[0].index}]
      if (row) row.id = 'ctx-drive-bare'
      return true
    })()`)
    const aimed = readOrThrow(await aim(window, '#ctx-drive-bare'), 'the restored bare row aim')
    if (aimed.state === 'aimed') await pressAt(window, aimed.x, aimed.y)
    const after = readOrThrow(await window.evaluate(`(() => {
      const row = document.getElementById('ctx-drive-bare')
      if (!row) return { gone: true }
      const mark = row.querySelector('.chat-action-mark')
      const head = row.querySelector('.chat-action-head')
      return {
        open: row.open === true,
        markVisibility: mark ? getComputedStyle(mark).visibility : null,
        cursor: head ? getComputedStyle(head).cursor : null,
        detail: (row.querySelector('.chat-action-detail')?.textContent || '').slice(0, 80),
      }
    })()`), 'the restored bare row after a press')
    record.pressBare = { before: bare[0], aimed, after }
    const honest = after.open === false && after.markVisibility === 'hidden' && after.cursor === 'default'
    note(honest ? 'PASS' : 'FAIL',
      `a row with nothing to open (${JSON.stringify(after.detail)}): disclosure mark ${after.markVisibility}, ` +
      `cursor ${after.cursor}, open after a real move→down→up = ${after.open} — ` +
      `${honest ? 'it does not offer itself as a control and does not act like one' : 'it still offers itself as pressable'}`)
    /* The same rule as every other picture in this file, and it caught a real
       slip: an earlier run photographed this under an emulated viewport, which
       by this drive's own argument is a picture nobody may quote. The verdict
       above is a DOM reading and stands either way; only the photograph is
       withheld. */
    if (emulated) note('info', 'the bare row is not photographed at this width — emulated viewport; the verdict above is the DOM reading')
    else await shoot(window, '04-bare-row-pressed.png')
  } finally {
    writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({ findings, ...record }, null, 2))
    if (window) {
      try { await window.evaluate('window.close()') } catch { /* already gone */ }
      reap(window.child?.pid)
      await delay(1200)
    }
  }
}

async function main() {
  const hashes = auditSelf()
  if (hashes.length > 0) {
    console.error(`this drive must navigate by pressing; found hash assignment:\n${hashes.join('\n')}`)
    process.exit(2)
  }
  if (!REAL) {
    process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
    process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
      ok: true, tier: 'guided', isolated: false,
      threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
      env: {},
    })
  }
  const scratch = mkdtempSync(path.join(tmpdir(), `context-window-${LABEL}-`))
  console.log(`staging ${LABEL} into ${scratch}`)
  /* THE WATCHDOG. Not a timeout that passes: it names the step the run was on
     and leaves a non-zero exit, so a stalled run reads as a stalled run. */
  const deadlineMs = Number(argument('--deadline', '600')) * 1000
  const watchdog = setTimeout(() => {
    console.error(`\n${LABEL}: STALLED on "${where}" after ${Math.round(deadlineMs / 1000)}s — no verdict was reached, and this run must not be quoted as one`)
    reap(livePid)
    process.exit(3)
  }, deadlineMs)
  watchdog.unref?.()
  try {
    const { executable, appRoot } = await stage(scratch)
    const profile = freshProfile(scratch)
    const record = await drive(executable, profile, appRoot)
    record.widths = record.widths || {}
    /* The 1024 window is also the "next morning" window: it is the first
       relaunch, so it is where the restored record bare rows first exist. */
    for (const width of [1024, 1440, 1920]) {
      await driveAtWidth(executable, profile, width, record, { pressBare: width === 1024 })
    }
    writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({ findings, ...record }, null, 2))
  } finally {
    clearTimeout(watchdog)
    if (KEEP) console.log(`kept ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  }
  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${LABEL}: ${findings.length} findings, ${failed.length} FAIL`)
}

await main()
