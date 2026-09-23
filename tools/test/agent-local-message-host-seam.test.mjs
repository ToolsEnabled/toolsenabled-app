/* The application half of local agent-to-agent delivery.
 *
 * Engine tests exercise the real durable directory, broker and provider. Other
 * app tests prove the renderer writes an address the host can parse. Neither
 * proved the production host connected those pieces: register a running tree
 * session, poll its payload inbox, show the arrival, and submit it as that
 * session's next model turn. A missing module or a dead polling seam used to be
 * able to ship while every narrower test stayed green. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_ROOT = path.join(ROOT, 'tools/test/fixtures/confined-engine')
const ENGINE = path.join(FIXTURE_ROOT, 'src/lib/agent-engine/codex-process.js')
const DIRECTORY = path.join(FIXTURE_ROOT, 'src/lib/agent-comms/tree-node-directory.js')
const PROVIDER = path.join(FIXTURE_ROOT, 'src/lib/providers/agent-comms-local.js')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-local-message-host-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

function plan(workdir) {
  return {
    ok: true,
    tier: 'standard',
    isolated: true,
    threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly', 'toolsenabled'],
  }
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

test('a durable local arrival becomes the addressed running session\'s next turn', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'delivery-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
  })
  const visible = []
  const unlisten = host.onEvent(packet => visible.push(packet))
  try {
    await host.startSession({ sessionId: 'manager-session' })
    await host.sendTurn({
      sessionId: 'manager-session',
      text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    await host.startSession({ sessionId: 'child-session' })
    await host.sendTurn({
      sessionId: 'child-session',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    const before = engine.adapterCalls.length
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: 'Worker: the measured result is ready for review.',
    })

    const delivered = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1))
    assert.ok(delivered, 'the host never handed the durable arrival to the manager session')
    assert.match(delivered.request.text, /^Worker: the measured result is ready for review\./)
    assert.match(delivered.request.text, /arrived from Worker over this computer's agent tree/)
    assert.match(delivered.request.text, /agent_comms\.send_local with from "Manager" and to "Worker"/)

    const shown = visible.find(packet => packet.sessionId === 'manager-session'
      && packet.event?.type === 'assistant_text_delta'
      && packet.event.text.includes('measured result is ready'))
    assert.ok(shown, 'the arrival reached the model but was not exposed in the person-visible transcript stream')
  } finally {
    unlisten()
    await host.closeAll().catch(() => {})
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* SEND-TO-SURFACE, FOR A RECIPIENT WHO IS ALREADY IDLE.
 *
 * MEASURED 2026-09-03 by the second tree (m2-REPORT-ready.md addendum A1):
 * three worker-ready messages returned accepted / BROKER_DELIVERED at once
 * but each surfaced in the manager's own conversation minutes later. This
 * pins the bound that matters for an idle recipient -- one that holds no
 * active turn and has no person-first reservation open -- so a regression
 * back into minutes fails this test rather than waiting to be measured by
 * hand again. TREE_POLL_MS in shell/agent-host.cjs is 1200 ms; the bound
 * below is 2x that to absorb scheduler jitter on a loaded machine without
 * being able to pass a courier that only wakes on the person's own send or
 * that starves on a stuck priority yield. */
test('a delivered message reaches an idle recipient within about one poll interval', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'latency-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
  })
  try {
    await host.startSession({ sessionId: 'manager-session' })
    await host.sendTurn({
      sessionId: 'manager-session',
      text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    await host.startSession({ sessionId: 'child-session' })
    await host.sendTurn({
      sessionId: 'child-session',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    /* Let the manager settle past its own brief turn so nothing about this
       measurement is timing the brief itself, only the idle recipient. */
    await new Promise(resolve => setTimeout(resolve, 250))

    const before = engine.adapterCalls.length
    const sentAt = Date.now()
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: 'Worker: the measured result is ready for review.',
    })

    const delivered = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1), 8_000)
    const elapsedMs = Date.now() - sentAt
    assert.ok(delivered, 'the host never surfaced the durable arrival to the idle manager session')
    assert.ok(elapsedMs < 2_400,
      `send-to-surface took ${elapsedMs} ms for an idle recipient; expected under ~2x TREE_POLL_MS (2400 ms)`)
  } finally {
    await host.closeAll().catch(() => {})
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* Two circles briefed and settled, the way every test above builds them, with
   the courier's clocks shortened so a hung read or a held acknowledgement can
   be driven in seconds. Returns what the tests need to drive and observe. */
async function twoCirclesOnTheTree({ workdir, engine, treeCourier, messageDeliveryReader }) {
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    treeCourier,
    messageDeliveryReader,
  })
  const visible = []
  const unlisten = host.onEvent(packet => visible.push(packet))
  await host.startSession({ sessionId: 'manager-session' })
  await host.sendTurn({
    sessionId: 'manager-session',
    text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
    origin: 'brief',
  })
  const managerEngine = engine.calls.at(-1)
  managerEngine.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

  await host.startSession({ sessionId: 'child-session' })
  await host.sendTurn({
    sessionId: 'child-session',
    text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
    origin: 'brief',
  })
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
  return { host, visible, unlisten, managerEngine }
}

function handOffsOf(engine, pattern) {
  return engine.adapterCalls.filter(call => call.method === 'sendTurn' && pattern.test(call.request.text))
}

/* A READ THAT NEVER ANSWERS MUST NOT STOP THE COURIER.
 *
 * MEASURED 2026-09-04 on the owner's fourth tree: all seven circles' heartbeats
 * stopped within 132 ms of each other at 00:12:31Z and never resumed; half an
 * hour later every send on the tree was refused TREE_SENDER_NOT_RUNNING for
 * agents that were demonstrably still working, and the tree was abandoned.
 * The heartbeat is written inside the per-circle pass, which runs only after
 * the round's one shared inbox read, so a read the engine never answers is a
 * tree that goes dark all at once. This holds the fixture's read open and
 * asserts the circles keep proving they are alive meanwhile, and that the
 * message which arrived during the hold is delivered exactly once afterwards
 * -- the late answer to the held read must not deliver it a second time. */
test('a read that never answers does not stop the courier: heartbeats continue and the held message arrives once', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'hung-read-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  engine.control.holdTurns = false
  engine.pendingTurns.length = 0

  let tree = null
  try {
    tree = await twoCirclesOnTheTree({ workdir, engine, treeCourier: { pollMs: 150, heartbeatMs: 200, readDeadlineMs: 300 } })
    await sleep(400)

    provider.holdReads()
    const beatsAtHold = directory.heartbeatCount('manager-session')
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: 'Worker: delivered while the read was held.',
    })
    await sleep(1_500)
    const beatsDuringHold = directory.heartbeatCount('manager-session') - beatsAtHold
    assert.ok(beatsDuringHold >= 2,
      `${beatsDuringHold} heartbeats were written for the manager circle in 1500 ms while the shared read hung; the courier is wedged behind the read and the directory will call every circle stopped`)
    assert.equal(handOffsOf(engine, /delivered while the read was held/).length, 0,
      'nothing can be delivered while the read is held; a delivery here means the fixture did not hold')

    provider.releaseReads()
    const delivered = await waitFor(() => handOffsOf(engine, /delivered while the read was held/).length > 0, 4_000)
    assert.ok(delivered, 'the message that arrived during the hold was never delivered once the read answered')
    await sleep(700)
    assert.equal(handOffsOf(engine, /delivered while the read was held/).length, 1,
      'the held read\'s late answer delivered the message a second time')
  } finally {
    provider.releaseReads()
    if (tree) {
      tree.unlisten()
      await tree.host.closeAll().catch(() => {})
    }
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* AN ARRIVAL IS SHOWN WHILE THE RECIPIENT IS STILL ACCEPTING THE LAST ONE.
 *
 * The host's sendTurn() settles when the engine acknowledges the turn or emits
 * its first event -- on Claude, after however long the model thinks first. The
 * per-circle pass used to await that inside its latch, and the round planner
 * skips a latched circle, so from the hand-off until the model's first words
 * the circle was neither read nor heartbeated: a message arriving for it was
 * not shown to the person until the whole turn was over (the "minutes late"
 * the second tree measured, m2-REPORT-ready.md A1, on managers mid-spawn), and
 * a circle that thought for longer than the directory's live window was
 * called stopped while working. This holds the acknowledgement of the first
 * hand-off and asserts the second arrival is shown within a poll or two, with
 * no second turn started under the first, and is delivered once the turn ends. */
test('a message arriving while the recipient is still accepting a hand-off is shown at once and delivered once the turn ends', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'held-ack-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  engine.control.holdTurns = false
  engine.pendingTurns.length = 0

  let tree = null
  try {
    tree = await twoCirclesOnTheTree({ workdir, engine, treeCourier: { pollMs: 150 } })
    await sleep(400)

    engine.control.holdTurns = true
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: 'Worker: first.',
    })
    const held = await waitFor(() => engine.pendingTurns.length === 1 && engine.pendingTurns[0], 4_000)
    assert.ok(held, 'the first arrival was never handed to the manager session')
    assert.match(held.request.text, /^Worker: first\./)

    /* The hand-off is now pending: no acknowledgement, no event. */
    const sentAt = Date.now()
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: 'Worker: second.',
    })
    const shown = await waitFor(() => tree.visible.find(packet => packet.sessionId === 'manager-session'
      && packet.event?.type === 'assistant_text_delta'
      && packet.event.text.includes('Worker: second.')), 3_000)
    const elapsedMs = Date.now() - sentAt
    assert.ok(shown, 'the second arrival was not shown while the first hand-off was still being accepted; the circle is being skipped for the length of the turn')
    assert.ok(elapsedMs < 1_000, `the second arrival took ${elapsedMs} ms to show against a 150 ms poll`)
    assert.equal(engine.pendingTurns.length, 1, 'a second turn was started while the first was still being accepted')
    assert.equal(handOffsOf(engine, /^Worker: second\./).length, 0, 'the second message was handed off under the first')

    /* The engine accepts the first turn, then the turn ends. */
    held.resolve({ turnId: 't2' })
    await sleep(50)
    tree.managerEngine.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't2', status: 'completed' })
    engine.control.holdTurns = false
    const second = await waitFor(() => handOffsOf(engine, /^Worker: second\./).length === 1, 4_000)
    assert.ok(second, 'the second message was never handed off once the first turn ended')
    await sleep(500)
    assert.equal(handOffsOf(engine, /^Worker: first\./).length, 1, 'the first message was handed off more than once')
    assert.equal(handOffsOf(engine, /^Worker: second\./).length, 1, 'the second message was handed off more than once')
  } finally {
    engine.control.holdTurns = false
    for (const pending of engine.pendingTurns.splice(0)) pending.resolve({ turnId: 't-released' })
    if (tree) {
      tree.unlisten()
      await tree.host.closeAll().catch(() => {})
    }
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Autonomous+ host wiring yields owner messages and Stop fences late completed turns', async () => {
  const engine = require_(ENGINE);
  const canonicalRoot = process.env.MC_CANONICAL_ROOT || path.join(ROOT, 'capability');
  const continuationModule = require_(path.join(canonicalRoot, 'src/lib/agent-ledger-continuation.js'));
  const originalNow = Date.now;
  let clock = originalNow(), runner, durable;
  Date.now = () => clock;
  const workdir = mkdtempSync(path.join(SCRATCH, 'continuation-'));
  engine.calls.length = 0; engine.adapterCalls.length = 0;
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: ENGINE,
    defaultCwd: workdir, confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: () => ({ createLedgerContinuation(options) {
      runner = continuationModule.createLedgerContinuation({ ...options, now: () => clock,
        stateFactory: () => (durable = require_(path.join(canonicalRoot, 'src/lib/agent-continuation-state.js')).createContinuationState({ file: path.join(workdir, 'continuations.sqlite'), now: () => clock })),
        readSettings: () => ({ values: { 'agent.persistent_continuation': true }, provenance: { 'agent.persistent_continuation': { source: 'user' } } }),
        // The worker's own session-scoped task. A global task continues only for a session the
        // scheduler has already engaged on its own work in this episode, which a single person
        // turn does not do, so an unowned global task would test nothing about the host seam.
        readTasks: () => [{ kind: 'T', id: 'T1', status: 'open', scope: 'session', scopeKey: 'persistent-worker' }],
      });
      return runner;
    } }),
  });
  const tick = async () => { clock += 5000; runner.tick(); await new Promise(resolve => setImmediate(resolve)); };
  try {
    await host.startSession({ sessionId: 'persistent-worker' });
    host.rememberContinuation('persistent-worker', { tier: 'luna' });
    assert.equal(durable.list()[0].descriptor.tier, 'luna', 'host retains its requested model selector instead of undefined confinement tier');
    await host.sendTurn({ sessionId: 'persistent-worker', text: 'Continue the authorized workflow.', origin: 'person' });
    const finish = () => engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' });
    finish();
    // The host still polls every five seconds while durable continuations now
    // wait fifteen. Early polls must preserve readiness, then dispatch once due.
    for (let early = 0; early < 2; early++) {
      await tick();
      assert.equal(engine.adapterCalls.filter(call => call.method === 'sendTurn').length, 1);
      assert.equal(durable.list()[0].status, 'ready', 'an early poll must not stop a future continuation');
    }
    await tick();
    assert.equal(engine.adapterCalls.filter(call => call.method === 'sendTurn').length, 2);
    assert.match(engine.adapterCalls.at(-1).request.text, /Autonomous\+ continuation/);
    await assert.rejects(host.sendTurn({ sessionId: 'persistent-worker', text: 'My next instruction', origin: 'person' }), { code: 'AGENT_TURN_ACTIVE' });
    finish();
    for (let poll = 0; poll < 3; poll++) await tick();
    assert.equal(engine.adapterCalls.filter(call => call.method === 'sendTurn').length, 2, 'owner queue reservation outranks automatic work');
    await host.sendTurn({ sessionId: 'persistent-worker', text: 'My next instruction', origin: 'person' });
    await host.interrupt({ sessionId: 'persistent-worker' });
    finish();
    for (let poll = 0; poll < 3; poll++) await tick();
    assert.equal(engine.adapterCalls.filter(call => call.method === 'sendTurn').length, 3, 'late completion after Stop cannot restart work');
    assert.equal(durable.list()[0].status, 'stopped', 'the real host Stop reaches durable state before late events');
  } finally { await host.closeAll(); Date.now = originalNow; }
});

for (const mode of ['instant', 'timer', 'end-of-turn']) {
  test('courier applies ' + mode + ' to messages while an agent keeps working', async () => {
    const workdir = mkdtempSync(path.join(SCRATCH, 'policy-'))
    const directory = require_(DIRECTORY), provider = require_(PROVIDER), engine = require_(ENGINE)
    directory.reset(); provider.reset(); engine.calls.length = 0; engine.adapterCalls.length = 0
    let tree
    try {
      tree = await twoCirclesOnTheTree({ workdir, engine,
        treeCourier: { pollMs: 40, heartbeatMs: 1000, readDeadlineMs: 200 },
        messageDeliveryReader: () => ({ mode, intervalMs: 250 }),
      })
      await tree.host.sendTurn({ sessionId: 'manager-session', text: 'Continue the task', origin: 'person' })
      const before = engine.adapterCalls.length
      const deliver = body => provider.deliver({
        recipientAgentId: directory.agentIdForSession('manager-session'),
        senderAgentId: directory.agentIdForSession('child-session'), body,
      })
      deliver('Worker: first report.')
      if (mode === 'timer') {
        await sleep(100)
        assert.equal(engine.adapterCalls.length, before, 'timer delivered before its interval')
        deliver('Worker: second report.')
      }
      if (mode === 'end-of-turn') {
        await sleep(350)
        assert.equal(engine.adapterCalls.length, before, 'end-of-turn delivered into an active turn')
        tree.managerEngine.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
      }
      const accepted = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1), 2000)
      assert.ok(accepted, 'message was never delivered')
      assert.equal(accepted.method, mode === 'end-of-turn' ? 'sendTurn' : 'steerTurn')
      assert.match(accepted.request.text, /first report/)
      if (mode === 'timer') assert.match(accepted.request.text, /second report/)
      assert.equal(engine.adapterCalls.filter(call => call.method === 'interrupt').length, 0)
      await sleep(150)
      assert.equal(engine.adapterCalls.length, before + 1, 'batch was duplicated')
    } finally {
      tree?.unlisten(); await tree?.host.closeAll()
      directory.reset(); provider.reset()
      rmSync(workdir, { recursive: true, force: true })
    }
  })
}
