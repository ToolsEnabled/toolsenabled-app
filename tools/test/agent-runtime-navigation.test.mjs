import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { treeNodeClock } from '../../src/tree-session-liveness.js'
import { fmtRuntime } from '../../src/runtime-clock.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'

function fixture(t, { send = async () => ({ ok: true }), queued = [] } = {}) {
  const cells = new Map()
  const storage = { read: key => cells.get(key) || null, write: (key, value) => { cells.set(key, structuredClone(value)); return true } }
  let at = Date.parse('2026-09-08T04:00:00Z'), serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'local', storage,
    now: () => new Date(at).toISOString(), makeId: kind => `${kind}-${++serial}` })
  const node = treeStore.addNode({ role: 'worker', message: 'Finish the assigned change.' }).node
  treeStore.attachSession(node.id, 'session')
  treeStore.setNodeStatus(node.id, 'running')
  const transcriptStore = createTranscriptStore({ computerId: 'local', storage })
  transcriptStore.save(node.id, { lines: [{ who: 'you', text: node.message, at }], threadId: 'thread' })
  const owned = new Map([['session', node.id]])
  const events = new Set(), sent = [], confirmed = [], queue = [...queued]
  let allowed = true
  const coordinator = createAccountRecoveryCoordinator({ sessionNodeIds: owned,
    canStart: () => allowed, canContinue: () => allowed,
    bridge: { onEvent: fn => { events.add(fn); return () => events.delete(fn) },
      send: args => { sent.push(args); return send(args) } },
    outbox: { takeNext: () => queue.shift(), confirmDelivered: (_session, entry) => confirmed.push(entry),
      requeueFront: (_session, entry) => queue.unshift(entry) } })
  const context = { treeStore, transcriptStore }
  coordinator.register('local', context)
  t.after(() => coordinator.destroy())
  const emit = event => { for (const listener of events) listener({ sessionId: 'session', event }) }
  return { coordinator, context, treeStore, node, owned, transcriptStore, queue, sent, confirmed, events, emit,
    pass: ms => { at += ms }, allow: value => { allowed = value },
    clock: () => { const clock = treeNodeClock(treeStore.getNode(node.id), owned); return fmtRuntime(clock.runtimeEpoch, clock.stoppedAt ?? at) } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const delta = (text, turnId = 'turn-1') => ({ type: 'assistant_text_delta', text, turnId })
const done = (turnId = 'turn-1', status = 'completed') => ({ type: 'turn_completed', turnId, status })

test('ordinary session completes after leaving Computers: reply survives and the clock stops', t => {
  const f = fixture(t)
  const leave = f.coordinator.subscribe(() => {}, { observes: () => true })
  f.emit(delta('Implemented '))
  f.pass(20_000)
  leave()
  f.emit(delta('and verified.'))
  f.pass(10_000)
  f.emit(done())
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
  assert.equal(f.treeStore.getNode(f.node.id).reply, 'Implemented and verified.')
  assert.equal(f.transcriptStore.get(f.node.id).lines.at(-1).text, 'Implemented and verified.')
  assert.equal(f.clock(), '0:00:30')
  f.pass(3_600_000)
  assert.equal(f.clock(), '0:00:30', 'an idle hour must not become an hour of agent work')
  assert.equal(f.coordinator.sessionStore('local'), f.treeStore, 'navigation must reuse the live store')
})

test('an ordinary partial turn and its original clock survive reopening Computers', t => {
  const f = fixture(t)
  f.pass(15_000)
  f.emit(delta('Working on the tests.'))
  const notices = []
  f.coordinator.subscribe(value => notices.push(value))
  f.coordinator.register('local', { ...f.context, treeStore: f.coordinator.sessionStore('local') })
  assert.equal(notices.at(-1).partialText, 'Working on the tests.')
  assert.equal(f.treeStore.getNode(f.node.id).status, 'running')
  f.pass(15_000)
  assert.equal(f.clock(), '0:00:30')
  assert.equal(f.events.size, 1, 'repeated navigation must not multiply background listeners')
  f.owned.clear()
  assert.equal(f.coordinator.sessionStore('local'), null, 'saved session IDs cannot prove a live session')
})

test('the foreground remains the only writer and a stale completion cannot settle a newer turn', t => {
  const f = fixture(t)
  const leave = f.coordinator.subscribe(() => {}, { observes: () => true })
  f.emit(delta('Foreground answer.'))
  f.emit(done())
  assert.equal(f.transcriptStore.get(f.node.id).lines.length, 1)
  leave()
  f.emit(delta('New answer.', 'turn-2'))
  f.emit(done())
  assert.equal(f.treeStore.getNode(f.node.id).status, 'running')
  f.emit(done('turn-2'))
  f.emit(done('turn-2'))
  assert.equal(f.transcriptStore.get(f.node.id).lines.filter(line => line.text === 'New answer.').length, 1)
})

test('successful background completion sends exactly one queued message and waits for its completion', async t => {
  const f = fixture(t, { queued: [{ text: 'Next task' }, { text: 'Last task' }] })
  f.emit(delta('First done.'))
  f.emit(done())
  await flush()
  assert.deepEqual(f.sent.map(value => value.text), ['Next task'])
  assert.equal(f.queue.length, 1)
  assert.equal(f.confirmed.length, 1)
  f.emit(delta('Next done.', 'turn-2'))
  f.emit(done('turn-2'))
  await flush()
  assert.deepEqual(f.sent.map(value => value.text), ['Next task', 'Last task'])
  assert.equal(f.queue.length, 0)
})

test('a failed background send preserves the queued words', async t => {
  const f = fixture(t, { queued: [{ text: 'Preserve this' }], send: async () => { throw new Error('Not available') } })
  f.emit(delta('Done.'))
  f.emit(done())
  await flush()
  assert.equal(f.queue[0].text, 'Preserve this')
  assert.equal(f.confirmed.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished', 'a refused send cannot leave a ticking clock')
})

test('completion arriving before send acknowledgement still releases the following queued message', async t => {
  let f
  f = fixture(t, { queued: [{ text: 'Quick task' }, { text: 'Following task' }],
    send: async () => {
      if (f.sent.length === 1) {
        f.emit(delta('Quick task finished.', 'turn-2'))
        f.emit(done('turn-2'))
      }
      return { ok: true }
    } })
  f.emit(delta('First done.'))
  f.emit(done())
  await flush()
  assert.deepEqual(f.sent.map(value => value.text), ['Quick task', 'Following task'])
  assert.equal(f.confirmed.length, 2)
})

test('the actual Computers mount reuses the session store instead of reopening saved running clocks', t => {
  const f = fixture(t)
  f.pass(25_000)
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const context = vm.createContext({
    ...computersViewAuthorityBindings(),
    treeStore: null, treeStoreId: null, treeStoreProblem: '',
    treeHeadIds: new Set(),
    treeHeadIdsOf: vm.runInNewContext(source.match(/^  const treeHeadIdsOf = (.+)$/m)[1]),
    drivenComputerCopy: local => local,
    transcriptStore: null, diffHistoryStore: null,
    treePersistenceUnsub: null, treeStoreLiveRelease: null,
    recoveryCoordinator: () => f.coordinator,
    RUN_STARTING_TREE_STORES: new Map(), RUN_TREE_RUNTIME_STORES: new Map(),
    releaseTreeStore: () => {}, refreshTreeNames: () => {},
    createFleetTreeStore: () => { throw new Error('A live clock was reopened from saved state') },
    reportTreePersistence: () => {}, markTreeStoreLive: () => () => {},
    window: {}, createTranscriptStore: () => { throw new Error('Not needed for this mount check') },
    createChatDiffHistoryStore: () => { throw new Error('Not needed for this mount check') },
    nodeReplies: new Map(), currentDataSource: () => 'local',
  })
  vm.runInContext(declaredFunctionSource(source, 'openTreeStore'), context)
  assert.equal(context.openTreeStore('local'), f.treeStore)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'running')
  assert.equal(f.clock(), '0:00:25')
})

test('interrupts, disabled controls, and session exits do not launch queued work', async t => {
  for (const scenario of ['interrupt', 'disabled', 'exit']) {
    const f = fixture(t, { queued: [{ text: 'Do not lose this' }] })
    f.emit(delta('Partial work.'))
    if (scenario === 'disabled') f.allow(false)
    if (scenario === 'exit') f.emit({ type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } })
    else f.emit(done('turn-1', scenario === 'interrupt' ? 'interrupted' : 'completed'))
    await flush()
    assert.deepEqual(f.sent, [])
    assert.equal(f.queue.length, 1)
    if (scenario === 'exit') {
      assert.equal(f.owned.has('session'), false)
      assert.equal(f.treeStore.getNode(f.node.id).status, 'turn-failed')
    }
  }
})
