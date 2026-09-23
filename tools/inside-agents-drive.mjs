#!/usr/bin/env node
/* START A REAL AGENT FROM INSIDE THE PRODUCT AND GIVE IT REAL WORK.
 *
 * The owner, 2026-08-19: "i would like you also launch claude opus5 ultracode
 * agents from inside the software and ask them to begin utilizing differnt
 * tools and looking for things that dont work and you should be able to prompt
 * them and get them to do real work and fix real stuff with the program".
 *
 * SUCCESS IS A CHANGE ON DISK, NOT A SENTENCE ON SCREEN. The agent is asked to
 * WRITE A FILE whose contents it has to compute, and this driver then reads
 * that file from outside the application. A model saying it used a tool is not
 * evidence -- a sibling lane proved a fully permission-denied session still
 * produced prose claiming it had called one. A file that exists, in a directory
 * this driver created empty, containing a number that appears nowhere in the
 * prompt, cannot be produced by prose.
 *
 * HOW IT SIGNS IN, AND WHY IT IS A JUNCTION AND NEVER A COPY.
 * openWindow() redirects USERPROFILE/APPDATA/LOCALAPPDATA/CODEX_HOME into the
 * scratch profile -- non-negotiable, because a driver run against the real home
 * once desynced the owner's audit ledger. A child started under that redirect
 * finds no sign-in. The committed pattern (tools/claude-tree-start-proof.mjs)
 * solves it by COPYING ~/.claude/.credentials.json into the scratch home. This
 * file does not, and the distinction is the whole safety argument:
 *
 *   A COPY GIVES ONE CREDENTIAL TWO IDENTITIES. When the CLI refreshes, it
 *   renames a new token over the copy, and the owner's own home is left holding
 *   a superseded one. His sign-in dies with no visible cause.
 *
 *   A JUNCTION GIVES ONE DIRECTORY AND ONE FILE. A refresh is a rename inside
 *   the real directory -- byte for byte what happens when he runs the CLI
 *   himself. There is no second copy to rotate out from under him. The risk is
 *   the risk of him having two terminals open.
 *
 * Nothing here opens, reads, copies, moves or prints a credential.
 *
 * WHAT A JUNCTION DOES NOT BUY, stated so no one quotes this run for it: there
 * is NO memory isolation. A junctioned session reads the owner's own
 * ~/.claude/CLAUDE.md. This run is evidence that a session STARTS and REACHES
 * TOOLS. It is not evidence about confinement.
 *
 * NEVER RECURSIVELY COPY A PROFILE THAT CONTAINS A JUNCTION. cpSync follows it
 * and materialises the real auth store into the copy, silently converting the
 * safe mechanism into the forbidden one. Profiles here are built fresh.
 *
 *   node tools/inside-agents-drive.mjs --tier=claude-sonnet
 *   node tools/inside-agents-drive.mjs --tier=luna --visible
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  closeWindow, delay, openWindow, scratchDirectory, seedMachineRecord, stage,
} from './test-account-harness.mjs'

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* THE ANSWER MUST NOT BE IN THE QUESTION. If the proof string appeared in the
   prompt, a check for it would match this driver's own typing and report a
   result on a run where no agent ever spoke. Executable, not a comment,
   because this exact trap has burned two files in this tree. */
const JOBS = {
  /* ARITHMETIC THE MODEL MUST ACTUALLY DO, LANDED AS A FILE. The proof value
     appears nowhere in the prompt, so a check for it cannot match this driver's
     own typing. */
  proof: {
    file: 'AGENT-PROOF.txt',
    word: '391',
    text: [
      'Do this now, using your tools, and keep it short.',
      '1. Work out 17 multiplied by 23.',
      '2. Create a file named AGENT-PROOF.txt in your current working folder containing ONLY that number.',
      '3. Read the file back and reply with the absolute path you wrote and the exact contents.',
    ].join(' '),
  },
  /* WHAT TOOLS CAN THIS SESSION ACTUALLY REACH? The owner: agents should "begin
     utilizing differnt tools and looking for things that dont work". A model
     listing tool names proves nothing -- a permission-denied session will still
     write a confident list. So the job demands a RESULT that only a real call
     can produce, and it demands the failure in writing too, which is the more
     valuable outcome of the two. */
  tools: {
    file: 'TOOLS-REPORT.txt',
    word: null,
    text: [
      'Do this now and keep it short. Write everything into ONE file named TOOLS-REPORT.txt in your current working folder.',
      'Line 1: write CONNECTED if you have any MCP tool available whose name contains "toolsenabled", otherwise write NONE.',
      'Then list the exact names of every MCP tool you can call, one per line.',
      'Then actually CALL one read-only tool and paste its RAW result under a line reading RESULT:.',
      'If a call fails, paste the exact error text instead. Do not summarise and do not guess: if you cannot reach a tool, say so and write the error.',
    ].join(' '),
  },
  /* THE HUNT THE OWNER ASKED FOR: "anything that it gets stuck on or tools that
     dont work or get stuck etc need to either be built or fixed or wired
     correctlly."

     A SIBLING LANE ALREADY SWEPT ALL 272 TOOLS ON THE CODEX/luna LEG, so
     repeating that would spend the owner's money to learn nothing. What has
     never been swept is the CLAUDE leg, which only became able to reach tools
     tonight. This is that, kept to read-only calls and a small enough set to be
     cheap.

     THE FORMAT IS PINNED because the verdict is read from the FILE, never from
     the conversation. A refusal written down verbatim is a result; a refusal
     summarised is an opinion. The memory pair is here because a set followed by
     a get is the one cheap test that proves a value really persisted rather
     than being echoed back. */
  sweep: {
    file: 'TOOL-SWEEP.txt',
    word: null,
    text: [
      'Do this now. Call each of these ToolsEnabled MCP tools ONCE, in order, with minimal/default arguments, and record what really happened.',
      'system_doctor, audit_status, audit_verify, settings_read, task_list, workspace_list, window_list, search_status, research_local_tiers_status, agent_comms_local_roster, memory_set (key "inside-agents-probe", value "kestrel-vault-77"), memory_get (key "inside-agents-probe").',
      'Write ONE file named TOOL-SWEEP.txt in your current working folder.',
      'For each tool write exactly one block: a line "TOOL: <name>", then a line "OUTCOME: OK" or "OUTCOME: FAIL", then a line "RAW:" followed by the first 300 characters of the raw result or the exact error text.',
      'Never guess and never summarise. If a tool refuses, that is a valid OUTCOME: FAIL and the exact refusal is what I want.',
      'Finally add a line "MEMORY ROUNDTRIP: <the exact value memory_get returned>".',
    ].join(' '),
  },
}
const JOB = JOBS[(process.argv.find(a => a.startsWith('--job=')) || '--job=proof').split('=')[1]] || JOBS.proof
const PROOF_WORD = JOB.word
const PROOF_FILE = JOB.file
const TASK = JOB.text
if (PROOF_WORD && TASK.includes(PROOF_WORD)) {
  throw new Error('the answer is inside the question; this run could only measure its own typing')
}

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(420)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function key(window, key_, code) {
  for (const type of ['keyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, key: key_, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    })
    await delay(40)
  }
}

/* Escape first: pressing a native <select> opens an OS popup, and while it is
   open the first ArrowDown goes to the popup rather than the element. */
async function chooseByKeyboard(window, selector, wantedValue, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus: ${focused.why}`, seen: [] }
  await key(window, 'Escape', 27)
  await delay(120)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  const seen = []
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await valueNow()
    seen.push(current)
    if (current === wantedValue) {
      const label = await window.evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        return n ? [...n.options].find(o => o.value === n.value)?.textContent.trim().slice(0, 60) : null
      })()`)
      return { ok: true, presses: i, label, seen }
    }
    await key(window, 'ArrowDown', 40)
    await delay(90)
  }
  return { ok: false, why: `never reached ${wantedValue}`, seen }
}

async function shot(window, scratch, name) {
  try {
    try { await window.session.send('Page.enable', {}) } catch { /* already */ }
    await window.session.send('Page.setWebLifecycleState', { state: 'active' })
    await delay(220)
    /* `fromSurface: false` is load-bearing: a window opened with show:false
       under MC_SMOKE_HEADLESS=1 is not compositing, so the default surface
       capture never settles. */
    const packet = await Promise.race([
      window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
      delay(12_000).then(() => null),
    ])
    if (!packet?.data) return { ok: false, why: 'captureScreenshot did not return' }
    const file = path.join(scratch, `${name}.png`)
    writeFileSync(file, Buffer.from(packet.data, 'base64'))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, why: String(error && error.message || error) }
  }
}

/* EVERY PLACE THE PANEL CAN PUT A SENTENCE. The first version of this driver
   watched only [data-compose-status] and [data-org-status], both empty, and
   called a press that HAD been answered "SILENCE" -- the panel had painted
   "Pick a role first, then press Start." next to the role field. That was this
   driver's defect, not the product's, and the fix is to read every problem and
   status slot the panel owns rather than the two I first thought of. */
const PANEL_STATE = `(() => {
  const txt = n => (n ? n.textContent.replace(/\\s+/g, ' ').trim() : '')
  const all = sel => [...document.querySelectorAll(sel)].map(txt).filter(Boolean)
  const nodes = [...document.querySelectorAll('.computers .static-tree-node')]
  return {
    status: all('[data-compose-status]').join(' | ').slice(0, 400),
    problems: all('[data-compose-problem]').join(' | ').slice(0, 400),
    notice: all('[data-compose-notice]').join(' | ').slice(0, 300),
    org: all('[data-org-status], .org-status, [role="status"]').join(' | ').slice(0, 400),
    nodes: nodes.length,
    statuses: nodes.map(n => n.getAttribute('data-status')).filter(Boolean).slice(0, 8),
    transcript: all('.tree-rail [data-transcript-row], [data-session-transcript] *').slice(-6).join(' // ').slice(0, 900),
  }
})()`

function junction(from, to, label) {
  try {
    if (!existsSync(from)) return `${label}: source missing (${from})`
    if (existsSync(to)) return `${label}: already present at ${to}`
    mkdirSync(path.dirname(to), { recursive: true })
    symlinkSync(from, to, 'junction')
    const s = statSync(to)
    return `${label}: junction ${to} -> ${from} (reachable=${s.isDirectory()})`
  } catch (error) {
    return `${label}: FAILED ${String(error && error.message || error)}`
  }
}

/* Everything that appeared under the workspace since the run began. This is
   the evidence: the driver made these directories and they were empty. */
function walkFor(root, name, depth = 4) {
  const hits = []
  const walk = (dir, level) => {
    if (level > depth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, level + 1)
      else if (entry.name === name) hits.push(full)
    }
  }
  walk(root, 0)
  return hits
}

async function main() {
  const scratch = scratchDirectory('inside-agents')
  const tier = (process.argv.find(a => a.startsWith('--tier=')) || '--tier=claude-sonnet').split('=')[1]
  const role = (process.argv.find(a => a.startsWith('--role=')) || '--role=Default').split('=')[1]

  /* THE BUILD CARRIES THIS TREE'S RENDERER AND THIS TREE'S PAYLOAD. stage()
     overlays dist/ and shell/ and copies capability/ over the packaged one, so
     the Claude tools leg that landed tonight is what runs -- not the older
     engine inside the last cut. */
  const staged = await stage(scratch)
  note('info', `staged build at ${staged.executable}`)

  seedMachineRecord(scratch, staged.appRoot, 'standard')

  /* SIGN-IN BY JUNCTION. See the header: one directory, one file, no copy. */
  const home = process.env.USERPROFILE || ''
  note('info', junction(path.join(home, '.codex'), path.join(scratch, 'home', '.codex'), 'codex home'))
  note('info', junction(path.join(home, '.claude'), path.join(scratch, 'home', '.claude'), 'claude home'))
  note('info', junction(path.join(process.env.APPDATA || '', 'npm'), path.join(scratch, 'roaming', 'npm'), 'npm layout'))
  note('info', 'NO credential was opened, read, copied or printed; the child CLI opens the real store itself')

  /* SEARCHED FROM THE PROFILE ROOT, NOT FROM THE WORKSPACE I SEEDED. The first
     run of this file looked only under <profile>/home/ToolsEnabled -- the path
     in the machine record -- and reported "the agent did not perform the job"
     about a run where the agent HAD written the file, in
     <profile>/userdata/workspace, which is where a session with no configured
     profile actually starts. That was this driver's defect and it is the kind
     that invents a product bug out of nothing. The whole profile is the search
     root now, so where the agent chose to work cannot change the verdict. */
  const workspace = path.join(scratch, 'home', 'ToolsEnabled')
  mkdirSync(workspace, { recursive: true })
  const searchRoot = scratch
  const before = walkFor(searchRoot, PROOF_FILE)
  note('info', `searching all of ${searchRoot}; ${PROOF_FILE} present before the run: ${before.length}`)

  const window = await openWindow(staged.executable, scratch)
  note('info', `window pid=${window.timeline.pid} cdp=${window.port}`)

  try {
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(3200)

    const startable = await window.evaluate(`(async () => {
      try { return await window.mcAgent.startableTiers() } catch (e) { return { threw: String(e && e.message || e) } }
    })()`)
    note('info', `LIVE startableTiers(): ${JSON.stringify(startable)}`)
    const availability = await window.evaluate(`(async () => {
      try { return await window.mcAgent.availability() } catch (e) { return { threw: String(e && e.message || e) } }
    })()`)
    note('info', `LIVE availability(): ${JSON.stringify(availability)}`)

    const wayIn = await press(window, '.computers .tree-empty-node')
    note(wayIn.pressed ? 'info' : 'WARN', wayIn.pressed ? 'pressed the empty slot' : `empty slot: ${wayIn.why}`)
    await delay(1800)

    const switchPresent = await window.evaluate(`Boolean(document.querySelector('[data-compose-unavailable-action="panel"]'))`)
    if (switchPresent) {
      const turned = await press(window, '[data-compose-unavailable-action="panel"]')
      note(turned.pressed ? 'info' : 'WARN', turned.pressed ? 'turned on running agents from the panel' : `switch: ${turned.why}`)
      await delay(1600)
    }

    /* THE ROLE IS REQUIRED AND THE PANEL SAYS SO. Skipping it is what made the
       first run of this driver misreport a refusal as silence. */
    const gotRole = await chooseByKeyboard(window, '[data-compose-field="role"]', role)
    note(gotRole.ok ? 'info' : 'WARN', gotRole.ok ? `role: "${gotRole.label}"` : `role: ${gotRole.why} (saw ${JSON.stringify(gotRole.seen)})`)

    const gotTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', tier)
    note(gotTier.ok ? 'info' : 'WARN', gotTier.ok ? `tier: "${gotTier.label}" after ${gotTier.presses} press(es)` : `tier: ${gotTier.why} (saw ${JSON.stringify(gotTier.seen)})`)
    if (!gotTier.ok) return

    const typed = await window.typeInto('[data-compose-field="message"]', TASK)
    note(typed === 'typed' ? 'info' : 'WARN', `typed the job: ${typed}`)

    const s1 = await shot(window, scratch, '01-filled')
    note(s1.ok ? 'info' : 'WARN', s1.ok ? `shot ${s1.file}` : `no shot: ${s1.why}`)

    const started = await press(window, '[data-compose-action="start"]')
    note(started.pressed ? 'info' : 'WARN', started.pressed ? 'pressed Start this agent' : `Start: ${started.why}`)

    const timeline = []
    let done = false
    for (let i = 0; i < 80 && !done; i += 1) {
      await delay(4000)
      const state = await window.evaluate(PANEL_STATE)
      const line = JSON.stringify(state)
      if (timeline[timeline.length - 1] !== line) { timeline.push(line); note('info', `t+${(i + 1) * 4}s ${line.slice(0, 700)}`) }
      /* THE ONLY THING THAT ENDS THE WATCH EARLY IS EVIDENCE ON DISK. A
         transcript that looks finished is not the measurement. */
      if (walkFor(searchRoot, PROOF_FILE).length > 0) { done = true }
    }

    const s2 = await shot(window, scratch, '02-after')
    note(s2.ok ? 'info' : 'WARN', s2.ok ? `shot ${s2.file}` : `no shot: ${s2.why}`)

    /* ---- THE MODEL MENU, ON A LIVE SESSION ---------------------------- *
     * Driven proof for the fix in src/fleet-tree-copy.js sessionModelChoices().
     * The rows used to read "Claude — cannot start here yet" and enable only
     * `tier.provider === 'codex'`, which on a CLAUDE conversation offered the
     * one switch the engine silently ignores. This opens the real menu on the
     * real session and writes down what a person would read. */
    if (process.argv.includes('--verify-menu')) {
      /* THE RAIL HAS TO BE OPEN BEFORE THE ACTIONS BUTTON EXISTS. The first
         attempt pressed [data-chat-actions] straight after the start and got
         "absent" -- because nothing had opened the agent's detail rail, which is
         where that button lives. Driver gap, not a product one. */
      const nodeOpened = await press(window, '.computers .static-tree-node')
      note(nodeOpened.pressed ? 'info' : 'WARN', nodeOpened.pressed ? 'opened the agent node' : `node: ${nodeOpened.why}`)
      await delay(1500)
      const opened = await press(window, '[data-chat-actions]')
      note(opened.pressed ? 'info' : 'WARN', opened.pressed ? 'opened the actions popup' : `actions popup: ${opened.why}`)
      await delay(900)
      const intoModel = await window.evaluate(`(() => {
        const rows = [...document.querySelectorAll('button')]
        const row = rows.find(b => /switch model|what it runs on/i.test(b.textContent || ''))
        if (!row) return { found: false, sample: rows.map(b => (b.textContent||'').trim().slice(0,40)).filter(Boolean).slice(0,20) }
        const box = row.getBoundingClientRect()
        return { found: true, x: box.left + box.width/2, y: box.top + box.height/2, text: row.textContent.trim().slice(0,80), disabled: row.disabled === true }
      })()`)
      note('info', `switch-model row: ${JSON.stringify(intoModel).slice(0, 400)}`)
      if (intoModel?.found && !intoModel.disabled) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await window.session.send('Input.dispatchMouseEvent', {
            type, x: intoModel.x, y: intoModel.y, button: type === 'mouseMoved' ? 'none' : 'left',
            clickCount: type === 'mouseMoved' ? 0 : 1,
          })
          await delay(50)
        }
        await delay(900)
        const rows = await window.evaluate(`(() => [...document.querySelectorAll('button')]
          .map(b => ({ text: (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200), disabled: b.disabled === true }))
          .filter(r => /luna|terra|sol|fable|sonnet|opus|local|keep the tier/i.test(r.text)))()`)
        note('info', `MODEL MENU ON A LIVE ${tier.toUpperCase()} SESSION: ${JSON.stringify(rows, null, 1).slice(0, 2500)}`)
        const lies = rows.filter(r => /cannot start here yet/i.test(r.text))
        note(lies.length === 0 ? 'PASS' : 'FAIL', lies.length === 0
          ? 'no row claims Claude "cannot start here yet" — the false label is gone'
          : `${lies.length} row(s) still claim "cannot start here yet": ${JSON.stringify(lies)}`)
      }
      const s3 = await shot(window, scratch, '03-model-menu')
      note(s3.ok ? 'info' : 'WARN', s3.ok ? `shot ${s3.file}` : `no shot: ${s3.why}`)
    }

    /* ---- THE VERDICT, FROM THE FILESYSTEM ---------------------------- */
    const hits = walkFor(searchRoot, PROOF_FILE)
    if (hits.length === 0) {
      note('FAIL', `no ${PROOF_FILE} anywhere under ${searchRoot}: the agent did not perform the job (see the timeline for what the product said)`)
    } else {
      for (const hit of hits) {
        const body = readFileSync(hit, 'utf8').trim()
        if (!PROOF_WORD) {
          note('PASS', `${hit} written by the agent (${body.length} bytes) -- a real tool call landed it`)
          note('info', `--- ${PROOF_FILE} BEGIN ---\n${body.slice(0, 4000)}\n--- ${PROOF_FILE} END ---`)
        } else {
          const right = body.includes(PROOF_WORD)
          note(right ? 'PASS' : 'FAIL', `${hit} contains ${JSON.stringify(body.slice(0, 120))}${right ? ' -- the agent really ran a tool and really did the arithmetic' : ' -- file written but the value is wrong'}`)
        }
      }
    }

    const finalText = await window.evaluate(`(document.querySelector('.stage') || document.body).innerText.replace(/\\s+/g,' ').trim().slice(0, 2000)`)
    note('info', `FINAL STAGE TEXT: ${finalText}`)
    writeFileSync(path.join(scratch, 'findings.json'), JSON.stringify({ findings, startable, availability, timeline, hits, finalText }, null, 2))
    note('info', `evidence in ${scratch}`)
  } finally {
    await closeWindow(window)
  }
}

main().catch(error => {
  note('FAIL', `driver threw: ${String(error && error.stack || error)}`)
  process.exitCode = 1
})
