#!/usr/bin/env node

/* START A CHILD UNDER A MANAGER, ASK IT WHO ITS MANAGER IS, AND READ THE ANSWER.
 *
 * THE DEFECT THIS EXISTS FOR, in the owner's words: "This one is not realizing
 * and not able to contact its manager." His screenshot: a node called Default,
 * drawn under one called Manager, answering "I don't currently have a manager
 * agent or report content specified -- send me the manager's identifier." The
 * tree held the relationship and the session was never told it.
 *
 * WHAT SUCCESS IS, AND NOTHING ELSE COUNTS. The running agent must NAME its
 * manager in its own words. Not a session id, not a spinner, not a string this
 * driver put in the message box. The question is asked in a form whose answer
 * cannot be echoed from the question: the manager's on-screen name is never
 * typed by this file, it is produced by the product (treeNodeName) and read
 * back off the tree, and the answer is only counted when it appears somewhere
 * that is not a form control.
 *
 * IT ALSO ANSWERS DEFECT 1, in the same run and for free. After the reply
 * lands, the node's saved conversation is read back and checked for the brief
 * the person typed. Before 2026-08-18 the brief was never recorded anywhere:
 * it showed only through a fallback that stopped firing the moment the first
 * reply was appended, so the opening question vanished from the chat and from
 * the durable excerpt. One turn is enough to prove or disprove that.
 *
 * IT SPENDS REAL MONEY on the person's own subscription, so it is a tool and
 * never a default test target.
 *
 *   node tools/tree-manager-brief-drive.mjs
 *   node tools/tree-manager-brief-drive.mjs --visible --keep
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  argument,
  closeWindow,
  delay,
  openWindow,
  reap,
  releaseDirectory,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const RELEASE = path.resolve(argument('--release', releaseDirectory()))
const KEEP = process.argv.includes('--keep')

/* Codex, because the owner's quota is what is working and `luna` is the tier
   he named. Nothing here is Claude-specific; the brief rides in the message
   text precisely so it reaches either engine. */
const TIER = 'luna'
const COMPUTER_ID = 'this-computer'
const TREES_KEY = `mc.fleet.trees.v1:${COMPUTER_ID}`
const TRANSCRIPTS_KEY = `mc.fleet.transcripts.v1:${COMPUTER_ID}`

/* THE BRIEF THE PERSON TYPES, and the phrase defect 1 is measured with. It is
   deliberately unmistakable and appears nowhere else, so finding it in the
   saved conversation after a reply cannot be a coincidence. */
const MANAGER_BRIEF = 'Watch the release branch and report anything red.'
const CHILD_BRIEF = 'Answer in one sentence: who is your manager, and how do you report to it?'

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

const SPOT_FN = `(selector) => {
  const el = document.querySelector(selector)
  if (!el) return { state: 'absent' }
  const box = el.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'offscreen' }
  const hit = document.elementFromPoint(x, y)
  if (!hit) return { state: 'covered', by: 'nothing' }
  const receives = hit === el || el.contains(hit)
  if (!receives) {
    const name = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    return { state: 'covered', by: hit.contains(el) ? ('own-ancestor-' + name) : name }
  }
  return { state: 'visible', x, y }
}`

async function spot(window, selector, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs
  let last = { state: 'absent' }
  for (;;) {
    last = await window.evaluate(`(${SPOT_FN})(${JSON.stringify(selector)})`)
    if (last?.state === 'visible' || Date.now() >= until) return last
    await delay(240)
  }
}

async function press(window, selector, timeoutMs = 12_000) {
  const at = await spot(window, selector, timeoutMs)
  if (at?.state !== 'visible') {
    return { pressed: false, why: at?.state === 'covered' ? `covered by ${at.by}` : (at?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(420)
  return { pressed: true, at: { x: Math.round(at.x), y: Math.round(at.y) } }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
}

/* A native <select> answered the way a keyboard user answers it: press, dismiss
   the operating-system popup the press opens, then arrow. The Escape is the
   whole trick -- see tools/claude-tree-start-proof.mjs, where getting it wrong
   cost a lane a false claim about real input. */
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
  await window.session.send('Input.insertText', { text })
  await delay(220)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: String(landed).includes(text.slice(0, 24)), landed: String(landed).slice(0, 80) }
}

/* Fill the compose panel and press Start. The panel refuses an incomplete form
   in its own words, so every field is answered before Start is pressed. */
async function composeAndStart(window, { role, message }) {
  const roleValue = await window.evaluate(`(() => {
    const node = document.querySelector('[data-compose-field="role"]')
    if (!node) return null
    return [...node.options].map(o => o.value).find(v => v === ${JSON.stringify(role)}) || null
  })()`)
  if (!roleValue) return { ok: false, why: `the panel offers no ${role} role` }
  const roleChosen = await chooseByKeyboard(window, '[data-compose-field="role"]', roleValue)
  if (!roleChosen.ok) return { ok: false, why: `role: ${roleChosen.why}` }

  const tierChosen = await chooseByKeyboard(window, '[data-compose-field="tier"]', TIER)
  if (!tierChosen.ok) return { ok: false, why: `tier: ${tierChosen.why}` }

  const typed = await typeReal(window, '[data-compose-field="message"]', message)
  if (!typed.ok) return { ok: false, why: `message: ${typed.why || typed.landed}` }

  const startTarget = await window.evaluate(`(() => {
    const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'brief-drive-start'
    return { selector: '#' + btn.id, disabled: btn.disabled === true }
  })()`)
  if (!startTarget) return { ok: false, why: 'no Start control on the panel' }
  const pressed = await press(window, startTarget.selector)
  if (!pressed.pressed) return { ok: false, why: `Start: ${pressed.why}` }
  return { ok: true }
}

export function decodeStoredJson(raw, key) {
  // getItem's null is the one result that actually means the key is absent.
  // A malformed value says nothing about absence and must not be collapsed into
  // the same answer (or retained); callers need to stop rather than audit an
  // empty tree or conversation that the machine could not read.
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch (cause) {
    const error = new Error(
      `Could not determine ${key} because its stored JSON could not be read; this is NOT claiming absence.`,
      { cause },
    )
    error.code = 'STORAGE_VALUE_INDETERMINATE'
    throw error
  }
}

async function readForest(window) {
  const raw = await window.evaluate(`localStorage.getItem(${JSON.stringify(TREES_KEY)})`)
  return decodeStoredJson(raw, 'the fleet tree')
}

async function readTranscripts(window) {
  const raw = await window.evaluate(`localStorage.getItem(${JSON.stringify(TRANSCRIPTS_KEY)})`)
  return decodeStoredJson(raw, 'the fleet transcripts')
}

/* What is on the glass, outside every form control -- the same rule
   claude-tree-start-proof.mjs settled on after two false passes: a phrase found
   inside the message box is this driver reading its own typing. */
async function spokenText(window) {
  return window.evaluate(`(() => {
    const inField = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
    return [...document.querySelectorAll('.computers *')]
      .filter(node => node.children.length === 0 && (node.textContent || '').trim().length > 0 && !inField(node))
      .map(node => node.textContent.trim())
      .join('\\n')
      .slice(0, 6000)
  })()`)
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'tree-manager-brief-'))
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch, RELEASE)

    /* THE SIGN-IN THIS RUN NEEDS, borrowed into the scratch profile and deleted
       with it. openWindow isolates USERPROFILE and APPDATA on purpose -- a
       driver pointed at the real home once desynced the owner's audit ledger --
       and a Codex child started under an empty home would answer "not signed
       in", which is the product working and is not the proof. */
    const realHome = process.env.USERPROFILE || ''
    const credential = path.join(realHome, '.codex', 'auth.json')
    if (!existsSync(credential)) {
      note('FAIL', 'HARNESS STATE: this computer has no Codex sign-in to lend, so nothing below would measure a running agent.')
      return
    }
    const scratchCodex = path.join(scratch, 'home', '.codex')
    mkdirSync(scratchCodex, { recursive: true })
    cpSync(credential, path.join(scratchCodex, 'auth.json'))
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* already linked */ }
    }
    note('info', 'lent the scratch profile this computer\'s Codex sign-in and npm layout; both live only in the temporary profile this run deletes.')

    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)

    /* Starting agents ships switched off, and a person who has reached this
       question has already turned it on. Seeded for the same reason
       seedMachineRecord is: the question here is about the brief, not about the
       Settings toggle, which has its own coverage. */
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3800)
    if (await window.evaluate(`location.hash.includes('setup')`)) {
      note('FAIL', 'the build stopped in setup, so nothing below would be about the product')
      return
    }

    console.log('\n[1] starting a manager at the top of an empty tree')
    const doorway = await press(window, '.computers .tree-empty-node')
    note(doorway.pressed ? 'ok' : 'FAIL', `pressed the empty slot${doorway.pressed ? ` at (${doorway.at.x}, ${doorway.at.y})` : `: ${doorway.why}`}`)
    if (!doorway.pressed) return
    await delay(2200)
    const managerStart = await composeAndStart(window, { role: 'manager', message: MANAGER_BRIEF })
    note(managerStart.ok ? 'ok' : 'FAIL', `started the manager${managerStart.ok ? '' : `: ${managerStart.why}`}`)
    if (!managerStart.ok) return
    await delay(6000)

    const forestAfterManager = await readForest(window)
    const managerNode = forestAfterManager?.nodes?.find(entry => entry.role === 'manager')
    note(managerNode ? 'ok' : 'FAIL', `the manager is on the tree${managerNode ? ` as ${managerNode.id}` : ''}`)
    if (!managerNode) return

    /* THE NAME THE PRODUCT GIVES IT, read off the canvas. This driver never
       types it, so an agent that repeats it is repeating something only the
       product could have told it. */
    const managerName = await window.evaluate(`(() => {
      const node = document.querySelector('[data-agent-id="${managerNode.id}"]')
      const label = node?.querySelector('.nm, .node-name, .name')
      return (label?.textContent || node?.getAttribute('aria-label') || '').trim().slice(0, 60)
    })()`)
    note(managerName ? 'ok' : 'warn', `the canvas calls it ${JSON.stringify(managerName)}`)

    console.log('\n[2] starting a child under it')
    const childSlot = `[data-empty-slot="empty:child:${managerNode.id}"]`
    const childDoor = await press(window, childSlot)
    note(childDoor.pressed ? 'ok' : 'FAIL', `pressed the child slot under the manager${childDoor.pressed ? '' : `: ${childDoor.why}`}`)
    if (!childDoor.pressed) return
    await delay(2200)
    const childStart = await composeAndStart(window, { role: 'default', message: CHILD_BRIEF })
    note(childStart.ok ? 'ok' : 'FAIL', `started the child${childStart.ok ? '' : `: ${childStart.why}`}`)
    if (!childStart.ok) return

    console.log('\n[3] waiting for the child to answer (a cold start plus a turn)')
    /* WAIT ON THE RECORD, NOT ON THE PANEL, AND HERE IS THE HARNESS BUG THAT
     * TAUGHT ME TO. The first version of this loop broke as soon as the panel
     * text contained the manager's name -- and the manager's name is printed on
     * its own circle, by the tree, before the child has said a word. So it
     * exited on the first poll, waited nothing at all, and reported the agent
     * silent. A false FAIL produced entirely by the driver, about the exact
     * claim this file exists to make. It is written down rather than quietly
     * corrected because the same shape has cost this repository three false
     * verdicts: a wait whose condition is already true measures nothing.
     *
     * An AGENT line in the node's saved conversation cannot be written by
     * anything except a finished turn -- src/views/computers.js reaches
     * transcriptAppend with who:'agent' from the turn-completed branch and from
     * the turn-boundary settler, and from nowhere else -- so that is the thing
     * waited for. */
    const deadline = Date.now() + 240_000
    let answered = false
    let waited = 0
    for (;;) {
      const saved = await readTranscripts(window)
      const forestNow = await readForest(window)
      const childNow = forestNow?.nodes?.find(entry => entry.parentId === managerNode.id)
      const held = childNow ? saved?.nodes?.[childNow.id]?.lines : null
      if (Array.isArray(held) && held.some(line => line.who === 'agent')) { answered = true; break }
      if (Date.now() > deadline) break
      await delay(4000)
      waited += 4
    }
    note(answered ? 'ok' : 'FAIL', `an agent line reached the record after about ${waited}s`)
    const seen = await spokenText(window)

    const forest = await readForest(window)
    const childNode = forest?.nodes?.find(entry => entry.parentId === managerNode.id)
    const reply = String(childNode?.reply || '')
    note(reply ? 'ok' : 'FAIL', `the child produced a reply of ${reply.length} characters`)
    if (reply) note('info', `it said: ${JSON.stringify(reply.slice(0, 320))}`)

    const namesManager = managerName ? reply.includes(managerName) : false
    note(
      namesManager ? 'ok' : 'FAIL',
      namesManager
        ? `THE CHILD NAMED ITS MANAGER: it used ${JSON.stringify(managerName)}, which this driver never typed`
        : `the child did not name its manager (${JSON.stringify(managerName)}); this is the owner's defect, unfixed`,
    )
    const asksForIdentifier = /identifier|no manager|don't (currently )?have a manager|do not have a manager/i.test(reply)
    note(
      asksForIdentifier ? 'FAIL' : 'ok',
      asksForIdentifier
        ? 'the child still says it has no manager or asks for an identifier -- the exact sentence in the owner\'s screenshot'
        : 'the child does not ask for a manager identifier',
    )
    if (!answered && !reply) note('warn', `nothing was spoken in 180s; the last thing on the panel was ${JSON.stringify(seen.slice(-260))}`)

    console.log('\n[4] and the conversation kept what the person typed (defect 1)')
    const transcripts = await readTranscripts(window)
    const record = transcripts?.nodes?.[childNode?.id]
    const lines = Array.isArray(record?.lines) ? record.lines : []
    note(lines.length ? 'ok' : 'FAIL', `the saved conversation holds ${lines.length} line(s)`)
    const keptBrief = lines.some(line => line.who === 'you' && String(line.text || '').includes(CHILD_BRIEF.slice(0, 40)))
    note(
      keptBrief ? 'ok' : 'FAIL',
      keptBrief
        ? 'the brief the person typed is still in the conversation after the reply landed'
        : 'the brief the person typed is NOT in the conversation -- it disappeared when the reply arrived',
    )
    const keptContext = lines.some(line => /Your manager is/i.test(String(line.text || '')))
    note(
      keptContext ? 'ok' : 'FAIL',
      keptContext
        ? 'what the product told the agent about its manager is shown too, not hidden'
        : 'the tree context was sent and is not shown; the screen and the wire disagree',
    )
    const agentLines = lines.filter(line => line.who === 'agent')
    note(agentLines.length >= 1 ? 'ok' : 'warn', `${agentLines.length} agent line(s) recorded`)
  } finally {
    if (window) {
      await closeWindow(window)
      reap(window.timeline.pid)
    }
    if (!KEEP) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS will */ }
    } else {
      console.log(`kept: ${scratch}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()

  const failed = findings.filter(entry => entry.level === 'FAIL')
  console.log(`\n${findings.filter(entry => entry.level === 'ok').length} ok, ${failed.length} FAIL`)
  if (failed.length) process.exitCode = 1
}
