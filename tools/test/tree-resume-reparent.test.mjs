/* A RESUME REGISTERS UNDER THE SAVED PARENT, NOT THE PRIOR ONE.
 *
 * MEASURED by Controller, 2026-09-04: a manager resumed at 02:14:54Z under its
 * PRIOR parent after the person had reparented it, and the tree directory row
 * still carried the old managerName, so a send to it from the circle it now
 * actually reports to was refused TREE_RECIPIENT_NOT_CONNECTED.
 *
 * CAUSE: adoptTreeAddressFromThread() in shell/agent-host.cjs recovers a
 * resumed circle's identity from the tree-node-directory's row for the
 * thread's PRIOR session, including that row's managerName. A reparent done
 * through the canvas while the circle is stopped only calls
 * treeStore.moveNode() (src/views/computers.js), which writes the saved tree
 * and never touches that directory row -- so the row is stale the moment a
 * reparented circle resumes.
 *
 * These tests call the host with values, exactly as
 * tools/test/tree-resume-rebind.test.mjs does, and read the directory back
 * to see what actually happened -- never a spelling read out of the source. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_ROOT = path.join(ROOT, 'tools/test/fixtures/confined-engine')
const ENGINE = path.join(FIXTURE_ROOT, 'src/lib/agent-engine/codex-process.js')
const DIRECTORY = path.join(FIXTURE_ROOT, 'src/lib/agent-comms/tree-node-directory.js')
const PROVIDER = path.join(FIXTURE_ROOT, 'src/lib/providers/agent-comms-local.js')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-tree-resume-reparent-test')
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

async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

function rows(directory) {
  return directory.createTreeNodeDirectory().listNodes()
}

function liveRowFor(directory, sessionId) {
  return rows(directory).find(node => node.sessionId === sessionId && !node.stoppedAt) || null
}

async function withHost(name, run) {
  const workdir = mkdtempSync(path.join(SCRATCH, `${name}-`))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    /* This suite is about reparenting, not about the admission rule. Left to
       read the real os.freemem(), every startSession below refuses with
       AGENT_MEMORY_LOW whenever the machine happens to be short of memory, so
       the suite's colour tracked the state of the computer rather than the code
       under test. createAgentHost documents freeMemory as injectable for exactly
       this reason (shell/agent-host.cjs:2555-2559); memoryAdmission() is covered
       on its own elsewhere. */
    freeMemory: () => 64 * 1024 * 1024 * 1024,
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

test('a resume that names the saved parent registers under it, not the prior one', async () => {
  await withHost('reparent-to-new-manager', async ({ host, directory, provider, engine }) => {
    await host.startSession({ sessionId: 'worker-first' })
    await host.sendTurn({
      sessionId: 'worker-first',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    await host.closeSession({ sessionId: 'worker-first' })

    /* THE PERSON REPARENTED THE STOPPED CIRCLE ON THE CANVAS, under a
       different manager than the one the directory still remembers. The
       resuming caller now reads that from the saved tree and sends it. */
    await host.startSession({
      sessionId: 'worker-second',
      resumeThreadId: 'thread-1',
      resumeManagerName: 'Controller',
    })

    const row = liveRowFor(directory, 'worker-second')
    assert.ok(row, 'the resumed session never reached the directory')
    assert.equal(row.nodeName, 'Worker')
    assert.equal(row.managerName, 'Controller', 'the resume kept the PRIOR manager instead of the saved one')

    /* Addressable under the NEW manager is the behaviour that matters: a
       message from the circle it now actually reports to must reach it. */
    const before = engine.adapterCalls.length
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('worker-second'),
      senderAgentId: directory.agentIdForSession('controller-elsewhere'),
      body: 'Controller: report the measured result.',
    })
    const delivered = await waitFor(() => engine.adapterCalls.length > before && engine.adapterCalls.at(-1))
    assert.ok(delivered, 'the resumed circle under its new manager never received the message')
  })
})

test('a resume that names no manager registers at the top of the tree, not under the prior one', async () => {
  await withHost('reparent-to-top', async ({ host, directory }) => {
    await host.startSession({ sessionId: 'manager-first' })
    await host.sendTurn({
      sessionId: 'manager-first',
      text: 'Tree address: you are "Manager", and your manager is "Controller".\n\nTake the lane.',
      origin: 'brief',
    })
    await host.closeSession({ sessionId: 'manager-first' })

    /* Reparented to the top of its own tree while stopped. */
    await host.startSession({
      sessionId: 'manager-second',
      resumeThreadId: 'thread-1',
      resumeManagerName: null,
    })

    const row = liveRowFor(directory, 'manager-second')
    assert.ok(row, 'the resumed session never reached the directory')
    assert.equal(row.managerName, null, 'the resume kept the stale prior manager instead of the saved top-of-tree state')
  })
})

test('a resume that says nothing about the manager keeps the prior row, unchanged', async () => {
  await withHost('no-hint', async ({ host, directory }) => {
    await host.startSession({ sessionId: 'worker-first' })
    await host.sendTurn({
      sessionId: 'worker-first',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    await host.closeSession({ sessionId: 'worker-first' })

    /* An old caller (or this suite's own other tests) that never heard of
       resumeManagerName must see exactly the prior behaviour. */
    await host.startSession({ sessionId: 'worker-second', resumeThreadId: 'thread-1' })

    const row = liveRowFor(directory, 'worker-second')
    assert.ok(row)
    assert.equal(row.managerName, 'Manager')
  })
})
