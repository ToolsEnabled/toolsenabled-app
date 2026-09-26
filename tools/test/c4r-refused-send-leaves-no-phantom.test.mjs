import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import vm from 'node:vm'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { functionSource, realOutbox } from './fixtures/recovery-outbox.mjs'
import { createSingleFlight } from '../../src/single-flight.js'
import { isResourceHold } from '../../src/tree-launch-queue.js'
import { sessionEndedWithApp } from '../../src/tree-session-liveness.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
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
    Date, destroyed: false, LAUNCH_TIERS, slotAccountStartOptions, withResearchTreeBinding, pendingModelChoices: new Map(),
    treeStore: { getNode: () => current, setNodeStatus(id, status) { current.status = status } },
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
  const api = vm.runInNewContext(`(() => { ${['pendingModelChoice', 'treeCardSend', 'stripPhantomYouLine', 'resumeNodeSession', 'recoverDeadSessionSend'].map(functionSource).join('\n')}; return { treeCardSend, recoverDeadSessionSend } })()`, sandbox)
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
  const input = root.querySelector('.chat-input textarea')
  return { lines, root, input, outbox, sent, attempted, resumed, accepted, failures, heldEvents, promotions, deliveredIds, release, api, current: () => current,
    rehydrate: () => realOutbox(disk).list(current.sessionId),
    send: async text => { input.value = text; root.querySelector('.chat-send').dispatch('click'); await settle() },
    waiting: () => Array.from(outbox.list(current.sessionId), entry => entry.text),
    messages: who => root.querySelectorAll('.msg').filter(row => row.classList.contains(who)).map(row => row.textContent),
  }
}


/* c4 review (1.0.48 candidate 4). Real window, c4: a tree agent's message
 * waited 30 s for another agent's admission and was refused
 * MC_TRANSCRIPT_ADMISSION_PENDING ("was not sent. Your draft is kept"). The
 * bubble went, the draft came back -- and on the next repaint the refused
 * message was back in the conversation as a sent "you" line with no answer,
 * because this branch never takes back the line the send appended. */
for (const code of ['MC_TRANSCRIPT_ADMISSION_PENDING', 'MC_TRANSCRIPT_SEND_STOPPED']) test(`c4r: a refusal that proves nothing was sent takes back the you-line it appended (${code})`, async () => {
  const f = fixture({ sendFailure: code })
  const words = 'Reply with exactly the single word DATE and nothing else.'
  await f.send(words)
  assert.equal(f.attempted.length, 1, 'the send reached the host once')
  assert.deepEqual(f.sent, [])
  assert.equal(f.resumed.length, 0, 'not a dead session: no recovery')
  assert.equal(f.input.value, words, 'the draft is back in the composer')
  assert.equal(f.lines.some(line => line.who === 'you' && line.text === words), false,
    'the refused words must not stay in the conversation record, or a repaint shows them as sent')
  assert.equal(f.messages('you').some(text => text.includes('DATE')), false, 'no sent bubble either')
})

test('c4r: an unconfirmed refusal keeps its line (it may have reached the provider)', async () => {
  const f = fixture({ sendFailure: 'CODEX_PROTOCOL_INVALID' })
  const words = 'Reply with exactly the single word FIG and nothing else.'
  await f.send(words)
  assert.equal(f.lines.some(line => line.who === 'you' && line.text === words), true)
})
