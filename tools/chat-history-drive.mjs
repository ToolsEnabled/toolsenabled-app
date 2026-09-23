#!/usr/bin/env node

/* THE CONVERSATION, DRIVEN: DOES IT SURVIVE, AND DOES IT SHOW THE WORK?
 *
 * WHAT THIS ANSWERS. Four of the owner's findings on the preview build, each
 * one about the chat log on a tree node:
 *
 *   1  the chat is not a context window -- a turn that spends five minutes
 *      running commands puts nothing in it
 *   2  the messages "pile"
 *   4  the messages "combine into each other"
 *   6  "the messages in history disappear"
 *
 * and the defect underneath the last one, which is the worst of them: a save on
 * ONE node used to delete a DIFFERENT node's whole conversation and return true.
 * On a research machine that is destroyed work.
 *
 * IT IS DRIVEN, NOT INSPECTED. Every press below is a real mouse press at real
 * coordinates on a staged packaged build, with document.elementFromPoint checked
 * before the press so a control something is covering is reported as covered
 * rather than clicked. Typing is Input.insertText into a focused field. No
 * el.click(), no dispatchEvent, no assigned .value.
 *
 * IT NEVER TOUCHES THE INSTALLED COPY. The build is staged into a scratch
 * directory, every launch carries its own --user-data-dir, and LOCALAPPDATA,
 * APPDATA and USERPROFILE are redirected under the scratch profile
 * (tools/test-account-harness.mjs owns that rig).
 *
 * THE ENGINE, AND WHAT THAT COSTS THE CLAIM. Scenario D runs a turn through the
 * real path -- engine, shell/agent-host.cjs, shell/main.cjs, the preload's event
 * channel, the renderer's activity branch -- against
 * tools/test/fixtures/narrating-engine, which emits the two real adapters' own
 * tool_call/tool_result shapes on a timer. Nothing above the host is stubbed.
 * What it does NOT prove is that a model would choose those commands; it proves
 * the product carries a turn's actions from the wire to the glass and into the
 * saved record. A run against a paid engine answers the other half and needs
 * quota this lane does not have.
 *
 *   node tools/chat-history-drive.mjs
 *   node tools/chat-history-drive.mjs --visible
 *   node tools/chat-history-drive.mjs --keep      leave the scratch directory
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertIsolated,
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

const findings = []
/* The exit code is set the moment a finding is made, never at the end: a
   teardown that hangs on a closed debugger socket must be able to lose the
   summary and never the answer. */
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

/* ------------------------------------------------------------- pressing --
 *
 * B-POOL-6 MIGRATION (API decision doc §6, step 1 of 5 — chat-history-
 * drive.mjs is the origin the other four "typeInto family" drivers copy
 * verbatim). The CDP dispatch itself now lives in tools/lib/chat-drive-lib.mjs,
 * shared with the eight other drivers that used to reinvent it. These
 * three functions are thin adapters that keep every one of this file's
 * existing call sites working against the SAME {pressed, why} /
 * {pressed, at} shape they already expect (`.at` was always returned and
 * never read downstream -- grepped this file for `.at.x`/`.at.y` before
 * dropping it to an empty object rather than assuming) -- only the
 * mechanism moved, not the contract.
 *
 * ONE DELIBERATE BEHAVIOR CHANGE, NAMED RATHER THAN HIDDEN: reachability
 * now goes through fleet-node.mjs's FLEET_NODE_VISIBLE (via chat-drive-lib.mjs)
 * instead of this harness's own window.waitForVisible (test-account-
 * harness.mjs's VISIBLE_FN). The two are NOT identical: VISIBLE_FN checks
 * only the target node's own opacity; FLEET_NODE_VISIBLE also walks every
 * ANCESTOR's opacity, catching a node hidden by a fading-out parent that
 * VISIBLE_FN's own check would have missed. Strictly more careful, not
 * less -- a real reachability gap closes, not one that opens. */
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
  return { pressed: true, at: {} }
}

async function typeInto(window, selector, text) {
  const pressed = await press(window, selector)
  if (!pressed.pressed) return pressed
  await presserFor(window).typeInto(text)
  return pressed
}

/* WAIT FOR A PAINTED FRAME, BECAUSE THE ROWS ARE BATCHED INTO ONE.
 *
 * The chat appends its action rows once per frame on purpose: the log is pinned
 * to its bottom by a ResizeObserver and a MutationObserver that both fire on
 * every appended child, and a turn emitting hundreds of tool events would
 * otherwise re-pin hundreds of times on the main thread. So a driver that reads
 * the log the instant an event crosses the wire is reading BEFORE the frame that
 * draws it -- measured here: 3 rows at 560ms, 7 rows after one frame. That is a
 * correct product batching its work, and an instrument that called it a missing
 * row would have had a correct change reverted. */
async function paintedFrame(window) {
  return window.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))')
}

/* keyCode is accepted and ignored, not removed from the signature -- every
   existing call site (key(window, 'Enter', 13) etc.) keeps compiling
   unchanged. chat-drive-lib.mjs's own key() carries the same three codes
   internally (CDP_KEYS) and refuses a name it does not recognise, so a
   silently wrong code can no longer reach a real key event even if a
   future call site passed one. */
async function key(window, name, _keyCode) {
  await presserFor(window).key(name)
}

/* A NATIVE MENU TAKES ARROW KEYS ONLY AFTER ITS POPUP IS DISMISSED. Pressing a
   <select> opens an operating-system popup, and the first ArrowDown goes to the
   popup rather than to the element; Escape closes it and the arrows land where
   a keyboard user expects. Ported from tools/claude-tree-start-proof.mjs, which
   measured this. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  const seen = []
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await valueNow()
    seen.push(current)
    if (current === wanted) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses`, seen: [...new Set(seen)] }
}

/* ---------------------------------------------------------------- state -- */

/* THE COMPUTER ID IS READ OFF THE PAGE, NEVER TYPED. The record's key carries it
   (`mc.fleet.trees.v1:<computerId>`), and a record filed under a name this
   machine does not use is a record the product correctly ignores -- which reads
   here as "the tree page never drew a circle" and gets blamed on the product.
   tools/tree-chatbox-open-qa.mjs learned the same lesson. */
async function computerOnScreen(window) {
  await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
  await window.evaluate("location.hash = '#/computers'")
  await delay(1000)
  await window.evaluate('location.reload()')
  await delay(3800)
  return window.evaluate('window.__mcGraph?.computer?.id || null')
}

function node({ id, sessionId = null, status = 'finished', message, reply = '', tier = 'luna' }) {
  return { id, sessionId, status, message, reply, tier }
}

function treeRecord(computerId, nodes) {
  const stamp = new Date().toISOString()
  return {
    version: 1,
    computerId,
    trees: [{ id: 'tree-1', name: 'Research', createdAt: stamp, updatedAt: stamp, profileId: null }],
    nodes: nodes.map((held, index) => ({
      id: held.id,
      treeId: 'tree-1',
      parentId: index === 0 ? null : nodes[0].id,
      role: index === 0 ? 'coordinator' : 'worker',
      message: held.message,
      status: held.status,
      statusNote: '',
      reply: held.reply || '',
      tier: held.tier || 'luna',
      sessionId: held.sessionId,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  }
}

/* A FULL CONVERSATION, SIZED SO EIGHT OF THEM NEARLY FILL THE STORAGE.
 *
 * MEASURED HERE, on a staged packaged build, and it is why this shape is what
 * it is. Seeding eight records at the store's per-record ceiling (40 lines of
 * 600 characters) was refused outright:
 *
 *   Could not save setting "mc.fleet.transcripts.v1:<computer>":
 *   a settings value may not exceed 65536 characters
 *
 * That is shell/renderer-prefs.cjs's own bound on a stored value, so 64KB is
 * what the whole record may ever be -- a fact no arithmetic inside the store
 * could have produced, and the reason its envelope cap is now taken from
 * there. Eight of these come to roughly 62KB, which leaves the next save to
 * cross the line and makes the trimming the thing under measurement. */
function fullRecord(seed, lineChars = 150) {
  return {
    savedAt: 1_700_000_000_000 + seed,
    threadId: `thread-${seed}`,
    effort: 'medium',
    trimmed: 0,
    lines: Array.from({ length: 40 }, (_, i) => ({
      who: i % 2 ? 'agent' : 'you',
      text: `${seed}:${i}:${'w'.repeat(lineChars)}`,
      at: 1_700_000_000_000 + seed * 1000 + i,
    })),
  }
}

const treesKey = computerId => `mc.fleet.trees.v1:${computerId}`
const storeKey = computerId => `mc.fleet.transcripts.v1:${computerId}`

/* A WRITE THAT DID NOT LAND MUST NOT READ AS A PRODUCT DEFECT. localStorage
   throws on quota, and a seed that silently failed would be reported below as
   "the conversations disappeared" -- a harness fault dressed as the very defect
   under measurement. So the write is checked by reading its own length back. */
async function setItem(window, storageKey, value) {
  const body = JSON.stringify(JSON.stringify(value))
  const written = await window.evaluate(`(() => {
    try {
      localStorage.setItem(${JSON.stringify(storageKey)}, ${body})
      const back = localStorage.getItem(${JSON.stringify(storageKey)})
      return { ok: true, length: back ? back.length : 0 }
    } catch (error) { return { ok: false, why: String(error && error.message).slice(0, 120) } }
  })()`)
  if (written && written.__evaluateThrew) return { ok: false, why: written.__evaluateThrew.slice(0, 160) }
  return written || { ok: false, why: 'the page answered nothing' }
}

/* Write both records under the id the page is really using, then reload so the
   product reads them back through its own parsers. Answers which circles the
   canvas really drew, so nothing below is measured over a refused record. */
async function seedRecords(window, computerId, { nodes, transcripts }) {
  const wroteTrees = await setItem(window, treesKey(computerId), treeRecord(computerId, nodes))
  const wroteStore = await setItem(window, storeKey(computerId), transcripts)
  if (!wroteTrees.ok) throw new Error(`the tree record could not be seeded: ${wroteTrees.why}`)
  if (!wroteStore.ok) throw new Error(`the conversation record could not be seeded: ${wroteStore.why}`)
  console.log(`      seeded ${wroteTrees.length} characters of tree and ${wroteStore.length} of conversation`)
  await window.evaluate('location.reload()')
  await delay(4200)
  const drawn = await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()")
  return Array.isArray(drawn) ? drawn : []
}

/* ------------------------------------------------------------- readings -- */

/* WHAT IS ON THE GLASS, read from both chat surfaces at once so no report can
   say "the chat is empty" about the surface it did not look at. Every message
   carries its COMPUTED style, because the defect items 2 and 4 describe is a
   painting one: a reply used to be classed with the role key, for which no
   stylesheet has a rule, and rendered as bare full-width text beside real
   bubbles. */
const READ_CHAT = `function readChat(nodeId) {
  const describe = (chat) => {
    if (!chat) return null
    const log = chat.querySelector('.chat-log')
    if (!log) return null
    const messages = [...chat.querySelectorAll('.msg')].map(m => {
      const style = getComputedStyle(m)
      /* PAINTED IS MEASURED SIX WAYS, NOT FOUR -- retuned for the gutter
         redesign (src/styles.css, "owner-approved mockup, applied
         2026-08-24"), which moved identity OFF the message box entirely.
         The four checks below this comment are the ORIGINAL ones, written
         for the bubble era (backgroundImage was the person's gradient
         quote-box); they still catch a role with genuinely no rule at all
         (background.js's original defect). Two more are ADDED, not
         substituted, because the current design carries identity two NEW
         ways the old four cannot see: .msg.me's mark is a LEFT border
         (border-left, never border-top -- the property this file used to
         read); .msg.them carries no border or background on the message at
         all BY DESIGN, its whole mark is a coloured dot on its ::before
         pseudo-element, which getComputedStyle(m) alone can never reach. A
         message painted only one of these six ways is still a message with
         a real, deliberate identity treatment -- this failed silently
         before the redesign shipped because nothing here was updated
         alongside it, the same two-sources-of-truth drift chat-message-
         identity.test.mjs was already fixed for on the unit side. */
      const beforeStyle = getComputedStyle(m, '::before')
      return {
        cls: m.className,
        text: (m.querySelector('.chat-msg-text')?.textContent || '').trim().slice(0, 70),
        who: (m.querySelector('.who')?.textContent || '').trim(),
        hasWho: Boolean(m.querySelector('.who')),
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderWidth: style.borderTopWidth,
        borderLeftWidth: style.borderLeftWidth,
        boxShadow: style.boxShadow,
        beforeBackground: beforeStyle.backgroundColor,
        painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)'
          || style.backgroundImage !== 'none'
          || style.borderTopWidth !== '0px'
          || style.boxShadow !== 'none'
          || style.borderLeftWidth !== '0px'
          || (beforeStyle.content !== 'none' && beforeStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'),
        alignSelf: style.alignSelf,
        width: Math.round(m.getBoundingClientRect().width),
      }
    })
    const actions = [...chat.querySelectorAll('.chat-action')].map(a => ({
      state: a.dataset.actionState || '',
      tool: (a.querySelector('.chat-action-tool')?.textContent || '').trim(),
      detail: (a.querySelector('.chat-action-detail')?.textContent || '').trim().slice(0, 60),
      outcome: (a.querySelector('.chat-action-state')?.textContent || '').trim(),
      open: a.open === true,
      body: (a.querySelector('.chat-action-body')?.textContent || '').trim().slice(0, 80),
      width: Math.round(a.getBoundingClientRect().width),
    }))
    const order = [...log.children]
      .map(el => el.classList.contains('msg') ? 'msg' : (el.classList.contains('chat-action') ? 'action' : el.tagName.toLowerCase()))
    return { messages, actions, order, logWidth: Math.round(log.getBoundingClientRect().width) }
  }
  const chip = document.querySelector('.chip[data-agent-id="' + nodeId + '"]')
  const railHost = document.querySelector('[data-rail-chat-host]')
  return {
    chipAsChat: Boolean(chip && chip.classList.contains('as-chat')),
    card: describe(chip && chip.querySelector('.chat')),
    rail: describe(railHost && railHost.querySelector('.chat')),
  }
}`

const READ_STORE = computerId => `(() => {
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(${JSON.stringify(storeKey(computerId))})) } catch (error) { return { broken: String(error) } }
  if (!raw || !raw.nodes) return { records: 0, ids: [] }
  const ids = Object.keys(raw.nodes)
  return {
    records: ids.length,
    ids,
    lines: Object.fromEntries(ids.map(id => [id, raw.nodes[id].lines.length])),
    threads: Object.fromEntries(ids.map(id => [id, raw.nodes[id].threadId])),
    kinds: Object.fromEntries(ids.map(id => [id, raw.nodes[id].lines.map(l => l.who).join(',')])),
    savedAt: Object.fromEntries(ids.map(id => [id, raw.nodes[id].savedAt])),
    serialized: JSON.stringify(raw).length,
  }
})()`

const surfaceOf = seen => (seen && (seen.rail || seen.card)) || null

/* ------------------------------------------------------------ scenarios -- */

/* STARTING AN AGENT THE WAY A PERSON DOES: the dashed circle on the canvas, the
   compose panel, a tier, a role, a typed brief, Start. Shared by the scenarios
   that need a session this window really owns -- which is every scenario that
   measures a SAVE, because persistTranscript only knows the sessions this
   window started. */
async function startAgentFromCanvas(window, brief, { slot = '.tree-chat-add' } = {}) {
  const doorway = await press(window, slot)
  if (!doorway.pressed) return { ok: false, why: `the creation control could not be pressed (${doorway.why})` }
  if (slot === '.tree-chat-add') {
    const choice = await press(window, '.tree-new-tree')
    if (!choice.pressed) return { ok: false, why: `New tree could not be pressed (${choice.why})` }
  }
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
  const pickedTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', offered.tiers[0])
  if (!pickedTier.ok) return { ok: false, why: `could not choose a tier (${pickedTier.why})` }
  const pickedRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
  if (!pickedRole.ok) return { ok: false, why: `could not choose a role (${pickedRole.why})` }
  const typed = await typeInto(window, '[data-compose-field="message"]', brief)
  if (!typed.pressed) return { ok: false, why: `the brief field could not be pressed (${typed.why})` }

  const startTarget = readOrThrow(await window.evaluate(`(() => {
    const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    // Semantic selector, not a text-regex scan of every button: the compose
    // panel now legitimately shows a "Set" face on a fresh tree (B3's
    // Set/Start split), which /^start/i could never distinguish from an
    // absent Start. data-compose-action="start" names the control itself,
    // stable across both faces. See also [data-compose-action="set"].
    const btn = document.querySelector('[data-compose-action="start"]')
    if (!btn || !visible(btn)) return null
    if (!btn.id) btn.id = 'chat-history-drive-start'
    return { selector: '#' + btn.id, label: btn.textContent.trim().slice(0, 40), disabled: btn.disabled === true }
  })()`), 'the Start control')
  if (!startTarget) return { ok: false, why: 'there is no Start control on the compose panel' }
  const before = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas before the start',
  )
  const pressedStart = await press(window, startTarget.selector)
  if (!pressedStart.pressed) return { ok: false, why: `Start could not be pressed (${pressedStart.why})` }
  await delay(5200)
  const after = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas after the start',
  )
  const fresh = after.find(id => !before.includes(id)) || null
  if (!fresh) return { ok: false, why: `the start drew no new circle (${after.length} on the canvas)` }
  return { ok: true, nodeId: fresh, tier: offered.tiers[0], role: offered.roles[0], label: startTarget.label }
}


/* A -- SEVEN SAVED CONVERSATIONS, AND A REAL AGENT SAVING BESIDE THEM.
 *
 * THE MEASUREMENT THIS REPLACES. Against the code as it stood, eight records at
 * the store's per-record ceiling saved in a row left FOUR, every save returning
 * true: saving one node's transcript destroyed another node's entire
 * conversation, silently.
 *
 * THE AGENT IS REAL AND STARTED THE WAY A PERSON STARTS ONE, and that is not
 * ceremony. persistTranscript maps a session to its node through
 * sessionNodeIds, which holds only sessions THIS window started -- deliberately,
 * because a saved session id is a fact about a process that is gone. So a
 * seeded session id drives no save at all, and an earlier version of this
 * scenario typed into a chat, saw the record unchanged, and would have reported
 * a pass. The only way to measure a save is to make one.
 *
 * The seeded seven come to roughly 62KB, so the eighth conversation's first
 * save is what crosses the storage's own 64KB line -- which is exactly where
 * the old code deleted somebody's work and the new code gives up lines. */
async function scenarioA(executable, scratch, appRoot) {
  console.log('\nA. seven saved conversations, and a real agent saving beside them')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer, so nothing here is about a tree'); return }
    const nodes = Array.from({ length: 7 }, (_, i) => node({
      id: `node-${i}`, sessionId: `sess-${i}`, status: 'finished',
      message: `Question ${i}`, reply: `Answer ${i}`,
    }))
    const transcripts = { v: 1, nodes: Object.fromEntries(nodes.map((held, i) => [held.id, fullRecord(i, 176)])) }
    console.log(`      seeding ${JSON.stringify(transcripts).length} characters of conversation across ${nodes.length} nodes`)
    const drawn = await seedRecords(window, computerId, { nodes, transcripts })
    if (drawn.length !== 7) { note('FAIL', `only ${drawn.length}/7 circles reached the canvas (${drawn.join(',')})`); return }

    const before = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the seeded record')
    check(before.records === 7, 'the seven seeded conversations are all readable', `records=${before.records}, ${before.serialized} characters`)

    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) {
      note('SKIP', `no engine reachable (${reachable && reachable.code}); a real save could not be driven`)
      return
    }
    const started = await startAgentFromCanvas(window, 'Check the tests and read one file.')
    if (!started.ok) { note('FAIL', `an eighth agent could not be started: ${started.why}`); return }
    note('INFO', `the start drew ${started.nodeId}`)
    await delay(3200)

    const after = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after a real save')
    check(
      typeof after.savedAt[started.nodeId] === 'number',
      'the new conversation really was saved',
      `${started.nodeId} lines=${after.lines[started.nodeId]}`,
    )
    const lost = before.ids.filter(id => !after.ids.includes(id))
    check(
      lost.length === 0,
      'a save on one node destroyed no other conversation',
      `records ${before.records} -> ${after.records}${lost.length ? `; gone: ${lost.join(',')}` : '; none gone'}`,
    )
    /* AND IT STAYED WRITABLE. A value over the storage's own 64KB bound is
       refused outright, which is the silent way a conversation stops being
       saved at all -- so the size after the save is a finding, not a note. */
    check(
      after.serialized > 0 && after.serialized <= 64 * 1024,
      'the saved record still fits what this computer will store',
      `${after.serialized} characters, limit 65536`,
    )
    const shortened = before.ids.filter(id => after.lines[id] < before.lines[id])
    check(
      shortened.length > 0,
      'the room was made by giving up lines rather than conversations',
      shortened.length
        ? shortened.map(id => `${id} ${before.lines[id]}->${after.lines[id]}`).join(', ')
        : 'nothing was trimmed, so the size cap was never reached and this run proves less than it claims',
    )
    console.log(`      record now ${after.serialized} characters over ${after.records} conversations`)
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* B -- A REFUSED SEND MUST NOT EAT THE CONVERSATION.
 *
 * The owner's screenshot: a panel showing one YOU bubble over a node that had
 * held a real conversation. treeCardSend records the typed line BEFORE the send;
 * the send is refused (this session id belongs to no live session); the recovery
 * is refused too, because starting agents is switched off. The strip that takes
 * the phantom line back used to sit BELOW that refusal. */
async function scenarioB(executable, scratch, appRoot) {
  console.log('\nB. a refused send, over a node with a real saved conversation')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const nodes = [node({ id: 'node-0', sessionId: 'sess-dead', status: 'finished', message: 'Question 0', reply: 'Answer 0' })]
    const lines = [
      { who: 'you', text: 'first ask', at: 1 },
      { who: 'agent', text: 'first answer', at: 2 },
      { who: 'you', text: 'second ask', at: 3 },
      { who: 'agent', text: 'second answer', at: 4 },
      { who: 'you', text: 'third ask', at: 5 },
    ]
    const transcripts = { v: 1, nodes: { 'node-0': { savedAt: 1_700_000_000_000, threadId: 'thread-x', effort: 'medium', trimmed: 0, lines } } }
    const drawn = await seedRecords(window, computerId, { nodes, transcripts })
    if (!drawn.includes('node-0')) { note('FAIL', `the circle never reached the canvas (${drawn.join(',')})`); return }
    /* Starting agents switched OFF, which is what makes the recovery refuse and
       is the branch the strip used to sit below. */
    await window.evaluate("localStorage.setItem('mc.write.agent-session', 'disabled')")
    await window.evaluate('location.reload()')
    await delay(3800)

    const bubble = await press(window, '.node[data-agent-id="node-0"]')
    if (!bubble.pressed) { note('FAIL', `the circle could not be pressed (${bubble.why})`); return }
    const opened = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-0')`), 'the chat before the send'))
    check(
      Boolean(opened) && opened.messages.length >= 5,
      'the saved conversation is all there before the send',
      opened ? `${opened.messages.length} messages` : 'no chat opened',
    )

    const typed = await typeInto(window, '.chat-input input', 'a message that will be refused')
    if (!typed.pressed) { note('FAIL', `the message box could not be pressed (${typed.why})`); return }
    await key(window, 'Enter', 13)
    await delay(2000)

    const now = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-0')`), 'the chat after the refusal'))
    const texts = now ? now.messages.map(m => m.text) : []
    check(
      texts.some(t => t.includes('first ask')) && texts.some(t => t.includes('third ask')),
      'the whole saved conversation is still on the glass after the refusal',
      `${texts.length} rows: ${texts.slice(0, 7).join(' | ')}`,
    )
    const stored = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after the refusal')
    check(
      stored.records === 1 && stored.lines['node-0'] === 5,
      'the refused message was taken back out of the saved record',
      `lines=${stored.lines ? stored.lines['node-0'] : 'none'}`,
    )
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* C -- ONE CONVERSATION, ONE LOOK.
 *
 * Items 2 and 4. Every message in a log must paint by WHO SAID IT and never by
 * which code path delivered it. The measurement is the computed style of each
 * row: a reply classed with the role key had no background, no border, no
 * shadow, align-self auto (the full width of the log) and no sender label,
 * directly beneath a restored bubble carrying all of it. */
async function scenarioC(executable, scratch, appRoot) {
  console.log('\nC. every message painted the same way, whatever delivered it')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const nodes = [node({ id: 'node-0', sessionId: 'sess-paint', status: 'finished', message: 'Question', reply: 'Answer' })]
    const lines = [
      { who: 'you', text: 'restored question', at: 1 },
      { who: 'agent', text: 'restored answer', at: 2 },
    ]
    const transcripts = { v: 1, nodes: { 'node-0': { savedAt: 1_700_000_000_000, threadId: 'thread-p', effort: 'medium', trimmed: 0, lines } } }
    const drawn = await seedRecords(window, computerId, { nodes, transcripts })
    if (!drawn.includes('node-0')) { note('FAIL', `the circle never reached the canvas (${drawn.join(',')})`); return }

    const bubble = await press(window, '.node[data-agent-id="node-0"]')
    if (!bubble.pressed) { note('FAIL', `the circle could not be pressed (${bubble.why})`); return }
    /* A LIVE row, delivered by the send path rather than restored: the send is
       refused, and the refusal comes back through the chat's own handlers --
       the exact path that used to paint with the role key. */
    const typed = await typeInto(window, '.chat-input input', 'a live message')
    if (!typed.pressed) { note('FAIL', `the message box could not be pressed (${typed.why})`); return }
    await key(window, 'Enter', 13)
    await delay(2000)

    const surface = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-0')`), 'the painted chat'))
    if (!surface) { note('FAIL', 'neither chat surface was open to measure'); return }
    const kinds = [...new Set(surface.messages.map(m => m.cls.replace('msg ', '')))]
    check(
      kinds.length > 0 && kinds.every(kind => ['them', 'me', 'note'].includes(kind)),
      'every bubble carries one of the three kinds that have a rule',
      `kinds: ${kinds.join(', ')}`,
    )
    const unstyled = surface.messages.filter(m => m.painted === false)
    check(
      unstyled.length === 0,
      'no message painted as bare text',
      unstyled.length ? unstyled.map(m => `${m.cls}: bg=${m.background} img=${m.backgroundImage} border=${m.borderWidth}`).join('; ') : 'none',
    )
    const fullWidth = surface.messages.filter(m => m.width >= surface.logWidth)
    check(
      fullWidth.length === 0,
      'no message stretched the whole width of the log',
      fullWidth.length ? fullWidth.map(m => `${m.cls}@${m.width}/${surface.logWidth}`).join(', ') : `log ${surface.logWidth}px`,
    )
    const spoken = surface.messages.filter(m => m.cls.includes('them') || m.cls.includes('me'))
    check(
      spoken.length > 0 && spoken.every(m => m.alignSelf !== 'auto'),
      'every spoken bubble takes a side',
      spoken.map(m => `${m.cls.replace('msg ', '')}:${m.alignSelf}`).join(' '),
    )
    check(
      spoken.some(m => m.hasWho),
      'the speakers are named',
      spoken.map(m => `${m.cls.replace('msg ', '')}:${m.hasWho ? m.who : '-'}`).join(' '),
    )
    console.log(`      rows: ${surface.messages.map(m => `${m.cls}[${m.width}px]`).join(' ')}`)
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* D -- A TURN WITH TOOLS IN IT, AND WHAT THE CHAT SHOWS.
 *
 * THE AGENT IS STARTED THE WAY A PERSON STARTS ONE: the dashed circle on the
 * canvas, the compose panel, a tier, a role, a typed brief, and Start. Nothing
 * about the session is seeded, and that is load-bearing rather than tidy -- the
 * renderer deliberately refuses to adopt a session id it finds in storage (a
 * saved session id is a fact about a PROCESS, and re-registering one is how a
 * session killed at the last shutdown comes back as live), so a driver that
 * seeds one gets a tree whose events are correctly ignored and then reports
 * "the chat showed nothing". That is exactly what the first run of this file
 * did, and it would have been a harness fault printed as the defect under
 * measurement.
 *
 * The engine then narrates six actions and two stretches of words. The chat
 * must show the actions where they happened, join each result to its own call
 * rather than appending a second row, and keep them across a close and reopen
 * and across a restart of the whole application. */
async function scenarioD(executable, scratch, appRoot) {
  console.log('\nD. a turn with tools in it, from the wire to the glass and back')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  let computerId = null
  let nodeId = null
  try {
    computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) {
      note('SKIP', `no engine reachable in this staged build (${reachable && reachable.code}); the action stream could not be driven`)
      return
    }

    const started = await startAgentFromCanvas(window, 'Check the tests and read one file.')
    if (!started.ok) { note('FAIL', started.why); return }
    nodeId = started.nodeId
    note('INFO', `pressed ${JSON.stringify(started.label)} on tier ${started.tier}, role ${started.role}; the start drew ${nodeId}`)

    const bubble = await press(window, `.node[data-agent-id="${nodeId}"]`)
    if (!bubble.pressed) { note('FAIL', `the circle could not be pressed (${bubble.why})`); return }
    await delay(1400)

    const surface = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the chat after the turn'))
    if (!surface) { note('FAIL', 'neither chat surface was open to measure'); return }
    check(surface.actions.length > 0, 'the turn put action rows in the chat', `${surface.actions.length} rows`)
    check(
      surface.actions.length === 3,
      'each result joined the row its call opened rather than adding a second',
      `rows: ${surface.actions.map(a => `${a.tool}/${a.detail}/${a.outcome}`).join(' | ')}`,
    )
    check(
      surface.actions.some(a => a.state === 'undone'),
      'the command that failed says so on its own row',
      surface.actions.map(a => `${a.tool}:${a.state}`).join(' '),
    )
    check(
      surface.order.includes('action') && surface.order.includes('msg'),
      'the actions sit in the same log as the words',
      surface.order.join(' '),
    )
    check(
      surface.actions.every(a => a.open === false),
      'every action row is collapsed until it is pressed',
      surface.actions.map(a => String(a.open)).join(','),
    )
    /* A SECOND TURN, SENT FROM THE MESSAGE BOX, AND READ WHILE IT RUNS.
     *
     * The rows above are the FIRST turn's, read after it finished -- so they
     * come back through the saved record, which keeps the command and not the
     * output it printed. Whether a row can be OPENED onto its output is a
     * question about a live row, so a second turn is sent and measured while
     * it is still speaking. Both halves matter and they are different claims. */
    const second = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'do that again')
    if (!second.pressed) { note('FAIL', `the message box could not be pressed (${second.why})`); return }
    await key(window, 'Enter', 13)
    /* READ MID-TURN, AND THE TIMING IS THE MEASUREMENT. The whole narrated turn
       is about a second long; once it ends its rows are filed into the record
       and redrawn from there, and the record keeps the command but not the
       output it printed. So the question "can a row be opened onto what it
       printed" is only answerable while the turn is still speaking. The first
       command's result lands at about 360ms, the whole turn ends near 1020ms,
       and key() already waits 500ms of that -- so this is a small top-up, not a
       fresh budget. An earlier version added 650ms on top and read at 1150ms,
       after the turn had finished and its rows had been redrawn from the
       record, and reported "no action row carries any output". */
    /* Read WELL INSIDE the turn: the first command's result lands about 1.4s
       in and the whole turn ends near 4.1s, so this reads at roughly the
       halfway mark. key() has already waited 500ms of it. */
    await delay(1300)
    await paintedFrame(window)
    await delay(150)
    const mid = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the chat mid-turn'))
    note('INFO', `mid-turn: ${mid ? `${mid.messages.length} messages, ${mid.actions.length} actions, order ${mid.order.join(' ')}` : 'no chat'}`)
    note('INFO', `mid-turn rows: ${mid ? mid.actions.map(a => `[${a.tool}|${a.detail.slice(0, 20)}|body=${JSON.stringify(a.body.slice(0, 24))}]`).join(' ') : ''}`)
    check(
      Boolean(mid) && mid.actions.length > 3,
      'a second turn adds its own rows rather than folding into the first',
      mid ? `${mid.actions.length} rows now` : 'no chat',
    )
    /* THE ROW ITSELF IS THE TARGET, AND THAT IS A MEASUREMENT RATHER THAN A
     * CONVENIENCE.
     *
     * Three attempts, each corrected by what the page answered. Pressing the
     * heading box was refused as "covered by own-ancestor-DETAILS"; so was
     * pressing the command text inside it; and an id stamped onto the element by
     * an earlier evaluate was gone by the time the press ran ("absent"), because
     * the row is repainted as the turn goes on.
     *
     * What those refusals were telling us is a fact about `details`/`summary`:
     * document.elementFromPoint over any part of a collapsed row's heading --
     * including over the text spans inside it -- answers the DETAILS element.
     * The disclosure belongs to the details, a press anywhere on the row reaches
     * it, and that is what a person's click does too. So the row is the target,
     * the harness's own rule is satisfied by the element it really hits, and the
     * position in the log is what names it, because that survives a repaint. */
    /* PRESSED AFTER THE TURN HAS SETTLED. A row appended while the press is
       being aimed scrolls the log under it -- the log is pinned to its bottom --
       and the click then lands on whatever slid into that spot. Measured: the
       press was accepted and nothing opened. The output stays readable after the
       turn because the window keeps it, so waiting costs the measurement
       nothing. */
    await delay(4200)
    const target = readOrThrow(await window.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-rail-chat-host] .chat-action')]
      const at = rows.findIndex(r => (r.querySelector('.chat-action-body')?.textContent || '').trim().length > 0)
      return { at, rows: rows.length }
    })()`), 'the action row to open')
    if (target.at < 0) { note('FAIL', `no action row carries any output to open (${target.rows} rows)`); return }
    const rowSelector = `[data-rail-chat-host] .chat-action:nth-of-type(${target.at + 1})`
    const opened = await press(window, rowSelector)
    if (opened.pressed) {
      const rows = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the opened action row')).actions
      check(
        rows.some(a => a.open === true && a.body.length > 0),
        'a pressed row shows the command and what it printed',
        rows.filter(a => a.open).map(a => `${a.detail} -> ${a.body.slice(0, 40)}`).join(' | ') || 'nothing opened',
      )
      check(
        rows.filter(a => a.body.length === 0).every(a => a.open === false),
        'a row with nothing to show refuses to open onto an empty panel',
        rows.map(a => `${a.body.length}:${a.open}`).join(' '),
      )
    } else {
      note('FAIL', `an action row could not be pressed (${opened.why})`)
    }

    /* IT SURVIVES LEAVING THE PANEL AND COMING BACK. */
    await key(window, 'Escape', 27)
    await press(window, `.node[data-agent-id="${nodeId}"]`)
    const back = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the reopened chat'))
    check(
      Boolean(back) && back.actions.length >= 3 && back.messages.length > 0,
      'closing and reopening the panel kept the words and the work',
      back ? `${back.messages.length} messages, ${back.actions.length} actions` : 'no chat',
    )
    /* AND EVERY ROW LOOKS LIKE EVERY OTHER ROW. A restored action used to lose
       its tool name into the detail, so the same command painted two ways
       depending on which side of a reopen you saw it. */
    check(
      Boolean(back) && back.actions.every(a => a.tool.length > 0),
      'every restored action still names its tool in its own place',
      back ? back.actions.map(a => `${a.tool || '(none)'}/${a.detail.slice(0, 24)}`).join(' | ') : 'no chat',
    )

    const stored = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after the turn')
    check(
      Boolean(stored.kinds && stored.kinds[nodeId] && stored.kinds[nodeId].includes('action')),
      'the actions were written into the saved record',
      stored.kinds ? String(stored.kinds[nodeId]).slice(0, 90) : 'no record',
    )
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
  }

  if (!computerId || !nodeId) return
  /* AND IT SURVIVES A RESTART OF THE WHOLE APPLICATION, which is where the
     saved record has to be the thing carrying it. */
  const again = await openWindow(executable, profile)
  try {
    await computerOnScreen(again)
    await delay(1500)
    const pressed = await press(again, `.node[data-agent-id="${nodeId}"]`)
    if (!pressed.pressed) { note('FAIL', `the circle could not be pressed after the restart (${pressed.why})`); return }
    const kept = surfaceOf(readOrThrow(await again.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the chat after the restart'))
    check(
      Boolean(kept) && kept.actions.length > 0 && kept.messages.length > 0,
      'the app was restarted and the conversation still shows the work',
      kept ? `${kept.messages.length} messages, ${kept.actions.length} actions: ${kept.actions.map(a => a.detail).join(' | ').slice(0, 90)}` : 'no chat',
    )
  } finally {
    await closeWindow(again)
    reap(again.timeline.pid)
    assertIsolated(profile)
  }
}

/* ------------------------------------------------ the tree-switch pair -- */

/* TWO TREES IN ONE RECORD, each with its own root. The tree switcher only
   exists on a computer holding two or more, so this is the record that makes
   the gesture under measurement reachable at all. */
function twoTreeRecord(computerId, first, second) {
  const stamp = new Date().toISOString()
  const asNode = (held, treeId) => ({
    id: held.id, treeId, parentId: null, role: 'coordinator',
    message: held.message, status: held.status, statusNote: '',
    reply: held.reply || '', tier: held.tier || 'luna', sessionId: held.sessionId,
    createdAt: stamp, updatedAt: stamp,
  })
  return {
    version: 1,
    computerId,
    trees: [
      { id: 'tree-1', name: 'Alpha', createdAt: stamp, updatedAt: stamp, profileId: null },
      { id: 'tree-2', name: 'Beta', createdAt: stamp, updatedAt: stamp, profileId: null },
    ],
    nodes: [asNode(first, 'tree-1'), asNode(second, 'tree-2')],
  }
}

async function seedTwoTrees(window, computerId, { first, second, transcripts }) {
  const wroteTrees = await setItem(window, treesKey(computerId), twoTreeRecord(computerId, first, second))
  const wroteStore = await setItem(window, storeKey(computerId), transcripts)
  if (!wroteTrees.ok) throw new Error(`the tree record could not be seeded: ${wroteTrees.why}`)
  if (!wroteStore.ok) throw new Error(`the conversation record could not be seeded: ${wroteStore.why}`)
  await window.evaluate('location.reload()')
  await delay(4200)
}

const READ_TREE_SWITCH = `(() => {
  const buttons = [...document.querySelectorAll('.graph-tree-switch button')]
  return {
    buttons: buttons.map(b => ({ text: (b.textContent || '').trim(), on: b.classList.contains('on') })),
    circles: [...document.querySelectorAll('.node[data-agent-id]')].filter(n => !n.hidden).map(n => n.dataset.agentId),
  }
})()`

/* Press the tree button by its LABEL, read off the switcher rather than assumed:
   the label is derived (name, else the first message, else "Tree N"). */
async function pressTree(window, label) {
  const found = readOrThrow(await window.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.graph-tree-switch button')]
    const at = buttons.findIndex(b => (b.textContent || '').trim() === ${JSON.stringify(label)})
    return { at, labels: buttons.map(b => (b.textContent || '').trim()) }
  })()`), 'the tree switcher')
  if (found.at < 0) return { pressed: false, why: `no tree button reads ${JSON.stringify(label)}; offered ${found.labels.join(' | ')}` }
  const pressed = await press(window, `.graph-tree-switch button:nth-of-type(${found.at + 1})`)
  await delay(900)
  return pressed
}

/* E -- SWITCH TREES AND COME BACK, WITH A SAVED CONVERSATION OPEN.
 *
 * Owner item 6 named the tree-switch transition as one of the suspected ways a
 * conversation was lost. Two trees, one with a six-line saved conversation, one
 * with two lines. Open the first, switch away, open the other, switch back,
 * reopen: every line must still be there and the record untouched. */
async function scenarioE(executable, scratch, appRoot) {
  console.log('\nE. switch trees and come back, with a saved conversation open')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const alphaLines = [
      { who: 'you', text: 'alpha ask one', at: 1 }, { who: 'agent', text: 'alpha answer one', at: 2 },
      { who: 'you', text: 'alpha ask two', at: 3 }, { who: 'agent', text: 'alpha answer two', at: 4 },
      { who: 'you', text: 'alpha ask three', at: 5 }, { who: 'agent', text: 'alpha answer three', at: 6 },
    ]
    const betaLines = [{ who: 'you', text: 'beta ask', at: 1 }, { who: 'agent', text: 'beta answer', at: 2 }]
    await seedTwoTrees(window, computerId, {
      first: node({ id: 'node-a', sessionId: 'sess-a', status: 'finished', message: 'alpha ask one', reply: 'alpha answer three' }),
      second: node({ id: 'node-b', sessionId: 'sess-b', status: 'finished', message: 'beta ask', reply: 'beta answer' }),
      transcripts: { v: 1, nodes: {
        'node-a': { savedAt: 1_700_000_000_000, threadId: 'thread-a', effort: 'medium', trimmed: 0, lines: alphaLines },
        'node-b': { savedAt: 1_700_000_000_001, threadId: 'thread-b', effort: 'medium', trimmed: 0, lines: betaLines },
      } },
    })
    const start = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'the tree switcher')
    check(start.buttons.length === 3, 'two trees put a switcher on the page', `buttons: ${start.buttons.map(b => b.text).join(' | ')}; circles ${start.circles.join(',')}`)
    if (start.buttons.length !== 3) return
    const before = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record before')

    /* Alpha first, chat open. */
    const alpha = await pressTree(window, 'Alpha')
    if (!alpha.pressed) { note('FAIL', `Alpha could not be pressed (${alpha.why})`); return }
    let seen = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'after Alpha')
    check(seen.circles.includes('node-a') && !seen.circles.includes('node-b'), 'Alpha shows its own node and not Beta', seen.circles.join(','))
    let bubble = await press(window, '.node[data-agent-id="node-a"]')
    if (!bubble.pressed) { note('FAIL', `node-a could not be pressed (${bubble.why})`); return }
    let chat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-a')`), 'alpha chat'))
    check(Boolean(chat) && chat.messages.length === 6, 'the six-line conversation opens whole', chat ? `${chat.messages.length}: ${chat.messages.map(m => m.text).join(' | ')}` : 'no chat')

    /* Away to Beta, with Alpha's chat still mounted in the rail. */
    const beta = await pressTree(window, 'Beta')
    if (!beta.pressed) { note('FAIL', `Beta could not be pressed (${beta.why})`); return }
    seen = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'after Beta')
    check(seen.circles.includes('node-b') && !seen.circles.includes('node-a'), 'Beta shows its own node and not Alpha', seen.circles.join(','))
    const railAfterSwitch = readOrThrow(await window.evaluate(`(() => {
      const host = document.querySelector('[data-rail-chat-host] .chat')
      return { railChat: Boolean(host), messages: host ? host.querySelectorAll('.msg').length : 0, railOpen: Boolean(document.querySelector('.ctl-page.is-active')) }
    })()`), 'the rail after the switch')
    note('INFO', `after switching away the rail ${railAfterSwitch.railChat ? `still shows a chat with ${railAfterSwitch.messages} messages` : 'shows no chat'} (rail open: ${railAfterSwitch.railOpen})`)
    bubble = await press(window, '.node[data-agent-id="node-b"]')
    if (!bubble.pressed) { note('FAIL', `node-b could not be pressed (${bubble.why})`); return }
    chat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-b')`), 'beta chat'))
    check(Boolean(chat) && chat.messages.length === 2 && chat.messages.every(m => m.text.startsWith('beta')), 'Beta opens its own two lines and none of Alpha', chat ? chat.messages.map(m => m.text).join(' | ') : 'no chat')

    /* Back to Alpha, reopen. */
    const back = await pressTree(window, 'Alpha')
    if (!back.pressed) { note('FAIL', `Alpha could not be pressed again (${back.why})`); return }
    bubble = await press(window, '.node[data-agent-id="node-a"]')
    if (!bubble.pressed) { note('FAIL', `node-a could not be pressed after the round trip (${bubble.why})`); return }
    chat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-a')`), 'alpha chat again'))
    const texts = chat ? chat.messages.map(m => m.text) : []
    check(
      texts.length === 6 && alphaLines.every((line, i) => texts[i] === line.text),
      'after switching away and back, all six lines are there in order',
      texts.join(' | ') || 'no chat',
    )
    /* And "Every tree" -- both visible, Alpha still whole. */
    const every = await pressTree(window, 'Every tree')
    if (every.pressed) {
      seen = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'after Every tree')
      check(seen.circles.includes('node-a') && seen.circles.includes('node-b'), '"Every tree" shows both', seen.circles.join(','))
      bubble = await press(window, '.node[data-agent-id="node-a"]')
      chat = bubble.pressed ? surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-a')`), 'alpha under every tree')) : null
      check(Boolean(chat) && chat.messages.length === 6, 'Alpha is whole under "Every tree" too', chat ? `${chat.messages.length} lines` : 'no chat')
    }
    const after = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after')
    check(
      after.records === 2 && after.lines['node-a'] === 6 && after.lines['node-b'] === 2
        && after.savedAt['node-a'] === before.savedAt['node-a'] && after.savedAt['node-b'] === before.savedAt['node-b'],
      'the record is untouched by any of it',
      `records=${after.records}, lines a=${after.lines['node-a']} b=${after.lines['node-b']}, savedAt unchanged=${after.savedAt['node-a'] === before.savedAt['node-a']}`,
    )
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* F -- SWITCH TREES WHILE A TURN IS STREAMING, THEN BACK.
 *
 * The live accumulator belongs to a session, and the session to a node; a tree
 * switch mid-turn changes what is on the canvas and may rebuild the rail onto a
 * different node's chat. The words must land under the node that spoke them and
 * nowhere else, and be there when that node's chat is reopened. */
async function scenarioF(executable, scratch, appRoot) {
  console.log('\nF. switch trees while a turn is streaming, then back')
  const profile = freshProfile(scratch)
  seedMachineRecord(profile, appRoot)
  const window = await openWindow(executable, profile)
  try {
    const computerId = await computerOnScreen(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }
    const reachable = readOrThrow(
      await window.evaluate('(async () => { try { return await window.mcAgent.availability() } catch (error) { return { ok: false, code: String(error && error.message) } } })()'),
      'the agent availability probe',
    )
    if (!reachable || reachable.ok !== true) { note('SKIP', `no engine reachable (${reachable && reachable.code})`); return }

    /* One seeded tree, Beta, with a saved two-line conversation on its node. The
       streaming agent is started in a NEW tree from the new-tree slot, so the
       switch really crosses trees. */
    const betaLines = [{ who: 'you', text: 'beta ask', at: 1 }, { who: 'agent', text: 'beta answer', at: 2 }]
    const drawn = await seedRecords(window, computerId, {
      nodes: [node({ id: 'node-b', sessionId: 'sess-b', status: 'finished', message: 'beta ask', reply: 'beta answer' })],
      transcripts: { v: 1, nodes: { 'node-b': { savedAt: 1_700_000_000_001, threadId: 'thread-b', effort: 'medium', trimmed: 0, lines: betaLines } } },
    })
    if (!drawn.includes('node-b')) { note('FAIL', `Beta never reached the canvas (${drawn.join(',')})`); return }
    const treesBefore = readOrThrow(await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"), 'the canvas')

    /* Start in a NEW tree from the new-tree slot, so the switch really crosses
       trees, and let that first turn finish. The streaming turn under
       measurement is a SECOND one, sent from the message box, because that
       gives an exact moment the words start arriving: the switch below lands
       about a second and a half into a four-second turn. */
    const started = await startAgentFromCanvas(window, 'Check the tests and read one file.')
    if (!started.ok) { note('FAIL', started.why); return }
    const nodeX = started.nodeId
    const sw = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'the switcher after start')
    note('INFO', `started ${nodeX} in a new tree; switcher: ${sw.buttons.map(b => b.text).join(' | ')}`)
    const betaLabel = sw.buttons.map(b => b.text).find(text => text !== 'Every tree' && !/Check the tests/.test(text)) || null
    const newLabel = sw.buttons.map(b => b.text).find(text => /Check the tests/.test(text)) || null
    if (!betaLabel || !newLabel) { note('FAIL', `could not tell the trees apart: ${sw.buttons.map(b => b.text).join(' | ')}`); return }
    const firstTurn = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after the first turn')
    const linesAfterFirst = firstTurn.lines ? firstTurn.lines[nodeX] : 0
    note('INFO', `after the first turn ${nodeX} has ${linesAfterFirst} saved lines (${firstTurn.kinds ? firstTurn.kinds[nodeX] : ''})`)

    const bx0 = await press(window, `.node[data-agent-id="${nodeX}"]`)
    if (!bx0.pressed) { note('FAIL', `${nodeX} could not be pressed (${bx0.why})`); return }
    const typed = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'do that again')
    if (!typed.pressed) { note('FAIL', `the message box could not be pressed (${typed.why})`); return }
    const startedAt = Date.now()
    await key(window, 'Enter', 13)

    /* SWITCH AWAY MID-TURN, and open the other node's chat while it streams. */
    const away = await pressTree(window, betaLabel)
    note('INFO', `switched to ${JSON.stringify(betaLabel)} at +${Date.now() - startedAt}ms (${away.pressed ? 'pressed' : away.why})`)
    if (!away.pressed) return
    let seen = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'after the switch')
    check(seen.circles.includes('node-b') && !seen.circles.includes(nodeX), 'the streaming node left the canvas with its tree', seen.circles.join(','))
    /* PROOF THE TURN WAS STILL IN FLIGHT when the switch landed: the record
       cannot yet hold the second turn's answer, because that is filed only on
       completion. Without this line "mid-turn" would be a claim about timing
       rather than an observation. */
    const inFlight = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record at the switch')
    const linesAtSwitch = inFlight.lines ? inFlight.lines[nodeX] : 0
    check(
      linesAtSwitch === linesAfterFirst + 1,
      'the switch landed while the second turn was still speaking',
      `+${Date.now() - startedAt}ms after Enter: ${nodeX} has ${linesAtSwitch} saved lines (was ${linesAfterFirst}; the typed line is filed at once, the answer only on completion)`,
    )
    const bb = await press(window, '.node[data-agent-id="node-b"]')
    if (!bb.pressed) { note('FAIL', `node-b could not be pressed (${bb.why})`); return }
    await paintedFrame(window)
    let betaChat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-b')`), 'beta chat mid-turn'))
    note('INFO', `Beta chat opened at +${Date.now() - startedAt}ms: ${betaChat ? `${betaChat.messages.length} messages, ${betaChat.actions.length} actions` : 'no chat'}`)
    check(
      Boolean(betaChat) && betaChat.messages.length === 2 && betaChat.actions.length === 0
        && betaChat.messages.every(m => m.text.startsWith('beta')),
      "the other node's chat carries none of the streaming turn",
      betaChat ? `${betaChat.messages.map(m => m.text).join(' | ')}; ${betaChat.actions.length} actions` : 'no chat',
    )
    /* Let the turn finish while we are away. */
    await delay(Math.max(0, 6500 - (Date.now() - startedAt)))
    betaChat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})('node-b')`), 'beta chat after the turn'))
    check(
      Boolean(betaChat) && betaChat.messages.length === 2 && betaChat.actions.length === 0,
      "after the turn ended away from its tree, the other node's chat is still only its own",
      betaChat ? `${betaChat.messages.length} messages, ${betaChat.actions.length} actions` : 'no chat',
    )
    const stored = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after the turn')
    check(
      Boolean(stored.kinds && stored.kinds[nodeX]) && /agent/.test(stored.kinds[nodeX]) && /action/.test(stored.kinds[nodeX]),
      "the turn's words and work were filed under the node that spoke them",
      stored.kinds ? `${nodeX}: ${stored.kinds[nodeX]}` : 'no record',
    )
    check(
      Boolean(stored.lines) && stored.lines['node-b'] === 2,
      "and nothing landed under the other node's record",
      stored.lines ? `node-b lines=${stored.lines['node-b']}` : 'no record',
    )

    /* BACK, and reopen the node that spoke. */
    const home = await pressTree(window, newLabel)
    if (!home.pressed) { note('FAIL', `could not switch back (${home.why})`); return }
    seen = readOrThrow(await window.evaluate(READ_TREE_SWITCH), 'after switching back')
    check(seen.circles.includes(nodeX), 'the streaming node is back on the canvas with its tree', seen.circles.join(','))
    const bx = await press(window, `.node[data-agent-id="${nodeX}"]`)
    if (!bx.pressed) { note('FAIL', `${nodeX} could not be pressed (${bx.why})`); return }
    await paintedFrame(window)
    const xChat = surfaceOf(readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeX)})`), 'the streaming node chat'))
    const said = xChat ? xChat.messages.map(m => m.text) : []
    check(
      Boolean(xChat) && said.filter(t => /suite is green/.test(t)).length === 2 && said.some(t => t === 'do that again') && xChat.actions.length === 6,
      "the node that spoke shows both turns' answers and work after the round trip",
      xChat ? `${xChat.messages.length} messages, ${xChat.actions.length} actions; ${said.map(t => t.slice(0, 28)).join(' | ')}` : 'no chat',
    )
    check(
      Boolean(xChat) && !said.some(t => /beta/.test(t)),
      "and none of the other node's lines",
      said.filter(t => /beta/.test(t)).join(' | ') || 'none',
    )
    const finalStore = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record at the end')
    note('INFO', `records: ${finalStore.ids.map(id => `${id}=${finalStore.kinds[id]}`).join(' ; ')}`)
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* ----------------------------------------------------------------- main -- */

/* --only=E,F runs a subset; the letters are the scenario names. */
function pickScenarios(all) {
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7)
  if (!only) return all
  const wanted = new Set(only.split(',').map(s => s.trim().toUpperCase()))
  return all.filter(fn => wanted.has(fn.name.replace('scenario', '').toUpperCase()))
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'chat-history-drive-'))
  console.log(`scratch: ${scratch}`)
  /* THE ENGINE THIS RUN NARRATES WITH, set before any window is opened so the
     harness carries it into every child environment. */
  process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged: ${executable}`)
    for (const scenario of pickScenarios([scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF])) {
      try {
        await scenario(executable, scratch, appRoot)
      } catch (error) {
        note('FAIL', `${scenario.name} threw: ${String(error && error.message).slice(0, 240)}`)
      }
    }
  } finally {
    const passed = findings.filter(f => f.level === 'PASS').length
    const failed = findings.filter(f => f.level === 'FAIL').length
    const skipped = findings.filter(f => f.level === 'SKIP').length
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
    if (!KEEP) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* held open by a dead child */ } }
    else console.log(`kept: ${scratch}`)
  }
}

await main()
