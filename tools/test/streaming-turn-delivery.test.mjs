/* WHAT `send` MEANS, AND WHY BOTH ENGINES HAVE TO MEAN THE SAME THING BY IT.
 *
 * THE DEFECT THIS SUITE EXISTS TO END, measured 2026-08-17 by driving
 * shell/agent-host.cjs against both real engines with the same question
 * ("What is 17 multiplied by 23?"), and recording the order the host's own
 * event listener saw things in:
 *
 *   codex  luna           sendTurn() RESOLVED at +3ms, first delta at +33.8s
 *                         RESOLVED -> delta -> usage -> turn_completed
 *   claude claude-sonnet  sendTurn() RESOLVED at +3884ms, first delta +3867ms
 *                         delta -> usage -> turn_completed -> RESOLVED
 *
 * The codex adapter answers `turn/start`, an ACKNOWLEDGEMENT, so its promise
 * settles when the turn BEGINS. The Claude CLI adapter has nothing to
 * acknowledge with and resolves from the `result` packet, so its promise
 * settles when the turn is ALREADY OVER.
 *
 * Every surface above the host binds itself to the session on the strength of
 * that promise: the fleet tree's listener drops any packet for a session it has
 * not been told about, drainOutboxMessage() marks the node running after the
 * send is answered, and interrupt() waits on the send promise before it will
 * stop anything. On the Claude path all three happened after the turn was over.
 * The visible result was the one the owner reported: a real claude.exe with a
 * textbook-correct command line, a node stuck at `running`, an empty reply, no
 * error and no refusal, for as long as anyone was willing to wait.
 *
 * The host is what promises the two engines are interchangeable, so this is
 * where the promise is kept and where it is measured.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { sessionTurnSucceeded } from '../../src/agent-session-events.js'
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
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))

const STREAMING_ENGINE = path.join(ROOT, 'tools/test/fixtures/streaming-engine/src/lib/agent-engine/codex-process.js')
const ACKNOWLEDGING_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-streaming-turn-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

const PLAN = {
  ok: true, tier: 'guided', isolated: true,
  threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
  env: {},
}

function withPlan(run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(PLAN)
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  })
}

function startedHost(enginePath, sessionId) {
  return withPlan(async () => {
    const workdir = testScratch('mc-streaming-')
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath, defaultCwd: workdir })
    await host.startSession({ sessionId })
    return host
  })
}

/* A REAL DEADLINE, because the failure this suite guards against is a promise
   that never settles. `await` on its own would hang the runner and report a
   timeout with nothing in it; this reports the fact. */
function within(milliseconds, promise, what) {
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} had not settled after ${milliseconds}ms`)), milliseconds)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('a streaming engine answers the send when the turn STARTS, not when it ends', async () => {
  const engine = require_(STREAMING_ENGINE)
  engine.reset()
  const host = await startedHost(STREAMING_ENGINE, 'streaming-1')

  const sending = host.sendTurn({ sessionId: 'streaming-1', text: 'what is 17 multiplied by 23?' })
  await settle()

  /* The engine has not answered for the turn and will not until this test says
     so -- exactly the Claude adapter, whose promise waits for `result`. What it
     HAS done is start narrating, which is the only signal that engine gives
     that a turn is under way. */
  engine.narrate({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 'turn-live', text: '391' })

  const sent = await within(2000, sending,
    'host.sendTurn() on a streaming engine')
  assert.equal(sent.turnId, 'turn-live',
    'the send was answered with a turn id the engine never acknowledged separately')
  assert.equal(sent.sessionId, 'streaming-1')
  assert.equal(engine.control.sends, 1, 'the turn must be sent to the engine exactly once')

  /* And the turn is the session's ACTIVE one, so it can be stopped. Before
     this, interrupt() awaited the send promise and could therefore never fire
     during a turn on this engine -- a Claude turn could not be stopped at all. */
  const stopped = await within(2000, host.interrupt({ sessionId: 'streaming-1' }), 'interrupt()')
  assert.equal(stopped.turnId, 'turn-live')

  await host.closeAll()
})

test('an acknowledging engine is answered exactly as it was, from its own reply', async () => {
  /* The positive control. The whole risk in resolving early is that the engine
     which already answered promptly starts being answered from somewhere else;
     it must not. This fixture's adapter resolves immediately with `t1`, and `t1`
     is what has to come back -- no event ever names a turn here. */
  const host = await startedHost(ACKNOWLEDGING_ENGINE, 'acknowledging-1')
  const sent = await within(2000, host.sendTurn({ sessionId: 'acknowledging-1', text: 'hello' }),
    'host.sendTurn() on an acknowledging engine')
  assert.equal(sent.turnId, 't1', 'the acknowledged turn id is no longer what the caller is told')
  await host.closeAll()
})

test('a completed turn emitted inside sendTurn before its acknowledgement stays completed', async () => {
  /* THE ORDERING GAP. A transport may deliver notifications synchronously
     while the adapter is writing turn/start, before the host has assigned its
     sendPromise. The completion is still authoritative. The host must retain
     it through the later acknowledgement rather than setting activeTurnId
     after it has already shown the public terminal event. */
  const engine = require_(STREAMING_ENGINE)
  engine.reset()
  const host = await startedHost(STREAMING_ENGINE, 'streaming-completed-before-ack')
  const seen = []
  host.onEvent(packet => seen.push(packet.event))

  engine.control.duringSend = () => {
    engine.narrate({ type: 'assistant_text', threadId: 'thread-1', turnId: 'turn-early', itemId: 'item-early', text: '' })
    engine.narrate({ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-early', status: 'completed' })
    engine.control.resolveTurn({ turnId: 'turn-early' })
  }
  const sent = await within(2000,
    host.sendTurn({ sessionId: 'streaming-completed-before-ack', text: 'no reply needed' }),
    'host.sendTurn() after an early completion')
  assert.equal(sent.turnId, 'turn-early')
  assert.deepEqual(seen.map(event => [event.type, event.turnId, event.text ?? event.status]), [
    ['assistant_text', 'turn-early', ''],
    ['turn_completed', 'turn-early', 'completed'],
  ])
  assert.equal(host.sessionActivity('streaming-completed-before-ack').busy, false,
    'the acknowledgement resurrected a turn whose completion was already public')

  engine.control.duringSend = () => engine.control.resolveTurn({ turnId: 'turn-next' })
  const next = await within(2000,
    host.sendTurn({ sessionId: 'streaming-completed-before-ack', text: 'next assignment' }),
    'the next turn after an early completion')
  assert.equal(next.turnId, 'turn-next', 'the completed turn left the next send blocked')

  await host.closeAll()
})

test('a turn that dies after it was announced still reaches the person', async () => {
  /* Answering the send early takes the engine's rejection away from the caller,
     and the Claude adapter emits NOTHING when its child exits -- it only
     rejects the turn. Left there, this would have traded a hang for a hang. */
  const engine = require_(STREAMING_ENGINE)
  engine.reset()
  const host = await startedHost(STREAMING_ENGINE, 'streaming-2')

  const seen = []
  host.onEvent(packet => { seen.push(packet.event) })

  const sending = host.sendTurn({ sessionId: 'streaming-2', text: 'read every file' })
  await settle()
  engine.narrate({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 'turn-doomed', text: 'working' })
  await within(2000, sending, 'host.sendTurn()')

  const died = new Error('The Claude program stopped before finishing the turn (exit 1).')
  died.code = 'CLAUDE_CLI_EXITED'
  engine.control.rejectTurn(died)
  await settle()

  const ending = seen.filter(event => event.type === 'turn_completed')
  assert.equal(ending.length, 1, 'a turn whose program died reported no ending at all')
  assert.equal(ending[0].turnId, 'turn-doomed', 'the ending named a turn other than the one that died')
  assert.equal(sessionTurnSucceeded(ending[0].status), false,
    'a turn that died was reported with a status a surface reads as success')

  await host.closeAll()
})

test('both engines\' words for a successful turn are read as success, and nothing else is', () => {
  /* MEASURED on the same two live runs as the header: codex puts "completed" on
     turn_completed, the Claude CLI puts "success". Three surfaces compared
     against "completed" alone, so a correct Claude answer would have been
     painted as a failed turn beside the right number. */
  assert.equal(sessionTurnSucceeded('completed'), true, 'the codex word for success is not read as success')
  assert.equal(sessionTurnSucceeded('success'), true, 'the Claude word for success is not read as success')
  for (const status of ['error', 'failed', 'interrupted', 'cancelled', 'aborted', '', 'Completed', 'SUCCESS']) {
    assert.equal(sessionTurnSucceeded(status), false, `"${status}" is read as a successful turn`)
  }
  for (const status of [null, undefined, 0, 1, {}, ['completed']]) {
    assert.equal(sessionTurnSucceeded(status), false, 'a non-string outcome is read as a successful turn')
  }
})
