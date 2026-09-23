#!/usr/bin/env node

/* WHAT DOES "ACTIVITY ON THIS COMPUTER" ACTUALLY TELL A PERSON?
 *
 * THE REPORT THIS ANSWERS, twice over.
 *
 * FIRST TIME. The owner, on the installed build: the list shows only "Agent run
 * 37 · started" / "did not start" and a relative time. He named the repository
 * whose agent feeds get this right, and what those carry is always the same
 * three things -- which agent, what it was asked, what happened.
 *
 * SECOND TIME, and this file was passing while it was true: "on page 1 this is
 * supposed to be a context flow of all the agents and such we want to see their
 * outputs cleanly." The rows had grown the ask and the agent and still could
 * not show an OUTPUT, because the join read `role` and `message` off the saved
 * node and never read `reply` -- and this driver seeded every node with
 * `reply: ''`, so nothing here could have noticed. A driver that seeds a field
 * empty cannot fail when the field is dropped.
 *
 * WHAT IS SEEDED AND WHAT IS NOT. Four records this computer really keeps:
 *
 *   the signed run ledger    agent-spawn-records.jsonl, written by
 *                            shell/spawn-record.cjs. This driver builds it with
 *                            THE RECORDER ITSELF, in the profile the app will
 *                            read -- so the hash chain, the signature and the
 *                            key are the product's own, not a fixture. A
 *                            hand-written file would fail verification and the
 *                            screen would correctly report a broken record,
 *                            which is a different measurement.
 *   the per-turn record      agent-turn-usage-records.jsonl, written by
 *                            shell/usage-record.cjs, the same way and for the
 *                            same reason. It is where "what it did" comes from.
 *   the saved conversations  the trees a person builds on the computers page,
 *                            in localStorage, now WITH the reply on the node.
 *   the saved transcripts    the per-node excerpt src/session-transcript-store.js
 *                            keeps, which is where the answer comes from for a
 *                            node whose own reply was cleared.
 *
 * Nothing about the READ path is simulated: the page asks the shell over the
 * real channel, joins on the real key, and renders what it is given.
 *
 * AND THEN A REAL AGENT, because the owner asked for a FLOW and a flow that
 * only ever renders history is a photograph with more columns. Part B starts a
 * live agent from the computers page with real presses and real keystrokes,
 * walks to the home screen while it is still working, and reads the row as the
 * words arrive.
 *
 *   node tools/home-activity-substance-qa.mjs
 *   node tools/home-activity-substance-qa.mjs --visible
 *   node tools/home-activity-substance-qa.mjs --recorded-only
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  REPO_ROOT,
  seedMachineRecord,
  stage,
  userDataFor,
} from './test-account-harness.mjs'

const require_ = createRequire(import.meta.url)
/* NEVER the repo root. The old default was process.cwd(), which from the
   repository put eight evidence PNGs at the root of a tree whose release gate
   refuses to build with unreproducible bytes present — the same eight files
   stopped two cut attempts on two different days before the default moved.
   Evidence belongs with its run. */
const SHOTS = process.env.HOME_FLOW_SHOTS
  || mkdtempSync(path.join(tmpdir(), 'home-activity-shots-'))
const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }
const RECORDED_ONLY = process.argv.includes('--recorded-only')

/* The runs this measures, and why each one.
 *
 *   refused   with the code the tree really raises when a build carries no
 *             launcher for the picked type. That is the state the owner was in,
 *             and the row for it used to say only "did not start".
 *   answered  a run that started, was asked something, and ANSWERED. Its reply
 *             is on the node, which is the field the whole owner report is
 *             about. It also has turns in the per-turn record, so its row has to
 *             say what it did.
 *   spoke     a run whose node kept no reply of its own and whose saved
 *             conversation still holds what it said. The answer has to come out
 *             of the conversation or this row is blank on a record that is not.
 *   nowhere   a run in the signed record with NO node anywhere -- exactly what a
 *             start from the agent page leaves behind. There is no ask and no
 *             answer to show, so the row has to SAY that. This is the one that
 *             would otherwise be a silent gap on the glass.
 */
const RUNS = [
  {
    key: 'refused',
    sessionId: 'chat-aaaaaaaa-1111-2222-3333-444444444444',
    result: 'refused',
    reason: 'AGENT_TIER_NO_LAUNCHER',
    role: 'coordinator',
    asked: 'Read the build log and tell me exactly what broke.',
    reply: '',
    transcript: null,
    turns: [],
  },
  {
    key: 'answered',
    sessionId: 'chat-bbbbbbbb-5555-6666-7777-888888888888',
    result: 'started',
    reason: null,
    role: 'worker',
    asked: 'Summarise the release notes in three lines.',
    reply: 'Three lines, in order: the installer is signed now, the tree keeps its own record, and the crash on close is gone.',
    transcript: null,
    turns: [
      { turnId: 'turn-1', status: 'success', tokens: 4210 },
      { turnId: 'turn-2', status: 'success', tokens: 6180 },
    ],
  },
  {
    key: 'spoke',
    sessionId: 'chat-cccccccc-9999-aaaa-bbbb-cccccccccccc',
    result: 'started',
    reason: null,
    role: 'reviewer',
    asked: 'Check the release notes against the commits.',
    reply: '',
    transcript: [
      { who: 'you', text: 'Check the release notes against the commits.' },
      { who: 'agent', text: 'Two of the five notes name commits that are not on this branch.' },
    ],
    turns: [{ turnId: 'turn-3', status: 'error', tokens: 900 }],
  },
  {
    key: 'nowhere',
    sessionId: 'chat-dddddddd-eeee-ffff-0000-111111111111',
    result: 'started',
    reason: null,
    role: null,
    asked: null,
    reply: null,
    transcript: null,
    turns: [{ turnId: 'turn-4', status: 'success', tokens: 1500 }],
  },
]

const RUN_BY_KEY = Object.fromEntries(RUNS.map(run => [run.key, run]))

/* A SHOT OFF A WINDOW THE MACHINE IS NOT SHOWING.
 *
 * Under MC_SMOKE_HEADLESS the window is offscreen, and Page.captureScreenshot on
 * such a window never resolves -- it waits for a frame that will never be
 * serviced, exactly the mechanism src/page-frames.js documents from the other
 * side. Page.setWebLifecycleState('active') is what makes the frame arrive. The
 * shot is EVIDENCE and never a measurement, so a failure here is reported and
 * swallowed rather than allowed to fail a run about the screen's words.
 */
async function shoot(window, file) {
  try {
    await window.session.send('Page.setWebLifecycleState', { state: 'active' })
    const shot = await window.session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  shot  ${file}`)
  } catch (error) {
    console.log(`  shot  could not be taken (${error?.message || error}); the readings above stand on their own`)
  }
}

/* A read that THREW is not a read that found nothing. Anything carrying
   __evaluateThrew is a driver fault and is raised, never printed as a finding. */
function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (!value || typeof value !== 'object') throw new Error(`the page expression for ${what} answered ${JSON.stringify(value)}`)
  return value
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
  await delay(500)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

/* Real keystrokes into a real field: a press to focus, then Input.insertText.
   Never el.value, which fires no input event and proves nothing about a form. */
async function typeReal(window, selector, text) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await window.session.send('Input.insertText', { text })
  await delay(200)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: typeof landed === 'string' && landed.includes(text.slice(0, 20)), landed }
}

/* A native <select> takes arrow keys only through an operating-system popup an
   offscreen window does not have, so it is focused by a real press and then
   walked with real Down presses, with Escape first to dismiss the popup the
   click itself opens. Same gesture tools/claude-tree-start-proof.mjs measured. */
async function chooseByKeyboard(window, selector, wanted) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: focused.why }
  await window.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  for (let step = 0; step < 14; step += 1) {
    const at = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
    if (at === wanted) {
      return { ok: true, label: await window.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n?.options[n.selectedIndex]?.textContent.trim() || '' })()`) }
    }
    await window.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    await delay(120)
  }
  return { ok: false, why: `never reached ${wanted}` }
}

/* The keystore double the recorders' own suites use. Electron's safeStorage
   lives in a running app and this runs in plain Node, so the at-rest encryption
   of the key is stood in for and NOTHING else is: the signing, the hash chain
   and the record shape are all the product's. */
const KEYSTORE = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (buffer) => {
    const stored = buffer.toString('utf8')
    if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
    return Buffer.from(stored.slice(4), 'base64').toString('utf8')
  },
}

/* THE TWO LEDGERS, WRITTEN BY THE PRODUCT'S OWN RECORDERS.
 *
 * Required from this tree's shell/, not from inside the staged archive: plain
 * Node cannot read an asar, and stage() copies THIS shell/ into the archive the
 * app is about to run, so these are the same bytes. */
function seedLedgers(profile) {
  const directory = userDataFor(profile)
  mkdirSync(directory, { recursive: true })
  const { createSpawnRecorder } = require_(path.join(REPO_ROOT, 'shell', 'spawn-record.cjs'))
  const { createUsageRecorder } = require_(path.join(REPO_ROOT, 'shell', 'usage-record.cjs'))
  const runs = createSpawnRecorder({ directory, safeStorage: KEYSTORE })
  const usage = createUsageRecorder({ directory, safeStorage: KEYSTORE })

  for (const run of RUNS) {
    const receipt = runs.record({ action: 'agent_session_start', sessionId: run.sessionId, details: {} })
    runs.record({
      action: 'agent_session_outcome',
      sessionId: run.sessionId,
      details: {},
      outcome: { resolves: receipt.sequence, result: run.result, reason: run.reason },
    })
    for (const turn of run.turns) {
      /* Written through recordTurn(), so the reading below is the shape
         turnUsageFrom() really produces rather than a shape this file invented.
         `basis: 'turn'` is the case both engines land in for a finished turn. */
      usage.recordTurn({
        sessionId: run.sessionId,
        turnId: turn.turnId,
        tier: 'claude-sonnet',
        account: 'personal',
        status: turn.status,
        usage: { basis: 'turn', inputTokens: Math.round(turn.tokens * 0.7), outputTokens: Math.round(turn.tokens * 0.3), totalTokens: turn.tokens },
      })
    }
  }
  return { runs: runs.history({ limit: 40 }), usage: usage.usage({ limit: 40 }) }
}

function treeRecord(computerId) {
  const stamp = new Date().toISOString()
  const saved = RUNS.filter(run => run.role !== null)
  return {
    version: 1,
    computerId,
    trees: [{ id: 'tree-activity-qa', name: 'Activity', createdAt: stamp, updatedAt: stamp, profileId: null }],
    nodes: saved.map((run, index) => ({
      id: `node-activity-${run.key}`,
      treeId: 'tree-activity-qa',
      parentId: index === 0 ? null : `node-activity-${saved[0].key}`,
      role: run.role,
      message: run.asked,
      status: run.result === 'refused' ? 'failed' : 'finished',
      statusNote: '',
      /* THE FIELD THIS DRIVER USED TO SEED EMPTY. With '' here, a join that
         drops the answer looks exactly like a join that keeps it. */
      reply: run.reply,
      tier: 'claude-sonnet',
      sessionId: run.sessionId,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  }
}

function transcriptRecord() {
  const nodes = {}
  for (const run of RUNS) {
    if (!run.transcript) continue
    nodes[`node-activity-${run.key}`] = {
      savedAt: Date.now(),
      threadId: null,
      effort: null,
      lines: run.transcript.map(line => ({ ...line, at: Date.now() })),
    }
  }
  return { v: 1, nodes }
}

async function readRows(window) {
  return window.evaluate(`(function readRuns() {
    return [...document.querySelectorAll('.home-run')].map(row => {
      const line = selector => {
        const node = row.querySelector(selector)
        return node && !node.hidden ? (node.textContent || '').trim() : ''
      }
      return {
        what: line('.run-what'),
        result: line('.run-result'),
        live: line('.run-live'),
        when: line('.run-when'),
        exact: row.querySelector('.run-when')?.title || '',
        agent: line('.run-agent'),
        asked: line('.run-asked'),
        did: line('.run-did'),
        said: line('.run-said'),
        why: line('.run-why'),
        gap: line('.run-gap'),
      }
    })
  })()`)
}

/* Which row belongs to which seeded run. The rows carry the run's own number
   from the signed record and the ledger is written newest-last, so the order the
   screen shows is the reverse of RUNS. Matched on the text the row carries
   rather than on position, because a positional match would silently follow a
   list that had started rendering the wrong rows. */
function rowFor(rows, run) {
  if (run.asked) return rows.find(row => row.asked.includes(run.asked.slice(0, 30))) || null
  /* The run with nothing saved has no text of its own to match on, so it is
     found by elimination: the row carrying neither an ask nor an agent. */
  return rows.find(row => !row.asked && !row.agent) || null
}

async function recordedFlow(window, computerId) {
  console.log('\n[A] the recorded flow')
  const record = treeRecord(computerId)
  const wrote = readOrThrow(await window.evaluate(`(function write() {
    localStorage.setItem(${JSON.stringify(`mc.fleet.trees.v1:${computerId}`)}, ${JSON.stringify(JSON.stringify(record))})
    localStorage.setItem(${JSON.stringify(`mc.fleet.transcripts.v1:${computerId}`)}, ${JSON.stringify(JSON.stringify(transcriptRecord()))})
    const listed = []
    for (let i = 0; i < localStorage.length; i += 1) listed.push(localStorage.key(i))
    return { enumerated: Object.keys(localStorage), listed, length: localStorage.length }
  })()`), 'the write')
  /* THE FACT THAT COST THIS FEATURE ITS FIRST RUN, kept as an assertion so
     nobody has to rediscover it. In this application `localStorage` is not
     Storage: public/durable-storage.js replaces the global with a durable shim
     over the settings file. Object.keys() on it answers the METHOD names, so any
     code that enumerates a shape like that finds no saved key and degrades in
     silence. */
  note(wrote.enumerated.includes('getItem') ? 'ok' : 'info',
    `the packaged app's localStorage is a shim, and Object.keys answers ${JSON.stringify(wrote.enumerated)} -- only length/key(i) finds a saved key`)
  note(wrote.listed.some(key => String(key).startsWith('mc.fleet.trees.v1:')) ? 'ok' : 'FAIL',
    'the saved conversation is in the store the page will read')
  note(wrote.listed.some(key => String(key).startsWith('mc.fleet.transcripts.v1:')) ? 'ok' : 'FAIL',
    'the saved transcript is in the store the page will read')

  await gotoHomeByPress(window)
  await delay(3600)

  const rows = await readRows(window)
  if (!Array.isArray(rows) || rows.length === 0) {
    const seen = await window.evaluate(`(document.querySelector('.home') || document.body).innerText.slice(0, 600)`)
    note('FAIL', `no run rows on the home screen at all. What is there: ${JSON.stringify(seen)}`)
    return
  }
  note('ok', `${rows.length} run row(s) on the glass`)
  for (const row of rows) console.log(`        ${JSON.stringify(row)}`)

  /* ---- the run that was refused ---- */
  const refused = rowFor(rows, RUN_BY_KEY.refused)
  note(refused ? 'ok' : 'FAIL', 'the refused run is on the list')
  if (refused) {
    note(refused.result === 'did not start' ? 'ok' : 'FAIL', `it says what happened: ${JSON.stringify(refused.result)}`)
    note(refused.agent === RUN_BY_KEY.refused.role ? 'ok' : 'FAIL', `it says WHICH agent: ${JSON.stringify(refused.agent)}`)
    note(refused.asked.includes(RUN_BY_KEY.refused.asked) ? 'ok' : 'FAIL', `it says WHAT it was asked: ${JSON.stringify(refused.asked)}`)
    note(refused.why.length > 0 ? 'ok' : 'FAIL', `it says WHY it did not start: ${JSON.stringify(refused.why)}`)
    note(refused.exact.length > 0 ? 'ok' : 'FAIL', `and the exact instant is on the row: ${JSON.stringify(refused.exact)}`)
    /* THE ONE THING THAT WOULD MAKE THIS WORSE THAN BEFORE: a code where a
       sentence belongs. */
    note(/\b[A-Z][A-Z0-9_]{4,}\b/.test(refused.why) ? 'FAIL' : 'ok',
      'the reason is a sentence, not the identifier the record stored')
    /* A run that never started is not asked why it never answered, and is not
       told it recorded no turns. */
    note(refused.gap === '' ? 'ok' : 'FAIL', `a refused run carries no missing-answer line: ${JSON.stringify(refused.gap)}`)
    note(refused.did === '' ? 'ok' : 'FAIL', `a refused run carries no turn line: ${JSON.stringify(refused.did)}`)
  }

  /* ---- the run that ANSWERED, which is the owner's report ---- */
  const answered = rowFor(rows, RUN_BY_KEY.answered)
  note(answered ? 'ok' : 'FAIL', 'the run that answered is on the list')
  if (answered) {
    note(answered.said.includes(RUN_BY_KEY.answered.reply.slice(0, 40)) ? 'ok' : 'FAIL',
      `IT SAYS WHAT THE AGENT SAID BACK: ${JSON.stringify(answered.said)}`)
    note(/^said back/i.test(answered.said) ? 'ok' : 'FAIL', 'the answer reaches the glass labelled')
    note(/2 turns/.test(answered.did) ? 'ok' : 'FAIL', `IT SAYS WHAT THE AGENT DID: ${JSON.stringify(answered.did)}`)
    note(/Sonnet/.test(answered.did) ? 'ok' : 'FAIL', 'the model is named, not printed as the id the record kept')
    note(/10,390|10390/.test(answered.did.replace(/\s/g, '')) ? 'ok' : 'FAIL',
      `the two turns are added, not multiplied or dropped: ${JSON.stringify(answered.did)}`)
    note(answered.gap === '' ? 'ok' : 'FAIL', `a run that answered is not told it said nothing: ${JSON.stringify(answered.gap)}`)
    note(answered.why === '' ? 'ok' : 'FAIL', 'a run that STARTED carries no refusal line')
  }

  /* ---- the run whose answer is only in the saved conversation ---- */
  const spoke = rowFor(rows, RUN_BY_KEY.spoke)
  note(spoke ? 'ok' : 'FAIL', 'the run whose reply was cleared is on the list')
  if (spoke) {
    note(spoke.said.includes('Two of the five notes') ? 'ok' : 'FAIL',
      `the saved conversation answers when the node kept nothing: ${JSON.stringify(spoke.said)}`)
    note(/did not finish/.test(spoke.did) ? 'ok' : 'FAIL',
      `a turn the engine ended with an error is reported as one: ${JSON.stringify(spoke.did)}`)
  }

  /* ---- the run with no record to join to, which must SAY so ---- */
  const nowhere = rowFor(rows, RUN_BY_KEY.nowhere)
  note(nowhere ? 'ok' : 'FAIL', 'the run started outside the tree is on the list')
  if (nowhere) {
    note(nowhere.gap.length > 0 ? 'ok' : 'FAIL',
      `IT SAYS PLAINLY THAT NOTHING WAS SAVED FOR IT: ${JSON.stringify(nowhere.gap)}`)
    note(nowhere.asked === '' ? 'ok' : 'FAIL', 'and it invents no ask that was never recorded')
    note(/1 turn/.test(nowhere.did) ? 'ok' : 'FAIL',
      `it still shows what the turn record knows about it: ${JSON.stringify(nowhere.did)}`)
  }

  /* ---- nothing under the list ----
     The footer used to be three sentences on every healthy record (the record
     checks out, how many started, no ending is written down); the owner, with
     the card in front of him: "this little dialog box is kind of pointless".
     src/local-activity.js recordFooter now says nothing for a record that
     checks out and speaks only when the record NO LONGER does -- and this
     driver wrote the record with the product's own recorder, so it checks out.
     Read as the glass reads it: a hidden slot is an empty one. */
  await shoot(window, path.join(SHOTS, 'home-activity-recorded.png'))
  const footer = await window.evaluate(`(() => { const foot = document.querySelector('[data-panel-foot]'); return foot && !foot.hidden ? (foot.textContent || '').trim() : '' })()`)
  note(footer === '' ? 'ok' : 'FAIL',
    `a record that checks out carries no paragraph under the list: ${JSON.stringify(footer)}`)
  const everything = rows.map(row => Object.values(row).join(' ')).join(' ')
  note(/\bran for\b|\btook \d|\blasted\b|\bfinished in\b/i.test(everything) ? 'FAIL' : 'ok',
    'and no row claims a length that nothing recorded')
}

/* The page strip is arrows, not links (src/main.js #nav-back / #nav-next), so
   the way to the home screen is the arrow a person presses. Bounded, and it
   reports the route it actually reached rather than assuming one press did it. */
async function gotoHomeByPress(window) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const at = await window.evaluate(`location.hash`)
    if (at === '#/' || at === '' || at === '#') break
    const back = await press(window, '#nav-back', 6000)
    if (!back.pressed) {
      note('FAIL', `HARNESS STATE: the back arrow was not pressable (${back.why}), so this run never reached the home screen`)
      return false
    }
    await delay(1400)
  }
  const landed = await window.evaluate(`location.hash`)
  const home = landed === '#/' || landed === '' || landed === '#'
  note(home ? 'ok' : 'FAIL', `walked to the home screen with the page arrow; the route is ${JSON.stringify(landed)}`)
  return home
}

/* ==================================================================
   PART B. A REAL AGENT, WATCHED FROM THE HOME SCREEN.
   ================================================================== */

const LIVE_TIER = 'claude-sonnet'
/* LONG ENOUGH TO STILL BE RUNNING WHEN THE SCREEN IS REACHED, and this number
   was raised twice by measurement rather than guessed. One short sentence was
   over in eleven tokens. Sixty numbers was 180 tokens and about three seconds,
   which is shorter than the walk to the home screen -- that run saw the finished
   answer and never the working badge, and reported a FAIL that was a fact about
   the harness rather than about the screen. Four hundred streams for long enough
   that the badge is observable without the run depending on a race, and the word
   at the end is what proves the whole answer arrived rather than its first
   frame.

   AND THE MARKER WORD GOES FIRST, which the run that put it last discovered the
   hard way. The row clips a long answer, correctly and on purpose, so a word at
   the end of four hundred lines is a word the screen will never show -- the
   driver was asking the product to break its own clipping rule and calling the
   refusal a defect. First line, and the long tail behind it is only there to
   keep the turn streaming. */
const LIVE_PROMPT = 'Write the single word Cormorant on the first line, then count from 1 to 400, one number per line. Do not say anything else.'
const LIVE_WORD = 'Cormorant'

async function liveFlow(window) {
  console.log('\n[B] a real agent, watched from the home screen')
  /* ASKED UNTIL IT SETTLES, because the answer right after a reload is not the
     answer. The capability layer starts alongside the window and reports
     AGENT_ENGINE_UNAVAILABLE until it has resolved, and a single read taken at
     the wrong moment turns a working computer into a harness refusal -- observed
     once on this file. Bounded, and the LAST answer is the one reported. */
  let availability = 'null'
  const ready = Date.now() + 30_000
  for (;;) {
    availability = await window.evaluate(`window.mcAgent ? window.mcAgent.availability().then(r => JSON.stringify(r)) : 'null'`)
    if (String(availability).includes('"ok":true') || Date.now() > ready) break
    await delay(1500)
  }
  note('info', `this computer reports availability ${availability}`)
  if (!String(availability).includes('"ok":true')) {
    note('FAIL', 'HARNESS STATE: no agent can start on this computer, so the live half of the flow was not measured. That is a state of the machine, not a finding about the screen.')
    return
  }

  await window.evaluate(`location.hash = '#/computers'`)
  await delay(2600)
  const doorway = await press(window, '.computers .tree-empty-node')
  if (!doorway.pressed) {
    note('FAIL', `HARNESS STATE: the way into the start panel was not pressable (${doorway.why})`)
    return
  }
  await delay(2400)

  const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', LIVE_TIER)
  note(tier.ok ? 'ok' : 'FAIL', `chose ${LIVE_TIER} with real arrow keys: ${tier.ok ? JSON.stringify(tier.label) : tier.why}`)
  if (!tier.ok) return
  const firstRole = await window.evaluate(`(() => {
    const node = document.querySelector('[data-compose-field="role"]')
    return node ? ([...node.options].map(o => o.value).find(v => v && v.length > 0) || null) : null
  })()`)
  if (!firstRole) { note('FAIL', 'HARNESS STATE: no role menu on the start panel'); return }
  const role = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
  note(role.ok ? 'ok' : 'FAIL', `chose a role: ${role.ok ? JSON.stringify(role.label) : role.why}`)
  if (!role.ok) return

  const typed = await typeReal(window, '[data-compose-field="message"]', LIVE_PROMPT)
  note(typed.ok ? 'ok' : 'FAIL', `typed the brief with real keystrokes: ${JSON.stringify(typed.landed || typed.why)}`)
  if (!typed.ok) return

  const startSelector = await window.evaluate(`(() => {
    const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'home-flow-start-target'
    return { selector: '#' + btn.id, disabled: btn.disabled === true }
  })()`)
  if (!startSelector) { note('FAIL', 'HARNESS STATE: there is no Start control on the panel'); return }
  const started = await press(window, startSelector.selector)
  note(started.pressed ? 'ok' : 'FAIL', `pressed Start${started.pressed ? '' : `: ${started.why}`}`)
  if (!started.pressed) return

  /* Straight to the home screen while the agent is still working, with no wait
     that is not the product's own. This is the whole point: the list has to move
     while somebody is looking at it. */
  if (!(await gotoHomeByPress(window))) return

  const deadline = Date.now() + 180_000
  let sawWorking = false
  let sawWords = false
  let lastRows = []
  /* EVERY FRAME IS CHECKED FOR THE CONTRADICTION, not only the last one. The
     pair it is looking for lives in the beat between the signed record having
     the run and saved storage having the node, which is over in about a second
     -- a check on the final reading would look straight past it. */
  const contradictions = []
  while (Date.now() < deadline && !(sawWorking && sawWords)) {
    const rows = await readRows(window)
    if (Array.isArray(rows)) {
      lastRows = rows
      if (rows.some(row => row.live.length > 0)) {
        /* THE SHOT IS TAKEN THE FIRST TIME THE BADGE IS UP, not at the end of
           the loop. A first version shot after both flags were satisfied, by
           which time the turn had finished and the badge was correctly gone --
           so the evidence image showed the opposite of what the reading said. */
        if (!sawWorking) await shoot(window, path.join(SHOTS, 'home-activity-live.png'))
        sawWorking = true
      }
      if (rows.some(row => row.said.includes(LIVE_WORD))) sawWords = true
      for (const row of rows) if (row.said && row.gap) contradictions.push(row)
    }
    await delay(400)
  }
  note(sawWorking ? 'ok' : 'FAIL',
    'the row said it was WORKING while the turn was running, with no press or reload in between')
  note(contradictions.length === 0 ? 'ok' : 'FAIL',
    `no row shows an answer and a sentence saying no answer was saved, which is the pair this screen exists to make unreachable: ${JSON.stringify(contradictions.slice(0, 2))}`)
  note(sawWords ? 'ok' : 'FAIL',
    `the row showed what the agent said, live: ${JSON.stringify(lastRows.find(row => row.said.includes(LIVE_WORD))?.said || null)}`)
  for (const row of lastRows) console.log(`        ${JSON.stringify(row)}`)

  /* And after the turn ends, the claim is withdrawn and the turn record has
     something in it. */
  const settle = Date.now() + 60_000
  let after = lastRows
  while (Date.now() < settle) {
    after = await readRows(window)
    if (Array.isArray(after) && after.some(row => row.said.includes(LIVE_WORD) && row.live === '' && row.did.length > 0)) break
    await delay(1500)
  }
  const finished = (after || []).find(row => row.said.includes(LIVE_WORD))
  note(finished && finished.asked.length > 0 ? 'ok' : 'FAIL',
    `and the brief the person typed reaches the row without a reload: ${JSON.stringify(finished?.asked ?? null)}`)
  note(finished && finished.live === '' ? 'ok' : 'FAIL',
    `the live claim is withdrawn when the turn ends: ${JSON.stringify(finished?.live ?? null)}`)
  note(finished && finished.did.length > 0 ? 'ok' : 'FAIL',
    `and the turn the agent just took is counted from the record: ${JSON.stringify(finished?.did ?? null)}`)
  await shoot(window, path.join(SHOTS, 'home-activity-after-turn.png'))
}

/* The sign-in a Claude child needs, borrowed into the scratch profile for the
   lifetime of this run and removed with it. openWindow() isolates USERPROFILE
   and APPDATA on purpose, so a child started under it looks for a sign-in in a
   home that has never had one. Same borrow, same reasoning, as
   tools/claude-tree-start-proof.mjs. */
function lendClaudeSignIn(scratch) {
  const realHome = process.env.USERPROFILE || ''
  const credential = path.join(realHome, '.claude', '.credentials.json')
  if (!existsSync(credential)) return false
  const scratchClaude = path.join(scratch, 'home', '.claude')
  mkdirSync(scratchClaude, { recursive: true })
  cpSync(credential, path.join(scratchClaude, '.credentials.json'))
  const settings = path.join(realHome, '.claude.json')
  if (existsSync(settings)) cpSync(settings, path.join(scratch, 'home', '.claude.json'))
  const realNpm = path.join(process.env.APPDATA || '', 'npm')
  if (existsSync(realNpm)) {
    mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
    try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* already linked */ }
  }
  return true
}

/* TWO PROFILES, AND THE REASON IS A MEASUREMENT.
 *
 * Part A seeds both ledgers with the product's own recorders under a KEYSTORE
 * DOUBLE, because plain Node has no Electron safeStorage. The app can read
 * those records back -- history() and usage() only need the chain -- but it
 * cannot decrypt the signing key with its real keystore, so
 * mc-agent:availability answers SPAWN_RECORD_KEY_UNREADABLE and the product
 * correctly refuses to START anything. That refusal is right. It also means a
 * live agent cannot be measured in the same profile, and a first version of
 * this file discovered that by reporting the refusal as a harness state.
 *
 * So the live half gets its OWN profile with nothing seeded at all. The app
 * mints its own key, a real agent runs, and every record the rows below read is
 * one the product wrote about work it really did. That is a better measurement
 * than the seeded half, not a workaround for it.
 */
async function recordedRun() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'home-activity-recorded-'))
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')

    const seeded = seedLedgers(scratch)
    if (!seeded.runs || seeded.runs.ok !== true) {
      note('FAIL', `HARNESS STATE: the recorder would not write a ledger (${seeded.runs && seeded.runs.code}); nothing below is a measurement.`)
      return
    }
    note('ok', `wrote ${seeded.runs.entries.length} run record(s) with the product's own recorder; the chain verifies: ${seeded.runs.verified}`)
    note(seeded.usage?.ok === true ? 'ok' : 'FAIL',
      `wrote ${seeded.usage?.entries?.length ?? 0} per-turn record(s) with the product's own recorder; the chain verifies: ${seeded.usage?.verified}`)
    /* THE FIELD THIS WHOLE FEATURE HANGS ON, checked at the source before the
       page is asked. If history() stopped carrying the join key, the rows below
       would degrade silently to what they showed before -- a pass this driver
       must never award. */
    const key = seeded.runs.entries.find(entry => entry.sessionId === RUNS[0].sessionId)
    note(key ? 'ok' : 'FAIL', `the record hands the page a session to join on: ${JSON.stringify(key?.sessionId || null)}`)
    if (!key) return

    window = await openWindow(staged.executable, scratch)
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3600)
    const computerId = await window.evaluate(`window.__mcGraph?.computer?.id || null`)
    if (!computerId) {
      note('FAIL', 'HARNESS STATE: no computer on the page, so there is no tree record to save conversations into.')
      return
    }
    await recordedFlow(window, computerId)
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }
}

async function liveRun() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'home-activity-live-'))
  let window = null
  try {
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    const lent = lendClaudeSignIn(scratch)
    note('info', lent
      ? 'lent the scratch profile this computer\'s Claude sign-in; it lives only in the temporary profile this run deletes.'
      : 'this computer has no Claude sign-in to lend, so the live half will report a harness state rather than a finding.')
    note('info', 'NOTHING is seeded in this profile: every record the rows below read is one the product writes about work it really does.')
    window = await openWindow(staged.executable, scratch)
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3600)
    await liveFlow(window)
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }
}

async function main() {
  await recordedRun()
  if (!RECORDED_ONLY) await liveRun()

  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
