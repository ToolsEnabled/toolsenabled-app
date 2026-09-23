/* THE FALSE BUSY STATE AFTER A FAST, EMPTY LOCAL TURN.
 *
 * THE DEFECT (owner, Local Observer node16-8a2ff6c3, session cedebfeb-0079,
 * 2026-09-12): a local turn that fails before it ever says a word --
 * LOCAL_NODE_RESPONSE_INVALID, "the local model finished without returning
 * an answer" -- left the composer showing Stop and a Halt chip beside a
 * transcript that already read "The last turn failed...". Pressing Stop
 * answered "Nothing was interrupted; the turn may already be over" and only
 * THAT cleared the busy state.
 *
 * WHY THIS IS AN ORDERING BUG, NOT A MISSING EVENT. src/lib/agent-engine/
 * local-node-adapter.js's finishTurn() always emits turn_completed BEFORE
 * resolving the promise sendTurn() returns (emit(), then turn.resolve()) --
 * so for a turn whose first event is already its last, shell/agent-host.cjs
 * sees the completion (and resolves its own `announced` race branch from it)
 * strictly before the `acknowledged` branch -- the adapter's own sendTurn()
 * promise -- ever settles. The shell's OWN bookkeeping already accounts for
 * this (session.completedDuringSend, see emit()'s turn_completed branch and
 * sendTurn()'s `alreadyCompleted` read). What it does NOT protect is a
 * caller on the OTHER side of a second, separate IPC round trip: src/views/
 * computers.js's treeCardSend calls bridge.send(...).then(sent => ...
 * treeStore.setNodeStatus(node.id, 'running', ...)), unconditionally, once
 * the invoke settles -- and an invoke that settles AFTER the event channel
 * has already delivered and painted 'turn-failed' overwrites it back to
 * 'running', with nothing left to clear it again.
 *
 * THIS SUITE DRIVES THE REAL HOST. shell/agent-host.cjs is exercised exactly
 * as computers.js's bridge would: host.onEvent() stands in for the event
 * channel a renderer's 'mc-agent:event' listener reads, and host.sendTurn()
 * stands in for the invoke a renderer's bridge.send() awaits. Both cases the
 * person's own caveat leaves open are named, not silently assumed: mid-tool
 * cancellation is not exercised here (the fast-fail turn never starts a
 * tool), and this suite proves the ORDERING the two IPC channels can produce
 * for the real adapter shape, not the renderer's DOM (see
 * tree-turn-busy-race.test.mjs for that half, verified by source slice for
 * the same reason tree-turn-marks-running.test.mjs already gives: the view
 * is a 5,000-line closure over a live DOM).
 *
 * WHAT THIS SUITE CAN AND CANNOT CATCH. It never imports or touches
 * computers.js, so it PASSES IDENTICALLY whether or not the renderer's own
 * guard (sessionCompletedTurnIds) exists -- confirmed: run against a
 * computers.js checked out from before that guard was added, all five cases
 * here still pass. This is a CHARACTERISATION suite: it proves the ordering
 * the renderer's guard depends on is real and reachable through the real
 * host with the real adapter shape, both ways (CASE 1 and CASE 2), and that
 * the ordering itself is unrelated to and unchanged by the renderer fix. It
 * is not a regression test for the renderer's guard and must never be cited
 * as one; that guard's own regression coverage is
 * tree-turn-busy-race.test.mjs's source-slice suite, which does fail without
 * it (see that file's own header for what it can and cannot see).
 *
 *   node tools/test/agent-host-local-turn-completion-ordering.test.mjs
 */
import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'

const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_ENGINE = join(ROOT, 'tools', 'test', 'fixtures', 'confined-engine')
const LOCAL_MODULE = join('src', 'lib', 'agent-engine', 'local-node-process.js')
const CODEX_MODULE = join('src', 'lib', 'agent-engine', 'codex-process.js')

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
const completions = packets => packets.filter(packet => packet.event?.type === 'turn_completed')
const accepted = packets => packets.filter(packet => packet.event?.type === 'turn_accepted')

function workspace(t) {
  const directory = mkdtempSync(join(ownedFixtureTempRoot(), 'toolsenabled-local-order-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/* One engine root per case, the confined-engine fixture plus a local module
   whose sendTurn() the test controls -- see `behaviour` below. Modelled on
   tools/test/agent-host-local-tier.test.mjs's stageEngine(), narrowed to
   what this suite needs: no recorded calls, just the timing the real
   adapter's finishTurn() actually produces. */
function stageEngine(t, behaviour) {
  const scratch = mkdtempSync(join(ownedFixtureTempRoot(), 'toolsenabled-local-order-engine-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  cpSync(FIXTURE_ENGINE, scratch, { recursive: true })
  mkdirSync(dirname(join(scratch, LOCAL_MODULE)), { recursive: true })
  writeFileSync(join(scratch, LOCAL_MODULE), `'use strict'
async function startLocalSession(options) {
  const behave = ${behaviour}
  const handler = behave(options)
  return {
    threadId: 'local-thread-1',
    model: 'fake-model:1b',
    runtime: 'ollama',
    endpoint: 'http://127.0.0.1:1',
    close() {},
    adapter: {
      sendTurn: handler,
      interrupt: async () => {},
      answerApproval: async () => { throw new Error('not used') },
      forkThread: async () => ({ threadId: 'local-forked' }),
    },
  }
}
module.exports = { startLocalSession }
`)
  const planner = join(scratch, 'src', 'lib', 'agent-session-confinement.js')
  writeFileSync(planner, readFileSync(planner, 'utf8')
    + "\nmodule.exports.localSessionPlan = () => ({ ok: true, tier: 'guided', isolated: true, failedClosed: false, threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: null, mcpConfig: '/tmp/mock-mcp.json', servers: ['toolsenabled'], account: null })\n")
  const workdir = join(scratch, 'work')
  mkdirSync(workdir, { recursive: true })
  return { root: scratch, workdir, enginePath: join(scratch, CODEX_MODULE) }
}

async function withResolvedLevel(run) {
  const previous = process.env.MC_TEST_CONFINEMENT_RESOLVED
  process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true, sandbox: 'read-only', approvalPolicy: 'never' })
  try { return await run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_RESOLVED
    else process.env.MC_TEST_CONFINEMENT_RESOLVED = previous
  }
}

test('CASE 1 (the reported defect): a fast, empty local turn -- its first event is already turn_completed -- is already in the packet log by the time sendTurn() resolves', async (t) => {
  await withResolvedLevel(async () => {
    const engine = stageEngine(t, `(options) => async ({ threadId }) => {
      const turnId = 'turn-fast-empty-1'
      /* Mirrors local-node-adapter.js's finishTurn(): emit turn_completed
         BEFORE this promise settles. No turn_accepted at all -- the shape
         measured when the runtime closes the stream before ever answering. */
      options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'error', text: 'The local model finished without returning an answer.' })
      return { turnId }
    }`)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: engine.enginePath, defaultCwd: engine.workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'fast-empty', tier: 'local' })
    const sent = await host.sendTurn({ sessionId: 'fast-empty', text: 'hello' })

    assert.equal(sent.turnId, 'turn-fast-empty-1', 'the acknowledgement still names the turn, even though it already failed')
    const ended = completions(packets)
    assert.equal(ended.length, 1, 'the completion reached the event channel')
    assert.equal(ended[0].event.turnId, sent.turnId)
    assert.equal(ended[0].event.status, 'error')
    /* THE ORDERING CLAIM ITSELF: the packet was already on the channel before
       the caller's own await returned. A renderer that unconditionally marks
       'running' once THIS promise settles is marking it after its own
       terminal status was already painted -- see computers.js treeCardSend
       and sessionCompletedTurnIds (tree-turn-busy-race.test.mjs). */
  })
})

test('CASE 2 (the ordinary shape): turn_accepted resolves the acknowledgement fast, and the (later) completion arrives strictly after sendTurn() already resolved', async (t) => {
  await withResolvedLevel(async () => {
    const engine = stageEngine(t, `(options) => async ({ threadId }) => {
      const turnId = 'turn-normal-1'
      options.onEvent({ type: 'turn_accepted', threadId, turnId })
      setTimeout(() => {
        options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'error', text: 'The local model runtime closed the stream before finishing the answer.' })
      }, 40)
      return { turnId }
    }`)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: engine.enginePath, defaultCwd: engine.workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'normal-turn', tier: 'local' })
    const sent = await host.sendTurn({ sessionId: 'normal-turn', text: 'hello' })

    assert.equal(sent.turnId, 'turn-normal-1')
    assert.equal(accepted(packets).length, 1, 'the acceptance reached the event channel before the send resolved')
    assert.equal(completions(packets).length, 0, 'the completion has NOT arrived yet -- the acknowledgement genuinely came first this time')

    await settle(120)
    const ended = completions(packets)
    assert.equal(ended.length, 1, 'the delayed completion still reaches the event channel')
    assert.equal(ended[0].event.turnId, sent.turnId)
  })
})

test('the next message after a failed local turn reaches the real adapter, over the same session', async (t) => {
  await withResolvedLevel(async () => {
    const engine = stageEngine(t, `(options) => {
      let call = 0
      return async ({ threadId }) => {
        call += 1
        const turnId = call === 1 ? 'turn-fails-1' : 'turn-succeeds-2'
        if (call === 1) {
          options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'error', text: 'The local model finished without returning an answer.' })
        } else {
          options.onEvent({ type: 'assistant_text', threadId, turnId, text: 'second turn answered' })
          options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'completed' })
        }
        return { turnId }
      }
    }`)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: engine.enginePath, defaultCwd: engine.workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'retry-after-fail', tier: 'local' })
    const first = await host.sendTurn({ sessionId: 'retry-after-fail', text: 'first' })
    assert.equal(completions(packets).filter(p => p.event.turnId === first.turnId).length, 1)

    /* Nothing in the failed turn's bookkeeping blocks the next send: no
       AGENT_TURN_ACTIVE, the session is still the same one. */
    const second = await host.sendTurn({ sessionId: 'retry-after-fail', text: 'second' })
    assert.notEqual(second.turnId, first.turnId)
    const secondCompletion = completions(packets).find(p => p.event.turnId === second.turnId)
    assert.ok(secondCompletion, 'the second turn completed on the same session')
    assert.equal(secondCompletion.event.status, 'completed')
  })
})

test('Stop after the fast-empty turn already settled answers AGENT_TURN_NONE, honestly, rather than reopening the dead turn', async (t) => {
  await withResolvedLevel(async () => {
    const engine = stageEngine(t, `(options) => async ({ threadId }) => {
      const turnId = 'turn-fast-empty-stop'
      options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'error', text: 'The local model finished without returning an answer.' })
      return { turnId }
    }`)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: engine.enginePath, defaultCwd: engine.workdir })
    t.after(() => host.closeAll().catch(() => {}))
    host.onEvent(() => {})

    await host.startSession({ sessionId: 'stop-after-fail', tier: 'local' })
    await host.sendTurn({ sessionId: 'stop-after-fail', text: 'hello' })

    await assert.rejects(
      host.interrupt({ sessionId: 'stop-after-fail' }),
      error => error?.code === 'AGENT_TURN_NONE',
      'Stop on a session whose only turn already ended is refused by the honest, named code computers.js reads to self-heal (see stopStillOwnsNode)',
    )
  })
})

test('dispose: closing a session right after its fast-empty completion leaves no residue that reaches a freshly started session', async (t) => {
  await withResolvedLevel(async () => {
    const engine = stageEngine(t, `(options) => async ({ threadId }) => {
      const turnId = 'turn-fast-empty-dispose'
      options.onEvent({ type: 'turn_completed', threadId, turnId, status: 'error', text: 'The local model finished without returning an answer.' })
      return { turnId }
    }`)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: engine.enginePath, defaultCwd: engine.workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'dispose-first', tier: 'local' })
    await host.sendTurn({ sessionId: 'dispose-first', text: 'hello' })
    await host.closeSession({ sessionId: 'dispose-first' })

    await assert.rejects(
      host.sendTurn({ sessionId: 'dispose-first', text: 'again' }),
      error => error?.code === 'AGENT_SESSION_UNKNOWN',
      'the closed session is gone, exactly as a close must leave it',
    )

    const beforeSecond = packets.length
    await host.startSession({ sessionId: 'dispose-second', tier: 'local' })
    const second = await host.sendTurn({ sessionId: 'dispose-second', text: 'fresh' })
    assert.ok(second.turnId, 'the fresh session still gets its own acknowledged turn')

    const afterFirstPackets = packets.slice(0, beforeSecond)
    const secondSessionPackets = packets.slice(beforeSecond)
    assert.ok(afterFirstPackets.every(p => p.sessionId !== 'dispose-second'),
      'nothing filed against the disposed session id ever names the fresh one')
    assert.ok(secondSessionPackets.every(p => p.sessionId === 'dispose-second'),
      "the fresh session's own packets are not mixed with the disposed session's")
  })
})
