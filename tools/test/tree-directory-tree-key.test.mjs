/* A CIRCLE REGISTERS THE TOP OF ITS TREE, so the directory can tell two trees
 * apart when they use the same role names.
 *
 * MEASURED 2026-09-03 19:12 local on the owner's own machine: two trees, each
 * holding one circle named "Worker" (src/fleet-trees.js numbers a role per
 * tree, so the second tree's first Worker is plain "Worker" too). The engine's
 * tree directory keyed on names alone, held two live rows named "Worker", and
 * refused every roster and send from either as TREE_SENDER_AMBIGUOUS -- two
 * trees that shared a vocabulary could not message at all. The engine now keeps
 * a `treeKey` beside each row and keeps edges inside one tree; this suite
 * proves the HOST hands it the right key on both registration paths.
 *
 * The key is the first standing-request anchor -- the id of the top circle of
 * the tree, which src/views/computers.js treeAnchorsFor() already puts on every
 * start and every resume -- so nothing new crosses the renderer boundary.
 * Every assertion calls the production host with values and asks the fixture
 * directory what was registered; nothing reads shell/agent-host.cjs for a
 * spelling. */

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
const SCRATCH = testScratchRoot('.toolsenabled-tree-directory-tree-key-test')
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
    /* This suite is about tree keys, not about the admission rule. Left to read
       the real os.freemem(), every startSession below refuses with
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

test('a briefed circle registers the top of its tree as its tree key', async () => {
  await withHost('brief', async ({ host, directory }) => {
    await host.startSession({
      sessionId: 'worker-a',
      /* Top-down, exactly as treeAnchorsFor() builds it: the tree's top circle
         first, this circle last. */
      requestKeys: { treeAnchors: ['node-top-a', 'node-manager-a', 'node-worker-a'], threadId: 'node-worker-a' },
    })
    await host.sendTurn({
      sessionId: 'worker-a',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    const row = liveRowFor(directory, 'worker-a')
    assert.ok(row, 'the brief did not register the circle at all, so this suite is not measuring the key')
    assert.equal(row.nodeName, 'Worker')
    assert.equal(row.treeKey, 'node-top-a',
      'the row must carry the id of the top circle of its tree -- the first anchor -- not its own id and not nothing')
  })
})

test('a resumed circle registers the tree it is on NOW, not the one its old row remembered', async () => {
  await withHost('resume', async ({ host, directory }) => {
    /* The circle was on one tree when its old process died, and has since
       been dragged under a circle in another tree. The resume carries the
       anchors of where it stands today. */
    directory.createTreeNodeDirectory().registerNode({
      sessionId: 'worker-dead-process',
      nodeName: 'Worker',
      managerName: 'Manager',
      pid: 4242,
      threadId: 'thread-1',
      treeKey: 'node-top-old',
    })
    await host.startSession({
      sessionId: 'worker-resumed',
      resumeThreadId: 'thread-1',
      requestKeys: { treeAnchors: ['node-top-new', 'node-worker'], threadId: 'node-worker' },
    })
    const row = liveRowFor(directory, 'worker-resumed')
    assert.ok(row, 'the resume did not rebind at all')
    assert.equal(row.nodeName, 'Worker', 'the resumed session took a different name than the circle it continues')
    assert.equal(row.treeKey, 'node-top-new',
      'a circle resumed on another tree kept registering under the tree its dead row remembered')
  })
})

test('a session started without anchors registers no tree key, so the directory answers from names alone', async () => {
  await withHost('keyless', async ({ host, directory }) => {
    await host.startSession({ sessionId: 'lone' })
    await host.sendTurn({
      sessionId: 'lone',
      text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
      origin: 'brief',
    })
    const row = liveRowFor(directory, 'lone')
    assert.ok(row, 'a keyless brief must still register; the key is a scope hint, never a precondition')
    assert.equal(row.treeKey, null, 'nothing was invented for a session that named no tree')
  })
})
