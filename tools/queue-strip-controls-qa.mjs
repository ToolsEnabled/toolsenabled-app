#!/usr/bin/env node

/* DO THE QUEUE STRIP'S THREE CONTROLS DO WHAT THEIR LABELS SAY?
 *
 * A message typed and sent WHILE THE AGENT IS BUSY must queue rather than
 * interrupt. "Send now" / "Send next" on a queued row must promote it ahead
 * of the rest of the queue. "Unqueue" must remove a row. This drives all
 * three against a REAL busy session -- a real agent actually started from
 * the canvas, the same way a person starts one -- because `nodeBusy()`
 * (src/tree-session-liveness.js) is true only for a session THIS RUN
 * started or reattached (RUN_SESSION_NODES, a private map in
 * src/views/computers.js): a node whose 'running' status is merely SEEDED
 * into localStorage, the way tools/tree-chatbox-open-qa.mjs seeds its four
 * static states, reads as a restart-stale corpse and is never busy. There is
 * no dev hook that fakes membership in that map, so a real Start is the only
 * way to make isBusy() genuinely true. Modelled on tools/chat-history-
 * drive.mjs's scenario D (the file that already solved "how do you get a
 * real mid-turn read out of this app") and tools/tree-chatbox-open-qa.mjs
 * (seeding, the note()/exit-code discipline, and the closeWindow race
 * guard).
 *
 * ONE BUSY WINDOW, NOT TWO. All three controls are driven inside the SAME
 * running turn Start opens: alpha proves queue-while-busy, then bravo/charlie
 * queue in behind it (a fresh status read confirms the turn is still the same
 * one before each), and Send-now/Unqueue are driven straight off those three
 * real rows. An earlier version of this file waited for Turn #1 to finish and
 * then for the outbox's own completion-drain to open a second turn before
 * driving Send-now/Unqueue on fresh entries there -- reasoned defensively
 * (why trust a single real turn to stay open long enough for six more
 * presses), but it cost two extra real-turn waits for no measured gain: the
 * one busy window Start already opens has consistently been long enough for
 * the whole sequence below.
 *
 * EVERY PRESS IS A REAL PRESS, via tools/lib/chat-drive-lib.mjs's CDP
 * presser -- the same mouseMoved/mousePressed/mouseReleased triple and
 * Input.insertText this repo already proved against this exact composer.
 * The queue strip's own two buttons carry no id or data-hook to press by, so
 * each press targets a row by NTH-OF-TYPE computed from a fresh read of the
 * strip immediately before the press, never a cached index -- the strip
 * repaints (and can reorder) after every mutation.
 *
 * ACCOUNT-FENCE.md TRAP: os.tmpdir() resolves to the 8.3 short spelling
 * (…\TOOLSE~2\…) under an elevated shell on this machine, and
 * capability/src/lib/account-profile-boundary.js's installationProfileRoot()
 * does not expand it before comparing -- so a scratch profile built under it
 * is refused with AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE /
 * SERVICE_ACCOUNT_BOUNDARY_REFUSED, which reads exactly like a product
 * defect and is not one. DEV_TEMP_ROOT below is the literal long-form Dev
 * temp root the fence names, used instead of os.tmpdir().
 *
 *   node tools/queue-strip-controls-qa.mjs
 *   node tools/queue-strip-controls-qa.mjs --visible
 */

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { createChatPresser } from './lib/chat-drive-lib.mjs'

const DEV_TEMP_ROOT = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp'

const findings = []
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

/* ---- reads, all scoped to the rail chat -- the compact card is never opened here --- */

const READ_QUEUE = `(() => {
  const strip = document.querySelector('[data-rail-chat-host] .chat-queue-strip')
  if (!strip) return { present: false }
  const rows = [...strip.querySelectorAll('.chat-queue-row')]
  return {
    present: true,
    hidden: strip.hidden,
    rows: rows.map(row => {
      const now = row.querySelector('.chat-queue-now')
      const cancel = row.querySelector('.chat-queue-cancel')
      return {
        text: (row.querySelector('.chat-queue-text')?.textContent || '').trim(),
        nowLabel: now ? now.textContent.trim() : null,
        nowAria: now ? now.getAttribute('aria-label') : null,
        cancelLabel: cancel ? cancel.textContent.trim() : null,
        cancelAria: cancel ? cancel.getAttribute('aria-label') : null,
      }
    }),
  }
})()`

/* A DIAGNOSTIC READ, not an assertion -- when the composer cannot be focused
   this says WHY (cannotSend/readonly/nosend/disabled), instead of leaving
   "hidden" to be guessed at. */
const READ_RAIL_CHAT_DIAGNOSTIC = `(() => {
  const host = document.querySelector('[data-rail-chat-host]')
  const chat = host && host.querySelector('.chat')
  const input = chat && chat.querySelector('.chat-input input')
  const page = document.querySelector('.ctl-page')
  return {
    railHostPresent: Boolean(host),
    chatPresent: Boolean(chat),
    ctlPageActive: Boolean(page && page.classList.contains('is-active')),
    railBodyWords: (document.querySelector('[data-rail-body="chat"]')?.innerText || '').trim().slice(0, 300),
    inputPresent: Boolean(input),
    inputDisabled: Boolean(input && input.disabled),
    inputRect: input ? (() => { const r = input.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    /* FLEET_NODE_VISIBLE (tools/lib/fleet-node.mjs) checks the input's OWN
       display/visibility AND every ANCESTOR's opacity -- neither of which
       inputDisabled/inputRect above can see (a visibility:hidden or
       opacity:0 ancestor still reports a real, non-zero bounding rect). */
    inputOwnStyle: input ? (() => { const s = getComputedStyle(input); return { display: s.display, visibility: s.visibility, opacity: s.opacity } })() : null,
    ancestorOpacities: input ? (() => {
      const chain = []
      for (let cur = input; cur; cur = cur.parentElement) {
        const s = getComputedStyle(cur)
        chain.push({ tag: cur.tagName, cls: (cur.className || '').toString().slice(0, 40), opacity: s.opacity, display: s.display, visibility: s.visibility })
        if (chain.length > 12) break
      }
      return chain
    })() : null,
    cannotSend: chat ? chat.classList.contains('chat-cannot-send') : null,
    readonly: chat ? chat.classList.contains('chat-readonly') : null,
    nosend: (chat?.querySelector('.chat-nosend')?.textContent || '').trim().slice(0, 200),
    activeTabButton: (document.querySelector('[data-rail-tab].on')?.dataset.railTab) || null,
  }
})()`

const READ_COMPOSER = `(() => {
  const host = document.querySelector('[data-rail-chat-host]')
  const chat = host && host.querySelector('.chat')
  const input = chat && chat.querySelector('.chat-input input')
  const sendBtn = chat && chat.querySelector('.chat-send')
  return {
    chatPresent: Boolean(chat),
    inputValue: input ? input.value : null,
    sendIsStop: sendBtn ? sendBtn.classList.contains('is-stop') : null,
    notes: chat ? [...chat.querySelectorAll('.msg.note')].map(m => (m.textContent || '').trim()) : [],
    meBubbles: chat ? [...chat.querySelectorAll('.msg.me')].map(m => (m.textContent || '').trim()) : [],
  }
})()`

const readNodeStatusExpr = (computerId, nodeId) => `(() => {
  try {
    const raw = localStorage.getItem(${JSON.stringify(`mc.fleet.trees.v1:${computerId}`)})
    if (!raw) return { found: false }
    const parsed = JSON.parse(raw)
    const found = (parsed.nodes || []).find(n => n.id === ${JSON.stringify(nodeId)})
    return found ? { found: true, status: found.status, sessionId: found.sessionId } : { found: false }
  } catch (error) { return { __evaluateThrew: String(error) } }
})()`

/* ---- polling helpers -- observed state, never a fixed sleep standing in for one --- */

async function waitForNewNode(window, beforeIds, timeoutMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const ids = readOrThrow(await window.evaluate(
      "(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()",
    ), 'the canvas node ids')
    const fresh = ids.find(id => !beforeIds.includes(id))
    if (fresh) return fresh
    if (Date.now() >= until) return null
    await delay(200)
  }
}

async function waitForNodeStatus(window, computerId, nodeId, wantedSet, timeoutMs) {
  const until = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = readOrThrow(await window.evaluate(readNodeStatusExpr(computerId, nodeId)), 'the node status')
    if (last.found && wantedSet.has(last.status)) return { ok: true, ...last }
    if (Date.now() >= until) return { ok: false, ...last }
    await delay(200)
  }
}

/* THE RAIL PAGE OPENS BEHIND A CSS TRANSITION (src/tree-graph.css
   .computers .rail-page { opacity: 0; transition: opacity 180ms } / .is-active
   { opacity: 1 }), and in this harness's headless window (MC_SMOKE_HEADLESS,
   see test-account-harness.mjs's own note on captureScreenshot needing a
   woken, composited window) the transition can sit at its pre-transition
   opacity:0 indefinitely because nothing ever asks the renderer for another
   frame -- MEASURED: chat-drive-lib's press(), which already retries for a
   full 12s, still read "hidden" at the deadline. A real user's window
   composites on its own; this one is nudged with the same wake sequence
   test-account-harness.mjs documents for screenshots (setWebLifecycleState
   active, a real input event, two rAF frames), then polled for the CSS
   property this is actually about, rather than guessed at with a fixed delay. */
async function wakeWindow(window) {
  try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* best-effort */ }
  try {
    await window.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none', clickCount: 0 })
  } catch { /* best-effort */ }
  await window.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
}

/* TARGETS THE SPECIFIC PAGE THE CHAT HOST LIVES IN, NOT ANY `.rail-page.is-
   active` -- three rail pages share that base class (stats/controls/compose,
   src/views/computers.js activateRail), and MEASURED: pressing the new
   circle immediately after Start can race activateRail(controlsPage) losing
   to whatever page Start's own flow leaves active, so a bare
   `.rail-page.is-active` query can find the COMPOSE page still wearing the
   class (real, opaque, and utterly irrelevant) while the controls page --
   the one with [data-rail-chat-host] -- sits inactive and hidden. This reads
   the ANCESTOR of the actual chat host, and on a real timeout re-presses the
   circle once (the retry a person would do without even noticing) before
   giving up. */
async function waitForRailPageOpaque(window, presser, nodeSelector, timeoutMs = 8000) {
  const check = async () => window.evaluate(`(() => {
    const host = document.querySelector('[data-rail-chat-host]')
    const page = host ? host.closest('.rail-page') : null
    if (!page) return { present: false }
    return { present: true, active: page.classList.contains('is-active'), opacity: Number(getComputedStyle(page).opacity) }
  })()`)
  const pollOnce = async (budgetMs) => {
    const until = Date.now() + budgetMs
    let last = null
    for (;;) {
      last = await check()
      if (last?.present && last.active && last.opacity >= 0.99) return { ok: true, ...last }
      if (Date.now() >= until) return { ok: false, ...(last || {}) }
      try { await window.evaluate('new Promise(resolve => requestAnimationFrame(resolve))') } catch { /* keep polling */ }
      await delay(150)
    }
  }
  const first = await pollOnce(timeoutMs)
  if (first.ok) return first
  const retried = await presser.press(nodeSelector)
  if (retried !== 'clicked') return { ...first, retryPress: retried }
  await wakeWindow(window)
  const second = await pollOnce(timeoutMs)
  return { ...second, retried: true }
}

const BUSY = new Set(['starting', 'running'])

/* ---- driving the compose panel, ported from chat-history-drive.mjs -------------- */

/* chat-drive-lib.mjs's key() only knows Enter/Escape/ArrowDown (CDP_KEYS).
   Home (VK_HOME=36) is sent directly over the same CDP session rather than
   widening that shared table for one local need. */
async function pressHome(window) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36, code: 'Home', key: 'Home',
    })
  }
  await delay(200)
}

async function chooseByKeyboard(window, presser, selector, wanted, maxPresses = 40) {
  const focused = await presser.press(selector)
  if (focused !== 'clicked') return { ok: false, why: `could not focus the menu: ${focused}` }
  await presser.key('Escape')
  /* Home first, so the walk always starts from option 0 -- ArrowDown alone
     only moves forward, and the panel's own default selection is not
     guaranteed to sit at or before `wanted` in list order. */
  await pressHome(window)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if ((await valueNow()) === wanted) return { ok: true, presses: i }
    await presser.key('ArrowDown')
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses` }
}

async function startAgentFromCanvas(window, presser, brief) {
  const opened = await presser.press('.computers .tree-empty-node')
  if (opened !== 'clicked') return { ok: false, why: `the dashed circle could not be pressed: ${opened}` }
  await delay(1200)
  /* SELECTABLE, NOT MERELY PRESENT. A codex-provider tier (luna/terra/sol)
     renders as a real <option> in this select whether or not Codex is signed
     in on this sterile profile -- it is only DISABLED, and a disabled option
     is unreachable by ArrowDown (the native control skips it) and would sit
     the compose panel on an option the Start button then refuses. MEASURED:
     reading every option (disabled included) handed chooseByKeyboard 'luna'
     as tiers[0] and it could not be reached in 24 presses because it never
     can be, by keyboard, while disabled. */
  const offered = readOrThrow(await window.evaluate(`(() => {
    const read = (field) => {
      const node = document.querySelector('[data-compose-field="' + field + '"]')
      return node ? [...node.options].filter(o => !o.disabled).map(o => o.value).filter(Boolean) : []
    }
    return { tiers: read('tier'), roles: read('role') }
  })()`), 'the compose menus')
  if (!offered.tiers.length || !offered.roles.length) {
    return { ok: false, why: `the compose panel offered no SELECTABLE tier or role (${JSON.stringify(offered)})` }
  }
  const pickedTier = await chooseByKeyboard(window, presser, '[data-compose-field="tier"]', offered.tiers[0])
  if (!pickedTier.ok) return { ok: false, why: `could not choose a tier: ${pickedTier.why}` }
  const pickedRole = await chooseByKeyboard(window, presser, '[data-compose-field="role"]', offered.roles[0])
  if (!pickedRole.ok) return { ok: false, why: `could not choose a role: ${pickedRole.why}` }
  const focusedBrief = await presser.press('[data-compose-field="message"]')
  if (focusedBrief !== 'clicked') return { ok: false, why: `the brief field could not be pressed: ${focusedBrief}` }
  await presser.typeInto(brief)

  const startTarget = readOrThrow(await window.evaluate(`(() => {
    const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = document.querySelector('[data-compose-action="start"]')
    if (!btn || !visible(btn)) return null
    if (!btn.id) btn.id = 'queue-strip-qa-start'
    return { selector: '#' + btn.id }
  })()`), 'the Start control')
  if (!startTarget) return { ok: false, why: 'there is no Start control on the compose panel' }

  const before = readOrThrow(await window.evaluate(
    "(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()",
  ), 'the canvas before the start')
  const pressedStart = await presser.press(startTarget.selector)
  if (pressedStart !== 'clicked') return { ok: false, why: `Start could not be pressed: ${pressedStart}` }

  const nodeId = await waitForNewNode(window, before, 8000)
  if (!nodeId) return { ok: false, why: 'the start drew no new circle within 8s' }
  return { ok: true, nodeId, tier: offered.tiers[0], role: offered.roles[0] }
}

/* ---- the queue strip's three controls -------------------------------------------- */

async function queueViaComposer(window, presser, text) {
  const focused = await presser.press('[data-rail-chat-host] .chat-input input')
  if (focused !== 'clicked') return { ok: false, why: `could not focus the composer: ${focused}` }
  await presser.typeInto(text)
  const sendResult = await presser.send()
  await delay(300)
  return {
    ok: true,
    sendResult,
    composer: readOrThrow(await window.evaluate(`(${READ_COMPOSER})`), 'the composer after a queueing send'),
    queue: readOrThrow(await window.evaluate(`(${READ_QUEUE})`), 'the queue strip after a queueing send'),
  }
}

async function pressQueueRowButton(window, presser, matchText, kind) {
  const before = readOrThrow(await window.evaluate(`(${READ_QUEUE})`), `the queue strip before pressing ${kind} on ${matchText}`)
  const index = before.rows.findIndex(r => r.text === matchText)
  /* `after` is always read, found-row or not, so a caller can always ask what
     the strip looks like now -- a row that vanished (drained by a real turn
     ending mid-test, not this control's doing) is itself worth seeing, not an
     undefined a later check crashes on. */
  if (index < 0) {
    return {
      pressed: false, why: `no row for ${JSON.stringify(matchText)}`, before,
      after: readOrThrow(await window.evaluate(`(${READ_QUEUE})`), `the queue strip (row not found) for ${matchText}`),
    }
  }
  const selector = `[data-rail-chat-host] .chat-queue-strip .chat-queue-row:nth-of-type(${index + 1}) .chat-queue-${kind}`
  const result = await presser.press(selector)
  await delay(250)
  return {
    pressed: result === 'clicked',
    why: result === 'clicked' ? null : result,
    beforeRow: before.rows[index],
    after: readOrThrow(await window.evaluate(`(${READ_QUEUE})`), `the queue strip after pressing ${kind} on ${matchText}`),
  }
}

async function main() {
  const scratch = mkdtempSync(path.join(DEV_TEMP_ROOT, 'queue-strip-qa-'))
  if (!path.resolve(scratch).toLowerCase().startsWith('c:\\users\\toolsenabled-dev\\')) {
    throw new Error(`refusing to use a scratch dir outside the Dev profile: ${scratch}`)
  }
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)
    await wakeWindow(window)
    const presser = createChatPresser({ session: window.session, evaluate: window.evaluate, delay })

    await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
    await window.evaluate("location.hash = '#/computers'")
    await delay(1000)
    await window.evaluate('location.reload()')
    await delay(3800)
    const computerId = await window.evaluate('window.__mcGraph?.computer?.id || null')
    if (!computerId) { note('FAIL', 'HARNESS STATE: the computers page never named a computer.'); return }
    note('info', `computer on screen: ${JSON.stringify(computerId)}`)

    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) {
      note('SKIP', `HARNESS STATE: no engine reachable in this staged build (${JSON.stringify(reachable)}) -- the queue strip cannot be driven against a real busy session.`)
      return
    }

    /* ============ TURN #1: press Start for real, and prove QUEUE-WHILE-BUSY ============
       A brief that asks for SUSTAINED GENERATION, not a tool call: this turn's
       busy window has to outlast pressing a circle, waking the window, and a
       CSS-transition retry -- all real wall-clock, all before the first queue
       action. MEASURED: "Check the tests and read one file." (chat-history-
       drive.mjs's own brief) sometimes finished in well under that overhead. A
       few hundred words of prose takes a real model measurably longer to
       stream than a one-line tool-backed answer, without depending on this
       staged copy's filesystem the way a file-reading brief does. */
    const started = await startAgentFromCanvas(window, presser,
      'Write a thorough, detailed 500-word explanation of how a hash table works: hashing, collision resolution (with two named strategies), load factor, and one worked example with actual numbers. Do not use any tools; just write the explanation directly, taking your time to be complete.')
    if (!started.ok) { note('FAIL', `could not start a real agent from the canvas: ${started.why}`); return }
    note('info', `started ${JSON.stringify(started.nodeId)} on tier ${started.tier}, role ${started.role}`)

    const nodeSelector = `.node[data-agent-id="${started.nodeId}"]`
    const bubble = await presser.press(nodeSelector)
    check(bubble === 'clicked', 'the new circle can be pressed to open its rail chat', String(bubble))
    await wakeWindow(window)
    const railOpaque = await waitForRailPageOpaque(window, presser, nodeSelector, 4000)
    note(railOpaque.ok ? 'info' : 'FAIL', `rail page opacity after opening: ${JSON.stringify(railOpaque)}`)
    if (!railOpaque.ok) {
      note('FAIL', 'the controls rail page never became the active, opaque page -- nothing below would be a measurement of the queue strip.')
      return
    }

    const turn1Busy = await waitForNodeStatus(window, computerId, started.nodeId, BUSY, 5000)
    note(turn1Busy.ok ? 'ok' : 'FAIL', `Turn #1 busy window: status=${JSON.stringify(turn1Busy.status)}`)
    if (!turn1Busy.ok) {
      note('FAIL', 'the node never read busy after Start -- nodeBusy() never went true, so the queue door could not be exercised at all.')
      return
    }

    const diag = readOrThrow(await window.evaluate(READ_RAIL_CHAT_DIAGNOSTIC), 'the rail chat diagnostic before queueing')
    note('info', `rail chat diagnostic: ${JSON.stringify(diag)}`)

    const queuedAlpha = await queueViaComposer(window, presser, 'alpha')
    if (!queuedAlpha.ok) { note('FAIL', `could not type+send "alpha": ${queuedAlpha.why}`); return }
    check(
      queuedAlpha.composer.inputValue === '',
      'BEFORE-EVIDENCE 1: typing "alpha" and pressing Send while busy clears the box (queued, not sent-and-stuck)',
      `inputValue=${JSON.stringify(queuedAlpha.composer.inputValue)}`,
    )
    check(
      queuedAlpha.composer.notes.every(n => !/interrupt/i.test(n)),
      'BEFORE-EVIDENCE 1: no "Interrupted" note appeared from pressing Send with text in the box',
      JSON.stringify(queuedAlpha.composer.notes),
    )
    check(
      queuedAlpha.composer.meBubbles.every(m => m !== 'alpha'),
      'BEFORE-EVIDENCE 1: no "me" bubble claims "alpha" was sent (it is only queued)',
      JSON.stringify(queuedAlpha.composer.meBubbles),
    )
    check(
      queuedAlpha.queue.present && !queuedAlpha.queue.hidden && queuedAlpha.queue.rows.length === 1 && queuedAlpha.queue.rows[0].text === 'alpha',
      'BEFORE-EVIDENCE 1: the queue strip shows exactly one row, "alpha"',
      JSON.stringify(queuedAlpha.queue),
    )

    /* ============ STILL TURN #1: prove SEND-NOW / SEND-NEXT (promote) and UNQUEUE ============
       No wait for a second turn -- "alpha" alone already proved queue-while-
       busy, and racing a real turn's own completion (then racing the outbox's
       auto-drain into a second real turn) buys nothing but two more chances
       for wall-clock flakiness. bravo/charlie queue into the SAME first busy
       window; a busy check right before confirms it is still the window this
       is a claim about. */
    const stillBusy = await window.evaluate(readNodeStatusExpr(computerId, started.nodeId))
    note(BUSY.has(stillBusy?.status) ? 'info' : 'FAIL', `still busy before bravo/charlie: status=${JSON.stringify(stillBusy?.status)}`)
    const queuedBravo = await queueViaComposer(window, presser, 'bravo')
    if (!queuedBravo.ok) { note('FAIL', `could not type+send "bravo": ${queuedBravo.why}`); return }
    const queuedCharlie = await queueViaComposer(window, presser, 'charlie')
    if (!queuedCharlie.ok) { note('FAIL', `could not type+send "charlie": ${queuedCharlie.why}`); return }
    /* RELATIVE, NOT AN EXACT LIST. If Turn #1's real completion lands between
       alpha and bravo, the turn-completed listener legitimately drains alpha
       into a real send right here -- src/views/computers.js's own drain path,
       proof the fix reaches that door too, not a defect in this one. Only
       bravo-before-charlie is this section's actual claim. */
    const order = queuedCharlie.queue.rows.map(r => r.text)
    note('info', `queue order after bravo+charlie: ${JSON.stringify(order)} (alpha present = ${order.includes('alpha')})`)
    check(
      order.includes('bravo') && order.includes('charlie') && order.indexOf('bravo') < order.indexOf('charlie'),
      'BEFORE-EVIDENCE 2: bravo and charlie both queued busy, in the order they were sent',
      JSON.stringify(order),
    )
    const promotingLabel = queuedCharlie.queue.rows.find(r => r.text === 'charlie')?.nowLabel
    check(
      promotingLabel === 'Send next',
      'BEFORE-EVIDENCE 2: a queued row\'s promote button reads "Send next" while a turn is running',
      `label=${JSON.stringify(promotingLabel)}`,
    )

    /* pressQueueRowButton's `before` read finds the row BY NAME first and only
       presses if it is really there -- so `pressed === true` alone is already
       non-racy proof that a "charlie" row genuinely existed and its "Send
       next" button was really clicked. The resulting ORDER is the part a real
       turn's own completion can race: if it lands in the same instant,
       src/views/computers.js's turn-completed listener legitimately drains
       whatever is now the HEAD -- which, the instant after a successful
       promote, is the row this just promoted. So "charlie now missing
       entirely" is read as a LATER, correct drain of the very row that was
       just confirmed promoted, not a failure of the promote itself; only
       "charlie still present but NOT at the head" would be. */
    const promoted = await pressQueueRowButton(window, presser, 'charlie', 'now')
    check(promoted.pressed, 'BEFORE-EVIDENCE 2: the "Send next" button on the "charlie" row can be pressed (it was really there to press)', String(promoted.why))
    const charlieAfter = promoted.after.rows.find(r => r.text === 'charlie')
    check(
      !charlieAfter || promoted.after.rows[0]?.text === 'charlie',
      'BEFORE-EVIDENCE 2: pressing "Send next" on "charlie" puts it at the HEAD of the queue (or it has already drained from there -- see above)',
      `order now ${JSON.stringify(promoted.after.rows.map(r => r.text))}, charlie still present = ${Boolean(charlieAfter)}`,
    )

    /* Cancel on whichever OTHER row is still there to test Unqueue against --
       'bravo' if it survived the promote-and-possible-drain above, otherwise
       whatever pressQueueRowButton's own fresh `before` read finds. */
    const targetForUnqueue = promoted.after.rows.find(r => r.text !== 'charlie')?.text
      || promoted.after.rows[0]?.text
    if (!targetForUnqueue) {
      note('info', 'nothing left queued to press Unqueue on -- both alpha and bravo drained ahead of this step (a fast real turn, not a defect in this control)')
    } else {
      const unqueuedLabel = promoted.after.rows.find(r => r.text === targetForUnqueue)?.cancelLabel
      check(unqueuedLabel === 'Unqueue', 'BEFORE-EVIDENCE 3: the row\'s cancel button reads "Unqueue"', `label=${JSON.stringify(unqueuedLabel)}`)
      const unqueued = await pressQueueRowButton(window, presser, targetForUnqueue, 'cancel')
      check(unqueued.pressed, `BEFORE-EVIDENCE 3: "Unqueue" on the "${targetForUnqueue}" row can be pressed (it was really there to press)`, String(unqueued.why))
      check(
        !unqueued.after.rows.some(r => r.text === targetForUnqueue),
        `BEFORE-EVIDENCE 3: pressing "Unqueue" really removes the "${targetForUnqueue}" row`,
        `order now ${JSON.stringify(unqueued.after.rows.map(r => r.text))}`,
      )
    }

    /* CLEANUP: unqueue WHATEVER is left, re-reading fresh before every single
       press rather than iterating a list captured once -- a name in that list
       can itself drain out from under the loop between presses. */
    for (let guard = 0; guard < 6; guard += 1) {
      const now = readOrThrow(await window.evaluate(`(${READ_QUEUE})`), 'the queue strip during cleanup')
      const text = now.rows[0]?.text
      if (!text) {
        check(now.rows.length === 0 && now.hidden === true, 'cleanup: the queue strip is empty and hidden again', JSON.stringify(now))
        break
      }
      const result = await pressQueueRowButton(window, presser, text, 'cancel')
      check(result.pressed, `cleanup: "Unqueue" on the "${text}" row can be pressed`, String(result.why))
      if (!result.pressed) break
    }
    /* Informational, not a check: whether every claim above was really about
       ONE busy window, or the turn slipped to terminal partway through and
       these were the SEND-NOW/UNQUEUE-while-idle doors instead. Read once,
       no wait -- a slip is worth knowing about, not worth blocking on. */
    const endStatus = await window.evaluate(readNodeStatusExpr(computerId, started.nodeId))
    note('info', `status at the end of the sequence: ${JSON.stringify(endStatus?.status)} (busy throughout = ${BUSY.has(endStatus?.status)})`)
  } finally {
    if (window) {
      await Promise.race([closeWindow(window).catch(() => {}), delay(15_000)])
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }

  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
