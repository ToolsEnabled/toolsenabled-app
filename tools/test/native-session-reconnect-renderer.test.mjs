/* A RENDERER RELOAD IS NOT AN APP RESTART -- the native half.
 *
 * OWNER HAND TEST on the promoted native pair (app 2fd352b2; 68c7bca9 is the
 * later, unpromoted transcript repair this branch builds on): Page 2 was
 * reloaded at 10:21 while a host session was working. The answer that session
 * produced at 10:30 is durable in node-transcripts, and the page still showed
 * the previous reply with the node drawn as "starting". The session was alive
 * the whole time. Root's baseline reproduced the same shape on Codex: a
 * twenty-second child exited with its nonce on disk while the reloaded page
 * stayed running with no answer (evidence native-reload-before-proof.json).
 *
 * RUN_SESSION_NODES is module-local, so the reload emptied it, and
 * handleAgentEvent discards every event whose session is not in it.
 * reconnectSavedRemoteSessions repaired exactly this for the website, through
 * the relay journal and mcRemoteEvents, neither of which exists in the app.
 *
 * These cases mount the REAL Computers view over a native (desktop) world:
 * mcShell.getBridgeProof is present, so resolveDataSource answers 'local'. A
 * node saved with a sessionId and no entry in the module's session map IS the
 * post-reload state, which is why seeding the store and mounting is the whole
 * reproduction -- no reload is simulated or faked.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { fleetFetch, installWorld, mountView, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

register('./css-loader.mjs', import.meta.url)

const savedNode = (storage, computerId, nodeId) =>
  JSON.parse(storage.getItem(fleetTreesStorageKey(computerId))).nodes.find(node => node.id === nodeId)

/* One node's durable transcript. `pages` are consumed one per read, the last
   repeating, so a case can make the hydration read answer with the old record
   and the reconnect's own read answer with what was written while away. */
function transcripts(computerId, nodeId, pages) {
  const reads = []
  const appended = []
  let index = 0
  return {
    reads,
    appended,
    bridge: {
      list: async () => ({ ok: true, records: [{ computerId, nodeId }] }),
      read: async request => {
        reads.push(request)
        const page = pages[Math.min(index, pages.length - 1)]
        index += 1
        const entries = typeof page === 'function' ? await page() : page
        return { ok: true, entries, metadata: { computerId, nodeId }, before: null }
      },
      append: async request => { appended.push(...(request.entries || [])); return { ok: true } },
      bind: async () => ({ ok: true }),
      onError: () => () => {},
    },
  }
}

/* The native world, with the host reads the reconnect depends on. `activity`
   is a list of answers, one per call: the reconnect asks twice on purpose,
   before and after the disk read. */
async function nativeWorld(t, {
  computerId, nodeId, sessionId, status = 'running',
  activity = [{ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
  models = null, pages = [[]], hold = false, chat = false,
} = {}) {
  const world = await installWorld(fleetFetch({ computerId }))
  const store = transcripts(computerId, nodeId, pages)
  let view
  t.after(() => { view?.destroy(); delete window.mcTranscripts; world.restore() })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status })
  const calls = []
  const listeners = new Set()
  const waiting = []
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.models = models || (async request => {
    calls.push(['models', request.sessionId])
    return { provider: 'codex', catalogSupported: true, models: [] }
  })
  let asked = 0
  world.bridge.sessionActivity = async request => {
    calls.push(['activity', request.sessionId])
    const answer = activity[Math.min(asked, activity.length - 1)]
    asked += 1
    if (hold) await new Promise(resolve => waiting.push(resolve))
    return answer
  }
  const sends = []
  world.bridge.send = async request => { sends.push(request); return { ok: true, turnId: 'drained-turn' } }
  window.mcTranscripts = store.bridge
  let surface = null
  if (chat) {
    const { computersView } = await import('../../src/views/computers.js')
    view = computersView({ initialComputer: computerId, navigate() {}, chatWorkspace: true })
    document.body.appendChild(view.el)
    await view.chatWorkspace.ready
    await settle()
    const host = document.createElement('div')
    document.body.appendChild(host)
    surface = view.chatWorkspace.mount(host, { nodeId })
    t.after(() => { surface.dispose(); host.remove() })
    await settle()
  } else view = await mountView(world, { computerId })
  return {
    view, world, calls, store, sends, surface,
    node: () => savedNode(world.storage, computerId, nodeId),
    emit: async event => { for (const listener of listeners) await listener({ sessionId, event }); await settle(8) },
    held: () => waiting.length,
    /* The reconnect asks for activity twice, so releasing once would leave the
       second read hanging and the edge never restored. Keep letting go until
       no read is waiting. */
    release: async () => {
      for (let round = 0; round < 8; round += 1) {
        while (waiting.length) waiting.shift()()
        await settle(10)
        if (!waiting.length) break
      }
      await settle(30)
    },
  }
}

test('a working native session is verified with its own host and reconnected across a reload', async t => {
  const f = await nativeWorld(t, {
    computerId: 'native-live-computer', nodeId: 'native-live-node', sessionId: 'native-live-session',
  })
  assert.deepEqual(f.calls, [
    ['models', 'native-live-session'],
    ['activity', 'native-live-session'],
    ['activity', 'native-live-session'],
  ], 'identity first, then activity either side of the disk read, before any edge is restored')

  await f.emit({ type: 'assistant_text_delta', turnId: 'after-reload-turn', text: 'THE REPLY AFTER THE RELOAD' })
  await f.emit({ type: 'turn_completed', turnId: 'after-reload-turn', status: 'completed' })
  assert.equal(f.node().status, 'finished', 'the completion after the reload settles the saved node')
  assert.equal(f.node().reply, 'THE REPLY AFTER THE RELOAD',
    'the reply that arrives after a reload reaches the conversation, exactly')
})

test('a session this window does not own is refused, and its events stay discarded', async t => {
  const f = await nativeWorld(t, {
    computerId: 'native-foreign-computer', nodeId: 'native-foreign-node', sessionId: 'native-foreign-session',
    models: async () => { const error = new Error('Unknown sessionId'); error.code = 'MC_AGENT_UNKNOWN_SESSION'; throw error },
  })
  assert.deepEqual(f.calls, [], 'a refused identity read asks for nothing further')
  const before = f.node().status
  await f.emit({ type: 'assistant_text_delta', turnId: 'foreign-turn', text: 'NOT THIS WINDOWS WORK' })
  await f.emit({ type: 'turn_completed', turnId: 'foreign-turn', status: 'completed' })
  assert.equal(f.node().status, before, 'a session that failed verification must not be routed or settled')
  assert.doesNotMatch(f.node().reply || '', /NOT THIS WINDOWS WORK/)
})

test('a dead session from a previous run of the app stays refused after a reload', async t => {
  const f = await nativeWorld(t, {
    computerId: 'native-dead-computer', nodeId: 'native-dead-node', sessionId: 'native-dead-session',
    models: async () => ({ ok: false, code: 'MC_AGENT_SESSION_ENDED' }),
  })
  assert.deepEqual(f.calls, [], 'an ended session is never asked for its activity')
  assert.ok(!['finished', 'turn-failed'].includes(f.node().status),
    `a full restart must not settle the saved node, saw ${f.node().status}`)
  await f.emit({ type: 'turn_completed', turnId: 'dead-turn', status: 'completed' })
  assert.ok(!['finished', 'turn-failed'].includes(f.node().status),
    'an event for an unverified session must still be discarded')
})

test('a session the host is already closing is not reconnected', async t => {
  const f = await nativeWorld(t, {
    computerId: 'native-closing-computer', nodeId: 'native-closing-node', sessionId: 'native-closing-session',
    activity: [{ ok: true, busy: false, closing: true, lastTurnStatus: 'completed', turnsCompleted: 1 }],
  })
  assert.deepEqual(f.calls, [['models', 'native-closing-session'], ['activity', 'native-closing-session']],
    'a closing session is refused at the first activity answer')
  assert.ok(!['finished', 'turn-failed'].includes(f.node().status),
    'a session on its way out is not settled from its last status')
  await f.emit({ type: 'turn_completed', turnId: 'closing-turn', status: 'completed' })
  assert.ok(!['finished', 'turn-failed'].includes(f.node().status), 'nor routed afterwards')
})

/* ---------- the turn that ended while the page was away ---------- */

const AWAY_OLD = [{ id: 'agent:native-away-session:older-turn', who: 'agent', text: 'THE OLD ANSWER', at: 1, turnStamp: 'older-turn' }]
const AWAY_NEW = [
  ...AWAY_OLD,
  { id: 'agent:native-away-session:away-turn', who: 'agent', text: 'THE ANSWER WRITTEN WHILE AWAY', at: 2, turnStamp: 'away-turn' },
]

test('the answer written while away is read after hydration and settled by the host\'s own word', async t => {
  /* The hydration read answers with the record as it was when the page
     loaded; the reconnect's own read answers with what was written after it.
     That is the exact shape of the owner's bug, so the case is only honest if
     the two reads differ. */
  const f = await nativeWorld(t, {
    computerId: 'native-away-computer', nodeId: 'native-away-node', sessionId: 'native-away-session',
    activity: [{ ok: true, busy: false, closing: false, lastTurnStatus: 'completed', turnsCompleted: 2 }],
    pages: [AWAY_OLD, AWAY_NEW],
  })
  assert.ok(f.store.reads.length >= 2, `the reconnect must read the record again, saw ${f.store.reads.length} reads`)
  assert.equal(f.node().status, 'finished', 'the provider\'s own completed word settles the node')
  assert.equal(f.node().reply, 'THE ANSWER WRITTEN WHILE AWAY',
    'the card must show the answer from the later read, not the one hydration saw')
})

for (const [lastTurnStatus, expected] of [['failed', 'turn-failed'], ['interrupted', 'turn-failed'], ['error', 'turn-failed']]) {
  test(`an idle session whose last turn ended ${lastTurnStatus} is not drawn as finished`, async t => {
    const f = await nativeWorld(t, {
      computerId: `native-${lastTurnStatus}-computer`, nodeId: `native-${lastTurnStatus}-node`, sessionId: `native-${lastTurnStatus}-session`,
      activity: [{ ok: true, busy: false, closing: false, lastTurnStatus, turnsCompleted: 1 }],
      pages: [[{ id: 'agent:1', who: 'agent', text: 'Partial words before it stopped.', at: 2, turnStamp: 'stopped-turn' }]],
    })
    assert.equal(f.node().status, expected, `${lastTurnStatus} must not be read as success`)
  })
}

test('an idle session whose host recorded no outcome keeps the status it was saved with', async t => {
  /* Partial speech on disk and no recorded completion: an empty or lost turn.
     Nothing here may invent success, and no queued work may be released. */
  const outbox = await import('../../src/session-outbox.js')
  const sessionId = 'native-unknown-session'
  t.after(() => outbox.clearSession(sessionId))
  outbox.enqueue(sessionId, 'The next queued task.')
  const f = await nativeWorld(t, {
    computerId: 'native-unknown-computer', nodeId: 'native-unknown-node', sessionId,
    activity: [{ ok: true, busy: false, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
    pages: [[{ id: 'agent:1', who: 'agent', text: 'Some words, and then nothing.', at: 2, turnStamp: 'lost-turn' }]],
  })
  assert.ok(!['finished', 'turn-failed'].includes(f.node().status),
    `saved speech alone must not settle a node, saw ${f.node().status}`)
  assert.deepEqual(f.sends, [], 'an unproven outcome must not release queued work')
  assert.equal(outbox.list(sessionId).length, 1, 'the queued words wait for an explicit send')
})

/* ---------- a turn still speaking across the reload ---------- */

/* The capture is the writer for a rejoined turn, so a case supplies the record
   as the capture would have it: the snapshot the reconnect reads, then the
   complete row the reconciliation reads at completion. */
const partial = (sessionId, turnId, prefix, whole) => [
  [{ id: `agent:${sessionId}:${turnId}`, who: 'agent', text: prefix, at: 2, turnStamp: turnId }],
  [{ id: `agent:${sessionId}:${turnId}`, who: 'agent', text: prefix, at: 2, turnStamp: turnId }],
  [{ id: `agent:${sessionId}:${turnId}`, who: 'agent', text: whole, at: 2, turnStamp: turnId }],
]

test('a rejoined turn is filed from its own record, not from this window\'s remainder', async t => {
  /* Native capture flushes a turn's words as they stream, so a running turn
     already has a stamped row on disk, and a delta arriving during the
     reconnect reads may already be inside that snapshot. The window therefore
     adds nothing: the capture's own record is read at completion. */
  const sessionId = 'native-partial-session'
  const f = await nativeWorld(t, {
    computerId: 'native-partial-computer', nodeId: 'native-partial-node', sessionId,
    activity: [{ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
    pages: partial(sessionId, 'streaming-turn', 'PART ONE. ', 'PART ONE. PART TWO.'),
    chat: true,
    hold: true,
  })
  assert.ok(f.held() >= 1, 'the activity read is still in flight, which is the window being tested')
  await f.emit({ type: 'assistant_text_delta', turnId: 'streaming-turn', text: 'PART TWO.' })
  await f.release()
  await f.emit({ type: 'turn_completed', turnId: 'streaming-turn', status: 'completed' })
  await settle(30)

  assert.equal(f.node().reply, 'PART ONE. PART TWO.',
    'the card shows the whole answer exactly, with no part lost and none counted twice')
  const answers = [...f.surface.root.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  assert.deepEqual(answers, ['PART ONE. PART TWO.'], 'one actual chat row contains the entire recovered answer')
  f.surface.dispose()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const reopened = f.view.chatWorkspace.mount(host, { nodeId: 'native-partial-node' })
  t.after(() => { reopened.dispose(); host.remove() })
  await settle()
  assert.deepEqual([...reopened.root.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent),
    ['PART ONE. PART TWO.'], 'reopening uses one canonical row, not duplicate entries in memory')
})

test('a turn that really repeats itself keeps both halves', async t => {
  /* The case a prefix test would get wrong: the record says "ha" and the turn
     genuinely says "ha" again. Its own record is the only authority. */
  const sessionId = 'native-repeat-session'
  const f = await nativeWorld(t, {
    computerId: 'native-repeat-computer', nodeId: 'native-repeat-node', sessionId,
    activity: [{ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
    pages: partial(sessionId, 'repeat-turn', 'ha', 'haha'),
    hold: true,
  })
  await f.emit({ type: 'assistant_text_delta', turnId: 'repeat-turn', text: 'ha' })
  await f.release()
  await f.emit({ type: 'turn_completed', turnId: 'repeat-turn', status: 'completed' })
  await settle(30)
  assert.equal(f.node().reply, 'haha', 'a genuinely repeated word must not be collapsed')
})

test('a rejoined turn that ends with no further word still shows its saved answer', async t => {
  /* Partial speech was visible before the reload and the turn then ended with
     nothing but its completion: the complete saved text must still arrive. */
  const sessionId = 'native-terminal-session'
  const f = await nativeWorld(t, {
    computerId: 'native-terminal-computer', nodeId: 'native-terminal-node', sessionId,
    activity: [{ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
    pages: partial(sessionId, 'quiet-turn', 'THE PART SEEN BEFORE THE RELOAD ', 'THE PART SEEN BEFORE THE RELOAD AND THE REST OF IT.'),
  })
  await f.emit({ type: 'turn_completed', turnId: 'quiet-turn', status: 'completed' })
  await settle(30)
  assert.equal(f.node().reply, 'THE PART SEEN BEFORE THE RELOAD AND THE REST OF IT.',
    'a completion with no further delta still recovers the whole saved answer')
})

test('a later turn does not inherit an earlier turn\'s recovered text', async t => {
  const f = await nativeWorld(t, {
    computerId: 'native-next-computer', nodeId: 'native-next-node', sessionId: 'native-next-session',
    activity: [{ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 }],
    pages: [[{ id: 'agent:native-next-session:earlier-turn', who: 'agent', text: 'AN EARLIER ANSWER.', at: 2, turnStamp: 'earlier-turn' }]],
  })
  await f.emit({ type: 'assistant_text_delta', turnId: 'a-new-turn', text: 'A NEW ANSWER.' })
  await f.emit({ type: 'turn_completed', turnId: 'a-new-turn', status: 'completed' })
  assert.equal(f.node().reply, 'A NEW ANSWER.',
    'text recovered for one turn must never be prepended to a different turn')
})

/* ---------- Stop, and the queue that must not drain itself ---------- */

for (const status of ['interrupted', 'failed', 'completed']) {
  test(`a reload releases queued work only after an observed successful completion: ${status}`, async t => {
    const sessionId = `native-queue-${status}-session`
    const outbox = await import('../../src/session-outbox.js')
    t.after(() => outbox.clearSession(sessionId))
    const f = await nativeWorld(t, {
      computerId: `native-queue-${status}-computer`, nodeId: `native-queue-${status}-node`, sessionId,
      /* Busy when the reconnect starts, idle by the time it asks again: the
         turn whose completion it buffered is the one that just ended. */
      activity: [
        { ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 },
        { ok: true, busy: false, closing: false, lastTurnStatus: status, turnsCompleted: 1 },
      ],
      hold: true,
    })
    outbox.enqueue(sessionId, 'The next queued task.')
    await f.emit({ type: 'turn_completed', turnId: 'queued-turn', status })
    await f.release()
    const successful = status === 'completed'
    assert.equal(f.sends.length, successful ? 1 : 0,
      'only a positively successful completion may release queued words after a reload')
    assert.equal(outbox.list(sessionId).length, successful ? 0 : 1,
      'a stopped or failed turn keeps its queued words for an explicit send')
  })
}

test('a success observed during the reconnect cannot drain the queue under a newer busy turn', async t => {
  /* The buffered completion belongs to the turn that was running before; the
     host says something is running again by the time it is asked. The latest
     activity governs, so the queue waits. */
  const sessionId = 'native-stale-success-session'
  const outbox = await import('../../src/session-outbox.js')
  t.after(() => outbox.clearSession(sessionId))
  const f = await nativeWorld(t, {
    computerId: 'native-stale-success-computer', nodeId: 'native-stale-success-node', sessionId,
    activity: [{ ok: true, busy: true, closing: false, lastTurnStatus: 'completed', turnsCompleted: 1 }],
    hold: true,
  })
  outbox.enqueue(sessionId, 'The next queued task.')
  await f.emit({ type: 'turn_completed', turnId: 'older-turn', status: 'completed' })
  await f.release()
  assert.ok(['running', 'starting'].includes(f.node().status), 'the newer busy turn stays busy')
  assert.deepEqual(f.sends, [], 'a stale success must not release queued words while a turn is running')
  assert.equal(outbox.list(sessionId).length, 1, 'the queued words wait for the running turn')
})


test('a turn ending during the probe closes one mounted bubble with its entire canonical answer', async t => {
  const sessionId = 'native-probe-terminal-session'
  const f = await nativeWorld(t, {
    computerId: 'native-probe-terminal-computer', nodeId: 'native-probe-terminal-node', sessionId,
    activity: [
      { ok: true, busy: true, closing: false },
      { ok: true, busy: false, closing: false, lastTurnStatus: 'completed' },
    ],
    pages: partial(sessionId, 'probe-turn', 'HEL', 'HELLO'), hold: true, chat: true,
  })
  await f.emit({ type: 'assistant_text_delta', turnId: 'probe-turn', text: 'LO' })
  await f.emit({ type: 'turn_completed', turnId: 'probe-turn', status: 'completed' })
  await f.release()
  assert.equal(f.node().reply, 'HELLO')
  assert.deepEqual([...f.surface.root.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent), ['HELLO'])
})

for (const change of ['newer-turn', 'child-exit']) {
  test(`a delayed canonical read cannot overwrite ${change}`, async t => {
    const sessionId = `native-delayed-${change}-session`
    const old = [{ id: `agent:${sessionId}:old-turn`, who: 'agent', text: 'OLD CANONICAL ANSWER', at: 2, turnStamp: 'old-turn' }]
    let release
    const f = await nativeWorld(t, {
      computerId: `native-delayed-${change}-computer`, nodeId: `native-delayed-${change}-node`, sessionId,
      pages: [[], [], () => new Promise(resolve => { release = () => resolve(old) }), []],
    })
    await f.emit({ type: 'assistant_text_delta', turnId: 'old-turn', text: 'Old partial' })
    const pending = f.emit({ type: 'turn_completed', turnId: 'old-turn', status: 'completed' })
    await settle(10)
    assert.equal(typeof release, 'function', 'the canonical disk read is still pending')
    if (change === 'newer-turn') {
      await f.emit({ type: 'assistant_text_delta', turnId: 'new-turn', text: 'NEW ANSWER' })
      await f.emit({ type: 'turn_completed', turnId: 'new-turn', status: 'completed' })
    } else await f.emit({ type: 'session_ended', reason: 'exited' })
    const before = f.node()
    release()
    await pending
    assert.equal(f.node().reply, before.reply, 'the stale read cannot paint over the newer result')
    assert.equal(f.node().status, before.status, 'the stale completion cannot change current status')
    assert.doesNotMatch(f.node().reply || '', /OLD CANONICAL ANSWER/)
  })
}

test('the mounted chat keeps Stop and queued work pending after unproven cleanup, then settles its retry', async t => {
  const sessionId = 'native-cleanup-session'
  const f = await nativeWorld(t, { computerId: 'native-cleanup-computer', nodeId: 'native-cleanup-node', sessionId, chat: true })
  const outbox = await import('../../src/session-outbox.js')
  t.after(() => outbox.clearSession(sessionId))
  let calls = 0
  f.world.bridge.interrupt = async () => {
    if (++calls === 1) throw Object.assign(new Error('AGENT_STOP_PENDING: command cleanup unconfirmed'), { code: 'AGENT_STOP_PENDING' })
    return { sessionId, turnId: 'cleanup-turn' }
  }
  await f.emit({ type: 'assistant_text_delta', turnId: 'cleanup-turn', text: 'Partial answer.' })
  outbox.enqueue(sessionId, 'Keep this queued.')
  const stop = f.surface.root.querySelector('.chat-send')
  assert.ok(stop?.classList.contains('is-stop'), 'the real chat exposes Stop for the rejoined turn')
  stop.dispatch('click')
  await settle(20)
  assert.equal(calls, 1)
  let settled = false
  const completion = f.emit({ type: 'turn_completed', turnId: 'cleanup-turn', status: 'interrupted' }).then(() => { settled = true })
  await settle(20)
  assert.equal(settled, false)
  assert.equal(f.node().status, 'running')
  assert.ok(f.surface.root.querySelector('.chat-send').classList.contains('is-stop'))
  assert.equal(f.sends.length, 0)
  assert.equal(outbox.list(sessionId).length, 1)
  f.surface.root.querySelector('.chat-send').dispatch('click')
  await completion
  await settle(20)
  assert.equal(calls, 2)
  assert.equal(f.node().status, 'interrupted')
  assert.equal(f.surface.root.querySelector('.chat-send').classList.contains('is-stop'), false)
  assert.equal(f.sends.length, 0)
  assert.equal(outbox.list(sessionId).length, 1)
})

test('a direct send in a rejoined native chat stamps its original owner row when the host accepts', async t => {
  const f = await nativeWorld(t, { computerId: 'native-send-stamp-computer', nodeId: 'native-send-stamp-node', sessionId: 'native-send-stamp-session',
    status: 'finished', chat: true, activity: [{ ok: true, busy: false, closing: false, lastTurnStatus: 'success', turnsCompleted: 1 }] })
  const accepted = Promise.withResolvers()
  f.world.bridge.send = () => accepted.promise
  const input = f.surface.root.querySelector('.chat-input input')
  input.value = 'A new tool request after the earlier turn.'
  f.surface.root.querySelector('.chat-send').dispatch('click')
  await settle(10)
  const owner = [...f.surface.root.querySelectorAll('.me')].find(row => row.textContent.includes('A new tool request'))
  assert.ok(owner)
  assert.equal(owner.querySelector('.turn-stamp'), null, 'an optimistic message has no invented turn identity')
  await f.emit({ type: 'assistant_text_delta', turnId: 'direct-accepted-turn', text: 'Actual reply.' })
  accepted.resolve({ turnId: 'direct-accepted-turn' })
  await settle(20)
  assert.equal(owner.querySelector('.turn-stamp')?.textContent, 'direct-accepted-turn')
  assert.equal([...f.surface.root.querySelectorAll('.me')].filter(row => row.textContent.includes('A new tool request')).length, 1)
  await f.emit({ type: 'turn_completed', turnId: 'direct-accepted-turn', status: 'completed' })
  assert.equal(f.node().status, 'finished')
  assert.equal(f.surface.root.querySelector('.them .turn-stamp')?.textContent, 'direct-accepted-turn')
})

/* ---------- T830: the reconnect storm ---------- */

/* MEASURED 2026-09-21 on the LIVE generation (app d46c18f49): 303 lines of
   "Error occurred in handler for 'mc-agent:models': Error: MC_AGENT_UNKNOWN_SESSION"
   in the host's log within 27 minutes of activation, in bursts of 77, 76, 75
   and 75 -- one refused read per saved circle of an earlier run, per mount of
   this view or of the Home chat. Each is an Electron handler stack, because
   the host refuses by throwing. The refusal reaches the window as the sentence
   Electron wraps a rejected invoke in, without the code property. */
const hostRefusesModels = () => { throw new Error("Error invoking remote method 'mc-agent:models': Error: MC_AGENT_UNKNOWN_SESSION") }

/* A native world whose views this case mounts and unmounts itself. Each
   mount is a fresh view over the SAME window-lifetime module state, which is
   what a person navigating to the Agents page or the Home chat and back
   produces; the previous view is destroyed first, so the next mount opens
   its store from storage again and a changed saved circle is really seen.
   The one teardown destroys whatever is still mounted before the world goes,
   in that order, because a view torn down after the DOM stand-in has gone
   throws on its own animation frames. */
async function stormWorld(t, { computerId, models }) {
  const world = await installWorld(fleetFetch({ computerId }))
  const mounted = []
  t.after(() => { for (const view of mounted.splice(0)) view.destroy(); world.restore() })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.bridge.onEvent = () => () => {}
  world.bridge.models = models
  const activity = []
  world.bridge.sessionActivity = async request => {
    activity.push(request.sessionId)
    return { ok: true, busy: false, closing: false, lastTurnStatus: null, turnsCompleted: 0 }
  }
  return {
    world, activity,
    async mount() {
      for (const view of mounted.splice(0)) view.destroy()
      const view = await mountView(world, { computerId })
      mounted.push(view)
      await settle(20)
      return view
    },
  }
}

test('a saved session the host does not hold is asked about once across mounts, not once per mount', async t => {
  const computerId = 'native-storm-computer', nodeId = 'native-storm-node', sessionId = 'native-storm-session'
  const reads = []
  const f = await stormWorld(t, { computerId, models: async request => { reads.push(request.sessionId); hostRefusesModels() } })
  seedTreeNode(f.world.storage, { computerId, nodeId, sessionId, status: 'finished' })
  await f.mount()
  assert.deepEqual(reads, [sessionId], 'the first mount asks the host once')
  for (let again = 0; again < 3; again += 1) await f.mount()
  assert.deepEqual(reads, [sessionId],
    'three more mounts ask nothing: the host already refused this session and the circle has not changed')
  assert.equal(savedNode(f.world.storage, computerId, nodeId).status, 'finished',
    'the saved circle keeps the status it was saved with')
  assert.deepEqual(f.activity, [], 'a refused session is never asked for its activity')
  /* The circle changed: a different saved status is a reason to ask again,
     once, because it is the one other thing that can mean the host was asked
     to do something with this session. */
  seedTreeNode(f.world.storage, { computerId, nodeId, sessionId, status: 'interrupted' })
  await f.mount()
  assert.deepEqual(reads, [sessionId, sessionId], 'a changed circle is asked about again, once')
  await f.mount()
  assert.deepEqual(reads, [sessionId, sessionId], 'and not again while it stays the same')
})

test('a session the host holds is still verified on a mount that follows a refused one', async t => {
  /* The memory is per session: a refusal remembered for one saved circle
     must not silence the probe that brings a different, living session back
     after a reload. */
  const computerId = 'native-storm-mixed-computer'
  const dead = 'native-storm-mixed-dead-session', live = 'native-storm-mixed-live-session'
  const reads = []
  const f = await stormWorld(t, { computerId, models: async request => {
    reads.push(request.sessionId)
    if (request.sessionId === live) return { provider: 'codex', catalogSupported: true, models: [] }
    hostRefusesModels()
  } })
  seedTreeNode(f.world.storage, { computerId, nodeId: 'native-storm-mixed-dead', sessionId: dead, status: 'finished' })
  await f.mount()
  assert.deepEqual(reads, [dead])
  /* A second circle under the first (one root per tree, or the parser
     refuses the whole document), saved with a session the host does hold. */
  const saved = JSON.parse(f.world.storage.getItem(fleetTreesStorageKey(computerId)))
  saved.nodes.push({ ...saved.nodes[0], id: 'native-storm-mixed-live', parentId: 'native-storm-mixed-dead', sessionId: live, status: 'running' })
  f.world.storage.setItem(fleetTreesStorageKey(computerId), JSON.stringify(saved))
  await f.mount()
  await settle(30)
  assert.deepEqual(reads, [dead, live], 'the refused circle is left alone and the living one is verified with the host')
  assert.deepEqual(f.activity, [live, live],
    'the living session is reconnected the ordinary way: activity either side of the disk read')
})
