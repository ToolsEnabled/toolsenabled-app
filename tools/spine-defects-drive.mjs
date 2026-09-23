#!/usr/bin/env node

/* FOUR WALKTHROUGH DEFECTS, DRIVEN ON A FRESH INSTALL OF THE SHIPPED INSTALLER.
 *
 * This is the evidence run for the 2026-08-18 fresh-install findings, driven
 * the way the walkthrough was driven: the real NSIS installer, installed
 * silently into a scratch directory, launched with its own --user-data-dir and
 * an isolated profile, and every press and keystroke a real CDP input event —
 * never el.click(), never dispatchEvent.
 *
 *   1  FABLE ANSWERS, OR THE ENGINE'S OWN SENTENCE IS ON THE CARD. A real
 *      claude-fable tier start is asked arithmetic whose answer is typed
 *      nowhere in this run. Measured 2026-08-19: `--model fable` is the CLI's
 *      own documented alias and answers, so the pass condition is a real
 *      answer; a failure must put the engine's sentence on the card, never
 *      "finished without any words back".
 *
 *   2  A FAILED TURN IS NOT AN UNSTARTED SESSION. Mid-turn, this run kills the
 *      claude child it started — ONLY a process whose ancestry chain leads to
 *      this run's own app pid — and reads the chip: it must say the last turn
 *      failed, and must never say "did not start" over a session whose spawn
 *      record this same run wrote.
 *
 *   3  THE FOLDER SETUP RECORDS IS THE FOLDER THE AGENT WORKS IN. Setup is
 *      walked for real — level, folder, account skipped, autonomy, finish —
 *      and the folder it records must then be: the agent's working directory
 *      (a file the agent writes lands there), the fence anchor (a write
 *      outside it is refused), and the cwd in the spawn record (never null).
 *
 *   4  THE REWIND ROW READS THE DURABLE RECORD. The window is closed and
 *      reopened on the same profile; the palette's Rewind row must tell the
 *      truth about the saved messages instead of "You have not sent it a
 *      message yet."
 *
 * THE SIGN-IN IS LENT, NEVER READ. Same technique as
 * tools/claude-tree-start-proof.mjs and for the same reason: the profile is
 * isolated (a driver that ran against the real home once desynced the owner's
 * audit ledger), so the scratch home is given the two files the CLI reads and
 * the npm layout is junctioned. The product path then authenticates itself.
 *
 * IT SPENDS REAL MONEY on the person's own subscription, so it is a tool and
 * never a default test target.
 *
 *   node tools/spine-defects-drive.mjs
 *   node tools/spine-defects-drive.mjs --keep     leave the scratch tree
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { closeWindow, delay, openWindow, reap, resolveMachineServicesRoot } from './test-account-harness.mjs'
import { CHAT_COMPOSER_INPUT_SELECTOR, createChatPresser } from './lib/chat-drive-lib.mjs'

const KEEP = process.argv.includes('--keep')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const require_ = createRequire(import.meta.url)
const INSTALLER = path.join(REPO, 'release', 'ToolsEnabled Setup 1.0.20.exe')

const PROOF_WORD = '391'
const PROMPT = 'What is 17 multiplied by 23? Reply with only the number.'
if (PROMPT.includes(PROOF_WORD)) throw new Error('the answer is inside the question')

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* B-POOL-6 MIGRATION (API decision doc §6, typeReal family, step 2 of 2):
 * dispatch now lives in tools/lib/chat-drive-lib.mjs; this file's own
 * typeReal() verification policy (24-character prefix match, landed value
 * truncated to 90 chars) stays local and unchanged -- see request-
 * contract-drive.mjs's own migration comment for why that policy is not
 * folded into the shared module.
 *
 * THREE TIMING VALUES DIFFERED, NAMED RATHER THAN SILENTLY CHANGED. press()
 * settled 420ms here; the module gives 520ms -- an increase, safe by
 * construction. key() had NO trailing delay at all here (the only one of
 * the nine drivers with none); the module gives 500ms -- also an increase,
 * and the largest one in this migration, but still the safe direction: it
 * can only give the UI more time to react, never less. typeReal()'s
 * post-insertText settle was 200ms; the module's typeInto() gives 180ms --
 * the one DECREASE, so a 20ms top-up below restores this file's own proven
 * total instead of accepting a shorter one on another file's strength.
 * Same one named reachability change as every earlier step: FLEET_NODE_
 * VISIBLE's ancestor-opacity walk over this harness's own window.
 * waitForVisible/VISIBLE_FN. */
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

async function key(window, name, _keyCode) {
  await presserFor(window).key(name)
}

/* The Escape-then-arrows technique from tools/claude-tree-start-proof.mjs:
   pressing a native <select> opens an OS popup that eats the first arrow. */
async function chooseByKeyboard(window, selector, wantedValue, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  await delay(120)
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
    if (current === wantedValue) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
    await delay(130)
  }
  return { ok: false, why: `never reached ${wantedValue} in ${maxPresses} presses` }
}

async function typeReal(window, selector, text) {
  const clicked = await press(window, selector)
  if (!clicked.pressed) return { ok: false, why: clicked.why }
  await presserFor(window).typeInto(text)
  await delay(20) // top-up to this file's own proven 200ms total (module gives 180ms) -- see the note above
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: String(landed).includes(text.slice(0, 24)), landed: String(landed).slice(0, 90) }
}

/* Every process on this machine, once, as {pid, ppid, name, commandLine}. */
export function processTable(run = spawnSync) {
  let out
  try {
    out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  } catch (cause) {
    return couldNotTell('PROCESS_TABLE_COULD_NOT_TELL', 'Could not read the process table; this is NOT claiming that no matching process exists.', cause)
  }
  if (out.error || out.status !== 0) {
    return couldNotTell('PROCESS_TABLE_COULD_NOT_TELL', 'Could not read the process table; this is NOT claiming that no matching process exists.', out.error || new Error(`PowerShell exited ${out.status}`))
  }
  try {
    const parsed = JSON.parse(out.stdout)
    return { ok: true, rows: Array.isArray(parsed) ? parsed : [parsed] }
  } catch (cause) {
    return couldNotTell('PROCESS_TABLE_COULD_NOT_TELL', 'Could not parse the process table; this is NOT claiming that no matching process exists.', cause)
  }
}

function couldNotTell(code, message, cause) {
  return { ok: false, error: { code, message, causeCode: cause && typeof cause === 'object' ? cause.code || null : null } }
}

/* The claude child THIS RUN started, found by walking parent links up to the
   app pid — never by name alone, because live claude sessions belonging to the
   person run on this machine and are not this run's to touch. */
export function claudeChildOf(appPid, run = spawnSync) {
  const result = processTable(run)
  if (!result.ok) return result
  const table = result.rows
  const byPid = new Map(table.map(row => [row.ProcessId, row]))
  const descendsFromApp = pid => {
    for (let hop = 0, current = pid; hop < 12; hop += 1) {
      const row = byPid.get(current)
      if (!row) return false
      if (row.ParentProcessId === appPid) return true
      current = row.ParentProcessId
    }
    return false
  }
  return { ok: true, children: table.filter(row =>
    /claude/i.test(String(row.Name || '') + String(row.CommandLine || ''))
    && !/mcp/i.test(String(row.CommandLine || ''))
    && descendsFromApp(row.ProcessId)) }
}

export function readRecordedCwd(spawnLedger, read = readFileSync) {
  try {
    const lines = read(spawnLedger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const startRecord = lines.find(line => JSON.stringify(line).includes('agent_session_start'))
    return { ok: true, cwd: startRecord ? JSON.stringify(startRecord).match(/"cwd":"([^"]+)"/)?.[1] || null : null }
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return { ok: true, cwd: null }
    return couldNotTell('SPAWN_LEDGER_COULD_NOT_TELL', 'Could not read the spawn ledger; this is NOT claiming that its cwd is absent.', cause)
  }
}

async function waitFor(window, expression, { timeoutMs = 120_000, everyMs = 2500 } = {}) {
  const until = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await window.evaluate(expression)
    if (last && last.done) return last
    if (Date.now() > until) return last
    await delay(everyMs)
  }
}

const READ_TREE = `(() => {
  const panel = document.querySelector('.computers') || document.body
  const text = (panel.innerText || '')
  const cards = [...document.querySelectorAll('[data-tree-chip], .cl-chat, .chip')]
    .map(card => (card.innerText || '').trim()).filter(Boolean)
  return { text: text.slice(-1400), cards: cards.slice(0, 8),
    refusals: [...document.querySelectorAll('[data-refusal-code]')].map(n => n.getAttribute('data-refusal-code')) }
})()`

async function startFableNode(window, message) {
  const doorway = await press(window, '.computers .tree-empty-node')
  if (!doorway.pressed) return { ok: false, why: `no doorway: ${doorway.why}` }
  await delay(2200)
  const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', 'claude-fable')
  if (!tier.ok) return { ok: false, why: `tier: ${tier.why}` }
  const firstRole = await window.evaluate(`(() => {
    const n = document.querySelector('[data-compose-field="role"]')
    return n ? [...n.options].map(o => o.value).find(v => v && v.length > 0) || null : null
  })()`)
  if (!firstRole) return { ok: false, why: 'no role menu' }
  const role = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
  if (!role.ok) return { ok: false, why: `role: ${role.why}` }
  const typed = await typeReal(window, '[data-compose-field="message"]', message)
  if (!typed.ok) return { ok: false, why: `message: ${typed.landed}` }
  const start = await window.evaluate(`(() => {
    const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'spine-start-target'
    return '#' + btn.id
  })()`)
  if (!start) return { ok: false, why: 'no Start button' }
  const pressed = await press(window, start)
  if (!pressed.pressed) return { ok: false, why: `Start: ${pressed.why}` }
  return { ok: true }
}

/* Type into the node's chat composer (buildChat's `.chat input` + `.chat-send`
   button) and send with a real press on the send control.
   B-POOL-6 MIGRATION: this function's selector used to hardcode its own
   phrasing of the composer input (`.chat input[type="text"]`) -- one of
   FOUR independent phrasings the API decision doc's research found across
   the nine drivers for this one element -- rather than the canonical
   CHAT_COMPOSER_INPUT_SELECTOR src/components.js now exports (via chat-
   drive-lib.mjs). Interpolated into the evaluated string below rather than
   left as a driver-local guess, so the day this markup changes there is
   exactly one place that has to know. The raw Input.insertText dispatch
   is replaced the same way every other typing call in this file was --
   the 250ms settle after it is kept exactly as it was (typeInto's own
   180ms lands first; this is additive, not a replacement for it, so the
   total is a safe increase over the original 250ms, never a decrease). */
async function sendChat(window, text) {
  const box = await window.evaluate(`(() => {
    const vis = n => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 }
    const boxes = [...document.querySelectorAll(${JSON.stringify(CHAT_COMPOSER_INPUT_SELECTOR)})].filter(vis).filter(n => !n.disabled)
    const target = boxes[boxes.length - 1]
    if (!target) return null
    if (!target.id) target.id = 'spine-chat-box'
    const sender = target.closest('.chat')?.querySelector('.chat-send')
    if (sender && !sender.id) sender.id = 'spine-chat-send'
    return '#' + target.id
  })()`)
  if (!box) return { ok: false, why: 'no chat box' }
  const clicked = await press(window, box)
  if (!clicked.pressed) return { ok: false, why: `chat box: ${clicked.why}` }
  await presserFor(window).typeInto(text)
  await delay(250)
  const send = await press(window, '#spine-chat-send')
  if (!send.pressed) return { ok: false, why: `send button: ${send.why}` }
  await delay(600)
  return { ok: true }
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'spine-drive-'))
  const installDir = path.join(scratch, 'install')
  let window = null
  try {
    console.log(`scratch: ${scratch}`)

    console.log('\n[0] installing the shipped installer, silently, into scratch')
    if (!existsSync(INSTALLER)) { note('FAIL', `no installer at ${INSTALLER}`); return }
    const installed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath ${JSON.stringify(INSTALLER)} -ArgumentList '/S',${JSON.stringify(`/D=${installDir}`)} -Wait`],
    { encoding: 'utf8', windowsHide: true, timeout: 300_000 })
    const executable = path.join(installDir, 'ToolsEnabled.exe')
    if (installed.status !== 0 || !existsSync(executable)) {
      note('FAIL', `install did not produce ${executable} (exit ${installed.status}) ${String(installed.stderr || '').slice(0, 200)}`)
      return
    }
    note('ok', `installed to ${installDir}`)

    /* The profile: isolated everything, with the Claude sign-in lent and npm
       junctioned — see the module header. */
    for (const leaf of ['local', 'roaming', 'home', 'userdata']) mkdirSync(path.join(scratch, leaf), { recursive: true })
    const realHome = process.env.USERPROFILE || ''
    const credential = path.join(realHome, '.claude', '.credentials.json')
    if (!existsSync(credential)) { note('FAIL', 'HARNESS STATE: no Claude sign-in on this computer to lend'); return }
    mkdirSync(path.join(scratch, 'home', '.claude'), { recursive: true })
    cpSync(credential, path.join(scratch, 'home', '.claude', '.credentials.json'))
    const settings = path.join(realHome, '.claude.json')
    if (existsSync(settings)) cpSync(settings, path.join(scratch, 'home', '.claude.json'))
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* linked */ }
    }
    mkdirSync(path.join(scratch, 'home', 'Documents'), { recursive: true })
    note('info', 'profile isolated; Claude sign-in lent into the scratch home; npm junctioned')

    window = await openWindow(executable, scratch)
    note('ok', `launched pid ${window.timeline.pid}`)

    console.log('\n[1] DEFECT 3 SCENE 1: the real setup walkthrough, driven')
    await delay(1500)
    const inSetup = await window.evaluate(`location.hash.includes('setup')`)
    if (!inSetup) {
      /* A fresh profile that does not stop in setup is itself a finding. */
      await window.evaluate(`location.hash = '#/setup'`)
      await delay(1500)
    }
    const level = await press(window, '[data-setup-tier="standard"]')
    note(level.pressed ? 'ok' : 'FAIL', `pressed the "standard" level${level.pressed ? '' : `: ${level.why}`}`)
    if (!level.pressed) return
    await delay(1600)
    const toWorkspace = await press(window, '[data-setup-continue]')
    note(toWorkspace.pressed ? 'ok' : 'FAIL', `continued to the folder question${toWorkspace.pressed ? '' : `: ${toWorkspace.why}`}`)
    await delay(1800)
    const folderShown = await window.evaluate(`(() => {
      const roots = [...document.querySelectorAll('[data-setup-root-index] code, [data-setup-root-index]')]
      const text = roots.map(n => (n.innerText || '').trim()).join(' ')
      const section = document.querySelector('[data-setup-section]')
      return { text: text || (section ? section.innerText.slice(0, 600) : '') }
    })()`)
    note('info', `the folder question shows: ${JSON.stringify(String(folderShown?.text || '').slice(0, 200))}`)
    const toAccount = await press(window, '[data-setup-next="account"]')
    note(toAccount.pressed ? 'ok' : 'FAIL', `accepted the offered folder and continued${toAccount.pressed ? '' : `: ${toAccount.why}`}`)
    if (!toAccount.pressed) return
    await delay(1600)
    const skipAccount = await press(window, '[data-setup-next="autonomy"]')
    note(skipAccount.pressed ? 'ok' : 'FAIL', `skipped the account question${skipAccount.pressed ? '' : `: ${skipAccount.why}`}`)
    await delay(1600)
    const toReview = await press(window, '[data-setup-next="review"]')
    note(toReview.pressed ? 'ok' : 'FAIL', `answered autonomy with the shown default${toReview.pressed ? '' : `: ${toReview.why}`}`)
    await delay(1800)
    const finish = await press(window, '[data-setup-next="finish"]')
    note(finish.pressed ? 'ok' : 'FAIL', `pressed Finish setup${finish.pressed ? '' : `: ${finish.why}`}`)
    if (!finish.pressed) return
    await delay(3500)

    /* recordTier already wrote machine.json at the level step, without the
       chosen flag — poll for the record FINISH writes, the one that carries
       workspaceChosen, not merely the first parseable bytes. */
    const machineRecord = require_(path.join(installDir, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
    const servicesRoot = resolveMachineServicesRoot(scratch, machineRecord)
    const machineFile = path.join(servicesRoot, 'machine.json')
    let record = null
    for (let i = 0; i < 15; i += 1) {
      try {
        const parsed = JSON.parse(readFileSync(machineFile, 'utf8'))
        record = parsed
        if (parsed.workspaceChosen === true) break
      } catch { /* not yet */ }
      await delay(1000)
    }
    const chosen = record && Array.isArray(record.workspaceRoots) ? record.workspaceRoots[0] : null
    note(record?.workspaceChosen === true && chosen ? 'ok' : 'FAIL',
      `setup recorded the folder: ${JSON.stringify(chosen)} workspaceChosen=${record?.workspaceChosen}`)
    if (!chosen) return
    note(existsSync(chosen) ? 'ok' : 'FAIL', `the chosen folder exists on disk (${existsSync(path.join(chosen, '.git')) ? 'with' : 'WITHOUT'} the promised history)`)

    console.log('\n[2] DEFECT 1: a real Fable-tier agent, started by hand')
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(4200)
    const started = await startFableNode(window, PROMPT)
    note(started.ok ? 'ok' : 'FAIL', `Fable start ${started.ok ? 'submitted' : `failed: ${started.why}`}`)
    if (!started.ok) return

    const answer = await waitFor(window, `(() => {
      const view = ${READ_TREE}
      const inFormField = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
      const isEcho = node => String(node.textContent || '').includes(${JSON.stringify(PROMPT)}) || String(node.textContent || '').toLowerCase().includes('asked:')
      const spoken = [...document.querySelectorAll('*')].filter(node => node.children.length === 0
        && (node.textContent || '').includes(${JSON.stringify(PROOF_WORD)}) && !inFormField(node) && !isEcho(node))
      const failedCard = view.cards.find(card => /turn failed/i.test(card)) || null
      return { done: spoken.length > 0 || Boolean(failedCard) || view.refusals.length > 0,
        answered: spoken.length > 0, failedCard, refusals: view.refusals, tail: view.text }
    })()`, { timeoutMs: 180_000 })
    if (answer?.answered) {
      note('ok', `THE FABLE AGENT ANSWERED: "${PROOF_WORD}" is on the tree and typed nowhere in this run`)
    } else if (answer?.failedCard) {
      note('ok', `the turn failed and the card carries the engine's sentence: ${JSON.stringify(answer.failedCard.slice(0, 240))}`)
      note('info', 'a failure with the sentence on the glass is the defect-1a contract; the answerless silence is what shipped')
    } else {
      note('FAIL', `neither an answer nor a sentence within 180s. refusals=${JSON.stringify(answer?.refusals)} tail=${JSON.stringify((answer?.tail || '').slice(-400))}`)
      return
    }

    console.log('\n[3] DEFECT 3 SCENE 2: where the agent really works, and where it may not write')
    const spawnLedger = path.join(scratch, 'userdata', 'agent-spawn-records.jsonl')
    const recorded = readRecordedCwd(spawnLedger)
    if (!recorded.ok) note('FAIL', `${recorded.error.code}: ${recorded.error.message}`)
    const recordedCwd = recorded.ok ? recorded.cwd : null
    const normalizedChosen = chosen.replace(/\\\\/g, '\\')
    note(recordedCwd && recordedCwd.replace(/\\\\/g, '\\').toLowerCase() === normalizedChosen.toLowerCase() ? 'ok' : 'FAIL',
      `the spawn record carries the real cwd: ${JSON.stringify(recordedCwd)} (chosen: ${JSON.stringify(chosen)})`)

    /* The node's own chat, opened the way a person opens it: pressing the
       circle. `.static-tree-node` is the class that means "a running agent"
       (tree-graph.js names it that on purpose). */
    const nodeOpen = await press(window, '.computers .static-tree-node')
    note(nodeOpen.pressed ? 'ok' : 'info', `pressed the agent's circle${nodeOpen.pressed ? '' : ` (${nodeOpen.why}) — trying the composer that is already open`}`)
    await delay(2200)
    const outside = path.join(scratch, 'outside-probe.txt')
    const fenceAsk = `Create a file named fence-probe.txt containing the word INSIDE in your current working directory. Then try to write a file at ${outside} containing the word OUTSIDE. Then state your current working directory on its own line. Report each result plainly.`
    const sent = await sendChat(window, fenceAsk)
    note(sent.ok ? 'ok' : 'FAIL', `asked for the fence probe${sent.ok ? '' : `: ${sent.why}`}`)
    if (sent.ok) {
      const probed = await waitFor(window, `(() => {
        const view = ${READ_TREE}
        const settled = /INSIDE|refus|denied|could not|couldn|cannot|unable|permission/i.test(view.cards.join(' '))
        return { done: settled, cards: view.cards }
      })()`, { timeoutMs: 180_000 })
      const insideFile = path.join(chosen, 'fence-probe.txt')
      const wroteInside = existsSync(insideFile)
      const wroteOutside = existsSync(outside)
      note(wroteInside ? 'ok' : 'FAIL',
        `the agent's file landed in the CHOSEN folder: ${insideFile} exists=${wroteInside}`)
      note(!wroteOutside ? 'ok' : 'FAIL',
        `the write OUTSIDE the chosen folder was refused: ${outside} exists=${wroteOutside}`)
      note('info', `the agent reported: ${JSON.stringify((probed?.cards || []).join(' · ').slice(0, 500))}`)
    }

    console.log('\n[4] DEFECT 2: a turn that dies is a failed TURN, not an unstarted session')
    const longAsk = 'Count slowly from one to two hundred, writing each number in English words on its own line. Do not stop early.'
    const asked = await sendChat(window, longAsk)
    note(asked.ok ? 'ok' : 'FAIL', `asked for a long turn${asked.ok ? '' : `: ${asked.why}`}`)
    if (asked.ok) {
      await delay(9000)
      const childResult = claudeChildOf(window.timeline.pid)
      if (!childResult.ok) {
        note('FAIL', `${childResult.error.code}: ${childResult.error.message}`)
      } else if (!childResult.children.length) {
        note('FAIL', 'no claude child of THIS app was found to stop; the kill is skipped rather than widened')
      } else {
        for (const child of childResult.children) {
          note('info', `stopping pid ${child.ProcessId} (${String(child.Name)}) — a descendant of app pid ${window.timeline.pid}`)
          spawnSync('taskkill.exe', ['/PID', String(child.ProcessId), '/F'], { windowsHide: true, timeout: 20_000 })
        }
        const afterKill = await waitFor(window, `(() => {
          const view = ${READ_TREE}
          const failed = view.cards.find(card => /turn failed/i.test(card)) || null
          const unstarted = view.cards.find(card => /did not start/i.test(card)) || null
          return { done: Boolean(failed || unstarted), failed, unstarted, cards: view.cards }
        })()`, { timeoutMs: 60_000 })
        if (afterKill?.unstarted) {
          note('FAIL', `the card un-said the start: ${JSON.stringify(afterKill.unstarted.slice(0, 200))}`)
        } else if (afterKill?.failed) {
          note('ok', `the card says the TURN failed: ${JSON.stringify(afterKill.failed.slice(0, 240))}`)
        } else {
          note('FAIL', `no failure word appeared within 60s: ${JSON.stringify((afterKill?.cards || []).join(' · ').slice(0, 300))}`)
        }
      }
    }

    console.log('\n[5] DEFECT 4: restart, and read the Rewind row')
    await closeWindow(window)
    window = await openWindow(executable, scratch)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(4200)
    /* The node this run started, pressed so its rail (and composer) opens.
       `.static-tree-node` is tree-graph.js's class for a real agent node. */
    const opened = await press(window, '.computers .static-tree-node')
    note(opened.pressed ? 'ok' : 'FAIL', `pressed the node${opened.pressed ? '' : `: ${opened.why}`}`)
    await delay(2500)
    const popup = await press(window, '[data-chat-actions]')
    note(popup.pressed ? 'ok' : 'FAIL', `opened the Actions popup${popup.pressed ? '' : `: ${popup.why}`}`)
    if (popup.pressed) {
      await delay(1200)
      const rewind = await window.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.chat-actions-row')]
        const row = rows.find(r => /rewind/i.test(r.innerText || ''))
        if (!row) return { found: false, rows: rows.map(r => (r.innerText || '').split('\\n')[0]).slice(0, 14) }
        return { found: true, disabled: row.disabled === true, text: (row.innerText || '').replace(/\\s+/g, ' ').trim() }
      })()`)
      if (!rewind?.found) {
        note('FAIL', `no Rewind row in the popup: ${JSON.stringify(rewind?.rows)}`)
      } else if (/You have not sent it a message yet/i.test(rewind.text)) {
        note('FAIL', `the row still denies the saved messages: ${JSON.stringify(rewind.text)}`)
      } else if (/saved messages|before this window opened/i.test(rewind.text)) {
        note('ok', `the row tells the truth about the record: ${JSON.stringify(rewind.text.slice(0, 220))}`)
      } else {
        note(rewind.disabled ? 'FAIL' : 'ok', `the Rewind row reads: ${JSON.stringify(rewind.text.slice(0, 220))}`)
      }
    }
  } finally {
    try { if (window) await closeWindow(window) } catch { /* gone */ }
    try { if (window) reap(window.timeline.pid) } catch { /* gone */ }
    const failed = findings.filter(entry => entry.level === 'FAIL')
    console.log(`\n${findings.filter(entry => entry.level === 'ok').length} ok, ${failed.length} FAIL`)
    if (!KEEP && !failed.length) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* held */ } }
    else console.log(`scratch kept at ${scratch}`)
    process.exitCode = failed.length ? 1 : 0
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const modulePath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (invokedPath === modulePath) main().catch(error => { console.error(error); process.exitCode = 1 })
