#!/usr/bin/env node

/* THE RAIL'S LIFECYCLE, DRIVEN: TWO MEASURED DEFECTS, HELD SHUT ON THE GLASS.
 *
 *   1  THE POPUP, MID-WORD. A person opens the chat's actions popup and types
 *      in its filter while their agent is working. When the settling session's
 *      status lands (a turn completes; a queued message drains), the rail used
 *      to be REBUILT -- showTreeNodeControls swaps innerHTML, the rebuild
 *      disposes the mounted chat, and buildChat's dispose closes the popup.
 *      Filter text, cursor and menu gone mid-keystroke, measured twice on a
 *      live drive (2026-08-18). The turn here is real: the fixture engine
 *      (tools/test/fixtures/narrating-engine) speaks through the shell's own
 *      wire, so the status transitions are the product's own, on a timer this
 *      driver does not control. The popup must survive BOTH landings -- the
 *      completion and the drained queue -- with its filter text intact.
 *
 *   2  THE STALE RAIL. Open a node's rail chat, switch trees, and the rail
 *      used to keep the PREVIOUS tree's chat until another circle was
 *      pressed. Now the rail follows the canvas: a switch to another tree
 *      returns it to the overview; "Every tree" (the node is still on the
 *      canvas) keeps it; pressing the node again after a round trip reopens
 *      the whole saved conversation, untouched. The conversation record is
 *      read before and after and must not move -- tools/chat-history-drive.mjs
 *      scenarios E and F hold the deeper transcript claims and are re-run
 *      beside this driver, not replaced by it.
 *
 * IT IS DRIVEN, NOT INSPECTED: real CDP mouse presses at real coordinates
 * (covered controls are reported as covered, never clicked through), real key
 * events, Input.insertText into the focused field. No el.click(), no
 * dispatchEvent, no assigned .value. It never touches the installed copy:
 * the build is staged into a scratch directory with its own --user-data-dir,
 * LOCALAPPDATA and USERPROFILE (tools/test-account-harness.mjs owns the rig).
 *
 *   npm run build && node tools/rail-lifecycle-drive.mjs
 *   node tools/rail-lifecycle-drive.mjs --visible
 *   node tools/rail-lifecycle-drive.mjs --keep      leave the scratch directory
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

/* ------------------------------------------------------------- pressing -- */
/* B-POOL-6 MIGRATION (API decision doc §6, step 2 of 5): "the same
   instruments tools/chat-history-drive.mjs measured its way to" above was
   true before chat-history-drive.mjs's own step-1 migration, verified
   byte-identical before this file was touched -- so this file now takes
   the SAME instruments' new shared home. Same adapter, same one named
   behavior change (FLEET_NODE_VISIBLE's ancestor-opacity walk over this
   harness's own window.waitForVisible/VISIBLE_FN); see chat-history-
   drive.mjs's own comment at this point for the full account. */
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

async function key(window, name, _keyCode) {
  await presserFor(window).key(name)
}

async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if ((await valueNow()) === wanted) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses` }
}

/* ---------------------------------------------------------------- state -- */

async function computerOnScreen(window) {
  await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
  await window.evaluate("location.hash = '#/computers'")
  await delay(1000)
  await window.evaluate('location.reload()')
  await delay(3800)
  return window.evaluate('window.__mcGraph?.computer?.id || null')
}

const treesKey = computerId => `mc.fleet.trees.v1:${computerId}`
const storeKey = computerId => `mc.fleet.transcripts.v1:${computerId}`

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

/* ------------------------------------------------------------- readings -- */

/* The rail's three pages, the mounted chat, and the actions popup, in one
   read, so every claim below names what ALL of them were doing at that
   moment. The Details status word is read even while its body is hidden --
   textContent does not need paint -- which is how the in-place repaint is
   observed without closing the popup to look. */
const READ_RAIL = `(() => {
  const active = cls => Boolean(document.querySelector('.' + cls + '.is-active'))
  const pop = document.querySelector('[data-rail-chat-host] .chat-actions-pop')
  const filter = pop ? pop.querySelector('.chat-actions-filter') : null
  const chat = document.querySelector('[data-rail-chat-host] .chat')
  return {
    overview: active('stats-page'),
    controls: active('ctl-page'),
    compose: active('compose-page'),
    chatMounted: Boolean(chat),
    chatMessages: chat ? chat.querySelectorAll('.msg').length : 0,
    popupOpen: Boolean(pop),
    filterValue: filter ? filter.value : null,
    filterFocused: Boolean(filter && document.activeElement === filter),
    rows: pop ? pop.querySelectorAll('.chat-actions-row').length : 0,
    statusWord: (document.querySelector('[data-tree-status]')?.textContent || '').trim(),
    actionsExpanded: document.querySelector('[data-rail-chat-host] [data-chat-actions]')?.getAttribute('aria-expanded') || null,
  }
})()`

const READ_STORE = computerId => `(() => {
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(${JSON.stringify(storeKey(computerId))})) } catch (error) { return { broken: String(error) } }
  if (!raw || !raw.nodes) return { records: 0, ids: [] }
  const ids = Object.keys(raw.nodes)
  return {
    records: ids.length,
    ids,
    lines: Object.fromEntries(ids.map(id => [id, raw.nodes[id].lines.length])),
    savedAt: Object.fromEntries(ids.map(id => [id, raw.nodes[id].savedAt])),
  }
})()`

/* ----------------------------------------------------- starting an agent -- */

async function startAgentFromCanvas(window, brief, { slot = '.computers .tree-empty-node' } = {}) {
  const doorway = await press(window, slot)
  if (!doorway.pressed) return { ok: false, why: `the dashed circle could not be pressed (${doorway.why})` }
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
    const btn = [...document.querySelectorAll('button')].filter(visible).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'rail-lifecycle-drive-start'
    return { selector: '#' + btn.id }
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
  return { ok: true, nodeId: fresh }
}

/* ------------------------------------------------------------ scenarios -- */

/* 1 -- THE ACTIONS POPUP SURVIVES A SETTLING SESSION.
 *
 * One real agent, started the way a person starts one. A second turn is sent
 * so there is an exact moment the settling begins, and a THIRD message is
 * queued while it runs so the completion is followed by a drained queue --
 * the two status landings that used to rebuild the rail (the turn-completed
 * branch and drainOutboxMessage). The popup is opened and filtered mid-turn;
 * it must still be standing, filter text intact, after BOTH landings. */
async function scenarioPopup(executable, scratch, appRoot) {
  console.log('\n1. the actions popup survives a settling session')
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

    const started = await startAgentFromCanvas(window, 'Check the tests and read one file.')
    if (!started.ok) { note('FAIL', started.why); return }
    note('INFO', `started ${started.nodeId}; letting the first turn finish`)
    await delay(7000)

    const opened = await press(window, `.node[data-agent-id="${started.nodeId}"]`)
    if (!opened.pressed) { note('FAIL', `the circle could not be pressed (${opened.why})`); return }

    /* The settling turn, and a queued message behind it. */
    const typed = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'do that again')
    if (!typed.pressed) { note('FAIL', `the message box could not be pressed (${typed.why})`); return }
    const startedAt = Date.now()
    await key(window, 'Enter', 13)
    const queued = await typeInto(window, '[data-rail-chat-host] .chat-input input', 'and then a third time')
    if (!queued.pressed) { note('FAIL', `the message box could not be pressed again (${queued.why})`); return }
    await key(window, 'Enter', 13)

    /* The popup, opened and filtered while the turn runs. */
    const popPressed = await press(window, '[data-rail-chat-host] [data-chat-actions]')
    if (!popPressed.pressed) { note('FAIL', `the actions button could not be pressed (${popPressed.why})`); return }
    await window.session.send('Input.insertText', { text: 'cop' })
    await delay(200)
    const during = readOrThrow(await window.evaluate(READ_RAIL), 'the rail mid-turn')
    note('INFO', `popup open at +${Date.now() - startedAt}ms: filter=${JSON.stringify(during.filterValue)} rows=${during.rows} status=${JSON.stringify(during.statusWord)}`)
    if (!during.popupOpen || during.filterValue !== 'cop') {
      note('FAIL', `the popup never opened with the typed filter (open=${during.popupOpen} filter=${JSON.stringify(during.filterValue)})`)
      return
    }

    /* FIRST LANDING: the turn completes and the queued message drains. The
       narrating turn is 1020ms of script at SPEED 4 (~4.1s), so at +7.4s the
       first turn has settled and the drained second turn (earliest end ~+8.2s)
       is still speaking -- the window in which the status word must read
       running WITH the popup still up. */
    await delay(Math.max(0, 7400 - (Date.now() - startedAt)))
    const afterFirst = readOrThrow(await window.evaluate(READ_RAIL), 'the rail after the completion')
    check(
      afterFirst.popupOpen && afterFirst.filterValue === 'cop',
      'the popup survives the turn completing and the queue draining',
      `+${Date.now() - startedAt}ms: open=${afterFirst.popupOpen} filter=${JSON.stringify(afterFirst.filterValue)} (was open with "cop" before the landing)`,
    )
    check(
      afterFirst.statusWord === 'running',
      'the Details status word repainted in place while the popup stood',
      `status=${JSON.stringify(afterFirst.statusWord)} -- the drained queue put the agent back to work`,
    )

    /* SECOND LANDING: the drained turn completes too. */
    await delay(Math.max(0, 15000 - (Date.now() - startedAt)))
    const afterSecond = readOrThrow(await window.evaluate(READ_RAIL), 'the rail after the second completion')
    check(
      afterSecond.popupOpen && afterSecond.filterValue === 'cop' && afterSecond.actionsExpanded === 'true',
      'the popup is still standing, filter intact, after the second landing',
      `+${Date.now() - startedAt}ms: open=${afterSecond.popupOpen} filter=${JSON.stringify(afterSecond.filterValue)} expanded=${afterSecond.actionsExpanded}`,
    )
    check(
      afterSecond.statusWord === 'finished',
      'the status word reads finished without the rail having been rebuilt',
      `status=${JSON.stringify(afterSecond.statusWord)}`,
    )
    check(
      afterSecond.chatMounted && afterSecond.chatMessages >= during.chatMessages,
      'the mounted chat lived through both landings',
      `${during.chatMessages} messages before, ${afterSecond.chatMessages} after`,
    )
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* 2 -- THE RAIL FOLLOWS THE CANVAS ACROSS A TREE SWITCH. */
async function scenarioStaleRail(executable, scratch, appRoot) {
  console.log('\n2. the rail follows the canvas across a tree switch')
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
    const wroteTrees = await setItem(window, treesKey(computerId), twoTreeRecord(computerId,
      { id: 'node-a', sessionId: 'sess-a', status: 'finished', message: 'alpha ask one', reply: 'alpha answer three' },
      { id: 'node-b', sessionId: 'sess-b', status: 'finished', message: 'beta ask', reply: 'beta answer' }))
    const wroteStore = await setItem(window, storeKey(computerId), { v: 1, nodes: {
      'node-a': { savedAt: 1_700_000_000_000, threadId: 'thread-a', effort: 'medium', trimmed: 0, lines: alphaLines },
      'node-b': { savedAt: 1_700_000_000_001, threadId: 'thread-b', effort: 'medium', trimmed: 0, lines: betaLines },
    } })
    if (!wroteTrees.ok || !wroteStore.ok) { note('FAIL', `seeding failed (${wroteTrees.why || wroteStore.why})`); return }
    await window.evaluate('location.reload()')
    await delay(4200)
    const before = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record before')

    const pressTree = async label => {
      const found = readOrThrow(await window.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.graph-tree-switch button')]
        return { at: buttons.findIndex(b => (b.textContent || '').trim() === ${JSON.stringify(label)}), labels: buttons.map(b => (b.textContent || '').trim()) }
      })()`), 'the tree switcher')
      if (found.at < 0) return { pressed: false, why: `no tree button reads ${JSON.stringify(label)}; offered ${found.labels.join(' | ')}` }
      const pressed = await press(window, `.graph-tree-switch button:nth-of-type(${found.at + 1})`)
      await delay(900)
      return pressed
    }

    /* Alpha's chat, open in the rail. */
    const alpha = await pressTree('Alpha')
    if (!alpha.pressed) { note('FAIL', `Alpha could not be pressed (${alpha.why})`); return }
    const openedA = await press(window, '.node[data-agent-id="node-a"]')
    if (!openedA.pressed) { note('FAIL', `node-a could not be pressed (${openedA.why})`); return }
    const withAlpha = readOrThrow(await window.evaluate(READ_RAIL), 'the rail on Alpha')
    check(withAlpha.controls && withAlpha.chatMessages === 6, "Alpha's six-line chat opens in the rail",
      `controls=${withAlpha.controls} messages=${withAlpha.chatMessages}`)

    /* THE SWITCH. The rail must stop showing Alpha's chat. */
    const beta = await pressTree('Beta')
    if (!beta.pressed) { note('FAIL', `Beta could not be pressed (${beta.why})`); return }
    const afterSwitch = readOrThrow(await window.evaluate(READ_RAIL), 'the rail after the switch')
    check(
      !afterSwitch.controls && afterSwitch.overview,
      "switching trees returns the rail to the overview instead of leaving Alpha's chat standing",
      `overview=${afterSwitch.overview} controls=${afterSwitch.controls} (the stale rail showed the previous tree's chat here)`,
    )

    /* Beta's node opens its own chat as ever. */
    const openedB = await press(window, '.node[data-agent-id="node-b"]')
    if (!openedB.pressed) { note('FAIL', `node-b could not be pressed (${openedB.why})`); return }
    const withBeta = readOrThrow(await window.evaluate(READ_RAIL), 'the rail on Beta')
    check(withBeta.controls && withBeta.chatMessages === 2, "Beta's own two-line chat opens after the switch",
      `controls=${withBeta.controls} messages=${withBeta.chatMessages}`)

    /* "Every tree" keeps an open rail: the node is still on the canvas. */
    const every = await pressTree('Every tree')
    if (!every.pressed) { note('FAIL', `Every tree could not be pressed (${every.why})`); return }
    const zoomedOut = readOrThrow(await window.evaluate(READ_RAIL), 'the rail under Every tree')
    check(zoomedOut.controls && zoomedOut.chatMessages === 2,
      '"Every tree" keeps the open rail: its node is still on the canvas',
      `controls=${zoomedOut.controls} messages=${zoomedOut.chatMessages}`)

    /* Round trip: Alpha again, reopened whole. */
    const back = await pressTree('Alpha')
    if (!back.pressed) { note('FAIL', `Alpha could not be pressed again (${back.why})`); return }
    const reopenA = await press(window, '.node[data-agent-id="node-a"]')
    if (!reopenA.pressed) { note('FAIL', `node-a could not be pressed after the round trip (${reopenA.why})`); return }
    const again = readOrThrow(await window.evaluate(READ_RAIL), 'the rail on Alpha again')
    check(again.controls && again.chatMessages === 6, "after the round trip Alpha's chat reopens whole",
      `messages=${again.chatMessages}`)

    const after = readOrThrow(await window.evaluate(READ_STORE(computerId)), 'the record after')
    check(
      after.records === 2 && after.lines['node-a'] === 6 && after.lines['node-b'] === 2
        && after.savedAt['node-a'] === before.savedAt['node-a'] && after.savedAt['node-b'] === before.savedAt['node-b'],
      'the conversation record is untouched by every switch',
      `records=${after.records}, lines a=${after.lines['node-a']} b=${after.lines['node-b']}`,
    )
  } finally {
    await closeWindow(window)
    reap(window.timeline.pid)
    assertIsolated(profile)
  }
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'rail-lifecycle-drive-'))
  console.log(`scratch: ${scratch}`)
  process.env.MISSION_CONTROL_ENGINE = NARRATING_ENGINE
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: {},
  })
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged: ${executable}`)
    for (const scenario of [scenarioPopup, scenarioStaleRail]) {
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
