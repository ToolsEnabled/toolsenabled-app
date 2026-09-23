import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createTreeNodeCommandBroker,
  queueRequestOrRefuse,
  treeNodeCommandRefusalSentence,
} = require('../../shell/tree-node-command-broker.cjs')

const flush = () => new Promise(resolve => setImmediate(resolve))
const id = suffix => `tnc-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const envelope = requestId => ({
  request: {
    requestId,
    nodeId: `node-${requestId.slice(-1)}`,
    action: 'fresh-start-existing-node',
  },
})
const success = slot => ({
  requestId: slot.request.requestId,
  ok: true,
  code: null,
  nodeId: slot.request.nodeId,
  sessionId: `chat-${slot.request.requestId.slice(-1)}`,
  threadId: null,
})

test('the renderer and native context share the unchanged active deadline', async () => {
  let now = 1000, timer, sent
  const held = { request: { ...envelope(id(501)).request, action: 'create-and-start-node', nodeId: null } }
  const broker = createTreeNodeCommandBroker({ now: () => now, loadAndClaim: () => held,
    publishResult: async () => ({ ok: true }), sendToRenderer: request => { sent = request },
    setTimer(callback, delay) { timer = { callback, delay }; return timer }, clearTimer() {},
  })
  try {
    broker.setRendererReady(true); broker.queueRequest(id(501)); await flush()
    assert.equal(timer.delay, 300_000)
    assert.equal(Date.parse(sent.expiresAt), 301_000)
    const context = broker.startContext(id(501))
    context.bindNode('child')
    assert.equal(broker.startContext(id(502)), null)
    assert.throws(() => context.bindNode('other'), { code: 'TREE_DELEGATION_REFUSED' })
    now = 301_000
    assert.throws(() => context.assertCurrent(), { code: 'MC_TREE_COMMAND_COMPLETION_TIMEOUT' }, 'timer callback delay cannot extend a start')
    timer.callback(); await flush()
    assert.equal(broker.startContext(id(501)), null)
  } finally { broker.dispose() }
})

test('time spent queued cannot extend the existing local delivery deadline', async () => {
  let timer, sent
  const held = { request: { ...envelope(id(502)).request, expiresAt: new Date(330_000).toISOString() } }
  const broker = createTreeNodeCommandBroker({ now: () => 250_000, loadAndClaim: () => held,
    publishResult: async () => ({ ok: true }), sendToRenderer: request => { sent = request },
    setTimer(callback, delay) { timer = { callback, delay }; return timer }, clearTimer() {},
  })
  try {
    broker.queueRequest(id(502)); broker.setRendererReady(true); await flush()
    assert.equal(timer.delay, 80_000)
    assert.equal(Date.parse(sent.expiresAt), 330_000)
  } finally { broker.dispose() }
})

test('main-owned timeout publishes a closed failure and clears the active slot', async () => {
  const timers = []
  const published = []
  const sent = []
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (held, result) => { published.push([held, result]); return result },
    sendToRenderer: request => { sent.push(request.requestId) },
    setTimer: callback => { timers.push(callback); return callback },
    clearTimer: () => {},
    wait: async () => {},
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(1))
  await flush()
  assert.deepEqual(sent, [id(1)])
  timers[0]()
  await flush()
  assert.equal(published.length, 1)
  assert.equal(published[0][1].code, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT')
  assert.equal(broker.state().activeRequestId, null)
})

test('renderer reload durably fails an accepted request and never redispatches it', async () => {
  const published = []
  const sent = []
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (_held, result) => { published.push(result); return result },
    sendToRenderer: request => { sent.push(request.requestId) },
    setTimer: () => 1,
    clearTimer: () => {},
    wait: async () => {},
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(2))
  await flush()
  const outcome = await broker.rendererReloaded()
  assert.equal(outcome.ok, true)
  assert.equal(published[0].code, 'MC_TREE_COMMAND_RENDERER_RELOADED')
  broker.setRendererReady(true)
  await flush()
  assert.deepEqual(sent, [id(2)], 'an ambiguous provider start must not be replayed')
})

/* THE OTHER HALF OF NOT REPLAYING: THE CALLER HAS TO BE ABLE TO DECIDE.
 *
 * The test above proves the command is not repeated. That is only the right
 * behaviour if whoever asked can find out and decide for themselves, and the
 * refusal reached them as the code alone -- shell/main.cjs spelled it into
 * "The application could not add that assistant to the tree (<the code>)",
 * which names the failure and explains nothing. An assistant reading that has
 * one move to choose and no grounds to choose it on.
 *
 * This asserts the sentence for the code this broker really publishes on a
 * reload, so a rename on either side is a red test rather than a caller
 * quietly back on a bare code. The negative assertion is the load-bearing one:
 * the sentence must never claim the request did not start. It may have -- a
 * start is an IPC call into the main process and its session outlives the
 * window -- and "it did not start, ask again" is precisely the sentence that
 * buys a second paid session. */
test('the reload refusal reaches the caller as a sentence it can act on, not a bare code', async () => {
  const published = []
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (_held, result) => { published.push(result); return result },
    sendToRenderer: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
    wait: async () => {},
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(9))
  await flush()
  await broker.rendererReloaded()

  const said = treeNodeCommandRefusalSentence(published[0].code)
  assert.equal(typeof said, 'string')
  assert.ok(said.length > 0, 'a reload refusal has words, not only a code')
  assert.doesNotMatch(said, /MC_TREE_COMMAND/, 'a caller is owed the reason, not the code repeated at it')
  assert.match(said, /window reloaded/i, 'it says what happened')
  assert.match(said, /not repeated/i, 'it says what the application did not do about it')
  assert.match(said, /second paid session/i, 'it says why repeating it is the caller\'s call and not the broker\'s')
  assert.match(said, /send this request again/i, 'it says what the caller may do next')
  assert.doesNotMatch(said, /(was|were) not started|nothing (was )?started|did not start/i,
    'a start may already have succeeded, and promising otherwise pays for a second session')
})

/* THE SAME LOST ANSWER, ARRIVING THE OTHER WAY -- AND THE ONE THE FLEET HITS.
 *
 * capability/logs/actions.jsonl holds NINE agent.spawn failures whose whole
 * text is "The application could not add that assistant to the tree
 * (MC_TREE_COMMAND_COMPLETION_TIMEOUT)", eight of them inside forty-three
 * minutes -- more than the reload code above, and more recent. The timer that
 * raises it is armed only after the request reached the renderer, and firing
 * it publishes a failure without replaying, so the caller is in exactly the
 * ambiguity the reload sentence exists for: the start may have happened.
 *
 * This drives the real timer through the broker rather than asking the table
 * directly, so the code the broker PUBLISHES and the code the table ANSWERS
 * are pinned to each other; a rename on either side turns this red instead of
 * quietly dropping the caller back onto a bare code. */
test('a completion timeout reaches the caller as a sentence it can act on, not a bare code', async () => {
  const timers = []
  const published = []
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (_held, result) => { published.push(result); return result },
    sendToRenderer: () => {},
    setTimer: callback => { timers.push(callback); return callback },
    clearTimer: () => {},
    wait: async () => {},
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(10))
  await flush()
  timers[0]()
  await flush()

  assert.equal(published[0].code, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT')
  const said = treeNodeCommandRefusalSentence(published[0].code)
  assert.equal(typeof said, 'string')
  assert.ok(said.length > 0, 'a timed-out request has words, not only a code')
  assert.doesNotMatch(said, /MC_TREE_COMMAND/, 'a caller is owed the reason, not the code repeated at it')
  assert.match(said, /did not report back in time/i, 'it says what happened')
  assert.match(said, /not repeated/i, 'it says what the application did not do about it')
  assert.match(said, /second paid session/i, 'it says why asking again is the caller\'s call and not the broker\'s')
  assert.match(said, /send this request again/i, 'it says what the caller may do next')
  assert.doesNotMatch(said, /(was|were) not started|nothing (was )?started|did not start/i,
    'the request had already reached the renderer, so promising it never started pays for a second session')
})

test('a refusal this broker has no words for keeps the caller on its own wording', () => {
  assert.equal(treeNodeCommandRefusalSentence('MC_TREE_COMMAND_RESULT_MISMATCH'), null)
  assert.equal(treeNodeCommandRefusalSentence(''), null)
  assert.equal(treeNodeCommandRefusalSentence(undefined), null)
  /* Inherited object properties are not sentences: a lookup that answered
     "function String() { ... }" for the code `toString` would put the program's
     own guts in front of an assistant. */
  assert.equal(treeNodeCommandRefusalSentence('toString'), null)
})

test('result publication retries and succeeds without releasing order early', async () => {
  const events = []
  let attempts = 0
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async (_held, result) => {
      attempts += 1
      events.push(`publish-${attempts}`)
      if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'TEMP' })
      return result
    },
    sendToRenderer: request => { events.push(`send-${request.requestId.slice(-1)}`) },
    setTimer: () => 1,
    clearTimer: () => {},
    wait: async () => { events.push('wait') },
    retryDelaysMs: [1, 2, 3],
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(3))
  broker.queueRequest(id(4))
  await flush()
  const first = envelope(id(3))
  const outcome = await broker.complete(success(first))
  await flush()
  assert.equal(outcome.ok, true)
  assert.equal(outcome.attempts, 3)
  assert.equal(attempts, 3)
  assert.ok(events.indexOf('send-4') > events.indexOf('publish-3'))
})

test('permanent result failure reports terminally but never wedges the next command', async () => {
  const sent = []
  const terminal = []
  let publishCalls = 0
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: async () => {
      publishCalls += 1
      throw Object.assign(new Error('disk unavailable'), { code: 'DISK_DOWN' })
    },
    sendToRenderer: request => { sent.push(request.requestId) },
    setTimer: () => 1,
    clearTimer: () => {},
    wait: async () => {},
    retryDelaysMs: [0, 0],
    onTerminalPublicationFailure: (error, held) => terminal.push([error.code, held.request.requestId]),
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(5))
  broker.queueRequest(id(6))
  await flush()
  const outcome = await broker.complete(success(envelope(id(5))))
  await flush()
  assert.deepEqual(outcome, { ok: false, code: 'MC_TREE_COMMAND_RESULT_WRITE_FAILED' })
  assert.equal(publishCalls, 3)
  assert.deepEqual(terminal, [['DISK_DOWN', id(5)]])
  assert.deepEqual(sent, [id(5), id(6)])
  assert.equal(broker.state().activeRequestId, id(6))
})

test('completion mismatch cannot consume the active command', async () => {
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: result => result,
    sendToRenderer: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })
  broker.setRendererReady(true)
  broker.queueRequest(id(7))
  await flush()
  const answer = await broker.complete({ ...success(envelope(id(7))), requestId: id(8) })
  assert.equal(answer.code, 'MC_TREE_COMMAND_RESULT_MISMATCH')
  assert.equal(broker.state().activeRequestId, id(7))
})

/* THE OTHER DOOR A COMMAND CAN ARRIVE THROUGH.
 *
 * queueRequest() answers false, and never throws, for three reasons: a
 * disposed broker, a malformed id, or an id this process has already queued.
 * Answering false is the whole of what it does -- it writes nothing and tells
 * nobody. shell/main.cjs's LOCAL create path (dispatchTreeSpawn) checks the
 * return value for exactly that reason (its own comment: "A QUEUE THAT SAID
 * NO IS AN ANSWER, NOT A WAIT"). The SAME broker has a second caller in the
 * same file -- handleSecondInstance, reached from an entirely different OS
 * process's command line when a coordinator's detached helper hands a spooled
 * request to the already-running instance through Electron's single-instance
 * relay -- and it called queueRequest and threw the boolean away:
 *
 *   if (!requestId) return null
 *   queueTreeNodeCommand(requestId)
 *   return { focus: false }
 *
 * The helper is spawned with stdio ignored (tools/launch-tree-node-command.mjs),
 * so nothing on that side ever sees a console line. The request just sat in
 * the spool, unclaimed and unrefused, until its own lifetimeMs timed out --
 * which, to a coordinator polling for the result, is `{ ...launched, result:
 * null }` and exit code 3: an unexplained hang with no code and no reason,
 * not an answer.
 *
 * These three drive queueRequestOrRefuse directly, the shared decision both
 * doors now call through (see shell/tree-node-command-broker.cjs); the wiring
 * that proves shell/main.cjs's handoff actually calls it is
 * tools/test/tree-node-command-wiring.test.mjs. */
test('queueRequestOrRefuse queues and does not refuse an id the broker accepts', () => {
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: result => result,
    sendToRenderer: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const refusals = []
  const queued = queueRequestOrRefuse(broker, id(20), (code, reason) => refusals.push([code, reason]))
  assert.equal(queued, true)
  assert.deepEqual(refusals, [])
  assert.equal(broker.state().queued, 1, 'the request actually entered the broker, not just returned true')
})

test('queueRequestOrRefuse refuses, with a reason, when the broker is disposed -- the second-instance handoff racing app shutdown', () => {
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: result => result,
    sendToRenderer: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })
  broker.dispose()
  const refusals = []
  const queued = queueRequestOrRefuse(broker, id(21), (code, reason) => refusals.push([code, reason]))
  assert.equal(queued, false)
  assert.equal(refusals.length, 1, 'a refused queue attempt must tell its caller, not just vanish')
  const [code, reason] = refusals[0]
  assert.equal(code, 'MC_TREE_COMMAND_REQUEST_REFUSED')
  assert.equal(typeof reason, 'string')
  assert.match(reason, /did not accept this request/i)
  assert.match(reason, /"disposed":true/, 'the reason names the live broker state, the same way the local path already does')
})

/* AUDIT, WAVE 4: THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE OF THE LINE
 * BELOW -- that a plain duplicate must refuse "exactly as answerable as any
 * other refusal", same as the disposed case above. That was the previous
 * wave's whole fix applied one case too far, and it is wrong: unlike a
 * disposed broker, an id this process already queued has an ANSWER COMING --
 * the original acceptance is still going to claim and complete it (or
 * already has). A refusal written for the duplicate does not sit peacefully
 * beside that answer, it can WIN the file-spool claim out from under it,
 * because the original's claim only happens once pump() actually dequeues
 * the id (gated on renderer readiness), while a duplicate's refusal claims
 * and completes immediately. See shell/tree-node-command-broker.cjs
 * queueRequestOrRefuse for the full reasoning and
 * tools/test/tree-node-command.test.mjs, "a duplicate second-instance wake
 * for an already-queued request must not steal its claim out from under it",
 * for the end-to-end proof against the real file spool (this test here uses
 * fake loadAndClaim/publishResult stubs, so it cannot see that race itself --
 * it only pins queueRequestOrRefuse's own decision in isolation). */
test('queueRequestOrRefuse queues silently and does not refuse a duplicate of an id this process already accepted', () => {
  const broker = createTreeNodeCommandBroker({
    loadAndClaim: requestId => envelope(requestId),
    publishResult: result => result,
    sendToRenderer: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const first = []
  assert.equal(queueRequestOrRefuse(broker, id(22), (code, reason) => first.push([code, reason])), true)
  assert.deepEqual(first, [])

  const second = []
  const queued = queueRequestOrRefuse(broker, id(22), (code, reason) => second.push([code, reason]))
  assert.equal(queued, false, 'a duplicate wake for the same request must not be queued twice')
  assert.deepEqual(second, [], 'the duplicate must not write a competing refusal -- the original acceptance is still going to answer this id, and a refusal here can beat it to the claim')
  assert.equal(broker.state().queued, 1, 'the ORIGINAL request is still the one sitting in the queue, untouched by the duplicate')
})
