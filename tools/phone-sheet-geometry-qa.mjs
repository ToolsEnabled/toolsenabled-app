#!/usr/bin/env node

/* THE PHONE'S CHAT AND THE PHONE'S FLEET, MEASURED WITH THE SHEET OPEN.
 *
 * WHY THIS FILE EXISTS. A geometry gate walked every route of this product on
 * an emulated phone, in two engines, and passed 100 checks out of 100 while
 * the pinnacle page was unusable: press an agent, the sheet comes up on Chat,
 * and there is nothing to type into and nothing to read. Measured on the
 * served build, 2026-08-28, 390x664, Chromium and WebKit alike:
 *
 *   .chat-input   [22, 664, 346, 44]  -- its whole box below the glass
 *   .chat-log     8px tall holding 75px of content
 *   .chat-nosend  the sentence explaining the empty chat, half of it hidden
 *   and NOT ONE of the thirteen ancestors of the composer could scroll.
 *
 * The gate that passed walks ROUTES. It never opened the sheet, so the whole
 * of the product behind one press was outside everything anybody measured.
 * That is the class this file closes, and the rule it is built on: a surface
 * reached by a press is not covered until something presses it.
 *
 * WHAT IT MEASURES, per engine x cell, through one counted reporter:
 *
 *   1  THE COMPOSER IS ON THE GLASS. Its centre is inside the viewport, and
 *      its whole box is inside the sheet card. The second is the host-proof
 *      half: the site mounts this application under a header, so the card is
 *      shorter there than here, and "inside the card" is true or false the
 *      same way in both.
 *   2  THE SHEET CAN SCROLL. Some ancestor of the composer, at or below the
 *      sheet body, declares overflow-y auto or scroll. Without one, anything
 *      the column cannot fit is simply gone -- and the fix for (1) is only
 *      one arrangement of boxes away from being undone.
 *   3  THE REFUSAL IS READABLE. When the agent cannot be written to, the
 *      sentence that says so is inside the card, whole.
 *   4  NOTHING IN THE SHEET OVERFLOWS A BOX NOBODY CAN SCROLL. The general
 *      form of (1): every element in the sheet either fits, or has a scroller
 *      between it and the sheet body.
 *   5  LANDSCAPE KEEPS THE FLEET. Rotate, and every agent's centre is still
 *      inside the tree pane -- there was no landscape cell anywhere in this
 *      product's coverage, which is why a phone turned sideways lost all five
 *      agents with no way back but turning it again.
 *
 * HOW IT DRIVES. Real touch taps at coordinates, never el.click(): the press
 * that opens this sheet is a press on a circle drawn on a canvas, and a
 * harness that clicks by selector cannot tell whether a person could reach it.
 *
 * WHAT IT SERVES. With --release <directory>, only the selected archive's
 * packed renderer bytes, read-only on its own ephemeral loopback server.
 * This is emulated-browser layout QA, not native/installed or phone proof.
 * Candidate mode refuses APP_ORIGIN and non-root APP_PATH overrides. With no
 * candidate selection, its own `vite dev` on an ephemeral port by default, so the
 * gate has no dependency on anything being built or deployed. Point APP_ORIGIN
 * at anything else -- a preview server, or the site's own mount at /app/ -- to
 * measure that instead; APP_PATH names the mount, default "/".
 *
 * EXIT CODES, the convention this repository's drivers share: 0 every check
 * proved, 1 a check failed, 2 no verdict (Playwright unloadable, no engine, no
 * origin). Zero executed checks can never exit 0.
 */

import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fenceGeometryContext, serveCandidateRenderer, visibleGeometryPressPoint } from './lib/qa-candidate-browser.mjs'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* Playwright is an explicit test-kit dependency. Nothing is downloaded or
   installed by this driver, and it never guesses another checkout. */
const PLAYWRIGHT_ROOT = typeof process.env.TESTKIT_PLAYWRIGHT_ROOT === 'string'
  ? process.env.TESTKIT_PLAYWRIGHT_ROOT.trim()
  : ''
const APP_PATH = process.env.APP_PATH || '/'
const ENGINES = ['chromium', 'webkit']
let candidateRenderer = null
let evidenceRoot
const activeBrowsers = new Set()

async function openGeometryContext(engine, options, origin) {
  const profile = mkdtempSync(path.join(evidenceRoot, 'browser-'))
  const gui = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(name)))
  const environment = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(profile)), gui,
    { systemPathOnly: true })
  if (process.platform === 'linux') {
    environment.XDG_RUNTIME_DIR = path.join(profile, 'runtime')
    mkdirSync(environment.XDG_RUNTIME_DIR, { mode: 0o700 })
    environment.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(profile, 'absent-session-bus')}`
    environment.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${path.join(profile, 'absent-system-bus')}`
  }
  const browser = await engine.launch({ headless: true, env: environment,
    ...(engine.name() === 'chromium' ? { chromiumSandbox: true } : {}) })
  activeBrowsers.add(browser)
  browser.once('disconnected', () => activeBrowsers.delete(browser))
  try {
    const context = await browser.newContext({ ...options, serviceWorkers: 'block' })
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(20_000)
    const blocked = await fenceGeometryContext(context, { origin, staticPath: candidateRenderer?.staticPath })
    return { browser, context, blocked }
  } catch (error) {
    await browser.close()
    throw error
  }
}

async function closeGeometryContext(context, page, label) {
  try {
    await page.screenshot({ path: path.join(evidenceRoot, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') })
    say(`  ${label}: blocked ${context.blocked.http} non-static/write request(s), ${context.blocked.websocket} WebSocket(s)`)
  } finally { await context.browser.close() }
}

async function pressGeometryControl(page, selector, label, touch = true) {
  const target = await page.evaluate(visibleGeometryPressPoint, selector)
  if (!check(Boolean(target), `${label}: ${selector} has no visible, unobstructed press point`)) return false
  if (touch) await page.touchscreen.tap(target.x, target.y)
  else await page.mouse.click(target.x, target.y)
  return true
}

async function dismissGeometryGuide(page, label, touch = true) {
  if (!await page.locator('.first-use-layer').isVisible()) return true
  if (!await pressGeometryControl(page, '.first-use-close', label + ' dismiss guide', touch)) return false
  await page.waitForFunction(() => !document.querySelector('.first-use-layer')
    || document.querySelector('.first-use-layer').hidden, null, { timeout: 5000 })
  return true
}

async function enterGeometryDemo(page, label) {
  if (!await dismissGeometryGuide(page, label)) return false
  // A saved graph style is not account approval. Reach examples through the
  // actual public choice; never seed an authenticated state or demo bypass.
  if (!await pressGeometryControl(page, '.phone-ledger-door-demo', label + ' choose example')) return false
  await page.waitForFunction(() => [...document.querySelectorAll('.phone-ledger-door')].every(node =>
    node.hidden || node.getBoundingClientRect().width === 0), null, { timeout: 5000 })
  const simulated = await page.evaluate(() => document.querySelector('.computers')?.dataset.liveMode)
  return check(simulated === 'simulated', `${label}: the public demo choice did not produce an explicitly simulated surface (${simulated})`)
}

/* THE CELLS. Three portrait heights and one landscape, and the landscape one
   is the point: nothing in this product's coverage had ever been measured
   sideways. 320x568 is the shortest phone the product claims.

   AND THE MOUNTED GEOMETRY IS A SEPARATE RUN, NOT A CELL. The site draws this
   application under a header, which takes ~52-148px of the window before the
   product paints anything; that room is exactly what the sheet's chrome was
   spending, and it is why the rectangles in this file's header are shorter
   than the ones a bare 390x664 produces. Point APP_ORIGIN and APP_PATH at the
   served site (APP_ORIGIN=http://127.0.0.1:4700 APP_PATH=/app/) and every cell
   below is measured through that header instead. Inventing a viewport no phone
   has, to stand in for it here, would be measuring an imaginary device. */
const CELLS = [
  { name: 'portrait 390x844', width: 390, height: 844, landscape: false },
  { name: 'portrait 320x568', width: 320, height: 568, landscape: false },
  /* The reference compact viewport used by every rectangle in the header. */
  { name: 'portrait 390x664', width: 390, height: 664, landscape: false },
  { name: 'landscape 844x390', width: 844, height: 390, landscape: true },
]

let checks = 0
const failures = []
const say = (line) => process.stdout.write(`${line}\n`)
function check(passed, sentence) {
  checks += 1
  if (passed) return true
  failures.push(sentence)
  return false
}
function noVerdict(sentence) {
  process.stderr.write(`\nNO VERDICT: ${sentence}\n`)
  process.exitCode = 2
}

let playwright = null
if (!PLAYWRIGHT_ROOT) {
  noVerdict('TESTKIT_PLAYWRIGHT_ROOT must name the authorized Playwright test kit.')
} else {
  try {
    playwright = createRequire(path.join(PLAYWRIGHT_ROOT, 'package.json'))('playwright')
  } catch (error) {
    noVerdict(`Playwright could not be loaded from ${PLAYWRIGHT_ROOT} (${error?.message || error}). `
      + 'Set TESTKIT_PLAYWRIGHT_ROOT to the authorized test kit that has it installed.')
  }
}

/* ---------------------------------------------------------------- the page */

/** Everything this file asks about the open sheet, read in one pass. */
function readSheet() {
  const rect = (node) => {
    const box = node.getBoundingClientRect()
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
  }
  const card = document.querySelector('.phone-sheet-card')
  const body = document.querySelector('.phone-sheet-body')
  const input = document.querySelector('.phone-sheet-body .chat-input')
  const nosend = document.querySelector('.phone-sheet-body .chat-nosend')
  const chat = document.querySelector('.phone-sheet-body .chat')
  const head = document.querySelector('.phone-sheet-body .chat-head')
  if (!card || !body || !input) {
    return { ok: false, why: `the sheet did not open on an agent (card ${!!card}, body ${!!body}, composer ${!!input})` }
  }
  /* Every box between the composer and the sheet body, with the two facts
     that decide whether anything below the fold is reachable. */
  const chain = []
  for (let node = input; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node)
    chain.push({
      name: (node.getAttribute('class') || node.tagName.toLowerCase()).slice(0, 48),
      scrolls: /auto|scroll/.test(style.overflowY),
      touchAction: style.touchAction,
      insideSheet: body.contains(node) || node === body,
    })
    if (node === body) break
  }
  /* Rule 4, asked of the whole sheet rather than of the composer alone. */
  const stranded = []
  for (const node of body.querySelectorAll('*')) {
    if (node.scrollHeight - node.clientHeight <= 1) continue
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) continue
    let reachable = false
    for (let up = node.parentElement; up && up !== body.parentElement; up = up.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(up).overflowY)) { reachable = true; break }
    }
    if (!reachable) stranded.push(`${(node.getAttribute('class') || node.tagName).slice(0, 40)} (${node.scrollHeight} of content in ${node.clientHeight})`)
  }
  const scroller = chain.find((entry) => entry.scrolls && entry.insideSheet)
  /* The mode promises every control a 44px target (src/phone-canvas.css
     section 2). A control can still be DRAWN smaller: a flex sibling that
     claims its content height makes the column short of room, and flexbox
     takes the shortfall from whichever neighbour will give. */
  const squashed = []
  for (const control of body.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"]')) {
    if (control.hidden || control.disabled) continue
    const box = control.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    const name = (control.getAttribute('class') || control.tagName).slice(0, 32)
    if (box.height < 43.5) {
      squashed.push(`${name} drawn ${Math.round(box.height)}px tall`)
      continue
    }
    /* AND IT IS STILL INSIDE THE THING THAT HOLDS IT. A control keeps its own
       floor while the BOX AROUND IT gives way -- measured: the Chat/Details
       pill squeezed to 30px with its two 44px buttons standing outside it --
       and that deformation is worse than a fail, because it also relieves the
       pressure every other check here reads. */
    const parent = control.parentElement
    if (!parent || parent === body) continue
    /* A scroller's content is SUPPOSED to extend past its box; that is what a
       scroller is. Only a box that cannot scroll is deforming when its own
       control stands outside it. */
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue
    const holder = parent.getBoundingClientRect()
    if (holder.height === 0) continue
    if (box.top >= holder.top - 1 && box.bottom <= holder.bottom + 1) continue
    squashed.push(`${name} is drawn outside the ${(parent.getAttribute('class') || parent.tagName).slice(0, 24)} that holds it (${Math.round(box.height)}px in ${Math.round(holder.height)}px)`)
  }
  return {
    squashed: squashed.slice(0, 6),
    ok: true,
    viewport: [innerWidth, innerHeight],
    card: rect(card),
    input: rect(input),
    nosend: nosend ? rect(nosend) : null,
    chat: chat ? rect(chat) : null,
    chatHead: head ? rect(head) : null,
    scrollerInSheet: Boolean(scroller),
    /* A scroller a finger is not allowed to move is not a scroller on a phone:
       the mode locks the page with `touch-action`, and the exemption has to be
       declared on the box that is meant to move. */
    scrollerTakesAFinger: Boolean(scroller && /pan-y|auto|manipulation/.test(scroller.touchAction)),
    chain: chain.map((entry) => `${entry.name}${entry.scrolls ? ' [scrolls]' : ''}`),
    stranded: stranded.slice(0, 6),
  }
}

/** Take the sheet's column to its end, the way a thumb does. */
function scrollSheetToEnd() {
  const body = document.querySelector('.phone-sheet-body')
  if (!body) return false
  let moved = false
  for (const node of body.querySelectorAll('*')) {
    if (node.scrollHeight - node.clientHeight <= 1) continue
    if (!/auto|scroll/.test(getComputedStyle(node).overflowY)) continue
    node.scrollTop = node.scrollHeight
    moved = true
  }
  return moved
}

/** The fleet, and whether a person can see it. */
function readFleet() {
  const pane = document.querySelector('.graph-canvas-slot')
  if (!pane) return { ok: false, why: 'the tree pane is not on this screen' }
  const box = pane.getBoundingClientRect()
  /* THE FLEET IS ROWS NOW, WHEREVER THE LEDGER IS THE SURFACE. This gate was
     written when a phone always got the graph, so it asked its question of
     `.static-tree-node` circles. Since the ledger became what a phone gets for
     doing nothing, those circles are `display: none` and every one of them
     measures 0x0 at (0, 0) -- so the gate reported all five agents off the
     pane and no sheet openable, on a surface where a person can see and press
     all five. Measured 2026-08-28 at 390x664: ledger off, 5 circles with size;
     ledger on, 5 circles, 0 with size. Same question, asked of whatever is
     actually drawn: can a person reach every agent, and does a press on one
     raise the sheet. */
  const rows = [...document.querySelectorAll('.phone-ledger-row')]
  if (rows.length > 0) {
    const ledger = document.querySelector('.phone-ledger')
    const lb = ledger ? ledger.getBoundingClientRect() : box
    /* Vertically the ledger is a scroller, so "below the fold" is reachable by
       definition; what would strand a row is being outside it sideways, or the
       scroller not existing at all. */
    const scrolls = ledger ? /auto|scroll/.test(getComputedStyle(ledger).overflowY) : false
    const off = rows
      .map((row) => {
        const r = row.getBoundingClientRect()
        return { name: (row.querySelector('.phone-ledger-name')?.textContent || '?').slice(0, 18), cx: r.x + r.width / 2, cy: r.y + r.height / 2, r }
      })
      .filter((n) => n.cx < lb.left - 1 || n.cx > lb.right + 1 || (!scrolls && (n.cy < lb.top - 1 || n.cy > lb.bottom + 1)))
    return {
      ok: true,
      pane: [Math.round(lb.x), Math.round(lb.y), Math.round(lb.width), Math.round(lb.height)],
      total: rows.length,
      off: off.map((n) => `${n.name} at (${Math.round(n.cx)}, ${Math.round(n.cy)})`),
      pageScrolls: document.documentElement.scrollHeight - document.documentElement.clientHeight > 2,
    }
  }
  const nodes = [...document.querySelectorAll('.static-tree-node')].filter((node) => !node.hidden)
  const offPane = nodes
    .map((node) => {
      const r = node.getBoundingClientRect()
      return { name: (node.querySelector('.nn-t')?.textContent || '?').slice(0, 18), cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
    })
    .filter((n) => n.cx < box.left - 1 || n.cx > box.right + 1 || n.cy < box.top - 1 || n.cy > box.bottom + 1)
  return {
    ok: true,
    pane: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    total: nodes.length,
    off: offPane.map((n) => `${n.name} at (${Math.round(n.cx)}, ${Math.round(n.cy)})`),
    pageScrolls: document.documentElement.scrollHeight - document.documentElement.clientHeight > 2,
  }
}

/* Wait until the page stops re-rendering itself. The host bridge remounts the
   projection when its dial resolves, and that remount returns the rail to the
   fleet overview -- a press made while it is in flight is swallowed. Counted
   rather than slept through, so this measures a settled page. */
async function settle(page) {
  await page.evaluate(() => {
    window.__railResets = 0
    const real = DOMTokenList.prototype.toggle
    DOMTokenList.prototype.toggle = function toggle(name, force) {
      if (name === 'is-active' && force === true && this.contains('stats-page')) window.__railResets += 1
      return real.call(this, name, force)
    }
  })
  let quiet = 0
  let last = 0
  for (let attempt = 0; attempt < 40 && quiet < 4; attempt += 1) {
    await page.waitForTimeout(400)
    const now = await page.evaluate(() => window.__railResets)
    quiet = now === last ? quiet + 1 : 0
    last = now
  }
}

/** Press an actual ledger row the way a thumb does, and wait for its sheet. */
async function openAgentSheet(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let target = await page.evaluate(visibleGeometryPressPoint, '.phone-ledger-press')
    if (!target) {
      // Small viewports can put every row below the ledger header. Move only
      // the product's actual touch scroller, then repeat the hit test. Hidden
      // nodes and a locked/non-scrollable ledger never authorize a press.
      const revealed = await page.evaluate(() => {
        const ledger = document.querySelector('.phone-ledger')
        const row = ledger?.querySelector('.phone-ledger-press')
        if (!ledger || !row || row.closest('[hidden], [inert], [aria-hidden="true"]')) return false
        const style = getComputedStyle(ledger)
        if (!/auto|scroll/.test(style.overflowY) || !/auto|pan-y|manipulation/.test(style.touchAction)) return false
        const box = ledger.getBoundingClientRect(), target = row.getBoundingClientRect()
        if (!box.height || !target.height) return false
        const before = ledger.scrollTop
        ledger.scrollTop += target.top - box.top - Math.max(0, (box.height - target.height) / 2)
        return ledger.scrollTop !== before
      })
      if (!revealed) return null
      await page.waitForTimeout(150)
      target = await page.evaluate(visibleGeometryPressPoint, '.phone-ledger-press')
    }
    if (!target) return null
    await page.touchscreen.tap(target.x, target.y)
    await page.waitForTimeout(1200)
    const open = await page.evaluate(() => Boolean(document.querySelector('.phone-sheet:not([hidden]).is-up .rail-page.ctl-page.is-active .chat-input')))
    if (open) return target
    await page.waitForTimeout(800)
  }
  return null
}

/* --------------------------------------------------- content growth (M4) */

/* THE UNPROVEN RISK, PROVEN OR REFUTED HERE FIRST. fleet-A's A/B already
 * refuted container height as a cause: .rail-page self-sizes in lockstep
 * with whatever height its ancestor gives it (353/353 -> 405/405, both
 * engines), so a mismatched container is not what would break the sheet.
 * The remaining, UNPROVEN question is different: does a conversation that
 * genuinely grows long -- not a short seeded example -- outrun the ancestor
 * chain readSheet() already checks (the scroller between the composer and
 * the sheet body, and the "nothing stranded" sweep)?
 *
 * THE INJECTED LENGTH IS NOT ARBITRARY. It is the WINDOW-MEMORY bound this
 * app's own transcript pipeline actually allows before anything trims it --
 * TRANSCRIPT_MAX_ENTRIES = 60 in src/views/computers.js, the cap on
 * `sessionTranscripts` before the durable store's own, smaller bound
 * (40 spoken + 12 action lines) ever applies. So this is not a synthetic
 * worst case invented for this file; it is the LARGEST conversation this
 * app's own code will hold in a live window before it starts trimming
 * anything -- a session that has not yet reloaded is exactly this size.
 * Message lengths are drawn up toward the per-line bound the durable store
 * enforces (600 characters, src/session-transcript-store.js MAX_LINE_CHARS)
 * so a handful of the injected lines are close to the longest a real message
 * is ever allowed to be, not a uniform short stand-in.
 *
 * WHY DOM INJECTION AND NOT A REAL SEND. Growing the transcript through 60
 * genuine sends would multiply this file's own runtime by the number of
 * cells it already measures, for a question that is about LAYOUT, not about
 * whether a message was correctly appended (components.js's own tests
 * already cover that). The markup injected below is the exact shape
 * makeMsg() in src/components.js produces (`.msg.them` /
 * `.msg.me` > `.who` + `.chat-msg-text`), appended to the same `.chat-log`
 * the real path appends to, so the CSS the ancestor-chain question is
 * actually about sees exactly the box sizes it would see from real content. */
const LONG_CONVERSATION_TARGET_ENTRIES = 60
const LONG_CONVERSATION_MAX_LINE_CHARS = 600

/** Grow the currently-open chat's log to the app's own window-memory ceiling,
 *  in the app's own message markup. Returns how many rows are now in the log,
 *  or 0 if there was nothing to grow (no open chat found). */
async function injectLongConversation(page) {
  return page.evaluate(({ target, maxChars }) => {
    const log = document.querySelector('.phone-sheet-body .chat-log')
    if (!log) return 0
    const existing = log.querySelectorAll('.msg').length
    const lorem = 'the agent read three files, ran the suite, and reported back with the full output attached below so nothing has to be re-run to see what changed '
    for (let i = existing; i < target; i += 1) {
      const from = i % 2 === 0 ? 'them' : 'me'
      /* Every eighth line is pushed up toward the durable store's own
         per-line ceiling, not just this cell's average -- the ancestor
         chain has to hold the longest real message allows, not only the
         typical one. */
      const long = i % 8 === 0
      const text = long ? lorem.repeat(Math.ceil(maxChars / lorem.length)).slice(0, maxChars) : `message ${i}: ${lorem.slice(0, 60 + (i % 5) * 20)}`
      const row = document.createElement('div')
      row.className = `msg ${from}`
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = from === 'me' ? 'you' : 'Agent'
      const body = document.createElement('span')
      body.className = 'chat-msg-text'
      body.textContent = text
      row.append(who, body)
      log.appendChild(row)
    }
    log.scrollTop = log.scrollHeight
    return log.querySelectorAll('.msg').length
  }, { target: LONG_CONVERSATION_TARGET_ENTRIES, maxChars: LONG_CONVERSATION_MAX_LINE_CHARS })
}

async function measureLongConversationCell(engineName, engine, origin) {
  /* The owner's own cell (see CELLS above) -- the width and height every
     other measured rectangle in this file is against, so a finding here is
     directly comparable to the short-conversation baseline for the same
     device. */
  const cell = { name: 'portrait 390x664 (long conversation)', width: 390, height: 664, landscape: false }
  const label = `${engineName} ${cell.name}`
  const context = await openGeometryContext(engine, {
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  }, origin)
  // Use the supported ledger presentation. A row opens the phone sheet;
  // a graph tap now opens the separate tree conversation workspace. The
  // public example choice is still pressed before any agent is reachable.
  await context.context.addInitScript(() => {
    localStorage.setItem('mc.phoneCanvas', 'on')
    localStorage.setItem('mc.phoneLedger', 'on')
  })
  const page = await context.context.newPage()
  try {
    await page.goto(`${origin}${APP_PATH}#/computers`, { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    const mode = await page.evaluate(() => ({
      phone: document.documentElement.getAttribute('data-phone-canvas'),
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
    }))
    if (!check(mode.phone === 'on' && mode.coarse && mode.hoverNone,
      `${label}: this is not a phone canvas (attribute ${mode.phone}, coarse ${mode.coarse}, hover:none ${mode.hoverNone}) — every check below would pass vacuously`)) return
    await settle(page)
    if (!await enterGeometryDemo(page, label)) return
    await settle(page)

    const target = await openAgentSheet(page)
    if (!check(Boolean(target), `${label}: no reachable agent press opened its sheet`)) return
    const before = await page.evaluate(readSheet)
    if (!check(before.ok, `${label}: ${before.why}`)) return

    const grown = await injectLongConversation(page)
    if (!check(grown >= LONG_CONVERSATION_TARGET_ENTRIES,
      `${label}: only ${grown} of ${LONG_CONVERSATION_TARGET_ENTRIES} target messages are in the log — the injection itself failed, not the layout being tested`)) return
    await page.waitForTimeout(300)

    /* THE SAME CHECKS measureCell RUNS ON A SHORT CONVERSATION, RUN AGAIN
       HERE. If content growth is the risk, these are exactly where it would
       show: the composer pushed off-screen, the scroller lost, something
       stranded above a box that cannot scroll to it, or a control squeezed
       under its own touch floor by the taller column. */
    const sheet = await page.evaluate(readSheet)
    if (!check(sheet.ok, `${label}: ${sheet.why}`)) return

    const inside = (box, card) => box && box[1] >= card[1] - 1 && box[1] + box[3] <= card[1] + card[3] + 1
    check(inside(sheet.input, sheet.card),
      `${label}: with ${grown} messages in the log, the message box ${JSON.stringify(sheet.input)} is outside its own sheet card ${JSON.stringify(sheet.card)}`)
    check(sheet.scrollerInSheet,
      `${label}: with ${grown} messages in the log, nothing between the message box and the sheet body can scroll (${sheet.chain.join(' < ')})`)
    check(sheet.scrollerTakesAFinger,
      `${label}: with ${grown} messages in the log, the sheet's scroller no longer permits a touch pan`)

    const scrolled = await page.evaluate(scrollSheetToEnd)
    await page.waitForTimeout(300)
    const ended = scrolled ? await page.evaluate(readSheet) : sheet
    check(inside(ended.input, ended.card),
      `${label}: with ${grown} messages in the log, the message box is outside the sheet card after scrolling to the end (${JSON.stringify(ended.input)} against ${JSON.stringify(ended.card)})`)
    check(sheet.stranded.length === 0,
      `${label}: with ${grown} messages in the log, ${sheet.stranded.length} box(es) hold more than they show with no scroller above them — ${sheet.stranded.join('; ')}`)
    check(sheet.squashed.length === 0,
      `${label}: with ${grown} messages in the log, ${sheet.squashed.length} control(s) are below the mode's own 44px touch floor — ${sheet.squashed.join('; ')}`)

    say(`  ${label}: ${grown} messages injected, composer ${JSON.stringify(sheet.input)} in card ${JSON.stringify(sheet.card)}, at the end of the scroll ${JSON.stringify(ended.input)}`)
  } finally {
    await closeGeometryContext(context, page, label)
  }
}

/* ------------------------------------------------------------------- a run */

async function measureCell(engineName, engine, cell, origin) {
  const label = `${engineName} ${cell.name}`
  const context = await openGeometryContext(engine, {
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  }, origin)
  // The presentation preference grants no account access. Enter examples
  // through the visible choice, then press an actual ledger row.
  await context.context.addInitScript(() => {
    localStorage.setItem('mc.phoneCanvas', 'on')
    localStorage.setItem('mc.phoneLedger', 'on')
  })
  const page = await context.context.newPage()
  try {
    await page.goto(`${origin}${APP_PATH}#/computers`, { waitUntil: 'load' })
    await page.waitForTimeout(1500)

    /* THE MODE ITSELF. Everything below is a claim about the phone dress, and
       a cell that never entered it would pass every one of them vacuously. */
    const mode = await page.evaluate(() => ({
      phone: document.documentElement.getAttribute('data-phone-canvas'),
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
    }))
    if (!check(mode.phone === 'on' && mode.coarse && mode.hoverNone,
      `${label}: this is not a phone canvas (attribute ${mode.phone}, coarse ${mode.coarse}, hover:none ${mode.hoverNone}) — every check below would pass vacuously`)) {
      return
    }
    await settle(page)
    if (!await enterGeometryDemo(page, label)) return
    await settle(page)

    if (cell.landscape) {
      /* 5 — THE FLEET SURVIVES THE ROTATION. Measured from the pane rather
         than the window: a circle drawn below the pane is clipped by it, and
         no zoom or pan the person has is going to find it. */
      const fleet = await page.evaluate(readFleet)
      if (!check(fleet.ok && fleet.total > 0, `${label}: no agents were drawn, so nothing was measured (${fleet.why || 'zero nodes'})`)) return
      check(fleet.off.length === 0,
        `${label}: ${fleet.off.length} of ${fleet.total} agents are outside the ${fleet.pane[3]}px tree pane and the page does not scroll — ${fleet.off.join('; ')}`)
      check(fleet.pageScrolls === false, `${label}: the phone canvas page scrolled, which the mode forbids`)
    }

    const target = await openAgentSheet(page)
    if (!check(Boolean(target), `${label}: no reachable agent press opened its sheet`)) return
    const sheet = await page.evaluate(readSheet)
    if (!check(sheet.ok, `${label}: ${sheet.why}`)) return

    const inside = (box, card) => box && box[1] >= card[1] - 1 && box[1] + box[3] <= card[1] + card[3] + 1
    const centre = sheet.input[1] + sheet.input[3] / 2

    /* 1 — THE MESSAGE BOX IS ON THE GLASS THE MOMENT THE SHEET OPENS, and
       wholly inside the sheet that holds it. This is the finding in its own
       words: nothing a person has to do first, no scrolling.
     *
     * PORTRAIT ONLY, AND THE EXCEPTION IS MEASURED RATHER THAN ASSUMED. A
     * phone held sideways gives this sheet ~256px once the page mounting the
     * application has taken its header, and the sheet's own head, tool row,
     * title and tabs want ~200 of them. There is no arrangement of those boxes
     * that also shows a conversation, so the guarantee sideways is
     * reachability -- (3), asked after the column has been scrolled -- and the
     * chrome budget for landscape is a design question filed with the owner
     * rather than something this gate can assert its way out of. */
    if (!cell.landscape) {
      check(centre >= 0 && centre <= sheet.viewport[1],
        `${label}: the message box's centre is at y=${Math.round(centre)} on a ${sheet.viewport[1]}px screen — a person cannot type into it`)
      check(inside(sheet.input, sheet.card),
        `${label}: the message box ${JSON.stringify(sheet.input)} is outside its own sheet card ${JSON.stringify(sheet.card)}`)
    }

    /* 2 — SOMETHING CAN SCROLL, AND A FINGER IS ALLOWED TO MOVE IT. Without
       this the fix for (1) is one rearrangement away from being undone, and
       anything the column cannot fit is gone again. */
    check(sheet.scrollerInSheet,
      `${label}: nothing between the message box and the sheet body can scroll (${sheet.chain.join(' < ')}) — anything that does not fit is unreachable`)
    check(sheet.scrollerTakesAFinger,
      `${label}: the sheet's scroller does not permit a touch pan; the mode locks the page, so a scroller without its own touch-action is a scroller a thumb cannot move`)

    /* 3 — AND EVERYTHING IN IT CAN BE REACHED. Take the column to its end and
       the message box and the sentence explaining the empty chat are both
       inside the card, whole. The scroll is performed on the element (2) has
       just proved is a scroller a finger may move. */
    const scrolled = await page.evaluate(scrollSheetToEnd)
    await page.waitForTimeout(300)
    const ended = scrolled ? await page.evaluate(readSheet) : sheet
    check(inside(ended.input, ended.card),
      `${label}: the message box is still outside the sheet card after the column has been scrolled to its end (${JSON.stringify(ended.input)} against ${JSON.stringify(ended.card)})`)
    const endedCentre = ended.input[1] + ended.input[3] / 2
    check(endedCentre >= 0 && endedCentre <= ended.viewport[1],
      `${label}: the message box's centre is still at y=${Math.round(endedCentre)} on a ${ended.viewport[1]}px screen after the column has been scrolled to its end — there is no gesture left that reaches it`)
    if (ended.nosend) {
      check(inside(ended.nosend, ended.card),
        `${label}: the refusal that explains the empty chat cannot be read even at the end of the scroll (${JSON.stringify(ended.nosend)} against ${JSON.stringify(ended.card)})`)
    }

    /* 3b — AND THE CONVERSATION IS A CONVERSATION, not a sliver of one. Its
       box must hold at least the two things that are always in it: the agent's
       name and the message box. Measured 2026-08-28 at 844x390, `.chat` came
       out THREE PIXELS TALL holding 188px of conversation, with its transcript
       scrolling inside 8px of that -- everything technically reachable, and
       nothing readable. */
    if (sheet.chat && sheet.chatHead) {
      const floor = sheet.chatHead[3] + sheet.input[3]
      check(sheet.chat[3] >= floor,
        `${label}: the conversation is drawn ${sheet.chat[3]}px tall — less than its own name row and message box together (${floor}px), so it is a sliver rather than a chat`)
    }

    /* 4 — nothing anywhere in the sheet is stranded. */
    check(sheet.stranded.length === 0,
      `${label}: ${sheet.stranded.length} box(es) in the sheet hold more than they show with no scroller above them — ${sheet.stranded.join('; ')}`)

    /* 4b — AND EVERY CONTROL IN IT IS STILL A TARGET. The mode declares a 44px
       floor for every control; a flex sibling that grows can take that back
       without any rule being changed, and the person is left pressing at a
       button drawn 30px tall. */
    check(sheet.squashed.length === 0,
      `${label}: ${sheet.squashed.length} control(s) in the sheet are below the mode's own 44px touch floor — ${sheet.squashed.join('; ')}`)
    say(`  ${label}: composer ${JSON.stringify(sheet.input)} in card ${JSON.stringify(sheet.card)}${sheet.nosend ? `, refusal ${JSON.stringify(sheet.nosend)}` : ''}${scrolled ? `, at the end of the scroll ${JSON.stringify(ended.input)}` : ', nothing to scroll'}`)
  } finally {
    await closeGeometryContext(context, page, label)
  }
}

/* ------------------------------------------------------ the ledger override */

/* THE LEDGER LINK'S OWN OVERRIDE, MEASURED AT THE GLASS (M2, owner-approved).
 *
 * phone-canvas-ledger-override.test.mjs already proves the pure decision
 * function: phoneCanvasDecision({ ...DESKTOP, choice: 'auto', ledgerRoute:
 * true }) returns true for a fine-pointer, hovering, 1440-wide desktop
 * signature. What that test cannot prove is that a REAL BROWSER, given a
 * REAL ?ledger=1 URL, reaches the same verdict end to end -- that
 * readPhoneCanvasEnvironment() is actually wired to the real
 * location.search on a real navigation, that its result actually reaches
 * phoneCanvasDecision(), and that the answer actually lands on
 * documentElement's data-phone-canvas attribute rather than being computed
 * and discarded somewhere on the way. This is that proof, the strongest one
 * available short of the native-device sweep: it is still Chromium/WebKit
 * under Playwright, not a physical VM or device, so it cannot stand in for
 * that sweep -- it can only prove the wiring holds all the way to the DOM
 * in the two engines this repository already tests everything else in.
 *
 * A DESKTOP CONTEXT, DELIBERATELY -- the exact opposite of every CELL above.
 * isMobile:false, hasTouch:false, and a real desktop Chrome UA: this is the
 * one signature the OLD code (coarsePointer required, unconditionally)
 * could never have passed on, which is the whole reason the override exists.
 * If phoneCanvasDecision's pure-function test is green but THIS fails, the
 * M2 branch is not actually reaching the page the unit test proved it
 * should reach -- a wiring defect the pure-function test cannot see by
 * construction (it never touches a URL, a matchMedia query, or an
 * attribute).
 */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function measureLedgerOverride(engineName, engine, origin) {
  const label = `${engineName} ledger override (fine-pointer desktop signature)`
  const context = await openGeometryContext(engine, {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: DESKTOP_UA,
  }, origin)
  const page = await context.context.newPage()
  try {
    await page.goto(`${origin}${APP_PATH}?ledger=1#/computers`, { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await settle(page)
    if (!await dismissGeometryGuide(page, label, false)) return

    const mode = await page.evaluate(() => ({
      phone: document.documentElement.getAttribute('data-phone-canvas'),
      coarse: matchMedia('(pointer: coarse)').matches,
      hover: matchMedia('(hover: hover)').matches,
      search: location.search,
    }))

    /* The scenario has to actually BE the case under test, or a pass proves
       nothing -- the same discipline measureCell's own mode check applies to
       the ordinary phone cells, mirrored here for the inverse signature. */
    if (!check(!mode.coarse && mode.hover,
      `${label}: this context is not actually a fine-pointer, hovering signature (pointer:coarse ${mode.coarse}, hover:hover ${mode.hover}) — the scenario itself is invalid, not the override`)) return
    if (!check(mode.search.includes('ledger=1'),
      `${label}: the navigation did not carry ?ledger=1 through to location.search (read "${mode.search}") — nothing below would prove the override, only that a page loaded`)) return

    /* THE CORE CLAIM: the M2 branch reaches the real DOM. */
    check(mode.phone === 'on',
      `${label}: data-phone-canvas is "${mode.phone}", not "on", on a fine-pointer desktop that followed the ?ledger=1 link — the override proven in phone-canvas-ledger-override.test.mjs is not reaching this page (pointer:coarse ${mode.coarse}, hover:hover ${mode.hover})`)

    /* AND THE DOWNSTREAM SURFACE IT UNLOCKS ACTUALLY RENDERS, not only the
       attribute -- UPDATED FOR THE ROUTING LAW's SIGN-IN GATE (owner's final
       ruling, 2026-08-28 evening; plan of record LEDGER.md, Part 2b §A0-M
       item 0: "The ledger surface requires FULL ONLINE SIGN-IN").
       .phone-ledger-press ROWS ARE NO LONGER THE RIGHT THING TO EXPECT HERE.
       This harness has no window.mcAccount at all (a bare vite dev server,
       no Electron, no website host-bridge.js), so src/account-state.js's own
       fail-closed rule means it always reads as signed out -- and under the
       new law that is the CORRECT reason to see src/phone-ledger.js's
       sign-in door (buildSignInDoor()), not the ledger rows. Asserting rows
       here would now assert the removed behaviour (an unauthenticated
       visitor seeing somebody's fleet), which is exactly backwards. The
       claim this cell can still honestly make is narrower than before: the
       MODE unlocks (checked above, unchanged) AND the mobile surface it
       unlocks draws SOMETHING real -- specifically the door, house mark and
       sign-in control included, with real size. Proving the signed-in
       ledger path itself would need a harness that can authenticate, which
       this one cannot (see the same limit noted in the website repo's
       phone-wall.mjs). */
    const door = await page.evaluate(() => {
      const el = document.querySelector('.phone-ledger-door')
      const mark = document.querySelector('.phone-ledger-door-mark')
      const signIn = document.querySelector('.phone-ledger-door-signin')
      const rect = el?.getBoundingClientRect()
      const signInRect = signIn?.getBoundingClientRect()
      return {
        present: Boolean(el),
        hasRealSize: Boolean(rect && rect.width > 0 && rect.height > 0),
        markText: mark?.textContent || '',
        signInHref: signIn?.getAttribute('href') || '',
        signInHasRealSize: Boolean(signInRect && signInRect.width > 0 && signInRect.height > 0),
        strayLedgerRows: document.querySelectorAll('.phone-ledger-press').length,
      }
    })
    check(door.present && door.hasRealSize,
      `${label}: the sign-in door did not draw with a real size (present=${door.present}) — the mode flipped but the surface an unauthenticated visitor should see did not render`)
    check(door.markText === 'ToolsEnabled',
      `${label}: the door's house mark read "${door.markText}", not "ToolsEnabled"`)
    check(door.signInHref === '/signin/' && door.signInHasRealSize,
      `${label}: the door's sign-in control is missing, wrongly addressed (href="${door.signInHref}"), or has no real size`)
    check(door.strayLedgerRows === 0,
      `${label}: ${door.strayLedgerRows} .phone-ledger-press row(s) drew for an unauthenticated visitor — the sign-in gate did not hold`)

    say(`  ${label}: data-phone-canvas="${mode.phone}", location.search="${mode.search}", sign-in door drawn (mark="${door.markText}", sign-in href="${door.signInHref}")`)
  } finally {
    await closeGeometryContext(context, page, label)
  }
}

async function main() {
  if (!playwright) return

  let origin = process.env.APP_ORIGIN || ''
  let devServer = null
  try {
    candidateRenderer = await serveCandidateRenderer({ argv: process.argv, environment: process.env, repoRoot: REPO_ROOT })
    evidenceRoot = mkdtempSync(path.join(os.tmpdir(), 'phone-geometry-qa-'))
    say(`geometry evidence retained at ${evidenceRoot}`)
    if (candidateRenderer) {
      origin = candidateRenderer.origin
      say(`renderer subject: ${JSON.stringify(candidateRenderer.provenance)}`)
      say('scope: emulated browser, anonymous/sample and injected-long-conversation geometry; no native shell, signed-in fleet, physical phone or installer proof')
    } else if (!origin) {
      let vite = null
      try {
        vite = await import('vite')
      } catch (error) {
        noVerdict(`no APP_ORIGIN was given and vite could not be imported to serve this repository (${error?.message || error}).`)
        return
      }
      devServer = await vite.createServer({ root: REPO_ROOT, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
      await devServer.listen()
      const address = devServer.httpServer.address()
      origin = `http://127.0.0.1:${address.port}`
      say(`serving this repository at ${origin}`)
    } else {
      try {
        await fetch(`${origin}${APP_PATH}`, { signal: AbortSignal.timeout(5_000) })
      } catch (error) {
        noVerdict(`APP_ORIGIN ${origin}${APP_PATH} is not answering (${error?.cause?.code || error?.message || error}).`)
        return
      }
      say(`measuring ${origin}${APP_PATH}`)
    }

    const missing = []
    for (const engineName of ENGINES) {
      const engine = playwright[engineName]
      try {
        const probe = await openGeometryContext(engine, {}, origin)
        await probe.browser.close()
      } catch (error) {
        missing.push(`${engineName} (${error?.message?.split('\n')[0] || error})`)
        continue
      }
      for (const cell of CELLS) await measureCell(engineName, engine, cell, origin)
      await measureLedgerOverride(engineName, engine, origin)
      await measureLongConversationCell(engineName, engine, origin)
    }

    if (candidateRenderer) candidateRenderer.assertUnchanged()
    if (missing.length) say(`  ${missing.length} engine(s) could not be started: ${missing.join('; ')}`)
    say(`${checks - failures.length}/${checks} checks passed`)
    if (failures.length) {
      for (const failure of failures) say(`  FAIL  ${failure}`)
      process.exitCode = 1
      return
    }
    if (checks === 0) {
      noVerdict(`no engine could be started (${missing.join('; ') || 'none tried'}), so nothing was measured.`)
      return
    }
    if (missing.length) {
      noVerdict(`${checks} checks passed but ${missing.join('; ')} could not run; a phone gate that only sees one engine is the gate this file was written to replace.`)
      return
    }
    say(`  ALL ${checks} CHECKS PASSED: the phone sheet opens on an agent with its message box on screen, its refusal readable, and a scroller above both — in ${ENGINES.join(' and ')}, portrait and landscape — the ?ledger=1 override reaches data-phone-canvas on a fine-pointer desktop signature in both engines, and the sheet holds this app's own window-memory ceiling of ${LONG_CONVERSATION_TARGET_ENTRIES} messages without losing the composer, the scroller, or a control's touch floor.`)
    process.exitCode = 0
  } finally {
    const closed = await Promise.allSettled([
      ...[...activeBrowsers].map(browser => browser.close()),
      ...(devServer ? [devServer.close()] : []),
      ...(candidateRenderer ? [candidateRenderer.close()] : []),
    ])
    const failed = closed.filter(result => result.status === 'rejected')
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'geometry QA cleanup or candidate integrity failed')
    if (candidateRenderer) say(`candidate static server: ${JSON.stringify(candidateRenderer.stats)}; archive unchanged`)
  }
}

main().catch((error) => {
  process.stderr.write(`\nNO VERDICT: the harness itself failed: ${error?.stack || error}\n`)
  process.exitCode = 2
})
