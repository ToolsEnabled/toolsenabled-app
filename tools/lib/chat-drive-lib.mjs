/* THE SHARED CHAT DRIVER — one press/typeInto/key/send/waitForReply, for
 * every driver that exercises the chat composer end to end, over EITHER
 * transport a real running instance of this app can be reached through.
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED. Nine drivers under tools/
 * each defined their own local press/typeInto/key trio -- five of them
 * (chat-history-drive.mjs, node-remove-drive.mjs, rail-lifecycle-drive.mjs,
 * session-end-record-drive.mjs, tree-panel-audit-drive.mjs) are near-
 * verbatim copies of each other; two more (request-contract-drive.mjs,
 * spine-defects-drive.mjs) share a second, independent lineage. Four
 * distinct phrasings existed for the ONE composer text input. None of the
 * nine used a real quiescence signal to know when a reply had actually
 * arrived -- all nine used a fixed sleep. Full evidence, file:line cited:
 * the B-pool-6 API decision document this module implements.
 *
 * THE TWO TRANSPORTS, ONE SIGNATURE. tools/lib/fleet-node.mjs's
 * createPresser is CDP-only by explicit design (its own header: "Every
 * press is a CDP mouse event") -- correct for drivers attached to a
 * browser/renderer via a DevTools session. tools/steering-controls-
 * e2e.cjs and tools/steering-controls-reachability-e2e.cjs run inside
 * Electron's MAIN process against a BrowserWindow, where there is no CDP
 * session at all -- only webContents -- and independently (copy-pasted
 * between the two files) hand-rolled their own presser using
 * webContents.sendInputEvent. createChatPresser below accepts EITHER a
 * CDP handle ({ session, evaluate, delay }, unchanged from fleet-node.mjs
 * -- no existing caller's signature changes) or an Electron handle
 * ({ webContents, evaluate, delay }), and returns the SAME shape either
 * way, so a call site never needs to know or care which transport it is
 * driving against.
 *
 * WHAT IS PROVEN HERE AND WHAT IS NOT, STATED PLAINLY. The CDP branch does
 * NOT delegate to fleet-node.mjs's own createPresser -- a real difference
 * surfaced while migrating chat-history-drive.mjs (§6 step 1), and this
 * module follows the origin driver rather than silently dropping a step
 * fleet-node.mjs's version does not have. fleet-node.mjs's press() sends
 * TWO CDP mouse events (mousePressed, mouseReleased) with no delay between
 * them and a 400ms settle after; every composer driver in the "typeInto"
 * lineage (chat-history-drive.mjs and the four files that copy it
 * verbatim) sends THREE (mouseMoved first, then mousePressed,
 * mouseReleased), 45ms between each, plus a 520ms settle after. Two
 * different proven gestures exist in this codebase for "press", and this
 * module's CDP branch reproduces chat-history-drive.mjs's own -- the one
 * being migrated first -- rather than fleet-node.mjs's, so that migration
 * step is a genuine swap of mechanism-for-identical-mechanism, not a
 * quiet behavior change riding along with a refactor. key()/typeInto()
 * similarly match chat-history-drive.mjs's own timing (500ms/180ms) over
 * fleet-node.mjs's (150ms/150ms). Only FLEET_NODE_VISIBLE -- the
 * reachability proof itself, identical across every lineage this module's
 * research found -- is actually imported from fleet-node.mjs.
 *
 * The webContents branch's press() is copied, logic-for-logic, from
 * steering-controls-e2e.cjs's own already-working pressReal() (verified
 * against a real BrowserWindow by that file's own suite). webContents
 * key()/typeInto() are NEW -- steering-controls-e2e.cjs never needed to
 * type text, only to click session-control buttons -- built from
 * Electron's documented webContents.sendInputEvent contract (a 'char'
 * event per character for real text input, 'keyDown'/'keyUp' for a named
 * key), but UNVERIFIED against a live window as of this commit. Per the
 * API decision document §6, the two webContents-only drivers migrate
 * LAST, specifically so that migration step is this branch's own
 * equivalence proof -- this module does not claim that proof in advance
 * of it happening.
 */

import { FLEET_NODE_VISIBLE, INPUT_UI_QUIET, recordInputMetric } from './fleet-node.mjs'
import { CHAT_COMPOSER_INPUT_SELECTOR, CHAT_APPROVAL_SELECTOR } from '../../src/components.js'

export { CHAT_COMPOSER_INPUT_SELECTOR, CHAT_APPROVAL_SELECTOR, FLEET_NODE_VISIBLE }

/* The chat send button -- one selector, same reasoning as
   src/components.js's own exports: a driver composes a scoping prefix
   around this rather than retyping it. Not exported from components.js
   itself because, unlike the composer input and the approval buttons,
   nothing inside buildChat needs to find its OWN send button by a shared
   constant -- it holds the reference directly at construction. Kept here,
   the one place outside the component that needs it, rather than in
   every driver that used to retype it. */
export const CHAT_SEND_SELECTOR = '.chat-send'

/* One timing policy for both CDP and Electron. The old drivers each slept a
   fixed 250/520/500ms even when the page was already idle, which made a long
   Page 2 walk look hung on a fast machine and still raced a streaming update
   on a slow one. These defaults keep a short input guard but let the page's
   input control's mutation quietness extend it while that control changes. Callers
   may tune the bounded values for a known host; no unbounded wait is allowed. */
export const DEFAULT_CHAT_TIMING = Object.freeze({
  visiblePollMs: 80,
  interEventMs: 25,
  pressQuietMs: 120,
  pressBudgetMs: 900,
  keyQuietMs: 100,
  keyBudgetMs: 600,
  typeQuietMs: 80,
  typeBudgetMs: 500,
})

function chatTiming(overrides = {}) {
  const out = { ...DEFAULT_CHAT_TIMING }
  for (const key of Object.keys(DEFAULT_CHAT_TIMING)) {
    const value = Number(overrides?.[key])
    if (Number.isFinite(value) && value >= 0) out[key] = Math.min(10_000, value)
  }
  return out
}

/* Input quietness is scoped to the pressed or focused control by the shared
   helper. It is not a route/reply readiness claim; those keep explicit waits. */

/* ---------------------------------------------------------------
   waitForReply -- replaces nine fixed sleeps with a real signal.
   Modelled on tools/first-run-contract-qa.mjs's SETTLE (a MutationObserver
   quiet-window with a hard budget as the FLOOR, never the signal) -- the
   same shape, independently reinvented three times elsewhere in this repo
   for whole-page route transitions. This is not that primitive reused
   verbatim: a chat reply's quiescence question is scoped to the chat log
   specifically, and cares about a NEW message existing, not merely that
   nothing changed anywhere on the page -- so this adapts SETTLE's
   MutationObserver + quiet-tick + budget structure to that narrower
   question rather than importing the whole-page primitive unchanged.
   --------------------------------------------------------------- */
const CHAT_REPLY_SETTLE = `((rootSelector, logSelector, sinceCount, quietMs, budgetMs) => new Promise(resolve => {
  const started = Date.now()
  const root = document.querySelector(rootSelector)
  if (!root) { resolve({ settled: false, waitedMs: 0, count: sinceCount, reason: 'root-not-found' }); return }
  const log = root.querySelector(logSelector)
  if (!log) { resolve({ settled: false, waitedMs: 0, count: sinceCount, reason: 'log-not-found' }); return }
  let lastMutation = Date.now()
  const observer = new MutationObserver(() => { lastMutation = Date.now() })
  observer.observe(log, { childList: true, subtree: true, characterData: true })
  const tick = () => {
    const count = log.children.length
    const grew = count > sinceCount
    const quietFor = Date.now() - lastMutation
    if (grew && quietFor >= quietMs) {
      observer.disconnect()
      resolve({ settled: true, waitedMs: Date.now() - started, count })
      return
    }
    if (Date.now() - started >= budgetMs) {
      observer.disconnect()
      resolve({ settled: false, waitedMs: Date.now() - started, count })
      return
    }
    setTimeout(tick, 50)
  }
  setTimeout(tick, 50)
}))`

/**
 * Wait for a new message to land in a chat panel's log AND stop changing
 * (a streaming reply grows token by token; returning on the first mutation
 * would catch it mid-word). `timeoutMs` is a BOUND, never the signal --
 * a driver that hits it gets `settled: false` and the count it actually
 * saw, so a reply that never arrived is reported as that, not silently
 * sampled early the way a fixed sleep would be.
 *
 * @param evaluate    expression -> value, awaiting promises (same contract
 *                    fleet-node.mjs's createPresser already takes).
 * @param rootSelector which chat panel -- e.g. '[data-rail-chat-host]',
 *                    '[data-chat-panel]', or a specific card's host.
 * @param sinceCount  how many rows were in the log before the turn that
 *                    should produce a reply -- read this with `evaluate`
 *                    immediately before sending, never assume 0.
 * @param quietMs     how long the log must stop mutating to count as
 *                    settled (default 400ms).
 * @param timeoutMs   the hard budget (default 20s).
 */
export async function waitForReply(evaluate, { rootSelector, sinceCount = 0, quietMs = 400, timeoutMs = 20_000 } = {}) {
  if (!rootSelector) throw new Error('waitForReply requires rootSelector -- which chat panel to watch')
  return evaluate(`${CHAT_REPLY_SETTLE}(${JSON.stringify(rootSelector)}, ${JSON.stringify('.chat-log')}, ${sinceCount}, ${quietMs}, ${timeoutMs})`)
}

/* ---------------------------------------------------------------
   The CDP branch. press/key/type retain the proven real input event shapes
   while using the shared bounded adaptive timing policy above. A short
   MutationObserver quiet window replaces fixed 520/500/180ms sleeps, so a
   ready control proceeds quickly and a changing control gets more time.
   --------------------------------------------------------------- */
/* The three keys chat-history-drive.mjs (and every driver copying its
   pattern) actually dispatches: Enter to submit, Escape to dismiss a
   native <select> popup, ArrowDown to walk one. The SAME three values
   fleet-node.mjs's own KEYS table carries -- named here rather than
   imported from there because that table is not exported, and three
   numbers are not worth widening that module's surface for. A caller
   passes only the NAME, never a code, on both transports alike; the CDP
   branch needs a Windows virtual-key code and the webContents branch
   needs Electron's own key-name string, so each transport still holds
   its own lookup shaped for what it actually needs. */
const CDP_KEYS = { Enter: 13, Escape: 27, ArrowDown: 40 }

function createCdpPresser({ session, evaluate, delay, timing, telemetry }) {
  const visible = async (selector, timeoutMs = 12_000) => {
    const until = Date.now() + timeoutMs
    let last = { state: 'absent' }
    for (;;) {
      last = await evaluate(`(${FLEET_NODE_VISIBLE})(${JSON.stringify(selector)})`)
      if (last?.state === 'visible' || Date.now() >= until) return last
      await delay(timing.visiblePollMs)
    }
  }
  const press = async (selector, timeoutMs = 12_000) => {
    const spot = await visible(selector, timeoutMs)
    if (spot?.state !== 'visible') return spot?.state === 'covered' ? `covered-by-${spot.by}` : (spot?.state || 'unknown')
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      })
      await delay(timing.interEventMs)
    }
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.pressQuietMs}, ${timing.pressBudgetMs}, ${JSON.stringify(selector)})`)
    recordInputMetric(telemetry, { kind: 'press', selector }, settled)
    return 'clicked'
  }
  const key = async name => {
    const keyCode = CDP_KEYS[name]
    if (keyCode === undefined) throw new Error(`chat-drive's CDP key() does not know "${name}" -- add it to CDP_KEYS if a migrated driver really needs it`)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name })
    }
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.keyQuietMs}, ${timing.keyBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'key', name }, settled)
  }
  const type = async text => {
    await session.send('Input.insertText', { text })
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.typeQuietMs}, ${timing.typeBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'type', chars: String(text).length }, settled)
  }
  return { visible, press, key, type }
}

/* ---------------------------------------------------------------
   The webContents branch. press() is steering-controls-e2e.cjs's own
   pressReal(), logic-for-logic, not re-derived -- see this file's header.
   --------------------------------------------------------------- */
function createWebPresser({ webContents, evaluate, delay, timing, telemetry }){
  const visible = async (selector, timeoutMs = 12_000) => {
    const until = Date.now() + timeoutMs
    let last = { state: 'absent' }
    for (;;) {
      last = await evaluate(`(${FLEET_NODE_VISIBLE})(${JSON.stringify(selector)})`)
      if (last?.state === 'visible' || Date.now() >= until) return last
      await delay(timing.visiblePollMs)
    }
  }
  const press = async (selector, timeoutMs = 12_000) => {
    const spot = await visible(selector, timeoutMs)
    if (spot?.state !== 'visible') return spot?.state === 'covered' ? `covered-by-${spot.by}` : (spot?.state || 'unknown')
    const x = Math.round(spot.x)
    const y = Math.round(spot.y)
    webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.pressQuietMs}, ${timing.pressBudgetMs}, ${JSON.stringify(selector)})`)
    recordInputMetric(telemetry, { kind: 'press', selector }, settled)
    return 'clicked'
  }
  /* NEW, UNVERIFIED AGAINST A LIVE WINDOW -- see this file's header. Named
     keys only (this module only ever needs 'Enter' for the composer's
     submit chord); a keyCode this map does not carry falls through to
     Electron's own string, which is correct for a single printable key
     but not guaranteed for every named key Chromium recognises. */
  const NAMED_KEYS = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab' }
  const key = async name => {
    const keyCode = NAMED_KEYS[name] || name
    webContents.sendInputEvent({ type: 'keyDown', keyCode })
    webContents.sendInputEvent({ type: 'keyUp', keyCode })
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.keyQuietMs}, ${timing.keyBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'key', name }, settled)
  }
  /* NEW, UNVERIFIED. One 'char' input event per character -- Electron's
     documented mechanism for real character input via sendInputEvent,
     the same "enters the real input pipeline" property press() already
     has over a scripted .value assignment (see this file's header and
     steering-controls-e2e.cjs's own note on why .click() was rejected). */
  const type = async text => {
    for (const character of String(text)) {
      webContents.sendInputEvent({ type: 'char', keyCode: character })
    }
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.typeQuietMs}, ${timing.typeBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'type', chars: String(text).length }, settled)
  }
  return { visible, press, key, type }
}

/**
 * The one presser, either transport, same returned shape.
 *
 * @param session     a CDP session (needs .send) -- OR
 * @param webContents an Electron webContents (needs .sendInputEvent) --
 *                    exactly one of the two must be supplied.
 * @param evaluate    expression -> value, awaiting promises.
 * @param delay       ms -> promise.
 * @param timing      optional bounded timing overrides for a known host.
 * @returns {{visible, press, key, typeInto, typeAndVerify, send, metrics, timing, waitForReply}}
 */
export function createChatPresser({ session, webContents, evaluate, delay, timing: timingOverrides }) {
  if (!session && !webContents) throw new Error('createChatPresser requires either { session } (CDP) or { webContents } (Electron)')
  if (session && webContents) throw new Error('createChatPresser takes exactly one transport, not both')

  if (typeof evaluate !== 'function' || typeof delay !== 'function') throw new Error('createChatPresser requires evaluate and delay functions')
  const timing = chatTiming(timingOverrides)
  const telemetry = []
  const base = session
    ? createCdpPresser({ session, evaluate, delay, timing, telemetry })
    : createWebPresser({ webContents, evaluate, delay, timing, telemetry })

  /* typeInto is base.type under its composer-facing name -- the trio's
     three call sites (drivers) read more plainly as press/typeInto/key
     than press/type/key when typeInto is specifically "into the composer
     box", which is the only thing this module's type() is ever used for. */
  const typeInto = base.type

  /* The typeReal family's own reason for existing, folded in as an option
     rather than a fifth reinvention: read the field back to confirm the
     text actually landed, instead of trusting the dispatch succeeded. */
  const typeAndVerify = async (selector, text) => {
    await typeInto(text)
    const landed = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ''`)
    return { ok: landed === text, landed }
  }

  /* The observed send-mechanism split, named rather than re-derived per
     driver: some click .chat-send, some submit via Enter. A caller states
     which one it means. */
  const send = async ({ viaEnter = false } = {}) => {
    if (viaEnter) { await base.key('Enter'); return 'sent-via-enter' }
    const clicked = await base.press(CHAT_SEND_SELECTOR)
    return clicked === 'clicked' ? 'sent-via-click' : clicked
  }

  const metrics = () => telemetry.map(entry => ({ ...entry }))
  return { ...base, typeInto, typeAndVerify, send, metrics, timing: Object.freeze({ ...timing }), waitForReply: (opts) => waitForReply(evaluate, opts) }
}
