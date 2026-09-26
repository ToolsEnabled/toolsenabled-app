/* A CIRCLE BRIEFED WHILE THE DIRECTORY WAS UNREADABLE IS NOT A CIRCLE THAT WAS
 * REFUSED, and it must not be maimed for the rest of its life for having been
 * started at the wrong second.
 *
 * MEASURED 2026-09-02: one row of the durable tree directory was left
 * inconsistent by something outside the engine, so every read of the file
 * refused. A Manager briefed inside that window had its registerNode() throw
 * into a silent catch in registerTreeSession(). The brief line is the only
 * place a circle's name is ever written and it rides the first turn and no
 * other, so that one lost attempt was final: the session showed on the canvas
 * as a live circle and answered TREE_SENDER_NOT_RUNNING to everything for the
 * rest of its life. Repairing the directory underneath it changed nothing,
 * because nothing ever asked again.
 *
 * These tests hold the two halves of the answer: what the brief said survives a
 * failed attempt, and something keeps asking -- including for the session that
 * is never sent another turn, which is exactly the manager sitting idle waiting
 * for messages. The third holds the line that was already correct: a name this
 * directory will never hold is not retried forever. */

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
const SCRATCH = testScratchRoot('.toolsenabled-tree-register-retry-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const BRIEF = 'Tree address: you are "Manager", and your manager is "Controller".\n\nTake the lane.'

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

/* One briefed session, the directory refusing `refusalCount` registrations. */
async function briefed(workdir, { refusalCount, code, sessionId = 'manager-session' }) {
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  directory.failNextRegistrations(refusalCount, code)

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
  })
  await host.startSession({ sessionId })
  await host.sendTurn({ sessionId, text: BRIEF, origin: 'brief' })
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
  return { host, directory, provider, engine, sessionId }
}

test('a brief whose registration was refused still names the circle, and the next turn joins it', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'retry-turn-'))
  const { host, directory, engine, sessionId } = await briefed(workdir, { refusalCount: 1 })
  try {
    assert.equal(directory.listNodes().length, 0, 'the refused registration must not have produced a node')
    assert.equal(directory.registrationAttempts().length, 1, 'the brief should have been tried exactly once')

    /* An ordinary later turn: it carries no tree address line, so before this
       fix there was nothing left anywhere that knew this session was "Manager". */
    await host.sendTurn({ sessionId, text: 'Status please.', origin: 'person' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't2', status: 'completed' })

    const nodes = directory.listNodes()
    assert.equal(nodes.length, 1, 'the session never rejoined the tree after the directory recovered')
    assert.equal(nodes[0].nodeName, 'Manager')
    assert.equal(nodes[0].managerName, 'Controller')
    assert.equal(nodes[0].sessionId, sessionId)
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a briefed session that is never sent another turn still joins once the directory recovers', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'retry-poll-'))
  const { host, directory } = await briefed(workdir, { refusalCount: 1 })
  try {
    assert.equal(directory.listNodes().length, 0, 'the refused registration must not have produced a node')
    /* No further turn is ever sent. Nothing but the poll tick can save this
       session, which is the whole case: a manager waits for messages, and
       waiting is not a reason to be unreachable. */
    const joined = await waitFor(() => directory.listNodes().length === 1, 20_000)
    assert.ok(joined, 'an idle briefed session never retried its registration')
    assert.equal(directory.listNodes()[0].nodeName, 'Manager')
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a name this directory will never hold is refused once, not asked about forever', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'retry-permanent-'))
  const { host, directory, engine, sessionId } = await briefed(workdir, {
    refusalCount: 5,
    code: 'TREE_NAME_INVALID',
  })
  try {
    await host.sendTurn({ sessionId, text: 'Status please.', origin: 'person' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't2', status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 200))

    assert.equal(directory.listNodes().length, 0, 'a name the directory refuses must not become a node')
    assert.equal(
      directory.registrationAttempts().length,
      1,
      'a refusal about the name itself was retried; the same answer comes back forever',
    )
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
