import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { orphanedNodeSeatSweepProposal } from '../../src/orphaned-node-seat-sweep.js'
import { mountComputers, settle, COMPUTER_ID } from './helpers/t1308-computers-fixture.mjs'

test('zero authoritative candidates is a silent no-op without reading an empty or unknown tree store', () => {
  for (const snapshot of [() => ({ nodes: [] }), () => { throw new Error('unreadable') }, () => null]) {
    let reads = 0
    const result = orphanedNodeSeatSweepProposal({ candidateIds: [], store: { snapshot() { reads++; return snapshot() } } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.candidateIds, [])
    assert.equal(result.snapshot, null, 'no invented authoritative tree snapshot')
    assert.equal(reads, 0, 'nothing to release needs no tree read')
  }
})

test('unknown candidates and actual candidates retain the sweep safety refusals', () => {
  for (const candidateIds of [null, {}, 'node-1-seat']) {
    assert.equal(orphanedNodeSeatSweepProposal({ candidateIds }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  }
  for (const [snapshot, code] of [
    [() => ({ nodes: [] }), 'TREE_STORE_EMPTY'],
    [() => { throw new Error('unreadable') }, 'TREE_STORE_UNREADABLE'],
    [() => ({ nodes: [{ id: 'live' }], persistenceFailed: true }), 'TREE_STORE_PERSISTENCE_FAILED'],
  ]) {
    const result = orphanedNodeSeatSweepProposal({ candidateIds: ['node-1-seat'], nodeSeatCount: 4, store: { snapshot } })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
  }
  const store = { snapshot: () => ({ nodes: [{ id: 'live' }] }) }
  assert.equal(orphanedNodeSeatSweepProposal({ store, candidateIds: [''], nodeSeatCount: 4 }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  const accepted = orphanedNodeSeatSweepProposal({ store, candidateIds: ['live', 'node-1-seat', 'node-1-seat'], nodeSeatCount: 4 })
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.candidateIds, ['node-1-seat'])
  assert.equal(accepted.fraction, 0.25)
})

test('fresh mounted Computers with no node seats shows no sweep refusal or release', async t => {
  const fixture = await mountComputers(t, { agents: [{ id: 'controller', role: 'controller', enabled: true }] })
  const status = fixture.view.el.querySelector('.org-status')
  assert.ok(status)
  assert.equal(status.textContent, '')
  assert.equal(status.hidden, true)
  assert.deepEqual(fixture.operations, [])
})

test('mounted Computers refuses an empty fleet with actual seats and refuses unknown org candidates', async t => {
  for (const [agents, code] of [
    [[{ id: 'node-1-seat', role: 'worker', enabled: true }], 'TREE_STORE_EMPTY'],
    [null, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE'],
  ]) await t.test(code, async child => {
    const fixture = await mountComputers(child, { agents })
    const status = fixture.view.el.querySelector('.org-status')
    assert.equal(status.hidden, false)
    assert.equal(status.dataset.refusalCode, code)
    assert.ok(status.textContent.length > 0)
    assert.deepEqual(fixture.operations, [])
  })
})

/* T1365: a + agent tab declares a `standalone-<uuid>` seat before its chat
 * exists. A tab lost to a restart or a crash never closes, and the node sweep
 * only reads `node-<n>-` ids, so every such seat stayed enabled forever and
 * counted toward the organisation's bound (LIVE agent-org.json held three).
 * The mounted page must release a + agent seat that no tab holds, no saved
 * tree names and that has no saved conversation -- and keep LO-5: an empty or
 * unreadable tree state refuses and releases nothing. */
const solo = n => `standalone-0000000${n}-0000-4000-8000-00000000000${n}`
const seat = id => ({ id, displayName: 'Agent 1', role: 'worker', provider: 'claude', enabled: true, nodeId: id })
const CONTROLLER = Object.freeze({ id: 'controller', role: 'controller', enabled: true })
const LIVE_NODE = Object.freeze({ id: 'node-1-live', role: 'worker' })
function releasing(agents) {
  let revision = 1
  return request => {
    const index = agents.findIndex(agent => agent.id === request.id)
    if (index >= 0) agents.splice(index, 1)
    revision += 1
    return { ok: true, org: { revision, agents: [...agents], relationships: [] } }
  }
}
const released = fixture => fixture.operations.filter(row => row.name === 'releaseSeat').map(row => row.request.id)
const refusalShown = fixture => {
  const status = fixture.view.el.querySelector('.org-status')
  return status && !status.hidden ? status.dataset.refusalCode || 'shown-without-code' : null
}

test('a + agent seat no tab holds and no conversation names is released on load; one with a saved conversation is kept (T1365)', async t => {
  const { createTranscriptStore } = await import('../../src/session-transcript-store.js')
  const { safeTreeStorage } = await import('../../src/fleet-trees.js')
  const agents = [CONTROLLER, seat(solo(1)), seat(solo(2))]
  const fixture = await mountComputers(t, {
    nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
    seed: storage => createTranscriptStore({ computerId: COMPUTER_ID, storage: safeTreeStorage(storage) })
      .save(solo(2), { lines: [{ who: 'you', text: 'Keep this conversation.', at: 1 }] }),
  })
  await settle()
  assert.deepEqual(released(fixture), [solo(1)], 'the lost + agent seat was not released, or a kept one was')
  const request = fixture.operations.find(row => row.name === 'releaseSeat').request
  assert.equal(request.expectedRevision, 1)
  assert.deepEqual(request.audit, { seatId: solo(1), priorRoleId: 'worker', priorManagerId: null, proposedReleasedSeatIds: [solo(1)] })
  assert.ok(agents.some(agent => agent.id === solo(2)), 'a + agent seat with a saved conversation was released')
  assert.equal(refusalShown(fixture), null, 'a successful sweep drew a refusal')
})

test('an open + agent tab keeps its seat when Computers is left and reopened; a lost one beside it is released (T1365)', async t => {
  const agents = [CONTROLLER]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents) })
  const workspace = fixture.graph?.workspace
  assert.ok(workspace && typeof workspace.openStandalone === 'function', 'the mounted page has no + agent workspace')
  await workspace.openStandalone()
  await settle()
  const open = [...workspace.standalone.keys()]
  assert.equal(open.length, 1, 'the + agent tab did not open')
  assert.match(open[0], /^standalone-[0-9a-f-]{36}$/)
  // The seat the tab declared, and one left by a tab lost before this load.
  agents.push(seat(open[0]), seat(solo(3)))
  await fixture.remount()
  await settle()
  assert.deepEqual(released(fixture), [solo(3)], 'the open tab lost its seat, or the lost one was kept')
  assert.ok(agents.some(agent => agent.id === open[0]), 'the open + agent tab\'s seat was released')
})

test('an empty or unreadable saved tree refuses the + agent sweep and releases nothing (LO-5, T1365)', async t => {
  const { fleetTreesStorageKey } = await import('../../src/fleet-trees.js')
  for (const [label, options, code] of [
    ['empty', {}, 'TREE_STORE_EMPTY'],
    ['unreadable', { seed: storage => storage.setItem(fleetTreesStorageKey(COMPUTER_ID), '{"version":1,"computerId":') }, 'TREE_STORE_UNREADABLE'],
  ]) await t.test(label, async child => {
    const agents = [CONTROLLER, seat(solo(4))]
    const fixture = await mountComputers(child, { nodes: [], agents, releaseSeat: releasing(agents), ...options })
    await settle()
    assert.deepEqual(released(fixture), [], label + ' tree state released a seat')
    assert.equal(refusalShown(fixture), code, label + ' tree state did not refuse visibly')
  })
})

/* B4 (1.0.48): the open New agent tabs are written down so they come back after
 * a restart. The sweep runs before any of them has remounted, so the list is
 * what tells an open tab from a lost one -- including a tab that never sent,
 * which has no conversation to keep its seat. And a seat WITH a conversation is
 * never a candidate at all: it no longer raises the empty-trees notice, and it
 * no longer takes one of the two places a load may release. */
const TABS_KEY = computerId => 'mc.fleet.standalone-tabs.v1:' + computerId
const listed = (...ids) => JSON.stringify({ v: 1, tabs: ids.map((id, index) => ({
  id, name: `Agent ${index + 1}`, tier: 'claude-sonnet', effort: 'high', openedAt: 1, sessionId: null })) })
async function savedConversations(...ids) {
  const { createTranscriptStore } = await import('../../src/session-transcript-store.js')
  const { safeTreeStorage } = await import('../../src/fleet-trees.js')
  return storage => {
    const store = createTranscriptStore({ computerId: COMPUTER_ID, storage: safeTreeStorage(storage) })
    for (const id of ids) store.save(id, { lines: [{ who: 'you', text: `Keep ${id}.`, at: 1 }] })
  }
}

test('a never-sent tab named by the open-tab list keeps its seat through a restart (B4)', async t => {
  const agents = [CONTROLLER, seat(solo(6))]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
    seed: storage => storage.setItem(TABS_KEY(COMPUTER_ID), listed(solo(6))) })
  await settle()
  assert.deepEqual(released(fixture), [], 'an open tab lost its seat before it could come back')
  assert.ok(agents.some(agent => agent.id === solo(6)))
})

test('a damaged open-tab list refuses the + agent sweep and releases nothing (B4)', async t => {
  const agents = [CONTROLLER, seat(solo(6))]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
    seed: storage => storage.setItem(TABS_KEY(COMPUTER_ID), '{"v":1,"tabs":') })
  await settle()
  assert.deepEqual(released(fixture), [])
  assert.equal(refusalShown(fixture), 'TREE_SEAT_SWEEP_HELD_UNREADABLE')
})

test('a tab listed for another computer keeps its seat too (B4)', async t => {
  const agents = [CONTROLLER, seat(solo(7))]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
    seed: storage => storage.setItem(TABS_KEY('other-computer'), listed(solo(7))) })
  await settle()
  assert.deepEqual(released(fixture), [], 'a seat another computer\'s tab still holds was released')
})

test('with no trees, a lost seat that has a saved conversation raises no empty-trees notice (B4)', async t => {
  const agents = [CONTROLLER, seat(solo(8))]
  const fixture = await mountComputers(t, { nodes: [], agents, releaseSeat: releasing(agents), seed: await savedConversations(solo(8)) })
  await settle()
  assert.deepEqual(released(fixture), [])
  assert.equal(refusalShown(fixture), null, 'a seat the sweep would keep anyway raised the empty-trees notice')
})

test('two lost seats with conversations do not hold back a third with none (B4)', async t => {
  const agents = [CONTROLLER, seat(solo(1)), seat(solo(2)), seat(solo(3))]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents), seed: await savedConversations(solo(1), solo(2)) })
  await settle()
  assert.deepEqual(released(fixture), [solo(3)], 'the seat with nothing saved was stuck behind the two-seat bound')
  assert.ok(agents.some(agent => agent.id === solo(1)) && agents.some(agent => agent.id === solo(2)))
})

test('the + agent proposal holds LO-5 and reads no tree when there is nothing to release (T1365)', async () => {
  const sweep = await import('../../src/orphaned-node-seat-sweep.js')
  assert.equal(typeof sweep.orphanedStandaloneSeatSweepProposal, 'function', 'there is no + agent seat sweep')
  const propose = sweep.orphanedStandaloneSeatSweepProposal
  let reads = 0
  const storeOf = snapshot => ({ snapshot() { reads++; return snapshot() } })
  // Nothing this window does not hold: silent, and no tree read at all.
  for (const snapshot of [() => ({ nodes: [] }), () => { throw new Error('unreadable') }]) {
    reads = 0
    const idle = propose({ store: storeOf(snapshot), candidateIds: [solo(1)], heldIds: new Set([solo(1)]) })
    assert.deepEqual({ ok: idle.ok, candidateIds: [...idle.candidateIds] }, { ok: true, candidateIds: [] })
    assert.equal(reads, 0)
  }
  // Something to release and an unhealthy tree: refused, nothing proposed.
  for (const [snapshot, code] of [
    [() => ({ nodes: [] }), 'TREE_STORE_EMPTY'],
    [() => { throw new Error('unreadable') }, 'TREE_STORE_UNREADABLE'],
    [() => ({ nodes: [{ id: 'node-1-live' }], persistenceFailed: true }), 'TREE_STORE_PERSISTENCE_FAILED'],
  ]) {
    const refused = propose({ store: storeOf(snapshot), candidateIds: [solo(1)], heldIds: new Set() })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, code)
    assert.match(refused.reason, /agent-tab seats were not released/)
  }
  // Unknown inputs refuse rather than read as "nothing held".
  assert.equal(propose({ candidateIds: null, heldIds: new Set() }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  assert.equal(propose({ candidateIds: [solo(1)], heldIds: null }).code, 'TREE_SEAT_SWEEP_HELD_UNREADABLE')
  assert.equal(propose({ candidateIds: ['standalone-not-a-uuid'], heldIds: new Set() }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  // Held and tree-named seats are never proposed; at most two per load.
  const healthy = { snapshot: () => ({ nodes: [{ id: 'node-1-live' }, { id: solo(2) }] }) }
  const accepted = propose({ store: healthy, candidateIds: [solo(1), solo(2), solo(3), solo(4), solo(5), solo(1)], heldIds: new Set([solo(3)]) })
  assert.equal(accepted.ok, true)
  assert.deepEqual([...accepted.candidateIds], [solo(1), solo(4)])
  assert.equal(sweep.ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxReleases, 2)
})

/* B4 review (1.0.48), D5. A damaged list of open tabs -- or one a newer copy wrote -- on this
 * computer or on another one this page can never rewrite, put the sweep's refusal up on every load,
 * even when there was no agent-tab seat to release at all. That breaks LO-5's "nothing to release
 * is silent", and the sentence said "seats" and gave nothing to do. It now refuses only while a
 * seat no open tab here holds could otherwise have been released, and says how to fix the list. */
const statusText = fixture => fixture.view.el.querySelector('.org-status')?.textContent || ''
test('a damaged open-tab list with nothing to release raises no notice, on any computer (B4 review D5)', async t => {
  for (const [label, key, value] of [
    ['this computer, bad bytes', COMPUTER_ID, '{"v":1,"tabs":'],
    ['another computer, a newer copy\'s list', 'other-computer', '{"v":2,"tabs":[]}'],
  ]) await t.test(label, async child => {
    const agents = [CONTROLLER]
    const fixture = await mountComputers(child, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
      seed: storage => storage.setItem(TABS_KEY(key), value) })
    await settle()
    assert.deepEqual(released(fixture), [])
    assert.equal(refusalShown(fixture), null, 'THE DEFECT: nothing could be released, and the page still refused')
  })
})

test('a damaged list elsewhere does not refuse over a seat an open tab here holds (B4 review D5)', async t => {
  const agents = [CONTROLLER]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents) })
  const workspace = fixture.graph?.workspace
  await workspace.openStandalone()
  await settle()
  const [open] = [...workspace.standalone.keys()]
  assert.equal(typeof open, 'string', 'fixture premise: the tab opened')
  agents.push(seat(open))
  fixture.world.storage.setItem(TABS_KEY('other-computer'), '{"v":2,"tabs":[]}')
  await fixture.remount()
  await settle()
  assert.deepEqual(released(fixture), [])
  assert.equal(refusalShown(fixture), null, 'the only seat is this page\'s own open tab, so there was nothing to refuse over')
})

test('a damaged list refuses in plain words that say how to fix it (B4 review D5)', async t => {
  const agents = [CONTROLLER, seat(solo(6))]
  const fixture = await mountComputers(t, { nodes: [LIVE_NODE], agents, releaseSeat: releasing(agents),
    seed: storage => storage.setItem(TABS_KEY('other-computer'), '{"v":1,"tabs":') })
  await settle()
  assert.deepEqual(released(fixture), [])
  assert.equal(refusalShown(fixture), 'TREE_SEAT_SWEEP_HELD_UNREADABLE')
  const words = statusText(fixture)
  assert.equal(/\bseats?\b/i.test(words), false, `the refusal says "seats": ${words}`)
  assert.match(words, /Open a new agent tab/, 'the refusal does not say what fixes it')
  for (const sentence of words.split(/(?<=\.)\s+/).filter(Boolean)) {
    assert.equal(sentence.split(/\s+/).length <= 25, true, `a sentence over 25 words: ${sentence}`)
  }
})
