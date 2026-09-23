#!/usr/bin/env node

/* PRESSING SEND WITH TEXT IN THE BOX MUST SEND THAT TEXT. NOT STOP THE TURN.
 *
 * THE REPORT THIS ANSWERS (owner's window, port 9223, never touched by this
 * driver). Send sat in class "chat-send is-stop" while the composer was
 * empty -- src/components.js's syncComposer(): `stopMode = isBusy() &&
 * !input.value.trim() && typeof onStop === 'function'`. isBusy() was true on
 * a circle whose session records showed ZERO turns -- a node right after
 * Start, before its first turn has completed. Typed text, then Send,
 * produced "Interrupted." in the transcript and LEFT THE TEXT IN THE BOX:
 * Send ran the STOP branch over a composer that was not empty.
 *
 * TWO SCENARIOS, RUN IN THIS ORDER, AND WHY THE SECOND EXISTS AT ALL.
 *
 * scenarioMountedDispatch (the one that actually answers the question).
 * Reaching isBusy()===true for real needs a session THIS run started (src/
 * tree-session-liveness.js -- ownedSessions cannot be rebuilt from storage,
 * see that module's own header), and on THIS account every Codex-shaped tier
 * (luna/terra/sol -- the only ones a providerless narrating-engine fixture
 * can stand behind) comes back from src/fleet-tree-copy.js's
 * tierChoicesFor() as `enabled:false`, correctly: nobody is signed in to
 * Codex here. agent-compose-panel.js's attemptSubmit() re-checks that same
 * flag itself (~line 1114) even with the DOM's own `disabled` forced off, so
 * this is not a stale paint to route around -- it is a real, correct refusal.
 * CONFIRMED not a regression from today: `node tools/chat-history-
 * drive.mjs --only=D`, the existing already-relied-upon driver, unmodified,
 * fails the identical way on this account. Claude tiers are not a substitute
 * -- they would shell out to the REAL Claude CLI this very session runs
 * under (MEMORY.md: "Claude account is fixed per process" -- forking a
 * credential signs the original process OUT), a cost and a disruption this
 * driver will not spend to press one button.
 * So the control is pressed directly: buildChat() -- the literal, unmodified
 * export, loaded LIVE off disk via a real dynamic `import()` (see
 * COMPONENTS_MODULE/COMPONENTS_ROOT below; no bare-specifier imports in
 * components.js, checked, so it loads as an ordinary ES module) -- mounted
 * into a real sterile window's real DOM and pressed with the same CDP mouse/
 * keyboard dispatch every other driver in this repo uses (mouseMoved ->
 * mousePressed -> mouseReleased, Input.insertText; never el.click() or an
 * assigned .value). What is substituted is everything OUTSIDE the
 * component's own boundary -- status.busy/onStop/onSend/queue, reproduced to
 * the same observable CONTRACT src/views/computers.js's treeChatConfigFor
 * wires in production, never their internal business logic. See
 * scenarioMountedDispatch's own comment for the full accounting, including
 * what this CANNOT show (whether a queued message drains once a real turn
 * ends -- that lives in views/computers.js's outbox, outside this file's
 * boundary).
 * VALIDATED AGAINST A WORKING NEGATIVE CONTROL, not merely written and
 * trusted: `send()`'s dispatch was deliberately broken in a disposable
 * scratch worktree (busy-check moved ahead of the `!v` guard, reproducing
 * the exact reported shape) and this same scenario correctly turned red --
 * "Interrupted." bubble, box still holding the text, queue never touched.
 * Restored/discarded with the scratch worktree; nothing of that experiment
 * reaches this file or the tree it ran in.
 *
 * scenarioSendWhileBusy (kept as evidence, not as the verdict). The ORIGINAL
 * approach: start a real narrating-engine session through the actual compose
 * panel UI (tools/chat-history-drive.mjs's technique, MISSION_CONTROL_ENGINE
 * pointed at tools/test/fixtures/narrating-engine), polling for the new
 * circle instead of chat-history-drive.mjs's own flat 5200ms wait (which
 * outlasts the fixture's whole ~4.08s narrated turn). It SKIPs with the
 * Codex-sign-in reason above rather than failing -- that is an account/
 * environment fact, not a finding about the send/stop dispatch this lane
 * owns. Left in and run second, after the primary scenario, as documented
 * evidence of exactly where the full-UI route currently stops on this
 * account, for whoever next has real Codex credentials to run it with.
 *
 *   node tools/send-actually-sends-qa.mjs
 *   node tools/send-actually-sends-qa.mjs --only=mounted   the primary scenario alone (faster)
 *   node tools/send-actually-sends-qa.mjs --components-root=<dir>   mount a DIFFERENT checkout's src/ (e.g. a scratch worktree at an older commit) against this checkout's own staged shell
 *   node tools/send-actually-sends-qa.mjs --visible
 *   node tools/send-actually-sends-qa.mjs --keep      leave the scratch profile
 *
 * Run with the electron binary the harness itself resolves (openWindow calls
 * stage()'s own `executable`, from deps/app-node_modules/electron or the
 * staged release's own .exe) -- this file is launched with plain `node`,
 * exactly like tools/tree-chatbox-open-qa.mjs and tools/chat-history-
 * drive.mjs, because it only DRIVES the Electron process over CDP; it never
 * needs to BE one.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { createChatPresser } from './lib/chat-drive-lib.mjs'

const KEEP = process.argv.includes('--keep')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NARRATING_ENGINE = path.join(REPO, 'tools/test/fixtures/narrating-engine/src/lib/agent-engine/codex-process.js')

/* THE LITERAL DEV TEMP ROOT, NEVER THE INHERITED TEMP/TMP.
 *
 * MEASURED IN THIS ACCOUNT: os.tmpdir() answers `C:\Users\TOOLSE~2\AppData\
 * Local\Temp` -- the 8.3 short spelling of this very profile, not another
 * one -- while USERPROFILE/APPDATA/LOCALAPPDATA all answer the long form.
 * sterile-launch.cjs's own canonicalizeCreatedQaProfile documents exactly
 * this trap ("Windows may hand a Dev-token process its own Temp through an
 * 8.3 profile spelling; recording that spelling in machine.json makes the
 * product's later long-profile fence correctly mistake it for another
 * account"). Confirmed here first-hand: a scratch profile rooted at the
 * short spelling made seedMachineRecord write a machine record the staged
 * app's own account-fence then refused at launch --
 * DurableMemoryFileError: "the running Windows principal does not own this
 * ToolsEnabled installation." Rooting the scratch tree at the literal long
 * form instead (ACCOUNT-FENCE.md's own instruction) avoids generating that
 * mismatched spelling in the first place. */
const DEV_TEMP_ROOT = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp'
if (!path.resolve(DEV_TEMP_ROOT).toLowerCase().startsWith('c:\\users\\toolsenabled-dev\\')) {
  throw new Error(`refusing to stage under ${DEV_TEMP_ROOT} -- it does not resolve inside the ToolsEnabled-Dev profile`)
}

const findings = []
/* Recorded the moment a finding is made, not at the end -- see tools/tree-
   chatbox-open-qa.mjs's own note on the debugger-socket teardown hazard this
   guards against: an unbounded await on a dead socket can lose the summary,
   never the verdict. */
const note = (level, text) => {
  findings.push({ level, text })
  if (level === 'FAIL') process.exitCode = 1
  console.log(`  ${level.padEnd(5)} ${text}`)
}
const check = (ok, subject, detail = '') => note(ok ? 'PASS' : 'FAIL', `${subject}${detail ? ` -- ${detail}` : ''}`)

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

/* ------------------------------------------------------------- pressing -- */
const pressers = new WeakMap()
function presserFor(window) {
  let presser = pressers.get(window)
  if (!presser) {
    presser = createChatPresser({ session: window.session, evaluate: window.evaluate, delay })
    pressers.set(window, presser)
  }
  return presser
}
async function press(window, selector, timeoutMs = 9000) {
  const result = await presserFor(window).press(selector, timeoutMs)
  if (result !== 'clicked') return { pressed: false, why: result }
  return { pressed: true }
}
async function typeInto(window, selector, text) {
  const pressed = await press(window, selector)
  if (!pressed.pressed) return pressed
  await presserFor(window).typeInto(text)
  return pressed
}
async function key(window, name) { await presserFor(window).key(name) }

/* A native <select> popup eats the first ArrowDown; Escape dismisses it so
   the rest land on the element, as claude-tree-start-proof.mjs measured. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape')
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if ((await valueNow()) === wanted) return { ok: true, presses: i }
    await key(window, 'ArrowDown')
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses` }
}

/* The computer id is read off the page, never typed -- a record filed under
   the wrong id is a record the product correctly ignores, which would read
   here as "the tree page drew nothing" and get blamed on the product. */
async function computerOnScreen(window) {
  await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
  await window.evaluate("location.hash = '#/computers'")
  await delay(1000)
  await window.evaluate('location.reload()')
  await delay(3800)
  return window.evaluate('window.__mcGraph?.computer?.id || null')
}

/* ---------------------------------------------------------- the composer -- */

/* One read of everything a send/stop press could have changed: the box, the
   button's face, the queue strip, and the log -- so a FAIL can quote exactly
   what appeared instead of a class name in isolation. */
const READ_COMPOSER = `function readComposer(rootSelector) {
  const root = document.querySelector(rootSelector)
  const chat = root && (root.matches('.chat') ? root : root.querySelector('.chat'))
  if (!chat) return null
  const input = chat.querySelector('.chat-input input')
  const send = chat.querySelector('.chat-send')
  const strip = chat.querySelector('.chat-queue-strip')
  const queueRows = strip ? [...strip.querySelectorAll('.chat-queue-row')].map(r => ({
    text: (r.querySelector('.chat-queue-text')?.textContent || '').trim(),
  })) : []
  const log = chat.querySelector('.chat-log')
  const messages = log ? [...log.querySelectorAll('.msg')].map(m => ({
    cls: m.className,
    text: (m.querySelector('.chat-msg-text')?.textContent || '').trim(),
    html: (m.querySelector('.chat-msg-text')?.innerHTML || ''),
  })) : []
  return {
    present: true,
    inputValue: input ? input.value : null,
    sendIsStop: Boolean(send && send.classList.contains('is-stop')),
    sendAriaLabel: send ? send.getAttribute('aria-label') : null,
    sendDisabled: Boolean(send && send.disabled),
    queueStripHidden: strip ? strip.hidden : null,
    queueRows,
    messages,
  }
}`
async function readComposer(window, rootSelector) {
  return readOrThrow(await window.evaluate(`(${READ_COMPOSER})(${JSON.stringify(rootSelector)})`), `the composer at ${rootSelector}`)
}

/* Polled, not sampled once -- the composer only repaints on its own
   subscriptions (status/queue/input events), and this driver has no honest
   way to know that repaint has landed except by watching for it. */
async function waitForComposer(window, rootSelector, predicate, { timeoutMs = 4000, intervalMs = 100 } = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await readComposer(window, rootSelector)
    if (predicate(last)) return { ok: true, elapsedMs: Date.now() - started, state: last }
    await delay(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - started, state: last }
}

/* --------------------------------------------------- starting the agent -- */

/* Same gesture as chat-history-drive.mjs's startAgentFromCanvas (dashed
   circle -> compose panel -> tier -> role -> brief -> Start), but it POLLS
   for the new circle instead of sleeping a flat 5200ms. That flat wait
   outlasts the whole ~4.08s narrated turn (SPEED=4 x ~1020ms of scripted
   delay in the fixture) -- by the time it returned, this driver's busy
   window would already be closed. Polling returns the instant the circle
   exists, which measured well under a second in every run below. */
async function startAgentFast(window, brief) {
  const doorway = await press(window, '.computers .tree-empty-node')
  if (!doorway.pressed) return { ok: false, why: `the dashed circle could not be pressed (${doorway.why})` }
  await delay(2200)
  const offered = readOrThrow(await window.evaluate(`(() => {
    const read = (field) => {
      const node = document.querySelector('[data-compose-field="' + field + '"]')
      return node ? [...node.options].map(o => o.value).filter(Boolean) : []
    }
    return { tiers: read('tier'), roles: read('role') }
  })()`), 'the compose menus')
  if (!offered.tiers.length || !offered.roles.length) {
    return { ok: false, why: `the compose panel offered no tier or role (${JSON.stringify(offered)})` }
  }
  note('INFO', `compose panel offered tiers=${JSON.stringify(offered.tiers)} roles=${JSON.stringify(offered.roles)}`)
  /* THE TIER SELECT'S DEFAULT IS OFTEN ALREADY offered.tiers[0], and Start's
     disabled flag is only recomputed inside the tier <select>'s own 'change'
     listener (agent-compose-panel.js ~1222-1227) -- there is no separate
     paint of it at panel-build time in this flow. chooseByKeyboard checks the
     WANTED value before pressing a single key, so picking a value that is
     already selected returns immediately having fired no 'change' event at
     all, and Start can be left showing whatever disabled state the panel
     opened with (observed here: stuck disabled with tiers[0] selected by
     default). Selecting a DIFFERENT tier first, then the wanted one,
     guarantees a real 'change' event lands on the wanted value regardless of
     what the panel opened with. */
  if (offered.tiers.length > 1) {
    const decoy = offered.tiers.find(t => t !== offered.tiers[0]) || offered.tiers[offered.tiers.length - 1]
    await chooseByKeyboard(window, '[data-compose-field="tier"]', decoy)
  }
  const pickedTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', offered.tiers[0])
  if (!pickedTier.ok) return { ok: false, why: `could not choose a tier (${pickedTier.why})` }
  const pickedRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
  if (!pickedRole.ok) return { ok: false, why: `could not choose a role (${pickedRole.why})` }
  const typed = await typeInto(window, '[data-compose-field="message"]', brief)
  if (!typed.pressed) return { ok: false, why: `the brief field could not be pressed (${typed.why})` }

  const fields = readOrThrow(await window.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-compose-field]')]
    return nodes.map(n => ({
      field: n.dataset.composeField,
      tag: n.tagName,
      type: n.type || null,
      value: n.tagName === 'SELECT' ? n.value : (n.value || '').slice(0, 60),
      optionCount: n.tagName === 'SELECT' ? n.options.length : null,
    }))
  })()`), 'every compose field')
  note('INFO', `compose fields after picking: ${JSON.stringify(fields)}`)
  const hint = readOrThrow(await window.evaluate(`(() => {
    const btn = document.querySelector('[data-compose-action="start"]')
    const near = btn ? btn.closest('form, .agent-compose, [class*="compose"]') : null
    const hints = near ? [...near.querySelectorAll('[class*="hint"], [class*="reason"], [class*="note"], [class*="error"]')]
      .map(e => (e.textContent || '').trim()).filter(Boolean) : []
    return { title: btn ? btn.title : null, ariaDisabled: btn ? btn.getAttribute('aria-disabled') : null, hints }
  })()`), 'why Start might be disabled')
  note('INFO', `Start-disabled hints: ${JSON.stringify(hint)}`)

  const startTarget = readOrThrow(await window.evaluate(`(() => {
    const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = document.querySelector('[data-compose-action="start"]')
    if (!btn) return { present: false }
    if (!visible(btn)) return { present: true, visible: false, disabled: btn.disabled === true, text: btn.textContent.trim().slice(0, 60) }
    if (!btn.id) btn.id = 'send-actually-sends-qa-start'
    return { present: true, visible: true, selector: '#' + btn.id, label: btn.textContent.trim().slice(0, 40), disabled: btn.disabled === true }
  })()`), 'the Start control')
  note('INFO', `Start control: ${JSON.stringify(startTarget)}`)
  if (!startTarget || !startTarget.visible) return { ok: false, why: `there is no visible Start control on the compose panel (${JSON.stringify(startTarget)})` }

  if (startTarget.disabled) {
    /* NOT THE CONTROL THIS LANE OWNS. startableTiers() answers the picked
       tier as startable (checked above and logged), yet the compose panel's
       own Start button stays disabled regardless of reselecting the tier --
       a real finding, but about the START gate, not the send/stop dispatch
       this driver exists to press. Recorded plainly rather than silently
       patched around: the button's OWN disabled flag is forced off here so
       the rest of this scenario (the actual click handler, submitCompose,
       startDraftNode, bridge.start()) still runs for real and this driver
       can reach the busy composer it needs. */
    note('INFO', 'Start stayed disabled after selecting an enabled tier and filling the brief -- forcing it enabled to reach the composer under test; this is logged as a separate, unfixed finding, not swept under the send/stop result')
    await window.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(startTarget.selector)}); if (b) b.disabled = false })()`)
  }

  const before = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas before the start',
  )
  const pressedStart = await press(window, startTarget.selector)
  if (!pressedStart.pressed) return { ok: false, why: `Start could not be pressed (${pressedStart.why})` }
  const rightAfter = readOrThrow(await window.evaluate(`(() => {
    const toast = document.querySelector('[data-toast], .toast, [role="alert"]')
    return {
      nodes: [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId),
      composeStillOpen: Boolean(document.querySelector('[data-compose-action="start"]')),
      toast: toast ? (toast.textContent || '').trim().slice(0, 200) : null,
    }
  })()`), 'the page right after pressing Start')
  note('INFO', `right after pressing Start: ${JSON.stringify(rightAfter)}`)

  const startedAt = Date.now()
  const deadline = startedAt + 9000
  let fresh = null
  let polls = 0
  while (Date.now() < deadline) {
    polls += 1
    const after = readOrThrow(
      await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
      'the canvas while waiting for the new circle',
    )
    fresh = after.find(id => !before.includes(id)) || null
    if (fresh) break
    await delay(120)
  }
  if (!fresh) return { ok: false, why: `no new circle appeared within ${Date.now() - startedAt}ms of pressing Start (${polls} polls)` }
  return { ok: true, nodeId: fresh, tier: offered.tiers[0], role: offered.roles[0], circleAtMs: Date.now() - startedAt }
}

/* ----------------------------------------------- mounting the real control -- */

/* THE COMPONENT, LOADED LIVE FROM THE CHECKOUT -- not staged, not bundled,
 * not re-typed. src/components.js has no bare-specifier import (checked:
 * every import in the file is a relative `./*.js`), so it loads as an
 * ordinary ES module straight off disk.
 *
 * WHY A BOOTSTRAP PAGE INSIDE src/, MEASURED. The first version of this mount
 * navigated nowhere and imported components.js by its absolute file:// URL
 * from inside the STAGED app's own already-loaded page (dist/index.html,
 * itself served out of an asar archive) -- refused: "TypeError: Failed to
 * fetch dynamically imported module". Electron's webSecurity (on by default,
 * correctly, and not something this driver will weaken) treats a file:// load
 * from a DIFFERENT directory -- here, doubly different: outside the asar AND
 * outside dist/ -- as a separate origin. A blob: URL was the other candidate
 * and was rejected before trying it: components.js has real relative sibling
 * imports (./chat-copy.js, ./fleet-tree-copy.js, ...), and a blob: module has
 * no directory for those specifiers to resolve against.
 * So the window is navigated (Page.navigate) to a throwaway HTML file
 * written directly beside components.js for the few seconds this scenario
 * needs it, then deleted in the `finally` below -- same-directory, so EVERY
 * relative import in the real module graph resolves exactly as it does for
 * the product's own bundler, and `import('./components.js')` is a same-origin
 * load Electron has no reason to refuse. */
const PROBE_BOOTSTRAP_NAME = '.round1-send-probe-bootstrap.html'
/* --components-root=<dir> points the mounted probe at a DIFFERENT checkout's
   src/ -- e.g. a scratch `git worktree` at an older commit -- while still
   reusing this checkout's own staged Electron shell (the shell/Chromium
   binary is not what is under test). Defaults to this checkout's own src/. */
const COMPONENTS_ROOT = (() => {
  const arg = process.argv.find(a => a.startsWith('--components-root='))
  return arg ? path.resolve(arg.slice('--components-root='.length)) : path.join(REPO, 'src')
})()
const PROBE_BOOTSTRAP_PATH = path.join(COMPONENTS_ROOT, PROBE_BOOTSTRAP_NAME)
const PROBE_BOOTSTRAP_URL = pathToFileURL(PROBE_BOOTSTRAP_PATH).href

async function navigateTo(window, url) {
  await window.session.send('Page.enable', {}).catch(() => {})
  await window.session.send('Page.navigate', { url })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const state = await window.evaluate('document.readyState').catch(() => null)
    if (state === 'complete' || state === 'interactive') return
    await delay(80)
  }
  throw new Error(`navigation to ${url} never reached readyState complete/interactive`)
}

/* WHY THIS MOUNT EXISTS, AND WHAT IT DOES NOT CLAIM.
 *
 * THE WALL THIS DRIVER HIT FIRST, MEASURED, NOT ASSUMED. Reaching
 * isBusy()===true for real needs a session this run actually started
 * (src/tree-session-liveness.js -- ownedSessions cannot be rebuilt from
 * storage). tools/chat-history-drive.mjs already solved that providerlessly
 * for a CODEX-shaped tier via MISSION_CONTROL_ENGINE + the narrating-engine
 * fixture -- but on THIS account, `[data-compose-action="start"]` stays
 * disabled for every Codex-shaped tier (luna/terra/sol) because src/fleet-
 * tree-copy.js's tierChoicesFor() marks them `enabled:false` from a REAL,
 * CORRECT read of Codex sign-in presence, and agent-compose-panel.js's
 * attemptSubmit() re-checks that same `enabled` flag itself (line ~1114) even
 * once the DOM's own disabled attribute is forced off -- so this is not one
 * stale paint to route around, it is the product correctly reporting "nobody
 * is signed in to Codex on the computer you are driving". CONFIRMED not a
 * regression from today: `node tools/chat-history-drive.mjs --only=D` (the
 * existing, already-relied-upon driver, unmodified) fails the SAME way on
 * this account -- "the start drew no new circle (0 on the canvas)". Claude
 * tiers are not a substitute: they would shell out to the REAL Claude CLI
 * this very session runs under (see MEMORY.md, "Claude account is fixed per
 * process" -- forking a credential signs the original process OUT), which is
 * a cost and a disruption this driver will not spend.
 *
 * SO THE CONTROL IS PRESSED DIRECTLY, for real, with everything BELOW
 * src/components.js's own boundary substituted by a small, contract-faithful
 * stand-in rather than skipped. This is still buildChat() -- the literal,
 * unmodified (until Round 1's fix) export, loaded live off disk (see
 * COMPONENTS_MODULE above) -- mounted into the REAL sterile window's REAL
 * DOM, pressed with the SAME CDP mouse/keyboard dispatch (mouseMoved->
 * mousePressed->mouseReleased, Input.insertText) every other driver in this
 * repo uses, never el.click() or an assigned .value. What is substituted is
 * everything OUTSIDE the component's own boundary: `status.busy`, `onStop`,
 * `onSend` and `queue` are the same four closures src/views/computers.js's
 * treeChatConfigFor wires in production (this file's own reading of that
 * function is quoted in the header above) -- reproduced here to the same
 * observable CONTRACT (queue.add returns {ok, entry}, onStop resolves the
 * exact sentence PALETTE_PANEL.interruptDone/'Interrupted.' the owner saw),
 * not reimplemented business logic. What this CANNOT show: whether a queued
 * message really drains once a real turn ends (that draining lives in
 * views/computers.js's outbox, not in components.js) -- that half stays
 * unverified and is reported as such, not claimed. */
const MOUNT_SETUP = `(async (moduleUrl) => {
  const mod = await import(moduleUrl)
  if (typeof mod.buildChat !== 'function') return { ok: false, why: 'buildChat is not exported' }
  const host = document.createElement('div')
  host.id = 'probe-mount'
  document.body.appendChild(host)
  const probe = {
    busy: true,
    subs: [],
    queueSubs: [],
    queue: [],
    seq: 0,
    sent: [],
    stopped: 0,
    setBusy(next) { probe.busy = next; for (const fn of probe.subs.slice()) { try { fn() } catch (e) {} } },
  }
  window.__probe = probe
  const root = mod.buildChat({
    title: 'Round1 probe',
    subtitle: 'mounted directly for the send/stop dispatch control',
    roleKey: 'worker',
    history: [],
    seed: 0,
    status: {
      busy: () => probe.busy,
      subscribe: (fn) => { probe.subs.push(fn); return () => { probe.subs = probe.subs.filter(f => f !== fn) } },
      step: () => '',
    },
    /* THE SAME OBSERABLE SHAPE treeChatConfigFor's queue carries (src/views/
       computers.js): list/add/cancel/sendNow/subscribe. add() returns
       {ok:true, entry:{id,text}} on success -- the shape send()'s busy
       branch reads before it clears the box and repaints. */
    queue: {
      list: () => probe.queue.map(e => ({ id: e.id, text: e.text })),
      add: (text) => {
        const entry = { id: String(probe.seq += 1), text }
        probe.queue.push(entry)
        for (const fn of probe.queueSubs.slice()) { try { fn() } catch (e) {} }
        return { ok: true, entry }
      },
      cancel: (id) => {
        probe.queue = probe.queue.filter(e => e.id !== id)
        for (const fn of probe.queueSubs.slice()) { try { fn() } catch (e) {} }
      },
      sendNow: (id) => {
        const at = probe.queue.findIndex(e => e.id === id)
        if (at < 0) return { ok: false, sentence: 'gone' }
        const [entry] = probe.queue.splice(at, 1)
        probe.queue.unshift(entry)
        for (const fn of probe.queueSubs.slice()) { try { fn() } catch (e) {} }
        return { ok: true, sentence: 'moved to the front' }
      },
      subscribe: (fn) => { probe.queueSubs.push(fn); return () => { probe.queueSubs = probe.queueSubs.filter(f => f !== fn) } },
    },
    /* views/computers.js treeChatConfigFor: onSend: (text, handlers) =>
       treeCardSend(node, text, handlers) -- the idle-path delivery. Recorded
       here rather than re-deriving treeCardSend's own dispatch/session logic,
       which is genuinely outside this component's boundary. */
    onSend: (text, handlers) => {
      probe.sent.push(text)
      /* REGRESSION CHECK 5's OWN MATERIAL, riding the same mount: "an agent
         reply renders as formatted text, not escaped punctuation" -- a reply
         carrying real markdown, read back after this send below. */
      if (handlers && typeof handlers.reply === 'function') handlers.reply('a reply with **strong** and _emphasis_ in it')
    },
    /* views/computers.js treeChatConfigFor: onStop resolves
       sink.textContent || PALETTE_PANEL.interruptDone, and PALETTE_PANEL.
       interruptDone is the literal string 'Interrupted.' (src/fleet-tree-
       copy.js). Reproduced verbatim, not paraphrased, because that exact
       sentence is the owner's own smoking gun for this bug. */
    onStop: () => { probe.stopped += 1; return Promise.resolve('Interrupted.') },
  })
  host.appendChild(root)
  return { ok: true }
})('./components.js')`

async function mountDispatchProbe(window) {
  await navigateTo(window, PROBE_BOOTSTRAP_URL)
  const result = readOrThrow(await window.evaluate(MOUNT_SETUP), 'mounting buildChat live from src/components.js')
  if (!result || result.ok !== true) throw new Error(`could not mount the probe: ${JSON.stringify(result)}`)
}

async function readProbe(window) {
  return readOrThrow(await window.evaluate('({ busy: window.__probe.busy, sent: window.__probe.sent.slice(), stopped: window.__probe.stopped, queueLength: window.__probe.queue.length })'), 'the probe harness state')
}

async function setProbeBusy(window, busy) {
  await window.evaluate(`window.__probe.setBusy(${busy ? 'true' : 'false'})`)
}

async function unmountDispatchProbe(window) {
  await window.evaluate("document.getElementById('probe-mount')?.remove(); delete window.__probe")
}

/* THE PRIMARY EVIDENCE FOR ROUND 1: the real, unmodified buildChat() (loaded
   live off disk -- see COMPONENTS_MODULE above), mounted in a real sterile
   window, pressed for real. Everything the mount's own header explains. */
async function scenarioMountedDispatch(executable, scratch, appRoot) {
  console.log('\nMOUNTED DISPATCH -- the real buildChat(), a real busy composer, text in the box, Send pressed')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  const MOUNT = '#probe-mount'
  try {
    await mountDispatchProbe(window)

    const before = await readComposer(window, MOUNT)
    check(Boolean(before && before.present), 'the mounted composer is on the page', JSON.stringify(before))
    check(before.sendIsStop === true && before.inputValue === '', 'busy + empty box shows the stop face (the precondition the owner\'s report describes)', `is-stop=${before.sendIsStop} value=${JSON.stringify(before.inputValue)}`)

    const typed = await typeInto(window, `${MOUNT} .chat-input input`, CONTROL_TEXT)
    if (!typed.pressed) { note('FAIL', `the mounted composer could not be typed into (${typed.why})`); return }
    const afterTyping = await readComposer(window, MOUNT)
    check(afterTyping.inputValue === CONTROL_TEXT, 'the typed text lands in the box', `value=${JSON.stringify(afterTyping.inputValue)}`)
    check(afterTyping.sendIsStop === false, 'the button returns to its send face the moment text is typed', `is-stop=${afterTyping.sendIsStop} aria-label=${JSON.stringify(afterTyping.sendAriaLabel)}`)

    const pressedSend = await press(window, `${MOUNT} .chat-send`)
    if (!pressedSend.pressed) { note('FAIL', `Send could not be pressed (${pressedSend.why})`); return }
    await delay(400)

    const afterSend = await readComposer(window, MOUNT)
    const probeAfterSend = await readProbe(window)
    const interruptNote = afterSend.messages.find(m => m.cls.includes('note') && /interrupt/i.test(m.text))
    const queuedOurs = afterSend.queueRows.find(r => r.text === CONTROL_TEXT)

    check(probeAfterSend.stopped === 0, 'onStop (the interrupt path) is never called while the box holds text', `onStop call count=${probeAfterSend.stopped}`)
    check(afterSend.inputValue === '', 'pressing Send while busy clears the box', `value=${JSON.stringify(afterSend.inputValue)}`)
    check(!interruptNote, 'pressing Send with text in the box does not stop the running turn -- THE OWNER\'S REGRESSION',
      interruptNote ? `a note bubble said ${JSON.stringify(interruptNote.text)} (this is the "Interrupted." defect)` : 'no interrupt-flavoured note appeared')
    check(Boolean(queuedOurs), 'the typed words reach the real queue (send()\'s own busy branch), not discarded',
      queuedOurs ? `queued: ${JSON.stringify(queuedOurs.text)}` : `queue=${JSON.stringify(afterSend.queueRows)} probe.queueLength=${probeAfterSend.queueLength}`)
    note('INFO', `full composer state right after Send: ${JSON.stringify(afterSend)}; probe: ${JSON.stringify(probeAfterSend)}`)

    /* REGRESSION CHECK 3, same mount, same queued row: "a queued message
       appears in the queue strip and 'Send now' promotes it". */
    if (queuedOurs) {
      const promoted = await press(window, `${MOUNT} .chat-queue-row .chat-queue-now`)
      await delay(300)
      const afterPromote = await readComposer(window, MOUNT)
      const promoteNote = afterPromote.messages.find(m => m.cls.includes('note') && /front/i.test(m.text))
      check(promoted.pressed && Boolean(promoteNote), 'REGRESSION 3: the queue strip\'s "Send now" promotes the queued row',
        `pressed=${promoted.pressed} note=${promoteNote ? JSON.stringify(promoteNote.text) : 'none'} rows=${JSON.stringify(afterPromote.queueRows)}`)
    } else {
      note('FAIL', 'REGRESSION 3: nothing was queued, so "Send now" could not be pressed against a real row')
    }

    /* THE PLAIN CASE THE CONTROL IS NAMED FOR: idle, text in the box, Send. */
    await setProbeBusy(window, false)
    await waitForComposer(window, MOUNT, s => s && s.present && s.sendIsStop === false, { timeoutMs: 1500 })
    const typedIdle = await typeInto(window, `${MOUNT} .chat-input input`, SECOND_TEXT)
    if (!typedIdle.pressed) { note('FAIL', `the idle mounted composer could not be typed into (${typedIdle.why})`); return }
    const pressedIdle = await press(window, `${MOUNT} .chat-send`)
    if (!pressedIdle.pressed) { note('FAIL', `Send could not be pressed on the idle mounted composer (${pressedIdle.why})`); return }
    await delay(400)
    const afterIdle = await readComposer(window, MOUNT)
    const probeAfterIdle = await readProbe(window)
    const idleInterruptNote = afterIdle.messages.find(m => m.cls.includes('note') && /interrupt/i.test(m.text))
    check(probeAfterIdle.sent.includes(SECOND_TEXT), 'idle + text + Send calls onSend with exactly that text -- "send that text as a turn"',
      `onSend saw: ${JSON.stringify(probeAfterIdle.sent)}`)
    check(afterIdle.inputValue === '', 'pressing Send on an idle composer clears the box', `value=${JSON.stringify(afterIdle.inputValue)}`)
    check(!idleInterruptNote, 'pressing Send on an idle composer does not stop anything', idleInterruptNote ? JSON.stringify(idleInterruptNote.text) : 'none')

    /* REGRESSION CHECK 5, same mount: "an agent reply renders as formatted
       text, not escaped punctuation". onSend's mock reply above carries real
       markdown -- read back here as the DOM the reply actually painted. */
    const reply = afterIdle.messages.find(m => m.cls.includes('them'))
    check(Boolean(reply) && /<(strong|b|em|i)[ >]/i.test(reply.html) && !reply.text.includes('**strong**') && !reply.text.includes('_emphasis_'),
      'REGRESSION 5: an agent reply renders as formatted markup, not escaped punctuation',
      reply ? `text=${JSON.stringify(reply.text)} html=${JSON.stringify(reply.html)}` : 'no "them" bubble appeared')

    /* THE NEGATIVE CONTROL: busy AGAIN, box EMPTY, Send pressed -- this MUST
       still call onStop. A fix that makes typed-text-while-busy stop
       interrupting by disabling the stop path entirely would pass every
       check above and break this one; proving the instrument can still see
       the correct stop behaviour is what makes the earlier PASS lines mean
       something. */
    await setProbeBusy(window, true)
    await waitForComposer(window, MOUNT, s => s && s.present && s.sendIsStop === true && s.inputValue === '', { timeoutMs: 1500 })
    const stoppedBefore = (await readProbe(window)).stopped
    const pressedStop = await press(window, `${MOUNT} .chat-send`)
    if (!pressedStop.pressed) { note('FAIL', `Send/Stop could not be pressed on the empty busy composer (${pressedStop.why})`); return }
    await delay(400)
    const probeAfterStop = await readProbe(window)
    check(probeAfterStop.stopped === stoppedBefore + 1, 'NEGATIVE CONTROL: pressing Send on an EMPTY busy composer still calls onStop (Stop itself must keep working)',
      `onStop call count ${stoppedBefore} -> ${probeAfterStop.stopped}`)
  } finally {
    await unmountDispatchProbe(window).catch(() => {})
    await closeWindow(window)
    reap(window.timeline.pid)
  }
}

/* ------------------------------------------------------------ the scenario -- */

const CONTROL_TEXT = 'round1 probe -- typed while busy, must not interrupt'
const SECOND_TEXT = 'round1 probe -- typed once idle, must send directly'

async function scenarioSendWhileBusy(executable, scratch, appRoot) {
  console.log('\nSEND WHILE BUSY -- a real turn, zero turns recorded yet, text in the box, Send pressed')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer, so nothing below is about a tree'); return }

    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) {
      note('SKIP', `no engine reachable in this staged build (${JSON.stringify(reachable)}); the busy-composer path could not be driven`)
      return
    }

    const bridgeShape = readOrThrow(await window.evaluate(`(() => ({
      writeFlag: localStorage.getItem('mc.write.agent-session'),
      hasStart: typeof window.mcAgent?.start,
      hasAvailability: typeof window.mcAgent?.availability,
      keys: window.mcAgent ? Object.keys(window.mcAgent).sort() : null,
    }))()`), 'the mcAgent bridge shape')
    note('INFO', `mcAgent bridge before starting: ${JSON.stringify(bridgeShape)}`)
    const tiersRaw = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.startableTiers() } catch (error) { return { threw: String(error && error.message) } } })()'),
      'startableTiers()',
    )
    note('INFO', `startableTiers(): ${JSON.stringify(tiersRaw)}`)

    const started = await startAgentFast(window, 'Check the tests and read one file.')
    if (!started.ok) {
      /* NOT A PRODUCT DEFECT ON THIS CONTROL: confirmed (see the mount
         scenario's header, and `node tools/chat-history-drive.mjs --only=D`
         run unmodified against this same account) to be this account
         genuinely having no Codex sign-in, which agent-compose-panel.js
         correctly refuses to start against. */
      note('SKIP', `a real narrating-engine session could not be started on this account (this is the known Codex-sign-in gap the mount scenario's header documents, not a finding about send/stop dispatch): ${started.why}`)
      return
    }
    note('INFO', `started ${started.nodeId} on tier ${started.tier}/${started.role}; the circle appeared ${started.circleAtMs}ms after Start`)

    const openedRail = await press(window, `.node[data-agent-id="${started.nodeId}"]`)
    if (!openedRail.pressed) { note('FAIL', `the circle could not be pressed to open the rail (${openedRail.why})`); return }

    const RAIL = '[data-rail-chat-host]'
    const busy = await waitForComposer(window, RAIL, s => s && s.present && s.sendIsStop === true && s.inputValue === '', { timeoutMs: 3200 })
    if (!busy.ok) {
      note('FAIL', `the rail composer never showed the busy/stop face within ${busy.elapsedMs}ms of opening it -- last read: ${JSON.stringify(busy.state)}`)
      return
    }
    note('INFO', `busy/stop face confirmed ${busy.elapsedMs}ms after opening the rail (aria-label=${JSON.stringify(busy.state.sendAriaLabel)})`)
    const beforeMessageCount = busy.state.messages.length

    const typed = await typeInto(window, `${RAIL} .chat-input input`, CONTROL_TEXT)
    if (!typed.pressed) { note('FAIL', `the rail composer could not be typed into (${typed.why})`); return }

    const afterTyping = await readComposer(window, RAIL)
    check(afterTyping.inputValue === CONTROL_TEXT, 'the typed text lands in the box', `value=${JSON.stringify(afterTyping.inputValue)}`)
    check(afterTyping.sendIsStop === false, 'the button returns to its send face the moment text is typed', `is-stop=${afterTyping.sendIsStop} aria-label=${JSON.stringify(afterTyping.sendAriaLabel)}`)

    const pressedSend = await press(window, `${RAIL} .chat-send`)
    if (!pressedSend.pressed) { note('FAIL', `Send could not be pressed (${pressedSend.why})`); return }
    await delay(700)

    const afterSend = await readComposer(window, RAIL)
    const interruptNote = afterSend.messages.find(m => m.cls.includes('note') && /interrupt|stopped/i.test(m.text))
    const queuedOurs = afterSend.queueRows.find(r => r.text === CONTROL_TEXT)
    const sentOurs = afterSend.messages.find(m => m.cls.includes('me') && m.text.includes(CONTROL_TEXT.slice(0, 30)))

    check(afterSend.inputValue === '', 'pressing Send while busy clears the box', `value=${JSON.stringify(afterSend.inputValue)}`)
    check(!interruptNote, 'pressing Send with text in the box does not stop the running turn',
      interruptNote ? `a note bubble said ${JSON.stringify(interruptNote.text)}` : 'no interrupt-flavoured note appeared')
    check(Boolean(queuedOurs) || Boolean(sentOurs),
      'the typed words are now somewhere real -- queued or sent -- not discarded',
      queuedOurs ? `queued: ${JSON.stringify(queuedOurs.text)}`
        : sentOurs ? `sent directly: ${JSON.stringify(sentOurs.text)}`
        : `queue=${JSON.stringify(afterSend.queueRows)} log=${JSON.stringify(afterSend.messages.map(m => m.cls))}`)
    note('INFO', `full state right after Send: ${JSON.stringify(afterSend)}`)

    /* CLOSE THE LOOP. Queued is only the right answer if the words later
       reach the model -- "must send that text as a turn" is a claim about
       delivery, not merely about not being refused. */
    if (queuedOurs) {
      const drained = await waitForComposer(window, RAIL, s => s && s.present && !s.queueRows.some(r => r.text === CONTROL_TEXT), { timeoutMs: 6000, intervalMs: 250 })
      check(drained.ok, 'the queued message drains once the running turn ends',
        drained.ok ? `drained ${drained.elapsedMs}ms after the check began` : `still queued after ${drained.elapsedMs}ms: ${JSON.stringify(drained.state && drained.state.queueRows)}`)
    }

    /* THE PLAIN CASE THE CONTROL IS NAMED FOR: idle, text in the box, press
       Send. Reuses the same now-finished session rather than paying for a
       second agent start. Only asserted once the composer genuinely reads
       idle -- a FAIL here must be about the send path, never about this
       probe outrunning the turn's own ending. */
    const idle = await waitForComposer(window, RAIL, s => s && s.present && s.sendIsStop === false, { timeoutMs: 3000 })
    if (!idle.ok) {
      note('INFO', `the composer never settled into a plain idle send face within ${idle.elapsedMs}ms; skipping the idle-send half (state: ${JSON.stringify(idle.state)})`)
    } else {
      const beforeIdleCount = idle.state.messages.length
      const typedIdle = await typeInto(window, `${RAIL} .chat-input input`, SECOND_TEXT)
      if (!typedIdle.pressed) {
        note('FAIL', `the idle composer could not be typed into (${typedIdle.why})`)
      } else {
        const pressedIdle = await press(window, `${RAIL} .chat-send`)
        if (!pressedIdle.pressed) {
          note('FAIL', `Send could not be pressed on the idle composer (${pressedIdle.why})`)
        } else {
          await delay(700)
          const afterIdle = await readComposer(window, RAIL)
          const idleInterrupt = afterIdle.messages.find(m => m.cls.includes('note') && /interrupt|stopped/i.test(m.text))
          const idleSent = afterIdle.messages.find(m => m.cls.includes('me') && m.text.includes(SECOND_TEXT.slice(0, 30)))
          check(afterIdle.inputValue === '', 'pressing Send on an idle composer clears the box', `value=${JSON.stringify(afterIdle.inputValue)}`)
          check(!idleInterrupt, 'pressing Send on an idle composer does not stop anything',
            idleInterrupt ? `a note bubble said ${JSON.stringify(idleInterrupt.text)}` : 'no interrupt-flavoured note appeared')
          check(Boolean(idleSent) || afterIdle.messages.length > beforeIdleCount,
            'the idle text is sent as a turn -- a new spoken bubble appears',
            idleSent ? `sent: ${JSON.stringify(idleSent.text)}` : `messages ${beforeIdleCount} -> ${afterIdle.messages.length}: ${JSON.stringify(afterIdle.messages.map(m => m.cls))}`)
        }
      }
    }
    note('INFO', `messages in the log at the very start of this scenario: ${beforeMessageCount}`)
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
  }
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  mkdirSync(DEV_TEMP_ROOT, { recursive: true })
  const scratch = mkdtempSync(path.join(DEV_TEMP_ROOT, 'send-actually-sends-qa-'))
  if (!path.resolve(scratch).toLowerCase().startsWith('c:\\users\\toolsenabled-dev\\')) {
    throw new Error(`refusing to use scratch profile ${scratch} -- it resolved outside the ToolsEnabled-Dev profile`)
  }
  console.log(`scratch: ${scratch}`)
  /* Set before any window is opened, so the sterile harness carries it into
     every child environment (test-account-harness.mjs's environmentFor
     passes process.env through, redirecting only the home variables). */
  process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged: ${executable}`)
    if (existsSync(PROBE_BOOTSTRAP_PATH)) {
      throw new Error(`refusing to overwrite a pre-existing ${PROBE_BOOTSTRAP_PATH} -- remove it by hand first`)
    }
    writeFileSync(PROBE_BOOTSTRAP_PATH, '<!doctype html><title>round1 probe</title><body></body>', 'utf8')
    try {
      await scenarioMountedDispatch(executable, scratch, appRoot)
    } finally {
      try { unlinkSync(PROBE_BOOTSTRAP_PATH) } catch { /* best-effort; never leave this beside tracked source */ }
    }
    if (!process.argv.includes('--only=mounted')) {
      await scenarioSendWhileBusy(executable, scratch, appRoot)
    }
  } catch (error) {
    note('FAIL', `the driver itself failed, which is not on its own a product defect: ${error?.stack || error}`)
  } finally {
    const passed = findings.filter(f => f.level === 'PASS').length
    const failed = findings.filter(f => f.level === 'FAIL').length
    const skipped = findings.filter(f => f.level === 'SKIP').length
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a dead child can hold the profile open */ } }
    else console.log(`kept: ${scratch}`)
  }
}

await main()
