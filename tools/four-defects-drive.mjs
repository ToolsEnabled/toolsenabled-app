#!/usr/bin/env node

/* THE FOUR DEFECTS, DRIVEN ON A STAGED PACKAGED BUILD.
 *
 * Every claim in the report this produces is a thing the application did while
 * a real mouse press landed on a real control at real coordinates, measured
 * with document.elementFromPoint before the press (tools/test-account-harness.mjs
 * owns that rig; this file is a driver for it).
 *
 * WHAT IT DRIVES, one scenario per defect:
 *
 *   A  PERMISSION LEVEL. Press a level button in Settings -> Setup and watch
 *      BOTH the machine record on disk and the row on the glass. The defect was
 *      that the first moved and the second never did, and that the section went
 *      dead in the same breath.
 *
 *   B  THE ZOMBIE. Leave a node saved mid-turn -- the exact record an app closed
 *      during a turn leaves behind -- reopen the profile, and read the circle:
 *      is the runtime clock ticking over a process that does not exist, is
 *      Resume refused for being busy, is Stop offered over a corpse.
 *
 *   C  THE REVIEW'S CLAIM ABOUT CODEX, measured with Codex genuinely absent from
 *      PATH. The sentence used to flip on whether CLAUDE was installed.
 *
 *   D  THE PROMISE. A profile that answered "Nothing yet -- let me look around
 *      first" presses the dashed circle on the fleet page, and nothing may reach
 *      the engine.
 *
 * IT IS A MEMBER OF tools/packaged-qa-suite.mjs, AND RUNS AT EVERY CUT.
 * This paragraph used to say the opposite -- that the suite globs for
 * `-qa.(mjs|cjs)`, that this file deliberately did not match, and that it was
 * evidence for one report rather than a gate. On 2026-08-23 that glob was
 * measured to be blind to all twenty-eight `-drive` harnesses, so "deliberately
 * does not match" described an accident, not a decision. The glob reads both
 * suffixes now and this file was read and classified with the rest: it costs
 * nothing but time, and the four defects it drives -- a permission control that
 * moved on disk and not on the glass, a clock ticking over a dead process, a
 * sentence about Codex that flipped on whether Claude was installed, and a
 * promise the start path did not keep -- are all on the first surfaces a person
 * meets. The unit suites named below hold the same regressions at the source
 * level (tools/test/setup-permission-level-control.test.mjs,
 * zombie-session.test.mjs, setup-review-readiness.test.mjs,
 * start-control-flag-gates-the-tree.test.mjs); this file presses the glass,
 * which is the half they structurally cannot reach.
 *
 * IT NEVER TOUCHES THE INSTALLED COPY. Every launch is a staged build under a
 * scratch directory with its own --user-data-dir, LOCALAPPDATA and USERPROFILE,
 * and assertIsolated() finds the file the app really wrote and refuses the run
 * if it landed anywhere else.
 *
 * RUN IT:
 *   npm run build && node tools/four-defects-drive.mjs
 *   node tools/four-defects-drive.mjs --keep       leave the scratch directory
 */

import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeActiveRouteResult, pressForwardToActiveRoute } from './lib/active-route-navigation.mjs'

import {
  assertIsolated,
  closeWindow,
  createLedger,
  delay,
  describeTimeline,
  gotoSettings,
  machineRecordProductDirectory,
  openWindow,
  reap,
  route,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const KEEP = process.argv.includes('--keep')
const ledger = createLedger()

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

const machineRecordPath = profile => path.join(
  profile,
  'local',
  machineRecordProductDirectory(profile),
  'machine.json',
)
export const recordedTier = (profile, { readFile = readFileSync } = {}) => {
  const file = machineRecordPath(profile)
  try {
    return JSON.parse(readFile(file, 'utf8')).tier ?? null
  } catch (cause) {
    if (cause instanceof Error && cause.code === 'ENOENT') return null
    const error = new Error(`Could not read the machine permission level at ${file}; this is not claiming that the record or level is absent.`, { cause })
    error.code = 'MACHINE_RECORD_TIER_COULD_NOT_BE_READ'
    throw error
  }
}

export const pathHasCodex = (entry, { access = accessSync } = {}) => {
  const command = path.join(entry, 'codex.cmd')
  try {
    access(command)
    return true
  } catch (cause) {
    if (cause instanceof Error && cause.code === 'ENOENT') return false
    const error = new Error(`Could not check for Codex at ${command}; this is not claiming that Codex is absent.`, { cause })
    error.code = 'CODEX_PATH_PRESENCE_COULD_NOT_BE_READ'
    throw error
  }
}

/* Written through the page's own storage, in the page, because that is where
   the product keeps them -- these are the same keys the walkthrough writes when
   a person answers it. Nothing here is a stub: the code under test reads them
   exactly as it reads a real answer. */
async function recordAnswers(window, { autonomy, flags = {} }) {
  return window.evaluate(`(() => {
    localStorage.setItem('mc.setup.profile', JSON.stringify({
      schemaVersion: 1, status: 'complete', step: 'review',
      answers: { autonomy: ${JSON.stringify(autonomy)}, screens: 'live', workspaceRoots: [] },
      updatedAtMs: Date.now(),
    }))
    ${Object.entries(flags).map(([id, on]) => `localStorage.setItem('mc.write.${id}', ${JSON.stringify(on ? 'enabled' : 'disabled')})`).join('\n    ')}
    return true
  })()`)
}

/* ------------------------------------------------------------------ A ----- */

const READ_TIER_ROW = `(() => {
  const buttons = [...document.querySelectorAll('[data-setup-profile-set="tier"]')]
  /* The buttons are the current public control contract. Derive their row from
     the control itself so a present, operable permission selector cannot be
     reported absent because a wrapper's descriptive id changed. */
  const row = buttons[0]?.closest('.settings-row') || null
  return {
    present: Boolean(row),
    description: row ? (row.querySelector('.settings-desc')?.textContent || '').trim().slice(0, 90) : null,
    pressed: buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.setupProfileValue),
    disabled: buttons.filter(button => button.disabled).map(button => button.dataset.setupProfileValue),
    status: (document.querySelector('[data-setup-profile-status] strong')?.textContent || '').trim(),
  }
})()`

async function scenarioA(executable, scratch, appRoot) {
  console.log('\nA. PERMISSION LEVEL — pressing a level button in Settings → Setup')
  const profile = freshProfile(scratch)
  let window = null
  try {
    seedMachineRecord(profile, appRoot, 'guided')
    ledger.note(`machine record starts at tier=${recordedTier(profile)}`)
    window = await openWindow(executable, profile)
    ledger.check('A0 the staged app opened a window', window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)

    const reached = await gotoSettings(window)
    ledger.check('A1 Settings is reachable by clicking', reached === 'clicked' || reached === 'already-there', String(reached))
    /* The rail's groups ship collapsed; open them the way a person does, so the
     category this driver wants is a button on the screen. */
    await window.evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
    await delay(400)
    const category = await window.clickVisible('[data-category="Setup"]')
    ledger.check('A2 the Setup category opens', category === 'clicked', String(category))
    await delay(700)

    const before = await window.evaluate(READ_TIER_ROW)
    ledger.check('A3 the permission level row is on the page', before?.present === true, JSON.stringify(before?.pressed))

    const pressed = await window.clickVisible('[data-setup-profile-set="tier"][data-setup-profile-value="unrestricted"]')
    ledger.check('A4 a level button takes a real press', pressed === 'clicked', String(pressed))

    /* The same sampling the adversarial run used: the defect held identical
       state at every one of these. */
    const samples = []
    for (const at of [0, 2000, 3000, 3000]) {
      if (at) await delay(at)
      samples.push({ at, ...(await window.evaluate(READ_TIER_ROW)) })
    }
    const last = samples[samples.length - 1]
    console.log(`      samples: ${samples.map(s => `${s.pressed?.join('/') || 'none'}${s.disabled?.length ? '(disabled)' : ''}`).join(' -> ')}`)

    const onDisk = recordedTier(profile)
    ledger.check('A5 the machine record moved to the level that was pressed', onDisk === 'unrestricted', `machine.json tier=${onDisk}`)
    ledger.check('A6 the row on screen shows the level the machine now holds',
      last.pressed?.length === 1 && last.pressed[0] === 'unrestricted', JSON.stringify(last.pressed))
    ledger.check('A7 the section did not go dead', (last.disabled || []).length === 0, JSON.stringify(last.disabled))
    ledger.check('A8 the screen says what happened', /Permission level changed/i.test(last.status || ''), JSON.stringify(last.status))

    /* AND IT CAN BE MOVED BACK, which is the half the dead section removed. */
    const again = await window.clickVisible('[data-setup-profile-set="tier"][data-setup-profile-value="guided"]')
    await delay(2500)
    const back = await window.evaluate(READ_TIER_ROW)
    ledger.check('A9 a second press still works and lands on disk',
      again === 'clicked' && recordedTier(profile) === 'guided' && back.pressed?.[0] === 'guided',
      `click=${again} disk=${recordedTier(profile)} row=${JSON.stringify(back.pressed)}`)
  } finally {
    await closeWindow(window)
    reap(window?.child?.pid)
  }
}

/* ------------------------------------------------------------------ B ----- */

/* THE RECORD AN APP CLOSED MID-TURN LEAVES BEHIND, written into the page's own
   tree store through the same storage the store reads. `status: 'running'` with
   a session id is what is on disk at the moment the window goes away;
   parseFleetTrees loads it back as 'starting', which is the state the defect
   lived in. The session id names a child process that no longer exists --
   which, after a restart, is true of EVERY saved session id. */
const seedMidTurnTree = (computerId, sessionId) => `(() => {
  const key = 'mc.fleet.trees.v1:' + ${JSON.stringify(computerId)}
  const now = Date.now()
  const started = new Date(now - 33_000).toISOString()
  const lastWrite = new Date(now).toISOString()
  const record = {
    version: 1,
    computerId: ${JSON.stringify(computerId)},
    trees: [{ id: 'tree-1', name: null, createdAt: started, updatedAt: started, profileId: null }],
    nodes: [{
      id: 'node-1', treeId: 'tree-1', parentId: null, role: 'coordinator',
      message: 'What is 17 multiplied by 23?', reply: '',
      status: 'running', statusNote: '', sessionId: ${JSON.stringify(sessionId)},
      tier: 'codex-medium', createdAt: started, updatedAt: lastWrite,
    }],
  }
  localStorage.setItem(key, JSON.stringify(record))
  /* AND THE EXCERPT THE AGENT HAD ALREADY SAVED. A node that spoke before the
     window went away has one, and it is what Resume reads; without it Resume is
     correctly refused for having nothing to resume FROM, which is a different
     answer from the defect's "it is still running, wait". */
  localStorage.setItem('mc.fleet.transcripts.v1:' + ${JSON.stringify(computerId)}, JSON.stringify({
    v: 1,
    nodes: {
      'node-1': {
        savedAt: now - 20_000,
        threadId: null,
        effort: 'medium',
        lines: [
          { who: 'you', text: 'What is 17 multiplied by 23?', at: now - 33_000 },
          { who: 'agent', text: 'Working on it.', at: now - 20_000 },
        ],
      },
    },
  }))
  return (localStorage.getItem(key) || '').length
})()`

const READ_NODE_FACE = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : null)
  const circle = document.querySelector('.static-tree-node')
  const runtime = document.querySelector('.static-tree-node .rt, .static-tree-node .rt-state')
  return {
    circleOnCanvas: Boolean(circle),
    runtimeState: circle ? circle.dataset.runtimeState : null,
    runtime: text(runtime),
    chip: text(document.querySelector('.static-tree-chip .chip-preview')),
  }
})()`

/* The popup's rows carry no id -- they are buttons with a label -- so they are
   read the way a person reads them: by what they say. */
const READ_ACTIONS = `(() => {
  const clean = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  return {
    rows: [...document.querySelectorAll('.chat-actions-row')].map(row => ({
      label: clean(row).slice(0, 60),
      disabled: row.disabled === true,
    })),
    header: [...document.querySelectorAll('.chat-sub, .chat-head, .chat-header, .chat-title')]
      .map(clean).join(' | ').slice(0, 220),
  }
})()`

async function scenarioB(executable, scratch, appRoot) {
  console.log('\nB. THE ZOMBIE — a node saved mid-turn, met again on the next launch')
  const profile = freshProfile(scratch)
  let window = null
  try {
    seedMachineRecord(profile, appRoot, 'standard')
    window = await openWindow(executable, profile)
    ledger.check('B0 the staged app opened a window', window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)
    await recordAnswers(window, { autonomy: 'assisted', flags: { 'agent-session': true } })
    /* Example off -- the shipped default, made explicit: the board must read
       this computer, and mc.example is the one switch that could point every
       screen at the example fleet instead (src/data-source.js). */
    await window.evaluate(`(() => { localStorage.removeItem('mc.example'); return true })()`)

    /* Which computer this page is showing, asked of the page rather than
       assumed, so the seeded record lands under the id the store will open. */
    const firstArrival = await pressForwardToActiveRoute(window, {
      hash: '#/computers', route: 'computers', pageSelector: '.computers', pollMs: 250,
    })
    ledger.check('B1 the fleet page is reachable and active by clicking',
      firstArrival.ok === true, describeActiveRouteResult(firstArrival))
    /* WHICH COMPUTER THIS PAGE IS SHOWING. On a customer machine the fleet
       projection never answers and the page draws the DECLARED organisation
       instead, under src/declared-fleet.js's own id. Nothing in the DOM carries
       that id, so it is taken from a tree store the page has already opened when
       there is one and from that module's constant otherwise -- and the seed is
       then PROVEN to have landed by B4, which can only pass if the page really
       opens the key this wrote. */
    /* WAITED FOR, NOT SAMPLED ONCE. The page paints `projectionState=loading`
       while the fleet read and the organisation read are both outstanding, and
       a single sample taken inside that window says "no computer" about a page
       that is about to draw one -- a finding about this driver, not about the
       product. */
    const readBoard = `(() => {
      const page = document.querySelector('.computers')
      const keys = Object.keys(localStorage).filter(key => key.startsWith('mc.fleet.trees.v1:'))
      return {
        liveMode: page ? page.dataset.liveMode : null,
        projectionState: page ? page.dataset.projectionState : null,
        treeKeys: keys,
        emptyNode: Boolean(document.querySelector('.tree-empty-node')),
      }
    })()`
    let board = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      board = await window.evaluate(readBoard)
      if (board?.projectionState && board.projectionState !== 'loading' && board.emptyNode) break
      await delay(500)
    }
    ledger.note(`board: ${JSON.stringify(board)}`)
    ledger.check('B2 the page is showing a real computer, not the example board',
      board?.liveMode === 'live' && board?.emptyNode === true, JSON.stringify(board))
    const computerId = board?.treeKeys?.length
      ? board.treeKeys[0].slice('mc.fleet.trees.v1:'.length)
      : 'this-computer'
    ledger.note(`computer on screen: ${computerId}`)
    const seeded = await window.evaluate(seedMidTurnTree(computerId, 'session-from-a-process-that-is-gone'))
    ledger.check('B2b a mid-turn record is saved for that computer', Number(seeded) > 0, `${seeded} bytes`)

    /* THE RELAUNCH IS THE MEASUREMENT. Closing and reopening is exactly the
       journey: the child dies with the app, the record survives it. */
    await closeWindow(window)
    window = await openWindow(executable, profile)
    ledger.check('B3 the profile reopens', window.timeline.windowAt !== null, describeTimeline(window.timeline))
    const reopenedArrival = await pressForwardToActiveRoute(window, {
      hash: '#/computers', route: 'computers', pageSelector: '.computers', pollMs: 250,
    })
    ledger.check('B3b the reopened profile is measured on the active fleet page',
      reopenedArrival.ok === true, describeActiveRouteResult(reopenedArrival))
    await delay(1800)

    const first = await window.evaluate(READ_NODE_FACE)
    ledger.check('B4 the saved agent is drawn on the canvas', first?.circleOnCanvas === true, JSON.stringify(first))
    await delay(4000)
    const later = await window.evaluate(READ_NODE_FACE)
    console.log(`      runtime: ${JSON.stringify(first?.runtime)} -> ${JSON.stringify(later?.runtime)} (state=${later?.runtimeState})`)

    ledger.check('B5 the runtime clock is not ticking over a dead session',
      first?.runtime === later?.runtime && later?.runtimeState === 'stopped',
      `${first?.runtime} -> ${later?.runtime}, state=${later?.runtimeState}`)
    ledger.check('B6 the chip does not say the agent is starting',
      !/starting|running/i.test(later?.chip || ''), JSON.stringify(later?.chip))

    /* THE WAY OUT. Open the node and read the actions: Resume must be offered,
       and Stop must not be offered over something that has already stopped. */
    const opened = await window.clickVisible('.static-tree-node')
    await delay(1400)
    const openedActions = await window.clickVisible('[data-chat-actions]', { timeoutMs: 6000 })
    await delay(900)
    const actions = await window.evaluate(READ_ACTIONS)
    ledger.note(`node opened: ${opened}; actions button: ${openedActions}`)
    ledger.note(`rows: ${JSON.stringify(actions?.rows?.map(row => `${row.label}${row.disabled ? ' (off)' : ''}`))}`)
    const row = words => actions?.rows?.find(entry => entry.label.startsWith(words))
    ledger.check('B7 the actions of a stopped agent can be read at all', (actions?.rows?.length || 0) > 0,
      `${actions?.rows?.length || 0} rows`)
    ledger.check('B8 Resume is offered on a session that has ended',
      Boolean(row('Resume')) && row('Resume').disabled === false, JSON.stringify(row('Resume')))
    ledger.check('B9 Stop does not stand over a corpse',
      !row('Stop this agent') || row('Stop this agent').disabled === true, JSON.stringify(row('Stop this agent')))
    ledger.check('B10 Interrupt does not stand over a corpse',
      !row('Interrupt') || row('Interrupt').disabled === true, JSON.stringify(row('Interrupt')))
    ledger.check('B11 nothing on the node claims a live session',
      !/live session/i.test(actions?.header || ''), JSON.stringify((actions?.header || '').slice(0, 140)))

    /* THE HEADLINE SYMPTOM, TYPED. The defect answered a typed message with
       "Queued — sends by itself when this turn finishes" over a turn that ended
       when the app closed, and it never finished. Whatever this build answers
       now, it may not be that. */
    await window.evaluate(`(() => { document.querySelector('.chat-actions-pop')?.remove(); return true })()`)
    const typed = await window.typeInto('.chat-input input', 'What is 17 multiplied by 23?')
    const sent = await window.clickVisible('.chat-send')
    await delay(6000)
    const conversation = await window.evaluate(`(() => {
      const clean = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
      return {
        log: clean(document.querySelector('.chat-log')).slice(-400),
        queueStrip: clean(document.querySelector('.chat-queue-strip')),
        queueHidden: document.querySelector('.chat-queue-strip')?.hidden ?? null,
      }
    })()`)
    ledger.note(`typed=${typed} sent=${sent}`)
    ledger.note(`conversation tail: ${JSON.stringify(conversation?.log?.slice(-220))}`)
    ledger.check('B12 the message is not parked in a queue nothing will drain',
      !/sends by itself when this turn finishes/i.test(conversation?.log || '')
      && !/sends by itself when this turn finishes/i.test(conversation?.queueStrip || ''),
      JSON.stringify(`${conversation?.log || ''} ${conversation?.queueStrip || ''}`.slice(-220)))
  } finally {
    await closeWindow(window)
    reap(window?.child?.pid)
  }
}

/* ------------------------------------------------------------------ C ----- */

const READ_REVIEW = `(() => {
  const blocks = [...document.querySelectorAll('.fleet-profile-status')].map(block => ({
    tone: block.className,
    text: block.textContent.replace(/\\s+/g, ' ').trim(),
  }))
  return {
    step: document.querySelector('[data-setup-step]')?.dataset.setupStep || null,
    readiness: blocks.find(block => /Before an agent can run/.test(block.text)) || null,
    all: blocks.map(block => block.text.slice(0, 120)),
  }
})()`

async function scenarioC(executable, scratch, appRoot, { codexOnPath }) {
  console.log(`\nC. THE REVIEW'S CLAIM ABOUT CODEX — with codex ${codexOnPath ? 'on' : 'NOT on'} PATH`)
  const profile = freshProfile(scratch)
  let window = null
  const realPath = process.env.PATH
  try {
    seedMachineRecord(profile, appRoot, 'standard')
    if (!codexOnPath) {
      /* THE NEGATIVE CONTROL, and it is a real one: the directories that carry
         codex.cmd are removed from the PATH the app inherits, so
         shell/provider-cli-presence.cjs answers `installed: 'no'` from the
         filesystem rather than from anything this driver told it. CODEX_HOME is
         already a scratch directory, so it is signed out too. */
      process.env.PATH = realPath.split(path.delimiter)
        .filter(entry => !pathHasCodex(entry))
        .join(path.delimiter)
    }
    window = await openWindow(executable, profile)
    ledger.check(`C0 the app opened (codex ${codexOnPath ? 'present' : 'absent'})`, window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)

    /* What the shell itself says this machine has, so the claim on screen is
       compared against the machine and not against this driver's intention. */
    const presence = await window.evaluate('window.mcProviders ? window.mcProviders.presence() : null')
    const codex = presence?.providers?.find(provider => provider.id === 'codex') || null
    const claude = presence?.providers?.find(provider => provider.id === 'claude') || null
    ledger.note(`the shell reports codex=${JSON.stringify(codex)} claude=${JSON.stringify(claude)}`)
    const availability = await window.evaluate('window.mcAgent ? window.mcAgent.availability() : null')
    ledger.note(`availability answers ${JSON.stringify(availability)}`)

    /* Walk to the review by clicking Continue, touching no answer. */
    const opened = await window.evaluate(`(() => { location.hash = '#/setup'; return true })()`)
    await delay(1600)
    ledger.check('C1 the walkthrough opens', (await route(window)) === 'setup', `${opened} route=${await route(window)}`)
    for (let step = 0; step < 6; step += 1) {
      const read = await window.evaluate(READ_REVIEW)
      if (read?.readiness) break
      const next = await window.clickVisible('[data-setup-next]', { timeoutMs: 5000 })
      if (next !== 'clicked') break
      await delay(900)
    }
    await delay(1500)
    const review = await window.evaluate(READ_REVIEW)
    const said = review?.readiness?.text || ''
    console.log(`      "${said.slice(0, 200)}"`)
    ledger.check('C2 the review states something about starting an agent', said.length > 0, JSON.stringify(review?.all?.slice(0, 3)))

    if (codex && codex.installed === 'no') {
      ledger.check('C3 it does not claim Codex is installed and signed in',
        !/installed on this computer and signed in/i.test(said), said.slice(0, 160))
      ledger.check('C4 it hands over the install command the person needs',
        /winget install|npm i -g|npm install -g/i.test(said), said.slice(0, 200))
    } else if (codex && codex.installed === 'yes' && codex.signedIn === 'yes') {
      ledger.check('C3 it says the machine is ready, because it is',
        /installed on this computer and signed in/i.test(said), said.slice(0, 160))
    } else {
      ledger.check('C3 it does not claim more than the shell told it',
        !/installed on this computer and signed in/i.test(said), `presence=${JSON.stringify(codex)} said="${said.slice(0, 120)}"`)
    }
  } finally {
    process.env.PATH = realPath
    await closeWindow(window)
    reap(window?.child?.pid)
  }
}

/* ------------------------------------------------------------------ D ----- */

const READ_COMPOSE = `(() => {
  const panel = document.querySelector('[data-agent-compose]')
  const start = document.querySelector('[data-compose-action="start"]')
  return {
    panelOpen: Boolean(panel),
    notice: (document.querySelector('[data-compose-notice="panel"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    startPresent: Boolean(start),
    startDisabled: start ? start.disabled : null,
    status: (document.querySelector('[data-compose-status="panel"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    flag: localStorage.getItem('mc.write.agent-session'),
  }
})()`

async function scenarioD(executable, scratch, appRoot) {
  console.log('\nD. THE PROMISE — "nothing here will start an agent", on the page that starts them')
  const profile = freshProfile(scratch)
  let window = null
  try {
    seedMachineRecord(profile, appRoot, 'standard')
    window = await openWindow(executable, profile)
    ledger.check('D0 the app opened', window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)
    /* The answer a person gives when they choose to look around first, recorded
       exactly as the walkthrough records it. */
    await recordAnswers(window, { autonomy: 'observe', flags: { 'agent-session': false } })
    const before = await window.evaluate('window.mcAgent ? window.mcAgent.history({}) : null')
    ledger.note(`spawn history before: total=${before?.total ?? 'unknown'}`)

    await window.evaluate(`(() => { location.hash = '#/computers'; return true })()`)
    await delay(2200)
    for (let step = 0; step < 12; step += 1) {
      if ((await route(window)) === 'computers') break
      await window.clickVisible('#nav-next')
      await delay(400)
    }
    ledger.check('D1 the fleet page is on screen', (await route(window)) === 'computers', await route(window))

    const pressed = await window.clickVisible('.tree-empty-node', { timeoutMs: 9000 })
    ledger.check('D2 the dashed circle takes a real press', pressed === 'clicked', String(pressed))
    await delay(1200)
    const panel = await window.evaluate(READ_COMPOSE)
    console.log(`      panel: ${JSON.stringify(panel)}`)
    ledger.check('D3 the press is answered rather than ignored', panel?.panelOpen === true, JSON.stringify(panel))
    ledger.check('D4 the panel says starting is switched off and where the switch is',
      /switched off|starts an assistant|Settings/i.test(panel?.notice || ''), JSON.stringify(panel?.notice))
    ledger.check('D5 the Start control cannot be pressed', panel?.startDisabled === true, JSON.stringify(panel?.startDisabled))

    /* AND NOTHING REACHED THE ENGINE. Start is pressed anyway -- a disabled
       button is paint until the code behind it refuses -- and the spawn record
       is read afterwards, because that is the file a real start writes. */
    await window.clickVisible('[data-compose-action="start"]', { timeoutMs: 4000 })
    await delay(2500)
    const after = await window.evaluate('window.mcAgent ? window.mcAgent.history({}) : null')
    const afterPanel = await window.evaluate(READ_COMPOSE)
    ledger.check('D6 no agent was started on this computer',
      (after?.total ?? 0) === (before?.total ?? 0), `history total ${before?.total ?? '?'} -> ${after?.total ?? '?'}`)
    /* THE DISCRIMINATOR. The defect's own signature was an ENGINE refusal --
       a sentence about Codex -- on a computer that had been promised nothing
       here would start anything. A permission answer names the permission. */
    const refusal = `${afterPanel?.status || ''} ${afterPanel?.notice || ''}`
    ledger.check('D6b the answer is about the switch, not about Codex',
      !/codex|winget|not installed|engine/i.test(refusal) && /switched off|Settings/i.test(refusal),
      JSON.stringify(refusal.slice(0, 180)))

    /* AND THE SWITCH REALLY IS THE THING: turn it on and the same press offers
       a live Start. A gate nobody can open is a removed feature. */
    await window.evaluate(`(() => { localStorage.setItem('mc.write.agent-session', 'enabled'); location.hash = '#/'; return true })()`)
    await delay(900)
    await window.evaluate(`(() => { location.hash = '#/computers'; return true })()`)
    await delay(2200)
    await window.clickVisible('.tree-empty-node', { timeoutMs: 9000 })
    await delay(1200)
    const onceOn = await window.evaluate(READ_COMPOSE)
    ledger.check('D7 turning the switch on gives the Start control back',
      onceOn?.panelOpen === true && onceOn?.startDisabled === false, JSON.stringify(onceOn))
  } finally {
    await closeWindow(window)
    reap(window?.child?.pid)
  }
}

/* ------------------------------------------------------------------------- */

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'four-defects-'))
  console.log(`scratch: ${scratch}`)
  try {
    const staged = await stage(scratch)
    console.log(`staged:  ${staged.executable}`)
    const only = process.argv.find(value => /^--only=/.test(value))?.slice('--only='.length) || 'abcd'
    if (only.includes('a')) await scenarioA(staged.executable, scratch, staged.appRoot)
    if (only.includes('b')) await scenarioB(staged.executable, scratch, staged.appRoot)
    if (only.includes('c')) {
      await scenarioC(staged.executable, scratch, staged.appRoot, { codexOnPath: false })
      await scenarioC(staged.executable, scratch, staged.appRoot, { codexOnPath: true })
    }
    if (only.includes('d')) await scenarioD(staged.executable, scratch, staged.appRoot)
  } finally {
    ledger.finish('staged packaged build')
    if (!KEEP) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a held file is not a finding */ }
    } else {
      console.log(`kept: ${scratch}`)
    }
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
