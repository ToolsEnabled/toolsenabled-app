import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import vm from 'node:vm'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { functionSource, realOutbox } from './fixtures/recovery-outbox.mjs'
import { createSingleFlight } from '../../src/single-flight.js'
import { isResourceHold } from '../../src/tree-launch-queue.js'
import { sessionEndedWithApp } from '../../src/tree-session-liveness.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { RECOVERED_SESSION, QUEUE_PANEL, RESUME_PANEL, START_REFUSAL, sendFailureIsUnconfirmed } from '../../src/fleet-tree-copy.js'

const { restore } = installDomStandIn(globalThis)
const originalStorage = globalThis.localStorage
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) }
const { buildChat } = await import('../../src/components.js')
const mounted = new Set()
afterEach(() => { for (const root of mounted) root.dispose(); mounted.clear() })
after(() => { restore(); if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage })
const settle = async () => { for (let step = 0; step < 16; step++) await Promise.resolve() }

function fixture({ startAllowed = true, resume = 'refused', initialQueue = [], sendFailure = 'MC_AGENT_UNKNOWN_SESSION' } = {}) {
  const disk = new Map(), outbox = realOutbox(disk), sent = [], attempted = [], resumed = [], accepted = [], failures = [], heldEvents = [], promotions = [], deliveredIds = []
  let current = { id: 'fictional-node', sessionId: 'retired-session', status: 'failed' }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const lines = [], turns = new Map([['retired-session', lines]])
  const sandbox = {
    Date, destroyed: false, treeStore: { getNode: () => current, setNodeStatus(id, status) { current.status = status } },
    window: { mcAgent: { async send({ sessionId, text }) {
      attempted.push({ sessionId, text })
      if (sessionId === 'retired-session') throw Object.assign(new Error(sendFailure), { code: sendFailure })
      sent.push({ sessionId, text }); return { turnId: 'fictional-turn' }
    } } },
    notePersonSpokeTo() {}, parseSlashCommand: () => null, awaitTurnReply() {}, dropTurnReply() {},
    sessionModelOverride: new Map(), sessionPendingImages: new Map(), sessionCompletedTurnIds: new Map(),
    sessionTranscripts: turns, transcriptAppend(sessionId, line) { (turns.get(sessionId) || lines).push(line) },
    transcriptStore: { has: () => true, get: () => ({ lines: [] }) }, TRANSCRIPT_LIMITS: { maxLineChars: 600 },
    turnLogAppend() {}, refreshTree() {}, refusalCode, queuedSendRefusalSentence: code => code,
    sendFailureIsUnconfirmed, START_NEEDS_APP_TEXT: () => 'Open the app.',
    isWriteEnabled: () => startAllowed, START_CONTROL_FLAG: 'start', startControlOffReason: () => 'Starting agents is switched off.',
    START_REFUSAL, RECOVERED_SESSION, QUEUE_PANEL, RESUME_PANEL,
    recoveringNodes: new Set(), nodeReplacementFlight: createSingleFlight(), recoveryCoordinator: () => null, isResourceHold,
    retainStartingTreeStore: () => () => {}, nodeBusy: node => node.status === 'running', nodeSessionEnded: node => sessionEndedWithApp(node, new Set()),
    outboxEnqueue: outbox.enqueue, outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel, outboxMoveSession: outbox.moveSession,
    outboxList: outbox.list, liveSessionId: () => current.sessionId,
    outboxPromoteFront: (sessionId, id) => { promotions.push({ sessionId, id }); return outbox.promoteFront(sessionId, id) },
    async resumeNodeSessionUnguarded(node, options) {
      resumed.push(node.id); await gate
      if (resume === 'refused') {
        options.onRefused?.({ code: 'AGENT_RESOURCE_WARMING', message: 'This computer is under heavy load.', retryable: true, sessionId: null })
        return false
      }
      if (resume === 'ended') {
        current = { ...current, sessionId: 'ended-replacement', status: 'starting' }
        options.onRefused?.({ code: 'MC_AGENT_SESSION_ENDED', message: 'The replacement ended before it accepted a turn.', retryable: false, sessionId: current.sessionId })
        return false
      }
      outbox.moveSession(current.sessionId, 'resumed-session')
      current = { ...current, sessionId: 'resumed-session', status: 'finished' }
      return 'engine'
    },
    async drainOutboxMessage(sessionId, nodeId, entry) {
      deliveredIds.push(entry.id)
      await sandbox.window.mcAgent.send({ sessionId, text: entry.text })
      outbox.confirmDelivered(sessionId, entry); current.status = 'running'
    },
  }
  const api = vm.runInNewContext(`(() => { ${['treeCardSend', 'stripPhantomYouLine', 'resumeNodeSession', 'recoverDeadSessionSend'].map(functionSource).join('\n')}; return { treeCardSend, recoverDeadSessionSend } })()`, sandbox)
  const sendNextSource = functionSource('treeChatConfigFor').match(/sendNow: (id => \{[\s\S]*?\n        \}),/)
  assert.ok(sendNextSource, 'exercise the actual Page 2 queue promotion adapter')
  const sendNext = vm.runInNewContext(`(${sendNextSource[1]})`, sandbox)
  for (const text of initialQueue) outbox.enqueue(current.sessionId, text)
  const root = buildChat({ title: 'Fictional saved conversation', seed: 0,
    status: { busy: () => current.status === 'running', subscribe: () => () => {} }, chips: {},
    queue: { list: () => outbox.list(current.sessionId), add: text => outbox.enqueue(current.sessionId, text), cancel: id => outbox.cancel(current.sessionId, id), sendNow: sendNext,
      hold(request) {
        const held = outbox.holdForSend(current.sessionId, request)
        if (!held.ok) return held
        const observed = { ...held }
        for (const key of ['confirm', 'restore']) observed[key] = (...args) => {
          const changed = held[key](...args); heldEvents.push({ key, changed, replacementStarted: resumed.length > 0 }); return changed
        }
        return observed
      },
    },
    onSend(text, handlers) { api.treeCardSend(current, text, { ...handlers, accepted: value => { accepted.push(text); handlers.accepted(value) }, fail: (message, details) => { failures.push({ message, details }); handlers.fail(message, details) } }) },
  })
  mounted.add(root)
  const input = root.querySelector('.chat-input input')
  return { root, input, outbox, sent, attempted, resumed, accepted, failures, heldEvents, promotions, deliveredIds, release, api, current: () => current,
    rehydrate: () => realOutbox(disk).list(current.sessionId),
    send: async text => { input.value = text; root.querySelector('.chat-send').dispatch('click'); await settle() },
    waiting: () => Array.from(outbox.list(current.sessionId), entry => entry.text),
    messages: who => root.querySelectorAll('.msg').filter(row => row.classList.contains(who)).map(row => row.textContent),
  }
}

test('ordinary Send keeps a refused recovery queued and reports no delivery or automatic retry', async () => {
  const f = fixture()
  f.outbox.enqueue('retired-session', 'Earlier saved request')
  await f.send('Continue the fictional research')
  assert.equal(f.resumed.length, 1)
  f.release(); await settle()
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.waiting(), ['Earlier saved request', 'Continue the fictional research'])
  assert.equal(f.input.value, '', 'accepted queue text must not also remain as a duplicate draft')
  assert.equal(f.messages('them').length, 0, 'product reconnect/queue notices must not look like an agent answer')
  const notes = f.messages('note').join(' ')
  assert.match(notes, /not (?:been )?sent/i)
  assert.match(notes, /Resume/)
  assert.doesNotMatch(notes, /when this turn finishes|automatically/i)
})

test('a definitive disabled-start refusal restores the ordinary Send draft', async () => {
  const f = fixture({ startAllowed: false })
  await f.send('Keep these fictional words')
  assert.equal(f.input.value, 'Keep these fictional words')
  assert.deepEqual(f.waiting(), [])
  assert.deepEqual(f.resumed, [])
  assert.deepEqual(f.sent, [])
})

test('a full outbox retains every older message and returns unaccepted text to the composer', async () => {
  const f = fixture(), older = Array.from({ length: 12 }, (_, index) => `Earlier ${index}`)
  for (const text of older) f.outbox.enqueue('retired-session', text)
  await f.send('One more fictional request')
  assert.equal(f.input.value, 'One more fictional request')
  assert.deepEqual(f.waiting(), older)
  assert.deepEqual(f.resumed, [])
})

test('ordinary Send resumes once and delivers its queued text once to the resumed session', async () => {
  const f = fixture({ resume: 'engine' })
  await f.send('Continue once')
  f.release(); await settle()
  assert.deepEqual(f.resumed, ['fictional-node'])
  assert.deepEqual(f.sent, [{ sessionId: 'resumed-session', text: 'Continue once' }])
  assert.deepEqual(f.waiting(), [])
  assert.equal(f.input.value, '')
})

test('a full queue during a pending reconnect preserves the newer draft and reports the real refusal', async () => {
  const f = fixture(), older = Array.from({ length: 11 }, (_, index) => `Earlier ${index}`)
  for (const text of older) f.outbox.enqueue('retired-session', text)
  await f.send('Admitted before reconnect')
  await f.send('Keep this newer draft')
  assert.equal(f.input.value, 'Keep this newer draft')
  assert.match(f.failures.at(-1).message, /12 messages waiting/)
  f.release(); await settle()
  assert.equal(f.input.value, 'Keep this newer draft', 'the older reconnect outcome must not replace a newer draft')
  assert.deepEqual(f.waiting(), [...older, 'Admitted before reconnect'])
  assert.equal(f.resumed.length, 1)
  assert.deepEqual(f.sent, [])
})

test('a known dead session returns a held Send now to its original queue before the replacement settles', async () => {
  const f = fixture({ initialQueue: ['Held fictional request'] })
  f.root.querySelector('.chat-queue-now').dispatch('click')
  await settle()
  assert.equal(f.resumed.length, 1)
  assert.equal(f.heldEvents.filter(event => event.key === 'restore' && event.changed).length, 1, 'the definitive rejection releases the transport hold without deleting its row')
  assert.equal(f.heldEvents.filter(event => event.key === 'confirm' && event.changed).length, 0)
  assert.deepEqual(f.promotions, [], 'a progress note must not invoke the queue promotion adapter')
  assert.equal(f.attempted.length, 1, 'only the original stale-session send was attempted')
  f.release(); await settle()
  assert.deepEqual(f.waiting(), ['Held fictional request'])
  assert.equal(f.heldEvents.filter(event => event.key === 'confirm' && event.changed).length, 0)
  assert.equal(f.heldEvents.filter(event => event.key === 'restore' && event.changed).length, 1)
  assert.equal(f.attempted.length, 1)
  assert.deepEqual(f.sent, [])
})

test('a held dead-session Send now retains its original row throughout the Resume wait', async () => {
  const f = fixture({ initialQueue: ['One unchanged fictional message'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click')
  await settle()
  try {
    assert.equal(f.resumed.length, 1)
    const waiting = f.outbox.list('retired-session')
    assert.equal(waiting.length, 1, 'one Send now must never create a second durable recovery entry')
    assert.equal(waiting[0].id, original.id)
    assert.equal(waiting[0].atMs, original.atMs)
    assert.equal(waiting[0].text, original.text)
    assert.notEqual(waiting[0].deliveryUnconfirmed, true, 'the stale-session rejection proved this send was not accepted')
    const reopened = f.rehydrate()
    assert.equal(reopened.length, 1, 'a restart during the wait sees one durable entry')
    assert.equal(reopened[0].atMs, original.atMs)
    assert.equal(reopened[0].text, original.text)
    assert.notEqual(reopened[0].deliveryUnconfirmed, true)
  } finally { f.release(); await settle() }
  const retained = f.outbox.list('retired-session')
  assert.equal(retained.length, 1)
  assert.equal(retained[0].id, original.id)
  assert.equal(retained[0].atMs, original.atMs)
  assert.equal(f.sent.length, 0)
})

test('a held Send now keeps its requested priority and delivers once after a successful resume', async () => {
  const f = fixture({ resume: 'engine', initialQueue: ['Earlier fictional request', 'Chosen fictional request'] })
  const chosen = f.outbox.list('retired-session')[1]
  f.root.querySelectorAll('.chat-queue-now')[1].dispatch('click')
  await settle()
  assert.equal(f.resumed.length, 1)
  assert.equal(f.heldEvents.filter(event => event.key === 'restore' && event.changed).length, 1)
  assert.deepEqual(f.promotions, [])
  f.release(); await settle()
  assert.deepEqual(f.sent, [{ sessionId: 'resumed-session', text: 'Chosen fictional request' }])
  assert.deepEqual(f.waiting(), ['Earlier fictional request'])
  assert.deepEqual(f.deliveredIds, [chosen.id], 'the original selected entry, not a text copy, reaches delivery once')
  assert.equal(f.heldEvents.filter(event => event.key === 'confirm' && event.changed).length, 0)
  assert.equal(f.attempted.length, 2, 'one stale send followed by one delivered send, with no duplicate')
})

test('identical messages deliberately typed during a held recovery remain distinct entries', async () => {
  const f = fixture({ initialQueue: ['Same intentional words'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click'); await settle()
  await f.send('Same intentional words')
  const pending = f.outbox.list('retired-session')
  assert.equal(pending.length, 2)
  assert.equal(pending[0].id, original.id)
  assert.notEqual(pending[1].id, original.id)
  assert.ok(pending.every(entry => entry.text === original.text && entry.deliveryUnconfirmed !== true))
  f.release(); await settle()
  assert.equal(f.outbox.list('retired-session').length, 2)
  assert.equal(f.resumed.length, 1)
})

test('Unqueue during a recovery wait cancels the original row without recreating it on success', async () => {
  const f = fixture({ resume: 'engine', initialQueue: ['Cancel this pending request'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click'); await settle()
  assert.equal(f.outbox.cancel('retired-session', original.id), true)
  f.release(); await settle()
  assert.deepEqual(f.waiting(), [])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.deliveredIds, [])
})

test('Unqueue before a dead-session rejection cannot turn a cancelled hold into a new recovery entry', async () => {
  const f = fixture({ initialQueue: ['Cancel before rejection'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click')
  assert.equal(f.outbox.cancel('retired-session', original.id), true)
  await settle()
  assert.deepEqual(f.waiting(), [])
  assert.deepEqual(f.resumed, [])
  assert.equal(f.input.value, '')
})

test('an uncertain transport result keeps the original Send now unconfirmed and starts no recovery', async () => {
  const f = fixture({ initialQueue: ['Do not automatically retry uncertain words'], sendFailure: 'CODEX_PROTOCOL_INVALID' })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click'); await settle()
  const pending = f.outbox.list('retired-session')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, original.id)
  assert.equal(pending[0].atMs, original.atMs)
  assert.equal(pending[0].deliveryUnconfirmed, true)
  assert.deepEqual(f.resumed, [])
  assert.deepEqual(f.sent, [])
})

for (const context of ['closed chat', 'newer draft']) test(`a held recovery preserves its original row after an ended Resume (${context})`, async () => {
  const f = fixture({ resume: 'ended', initialQueue: ['Keep this original durable request'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click'); await settle()
  if (context === 'closed chat') f.root.dispose()
  else f.input.value = 'A newer draft must remain unchanged'
  f.release(); await settle()
  const pending = f.outbox.list(f.current().sessionId)
  assert.equal(pending.length, 1, 'hard recovery failure must not delete the original durable row')
  assert.equal(pending[0].id, original.id)
  assert.equal(pending[0].atMs, original.atMs)
  assert.equal(pending[0].text, original.text)
  assert.notEqual(pending[0].deliveryUnconfirmed, true)
  if (context === 'newer draft') assert.equal(f.input.value, 'A newer draft must remain unchanged')
  assert.deepEqual(f.sent, [])
})

test('an ended Resume does not recreate a held row deliberately Unqueued during recovery', async () => {
  const f = fixture({ resume: 'ended', initialQueue: ['Explicitly remove this request'] })
  const original = f.outbox.list('retired-session')[0]
  f.root.querySelector('.chat-queue-now').dispatch('click'); await settle()
  assert.equal(f.outbox.cancel('retired-session', original.id), true)
  f.release(); await settle()
  assert.deepEqual(f.waiting(), [])
  assert.equal(f.input.value, '')
  assert.deepEqual(f.sent, [])
})

test('an attachment refused during recovery stays in the composer contract instead of a text-only queue', async () => {
  const f = fixture(), failures = [], attachments = [{ path: 'fictional-image.png' }]
  const recovering = f.api.recoverDeadSessionSend(f.current(), 'Keep the attachment', {
    attachments, reply() {}, queued() {}, note() {}, fail: (message, details) => failures.push({ message, details }),
  })
  f.release(); await recovering
  assert.equal(failures.length, 1)
  assert.equal(failures[0].details?.restoreDraft, true)
  assert.equal(failures[0].details?.unconfirmed, false)
  assert.deepEqual(f.waiting(), [])
  assert.deepEqual(f.sent, [])
})

test('outbox storage acknowledgement does not promise a live turn will finish', () => {
  const outbox = realOutbox()
  const stored = outbox.enqueue('retired-session', 'Saved fictional request')
  assert.equal(stored.ok, true)
  assert.equal(outbox.persistence().durable, true)
  assert.match(stored.sentence, /saved on this computer/i)
  assert.doesNotMatch(stored.sentence, /sends by itself|when this turn finishes/i)
})
