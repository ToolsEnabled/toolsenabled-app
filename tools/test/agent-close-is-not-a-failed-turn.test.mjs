/* A TURN THE PERSON'S OWN STOP CUT SHORT IS NOT A TURN THAT FAILED.
 *
 * THE DEFECT. The palette's Stop row is enabled only while a circle is busy
 * (computers.js: `enabled: running && canStop`), so every Stop lands on a turn
 * in flight. For a Claude session that turn's sendTurn() promise is still open
 * -- the CLI adapter resolves it at the END of the turn -- and the adapter's
 * close() rejects it with CLAUDE_CLI_CLOSED. shell/agent-host.cjs's
 * post-announcement handler then emitted `turn_completed` with status
 * `failed` and the adapter's sentence, and three surfaces believed it:
 *
 *   shell/main.cjs        noteAgentTurnCompleted: lastTurnStatus 'failed',
 *                         turnsCompleted +1 -- so the signed end record for a
 *                         session the person closed says its last turn failed
 *   computers.js          the completion branch files 'turn-failed' with
 *                         "the last turn failed: This Claude session was
 *                         closed while a turn was running." and appends that
 *                         sentence to the transcript as the agent's words --
 *                         a moment before the Stop path writes 'finished',
 *                         "Stopped by you."
 *   the person            reads both, in that order
 *
 * The host already holds the rule for the child's exit: "an exit that follows
 * closeSession()/closeAll() is the close, and the caller already knows about
 * that ending" (endSessionFromExit, closeRequested). A turn rejection that
 * follows closeSession() is the same close. This suite drives the host with
 * an engine of exactly the Claude shape and asks for no completion after a
 * requested close -- and for one after a turn that really died.
 *
 *   node tools/test/agent-close-is-not-a-failed-turn.test.mjs
 */
import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLOSING_ENGINE = join(ROOT, 'tools/test/fixtures/closing-engine/src/lib/agent-engine/codex-process.js')
const PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} })

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function workspace(t) {
  const directory = mkdtempSync(join(ownedFixtureTempRoot(), 'toolsenabled-close-not-failed-'))
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

const completions = packets => packets.filter(packet => packet.event?.type === 'turn_completed')

test('a turn cut short by a requested close is not reported as a failed turn', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CLOSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'closed-mid-turn' })
    const sent = await host.sendTurn({ sessionId: 'closed-mid-turn', text: 'work on it' })
    assert.equal(sent.turnId, 'turn-closing-1', 'the turn was announced and the send answered while it was still open')

    await host.closeSession({ sessionId: 'closed-mid-turn' })
    await settle(150)

    assert.deepEqual(completions(packets), [],
      'the close the person asked for was reported back to them as a turn that failed')
    await assert.rejects(
      host.sendTurn({ sessionId: 'closed-mid-turn', text: 'again' }),
      error => error?.code === 'AGENT_SESSION_UNKNOWN',
      'the closed session is gone from the host, as a close must leave it',
    )
  })
})

test('a turn that dies on its own is still reported as one, with its sentence', async (t) => {
  await withPlan(async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CLOSING_ENGINE, defaultCwd: workspace(t) })
    t.after(() => host.closeAll().catch(() => {}))
    const packets = []
    host.onEvent(packet => packets.push(packet))

    await host.startSession({ sessionId: 'dies-mid-turn' })
    const sent = await host.sendTurn({ sessionId: 'dies-mid-turn', text: 'please die' })
    await settle(300)

    const ended = completions(packets)
    assert.equal(ended.length, 1, 'a turn that really failed after its announcement must still reach the person')
    assert.equal(ended[0].event.turnId, sent.turnId)
    assert.equal(ended[0].event.status, 'failed')
    assert.match(ended[0].event.text || '', /stopped answering/)
  })
})
