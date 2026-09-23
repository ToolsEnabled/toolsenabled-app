/* AN APPROVAL THE ADAPTER REFUSED IS NOT AN APPROVAL THAT WAS ANSWERED.
 *
 * THE DEFECT. shell/agent-host.cjs's answerApproval() calls
 * `session.adapter.answerApproval({...})` and neither awaits nor returns
 * that call -- it always resolves `{ sessionId, approvalId, decision }` right
 * underneath it:
 *
 *   session.adapter.answerApproval({ approvalId: id, response: { decision: chosen } })
 *   return Object.freeze({ sessionId: session.sessionId, approvalId: id, decision: chosen })
 *
 * interrupt(), three lines above it in the same file, awaits the identical
 * shape of call (`await session.adapter.interrupt(...)`); answerApproval()
 * does not, and the vendored Claude CLI adapter's own answerApproval is
 * unconditional and REJECTS every call (engine claude-cli-adapter.js:
 * "async answerApproval(answer) { ...; throw new ClaudeCliError
 * ('CLAUDE_CLI_APPROVALS_UNSUPPORTED', ...) }" -- approvals are not wired for
 * that engine at all). Because that method is declared `async`, the throw is
 * not synchronous: calling it hands back an already-rejected promise that
 * nothing here ever looks at.
 *
 * Two renderer doors depend on the opposite contract. src/approval-answer.js
 * (answerWithinBound) states it in so many words: "A thrown answer is an
 * answer that did not land" -- a rejection from bridge.answerApproval() is
 * supposed to read exactly like a timeout, so the approval card can say the
 * press did not go through and leave the question open. With the adapter's
 * promise dropped on the floor, host.answerApproval() resolves ok no matter
 * what the adapter did: a person pressing Approve or Decline on a session
 * whose engine cannot honour it is told the press worked, the card removes
 * itself (finishApprovalSettle), and the question it was never actually
 * asked to settle sits blocked forever with no control left on any screen
 * that can reach it again. The orphaned rejection also has no handler
 * anywhere, which is its own separate hazard (an unhandledRejection event,
 * fatal by default in this Node).
 *
 *   node tools/test/agent-host-answer-approval-refusal.test.mjs
 */
import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REFUSING_ENGINE = join(ROOT, 'tools/test/fixtures/refusing-approval-engine/src/lib/agent-engine/codex-process.js')
const PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} })

const settle = ms => new Promise(resolveTimer => setTimeout(resolveTimer, ms))

test('the real shared host and ACP adapter answer the exact offered option and reject a repeated click', async t => {
  await withPlan(async () => {
    const directory = workspace(t)
    const fixture = join(directory, 'engine')
    cpSync(join(ROOT, 'tools/test/fixtures/refusing-approval-engine'), fixture, { recursive: true })
    const modulePath = join(fixture, 'src/lib/agent-engine/codex-process.js')
    const adapterPath = join(canonicalRootForTests(), 'src/lib/agent-engine/acp-adapter.js')
    // Only the external wire is synthetic. Both sides of the faulty
    // host-to-adapter approval boundary run their actual implementation.
    writeFileSync(modulePath, `
      const { AcpAdapter } = require(${JSON.stringify(adapterPath)});
      const writes = [], listenerErrors = []; const listeners = new Set();
      const emit = packet => { for (const listener of listeners) listener(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\\n'); };
      const adapter = new AcpAdapter({ transport: {
        onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        write(line) {
          const packet = JSON.parse(line); writes.push(packet);
          if (packet.method === 'initialize') queueMicrotask(() => emit({ id: packet.id,
            result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }));
          if (packet.method === 'session/new') queueMicrotask(() => emit({ id: packet.id, result: { sessionId: 'real-acp-thread' } }));
          if (packet.method === 'session/prompt') queueMicrotask(() => emit({ id: 0, method: 'session/request_permission', params: {
            sessionId: 'real-acp-thread', toolCall: { toolCallId: 'read-count', title: 'host.list_processes' },
            options: [{ optionId: 'opaque-' + 'x'.repeat(200), name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Refuse', kind: 'reject_once' }] } }));
        }
      } });
      module.exports = { writes, emit, listenerErrors,
        async startCodexSession({ onEvent }) {
        adapter.onEvent(event => { try { onEvent(event); } catch (error) { listenerErrors.push(error.stack); throw error; } });
        await adapter.initialize(); const thread = await adapter.startThread({ cwd: ${JSON.stringify(directory)} });
        return { adapter, threadId: thread.threadId, close() { adapter.close(); } };
      } };
    `)
    const wire = createRequire(import.meta.url)(modulePath)
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: modulePath, defaultCwd: directory })
    t.after(() => host.closeAll())
    const events = []
    host.onEvent(packet => events.push(packet))
    await host.startSession({ sessionId: 'actual-acp-approval' })
    const turn = host.sendTurn({ sessionId: 'actual-acp-approval', text: 'Read the process count.' })
    let turnFailure
    turn.catch(error => { turnFailure = error })
    for (let attempt = 0; attempt < 100 && !turnFailure && !events.some(packet => packet.event?.type === 'approval_request'); attempt++) await settle(10)
    assert.equal(turnFailure?.code, undefined, turnFailure?.message)
    const packet = events.find(packet => packet.event?.type === 'approval_request')
    assert.ok(packet, `host must forward the actual native permission request; wire=${JSON.stringify(wire.writes.map(row => ({ method: row.method, hasResult: !!row.result })))}; events=${JSON.stringify(events.map(row => ({ type: row.event?.type })))}; listenerErrors=${JSON.stringify(wire.listenerErrors)}`)
    const activity = sessionActivityEvent(packet, 'actual-acp-approval')
    assert.equal(activity.availableDecisions[0], 'opaque-' + 'x'.repeat(200), 'opaque native ids must survive the UI reader')
    const decision = activity.availableDecisions[0]
    await host.answerApproval({ sessionId: 'actual-acp-approval', approvalId: activity.approvalId, decision })
    assert.deepEqual(wire.writes.at(-1), { jsonrpc: '2.0', id: 0,
      result: { outcome: { outcome: 'selected', optionId: decision } } })
    await assert.rejects(host.answerApproval({ sessionId: 'actual-acp-approval', approvalId: activity.approvalId, decision }),
      { code: 'ACP_APPROVAL_UNKNOWN' })
    const prompt = wire.writes.find(packet => packet.method === 'session/prompt')
    wire.emit({ id: prompt.id, result: { stopReason: 'end_turn' } })
    await turn
  })
})

function workspace(t) {
  const directory = mkdtempSync(join(ownedFixtureTempRoot(), 'toolsenabled-answer-approval-refusal-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function withPlan(run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = PLAN
  try { return await run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

test('answerApproval does not report success when the adapter refuses the answer', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: REFUSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    await host.startSession({ sessionId: 'approval-refused' })

    await assert.rejects(
      host.answerApproval({ sessionId: 'approval-refused', approvalId: 'ap-1', decision: 'approve' }),
      error => error?.code === 'FIXTURE_APPROVALS_UNSUPPORTED',
      'the host reported an approval as answered while the adapter actually refused it -- a person pressing Approve was told it worked',
    )
  })
})

test('a refused approval answer does not leak out as an unhandled promise rejection', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: REFUSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    await host.startSession({ sessionId: 'approval-refused-unhandled' })

    let unhandled = null
    const onUnhandled = error => { unhandled = error }
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.removeListener('unhandledRejection', onUnhandled))

    try { await host.answerApproval({ sessionId: 'approval-refused-unhandled', approvalId: 'ap-1', decision: 'decline' }) }
    catch { /* covered by the sibling test; this one watches for the orphaned promise */ }

    /* Give the adapter's own promise a turn to surface as unhandled if
       nothing in the host chain ever attached to it. */
    await settle(50)
    assert.equal(unhandled, null,
      'the adapter\'s refusal reached the process as an unhandled promise rejection instead of the caller\'s own result')
  })
})

/* THE UNCOVERED CASE THE TWO TESTS ABOVE NEVER DRIVE: A SECOND PRESS BEFORE
 * THE FIRST SETTLES. renderApprovalCard() (src/views/computers.js) does not
 * disable its buttons, debounce the click, or track an in-flight press --
 * the handler just does `await answerWithinBound(() => bridge.answerApproval(...))`
 * and nothing marks the card busy while that is pending, so a real double
 * click (or an Approve press followed immediately by a Decline press before
 * the first round trip returns) fires two overlapping host.answerApproval()
 * calls for the same approvalId. Each is its own function invocation with
 * its own local `await`, so nothing here predicts a shared-promise hazard --
 * but the two single-call tests above cannot tell a fix that only awaits
 * the FIRST caller apart from one that awaits both, and the pre-fix code's
 * failure mode (two independent fire-and-forget adapter calls) is exactly
 * the shape a concurrent press produces twice over. */
test('two concurrent presses on the same approval both report the refusal, and neither leaks', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: REFUSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    await host.startSession({ sessionId: 'approval-refused-concurrent' })

    let unhandled = null
    const onUnhandled = error => { unhandled = error }
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.removeListener('unhandledRejection', onUnhandled))

    const first = host.answerApproval({ sessionId: 'approval-refused-concurrent', approvalId: 'ap-1', decision: 'approve' })
    const second = host.answerApproval({ sessionId: 'approval-refused-concurrent', approvalId: 'ap-1', decision: 'deny' })
    const [outcome1, outcome2] = await Promise.allSettled([first, second])

    assert.equal(outcome1.status, 'rejected', 'the first of two concurrent presses must not report success')
    assert.equal(outcome2.status, 'rejected', 'the second of two concurrent presses must not report success')
    assert.equal(outcome1.reason?.code, 'FIXTURE_APPROVALS_UNSUPPORTED')
    assert.equal(outcome2.reason?.code, 'FIXTURE_APPROVALS_UNSUPPORTED')

    await settle(50)
    assert.equal(unhandled, null,
      'a concurrent second press leaked its refusal as an unhandled promise rejection even though the first press did not')
  })
})

/* A THIRD UNCOVERED CASE: THE PRESS RACES A CLOSE, NOT ANOTHER PRESS.
 * closeSession() (shell/agent-host.cjs) has no notion of "an approval answer
 * is in flight" -- it does not track answerApproval's promise on `session`
 * the way interrupt() tracks a turn via session.sendPromise, so nothing
 * makes closeSession() wait for or cancel a concurrent answerApproval() call
 * on the same session. This is the shape of a person pressing Stop the
 * instant after pressing Approve/Decline, before that round trip returns --
 * a real sequence, not a contrived one, and neither test above touches
 * closeSession at all. Two things could plausibly go wrong here and neither
 * is exercised anywhere else on this branch: closeSession() could hang
 * waiting on something it never actually waits on, and answerApproval()'s
 * already-dispatched adapter call could settle into a rejection with no
 * handler once nothing (including the caller's own Promise.allSettled,
 * which mirrors what a fire-and-forget renderer press would leave behind if
 * a close beat it to the microtask queue) is positioned to observe it. */
test('a close racing an in-flight approval answer neither hangs the close nor leaks the answer', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: REFUSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    await host.startSession({ sessionId: 'approval-refused-close-race' })

    let unhandled = null
    const onUnhandled = error => { unhandled = error }
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.removeListener('unhandledRejection', onUnhandled))

    // Neither call is awaited individually first: both are dispatched back to
    // back, exactly as a Stop press landing a tick after an Approve press
    // would reach the host, so the close's own bookkeeping (closeRequested,
    // state -> 'closing' -> 'closed', deleting the session from the map) runs
    // while the adapter's answerApproval call is still outstanding.
    const answerPromise = host.answerApproval({ sessionId: 'approval-refused-close-race', approvalId: 'ap-1', decision: 'approve' })
    const closePromise = host.closeSession({ sessionId: 'approval-refused-close-race' })

    const [answerOutcome, closeOutcome] = await Promise.allSettled([answerPromise, closePromise])

    assert.equal(closeOutcome.status, 'fulfilled',
      'closeSession must not hang or throw merely because an approval answer was in flight for the same session')
    assert.equal(closeOutcome.value?.closed, true)

    assert.equal(answerOutcome.status, 'rejected',
      'the in-flight answer must still settle with the adapter\'s own refusal -- a close finishing first must not turn it into a silent success')
    assert.equal(answerOutcome.reason?.code, 'FIXTURE_APPROVALS_UNSUPPORTED')

    await settle(50)
    assert.equal(unhandled, null,
      'a close racing an in-flight approval answer turned the answer\'s eventual rejection into an unhandled promise rejection')
  })
})
