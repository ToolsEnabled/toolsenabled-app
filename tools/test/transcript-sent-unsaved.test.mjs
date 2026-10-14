/* SENT, BUT NOT SAVED, IN THE WINDOW.
 *
 * shell/agent-host.cjs answers MC_TRANSCRIPT_SENT_UNSAVED when the provider
 * accepted a message and only saving it failed (see
 * transcript-accepted-unsaved-send.test.mjs for the host half). Every window
 * sender has to read that as a message that WENT: before, the same failure
 * arrived as MC_TRANSCRIPT_STORAGE_FAILED, whose sentence is "this message was
 * not sent. Your draft is kept", and each sender acted on it -- the composer
 * handed the words back to be sent again, and the queue drain put the entry
 * back at the front, where the next turn boundary sent it again by itself.
 * These cases run the real copy tables, the real mounted composer and the real
 * drainOutboxMessage with the real session outbox. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { refusalCode, unavailableReason } from '../../src/agent-availability-copy.js'
import * as copy from '../../src/fleet-tree-copy.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { clearSession, enqueue, requeueFront, takeNext, list, confirmDelivered } from '../../src/session-outbox.js'
import { retryWorld, settle } from './helpers/t844-retry-world.mjs'

const CODE = 'MC_TRANSCRIPT_SENT_UNSAVED'
const fromIpc = () => new Error("Error invoking remote method 'mc-agent:send': Error: " + CODE)
// Absent before the fix; a missing helper must read as "not accepted".
const wasAccepted = code => typeof copy.sendFailureWasAccepted === 'function' && copy.sendFailureWasAccepted(code)

test('the sent-but-unsaved answer survives IPC and says the message went', () => {
  const received = refusalCode(fromIpc())
  assert.equal(received, CODE, 'the code must be recoverable from the IPC error text')
  assert.equal(wasAccepted(received), true)
  assert.equal(copy.sendFailureIsUnconfirmed(received), false, 'the provider acceptance was observed')
  const sentence = copy.sendRefusalSentence(received)
  assert.match(sentence, /was sent/i)
  assert.match(sentence, /not saved/i)
  assert.match(sentence, /do not send it again/i)
  assert.doesNotMatch(sentence, /not sent|draft is kept|delivery could not be confirmed/i)
  assert.equal(unavailableReason(received), sentence)
  for (const code of ['MC_TRANSCRIPT_STORAGE_FAILED', 'MC_TRANSCRIPT_DISK_FULL', 'AGENT_TURN_ACTIVE', 'SOME_TRANSPORT_FAILURE']) {
    assert.equal(wasAccepted(code), false, `${code} does not prove the provider accepted anything`)
  }
})

test('the real mounted composer keeps a sent-but-unsaved message as sent and never hands the draft back', async t => {
  const f = await retryWorld(t)
  const attempts = []
  f.world.bridge.send = async request => {
    attempts.push(structuredClone(request))
    throw fromIpc()
  }
  const chat = await f.openChat()
  const words = 'Synthetic accepted but unsaved question.'
  chat.importDraft({ text: words, attachments: [] })
  const button = chat.querySelector('.chat-send')
  assert.ok(button)
  button.dispatch('click')
  await settle(25)
  assert.equal(attempts.length, 1, 'the actual view reached its send bridge once')
  assert.equal(chat.exportDraft().text, '', 'the words were sent, so they are not put back in the input to be sent again')
  assert.match(chat.textContent, /not saved/i)
  assert.match(chat.textContent, /do not send it again/i)
  assert.doesNotMatch(chat.textContent, /not sent/i)
  assert.ok(chat.textContent.includes(words), 'the sent words stay in the conversation')
  await settle(15)
  assert.equal(attempts.length, 1, 'nothing sends the same words again by itself')
})

/* The real drainOutboxMessage, evaluated with the real outbox and fleet tree
   store, the real copy helpers, and a bridge whose receipt the test settles --
   the same harness drain-outbox-after-removal.test.mjs uses. */
const VIEW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'views', 'computers.js'), 'utf8')
function drainOutboxMessageSource() {
  const start = VIEW.indexOf('async function drainOutboxMessage')
  assert.notEqual(start, -1, 'drainOutboxMessage was renamed or removed')
  const end = VIEW.indexOf("/* THE TREE'S OWN EAR ON THE SESSION STREAM.", start)
  assert.notEqual(end, -1, 'could not find where drainOutboxMessage ends')
  return VIEW.slice(start, end)
}
function memoryStorage() {
  const cells = new Map()
  return { read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null }, write(key, value) { cells.set(key, JSON.stringify(value)); return true } }
}

test('a queued message the provider accepted but could not save is settled as delivered, never queued to send again', async t => {
  let count = 0, tick = 0
  const store = createFleetTreeStore({ computerId: 'c1', storage: memoryStorage(),
    now: () => `2026-09-23T00:00:${String((tick += 1)).padStart(2, '0')}.000Z`, makeId: kind => `${kind}-${(count += 1)}` })
  const node = store.addNode({ role: 'worker' }).node
  const sessionId = 'sent-unsaved-drain'
  store.attachSession(node.id, sessionId)
  store.setNodeStatus(node.id, 'finished')
  clearSession(sessionId)
  t.after(() => clearSession(sessionId))
  enqueue(sessionId, 'queued words the provider took')
  const entry = takeNext(sessionId)
  assert.ok(entry)
  const effects = []
  const sandbox = {
    window: { mcAgent: { send: () => Promise.reject(fromIpc()) } }, treeStore: store, destroyed: false,
    sessionNodeIds: new Map([[sessionId, node.id]]), withResearchTreeBinding,
    sessionModelOverride: new Map(), outboxRequeueFront: requeueFront,
    outboxConfirmDelivered: confirmDelivered, currentRailTreeNode: null,
    refusalCode, sendFailureIsUnconfirmed: copy.sendFailureIsUnconfirmed, sendFailureWasAccepted: wasAccepted,
    queuedSendRefusalSentence: copy.sendRefusalSentence, QUEUE_PANEL: copy.QUEUE_PANEL,
    setOrgStatus: (...args) => effects.push(['status', ...args]),
    repaintRailStatus: (...args) => effects.push(['repaint', ...args]),
    transcriptAppend: (...args) => effects.push(['transcript', ...args]),
    broadcastOwnerMessage: (...args) => effects.push(['broadcast', ...args]),
    turnLogAppend: (...args) => effects.push(['turn-log', ...args]),
    refreshTree: () => effects.push(['refresh']),
  }
  const drain = vm.runInNewContext(`(${drainOutboxMessageSource().trim()})`, sandbox)
  await drain(sessionId, node.id, entry)
  assert.deepEqual(list(sessionId), [], 'the accepted words were put back in the queue')
  assert.equal(takeNext(sessionId), null, 'the next turn boundary would send the same words again')
  assert.ok(effects.some(([kind, value]) => kind === 'transcript' && value === sessionId), 'the sent words are written as sent')
  assert.equal(store.getNode(node.id).status, 'running', 'the agent is working on the accepted message')
  const status = effects.filter(([kind]) => kind === 'status').at(-1)
  assert.match(status?.[1] || '', /not saved/i, 'the one sentence says what did not happen')
})
