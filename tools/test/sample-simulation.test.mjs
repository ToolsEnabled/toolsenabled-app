/* THE EXAMPLE FLEET AT WORK (src/sample-simulation.js), driven by hand.
 *
 * Owner, 2026-09-11: "have the example fleet simulate its different states in
 * a seemingly very acive environment (this will essentially be an upgrade on
 * the simulation)". These tests run the real script over the real example
 * store (sample-trees.js, the real store over memory) with a clock the test
 * owns, and hold the promises the page relies on:
 *   - the tree has the product's shape and every tier is a real launch tier;
 *   - the page joins with most of the tree busy, and the loop never stops;
 *   - every state the owner asked to see actually happens, in order;
 *   - every write goes through the store's own API and none is refused;
 *   - only example session ids ever exist, and a finished agent holds none;
 *   - the same seed and clock give the same run;
 *   - the module owns no timers, storage, network or drawing.
 *
 * Run: node --test tools/test/sample-simulation.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SAMPLE_SIM_AGENTS, SAMPLE_SIM_LOOP_MS, SAMPLE_SIM_JOIN_MS, SAMPLE_SIM_SESSION_PREFIX, SAMPLE_SIM_TREE_NAME,
  compileSampleScript, createSampleFleetRun, isSampleSimSession,
} from '../../src/sample-simulation.js'
import { createSampleTreeStore, sampleSimulationSeed } from '../../src/sample-trees.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { NODE_STATUSES } from '../../src/fleet-trees.js'

const T0 = 1_800_000_000_000
const source = readFileSync(new URL('../../src/sample-simulation.js', import.meta.url), 'utf8')
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

function started({ seed = 1 } = {}) {
  const store = createSampleTreeStore({ simulation: true })
  const seeded = sampleSimulationSeed(store)
  const run = createSampleFleetRun({ store, seeded, seed, startedAt: T0 })
  return { store, seeded, run }
}

/* Walk the clock in page-sized steps, recording every event and the tree. */
function play({ store, seeded, run }, untilMs, stepMs = 200) {
  const events = []
  const byKey = new Map([...seeded.ids].map(([key, id]) => [id, key]))
  const statuses = new Map()
  const sessions = new Set()
  const sessionsByKey = new Map()
  const push = event => events.push({ ...event, key: byKey.get(event.nodeId) || null })
  for (const event of run.advance(T0)) push(event)
  for (let at = T0 + stepMs; at <= T0 + untilMs; at += stepMs) {
    for (const event of run.advance(at)) push(event)
    for (const node of store.snapshot().nodes) {
      const key = byKey.get(node.id)
      if (!key) continue
      const seen = statuses.get(key) || []
      if (seen.at(-1) !== node.status) seen.push(node.status)
      statuses.set(key, seen)
      if (node.sessionId) {
        sessions.add(node.sessionId)
        sessionsByKey.set(key, new Set([...(sessionsByKey.get(key) || []), node.sessionId]))
      }
    }
  }
  return { events, statuses, sessions, sessionsByKey, byKey }
}

test('the working tree has the product’s shape, real tiers and a name of its own', () => {
  assert.equal(SAMPLE_SIM_AGENTS.length, 11)
  const roles = SAMPLE_SIM_AGENTS.map(agent => agent.role)
  assert.equal(roles.filter(role => role === 'controller').length, 1)
  assert.equal(roles.filter(role => role === 'manager').length, 2)
  assert.equal(roles.filter(role => role === 'reviewer').length, 1)
  assert.ok(roles.filter(role => role === 'builder').length >= 3)
  const tiers = new Map(LAUNCH_TIERS.map(tier => [tier.id, tier]))
  for (const agent of SAMPLE_SIM_AGENTS) {
    assert.ok(tiers.has(agent.tier), `${agent.key} names a tier the launch table does not have: ${agent.tier}`)
    if (agent.parent) assert.ok(SAMPLE_SIM_AGENTS.some(other => other.key === agent.parent), `${agent.key} reports to a missing agent`)
  }
  const providers = new Set(SAMPLE_SIM_AGENTS.map(agent => tiers.get(agent.tier).provider))
  for (const provider of ['codex', 'claude', 'grok', 'gemini', 'local']) assert.ok(providers.has(provider), `no ${provider} agent in the example`)

  const { store, seeded } = started()
  const first = store.listTrees()[0]
  assert.equal(store.treeLabel(first.id), SAMPLE_SIM_TREE_NAME, 'the working tree is the first tree a person sees')
  assert.equal(first.id, seeded.treeId)
  assert.equal(store.listNodes(first.id).length, 11)
  assert.deepEqual(store.listTrees().slice(1).map(tree => store.treeLabel(tree.id)),
    ['can you open chrome'], 'the refused start stays behind it; the frozen trees it replaces are gone')
  const names = new Set()
  for (const node of store.snapshot().nodes) {
    const label = `${node.role}:${node.nameOrdinal}`
    assert.ok(!names.has(label), `two circles would share the name ${label}`)
    names.add(label)
  }
  assert.equal(sampleSimulationSeed(createSampleTreeStore()), null, 'a store that did not ask for the simulation has none')
})

test('the page joins mid-round with most of the tree busy, and every beat is accepted by the store', () => {
  const setup = started()
  setup.run.advance(T0)
  const busy = setup.store.listNodes(setup.seeded.treeId).filter(node => node.status === 'running' || node.status === 'starting')
  assert.ok(busy.length >= 8, `only ${busy.length} of 11 agents are busy when the page opens`)
  play(setup, SAMPLE_SIM_LOOP_MS * 3)
  assert.deepEqual(setup.run.problems, [], 'the store refused a beat')
  assert.equal(setup.run.round(), 3, 'three loops ran')
  for (const status of setup.store.snapshot().nodes.map(node => node.status)) assert.ok(NODE_STATUSES.includes(status))
})

test('every state the owner asked to see happens, in order', () => {
  const setup = started()
  const { events, statuses, sessionsByKey } = play(setup, SAMPLE_SIM_LOOP_MS - SAMPLE_SIM_JOIN_MS + 1000)
  const notes = key => events.filter(event => event.key === key && event.kind === 'note').map(event => event.text)
  const words = key => events.filter(event => event.key === key && event.kind === 'turn-close').map(event => event.text)
  const rows = key => events.filter(event => event.key === key && event.kind === 'row').map(event => event.row)

  // starting -> running -> finished, with tool steps, a file edit, thinking and streamed words.
  assert.deepEqual(statuses.get('fixtures'), ['running', 'finished'])
  assert.ok(statuses.get('reviewer').join(' ').includes('starting running finished'))
  const layoutRows = rows('layout')
  assert.ok(layoutRows.some(row => row.tool === 'Edit' && /invoice-table\.css/.test(row.detail)), 'no file edit row')
  assert.ok(layoutRows.some(row => row.stateKey === 'working') && layoutRows.some(row => row.stateKey === 'done'), 'tool rows do not go from running to finished')
  assert.ok(events.some(event => event.key === 'layout' && event.kind === 'words'), 'no streamed words')
  assert.ok(events.some(event => event.kind === 'thinking'), 'no thinking lines')

  // A reviewer rejecting, then accepting.
  const verdicts = words('reviewer')
  assert.match(verdicts[0], /^Changes requested/)
  assert.match(verdicts[1], /^Accepted/)

  // A usage limit, the Wait-for-resets countdown, and the automatic retry.
  assert.ok(statuses.get('totals').join(' ').includes('running turn-failed running finished'))
  const waiting = notes('totals')
  assert.match(waiting[0], /reached its usage limit\. This turn waits for the reset, then retries by itself\./)
  assert.match(waiting[1], /reset\. Retrying the turn automatically/)

  // Keep trying accounts: a new sign-in, a compact handoff, and not the same conversation.
  const moved = notes('pdf').join('\n')
  assert.match(moved, /Keep trying accounts is on, so this moves to Personal/)
  assert.match(moved, /compact handoff .* This is a new conversation, not the same one\./)
  assert.equal(sessionsByKey.get('pdf').size, 2, 'the handoff did not start a second conversation')
  assert.ok(statuses.get('pdf').join(' ').includes('turn-failed starting running finished'))

  // A queued message, sent when the turn finished.
  assert.ok(notes('layout').some(text => /^Queued until this turn finishes: “When that is done/.test(text)))
  assert.ok(events.some(event => event.key === 'layout' && event.kind === 'owner' && /^When that is done/.test(event.text)), 'the queued words were never sent')

  // A Stop, and Autonomous+ carrying on with ledger work.
  assert.ok(statuses.get('autoplus').includes('interrupted'))
  assert.ok(notes('autoplus').some(text => /^Autonomous\+ picked up the next open ledger item: #215/.test(text)))
  assert.ok(notes('autoplus').some(text => /^Stopped by you\./.test(text)))
  assert.ok(rows('autoplus').some(row => row.stateKey === 'undone'), 'the stopped command is not shown as unfinished')

  // Grok and Gemini clerks with their usage rows.
  assert.ok(notes('grok').some(text => /^Grok usage: not reported/.test(text)))
  assert.ok(notes('gemini').some(text => /^Gemini weekly allowance: \d+% used, resets Monday/.test(text)))
})

test('only example sessions ever exist, and an agent whose turn is over holds none', () => {
  const setup = started()
  const { sessions } = play(setup, SAMPLE_SIM_LOOP_MS * 2)
  assert.ok(sessions.size >= 11)
  for (const sessionId of sessions) {
    assert.ok(sessionId.startsWith(SAMPLE_SIM_SESSION_PREFIX), `a session id that is not the example's: ${sessionId}`)
    assert.ok(isSampleSimSession(sessionId))
  }
  for (const sessionId of setup.run.liveSessions) assert.ok(isSampleSimSession(sessionId))
  for (const node of setup.store.listNodes(setup.seeded.treeId)) {
    if (['finished', 'interrupted', 'failed'].includes(node.status)) assert.equal(node.sessionId, null, `${node.id} kept a session after its turn`)
    else if (node.sessionId) assert.ok(setup.run.liveSessions.has(node.sessionId))
  }
  assert.equal(isSampleSimSession('019c0a2b-1234-7abc-8def-0123456789ab'), false)
})

test('the same seed and clock give the same run; the seed changes only the rhythm', () => {
  const summary = seed => {
    const setup = started({ seed })
    const { events } = play(setup, 60_000, 250)
    return {
      events: events.map(event => `${event.kind}:${event.key}:${event.text || event.row?.id || ''}`),
      nodes: setup.store.snapshot().nodes.map(node => `${node.status}:${node.statusNote}:${node.reply}`),
    }
  }
  assert.deepEqual(summary(7), summary(7))
  const [a, b] = [summary(1), summary(2)]
  const statusOnly = list => list.filter(line => line.startsWith('status:'))
  assert.deepEqual(statusOnly(a.events), statusOnly(b.events), 'a different seed changed the story, not just its rhythm')
  assert.notDeepEqual(a.events, b.events)
})

test('a chat opened mid-turn gets the conversation so far, and the words in progress', () => {
  const setup = started()
  play(setup, 34_500 - SAMPLE_SIM_JOIN_MS)
  const layout = setup.seeded.ids.get('layout')
  const history = setup.run.historyOf(layout)
  assert.equal(history[0].who, 'you')
  assert.match(history[0].text, /^Fix the export layout/)
  assert.ok(history.some(entry => entry.who === 'action' && entry.tool === 'Command'))
  const view = setup.run.viewOf(layout)
  assert.equal(typeof view.streaming, 'string')
  assert.ok(view.streaming.length > 0 && 'Long account names now wrap inside their column, and the amount column keeps its width. Checked against the long-name fixtures.'.startsWith(view.streaming),
    `the reply in progress is not offered to a chat opened now: ${JSON.stringify(view.streaming)}`)
  assert.ok(view.sessionId.startsWith(SAMPLE_SIM_SESSION_PREFIX))
})

test('the loop never ends and the script is bounded', () => {
  const beats = compileSampleScript()
  assert.ok(beats.length > 200)
  assert.ok(beats.every(beat => beat.at >= 0 && beat.at < SAMPLE_SIM_LOOP_MS), 'a beat falls outside the round')
  for (let i = 1; i < beats.length; i += 1) assert.ok(beats[i - 1].at <= beats[i].at)
  const setup = started()
  const { statuses } = play(setup, SAMPLE_SIM_LOOP_MS * 2 + 40_000, 500)
  assert.ok(statuses.get('controller').filter(status => status === 'running').length >= 3, 'the controller did not start its next rounds')
})

test('the module owns no timers, storage, network or drawing, and imports only the copy', () => {
  for (const banned of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch(', 'XMLHttpRequest', 'WebSocket',
    'localStorage', 'sessionStorage', 'indexedDB', 'mcAgent', 'window.', 'document.', 'canvas', 'WebGL', 'Math.random']) {
    assert.ok(!code.includes(banned), `src/sample-simulation.js must not use ${banned}`)
  }
  const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./fleet-tree-copy.js'])
})

test('Wait for resets counts down on the agent itself, second by second, then retries', () => {
  const setup = started()
  const totals = setup.seeded.ids.get('totals')
  const noteAt = loopSec => {
    setup.run.advance(T0 - SAMPLE_SIM_JOIN_MS + loopSec * 1000)
    const node = setup.store.getNode(totals)
    return `${node.status} | ${node.statusNote}`
  }
  assert.match(noteAt(40), /^turn-failed \| .*retrying automatically in 0:38\.$/)
  assert.match(noteAt(60), /^turn-failed \| .*retrying automatically in 0:18\.$/)
  assert.match(noteAt(77.5), /^turn-failed \| .*retrying automatically in 0:01\.$/)
  assert.match(noteAt(79), /^running \| $/)
})
