#!/usr/bin/env node

/* THE STANDING-REQUEST CONTRACT, DRIVEN ON A STAGED PACKAGED BUILD.
 *
 * The owner's directive, and nothing weaker: type a real /RequestThread into a
 * real agent's chat; see the product's one-sentence confirmation on the glass;
 * find the words VERBATIM in the ledger file; RESTART the app; prove the new
 * session's brief carries the rule (mechanically, in the engine's own session
 * rollout) and observe whether a real model obeys it — the two facts reported
 * separately, because brief carriage is the product's proof and obedience is
 * the model's. Then "Ok use ToolsEnabled and store the value 742 in memory
 * under key contract-check, then read it back" — the spoken convention the
 * setup card teaches. Then scope isolation: a session rule filed in session A
 * must NOT reach session B's brief on another tree. Then the ceiling: an
 * absurd global ledger cannot brick a start, and the trimmed block announces
 * itself.
 *
 * IT SPENDS REAL MONEY on this computer's own Codex subscription, so it is a
 * tool and never a default test target.
 *
 * THE SIGN-IN IS POINTED AT, NEVER COPIED — the junction technique
 * tools/agent-to-agent-tree-drive.mjs documents. Everything else lives in a
 * scratch profile this run deletes; every ledger this run writes lands under
 * that scratch state root and never in anyone's real state.
 *
 *   node tools/request-contract-drive.mjs
 *   node tools/request-contract-drive.mjs --visible
 *   node tools/request-contract-drive.mjs --keep      leave the scratch directory
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  scratchDirectory,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { CHAT_COMPOSER_INPUT_SELECTOR, createChatPresser } from './lib/chat-drive-lib.mjs'

const KEEP = process.argv.includes('--keep')
/* Resume phases 5-6 on a kept scratch (--keep from an earlier run), so a
   harness fix in the later phases does not re-spend the earlier phases' real
   model turns: node A, its ledgers and its rollouts are already there. */
const FROM_5_AT = process.argv.indexOf('--from-5')
const RESUME_SCRATCH = FROM_5_AT >= 0 ? process.argv[FROM_5_AT + 1] : null
const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* The words this run types. The THREAD RULE is the owner's own example. The
   markers exist so a rollout can be attributed to its session mechanically —
   none of them appears in any other session's typed input, so finding one in
   the wrong file can only mean the product leaked it. */
const THREAD_RULE = 'Always answer in one sentence.'
const SESSION_RULE = 'Prefer the word amethyst when you need an example word. SESSION-A-MARKER.'
const BRIEF_A = 'Say the single word ready and stop. Do nothing else.'
const BRIEF_B = 'Say the single word blue and stop. MARKER-B-SESSION. Do nothing else.'
const BRIEF_C = 'Say the single word green and stop. MARKER-C-SESSION. Do nothing else.'
const MEMORY_ASK = 'Ok use ToolsEnabled and store the value 742 in memory under key contract-check, then read it back and tell me what you read.'

/* ------------------------------------------------------------- CDP hands --
 *
 * B-POOL-6 MIGRATION (API decision doc §6, typeReal family, step 1 of 2):
 * the dispatch mechanism now lives in tools/lib/chat-drive-lib.mjs. This
 * file's OWN verification policy in typeReal (below) is kept local and
 * unchanged -- it checks whether the landed value includes the first 24
 * characters of what was typed, looser than chat-drive-lib's own
 * typeAndVerify (exact match), and that looseness is this file's
 * deliberate choice for its own long, punctuation-bearing briefs, not a
 * default this migration should silently tighten for every future caller.
 *
 * THREE TIMING VALUES DIFFERED FROM THE SHARED MODULE'S, NAMED RATHER THAN
 * SILENTLY CHANGED. press()'s trailing settle was 350ms here; the module's
 * is 520ms (chat-history-drive.mjs's own proven value) -- an INCREASE,
 * which only adds margin and is safe by construction. key()'s 500ms
 * already matches the module exactly. typeReal()'s post-insertText settle
 * was 250ms here; the module's typeInto() gives 180ms -- a DECREASE, which
 * is the unsafe direction (shortening a wait nothing has since re-proven
 * adequate), so a 70ms top-up below restores the exact original total
 * rather than accepting a smaller one on the strength of a different
 * file's history. Same one named reachability change as every earlier
 * step: FLEET_NODE_VISIBLE's ancestor-opacity walk over this harness's own
 * window.waitForVisible/VISIBLE_FN. */
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

async function key(window, name, _keyCode) {
  await presserFor(window).key(name)
}

async function typeReal(window, selector, text) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await presserFor(window).typeInto(text)
  await delay(70) // top-up to this file's own proven 250ms total (module gives 180ms) -- see the note above
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  return { ok: typeof landed === 'string' && landed.includes(text.slice(0, 24)), landed }
}

/* A native select moves under the arrows only once its own popup is dismissed
   — the correction tools/claude-tree-start-proof.mjs measured. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  for (let index = 0; index < maxPresses; index += 1) {
    const value = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
    if (value === wanted) return { ok: true }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${wanted}` }
}

async function startNode(window, { doorway = '.tree-chat-add', role, message, tier = 'luna' }) {
  const opened = await press(window, doorway)
  if (!opened.pressed) return { ok: false, why: `could not open the panel: ${opened.why}` }
  if (doorway === '.tree-chat-add') {
    const choice = await press(window, '.tree-new-tree')
    if (!choice.pressed) return { ok: false, why: `could not choose New tree: ${choice.why}` }
  }
  await delay(1800)
  const chosenTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', tier)
  if (!chosenTier.ok) return { ok: false, why: `tier: ${chosenTier.why}` }
  const chosenRole = await chooseByKeyboard(window, '[data-compose-field="role"]', role)
  if (!chosenRole.ok) return { ok: false, why: `role: ${chosenRole.why}` }
  const typed = await typeReal(window, '[data-compose-field="message"]', message)
  if (!typed.ok) return { ok: false, why: `message: ${typed.why}` }
  const start = await window.evaluate(`(() => {
    const visible = node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
    const button = [...document.querySelectorAll('button')].filter(visible).find(node => /^start/i.test(node.textContent.trim()))
    if (!button) return null
    if (!button.id) button.id = 'drive-start-target'
    return '#' + button.id
  })()`)
  if (!start) return { ok: false, why: 'there is no Start control on the panel' }
  const pressed = await press(window, start)
  return pressed.pressed ? { ok: true } : { ok: false, why: `Start: ${pressed.why}` }
}

/* ------------------------------------------------------- mechanical reads -- */

async function computersPage(window) {
  await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
  await window.evaluate(`location.hash = '#/computers'`)
  await delay(1000)
  await window.evaluate('location.reload()')
  await delay(3800)
  return window.evaluate('window.__mcGraph?.computer?.id || null')
}

/* The durable records the page itself writes, read back through localStorage:
   the tree (node ids, session ids) and the conversations (who said what). */
async function treeRecordOf(window, computerId) {
  const raw = await window.evaluate(`localStorage.getItem(${JSON.stringify(`mc.fleet.trees.v1:${computerId}`)})`)
  try { return JSON.parse(raw) || null } catch { return null }
}

async function transcriptsOf(window, computerId) {
  const raw = await window.evaluate(`localStorage.getItem(${JSON.stringify(`mc.fleet.transcripts.v1:${computerId}`)})`)
  try { return JSON.parse(raw) || null } catch { return null }
}

function agentLinesOf(transcripts, nodeId) {
  const lines = transcripts?.nodes?.[nodeId]?.lines
  return Array.isArray(lines) ? lines.filter(line => line && line.who === 'agent').map(line => String(line.text || '')) : []
}

async function until(fn, { timeoutMs = 120_000, everyMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return null
    await delay(everyMs)
  }
}

/* What is on the open chat surfaces: message bubbles by kind, action rows. */
const READ_CHAT = `(() => {
  const surfaces = [...document.querySelectorAll('.chat')]
  const messages = surfaces.flatMap(chat => [...chat.querySelectorAll('.msg')].map(m => ({
    kind: (m.className || '').replace('msg', '').trim(),
    text: (m.innerText || '').trim(),
  })))
  const actions = surfaces.flatMap(chat => [...chat.querySelectorAll('.chat-action')].map(a => (a.innerText || '').trim()))
  return { surfaces: surfaces.length, messages, actions }
})()`

/* Every scratch file that carries a given text, so a brief's arrival in the
   ENGINE's own session rollout is a fact about bytes on disk rather than a
   claim. Junctions are never followed: the .codex and npm junctions point at
   this computer's real directories, and a scan that walked through them would
   be reading real state from a run that promised not to. */
export const SCAN_INDETERMINATE = 'REQUEST_CONTRACT_SCAN_INDETERMINATE'

function scanIndeterminate(error, root) {
  const failure = new Error(`Could not scan ${root}; this does NOT claim the requested files are absent.`, { cause: error })
  failure.code = SCAN_INDETERMINATE
  return failure
}

export function filesCarrying(root, needle, {
  excludeDirs = new Set(['node_modules']),
  out = [],
  readDirectory = readdirSync,
} = {}) {
  let entries = []
  try {
    entries = readDirectory(root, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return out
    throw scanIndeterminate(error, root)
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) filesCarrying(full, needle, { excludeDirs, out, readDirectory })
      continue
    }
    if (!entry.isFile()) continue
    let size = 0
    try { size = statSync(full).size } catch { continue }
    if (size === 0 || size > 12 * 1024 * 1024) continue
    if (!/\.(jsonl|json|md|txt|log)$/i.test(entry.name)) continue
    try {
      if (readFileSync(full, 'utf8').includes(needle)) out.push(full)
    } catch { /* unreadable is not evidence either way */ }
  }
  return out
}

const stateRootOf = profile => path.join(profile, 'userdata', 'capability')

/* ---------------------------------------------------------------- the run -- */

async function main() {
  const scratch = RESUME_SCRATCH || scratchDirectory('request-contract-')
  let window = null
  let pid = null
  try {
    let staged
    if (RESUME_SCRATCH) {
      const appRoot = path.join(scratch, 'app')
      const launcher = readdirSync(appRoot).filter(entry => entry.toLowerCase().endsWith('.exe'))
        .find(entry => !/^(elevate|squirrel|crashpad)/i.test(entry))
      if (!launcher) { note('FAIL', `no launcher in ${appRoot}; --from-5 needs a scratch a full run kept`); return }
      staged = { executable: path.join(appRoot, launcher), appRoot }
      note('info', `resuming phases 5-6 on the kept scratch at ${scratch}`)
    } else {
      staged = await stage(scratch)
      note('info', `staged a packaged build carrying this tree at ${staged.appRoot}`)

      const realCodex = path.join(process.env.USERPROFILE || '', '.codex')
      if (!existsSync(path.join(realCodex, 'auth.json'))) {
        note('FAIL', 'HARNESS STATE: this computer has no Codex sign-in to point the scratch profile at; nothing below would measure a real agent.')
        return
      }
      mkdirSync(path.join(scratch, 'home'), { recursive: true })
      try { symlinkSync(realCodex, path.join(scratch, 'home', '.codex'), 'junction') } catch { /* pointed */ }
      const realNpm = path.join(process.env.APPDATA || '', 'npm')
      if (existsSync(realNpm)) {
        mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
        try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* pointed */ }
      }
      note('info', 'the scratch profile POINTS at this computer\'s Codex sign-in; no credential is read or copied by this file.')

      seedMachineRecord(scratch, staged.appRoot, 'standard')
    }
    window = await openWindow(staged.executable, scratch)
    pid = window.timeline.pid
    const computerId = await computersPage(window)
    if (!computerId) { note('FAIL', 'the computers page never named a computer'); return }

    let nodeA = null
    if (RESUME_SCRATCH) {
      const record = await treeRecordOf(window, computerId)
      const first = (record?.nodes || []).slice()
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0]
      if (!first) { note('FAIL', 'the kept scratch holds no node A to resume from'); return }
      nodeA = { id: first.id, sessionId: first.sessionId || null }
      note('info', `node A recovered as ${nodeA.id}`)
    } else {

    console.log('\n[1] a real agent, started by hand')
    const started = await startNode(window, { role: 'default', message: BRIEF_A })
    note(started.ok ? 'ok' : 'FAIL', started.ok ? 'node A started' : `node A could not start: ${started.why}`)
    if (!started.ok) return

    nodeA = await until(async () => {
      const record = await treeRecordOf(window, computerId)
      const node = record?.nodes?.find(entry => entry.sessionId)
      return node && node.id ? { id: node.id, sessionId: node.sessionId } : null
    }, { timeoutMs: 60_000 })
    if (!nodeA) { note('FAIL', 'node A never recorded a session id'); return }
    note('info', `node A is ${nodeA.id}, session ${nodeA.sessionId}`)

    const firstReply = await until(async () => {
      const lines = agentLinesOf(await transcriptsOf(window, computerId), nodeA.id)
      return lines.length > 0 ? lines[lines.length - 1] : null
    }, { timeoutMs: 180_000 })
    note(firstReply ? 'ok' : 'FAIL', firstReply ? `node A answered its brief: ${JSON.stringify(firstReply.slice(0, 60))}` : 'node A never answered its brief')
    if (!firstReply) return

    console.log('\n[2] "/RequestThread ..." typed into the chat, for real')
    const opened = await press(window, `.node[data-agent-id="${nodeA.id}"]`)
    if (!opened.pressed) { note('FAIL', `node A's chat could not be opened: ${opened.why}`); return }
    const typedThread = await typeReal(window, CHAT_COMPOSER_INPUT_SELECTOR, `/RequestThread ${THREAD_RULE}`)
    if (!typedThread.ok) { note('FAIL', `the chat box could not be typed into: ${typedThread.why}`); return }
    await key(window, 'Enter', 13)

    const confirmation = await until(async () => {
      const chat = await window.evaluate(READ_CHAT)
      return chat.messages.find(m => /Filed RTH1/.test(m.text)) || null
    }, { timeoutMs: 20_000, everyMs: 1500 })
    note(confirmation ? 'ok' : 'FAIL', confirmation
      ? `the glass confirmed in one sentence: ${JSON.stringify(confirmation.text.slice(0, 140))}`
      : 'no confirmation sentence appeared for /RequestThread')
    if (confirmation && !/this conversation/.test(confirmation.text)) {
      note('FAIL', 'the confirmation does not state the THREAD scope honestly')
    }

    const threadLedger = path.join(stateRootOf(scratch), 'state', 'r-ledger', `thread-${nodeA.id}.md`)
    const ledgerHolds = existsSync(threadLedger) && readFileSync(threadLedger, 'utf8').includes(THREAD_RULE)
    note(ledgerHolds ? 'ok' : 'FAIL', ledgerHolds
      ? `the words are VERBATIM in the ledger the person can edit: ${threadLedger}`
      : `the thread ledger is missing or does not hold the words (${threadLedger})`)
    if (!ledgerHolds) return

    console.log('\n[3] a session rule too, then the spoken convention')
    const typedSession = await typeReal(window, CHAT_COMPOSER_INPUT_SELECTOR, `/RequestSession ${SESSION_RULE}`)
    if (typedSession.ok) await key(window, 'Enter', 13)
    const sessionConfirmed = await until(async () => {
      const chat = await window.evaluate(READ_CHAT)
      return chat.messages.find(m => /Filed RS1/.test(m.text)) || null
    }, { timeoutMs: 20_000, everyMs: 1500 })
    const sessionLedger = path.join(stateRootOf(scratch), 'state', 'r-ledger', `session-${nodeA.sessionId}.md`)
    const sessionHolds = existsSync(sessionLedger) && readFileSync(sessionLedger, 'utf8').includes('SESSION-A-MARKER')
    note(sessionConfirmed && sessionHolds ? 'ok' : 'FAIL',
      sessionConfirmed && sessionHolds
        ? `RS1 filed under the REAL session id and confirmed on the glass (${path.basename(sessionLedger)})`
        : `the session rule leg failed (confirmed=${Boolean(sessionConfirmed)}, file=${sessionHolds})`)

    const typedMemory = await typeReal(window, CHAT_COMPOSER_INPUT_SELECTOR, MEMORY_ASK)
    if (!typedMemory.ok) { note('FAIL', `the memory ask could not be typed: ${typedMemory.why}`); return }
    await key(window, 'Enter', 13)
    const memoryReply = await until(async () => {
      const lines = agentLinesOf(await transcriptsOf(window, computerId), nodeA.id)
      const latest = lines[lines.length - 1] || ''
      return lines.length >= 2 && latest !== firstReply ? latest : null
    }, { timeoutMs: 240_000 })
    const rolloutsWithKey = filesCarrying(scratch, 'contract-check')
      .filter(file => !file.includes(path.join('state', 'r-ledger')))
    const reachedForMemory = rolloutsWithKey.some(file => {
      const text = readFileSync(file, 'utf8')
      return /memory[._-]set/i.test(text) || /"memory"/.test(text)
    })
    const readBack = Boolean(memoryReply && memoryReply.includes('742'))
    note(reachedForMemory ? 'ok' : 'warn', reachedForMemory
      ? `the agent REACHED FOR the memory tools on "use ToolsEnabled" (${rolloutsWithKey.length} rollout file(s) carry the call)`
      : 'no memory tool call found in the session rollout — the model did not reach for the toolkit')
    note(readBack ? 'ok' : 'warn', readBack
      ? `and read the value back: ${JSON.stringify((memoryReply || '').slice(0, 80))}`
      : `the reply did not read 742 back: ${JSON.stringify((memoryReply || '').slice(0, 120))}`)

    console.log('\n[4] RESTART the app; the resumed conversation must carry the rule')
    /* Every sentence the agent said in THIS boot, by TEXT. A resume restores
       the saved conversation into the transcript, so counting lines mistakes a
       restored boot-1 reply for the answer to the question typed after the
       restart — the first run of this driver did exactly that and read
       "I read back 742" as the obedience answer. Only a text this boot never
       produced can be the new reply. */
    const bootOneLines = new Set(agentLinesOf(await transcriptsOf(window, computerId), nodeA.id))
    await closeWindow(window)
    reap(pid)
    window = null
    await delay(2500)

    window = await openWindow(staged.executable, scratch)
    pid = window.timeline.pid
    const computerId2 = await computersPage(window)
    if (computerId2 !== computerId) note('warn', `the computer id changed across the restart (${computerId} -> ${computerId2})`)
    const reopened = await press(window, `.node[data-agent-id="${nodeA.id}"]`)
    if (!reopened.pressed) { note('FAIL', `after restart, node A's chat could not be opened: ${reopened.why}`); return }
    const typedAfter = await typeReal(window, CHAT_COMPOSER_INPUT_SELECTOR, 'Tell me about this computer.')
    if (!typedAfter.ok) { note('FAIL', `after restart, the chat box could not be typed into: ${typedAfter.why}`); return }
    await key(window, 'Enter', 13)

    /* THE ANSWER IS READ FROM THE ENGINE'S OWN ROLLOUT, not the transcript.
       Measured on this driver's first two runs: the resume restores boot-1
       lines the snapshot missed (a final reply that landed after the snapshot
       was taken), so a transcript diff labels a RESTORED line as the new
       answer — both runs read "I read back 742" as the reply to a question
       about the computer. The rollout has no such ambiguity: the file that
       carries the typed question carries, after it, the turn's own
       task_complete with the final words. */
    const obeyReply = await until(async () => {
      const files = filesCarrying(scratch, 'Tell me about this computer.').filter(file => /\.jsonl$/i.test(file))
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        const asked = text.indexOf('Tell me about this computer.')
        const completions = [...text.slice(asked).matchAll(/"type":"task_complete"[^\n]*?"last_agent_message":"((?:[^"\\]|\\.)*)"/g)]
        if (completions.length > 0) return JSON.parse(`"${completions[completions.length - 1][1]}"`)
      }
      return null
    }, { timeoutMs: 300_000, everyMs: 5000 })
    if (!obeyReply) { note('FAIL', 'the restarted session never answered the post-restart question'); return }
    void bootOneLines

    /* FACT 1 — THE PRODUCT'S: the rule rode the restarted session's first
       turn. Proven in the engine's own rollout bytes, never inferred from
       behaviour, and WAITED FOR: the rollout is the engine's own write and
       lands on its own schedule. The ledger file itself is excluded. */
    const carriers = await until(async () => {
      const found = filesCarrying(scratch, THREAD_RULE)
        .filter(file => !file.includes(path.join('state', 'r-ledger')))
      return found.length > 0 ? found : null
    }, { timeoutMs: 90_000, everyMs: 5000 }) || []
    note(carriers.length > 0 ? 'ok' : 'FAIL', carriers.length > 0
      ? `BRIEF CARRIAGE: the restarted session's engine rollout carries the rule (${carriers.length} file(s), e.g. ${path.relative(scratch, carriers[0])})`
      : 'the rule reached no engine rollout after the restart — the brief did not carry it')

    /* FACT 2 — THE MODEL'S, reported separately as ordered. */
    const sentences = (obeyReply.match(/[.!?](\s|$)/g) || []).length
    const oneSentence = sentences <= 1 && !obeyReply.includes('\n\n')
    note(oneSentence ? 'ok' : 'warn', oneSentence
      ? `OBEDIENCE: the model answered in one sentence: ${JSON.stringify(obeyReply.slice(0, 120))}`
      : `DISOBEDIENCE (the model's, not the product's): ${sentences} sentence-enders in ${JSON.stringify(obeyReply.slice(0, 160))}`)

    }

    console.log('\n[5] scope isolation: a NEW TREE must not inherit A\'s session or thread rules')
    // Restore the tree page, then create B through the header's New tree action.
    await window.evaluate('location.reload()')
    await delay(3800)
    const startedB = await startNode(window, { role: 'default', message: BRIEF_B })
    note(startedB.ok ? 'ok' : 'FAIL', startedB.ok ? 'node B started on its own tree' : `node B could not start: ${startedB.why}`)
    if (!startedB.ok) return
    const bAnswered = await until(async () => {
      const record = await treeRecordOf(window, computerId)
      const nodeB = record?.nodes?.find(entry => entry.id !== nodeA.id && entry.sessionId)
      if (!nodeB) return null
      const lines = agentLinesOf(await transcriptsOf(window, computerId), nodeB.id)
      return lines.length > 0 ? nodeB : null
    }, { timeoutMs: 180_000 })
    if (!bAnswered) { note('FAIL', 'node B never answered, so its brief cannot be examined'); return }
    const bFiles = filesCarrying(scratch, 'MARKER-B-SESSION')
      .filter(file => /\.jsonl$/i.test(file))
    if (bFiles.length === 0) { note('FAIL', 'node B\'s rollout could not be found by its marker'); return }
    const leaked = bFiles.filter(file => {
      const text = readFileSync(file, 'utf8')
      return text.includes('SESSION-A-MARKER') || text.includes(THREAD_RULE)
    })
    note(leaked.length === 0 ? 'ok' : 'FAIL', leaked.length === 0
      ? `ISOLATION: B's rollout (${path.relative(scratch, bFiles[0])}) carries neither A's session rule nor A's thread rule`
      : `A's scoped rules LEAKED into ${leaked.map(file => path.relative(scratch, file)).join(', ')}`)

    console.log('\n[6] the ceiling: an absurd global ledger cannot brick a start')
    const globalLedger = path.join(stateRootOf(scratch), 'reports', 'R-LEDGER.md')
    mkdirSync(path.dirname(globalLedger), { recursive: true })
    let absurd = '# Owner requests — global\n\n'
    for (let index = 0; index < 300; index += 1) {
      absurd += `## R${2000 + index} — 2026-08-19T00:00:00.000Z\n\nGlobal rule number ${index} with some padding words to carry real weight in bytes.\n\n`
    }
    absurd += `## R2300 — 2026-08-19T00:00:01.000Z\n\nNEWEST-GLOBAL-RULE keep this one.\n\n<!-- next-id: 2301 -->\n`
    writeFileSync(globalLedger, absurd, 'utf8')
    note('info', `planted ${Math.round(absurd.length / 1024)}KB of global ledger (301 entries)`)

    await window.evaluate('location.reload()')
    await delay(3800)
    const childDoorway = await window.evaluate(`(() => {
      const spots = [...document.querySelectorAll('.computers .tree-empty-node[data-empty-kind="child"]')]
      if (!spots.length) return null
      const target = spots[spots.length - 1]
      if (!target.id) target.id = 'drive-node-c-doorway'
      return '#' + target.id
    })()`)
    if (!childDoorway) { note('FAIL', 'no child slot to start node C from'); return }
    const startedC = await startNode(window, { doorway: childDoorway, role: 'default', message: BRIEF_C })
    if (!startedC.ok) { note('FAIL', `node C could not be STARTED under the absurd ledger: ${startedC.why}`); return }
    const cAnswered = await until(async () => {
      const record = await treeRecordOf(window, computerId)
      const nodeC = record?.nodes?.find(entry => entry.id !== nodeA.id && entry.sessionId && agentIsC(entry))
      function agentIsC(entry) { return String(entry.message || '').includes('MARKER-C-SESSION') }
      if (!nodeC) return null
      const lines = agentLinesOf(await transcriptsOf(window, computerId), nodeC.id)
      return lines.length > 0 ? nodeC : null
    }, { timeoutMs: 180_000 })
    note(cAnswered ? 'ok' : 'FAIL', cAnswered
      ? 'node C STARTED AND ANSWERED under a 301-entry global ledger — the ceiling held'
      : 'node C never answered under the absurd ledger — the ceiling may have killed the start')
    if (cAnswered) {
      const cFiles = filesCarrying(scratch, 'MARKER-C-SESSION').filter(file => /\.jsonl$/i.test(file))
      const cText = cFiles.length ? readFileSync(cFiles[0], 'utf8') : ''
      const announced = cText.includes('withheld for space')
      const newest = cText.includes('NEWEST-GLOBAL-RULE')
      note(announced ? 'ok' : 'FAIL', announced
        ? 'the trimmed block ANNOUNCED the trim in C\'s own brief'
        : 'no trim announcement found in C\'s rollout')
      note(newest ? 'ok' : 'FAIL', newest
        ? 'the NEWEST global entry survived the shed, as the discipline requires'
        : 'the newest global entry was lost in the shed')
    }
  } finally {
    if (window) { try { await closeWindow(window) } catch { /* going down anyway */ } }
    if (pid) { try { reap(pid) } catch { /* gone */ } }
    if (!KEEP) { try { const { rmSync } = await import('node:fs'); rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* scratch outlives */ } }
    else note('info', `kept ${scratch}`)
    const failed = findings.filter(finding => finding.level === 'FAIL')
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${findings.filter(f => f.level === 'ok').length} ok, ${findings.filter(f => f.level === 'warn').length} reported, ${failed.length} failed`)
    process.exitCode = failed.length === 0 ? 0 : 1
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
