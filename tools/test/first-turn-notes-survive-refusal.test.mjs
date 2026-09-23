/* THE FIRST-TURN NOTES RIDE THE FIRST TURN THE ENGINE ACCEPTS, NOT THE FIRST
 * ONE THAT WAS TRIED.
 *
 * THE DEFECT. sendTurn (shell/agent-host.cjs) composes three one-time
 * additions onto a session's first turn -- the person's standing requests,
 * the configured role introduction and the tool-summary note -- and clears
 * each from the session BEFORE the adapter is asked, so that no failure path
 * can replay them onto a later turn. That is the right rule for a turn the
 * engine accepted. It is the wrong rule for a turn the engine refused before
 * accepting anything: nothing reached the model, so restoring the notes for
 * the retry is not a replay. The code already knew this for ONE of the three
 * (restoreUnacceptedRole put the role back when `announce.accepted` was still
 * false) and forgot the other two. A first turn whose turn/start was refused
 * -- a transport hiccup, an engine still warming -- left an agent that never
 * saw the person's rules and never learned what tools it had, for the life of
 * the session, and the retry that went a second later looked like success.
 *
 * Pinned against the real host and the confined-engine fixture, whose
 * tool-summary module returns a recognisable note and whose adapter can park
 * a turn for the test to refuse. */

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
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-first-turn-notes-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const NOTE = /FIXTURE TOOL SUMMARY \(standard\)/

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
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return null
}

test('a first turn refused before acceptance keeps its tool note for the retry, and the accepted retry does not replay it', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'notes-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  engine.control.holdTurns = false
  engine.pendingTurns.length = 0
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
  })
  try {
    await host.startSession({ sessionId: 'solo' })

    engine.control.holdTurns = true
    const first = host.sendTurn({ sessionId: 'solo', text: 'first words', origin: 'person' })
    const held = await waitFor(() => engine.pendingTurns.length === 1 && engine.pendingTurns[0])
    assert.ok(held, 'the first turn never reached the adapter')
    assert.match(held.request.text, NOTE, 'POSITIVE CONTROL: the tool note did not ride the first attempt, so nothing below can measure its loss')
    engine.pendingTurns.length = 0
    engine.control.holdTurns = false
    held.reject(Object.assign(new Error('turn/start refused: engine warming up'), { code: 'ENGINE_NOT_READY' }))
    await assert.rejects(first, error => error && error.code === 'ENGINE_NOT_READY',
      'the refusal did not reach the caller as the engine\'s own error')

    const second = await host.sendTurn({ sessionId: 'solo', text: 'first words, again', origin: 'person' })
    const retry = engine.adapterCalls.at(-1)
    assert.match(retry.request.text, /^first words, again/)
    assert.match(retry.request.text, NOTE,
      'the tool note was consumed by a send the engine never accepted and is gone for the life of the session; this agent will have to ask what it can do')

    /* THE OTHER HALF OF THE RULE, kept: once a turn is accepted the notes are
       spent, and the next turn carries the person\'s words alone. */
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: second.turnId, status: 'completed' })
    await host.sendTurn({ sessionId: 'solo', text: 'third', origin: 'person' })
    const third = engine.adapterCalls.at(-1)
    assert.match(third.request.text, /^third/)
    assert.doesNotMatch(third.request.text, NOTE, 'the tool note was replayed onto a later turn; the transcript repeats itself')
  } finally {
    engine.control.holdTurns = false
    for (const pending of engine.pendingTurns.splice(0)) pending.resolve({ turnId: 't-released' })
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
