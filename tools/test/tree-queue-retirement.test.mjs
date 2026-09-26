import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// The engine SOURCE, not the packed capability/ layer: this suite needs
// tests/lib/isolated-environment, which the payload deliberately does not
// ship. canonicalRootForTests() honours MC_CANONICAL_ROOT, then the owner's
// private/capability-source.owner.json, exactly as the other four suites
// that load that helper do. Reading capability/ directly bailed this whole
// file out with MODULE_NOT_FOUND at the cut-1 tip (CUT1-tree-suites.tap).
const engineRoot = canonicalRootForTests()
require_(path.join(engineRoot, 'tests/lib/isolated-environment')).activate('tree-queue-retirement')
const { createTreeNodeDirectory } = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory'))
const { createLocalAgentMessageProvider } = require_(path.join(engineRoot, 'src/lib/providers/agent-comms-local'))
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))
let index = 0

async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (predicate()) return; await delay(20) }
  assert.fail(label)
}

async function fixture(t, { inFlight = false, failFirstDefer = false, failFirstAcknowledge = false, hidePendingOnce = false, stalledVerb = null, stallAt = 1, messageCount = 1,
  refuseVerb = null, refusals = 0, distinctThreads = false, readDeadlineMs = 500 } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'host-queue-retirement-'))
  const key = `retirement-${++index}`, body = `Retained report ${key}.`
  const file = path.join(scratch, 'tree.json'), brokerFile = path.join(scratch, 'broker.json')
  const directory = createTreeNodeDirectory({ file })
  const provider = createLocalAgentMessageProvider({ directory, brokerFile })
  const originalDirectory = require_(directoryPath), originalProvider = require_(providerPath), engine = require_(enginePath)
  const originalStart = engine.startCodexSession
  const exitHandlers = [], engineCloses = []
  let releaseStall, rejectStall, releaseInbox
  const inboxReady = new Promise(resolve => { releaseInbox = resolve })
  if (messageCount === 1) releaseInbox()
  const stall = new Promise((resolve, reject) => { releaseStall = resolve; rejectStall = reject })
  // Observe a rejected gate even if setup fails before the selected verb starts.
  stall.catch(() => {})
  let stalledCalls = 0
  async function waitForBroker(verb) {
    if (verb === stalledVerb && ++stalledCalls === stallAt) await stall
  }
  // The broker's own answer when it does not take custody: accepted:false with
  // a code, not a thrown error (agent-comms-local defer/discard receipts).
  let refused = 0
  const brokerRefuses = verb => verb === refuseVerb && refused < refusals && ++refused > 0
  engine.calls.length = 0; engine.adapterCalls.length = 0; engine.pendingTurns.length = 0
  engine.control.holdTurns = false
  engine.startCodexSession = async options => {
    const session = await originalStart(options)
    const ordinal = engine.calls.length - 1
    const originalClose = session.close
    // A real provider session owns its own native thread.
    if (distinctThreads) session.threadId = `${key}-thread-${ordinal}`
    session.close = (...args) => { engineCloses.push(ordinal); return originalClose(...args) }
    session.adapter.interrupt = async () => ({ requiresResume: true })
    session.adapter.transport = { write() {}, onData(listener) { exitHandlers.push(listener) } }
    return session
  }
  require_.cache[require_.resolve(directoryPath)].exports = {
    createTreeNodeDirectory: options => createTreeNodeDirectory({ ...options, file }),
  }
  const deferReceipts = []
  let deferAttempts = 0, discardAttempts = 0, acknowledgmentAttempts = 0, hiddenSnapshots = 0
  require_.cache[require_.resolve(providerPath)].exports = { ...provider, async inboxes(requests) {
    await inboxReady
    const pages = await provider.inboxes(requests)
    return pages.map(row => {
      if (!hidePendingOnce || !row.page.records.some(record => record.message.body.includes(body))) return row
      // History publication precedes the broker's final transport receipt.
      // Freeze that legitimate first-read snapshot while the handoff starts.
      hidePendingOnce = false
      hiddenSnapshots++
      return { ...row, page: { ...row.page, pendingDeliveries: [] } }
    })
  }, async defer(request) {
    deferAttempts++
    await waitForBroker('defer')
    if (failFirstDefer && deferAttempts === 1) throw new Error('one retained-queue write refusal')
    if (brokerRefuses('defer')) return { accepted: false, code: 'BROKER_DELIVERY_NOT_RETAINED' }
    const result = await provider.defer(request)
    deferReceipts.push({ messageId: request.message.id, result })
    return result
  }, async discard(request) {
    discardAttempts++
    await waitForBroker('discard')
    if (brokerRefuses('discard')) return { accepted: false, code: 'BROKER_DELIVERY_NOT_RETAINED' }
    return provider.discard(request)
  }, async acknowledgeDeferred(request) {
    acknowledgmentAttempts++
    await waitForBroker('acknowledgeDeferred')
    if (failFirstAcknowledge && acknowledgmentAttempts === 1) throw new Error('one handoff-receipt write refusal')
    return provider.acknowledgeDeferred(request)
  } }
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 35, heartbeatMs: 1000, readDeadlineMs },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }),
  })
  const visible = []
  host.onEvent(packet => visible.push(packet))
  const managerId = `${key}-manager`, recipientId = `${key}-recipient`
  const recipientStart = { treeIdentity: { selfName: 'Recipient', managerName: 'Manager' },
    requestKeys: { treeAnchors: [key, `${key}-node`], threadId: `${key}-node` } }
  t.after(async () => {
    releaseStall()
    releaseInbox()
    engine.control.holdTurns = false
    for (const pending of engine.pendingTurns.splice(0)) pending.reject(Object.assign(new Error('fixture teardown'), { code: 'ENGINE_TRANSPORT_RESET' }))
    await host.closeAll()
    engine.startCodexSession = originalStart
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.startSession({ sessionId: managerId, treeIdentity: { selfName: 'Manager', managerName: null },
    requestKeys: { treeAnchors: [key], threadId: key } })
  const recipientStarted = await host.startSession({ sessionId: recipientId, ...recipientStart })
  if (inFlight) engine.control.holdTurns = true
  else await host.sendTurn({ sessionId: recipientId, text: 'A person’s active turn.' })
  const sent = await provider.send({ from: 'Manager', to: 'Recipient', body },
    { agentSessionId: managerId, agentPrincipal: { sessionId: managerId } })
  assert.equal(sent.delivered, true)
  const sentMessages = [sent]
  for (let messageIndex = 1; messageIndex < messageCount; messageIndex++) {
    const extra = await provider.send({ from: 'Manager', to: 'Recipient', body: `${body} Additional envelope ${messageIndex}.` },
      { agentSessionId: managerId, agentPrincipal: { sessionId: managerId } })
    assert.equal(extra.delivered, true)
    sentMessages.push(extra)
  }
  releaseInbox()
  await until(() => visible.some(packet => packet.sessionId === recipientId && packet.event?.treeDelivery && packet.event.text.includes(body)),
    'the message never entered the actual recipient queue')
  const offers = () => engine.adapterCalls.filter(call => call.method === 'sendTurn' && call.request.text.includes(body))
  if (inFlight) await until(() => offers().length === 1, 'the message did not enter a pending model handoff')
  else assert.equal(offers().length, 0, 'the fixture must stop a genuinely queued message')
  return { host, engine, directory, provider, sent, sentMessages, body, visible, managerId, recipientId, recipientStart, offers,
    recipientThreadId: recipientStarted.threadId, allowRetirement: () => { refusals = 0 },
    exitRecipient: () => exitHandlers[1](null, { code: 1, signal: null }),
    state: () => JSON.parse(readFileSync(brokerFile, 'utf8')), deferAttempts: () => deferAttempts,
    acknowledgmentAttempts: () => acknowledgmentAttempts,
    discardAttempts: () => discardAttempts, deferReceipts, releaseStall, rejectStall,
    recipientEngineCloses: () => engineCloses.filter(ordinal => ordinal === 1).length,
    hiddenSnapshots: () => hiddenSnapshots,
    notices: () => visible.filter(packet => packet.sessionId === managerId && packet.event?.text?.includes(sent.messageId)),
  }
}

test('explicit Stop records an unread queued delivery and tells its sender', async t => {
  const f = await fixture(t)
  await f.host.closeSession({ sessionId: f.recipientId })
  assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
  await until(() => f.notices().length === 1, 'Stop silently dropped the sender’s accepted delivery')
  assert.equal(f.offers().length, 0)
})

test('a late rejected in-flight handoff after Stop cannot disappear from the broker', async t => {
  const f = await fixture(t, { inFlight: true })
  const late = f.engine.pendingTurns.shift()
  await f.host.closeSession({ sessionId: f.recipientId })
  late.reject(Object.assign(new Error('late provider refusal'), { code: 'ENGINE_TRANSPORT_RESET' }))
  f.engine.control.holdTurns = false
  await until(() => f.notices().length === 1, 'the batch held outside treeQueue was lost on close')
  assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
  assert.equal(f.offers().length, 1)
})

test('replacement drains parked predecessor work before any terminal discard and confirms the recovered handoff', async t => {
  const f = await fixture(t)
  await f.host.startSession({ sessionId: `${f.recipientId}-next`, replacesSessionId: f.recipientId, ...f.recipientStart })
  await until(() => f.offers().length === 1, 'replacement never received the retained original envelope')
  await until(() => f.state().deliveries.some(row => row.messageId === f.sent.messageId && Number.isSafeInteger(row.modelHandoffAtMs)),
    'recovered work has no confirmed model handoff receipt')
  assert.equal(f.state().deadLetters.length, 0, 'retirement dead-lettered work its replacement could recover')
  assert.equal(f.state().deferred.length, 0)
  assert.match(f.offers()[0].request.text, /recovered.*previous session/i)
  await delay(150)
  assert.equal(f.offers().length, 1, 'history plus the parked envelope delivered the same work twice')
})

test('an unexpected provider exit preserves unread work and sends a pending recovery notice', async t => {
  const f = await fixture(t)
  f.exitRecipient()
  await until(() => f.state().deferred?.length === 1, 'exit cleanup discarded the pending queue')
  await until(() => f.notices().some(packet => /retained|recover|resume/i.test(packet.event.text)), 'sender was not told recovery is pending')
  assert.equal(f.state().deadLetters.length, 0)
})

test('an interrupt that requires Resume retains pending work without offering it to an ended adapter', async t => {
  const f = await fixture(t)
  const stopped = await f.host.interrupt({ sessionId: f.recipientId })
  assert.equal(stopped.requiresResume, true)
  assert.equal(f.state().deferred?.length, 1)
  assert.equal(f.state().deadLetters.length, 0)
  assert.equal(f.offers().length, 0)
})

test('a failed retirement write leaves a retryable close with the original queue intact', async t => {
  const f = await fixture(t, { failFirstDefer: true })
  await assert.rejects(f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true }))
  await f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true })
  assert.equal(f.deferAttempts(), 2)
  assert.equal(f.state().deferred?.length, 1)
  assert.equal(f.state().deadLetters.length, 0)
})

test('host shutdown retains pending messages for the next app session', async t => {
  const f = await fixture(t)
  await f.host.closeAll()
  assert.equal(f.state().deferred?.length, 1)
  assert.equal(f.state().deadLetters.length, 0)
  const page = (await f.provider.inbox({ agentId: f.directory.agentIdForSession(f.managerId) })).page
  assert.ok(page.deliveryReceipts.some(row => row.messageId === f.sent.messageId && row.code === 'BROKER_DELIVERY_DEFERRED'))
})

test('a late in-flight rejection cannot erase the capture retained after a failed retirement write', async t => {
  const f = await fixture(t, { inFlight: true, failFirstDefer: true })
  const late = f.engine.pendingTurns.shift()
  await assert.rejects(f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true }))
  late.reject(Object.assign(new Error('late provider refusal'), { code: 'ENGINE_TRANSPORT_RESET' }))
  f.engine.control.holdTurns = false
  await delay(40)
  await f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true })
  assert.equal(f.deferAttempts(), 2)
  assert.equal(f.state().deferred.length, 1)
  assert.equal(f.offers().length, 1)
})

test('late acceptance after recoverable retirement records the handoff without another offer', async t => {
  const f = await fixture(t, { inFlight: true })
  const late = f.engine.pendingTurns.shift()
  await f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true })
  assert.equal(f.state().deferred.length, 1)
  late.resolve({ turnId: 'accepted-before-retirement' })
  f.engine.control.holdTurns = false
  await until(() => f.state().deliveries.some(row => row.messageId === f.sent.messageId && Number.isSafeInteger(row.modelHandoffAtMs)),
    'a confirmed in-flight handoff stayed pending for duplicate recovery')
  assert.equal(f.state().deferred.length, 0)
  assert.equal(f.state().deadLetters.length, 0)
  assert.equal(f.offers().length, 1)
})

test('retrying the recovered acknowledgment never repeats its accepted model turn', async t => {
  const f = await fixture(t, { failFirstAcknowledge: true })
  await f.host.startSession({ sessionId: `${f.recipientId}-next`, replacesSessionId: f.recipientId, ...f.recipientStart })
  await until(() => f.state().deliveries.some(row => row.messageId === f.sent.messageId && Number.isSafeInteger(row.modelHandoffAtMs)),
    'a refused acknowledgment was never retried')
  assert.equal(f.acknowledgmentAttempts(), 2)
  assert.equal(f.offers().length, 1)
  assert.equal(f.state().deferred.length, 0)
})

test('a normal model handoff releases custody even when its first inbox snapshot preceded the broker receipt', async t => {
  const f = await fixture(t, { inFlight: true, hidePendingOnce: true })
  assert.equal(f.hiddenSnapshots(), 1)
  const pending = f.engine.pendingTurns.shift()
  pending.resolve({ turnId: 'normal-model-handoff' })
  f.engine.control.holdTurns = false
  await until(() => f.state().deferred.length === 0, 'the accepted normal turn left an orphaned recovery copy')
  assert.equal(f.offers().length, 1)
  assert.doesNotMatch(f.offers()[0].request.text, /recovered from a previous session/i)
  assert.equal(f.state().deliveries.find(row => row.messageId === f.sent.messageId).modelHandoffRecovered, false)
  await delay(120)
  assert.equal(f.notices().length, 0, 'ordinary delivery must not claim the recipient retired')
})


// Observe the operation without letting a broken, unbounded retirement hang
// this suite. Every test releases the real broker gate in finally.
async function retirementResult(operation) {
  return Promise.race([
    operation.then(() => ({ closed: true }), error => ({ error })),
    delay(1500).then(() => ({ deadline: true })),
  ])
}

for (const verb of ['defer', 'discard', 'acknowledgeDeferred']) {
  for (const settlement of ['success', 'rejection']) {
    test(`stalled ${verb} is bounded and retained across close retries until late ${settlement}`, async t => {
      const f = await fixture(t, { inFlight: verb === 'acknowledgeDeferred', stalledVerb: verb })
      const attempts = verb === 'defer' ? f.deferAttempts
        : verb === 'discard' ? f.discardAttempts : f.acknowledgmentAttempts
      const request = { sessionId: f.recipientId, preserveContinuation: verb !== 'discard' }
      const operations = []
      const close = () => {
        const operation = f.host.closeSession(request)
        operation.catch(() => {})
        operations.push(operation)
        return operation
      }
      try {
        if (verb === 'acknowledgeDeferred') {
          // Enter the courier's real model-accepted acknowledgment first.
          // Retirement must share this raw acknowledgment, not offer twice.
          f.engine.pendingTurns.shift().resolve({ turnId: 'accepted-before-retirement' })
          f.engine.control.holdTurns = false
          await until(() => attempts() === 1, 'model handoff did not reach the stalled acknowledgment')
        }
        const first = close()
        await until(() => attempts() >= 1, 'retirement did not reach the stalled broker')
        const firstResult = await retirementResult(first)
        assert.equal(firstResult.error?.code, 'AGENT_TREE_RECOVERY_TIMEOUT',
          'close must refuse within its deadline while broker custody is uncertain')
        assert.equal(f.recipientEngineCloses(), 0, 'timeout must retain the engine cleanup handle')
        assert.equal(f.host.activeSessionCount(), 2, 'timeout must retain the recipient session')
        assert.equal(attempts(), 1, 'retirement must reuse an acknowledgment already in flight')

        const secondResult = await retirementResult(close())
        assert.equal(secondResult.error?.code, 'AGENT_TREE_RECOVERY_TIMEOUT')
        assert.equal(attempts(), 1, 'a retry while the broker is pending must not repeat its write')
        assert.equal(f.recipientEngineCloses(), 0)
        assert.equal(f.host.activeSessionCount(), 2)

        if (settlement === 'rejection') f.rejectStall(new Error('late broker retirement refusal'))
        else f.releaseStall()
        // Let the retained raw operation publish its settlement before retry.
        await delay(30)
        await close()
        assert.equal(attempts(), settlement === 'success' ? 1 : 2,
          'retry must reuse confirmed custody and retry only an actually rejected write')
        assert.equal(f.recipientEngineCloses(), 1)
        assert.equal(f.host.activeSessionCount(), 1)
        if (verb === 'defer') {
          assert.equal(f.state().deferred.length, 1)
          assert.equal(f.state().deadLetters.length, 0)
          assert.equal(f.offers().length, 0)
        } else if (verb === 'discard') {
          assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
          assert.equal(f.offers().length, 0)
        } else {
          assert.equal(f.offers().length, 1, 'accepted model work must never be replayed')
          assert.equal(f.state().deferred.length, 0)
          assert.equal(f.state().deadLetters.length, 0)
          assert.ok(f.state().deliveries.some(row => row.messageId === f.sent.messageId && Number.isSafeInteger(row.modelHandoffAtMs)))
        }
      } finally {
        f.releaseStall()
        await Promise.allSettled(operations)
      }
    })
  }
}


test('partial retirement of a multi-envelope in-flight batch retries only the unresolved broker write', async t => {
  const f = await fixture(t, { inFlight: true, messageCount: 2, stalledVerb: 'defer', stallAt: 2 })
  assert.match(f.offers()[0].request.text, /Additional envelope 1/, 'both envelopes must belong to the same actual handoff batch')
  const operations = []
  const close = () => {
    const operation = f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true })
    operation.catch(() => {})
    operations.push(operation)
    return operation
  }
  try {
    const first = close()
    await until(() => f.deferAttempts() === 2, 'the first write did not settle before the second stalled')
    assert.equal(f.deferReceipts.length, 1, 'only the first retirement write has settled')
    assert.equal(f.deferReceipts[0].result.accepted, true)
    assert.equal(f.deferReceipts[0].messageId, f.sentMessages[0].messageId)
    // The broker already retains delivered-but-unacknowledged sends; its
    // deferred array is not a count of completed retirement writes.
    assert.equal(f.state().deferred.length, 2, 'both original envelopes must remain in durable custody')
    assert.equal((await retirementResult(first)).error?.code, 'AGENT_TREE_RECOVERY_TIMEOUT')
    f.rejectStall(new Error('second envelope broker refusal'))
    await delay(30)
    await close()
    assert.equal(f.deferAttempts(), 3, 'a settled batch envelope must not be recaptured and written again')
    assert.equal(f.state().deferred.length, 2)
    assert.equal(f.state().deadLetters.length, 0)
    assert.equal(f.recipientEngineCloses(), 1)
    assert.equal(f.offers().length, 1)
  } finally {
    f.releaseStall()
    await Promise.allSettled(operations)
  }
})

test('closeAll reports a stalled retirement without releasing that session and can finish after settlement', async t => {
  const f = await fixture(t, { stalledVerb: 'defer' })
  let closing
  try {
    closing = f.host.closeAll()
    const result = await retirementResult(closing)
    assert.ok(result.error instanceof AggregateError, 'closeAll must report bounded cleanup failure')
    assert.ok(result.error.errors.some(error => error.code === 'AGENT_TREE_RECOVERY_TIMEOUT'))
    assert.equal(f.deferAttempts(), 1)
    assert.equal(f.recipientEngineCloses(), 0)
    assert.equal(f.host.activeSessionCount(), 1, 'only the independently completed manager may leave the host')
    f.releaseStall()
    await until(() => f.state().deferred.length === 1, 'late retirement did not reach the broker')
    await f.host.closeAll()
    assert.equal(f.deferAttempts(), 1)
    assert.equal(f.recipientEngineCloses(), 1)
    assert.equal(f.host.activeSessionCount(), 0)
  } finally {
    f.releaseStall()
    if (closing) await Promise.allSettled([closing])
  }
})

test('observed engine exit retains its cleanup tombstone while broker retirement is stalled', async t => {
  const f = await fixture(t, { stalledVerb: 'defer' })
  try {
    f.exitRecipient()
    await until(() => f.deferAttempts() === 1, 'exit cleanup did not begin retirement')
    const endedIndex = f.visible.findIndex(packet => packet.sessionId === f.recipientId && packet.event?.type === 'session_ended')
    assert.ok(endedIndex >= 0, 'the host must publish its observed terminal event')
    assert.equal(f.recipientEngineCloses(), 0)
    assert.equal(f.host.activeSessionCount(), 2, 'observed exit is not proof of broker retirement')
    const retry = await retirementResult(f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true }))
    assert.equal(retry.error?.code, 'AGENT_TREE_RECOVERY_TIMEOUT')
    assert.equal(f.visible.slice(endedIndex + 1).some(packet => packet.sessionId === f.recipientId
      && packet.event?.type === 'assistant_text_delta'), false, 'the ended tombstone must not resume assistant output')
    assert.equal(f.deferAttempts(), 1)
    assert.equal(f.recipientEngineCloses(), 0)
    f.releaseStall()
    await until(() => f.state().deferred.length === 1, 'late exit-retirement settlement was lost')
    await f.host.closeSession({ sessionId: f.recipientId, preserveContinuation: true })
    assert.equal(f.deferAttempts(), 1)
    assert.equal(f.recipientEngineCloses(), 1)
    assert.equal(f.host.activeSessionCount(), 1)
  } finally { f.releaseStall() }
})

/* T1790. Measured: an account change closed the running
   session first; retiring its queued messages was refused, so the close failed
   and left the session half-closed (close-failed, closeRequested still set,
   engine and tool identity still open). Every later Resume was then refused as
   AGENT_RESUME_SOURCE_UNAVAILABLE -- "the saved native conversation could not
   be verified", retried in 5 s -- before the cleanup that would have closed the
   predecessor could run, although the saved conversation was intact. */
const resumeOf = (f, suffix = 'resumed') => ({ sessionId: `${f.recipientId}-${suffix}`, resumeThreadId: f.recipientThreadId,
  replacesSessionId: f.recipientId, ...f.recipientStart })

test('Resume completes an owed close that failed while retiring queued messages, then resumes the saved conversation', async t => {
  const f = await fixture(t, { refuseVerb: 'discard', refusals: 1, distinctThreads: true })
  // The manual account continuation closes the predecessor as a Stop (no continuation).
  await assert.rejects(f.host.closeSession({ sessionId: f.recipientId }), { code: 'AGENT_TREE_RECOVERY_UNCONFIRMED' })
  assert.equal(f.recipientEngineCloses(), 0, 'the failed close kept the engine cleanup handle')
  assert.equal(f.host.activeSessionCount(), 2, 'the half-closed predecessor is still owned by the host')
  const resumed = await f.host.startSession(resumeOf(f))
  assert.equal(resumed.threadId, f.recipientThreadId, 'the saved native conversation was resumed')
  assert.equal(f.discardAttempts(), 2, 'the owed close retried its refused retirement write once, with its own verb')
  assert.equal(f.deferAttempts(), 0, 'the retried close kept the recoverability its own close chose')
  assert.equal(f.recipientEngineCloses(), 1, 'the predecessor engine closed exactly once')
  assert.equal(f.engine.calls.filter(call => call.resumed && call.threadId === f.recipientThreadId).length, 1,
    'exactly one native resume was dispatched')
  assert.equal(f.state().deadLetters.filter(row => row.entry.messageId === f.sent.messageId).length, 1)
  assert.equal(f.host.activeSessionCount(), 2, 'the manager and the resumed session remain; the predecessor is gone')
})

test('a refused retirement write keeps the broker refusal code with the close failure', async t => {
  const f = await fixture(t, { refuseVerb: 'discard', refusals: 1 })
  await assert.rejects(f.host.closeSession({ sessionId: f.recipientId }), error => {
    assert.equal(error.code, 'AGENT_TREE_RECOVERY_UNCONFIRMED')
    assert.match(error.message, /\(BROKER_DELIVERY_NOT_RETAINED\)/, 'the broker refusal code is kept with the failure')
    return true
  })
  await f.host.closeSession({ sessionId: f.recipientId })
  assert.equal(f.recipientEngineCloses(), 1)
})

test('Resume names the unfinished close, not the conversation, when the owed close still cannot complete', async t => {
  const f = await fixture(t, { refuseVerb: 'discard', refusals: Infinity, distinctThreads: true })
  await assert.rejects(f.host.closeSession({ sessionId: f.recipientId }), { code: 'AGENT_TREE_RECOVERY_UNCONFIRMED' })
  await assert.rejects(f.host.startSession(resumeOf(f)), error => {
    assert.equal(error.code, 'AGENT_PREDECESSOR_CLOSE_REQUIRED')
    assert.match(error.message, /did not finish closing \(AGENT_TREE_RECOVERY_UNCONFIRMED: BROKER_DELIVERY_NOT_RETAINED\)/)
    assert.doesNotMatch(error.message, /could not be verified|stopped before/)
    return true
  })
  assert.equal(f.discardAttempts(), 2, 'the Resume retried the owed close once before refusing')
  assert.equal(f.recipientEngineCloses(), 0)
  assert.equal(f.engine.calls.filter(call => call.resumed).length, 0, 'no provider resume was dispatched')
  f.allowRetirement()
  // A later Resume, once the broker takes custody, proceeds without anything else.
  const resumed = await f.host.startSession(resumeOf(f, 'resumed-later'))
  assert.equal(resumed.threadId, f.recipientThreadId)
  assert.equal(f.recipientEngineCloses(), 1)
})

test('Resume during an unfinished Stop says the Stop is still in progress, and succeeds once it has stopped', async t => {
  const f = await fixture(t, { stalledVerb: 'discard', distinctThreads: true, readDeadlineMs: 10_000 })
  const closing = f.host.closeSession({ sessionId: f.recipientId })
  closing.catch(() => {})
  try {
    await until(() => f.discardAttempts() === 1, 'the Stop did not reach its retirement write')
    await assert.rejects(f.host.startSession(resumeOf(f)), error => {
      assert.equal(error.code, 'AGENT_PREDECESSOR_STOP_IN_PROGRESS')
      assert.doesNotMatch(error.message, /could not be verified/)
      return true
    })
    assert.equal(f.engine.calls.filter(call => call.resumed).length, 0)
  } finally { f.releaseStall() }
  await closing
  const resumed = await f.host.startSession(resumeOf(f, 'resumed-after-stop'))
  assert.equal(resumed.threadId, f.recipientThreadId)
})

test('the predecessor refusals carry honest retry classes through the paired engine taxonomy', () => {
  const { publicFailure } = require_(path.join(engineRoot, 'src/lib/error-taxonomy'))
  const shape = code => { const failure = publicFailure(Object.assign(new Error(code), { code })); return [failure.classification, failure.retryable] }
  // Waiting lets a Stop in progress settle; a close that keeps failing needs the person's Stop.
  assert.deepEqual(shape('AGENT_PREDECESSOR_STOP_IN_PROGRESS'), ['retry-after-time', true])
  assert.deepEqual(shape('AGENT_PREDECESSOR_CLOSE_REQUIRED'), ['retry-after-input', false])
})
