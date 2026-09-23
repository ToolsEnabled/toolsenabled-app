#!/usr/bin/env node

/* TWO AGENTS ON ONE TREE, DRIVEN BY HAND, ONE ASKING THE OTHER A QUESTION.
 *
 * THE OWNER'S SCENARIO, VERBATIM, AND NOTHING ELSE: a node called Manager, a
 * node called Default hanging under it, and the child told to contact its
 * manager. "This is just the issue with trying to have it reach coordinator
 * through agent comms it didnt work."
 *
 * WHAT COUNTS AS SUCCESS HERE, and nothing weaker does. Not a tool call that
 * returned accepted:true -- tools/agent-to-agent-mcp-proof.mjs already proves
 * that against the packed payload and says so. This run only passes if a REAL
 * MODEL, given a job and the brief the product writes, decides to use the
 * channel; the message lands in the OTHER session; that session answers; and
 * both conversations on the tree carry it. Everything is a real press and a
 * real keystroke over the debugger -- no el.click(), no dispatchEvent.
 *
 * IT SPENDS REAL MONEY on the person's own Codex subscription, so it is a tool
 * and never a default test target.
 *
 * THE SIGN-IN IS POINTED AT, NEVER COPIED. The scratch profile's .codex is a
 * junction to the one this computer already has, which is the technique
 * tools/a11y-keyboard-qa.mjs documents for the same reason: the product then
 * performs its OWN credential link, exactly as it does for the person, and no
 * credential is read, copied or moved by this file. Nothing else in the profile
 * is shared: state, app data and the tree all live in a directory this run
 * deletes.
 *
 *   node tools/agent-to-agent-tree-drive.mjs
 *   node tools/agent-to-agent-tree-drive.mjs --visible
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  scratchDirectory,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* THE ANSWER MUST NOT BE IN THE QUESTION, AND MY FIRST VERSION PUT IT THERE.
 *
 * It handed the manager a literal number to pass on. The tree draws every
 * node's brief on the panel under `asked:`, so that number was on screen from
 * the moment the manager started -- and the check, which scanned the panel,
 * reported A REAL EXCHANGE on a run where the child never received anything.
 * A false PASS about the single claim this whole lane exists to make. The same
 * trap is documented at length in tools/claude-tree-start-proof.mjs, twice, and
 * I walked into it anyway; it is recorded here so the third reader does not.
 *
 * The manager is now given a SUM instead of an answer. `391` is typed nowhere
 * in this run -- asserted below rather than trusted -- so it can only appear on
 * screen if a model worked it out and a message carried it. */
const PROOF = '391'
/* THE MANAGER IS GIVEN NOTHING TO DO UNTIL ASKED. An earlier wording -- "work
   out 17 multiplied by 23 and send them only that number" -- read to the model
   as an instruction to work it out NOW, and it wrote 391 into its own transcript
   thirteen seconds in, before the child had said a word. That is a real model
   doing what it was told; the driver's words were the defect. The sum is now
   named only inside the condition, and the reply route is stated once. */
/* AND IT MUST NOT SAY "WAIT". A message reaches an agent only between turns.
   The previous wording told the manager to wait, so it sat inside its first
   turn for four minutes with two questions queued behind it -- correctly
   refused by the host, because a mid-turn hand-over is a race. So the manager
   is told to end its turn; the product's own brief now says the same. */
const MANAGER_BRIEF = 'You manage a small team. Right now, say "ready" and stop. Do not calculate anything yet. Later, when a message arrives from an agent that reports to you asking for the job number, work out 17 multiplied by 23 and reply to that agent using agent_comms.send_local with only that number, then stop.'
const CHILD_BRIEF = 'You need the job number before you can start, and you do not have it. Ask your manager for it using the tool you were told about, then say the number back on its own line. Do not guess it and do nothing else.'
if (MANAGER_BRIEF.includes(PROOF) || CHILD_BRIEF.includes(PROOF)) {
  throw new Error('the answer is inside a brief; this run could only measure its own typing')
}

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(350)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

/* A native select moves under the arrow keys only once the popup the press
   itself opened has been dismissed with Escape -- the correction
   tools/claude-tree-start-proof.mjs records at length. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await window.session.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape' })
  await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' })
  await delay(120)
  for (let index = 0; index < maxPresses; index += 1) {
    const value = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
    if (value === wanted) return { ok: true, value }
    for (const type of ['keyDown', 'keyUp']) {
      await window.session.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' })
    }
    await delay(90)
  }
  const value = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  return { ok: value === wanted, value, why: `stopped at ${JSON.stringify(value)}` }
}

async function typeReal(window, selector, text) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await window.session.send('Input.insertText', { text })
  await delay(200)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  return { ok: typeof landed === 'string' && landed.includes(text.slice(0, 24)), landed }
}

async function startNode(window, { doorway, role, message, tier = 'luna' }) {
  const opened = await press(window, doorway)
  if (!opened.pressed) return { ok: false, why: `could not open the panel: ${opened.why}` }
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
    return { selector: '#' + button.id, disabled: button.disabled === true }
  })()`)
  if (!start) return { ok: false, why: 'there is no Start control on the panel' }
  const pressed = await press(window, start.selector)
  return pressed.pressed ? { ok: true } : { ok: false, why: `Start: ${pressed.why}` }
}

/* WHERE THE DIRECTORY REALLY LIVES. shell/main.cjs sets TOOLSENABLED_STATE_ROOT
   to <userData>/capability, and this run gives the app its own --user-data-dir,
   so the file is under the scratch profile's userdata -- not under the roaming
   directory the first version of this function guessed at, which reported zero
   registered agents on a run where both had registered. */
function readDirectory(profile) {
  const file = path.join(profile, 'userdata', 'capability', 'state', 'agent-comms', 'tree-nodes.json')
  if (!existsSync(file)) return { file, nodes: [] }
  try { return { file, nodes: JSON.parse(readFileSync(file, 'utf8')).nodes || [] } }
  catch { return { file, nodes: [] } }
}

async function main() {
  const scratch = scratchDirectory('a2a-tree-')
  let window = null
  try {
    const staged = await stage(scratch)
    note('info', `staged a packaged build carrying this tree at ${staged.appRoot}`)

    /* POINTED AT, NOT COPIED. See the module header. */
    const realCodex = path.join(process.env.USERPROFILE || '', '.codex')
    if (!existsSync(path.join(realCodex, 'auth.json'))) {
      note('FAIL', 'HARNESS STATE: this computer has no Codex sign-in to point the scratch profile at, so nothing below would measure a real agent.')
      return
    }
    mkdirSync(path.join(scratch, 'home'), { recursive: true })
    try { symlinkSync(realCodex, path.join(scratch, 'home', '.codex'), 'junction') } catch { /* already pointed */ }
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* already pointed */ }
    }
    note('info', 'the scratch profile POINTS at this computer\'s Codex sign-in and npm layout; no credential is read or copied by this file.')

    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1000)
    await window.evaluate(`location.reload()`)
    await delay(3800)
    if (await window.evaluate(`location.hash.includes('setup')`)) {
      note('FAIL', 'the build stopped in setup, so nothing below would be about the product')
      return
    }

    console.log('\n[1] starting the MANAGER, by hand')
    const manager = await startNode(window, { doorway: '.computers .tree-empty-node', role: 'manager', message: MANAGER_BRIEF })
    note(manager.ok ? 'ok' : 'FAIL', `the manager node ${manager.ok ? 'was started' : `could not be started: ${manager.why}`}`)
    if (!manager.ok) return
    await delay(9000)

    console.log('\n[2] starting a CHILD under it, by hand')
    /* The placeholder that hangs UNDER a started node is the child doorway;
       taking the first empty node again would start a second root. */
    const childDoorway = await window.evaluate(`(() => {
      const spots = [...document.querySelectorAll('.computers .tree-empty-node')]
      if (!spots.length) return null
      const target = spots[spots.length - 1]
      if (!target.id) target.id = 'drive-child-doorway'
      return '#' + target.id
    })()`)
    if (!childDoorway) {
      note('FAIL', 'the tree offers no place to add an agent under the manager')
      return
    }
    const child = await startNode(window, { doorway: childDoorway, role: 'default', message: CHILD_BRIEF })
    note(child.ok ? 'ok' : 'FAIL', `the child node ${child.ok ? 'was started' : `could not be started: ${child.why}`}`)
    if (!child.ok) return

    console.log('\n[3] did the two sessions announce their places on the tree?')
    let registered = { nodes: [] }
    for (let attempt = 0; attempt < 20 && registered.nodes.length < 2; attempt += 1) {
      await delay(2000)
      registered = readDirectory(scratch)
    }
    note(registered.nodes.length >= 2 ? 'ok' : 'FAIL',
      `the tree directory holds ${registered.nodes.length} running agent(s): ${JSON.stringify(registered.nodes.map(node => ({ name: node.nodeName, manager: node.managerName })))}`)
    if (registered.nodes.length < 2) return

    console.log('\n[4] waiting for the child to ask, and the manager to answer')
    const deadline = Date.now() + 240_000
    let seen = null
    for (;;) {
      /* READ THE CHILD'S OWN CARD, and only the part of it that is not the
         brief. `asked:` is where the tree prints what was typed INTO a node, so
         anything found there is this driver's own words coming back. */
      seen = await window.evaluate(`(() => {
        const panel = document.querySelector('.computers') || document.body
        const text = panel.innerText || ''
        const cards = [...document.querySelectorAll('[data-tree-chip], .cl-chat, .chip')]
          .map(card => (card.innerText || '').trim())
          .filter(card => card.length > 0)
        /* WHAT THE NODE SAID, with what was typed INTO it removed. The card reads
           "<name> <clock> <state> asked: <brief> › <what it said>": the brief
           sits between 'asked:' and the first › marker, and everything from
           that marker on is the node's own words. The first version of this
           stopped at 'asked:' and never reached the answer -- it reported
           SILENCE on a run where the child had said the number, plainly, one
           marker later. A driver that cannot read the answer it is waiting for
           will report every success as a failure. */
        const spoken = card => {
          const index = card.indexOf('asked:')
          if (index < 0) return card
          const marker = card.indexOf('›', index)
          return marker < 0 ? card.slice(0, index) : card.slice(0, index) + ' ' + card.slice(marker)
        }
        /* THE CHILD'S CARD, found by the name it carries rather than by where the
           name sits. The card list holds the node card AND a separate reply
           card for the same node ('› Manager: 391' on its own), and which one
           comes first is layout, not contract. Matching startsWith('Default')
           found nothing for the whole wait and burned the deadline while step 5,
           one query later, read the answer off the same page -- so this run
           reported SILENCE beside its own transcript printing the number. */
        /* DOUBLE BACKSLASHES, ON PURPOSE. This whole block is a template literal
           evaluated in the page, and a single \\b or \\s here is consumed by THIS
           file's parser first -- \\b became a backspace byte and \\s became the
           letter s, so /^Default\\b/ matched nothing and the loop burned its whole
           deadline reporting SILENCE beside a transcript that printed the answer.
           Node prints the backspace back as "\\b", which is what disguised it. */
        const childCard = cards.find(card => /^Default\\b/.test(card)) || cards.find(card => card.includes('Default')) || ''
        return {
          /* THE CHILD'S CARD, AND NOTHING ELSE. A previous version also accepted
             the number on "any card that is not the manager's" -- and the tree
             renders a node's reply as a SECOND card that carries no name, so the
             manager working out 391 in its own transcript, unprompted, before the
             child had said a word, satisfied that clause. A false PASS, 13
             seconds in, on a run where no message had been sent. The only card
             that proves a message was carried is the one belonging to the agent
             that could not have known the number without one. */
          proofOnChild: spoken(childCard).includes(${JSON.stringify(PROOF)}),
          proofAnywhereSpoken: cards.some(card => spoken(card).includes(${JSON.stringify(PROOF)})),
          refusals: [...document.querySelectorAll('[data-refusal-code]')].map(node => node.getAttribute('data-refusal-code')),
          notSignedIn: /not signed in|Please run \\/login|You are not signed in/i.test(text),
          childCard: spoken(childCard).replace(/\\s+/g, ' ').slice(0, 400),
          tail: text.slice(-700),
        }
      })()`)
      if (seen?.proofOnChild || seen?.refusals?.length || seen?.notSignedIn || Date.now() > deadline) break
      await delay(4000)
    }

    if (seen?.notSignedIn) {
      note('FAIL', `HARNESS STATE: the profile is not signed in, so no model ran. Tail: ${JSON.stringify(seen.tail)}`)
      return
    }
    if (seen?.refusals?.length) {
      note('FAIL', `the start was refused rather than run: ${JSON.stringify(seen.refusals)}`)
      return
    }
    note(seen?.proofOnChild ? 'ok' : 'FAIL',
      seen?.proofOnChild
        ? `THE CHILD LEARNED IT FROM ITS MANAGER: "${PROOF}" is in what the CHILD said, and it is typed nowhere in this run.`
        : `SILENCE: the number never reached the child within 240s. The child said: ${JSON.stringify(seen?.childCard || '')}`)

    console.log('\n[5] do BOTH conversations carry it?')
    /* READ EACH NODE'S WHOLE CONVERSATION, not a 600-character preview of it.
       The first version sliced the card text and then asked whether the number
       was in the slice -- so a run where BOTH agents had the exchange reported
       one, because on the longer card the number is past the cut. A driver that
       truncates its own evidence and then measures the truncation is measuring
       itself. */
    const transcripts = await window.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-tree-chip], .cl-chat, .chip')]
      return cards.map(card => (card.innerText || '').trim()).filter(text => text.length > 0).slice(0, 8)
    })()`)
    const carrying = transcripts.filter(text => text.includes(PROOF))
    note(carrying.length >= 2 ? 'ok' : 'FAIL',
      `${carrying.length} of ${transcripts.length} conversation(s) on the tree carry the exchange`)
    for (const text of transcripts) console.log(`      · ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 320))}`)

    console.log('\n[6] the comms page')
    await window.evaluate(`location.hash = '#/comms'`)
    await delay(4500)
    const comms = await window.evaluate(`(() => {
      const root = document.querySelector('.comms') || document.body
      const text = root.innerText || ''
      return {
        state: root.dataset ? root.dataset.projectionState : null,
        hasSecret: text.includes(${JSON.stringify(PROOF)}),
        hasReader: typeof window.mcAgent?.localMessages === 'function',
        tail: text.slice(0, 700),
      }
    })()`)
    note(comms.hasSecret ? 'ok' : (comms.hasReader ? 'FAIL' : 'info'),
      comms.hasSecret
        ? 'the comms page shows the exchange between the two agents'
        : comms.hasReader
          ? `the page has a message reader and still shows nothing: ${JSON.stringify(comms.tail)}`
          : `this build\'s shell exposes no mc-agent:local-messages reader yet, so the page says so instead of showing an empty conversation. State: ${comms.state}. Text: ${JSON.stringify(comms.tail.slice(0, 300))}`)
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }

  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const finding of failed) console.log(`  FAIL ${finding.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
