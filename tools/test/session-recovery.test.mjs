// Messaging a dead agent just works (iteration 6, owner: "We still get this
// message" — the sessionGone refusal standing where a recovery belongs).
//
// The pins here are the recovery's ORDER, because the order is the
// correctness: the phantom you-line strips BEFORE the resume reads the saved
// conversation (or the words ride twice — once in the seed, once queued); the
// typed message reserves its place BEFORE awaiting the fresh session; and the honest dead
// end survives as the fallback for the day the recovery itself fails.
//
// Beneath it all, the liveness rule: a restart-stale node (saved 'running'
// loads as 'starting', forever, over a session this run never owned) must
// read NOT-busy, or its sends park in a queue nothing will ever drain and the
// recovery is unreachable.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { QUEUE_PANEL, sendFailureIsUnconfirmed, sendRefusalSentence } from '../../src/fleet-tree-copy.js'
import { functionSource, realOutbox } from './fixtures/recovery-outbox.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

test('busy is liveness, not status — and the send path uses it', () => {
  /* The rule moved into src/tree-session-liveness.js when the restart-stale
     defect was closed, because six surfaces on this page needed to ask the same
     question and each was answering it its own way. It is DRIVEN in
     tools/test/zombie-session.test.mjs rather than matched; what is pinned here
     is that this view still reads it from there. */
  const liveness = view.slice(view.indexOf('const nodeSessionLive'), view.indexOf('const nodeSessionLive') + 400)
  assert.match(liveness, /sessionIsLive\(node, ownedSessions\(\)/,
    'the view stopped asking the shared liveness rule; restart-stale nodes read busy forever again')
  /* AND it hands that rule the expiring evidence, which is the half membership
     cannot supply. Without it a session that dies while the app keeps running
     stays in ownedSessions() and reads busy for the rest of the run -- 99 of
     the 185 sessions in the measured window had no end record. Pinned here
     because this file already owns "the view still asks the shared rule"; the
     rule itself is DRIVEN in tools/test/tree-session-liveness.test.mjs. */
  assert.match(liveness, /sessionIsLive\(node, ownedSessions\(\), sessionEvidence\(\)\)/,
    'the view stopped handing liveness its expiring evidence; a session that dies mid-run reads busy forever again')
  /* The owned set is this run's session map, except while the example's own
     simulated store is on the page (2026-09-11 example upgrade). */
  assert.match(view, /const ownedSessions = \(\) => \(sampleRun && treeStore && treeStore === sampleRunStore \? sampleRun\.liveSessions : sessionNodeIds\)/,
    'the view\'s owned sessions stopped being this run\'s session map')
  assert.match(view, /from '\.\.\/tree-session-liveness\.js'/,
    'the shared liveness rule is no longer imported by the page that needs it')
  const rule = view.slice(view.indexOf('const nodeBusy'), view.indexOf('const nodeBusy') + 400)
  assert.match(rule, /nodeIsBusy\(node, ownedSessions\(\), sessionEvidence\(\)\)/,
    'nodeBusy no longer checks session liveness against expiring evidence; stale nodes read busy forever again')
  /* The whole function, by its own boundaries. This read a fixed 2400
     characters, which is a guess at where treeCardSend ends: it left about a
     hundred characters of slack, so a comment added above the busy branch --
     not a change to the branch at all -- pushed `if (nodeBusy(node))` out of
     the window and turned this red. The boundary tools/test/
     b3-turnstamp-real-send-paths.test.mjs already uses for the same function
     covers strictly more of it, so both assertions below get stronger. */
  const send = view.slice(view.indexOf('function treeCardSend'), view.indexOf('async function drainOutboxMessage'))
  for (const state of [{ busy: true }, { applying: true }]) {
    const f = refusedSendFixture('UNUSED', state)
    assert.deepEqual(f.requests, [], 'busy or switching sessions must not dispatch a provider send')
    assert.deepEqual(f.events, [
      ['person'], ['outbox', 'session', 'keep these words'], ['accepted'], ['reply', 'queued locally'],
    ])
    assert.deepEqual(f.failures, [])
  }
  assert.ok(!/const busy = node\.status === 'starting' \|\| node\.status === 'running'/.test(send),
    'the raw status busy test is back in treeCardSend; dead sessions eat messages again')
})

// Exercise the actual private send function. Matching a copy-helper name
// missed the distinction between a proven refusal and unconfirmed delivery.
function refusedSendFixture(code, { attachments, recoveryAttempted = false, queueResult = { ok: true }, busy = false, applying = false } = {}) {
  const begin = view.indexOf('  function treeCardSend(')
  const end = view.indexOf('\n  }\n', begin)
  assert.ok(begin >= 0 && end > begin, 'treeCardSend must have a complete function boundary')
  const events = [], failures = [], recoveries = [], queued = [], requests = []
  const node = { id: 'conversation', sessionId: 'session', status: 'finished' }
  const callbacks = { attachments, recoveryAttempted,
    reply: value => events.push(['reply', value]),
    fail: (sentence, detail) => failures.push({ sentence, detail: detail && { ...detail } }),
    queued: value => queued.push(value), accepted: () => {
      if (busy || applying) events.push(['accepted'])
      else assert.fail('a rejected transport send was accepted')
    },
  }
  const send = vm.runInNewContext(`(${view.slice(begin, end + 4)})`, {
    notePersonSpokeTo: () => events.push(['person']), treeStore: {}, parseSlashCommand: () => null,
    nodeBusy: () => busy, pendingModelChoice: () => applying ? { applying: true } : null,
    outboxEnqueue(sessionId, text) { events.push(['outbox', sessionId, text]); return { ok: true, sentence: 'queued locally' } },
    withResearchTreeBinding: bridge => bridge,
    sessionModelOverride: new Map(), sessionPendingImages: new Map(),
    window: { mcAgent: { send(request) { requests.push(request); return Promise.reject({ code }) } } },
    awaitTurnReply: () => events.push(['await']), dropTurnReply: () => events.push(['drop']),
    transcriptAppend: () => events.push(['append']),
    stripPhantomYouLine: (target, session, text) => events.push(['strip', target, session, text]),
    recoverDeadSessionSend: (...args) => { events.push(['recover']); recoveries.push(args) },
    queueForSession: (target, text) => { events.push(['queue', target, text]); return queueResult },
    refusalCode, QUEUE_PANEL, sendFailureIsUnconfirmed, queuedSendRefusalSentence: sendRefusalSentence,
  })
  send(node, 'keep these words', callbacks)
  return { events, failures, recoveries, queued, requests, node, callbacks }
}

for (const code of ['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED', 'AGENT_SESSION_UNKNOWN', 'AGENT_SESSION_ENDED']) {
test(`${code} strips the phantom line and dispatches automatic recovery`, async () => {
  const attachments = [{ path: 'owned-image' }]
  const f = refusedSendFixture(code, { attachments })
  await new Promise(setImmediate)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].text, 'keep these words')
  assert.deepEqual(f.events.map(event => event[0]), ['person', 'await', 'append', 'drop', 'strip', 'recover'])
  assert.deepEqual(f.events[4].slice(1), [f.node, 'session', 'keep these words'])
  assert.equal(f.recoveries.length, 1)
  const [target, text, handlers] = f.recoveries[0]
  assert.equal(target, f.node)
  assert.equal(text, 'keep these words')
  for (const name of ['reply', 'fail', 'queued', 'attachments', 'accepted']) assert.equal(handlers[name], f.callbacks[name])
  assert.deepEqual(f.failures, [])
  assert.deepEqual(f.queued, [])
})

}

test('a dead replacement restores the draft without recursively starting another agent', async () => {
  const f = refusedSendFixture('MC_AGENT_SESSION_ENDED', { recoveryAttempted: true })
  await new Promise(setImmediate)
  assert.equal(f.recoveries.length, 0)
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0].detail.restoreDraft, true)
  assert.equal(f.failures[0].detail.unconfirmed, false)
})

test('other send refusals preserve the draft and distinguish proven rejection from unknown delivery', async () => {
  for (const code of ['MC_AGENT_FOREIGN_SESSION', 'MC_AGENT_NOT_OWNER', 'AGENT_INVALID_INPUT', 'CODEX_PROTOCOL_INVALID', 'UNRECOGNIZED_TRANSPORT_FAILURE', undefined]) {
    const f = refusedSendFixture(code)
    await new Promise(setImmediate)
    assert.equal(f.recoveries.length, 0, `${code} must not start a replacement`)
    assert.deepEqual(f.events.map(event => event[0]), ['person', 'await', 'append', 'drop'])
    assert.deepEqual(f.queued, [])
    const actualCode = refusalCode({ code })
    assert.deepEqual(f.failures, [{ sentence: sendRefusalSentence(actualCode),
      detail: { code: actualCode, unconfirmed: sendFailureIsUnconfirmed(actualCode), restoreDraft: true } }])
    assert.ok(f.failures[0].sentence.length > 0)
  }
})

test('a turn becoming busy queues text or retains attachments without starting recovery', async () => {
  for (const mode of ['queue', 'queue-refused', 'attachment']) {
    const f = refusedSendFixture('AGENT_TURN_ACTIVE', {
      ...(mode === 'attachment' ? { attachments: [{ path: 'owned-image' }] } : {}),
      ...(mode === 'queue-refused' ? { queueResult: { ok: false, sentence: 'storage refused' } } : {}),
    })
    await new Promise(setImmediate)
    assert.equal(f.recoveries.length, 0)
    assert.deepEqual(f.events.map(event => event[0]), ['person', 'await', 'append', 'drop', 'strip', ...(mode === 'attachment' ? [] : ['queue'])])
    if (mode === 'queue') {
      assert.deepEqual(f.queued, [QUEUE_PANEL.turnBecameBusy])
      assert.deepEqual(f.failures, [])
    } else {
      assert.deepEqual(f.queued, [])
      assert.deepEqual(f.failures, mode === 'attachment'
        ? [{ sentence: QUEUE_PANEL.busyAttachment, detail: { retract: true } }]
        : [{ sentence: 'storage refused', detail: { unconfirmed: false } }])
    }
  }
})

test('the phantom you-line strips from BOTH copies before the resume reads them', () => {
  /* THE STRIP MOVED, AND THE RULE DID NOT. It used to live inside
     recoverDeadSessionSend, BELOW that function's three early returns (the
     start-control switch, the quarter-minute limiter, the already-recovering
     guard), so a refused or rate-limited recovery left the line standing --
     a phantom YOU bubble as the only thing a panel drew. It now runs in the
     rejection branch that dispatches the recovery, which is above all three
     and still before the resume reads the record. Both copies, same order. */
  const strip = view.slice(view.indexOf('function stripPhantomYouLine'))
  const body = strip.slice(0, strip.indexOf('async function recoverDeadSessionSend'))
  assert.ok(body.indexOf('held.pop()') !== -1, 'the window transcript keeps the phantom you-line; the words ride twice')
  assert.match(body, /transcriptStore\.save\(node\.id, \{\s*lines: trimmed,/,
    'the durable record keeps the phantom you-line; the seed reads it and the queue re-sends it')
  const send = view.slice(view.indexOf('function treeCardSend'), view.indexOf('function stripPhantomYouLine'))
  const branch = send.slice(send.indexOf("['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED'"))
  assert.ok(branch.indexOf('stripPhantomYouLine(') !== -1, 'the refused send hands to the recovery without taking its line back')
  assert.ok(branch.indexOf('stripPhantomYouLine(') < branch.indexOf('recoverDeadSessionSend('),
    'the resume runs before the strip — it seeds the phantom line into the fresh agent')
  const recovery = view.slice(view.indexOf('async function recoverDeadSessionSend'), view.indexOf('async function drainOutboxMessage'))
  assert.ok(recovery.indexOf('held.pop()') === -1,
    'the recovery strips a second time; typing the same words twice would then take a real line')
})

for (const mode of ['engine', 'summary', 'bare', 'ready']) {
  test(`recovered text ${mode === 'summary' ? 'waits behind the summary turn' : `sends immediately at the idle ${mode} session`}`, async () => {
    const outbox = realOutbox(), wire = [], replies = [], notes = [], failures = []
    let node = { id: 'node', sessionId: 'old', status: 'finished' }, accepted = 0
    const sandbox = {
      Date, isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', startControlOffReason: () => 'disabled',
      recoveringNodes: new Set(), treeStore: { getNode: () => node },
      transcriptStore: { has: () => mode !== 'bare' },
      START_REFUSAL: { sessionGone: 'gone' }, QUEUE_PANEL,
      RECOVERED_SESSION: { reconnecting: 'reconnecting', bare: 'starting', summarised: 'used the summary' },
      outboxEnqueue: outbox.enqueue, outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel,
      nodeBusy: current => current.status === 'running', nodeSessionEnded: () => false,
      async resumeNodeSession(target, options) {
        assert.equal(options.deliverQueued, false, 'the recovery must be the single owner of the first post-resume drain')
        assert.deepEqual(Array.from(outbox.list('old'), row => row.text), ['FIRST'], 'the text reserves its FIFO place before awaiting resume')
        outbox.moveSession('old', 'new')
        node = { ...node, sessionId: 'new', status: mode === 'summary' ? 'running' : 'finished' }
        return mode === 'engine' ? 'engine' : mode === 'ready' ? 'ready' : true
      },
      drainOutboxMessage(sessionId, nodeId, entry) { wire.push(entry.text); outbox.confirmDelivered(sessionId, entry) },
      treeCardSend() { assert.fail('text recovery must share the real FIFO') },
    }
    const recover = vm.runInNewContext(`(${functionSource('recoverDeadSessionSend')})`, sandbox)
    await recover(node, 'FIRST', {
      reply: text => replies.push(text), note: text => notes.push(text),
      fail: text => failures.push(text), accepted: () => accepted++,
    })
    assert.equal(accepted, 1)
    assert.deepEqual(failures, [])
    assert.deepEqual(wire, mode === 'summary' ? [] : ['FIRST'])
    assert.deepEqual(Array.from(outbox.list('new'), row => row.text), mode === 'summary' ? ['FIRST'] : [])
    assert.deepEqual(notes, [mode === 'bare' ? 'starting' : 'reconnecting', ...(mode === 'summary' ? ['used the summary'] : mode === 'ready' ? ['A fresh agent will receive your message together with the saved conversation.'] : [])],
      'the composer receives a recovery notice, with the summary cost only after a seeded fallback')
    assert.deepEqual(replies, [], 'product recovery notices must not appear as an agent answer')
  })
}

test('the recovery is bounded and the honest dead end survives it', () => {
  /* SLICED BY STRUCTURE, NOT BY BYTE COUNT. These windows used to be
     `indexOf(...) + 4200`, and a comment added above the needle pushed it out
     of range -- the test then reported a real behaviour as missing. The
     function's own end is the honest boundary. */
  const recovery = functionSource('recoverDeadSessionSend')
  assert.match(recovery, /recoveryAttempted: true/, 'the direct retry must not start a replacement loop')
  assert.match(recovery, /refuseDraft\(resumeRefusal\?\.message \|\| START_REFUSAL\.sessionGone,/,
    'the sessionGone sentence no longer backs the recovery — a failed resume goes silent')
  assert.match(recovery, /RECOVERED_SESSION\.reconnecting/, 'the recovery no longer says what it is doing')
  /* The cost sentence is said only where a cost was paid. A real resume
     re-sends nothing, so promising tokens up front would be charging him in
     words for something that did not happen. */
  // The engine/summary/bare/ready behavioral cases above verify which notice
  // reaches the composer; the ready path carries history with the first intent.
})
