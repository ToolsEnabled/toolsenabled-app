/* THE SAVED TREE IS THE ADDRESS, AND THE DIRECTORY ROW MUST FOLLOW IT -- EVEN
 * WHEN THE DIRECTORY SAID NO THE FIRST TIME.
 *
 * Page 2 tells the host where a circle stands twice: on startSession
 * (treeIdentity + the first request anchor as the tree key) and, on a drag,
 * through updateTreeAddress. Both are the person's saved organisation. Two
 * paths let something else win over it:
 *
 *   1. updateTreeAddress() asked the directory once and, when the directory
 *      refused (busy lock, a row somebody hand-edited, an unreadable file),
 *      threw and forgot everything about the move. The session's row stayed
 *      on the OLD parent for the rest of its life: the courier's retry only
 *      fires for a session with no address at all, and this one had one. The
 *      person saw the drag land on the canvas and a warning line; every
 *      message from that circle still went to the manager it used to have.
 *
 *   2. registerTreeSession() reads a "Tree address:" line out of ANY turn text
 *      and overwrites the identity Page 2 supplied. That is the compatibility
 *      path for callers that send no identity, but it ran for every caller. A
 *      seeded resume re-sends the saved transcript, whose first line IS the
 *      original brief -- naming the parent the circle had when it was first
 *      started. Whenever the ready-time registration was refused (the exact
 *      window the retry exists for), the stale brief re-registered the circle
 *      under its old manager: a resume that silently reparents.
 *
 * Both are proved here against the production host with the confined fake
 * engine and the fixture directory, which refuses registrations on request. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
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
/* This suite found the junction problem before the others did and worked around
   it here, alone: it checked whether the repository's node_modules was a link
   and fell back to the temp root when it was. The fallback is now the only
   path, for every suite, in tools/lib/test-scratch-root.mjs -- including the
   8.3-short-name resolution this file discovered, which is why that helper
   calls realpathSync.native: a TEMP handed down as C:\Users\TOOLSE~2\... does
   not start with the long profile root, and the host's cwd confinement then
   refuses it as another account's folder. */
const SCRATCH = testScratchRoot('.toolsenabled-tree-address-saved-tree-wins-test')
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

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

const rowFor = (directory, sessionId) => directory.listNodes().find(node => node.sessionId === sessionId) || null

async function withHost(name, run) {
  const workdir = mkdtempSync(path.join(SCRATCH, `${name}-`))
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
    /* A fast courier tick so the registration retry (5 s, fixed) is the only
       wait in this file. */
    treeCourier: { pollMs: 100, heartbeatMs: 1_000 },
  })
  try {
    await run({ host, directory, provider, engine, workdir })
  } finally {
    await host.closeAll().catch(() => {})
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('a move the directory refused once still lands in the directory, on the same session', async () => {
  await withHost('refused-move', async ({ host, directory }) => {
    const sessionId = 'worker-moved'
    await host.startSession({
      sessionId,
      requestKeys: { treeAnchors: ['tree-a', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Manager' },
    })
    const before = rowFor(directory, sessionId)
    assert.equal(before.managerName, 'Manager')
    assert.equal(before.treeKey, 'tree-a')
    const attemptsBefore = directory.registrationAttempts().length

    directory.failNextRegistrations(1, 'TREE_DIRECTORY_MALFORMED')
    assert.throws(
      () => host.updateTreeAddress({ sessionId, selfName: 'Worker', managerName: 'Manager 2', treeKey: 'tree-b' }),
      error => error.code === 'TREE_DIRECTORY_MALFORMED',
      'the refusal itself is still reported to the caller, who warns the person',
    )
    assert.equal(rowFor(directory, sessionId).managerName, 'Manager', 'the refused write must not have landed')

    const healed = await waitFor(() => {
      const row = rowFor(directory, sessionId)
      return row && row.managerName === 'Manager 2' && row.treeKey === 'tree-b' ? row : null
    })
    assert.ok(healed, 'the row stayed on the old parent for ever after one refused move')
    assert.equal(healed.sessionId, sessionId, 'the same session re-registered; nothing minted a second circle')
    assert.equal(healed.nodeName, 'Worker')
    assert.ok(directory.registrationAttempts().length > attemptsBefore + 1, 'nothing asked the directory again')
  })
})

test('a supplied saved identity is never overwritten by a tree-address line in turn text', async () => {
  await withHost('brief-vs-saved', async ({ host, directory, engine }) => {
    const sessionId = 'worker-resumed-seeded'
    /* The ready-time registration is refused: the one window in which the
       first turn's text used to decide the circle's parent. */
    directory.failNextRegistrations(1, 'TREE_DIRECTORY_MALFORMED')
    await host.startSession({
      sessionId,
      requestKeys: { treeAnchors: ['tree-a', 'worker-node'], threadId: 'worker-node' },
      treeIdentity: { selfName: 'Worker', managerName: 'Manager 2' },
    })
    assert.equal(rowFor(directory, sessionId), null, 'the refused registration must not have produced a row')

    /* A seeded resume replays the saved transcript, whose first line is the
       original brief -- written when this circle still reported to "Manager". */
    const staleBrief = 'Tree address: you are "Worker", and your manager is "Manager".\n\nEarlier conversation follows.'
    await host.sendTurn({ sessionId, text: staleBrief, origin: 'person' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    const row = await waitFor(() => rowFor(directory, sessionId))
    assert.ok(row, 'the circle never registered after the directory recovered')
    assert.equal(row.nodeName, 'Worker')
    assert.equal(row.managerName, 'Manager 2', 'the stale brief in the turn text re-parented the resumed circle')
    assert.equal(row.treeKey, 'tree-a')
  })
})

test('a caller that supplies no identity still registers from its brief, exactly as before', async () => {
  await withHost('brief-only', async ({ host, directory, engine }) => {
    const sessionId = 'older-caller'
    await host.startSession({ sessionId })
    await host.sendTurn({
      sessionId,
      text: 'Tree address: you are "Manager", and your manager is "Controller".\n\nTake the lane.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    const row = rowFor(directory, sessionId)
    assert.ok(row)
    assert.equal(row.nodeName, 'Manager')
    assert.equal(row.managerName, 'Controller')
  })
})
